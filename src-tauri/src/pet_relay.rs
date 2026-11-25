//! 网易云桌面宠物帧中转（内置服务）
//!
//! 宠物窗口是 Electron 透明窗口（WS_EX_NOREDIRECTIONBITMAP / TOOLWINDOW），
//! 窗口捕获与游戏捕获都拿不到画面；这里通过网易云的调试端口订阅宠物页面
//! （subApp.html?route=pet-desktop）的渲染帧，再由本地 HTTP 提供给画布/浏览器源：
//!   GET http://127.0.0.1:9321/frame  → 最新一帧 PNG（未就绪时 503）
//!
//! 由点歌机卡片的「网易云音乐宠物捕捉」开关按需启动；启动一次后常驻（幂等），
//! 宠物窗口不存在时每 3 秒静默重试，不影响其它功能。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

/// 供画布拉帧的本地端口（与 scripts/pet-relay.mjs 默认一致）
pub const PET_HTTP_PORT: u16 = 9321;
/// 网易云调试端口（桌面快捷方式里带 --remote-debugging-port=9229）
const CDP_PORTS: [u16; 2] = [9229, 9222];

type SharedFrame = Arc<Mutex<Vec<u8>>>;

#[derive(Clone, Default)]
pub struct PetRelay {
    started: Arc<AtomicBool>,
    frame: SharedFrame,
}

/// 启动宠物帧中转（幂等）：HTTP 服务 + CDP 取帧循环
#[tauri::command]
pub async fn pet_relay_start(state: tauri::State<'_, PetRelay>) -> Result<u16, String> {
    if state.started.swap(true, Ordering::SeqCst) {
        return Ok(PET_HTTP_PORT);
    }
    let app = Router::new()
        .route("/frame", get(frame_handler))
        .with_state(state.frame.clone());
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PET_HTTP_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            state.started.store(false, Ordering::SeqCst);
            return Err(format!("端口 {PET_HTTP_PORT} 被占用：{e}"));
        }
    };
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let frame = state.frame.clone();
    tokio::spawn(async move {
        loop {
            let _ = stream_once(&frame).await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
    Ok(PET_HTTP_PORT)
}

async fn frame_handler(State(frame): State<SharedFrame>) -> Response {
    let bytes = frame.lock().map(|g| g.clone()).unwrap_or_default();
    if bytes.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CACHE_CONTROL, "no-store")],
            "waiting for pet frame",
        )
            .into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response()
}

async fn pick_pet_target() -> Option<String> {
    let client = reqwest::Client::new();
    for port in CDP_PORTS {
        let url = format!("http://127.0.0.1:{port}/json");
        let resp = match client.get(&url).timeout(std::time::Duration::from_secs(2)).send().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let list: Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let arr = match list.as_array() {
            Some(a) => a,
            None => continue,
        };
        let mut best: Option<&Value> = None;
        for t in arr {
            let u = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if !u.contains("subApp.html") {
                continue;
            }
            // 优先明确的宠物路由，其余 subApp 页兜底
            if u.contains("pet") {
                best = Some(t);
                break;
            }
            if best.is_none() {
                best = Some(t);
            }
        }
        if let Some(ws) = best
            .and_then(|t| t.get("webSocketDebuggerUrl"))
            .and_then(|v| v.as_str())
        {
            return Some(ws.to_string());
        }
    }
    None
}

/// 连接宠物页面，持续接收渲染帧写入共享缓存；连接断开后由外层循环重试
async fn stream_once(frame: &SharedFrame) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::Message;

    let ws_url = pick_pet_target().await.ok_or("no pet target")?;
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();

    let enable = json!({ "id": 1, "method": "Page.enable" }).to_string();
    write
        .send(Message::Text(enable.into()))
        .await
        .map_err(|e| e.to_string())?;
    let start = json!({
        "id": 2,
        "method": "Page.startScreencast",
        "params": { "format": "png", "maxWidth": 800, "maxHeight": 800, "everyNthFrame": 1 }
    })
    .to_string();
    write
        .send(Message::Text(start.into()))
        .await
        .map_err(|e| e.to_string())?;

    let mut ack_id = 2i64;
    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(t) => {
                let v: Value = match serde_json::from_str(t.as_str()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get("method").and_then(|m| m.as_str()) != Some("Page.screencastFrame") {
                    continue;
                }
                if let Some(data) = v["params"]["data"].as_str() {
                    let bytes = b64_decode(data);
                    if !bytes.is_empty() {
                        if let Ok(mut g) = frame.lock() {
                            *g = bytes;
                        }
                    }
                }
                // 必须回 ack，否则 Chrome 会停止继续推帧
                if let Some(sid) = v["params"]["sessionId"].as_i64() {
                    ack_id += 1;
                    let ack = json!({
                        "id": ack_id,
                        "method": "Page.screencastFrameAck",
                        "params": { "sessionId": sid }
                    })
                    .to_string();
                    let _ = write.send(Message::Text(ack.into())).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// 标准 base64 解码（CDP 返回 PNG 的 base64，不引入额外依赖）
fn b64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}
