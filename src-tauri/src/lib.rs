use serde_json::Value;
use tauri::{Emitter, Manager, WebviewUrl};
// 桌面端用 WebviewBuilder 建子 WebView；移动端不支持子 WebView，用 WebviewWindowBuilder 建独立窗口
#[cfg(desktop)]
use tauri::WebviewBuilder;
#[cfg(not(desktop))]
use tauri::WebviewWindowBuilder;

/// 活动面板子 WebView label（桌面端 + 移动端统一使用）
const ACTIVITY_PANEL_LABEL: &str = "activity-panel";
/// 真实活动面板子 WebView label（桌面端 + 移动端统一使用）
const REAL_ACTIVITY_PANEL_LABEL: &str = "real-activity-panel";

/// 判断是否 B站 登录相关地址（用于在导航层拦截，跳过登录跳转）
fn is_login_url(url: &str) -> bool {
    let u = url.to_lowercase();
    if u.contains("passport.bilibili.com") || u.contains("passlogin") {
        return true;
    }
    if (u.contains("bilibili.com") || u.contains("biligame")) && u.contains("/login") {
        return true;
    }
    false
}

#[tauri::command]
async fn fetch_json(url: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| format!("reqwest client build error: {}", e))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
        .header("Referer", "https://live.bilibili.com/")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应体失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), &body[..body.len().min(200)]));
    }

    serde_json::from_str(&body).map_err(|e| format!("JSON解析失败: {} body: {}", e, &body[..body.len().min(200)]))
}

#[tauri::command]
fn debug_acl(webview: tauri::Webview) -> String {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let label = webview.label().to_string();
    let window_label = webview.window().label().to_string();
    serde_json::json!({
        "webview_url": url,
        "webview_label": label,
        "window_label": window_label,
        "hint": "检查 webview_url 是否匹配 capabilities/default.json 中 remote.urls 的 URLPattern"
    })
    .to_string()
}

/// 活动窗口黑色标题栏注入脚本：固定在页面顶部（不随滚动），显示活动标题，顶部两角圆角。
/// 标题栏圆角下方用一块黑色不透明遮罩层（同样固定定位、无圆角）封住缝隙，
/// 确保活动页面内容不会透过圆角缝隙漏到标题栏上方。
/// 页面框架可能在渲染后清空 body（SPA 重新挂载），因此用定时器周期性检查，
/// 若标题栏或遮罩被页面清掉则重新挂载，保证始终存在。
/// 生成时把活动标题内联进脚本，因此返回 String（标题需转义）。
///
/// `top_offset`：标题栏距离窗口顶部的逻辑像素偏移。
///  - 桌面端 = 0（标题栏贴顶，子 WebView 面板本身已占下方 3/4）
///  - 移动端 = 100（iOS/Android 窗口天然全屏，无法用原生尺寸裁剪；通过把标题栏整体下移、
///    页面内容 paddingTop 下移 100px，视觉上活动页顶部与模拟器顶部之间留出 100px 空隙）
fn activity_title_bar_script(title: &str, top_offset: f64) -> String {
    let escaped = title
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    format!(
        r##"(function () {{
  if (window.__BILI_ACTIVITY_TITLEBAR__) return;
  window.__BILI_ACTIVITY_TITLEBAR__ = true;
  var TITLE = '{escaped}';
  var TOP_OFFSET = {top_offset};
  var BAR_H = 44;
  var TOTAL_H = BAR_H + TOP_OFFSET;
  function dismiss() {{
    if (window.__BILI_ACTIVITY_DISMISSING__) return;
    window.__BILI_ACTIVITY_DISMISSING__ = true;
    try {{
      // 整页向下收起（含固定标题栏/遮罩，body transform 会把 fixed 子元素一起带下去）
      document.body.style.transition = "transform 0.32s ease-in";
      document.body.style.transform = "translateY(100%)";
    }} catch (e) {{}}
    setTimeout(function () {{
      // 直接通过 Tauri IPC 调用关闭命令，而非导航到自定义 URL scheme。
      // iOS WKWebView 只为 http/https 触发 on_navigation 回调，自定义 scheme
      // （close-activity://）会被静默忽略 → Rust 永远收不到关闭事件 → 窗口无法销毁。
      // Tauri 的 IPC bridge 在初始化脚本注入前已就绪，所有平台可靠可用。
      try {{
        window.__TAURI_INTERNALS__.invoke("close_activity_panel");
      }} catch (e) {{
        // 兜底：如果 IPC 不可用，回退到旧方案（桌面端仍可工作）
        window.location.href = "close-activity://local";
      }}
    }}, 320);
  }}
  function mount() {{
    try {{
      if (!document.body) return false;
      var existing = document.getElementById("__bili_activity_titlebar__");
      if (existing) existing.remove();
      var oldMask = document.getElementById("__bili_activity_titlebar_mask__");
      if (oldMask) oldMask.remove();
      var oldScrim = document.getElementById("__bili_activity_scrim__");
      if (oldScrim) oldScrim.remove();
      // 1. 可点击收起区（仅移动端 TOP_OFFSET>0）：覆盖标题栏上方偏移区，
      //    暗紫色遮罩 + 居中"收起"胶囊，点击整页向下收起（同礼物栏交互）。
      //    背景改为完全不透明：否则页面内容滚动时会从半透明处"透到标题栏上方"，
      //    造成"内容可以滑动超出标题栏"的错觉。不再用纯黑铺满偏移区（避免黑屏观感）。
      if (TOP_OFFSET > 0) {{
        var scrim = document.createElement("div");
        scrim.id = "__bili_activity_scrim__";
        scrim.style.cssText =
          "position:fixed;top:0;left:0;right:0;height:" + TOP_OFFSET + "px;z-index:2147483644;" +
          "background:linear-gradient(to bottom, #2b1f2b 0%, #241a2e 60%, #1c1426 100%);" +
          "display:flex;align-items:center;justify-content:center;cursor:pointer;";
        var cap = document.createElement("div");
        cap.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:7px 16px;border-radius:999px;" +
          "background:rgba(255,255,255,0.16);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);" +
          "color:#fff;font-size:12px;font-weight:500;letter-spacing:.5px;";
        cap.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" style="opacity:.9"><path stroke-linecap="round" stroke-linejoin="round" d="M19 15l-7-7-7 7"/></svg>收起';
        scrim.appendChild(cap);
        scrim.onclick = dismiss;
        document.body.appendChild(scrim);
      }}
      // 2. 标题栏圆角缝隙遮罩：黑色，仅盖住标题栏一行（不再向上延伸铺黑）。
      var mask = document.createElement("div");
      mask.id = "__bili_activity_titlebar_mask__";
      mask.style.cssText =
        "position:fixed;top:" + TOP_OFFSET + "px;left:0;right:0;height:" + BAR_H + "px;z-index:2147483645;" +
        "background:#000;pointer-events:none;";
      // 3. 标题栏本体（黑色、顶部两角圆角、居中显示标题、固定不随页面滚动）
      var bar = document.createElement("div");
      bar.id = "__bili_activity_titlebar__";
      bar.textContent = TITLE;
      bar.style.cssText =
        "position:fixed;top:" + TOP_OFFSET + "px;left:0;right:0;height:" + BAR_H + "px;z-index:2147483646;" +
        "background:#000;color:#fff;font-size:16px;font-weight:500;line-height:" + BAR_H + "px;" +
        "text-align:center;font-family:'PingFang SC','Microsoft YaHei',sans-serif;" +
        "border-radius:12px 12px 0 0;user-select:none;-webkit-user-select:none;";
      document.documentElement.style.backgroundColor = "#000";
      document.body.style.backgroundColor = "#000";
      document.body.appendChild(mask);
      document.body.appendChild(bar);
      document.body.style.paddingTop = TOTAL_H + "px";
      return true;
    }} catch (e) {{ return false; }}
  }}
  function keep() {{
    try {{
      if (!document.body) {{ setTimeout(keep, 100); return; }}
      var bar = document.getElementById("__bili_activity_titlebar__");
      var mask = document.getElementById("__bili_activity_titlebar_mask__");
      var scrim = document.getElementById("__bili_activity_scrim__");
      var need = TOP_OFFSET > 0 ? (!bar || !mask || !scrim) : (!bar || !mask);
      if (need) mount();
      // SPA 可能重置 body 样式，持续保证 paddingTop
      if (document.body.style.paddingTop !== TOTAL_H + "px") {{
        document.body.style.paddingTop = TOTAL_H + "px";
      }}
    }} catch (e) {{}}
  }}
  keep();
  setInterval(keep, 400);
}})();"##
    )
}

/// 读取页面最大宽度（单一源头：src/lib/page-config.json，TypeScript 也读同一文件）。
#[cfg(desktop)]
fn page_max_width() -> f64 {
    let raw = include_str!("../../src/lib/page-config.json");
    let v: serde_json::Value = serde_json::from_str(raw)
        .unwrap_or(serde_json::json!({"page_max_width": 1000}));
    v["page_max_width"].as_f64().unwrap_or(1000.0)
}

/// 读取桌面端自定义窗口标题栏高度（单一源头：src/lib/page-config.json，TypeScript 也读同一文件）。
/// 主窗口 decorations:false，标题栏由 WindowTitleBar 渲染在顶部；真实活动页子 WebView 需
/// 下移该高度，避免盖住软件窗口标题栏。
#[cfg(desktop)]
fn desktop_titlebar_h() -> f64 {
    let raw = include_str!("../../src/lib/page-config.json");
    let v: serde_json::Value = serde_json::from_str(raw)
        .unwrap_or(serde_json::json!({"desktop_titlebar_h": 36}));
    v["desktop_titlebar_h"].as_f64().unwrap_or(36.0)
}

/// 根据给定的逻辑窗口宽高计算活动面板矩形。
/// 宽度与"模拟器页面"（固定 inset-0 + max-width:page_max_width 水平居中）保持一致：
/// 宽 = min(窗口宽, 页面最大宽度) 并水平居中；高 = 窗口高 * 3/4，贴底（顶部留 1/4）。
/// 这样无论软件窗口放大缩小，活动页都只落在模拟器页面范围内，与模拟器对齐。
#[cfg(desktop)]
fn activity_panel_rect_of(
    w: f64,
    h: f64,
) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    let panel_w = if w < page_max_width() { w } else { page_max_width() };
    let panel_h = h * 3.0 / 4.0;
    let pos = tauri::LogicalPosition::new((w - panel_w) / 2.0, h - panel_h);
    let size = tauri::LogicalSize::new(panel_w, panel_h);
    (pos, size)
}

#[cfg(desktop)]
fn activity_panel_rect(
    window: &tauri::Window,
) -> Result<(tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let phys = window.inner_size().map_err(|e| e.to_string())?;
    let w = phys.width as f64 / scale;
    let h = phys.height as f64 / scale;
    Ok(activity_panel_rect_of(w, h))
}

/// 打开 B站 活动页，做成「主窗口内下方 3/4 面板」（像礼物面板弹出一部分页面）。
///
/// 实现：不是 HTML iframe（跨域沙箱限制绕不过），而是用原生 WebView 承载真实 H5，
/// 并在文档开始前注入 mock-shim.js —— 脚本运行在 B站 页面自身 origin 上下文里，
/// 覆盖 fetch/XHR 返回本地 mock，达到「真实 B站 UI + 本地数据 + 不登录 + 不扣费 + 无服务器」。
///
///  - 桌面端：向主窗口 add_child 一个子 WebView，宽度与模拟器页面一致（水平居中），占下方 3/4；
///  - 移动端：Tauri 子 WebView 不支持，回退为独立全屏窗口。
#[tauri::command]
async fn open_activity_panel(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    let url = config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("缺少 url")?;
    let mock_cfg = config
        .get("mockConfig")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let title = config
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("活动");

    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|e| format!("活动 URL 解析失败: {}", e))?;
    let mock_cfg_js = mock_cfg.to_string();
    let mock_shim = include_str!("../../public/native-inject/mock-shim.js");
    // 按序注入：①mock 配置 → ②mock-shim → ③返回按钮 → ④标题栏
    let inject_config = format!("window.__BILI_ACTIVITY_MOCK_CONFIG__ = {};", mock_cfg_js);
    // 标题栏顶部偏移：桌面端子 WebView 面板占下方 3/4，标题栏贴顶（0）；
    // 移动端窗口天然全屏，通过注入把标题栏/内容整体下移 100px，留出顶部空隙。
    let title_bar_script = {
        #[cfg(desktop)]
        {
            activity_title_bar_script(title, 0.0)
        }
        #[cfg(not(desktop))]
        {
            activity_title_bar_script(title, 100.0)
        }
    };

    #[cfg(desktop)]
    {
        let Some(main_window) = app.get_window("main") else {
            return Err("找不到主窗口".into());
        };
        // 已存在则聚焦，避免重复创建
        if let Some(wv) = main_window
            .webviews()
            .iter()
            .find(|w| w.label() == ACTIVITY_PANEL_LABEL)
        {
            let _ = wv.set_focus();
            return Ok(());
        }

        // 子 WebView 尺寸：宽与"模拟器页面"一致（min(窗口宽, 页面最大宽度) 并水平居中），
        // 高占主窗口下方 3/4。无论软件窗口如何缩放，活动页都只落在模拟器页面范围内。
        let (position, size) = activity_panel_rect(&main_window)?;

        let nav_app = app.clone();
        let builder = WebviewBuilder::new(ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(inject_config)
            .initialization_script(mock_shim)
            .initialization_script(&title_bar_script)
            .on_navigation(move |nav_url| {
                let url = nav_url.as_str();
                // 阻止 B站 登录页跳转（跳过登录）
                if is_login_url(url) {
                    return false;
                }
                // 页面内"点击收起"通过导航到 close-activity.local 触发关闭
                if url.contains("close-activity.local") || url.contains("close-activity://") {
                    // 先 emit 事件通知前端，再关闭 WebView（避免 destroy/close 打断事件投递）
                    let _ = nav_app.emit_to("main", "activity-panel-closed", ());
                    if let Some(main_window) = nav_app.get_window("main") {
                        if let Some(wv) = main_window
                            .webviews()
                            .iter()
                            .find(|w| w.label() == ACTIVITY_PANEL_LABEL)
                        {
                            let _ = wv.close();
                        }
                    }
                    return false;
                }
                true
            });

        let webview = main_window
            .add_child(builder, position, size)
            .map_err(|e| format!("创建活动面板失败: {}", e))?;
        let _ = webview.set_focus();
        Ok(())
    }

    #[cfg(not(desktop))]
    {
        // 移动端：Tauri 不支持子 WebView（Window::add_child 仅限桌面端），
        // 改用 WebviewWindowBuilder 创建独立全屏窗口。移动端窗口默认全屏铺满，
        // 不能显式 set_size/set_position（iOS 上 set_size+居中会产生左侧触摸死区）。
        // 关闭通过 WebviewWindow::close() 可靠完成：标题栏脚本经 Tauri IPC
        // 调用 close_activity_panel 命令触发（不依赖自定义 URL scheme，iOS 不触发
        // on_navigation 自定义 scheme 的问题不复存在）。
        // 清理上次残留的面板（若上次未正常关闭）
        if let Some(panel) = app.get_webview_window(ACTIVITY_PANEL_LABEL) {
            let _ = panel.close();
        }

        let nav_app = app.clone();
        let builder = WebviewWindowBuilder::new(
            &app,
            ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .initialization_script(inject_config)
        .initialization_script(mock_shim)
        .initialization_script(&title_bar_script)
        .on_navigation(move |nav_url| {
            let url = nav_url.as_str();
            if is_login_url(url) {
                return false;
            }
            // 兼容旧版：on_navigation 也捕获 close-activity URL（实际由标题栏脚本
            // 通过 Tauri IPC 调用 close_activity_panel 命令关闭）
            if url.contains("close-activity.local") || url.contains("close-activity://") {
                let _ = nav_app.emit_to("main", "activity-panel-closed", ());
                if let Some(panel) = nav_app.get_webview_window(ACTIVITY_PANEL_LABEL) {
                    let _ = panel.close();
                }
                return false;
            }
            true
        });

        let panel = builder
            .build()
            .map_err(|e| format!("创建活动面板失败: {}", e))?;
        let _ = panel.set_focus();
        Ok(())
    }
}

/// 关闭活动面板（供前端顶部遮罩点击时调用，或标题栏脚本通过 Tauri IPC 调用）
#[tauri::command]
async fn close_activity_panel(app: tauri::AppHandle) -> Result<(), String> {
    // 先 emit 再 close：确保前端收到事件复位 nativePanelOpen
    let _ = app.emit_to("main", "activity-panel-closed", ());
    // 桌面端：子 WebView 面板（Window::webviews 枚举）
    #[cfg(desktop)]
    if let Some(main_window) = app.get_window("main") {
        if let Some(wv) = main_window
            .webviews()
            .iter()
            .find(|w| w.label() == ACTIVITY_PANEL_LABEL)
        {
            let _ = wv.close();
        }
    }
    // 移动端：独立全屏窗口（WebviewWindow）
    #[cfg(not(desktop))]
    if let Some(panel) = app.get_webview_window(ACTIVITY_PANEL_LABEL) {
        let _ = panel.close();
    }
    Ok(())
}

/// 真实活动页标题栏注入脚本：带左侧返回按钮，点击返回触发导航到 close-activity.local。
/// 与模拟器的 activity_title_bar_script 完全独立，不复用任何代码。
///
/// `top_offset`：标题栏额外顶部偏移（桌面/移动端均为 0）。
///  - 桌面端 = 0：子 WebView 已由 Rust 下移到自定义窗口标题栏下方，标题栏贴面板顶（安全区=0）。
///  - 移动端 = 0：黑抽页铺满整个全屏窗口，顶部安全区由脚本自行检测（避免 React 的
///    --safe-top CSS 变量跨文档无效的问题，详见下方可靠性说明）。
///
/// 移动端可靠性说明（为什么不能只靠 env() 探测）：
///  - 黑抽页是独立 H5 文档，React 的 --safe-top 变量无法作用到这里（CSS 变量跨文档无效）。
///  - env(safe-area-inset-top) 只有在页面 viewport-fit=cover 时才有值；且 Android 系统
///    WebView 不支持 env()（Android 15 起强制 edge-to-edge，状态栏会盖住 WebView 顶部）。
///  - 若探测失败时标题栏仍顶到 y=0，就会被状态栏遮住，看起来像"没有标题栏"。
///  - 因此脚本：①尽力注入 viewport-fit=cover；②body 就绪后探测 env()；③取不到时用平台
///    兜底值（iOS 47 / Android 24），保证标题栏始终位于状态栏之下。
fn real_activity_title_bar_script(title: &str, top_offset: f64) -> String {
    let escaped = title
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    format!(
        r##"(function () {{
  if (window.__BILI_REAL_ACTIVITY_TITLEBAR__) return;
  window.__BILI_REAL_ACTIVITY_TITLEBAR__ = true;
  var TITLE = '{escaped}';
  var TOP_OFFSET = {top_offset};
  var BAR_H = 44;
  var __totalH = 0;
  // 尽力确保 viewport-fit=cover：env(safe-area-inset-top) 只有在该模式下才有值。
  // 页面 head 可能尚未解析完成，挂载循环中会反复调用直到成功。
  function ensureViewportFit() {{
    try {{
      var m = document.querySelector('meta[name="viewport"]');
      if (m) {{
        var c = m.getAttribute('content') || '';
        if (c.indexOf('viewport-fit') === -1) {{
          m.setAttribute('content', c + ', viewport-fit=cover');
        }}
      }} else if (document.head) {{
        var meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
        document.head.appendChild(meta);
      }}
    }} catch (e) {{}}
  }}
  // 读取顶部安全区高度（三选一）：页面 --safe-top → env() 探针 → 平台兜底。
  function readSafeTop() {{
    try {{
      var v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
      if (v > 0) return v;
    }} catch (e) {{}}
    try {{
      // env() 只能写进 CSS 字符串，绝不能写成 JS 表达式（0px 是非法标识符，会整段语法报错）。
      var pr = document.createElement('div');
      pr.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none;';
      document.documentElement.appendChild(pr);
      var h = parseInt(getComputedStyle(pr).height) || 0;
      pr.remove();
      if (h > 0) return h;
    }} catch (e) {{}}
    try {{
      var ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/.test(ua)) return 47; // iOS 刘海/状态栏
      if (/Android/.test(ua)) return 24; // Android 状态栏（Android 15 起强制 edge-to-edge）
    }} catch (e) {{}}
    return 0;
  }}
  function mount() {{
    try {{
      if (!document.body) return false;
      ensureViewportFit();
      // body 就绪后再检测安全区：此时 viewport-fit 已注入，env() 可取到真实值；
      // 若仍取不到（如 Android WebView 不支持 env）则回退到平台兜底值。
      var SAFE_TOP = readSafeTop();
      var BAR_TOTAL_H = SAFE_TOP + BAR_H;
      var BAR_TOP = TOP_OFFSET;
      var TOTAL_H = BAR_TOTAL_H + TOP_OFFSET;
      __totalH = TOTAL_H;
      var oldBar = document.getElementById("__bili_real_titlebar__");
      if (oldBar) oldBar.remove();
      var oldMask = document.getElementById("__bili_real_titlebar_mask__");
      if (oldMask) oldMask.remove();
      // 1. 标题栏圆角缝隙遮罩：黑色，仅盖住标题栏整行（含安全区），不向上铺黑。
      var mask = document.createElement("div");
      mask.id = "__bili_real_titlebar_mask__";
      mask.style.cssText =
        "position:fixed;top:" + BAR_TOP + "px;left:0;right:0;height:" + BAR_TOTAL_H + "px;z-index:2147483645;" +
        "background:#000;pointer-events:none;";
      // 2. 标题栏本体（黑色、顶部两角圆角、居中显示标题、固定不随页面滚动）。
      //    padding-top = SAFE_TOP：黑色覆盖状态栏/刘海区域，标题文字落在其下方 44px 行。
      var bar = document.createElement("div");
      bar.id = "__bili_real_titlebar__";
      bar.style.cssText =
        "position:fixed;top:" + BAR_TOP + "px;left:0;right:0;height:" + BAR_TOTAL_H + "px;padding-top:" + SAFE_TOP + "px;z-index:2147483646;" +
        "background:#000;color:#fff;font-size:16px;font-weight:500;line-height:" + BAR_H + "px;" +
        "text-align:center;font-family:'PingFang SC','Microsoft YaHei',sans-serif;" +
        "border-radius:12px 12px 0 0;user-select:none;-webkit-user-select:none;" +
        "display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
      // 3. 返回按钮（与标题文字同处 44px 行，垂直对齐；点击导航到 close-activity.local）
      var backBtn = document.createElement("div");
      backBtn.style.cssText =
        "position:absolute;left:12px;top:" + SAFE_TOP + "px;bottom:0;width:44px;display:flex;" +
        "align-items:center;justify-content:center;cursor:pointer;";
      backBtn.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>';
      backBtn.onclick = function () {{
        // 直接通过 Tauri IPC 调用关闭命令（同 activity_panel 逻辑）。
        // iOS WKWebView 不触发自定义 scheme 的 on_navigation，IPC 是最可靠路径。
        try {{
          window.__TAURI_INTERNALS__.invoke("close_real_activity_panel");
        }} catch (e) {{
          window.location.href = "close-activity://local";
        }}
      }};
      // 标题文字
      var titleEl = document.createElement("span");
      titleEl.textContent = TITLE;
      bar.appendChild(backBtn);
      bar.appendChild(titleEl);
      document.documentElement.style.backgroundColor = "#000";
      document.body.style.backgroundColor = "#000";
      document.body.appendChild(mask);
      document.body.appendChild(bar);
      document.body.style.paddingTop = TOTAL_H + "px";
      return true;
    }} catch (e) {{ return false; }}
  }}
  function keep() {{
    try {{
      if (!document.body) {{ setTimeout(keep, 100); return; }}
      var bar = document.getElementById("__bili_real_titlebar__");
      var mask = document.getElementById("__bili_real_titlebar_mask__");
      if (!bar || !mask) {{ mount(); return; }}
      // SPA 可能重置 body 样式，持续保证 paddingTop
      if (__totalH && document.body.style.paddingTop !== __totalH + "px") {{
        document.body.style.paddingTop = __totalH + "px";
      }}
    }} catch (e) {{}}
  }}
  ensureViewportFit();
  mount();
  setInterval(keep, 400);
}})();"##
    )
}

/// 打开真实 B站 活动页（无 mock，真实交易）。
/// 与模拟器的 open_activity_panel 完全独立：不注入 mock-shim，不拦截登录，
/// 标题栏带返回按钮（点击触发导航到 close-activity.local，由 on_navigation 拦截并关闭面板）。
/// config.cookies: ["k=v", "k2=v2"]，将软件当前登录账号的 B站 Cookie 注入到 WebView，
/// 使 live.bilibili.com / .bilibili.com 请求自动携带登录态。
#[tauri::command]
async fn open_real_activity_panel(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    let url = config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("缺少 url")?;
    let title = config
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("活动");
    let cookies: Vec<String> = config
        .get("cookies")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|e| format!("活动 URL 解析失败: {}", e))?;
    // 标题栏顶部偏移：黑抽页铺满整个页面（与模拟器"活动页"不同，无顶部留空）。
    // 桌面端子 WebView 面板已下移到自定义窗口标题栏之下，标题栏贴子面板顶（0）；
    // 移动端窗口天然全屏，标题栏贴在安全区顶部（0），内容铺满整个页面。
    let title_bar_script = {
        #[cfg(desktop)]
        {
            real_activity_title_bar_script(title, 0.0)
        }
        #[cfg(not(desktop))]
        {
            real_activity_title_bar_script(title, 0.0)
        }
    };

    // 构建 Cookie 注入初始化脚本（在页面任何脚本之前运行，保证首次请求就带 Cookie）
    let cookie_script = if cookies.is_empty() {
        String::new()
    } else {
        let escaped_cookies: Vec<String> = cookies
            .iter()
            .map(|c| {
                c.replace('\\', "\\\\")
                    .replace('\'', "\\'")
                    .replace('\n', "\\n")
                    .replace('\r', "")
            })
            .collect();
        format!(
            r##"(function() {{
  var __cookies = [{}];
  try {{
    for (var i = 0; i < __cookies.length; i++) {{
      var parts = __cookies[i].split("=");
      if (parts.length < 2) continue;
      var name = parts.shift();
      var val = parts.join("=");
      try {{ document.cookie = name + "=" + val + "; path=/; domain=.bilibili.com;"; }} catch(e){{}}
      try {{ document.cookie = name + "=" + val + "; path=/; domain=.live.bilibili.com;"; }} catch(e){{}}
    }}
  }} catch(e) {{}}
}})();
"##,
            escaped_cookies
                .iter()
                .map(|c| format!("'{}'", c))
                .collect::<Vec<_>>()
                .join(",")
        )
    };

    #[cfg(desktop)]
    {
        let Some(main_window) = app.get_window("main") else {
            return Err("找不到主窗口".into());
        };
        // 清理上次可能残留的面板（若上次未正常关闭，残留面板命中后只 set_focus 会导致
        // 第二次"打不开、无反应"，且其位置/渲染异常会盖住软件窗口标题栏）。
        // 黑抽每次打开都是全新页面，这里总是关闭旧的再新建。
        if let Some(wv) = main_window
            .webviews()
            .iter()
            .find(|w| w.label() == REAL_ACTIVITY_PANEL_LABEL)
        {
            let _ = wv.close();
        }

        // 真实活动页：宽度与"模拟器页面"（min(窗口宽, 页面最大宽度) 水平居中）保持一致，
        // 高度铺满自定义窗口标题栏之下；下移避免盖住软件窗口标题栏。
        // 标题栏高度来自 page-config.json（单一源头，与 WindowTitleBar / SafeAreaStyler 一致）。
        let scale = main_window.scale_factor().map_err(|e| e.to_string())?;
        let phys = main_window.inner_size().map_err(|e| e.to_string())?;
        let w = phys.width as f64 / scale;
        let h = phys.height as f64 / scale;
        let tb = desktop_titlebar_h();
        let panel_w = if w < page_max_width() { w } else { page_max_width() };
        let position = tauri::LogicalPosition::new((w - panel_w) / 2.0, tb);
        let size = tauri::LogicalSize::new(panel_w, (h - tb).max(0.0));

        let app_handle = app.clone();
        // 拼接所有初始化脚本：先注 Cookie，再挂标题栏
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewBuilder::new(REAL_ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(&init_script)
            .on_navigation(move |nav_url| {
                // 先 emit 再 close：避免 close 打断事件投递（与 activity_panel 一致）
                if nav_url.as_str().contains("close-activity.local") || nav_url.as_str().contains("close-activity://") {
                    let _ = app_handle.emit_to("main", "real-activity-panel-closed", ());
                    if let Some(main_window) = app_handle.get_window("main") {
                        if let Some(wv) = main_window
                            .webviews()
                            .iter()
                            .find(|w| w.label() == REAL_ACTIVITY_PANEL_LABEL)
                        {
                            let _ = wv.close();
                        }
                    }
                    return false;
                }
                true
            });

        let webview = main_window
            .add_child(builder, position, size)
            .map_err(|e| format!("创建真实活动面板失败: {}", e))?;
        let _ = webview.set_focus();
        Ok(())
    }

    #[cfg(not(desktop))]
    {
        // 移动端：Tauri 不支持子 WebView（Window::add_child 仅限桌面端），
        // 改用 WebviewWindowBuilder 创建独立全屏窗口。关闭经 Tauri IPC 调用
        // close_real_activity_panel 命令完成（不依赖自定义 URL scheme）。
        // 清理上次残留的面板（若上次未正常关闭）
        if let Some(panel) = app.get_webview_window(REAL_ACTIVITY_PANEL_LABEL) {
            let _ = panel.close();
        }

        let app_handle = app.clone();
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewWindowBuilder::new(
            &app,
            REAL_ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .initialization_script(&init_script)
        .on_navigation(move |nav_url| {
            // 兼容旧版：on_navigation 也捕获 close-activity URL（实际由标题栏脚本
            // 通过 Tauri IPC 调用 close_real_activity_panel 命令关闭）
            if nav_url.as_str().contains("close-activity.local") || nav_url.as_str().contains("close-activity://") {
                let _ = app_handle.emit_to("main", "real-activity-panel-closed", ());
                if let Some(panel) = app_handle.get_webview_window(REAL_ACTIVITY_PANEL_LABEL) {
                    let _ = panel.close();
                }
                return false;
            }
            true
        });

        let panel = builder
            .build()
            .map_err(|e| format!("创建真实活动面板失败: {}", e))?;
        let _ = panel.set_focus();
        Ok(())
    }
}

/// 关闭真实活动面板（供标题栏脚本通过 Tauri IPC 调用）
#[tauri::command]
async fn close_real_activity_panel(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit_to("main", "real-activity-panel-closed", ());
    // 桌面端：子 WebView 面板
    #[cfg(desktop)]
    if let Some(main_window) = app.get_window("main") {
        if let Some(wv) = main_window
            .webviews()
            .iter()
            .find(|w| w.label() == REAL_ACTIVITY_PANEL_LABEL)
        {
            let _ = wv.close();
        }
    }
    // 移动端：独立全屏窗口（WebviewWindow）
    #[cfg(not(desktop))]
    if let Some(panel) = app.get_webview_window(REAL_ACTIVITY_PANEL_LABEL) {
        let _ = panel.close();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pldownloader::init());

    builder
        // 启动时调整主窗口：
        // 宽度 = page-config.json 的 page_max_width（单一源头，TypeScript 也读同一文件）
        // 高度按 16:9 计算，但不超过可用区域（排除任务栏）高度的 90%。
        // 窗口初始隐藏，设置尺寸/位置后再 show()，避免先闪默认大小再变形。
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // 仅桌面端调整窗口尺寸/位置（页面最大宽度来自 page-config.json，单一源头）。
                // 移动端（iOS/Android）窗口天然全屏，绝不能 set_size/set_position：
                // iOS 上 set_size(600)+居中会把 WebView 向左偏移 (屏宽-600)/2，
                // 产生"左侧约 103px 触摸死区"（命中区不覆盖，渲染无错位）——见诊断记录。
                #[cfg(not(any(target_os = "ios", target_os = "android")))]
                {
                    let page_max_width: f64 = {
                        let raw = include_str!("../../src/lib/page-config.json");
                        let v: serde_json::Value = serde_json::from_str(raw)
                            .unwrap_or(serde_json::json!({"page_max_width": 1000}));
                        v["page_max_width"].as_f64().unwrap_or(1000.0)
                    };
                    if let Some(monitor) = window.current_monitor().ok().flatten() {
                        let scale = monitor.scale_factor();
                        let wa = monitor.work_area();
                        // work_area 返回物理像素，转换为逻辑像素
                        let avail_w = wa.size.width as f64 / scale;
                        let avail_h = wa.size.height as f64 / scale;
                        let avail_x = wa.position.x as f64 / scale;
                        let avail_y = wa.position.y as f64 / scale;
                        // 宽度固定等于页面最大宽度（逻辑像素，内容刚好铺满窗口）
                        let w = page_max_width;
                        // 高度：按 16:9 计算，但不超过可用区域 90%
                        let h0 = w * 16.0 / 9.0;
                        let h = if h0 <= avail_h * 0.9 { h0 } else { avail_h * 0.9 };
                        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                        // 相对可用区域居中（不遮挡任务栏）
                        let x = avail_x + ((avail_w - w) / 2.0).round();
                        let y = avail_y + ((avail_h - h) / 2.0).round();
                        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                    }
                    // 活动面板（桌面子 WebView）跟随主窗口缩放：窗口 resize 时动态重算
                    // 面板位置/尺寸，让活动页宽度始终与"模拟器页面"（min(窗口宽, 页面最大宽度) 居中）
                    // 保持一致，避免窗口放大缩小后活动页与模拟器页面错位。
                    let win = window.as_ref().window();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Resized(size) = event {
                            let Ok(scale) = win.scale_factor() else {
                                return;
                            };
                            let w = size.width as f64 / scale;
                            let h = size.height as f64 / scale;
                            let (pos, size) = activity_panel_rect_of(w, h);
                            let tb = desktop_titlebar_h();
                            for wv in win.webviews() {
                                if wv.label() == ACTIVITY_PANEL_LABEL {
                                    let _ = wv.set_position(pos);
                                    let _ = wv.set_size(size);
                                } else if wv.label() == REAL_ACTIVITY_PANEL_LABEL {
                                    // 黑抽页：宽度与模拟器页面一致（min(窗口宽, 页面最大宽度) 水平居中），
                                    // 高度铺满自定义窗口标题栏下方，避免页面内容漏出模拟器列宽
                                    let panel_w = if w < page_max_width { w } else { page_max_width };
                                    let _ = wv.set_position(tauri::LogicalPosition::new((w - panel_w) / 2.0, tb));
                                    let _ = wv.set_size(tauri::LogicalSize::new(panel_w, (h - tb).max(0.0)));
                                }
                            }
                        }
                    });
                }
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            debug_acl,
            fetch_json,
            open_activity_panel,
            close_activity_panel,
            open_real_activity_panel,
            close_real_activity_panel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}