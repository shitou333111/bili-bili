//! 直播姬「浏览器源」本地服务器（仅 Windows 桌面端，绑定 127.0.0.1）。
//!
//! 职责：
//!  - 静态服务器：对外提供 Next 构建产物（out/ 或内嵌 asset），供直播姬浏览器源
//!    加载展示画布页面（如 `http://127.0.0.1:25100/display`）。
//!  - `/api/video?p=<绝对路径>`：提供入场动画本地视频，支持 HTTP Range（配合 `#t=` 片段）。
//!  - `/ws`：WebSocket 事件通道。主窗口 JS 经 `broadcast_display` 命令广播事件到所有浏览器源
//!    客户端（直播姬源 / 编辑 iframe）；客户端消息转发给主窗口 JS 处理。
//!
//! 端口：固定 127.0.0.1:25100 起，被占用则依次退避到 25119；仅 loopback，不对外。
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{CONTENT_TYPE, HeaderValue, RANGE};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite;

const BASE_PORT: u16 = 25100;
const PORT_SPAN: u16 = 20;
/// /api/video 允许的视频扩展名白名单（路径访问加固）。
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "mkv", "m4v"];

/// Tauri managed state：当前运行中的展示本地服务器（幂等启动）。
#[derive(Default)]
pub struct DisplayServerState {
    inner: Mutex<Option<Arc<RunningServer>>>,
}

struct RunningServer {
    port: u16,
    join: tauri::async_runtime::JoinHandle<()>,
    tx: broadcast::Sender<String>,
}

/// 展示页面的来源（webroot）：
///  - `Disk(path)`：生产/未走 dev 时，从磁盘 out/ 读，缺失走内嵌 asset 兜底。
///  - `Proxy(base)`：dev 模式下反向代理到 next dev 服务，无需预构建 out/。
enum Webroot {
    Disk(PathBuf),
    Proxy(String),
}

/// HTTP 处理器上下文（请求/连接共享）。
struct ServerContext {
    app: AppHandle,
    webroot: Webroot,
    tx: broadcast::Sender<String>,
}

/// 清理并校验静态相对路径，杜绝 `..` 路径穿越。
fn sanitize_rel(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(PathBuf::new());
    }
    let p = Path::new(trimmed);
    if !p.is_relative() {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn mime_of(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

/// 解析 webroot：环境变量 → 从 cwd 与 exe 所在目录逐级向上查找 out/；找不到返回 None（走内嵌 asset）。
///
/// 需要逐级向上的原因：`tauri dev` 启动的进程 cwd 是 src-tauri/（out/ 在项目根 src-tauri/..），
/// 打包安装后磁盘上根本没有 out/（资源内嵌在二进制里，走 asset 兜底）。
fn resolve_webroot(_app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("BILI_DISPLAY_WEBROOT") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    for start in starts {
        let mut cur = Some(start);
        // 最多向上 4 级：dev 下 exe=src-tauri/target/debug → 项目根正好在第 3 级
        for _ in 0..4 {
            let Some(dir) = cur else { break };
            let p = dir.join("out");
            if p.is_dir() {
                return Some(p);
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    None
}

/// 从内嵌 / hotswap 替换的 asset provider 读取资源（磁盘 out/ 缺失时的兜底）。
fn asset_bytes(app: &AppHandle, rel: &str) -> Option<Vec<u8>> {
    let resolver = app.asset_resolver();
    // 优先精确 key（内嵌资源的 key 通常带前导 '/'，如 `/display`）
    for key in [rel, &format!("{rel}.html")] {
        let k = if key.starts_with('/') {
            key.to_string()
        } else {
            format!("/{key}")
        };
        if let Some(asset) = resolver.get(k) {
            return Some(asset.bytes);
        }
        if let Some(asset) = resolver.get(key.to_string()) {
            return Some(asset.bytes);
        }
    }
    None
}

fn bytes_response(status: StatusCode, ct: &str, body: Vec<u8>) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", ct)
        .header("content-length", body.len().to_string())
        .body(axum::body::Body::from(body))
        .expect("构造响应失败")
}

/// 附带单区间 Range 的本地文件服务（/api/video 视频分段播放用；静态页也复用）。
async fn serve_file_with_range(path: &Path, range_hdr: Option<&HeaderValue>) -> Response {
    let filename = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("file");
    let ct = mime_of(filename);
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return bytes_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"not found".to_vec());
    };
    if !meta.is_file() {
        return bytes_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"not found".to_vec());
    }
    let total = meta.len();
    if let Some(rh) = range_hdr {
        if let Ok(spec) = rh.to_str() {
            if let Some(spec) = spec.strip_prefix("bytes=") {
                if let Some((a, b)) = spec.split_once('-') {
                    let start: u64 = a.trim().parse().unwrap_or(0);
                    let end_raw: u64 = b.trim().parse().unwrap_or(total.saturating_sub(1));
                    if start < total && start <= end_raw {
                        let end = end_raw.min(total - 1);
                        let len = (end - start + 1) as usize;
                        if let Ok(mut f) = tokio::fs::File::open(path).await {
                            if f.seek(SeekFrom::Start(start)).await.is_ok() {
                                let mut buf = vec![0u8; len];
                                if f.read_exact(&mut buf).await.is_ok() {
                                    return Response::builder()
                                        .status(StatusCode::PARTIAL_CONTENT)
                                        .header("content-type", ct)
                                        .header("accept-ranges", "bytes")
                                        .header("content-length", len.to_string())
                                        .header("content-range", format!("bytes {start}-{end}/{total}"))
                                        .body(axum::body::Body::from(buf))
                                        .expect("构造 206 响应失败");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    match tokio::fs::read(path).await {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", ct)
            .header("accept-ranges", "bytes")
            .header("content-length", body.len().to_string())
            .body(axum::body::Body::from(body))
            .expect("构造 200 响应失败"),
        Err(e) => bytes_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            e.to_string().into_bytes(),
        ),
    }
}

/// /api/video?p=<绝对路径>：校验存在、为文件、扩展名白名单后按 Range 返回。
async fn api_video(Query(params): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let Some(raw) = params.get("p") else {
        return bytes_response(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", b"missing p".to_vec());
    };
    let path = PathBuf::from(raw);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !VIDEO_EXTS.contains(&ext.as_str()) {
        return bytes_response(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", b"extension not allowed".to_vec());
    }
    let range = headers.get(RANGE).cloned();
    serve_file_with_range(&path, range.as_ref()).await
}

/// dev 反向代理：把静态请求转发到 next dev 服务（页面/资源实时来自 dev server）。
/// 仅代理 GET 类静态资源；/ws 与 /api/video 走本地显式路由，不受影响。
async fn proxy_request(base: &str, uri: Uri) -> Response {
    let mut url = format!("{}{}", base.trim_end_matches('/'), uri.path());
    if let Some(q) = uri.query() {
        url.push('?');
        url.push_str(q);
    }
    // 只代理静态资源，要求上游不压缩（reqwest 未启用 gzip 解码，原样转发压缩字节会损坏页面）
    match crate::shared_client().get(&url).header("Accept-Encoding", "identity").send().await {
        Ok(resp) => {
            let status = resp.status();
            let ct = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let body = resp.bytes().await.unwrap_or_default().to_vec();
            Response::builder()
                .status(status)
                .header("content-type", ct)
                .body(axum::body::Body::from(body))
                .expect("构造代理响应失败")
        }
        Err(e) => bytes_response(
            StatusCode::BAD_GATEWAY,
            "text/plain; charset=utf-8",
            format!("展示页面代理失败（dev server 未运行？）：{e}").into_bytes(),
        ),
    }
}

/// dev 反向代理 HMR WebSocket（Next Turbopack 路径为 `/_next/ln`）：
/// 让展示页在 dev 下获得热更新；否则 HMR 客户端连不上会在重试 25 次后整页 reload。
async fn handle_hmr_ws(
    ws: WebSocketUpgrade,
    uri: Uri,
    State(ctx): State<Arc<ServerContext>>,
) -> Response {
    let Webroot::Proxy(base) = &ctx.webroot else {
        return bytes_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"not found".to_vec());
    };
    let base = base.clone();
    let path = uri.path().to_string();
    let query = uri.query().map(str::to_string);
    ws.on_upgrade(move |socket| proxy_hmr_socket(socket, base, path, query))
}

async fn proxy_hmr_socket(mut socket: WebSocket, base: String, path: String, query: Option<String>) {
    let mut url = base.replace("http://", "ws://").trim_end_matches('/').to_string();
    url.push_str(&path);
    if let Some(q) = query {
        url.push('?');
        url.push_str(&q);
    }
    // 连到 dev server 的 HMR WS（Turbopack 用 ws 库 noServer 模式，不校验 Origin）。
    // 失败时直接关闭客户端连接，HMR 客户端会静默重试。
    let (server, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(pair) => pair,
        Err(_) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    // 双向中继：任一侧结束（Close/断连/错误），另一侧随之关闭。
    let (mut c_sink, mut c_stream) = socket.split();
    let (mut s_sink, mut s_stream) = server.split();
    let c2s = async move {
        while let Some(Ok(msg)) = c_stream.next().await {
            if let Some(tm) = axum_msg_to_ts(msg) {
                if s_sink.send(tm).await.is_err() {
                    break;
                }
            }
        }
        let _ = s_sink.close().await;
    };
    let s2c = async move {
        while let Some(Ok(msg)) = s_stream.next().await {
            if let Some(am) = ts_msg_to_axum(msg) {
                if c_sink.send(am).await.is_err() {
                    break;
                }
            }
        }
        let _ = c_sink.close().await;
    };
    tokio::select! {
        _ = c2s => {}
        _ = s2c => {}
    }
}

/// axum 的 WS 消息 → tungstenite 消息。两者 bytes 同源（Binary/Ping/Pong 直传）；
/// Text/Close 的 Utf8Bytes 包装不同，经 String/str 转换。
fn axum_msg_to_ts(msg: Message) -> Option<tungstenite::Message> {
    use axum::extract::ws::Message as M;
    match msg {
        M::Text(t) => Some(tungstenite::Message::Text(tungstenite::Utf8Bytes::from(
            t.as_str().to_owned(),
        ))),
        M::Binary(b) => Some(tungstenite::Message::Binary(b)),
        M::Ping(b) => Some(tungstenite::Message::Ping(b)),
        M::Pong(b) => Some(tungstenite::Message::Pong(b)),
        M::Close(Some(f)) => Some(tungstenite::Message::Close(Some(
            tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::from(f.code),
                reason: tungstenite::Utf8Bytes::from(f.reason.as_str().to_owned()),
            },
        ))),
        M::Close(None) => Some(tungstenite::Message::Close(None)),
    }
}

fn ts_msg_to_axum(msg: tungstenite::Message) -> Option<Message> {
    use axum::extract::ws::Message as M;
    match msg {
        tungstenite::Message::Text(t) => Some(M::Text(
            axum::extract::ws::Utf8Bytes::from(t.as_str().to_owned()),
        )),
        tungstenite::Message::Binary(b) => Some(M::Binary(b)),
        tungstenite::Message::Ping(b) => Some(M::Ping(b)),
        tungstenite::Message::Pong(b) => Some(M::Pong(b)),
        tungstenite::Message::Close(Some(f)) => Some(M::Close(Some(axum::extract::ws::CloseFrame {
            code: f.code.into(),
            reason: axum::extract::ws::Utf8Bytes::from(f.reason.as_str().to_owned()),
        }))),
        tungstenite::Message::Close(None) => Some(M::Close(None)),
        tungstenite::Message::Frame(_) => None,
    }
}

/// 静态兜底：dev 模式走反向代理；磁盘模式按 webroot/rel、rel.html、rel/index.html 依次
/// 查找，最后回退内嵌/hotswap asset。
async fn static_fallback(uri: Uri, State(ctx): State<Arc<ServerContext>>) -> Response {
    match &ctx.webroot {
        Webroot::Proxy(base) => return proxy_request(base, uri).await,
        Webroot::Disk(webroot) => {
            let trimmed = uri.path().trim_start_matches('/');
            let empty_root = trimmed.is_empty();
            let rel = if empty_root { "index.html" } else { trimmed };
            let Some(rel_path) = sanitize_rel(trimmed) else {
                return bytes_response(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", b"bad path".to_vec());
            };

            // 1) 空路由 → index.html
            if empty_root {
                let idx = webroot.join("index.html");
                if idx.is_file() {
                    return serve_file_with_range(&idx, None).await;
                }
            }
            // 2) 精确文件
            let direct = webroot.join(&rel_path);
            if direct.is_file() {
                return serve_file_with_range(&direct, None).await;
            }
            // 3) 无扩展名路由 → rel.html（Next output:export）
            let ext = Path::new(rel).extension().and_then(|e| e.to_str());
            if ext.is_none() && !rel.ends_with(".html") {
                let as_html = webroot.join(format!("{rel}.html"));
                if as_html.is_file() {
                    return serve_file_with_range(&as_html, None).await;
                }
            }
            // 4) rel/index.html
            let dir_idx = webroot.join(&rel_path).join("index.html");
            if dir_idx.is_file() {
                return serve_file_with_range(&dir_idx, None).await;
            }
            // 5) 内嵌 / hotswap asset 兜底
            let key = if empty_root { "index.html" } else { rel };
            if let Some(bytes) = asset_bytes(&ctx.app, key) {
                // 无扩展名路由（如 /display）对应的是页面 HTML，必须按 .html 计算
                // Content-Type；否则 mime_guess 对无扩展名文件名返回
                // application/octet-stream，浏览器会把页面当文件下载而不是渲染
                // （独立安装的 EXE 无磁盘 out/，全部走此内嵌兜底，必中此问题）。
                let ct_key = match Path::new(key).extension() {
                    Some(_) => key.to_string(),
                    None => format!("{key}.html"),
                };
                let ct = mime_of(&ct_key).to_owned();
                return bytes_response(StatusCode::OK, &ct, bytes);
            }
        }
    }
    bytes_response(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"not found".to_vec())
}

/// WebSocket：后台任务把广播 → 客户端；客户端消息 → 主窗口 `display-server-message`。
async fn handle_socket(socket: WebSocket, ctx: Arc<ServerContext>) {
    let (mut sink, mut stream) = socket.split();
    let mut brx = ctx.tx.subscribe();
    let app = ctx.app.clone();
    let send_task = tauri::async_runtime::spawn(async move {
        while let Ok(m) = brx.recv().await {
            if sink.send(Message::Text(m.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    let _ = app.emit_to("main", "display-server-message", v);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = send_task.await;
}

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<Arc<ServerContext>>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

/// 启动本地展示服务器（幂等）。端口 25100..25119 依次尝试绑定。
#[tauri::command]
pub async fn start_display_server(
    app: AppHandle,
    state: tauri::State<'_, DisplayServerState>,
) -> Result<u16, String> {
    {
        let guard = state.inner.lock().map_err(|_| "server lock err".to_string())?;
        if let Some(rs) = guard.as_ref() {
            return Ok(rs.port);
        }
    }

    // 展示页面来源：
    //  - dev 模式（tauri dev）：反向代理到 next dev 服务（localhost:3000），改页面刷新即生效，
    //    无需预先 next build 生成 out/；/ws 与 /api/video 仍由本服务器本地处理。
    //  - 生产：优先磁盘 out/（热更新覆盖时可能存在）；缺失退回内嵌 asset（打包安装后资源在二进制里）。
    let webroot = if tauri::is_dev() {
        let dev_url = app
            .config()
            .build
            .dev_url
            .as_ref()
            .map(|u| u.to_string())
            .unwrap_or_else(|| "http://localhost:3000".to_string());
        println!("[展示]dev 模式：展示页面反向代理到 {dev_url}（无需磁盘 out/）");
        Webroot::Proxy(dev_url)
    } else {
        match resolve_webroot(&app) {
            Some(w) => Webroot::Disk(w),
            None => {
                println!("[展示]未找到磁盘 out/ 目录，使用内嵌前端资源");
                Webroot::Disk(PathBuf::from("__embedded__"))
            }
        }
    };

    let mut listener = None;
    for port in BASE_PORT..(BASE_PORT + PORT_SPAN) {
        let addr = format!("127.0.0.1:{port}");
        if let Ok(l) = tokio::net::TcpListener::bind(&addr).await {
            listener = Some((l, port));
            break;
        }
    }
    let (listener, port) = listener.ok_or_else(|| {
        format!("本地展示服务端口 {BASE_PORT}-{} 均被占用", BASE_PORT + PORT_SPAN - 1)
    })?;

    let (tx, _rx) = broadcast::channel(256);
    let ctx = Arc::new(ServerContext { app: app.clone(), webroot, tx: tx.clone() });
    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/video", get(api_video))
        // Next 16 (Turbopack/webpack) 的 HMR WebSocket 路径为 /_next/webpack-hmr，
        // 老版本 /_next/ln 一并代理，缺失时静默重试而非 404 整页 reload。
        .route("/_next/webpack-hmr", get(handle_hmr_ws))
        .route("/_next/ln", get(handle_hmr_ws))
        .fallback(static_fallback)
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::overriding(
                axum::http::HeaderName::from_static("cache-control"),
                HeaderValue::from_static("no-cache"),
            ),
        )
        .with_state(ctx);

    let join = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    {
        let rs = Arc::new(RunningServer { port, join, tx });
        let mut guard = state.inner.lock().map_err(|_| "server lock err".to_string())?;
        *guard = Some(rs);
    }
    println!("[展示]本地浏览器源服务已启动 port={port}");
    Ok(port)
}

/// 停止本地展示服务器。
#[tauri::command]
pub fn stop_display_server(state: tauri::State<'_, DisplayServerState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "server lock err".to_string())?;
    if let Some(rs) = guard.take() {
        rs.join.abort();
    }
    println!("[展示]本地浏览器源服务已停止");
    Ok(())
}

/// 主窗口 → 所有浏览器源客户端 广播一条 JSON 消息（无连接时 no-op）。
#[tauri::command]
pub fn broadcast_display(
    json: Value,
    state: tauri::State<'_, DisplayServerState>,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "server lock err".to_string())?;
    if let Some(rs) = guard.as_ref() {
        let _ = rs.tx.send(json.to_string());
    }
    Ok(())
}