use serde_json::Value;
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};
#[cfg(not(desktop))]
use tauri::WebviewWindowBuilder;

/// 活动面板（桌面子 WebView）label
const ACTIVITY_PANEL_LABEL: &str = "activity-panel";
/// 真实活动面板（无 mock，真实交易）label
const REAL_ACTIVITY_PANEL_LABEL: &str = "real-activity-panel";
/// 活动窗口（移动端回退用）label，与 capabilities/default.json 的 windows 保持一致
#[cfg(not(desktop))]
const ACTIVITY_WINDOW_LABEL: &str = "activity";
/// 真实活动窗口（移动端回退用）label
#[cfg(not(desktop))]
const REAL_ACTIVITY_WINDOW_LABEL: &str = "real-activity";

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
  function mount() {{
    try {{
      if (!document.body) return false;
      var existing = document.getElementById("__bili_activity_titlebar__");
      if (existing) existing.remove();
      // 1. 黑色遮罩层：覆盖标题栏上方偏移区域 + 标题栏区域（TOP_OFFSET+BAR_H 高），
      //    封住圆角缝隙，防止页面内容透过；同时把偏移区铺黑，露出黑色空隙。
      var mask = document.getElementById("__bili_activity_titlebar_mask__");
      if (mask) mask.remove();
      mask = document.createElement("div");
      mask.id = "__bili_activity_titlebar_mask__";
      mask.style.cssText =
        "position:fixed;top:0;left:0;right:0;height:" + TOTAL_H + "px;z-index:2147483645;" +
        "background:#000;pointer-events:none;";
      // 2. 标题栏本体（黑色、顶部两角圆角、居中显示标题、固定不随页面滚动）
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
      // 把页面内容推到标题栏下方，避免被固定标题栏遮挡
      document.body.style.paddingTop = TOTAL_H + "px";
      return true;
    }} catch (e) {{ return false; }}
  }}
  function keep() {{
    try {{
      if (!document.body) {{ setTimeout(keep, 100); return; }}
      var bar = document.getElementById("__bili_activity_titlebar__");
      var mask = document.getElementById("__bili_activity_titlebar_mask__");
      if (!bar || !mask) mount();
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
fn page_max_width() -> f64 {
    let raw = include_str!("../../src/lib/page-config.json");
    let v: serde_json::Value = serde_json::from_str(raw)
        .unwrap_or(serde_json::json!({"page_max_width": 1000}));
    v["page_max_width"].as_f64().unwrap_or(1000.0)
}

/// 根据给定的逻辑窗口宽高计算活动面板矩形。
/// 宽度与"模拟器页面"（固定 inset-0 + max-width:page_max_width 水平居中）保持一致：
/// 宽 = min(窗口宽, 页面最大宽度) 并水平居中；高 = 窗口高 * 3/4，贴底（顶部留 1/4）。
/// 这样无论软件窗口放大缩小，活动页都只落在模拟器页面范围内，与模拟器对齐。
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

        let builder = WebviewBuilder::new(ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(inject_config)
            .initialization_script(mock_shim)
            .initialization_script(&title_bar_script)
            .on_navigation(move |nav_url| {
                // 阻止 B站 登录页跳转（跳过登录）
                if is_login_url(nav_url.as_str()) {
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
        // 移动端：独立全屏窗口
        let title = config.get("title").and_then(|v| v.as_str()).unwrap_or("活动");
        if let Some(w) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
            let _ = w.set_focus();
            return Ok(());
        }
        let window = WebviewWindowBuilder::new(&app, ACTIVITY_WINDOW_LABEL, WebviewUrl::External(parsed_url))
            .title(title)
            .initialization_script(inject_config)
            .initialization_script(mock_shim)
            .initialization_script(&title_bar_script)
            .on_navigation(move |nav_url| {
                if is_login_url(nav_url.as_str()) {
                    return false;
                }
                true
            })
            .build()
            .map_err(|e| format!("创建活动窗口失败: {}", e))?;
        let _ = window.show();
        Ok(())
    }
}

/// 关闭活动面板（供前端顶部遮罩点击时调用）
#[tauri::command]
async fn close_activity_panel(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Some(main_window) = app.get_window("main") {
            if let Some(wv) = main_window
                .webviews()
                .iter()
                .find(|w| w.label() == ACTIVITY_PANEL_LABEL)
            {
                let _ = wv.close();
            }
        }
    }
    #[cfg(not(desktop))]
    {
        if let Some(w) = app.get_webview_window(ACTIVITY_WINDOW_LABEL) {
            let _ = w.close();
        }
    }
    let _ = app.emit_to("main", "activity-panel-closed", ());
    Ok(())
}

/// 真实活动页标题栏注入脚本：带左侧返回按钮，点击返回触发导航到 close-activity.local。
/// 与模拟器的 activity_title_bar_script 完全独立，不复用任何代码。
///
/// `top_offset`：标题栏额外顶部偏移。
///  - 桌面端 = 0（标题栏贴顶，safe_top 单独处理刘海安全区）
///  - 移动端 = 100（与模拟器活动页同理，通过注入偏移留出空隙）
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
  var _st = 0;
  try {{ _st = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0; }} catch(e) {{}}
  if (!_st) {{
    try {{
      var st = env(safe-area-inset-top, 0px);
      _st = parseInt(st) || 0;
    }} catch(e) {{}}
  }}
  var SAFE_TOP = _st || 0;
  var BAR_H = 44;
  var TOTAL_H = BAR_H + SAFE_TOP + TOP_OFFSET;
  var BAR_TOP = SAFE_TOP + TOP_OFFSET;
  function mount() {{
    try {{
      if (!document.body) return false;
      if (document.getElementById("__bili_real_titlebar__")) return true;
      var mask = document.getElementById("__bili_real_titlebar_mask__");
      if (mask) mask.remove();
      mask = document.createElement("div");
      mask.id = "__bili_real_titlebar_mask__";
      mask.style.cssText =
        "position:fixed;top:0;left:0;right:0;height:" + TOTAL_H + "px;z-index:2147483645;" +
        "background:#000;pointer-events:none;";
      var bar = document.createElement("div");
      bar.id = "__bili_real_titlebar__";
      bar.style.cssText =
        "position:fixed;top:" + BAR_TOP + "px;left:0;right:0;height:" + TOTAL_H + "px;padding-top:" + SAFE_TOP + "px;z-index:2147483646;" +
        "background:#000;color:#fff;font-size:16px;font-weight:500;line-height:" + BAR_H + "px;" +
        "text-align:center;font-family:'PingFang SC','Microsoft YaHei',sans-serif;" +
        "border-radius:12px 12px 0 0;user-select:none;-webkit-user-select:none;" +
        "display:flex;align-items:center;justify-content:center;";
      // 返回按钮
      var backBtn = document.createElement("div");
      backBtn.style.cssText =
        "position:absolute;left:12px;top:" + BAR_TOP + "px;bottom:0;width:44px;display:flex;" +
        "align-items:center;justify-content:center;cursor:pointer;";
      backBtn.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>';
      backBtn.onclick = function () {{
        window.location.href = "https://close-activity.local/";
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
      if (!bar || !mask) mount();
      if (document.body.style.paddingTop !== TOTAL_H + "px") {{
        document.body.style.paddingTop = TOTAL_H + "px";
      }}
    }} catch (e) {{}}
  }}
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
    // 标题栏顶部偏移：桌面端子 WebView 面板占满主窗口，标题栏贴顶（0）；
    // 移动端窗口天然全屏，通过注入把标题栏/内容整体下移 100px，留出顶部空隙。
    let title_bar_script = {
        #[cfg(desktop)]
        {
            real_activity_title_bar_script(title, 0.0)
        }
        #[cfg(not(desktop))]
        {
            real_activity_title_bar_script(title, 100.0)
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
        if let Some(wv) = main_window
            .webviews()
            .iter()
            .find(|w| w.label() == REAL_ACTIVITY_PANEL_LABEL)
        {
            let _ = wv.set_focus();
            return Ok(());
        }

        // 真实活动页占满整个主窗口
        let scale = main_window.scale_factor().map_err(|e| e.to_string())?;
        let phys = main_window.inner_size().map_err(|e| e.to_string())?;
        let w = phys.width as f64 / scale;
        let h = phys.height as f64 / scale;
        let position = tauri::LogicalPosition::new(0.0, 0.0);
        let size = tauri::LogicalSize::new(w, h);

        let app_handle = app.clone();
        // 拼接所有初始化脚本：先注 Cookie，再挂标题栏
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewBuilder::new(REAL_ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(&init_script)
            .on_navigation(move |nav_url| {
                // 返回按钮触发导航到 close-activity.local，拦截并通知前端关闭
                if nav_url.as_str().contains("close-activity.local") {
                    let _ = app_handle.emit_to("main", "real-activity-back-clicked", ());
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
        if let Some(w) = app.get_webview_window(REAL_ACTIVITY_WINDOW_LABEL) {
            let _ = w.set_focus();
            return Ok(());
        }
        let app_handle = app.clone();
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let window = WebviewWindowBuilder::new(&app, REAL_ACTIVITY_WINDOW_LABEL, WebviewUrl::External(parsed_url))
            .title(title)
            .initialization_script(&init_script)
            .on_navigation(move |nav_url| {
                if nav_url.as_str().contains("close-activity.local") {
                    let _ = app_handle.emit_to("main", "real-activity-back-clicked", ());
                    return false;
                }
                true
            })
            .build()
            .map_err(|e| format!("创建真实活动窗口失败: {}", e))?;
        let _ = window.show();
        Ok(())
    }
}

/// 关闭真实活动面板
#[tauri::command]
async fn close_real_activity_panel(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Some(main_window) = app.get_window("main") {
            if let Some(wv) = main_window
                .webviews()
                .iter()
                .find(|w| w.label() == REAL_ACTIVITY_PANEL_LABEL)
            {
                let _ = wv.close();
            }
        }
    }
    #[cfg(not(desktop))]
    {
        if let Some(w) = app.get_webview_window(REAL_ACTIVITY_WINDOW_LABEL) {
            let _ = w.close();
        }
    }
    let _ = app.emit_to("main", "real-activity-panel-closed", ());
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
                            let (pos, size) = activity_panel_rect_of(
                                size.width as f64 / scale,
                                size.height as f64 / scale,
                            );
                            for wv in win.webviews() {
                                if wv.label() == ACTIVITY_PANEL_LABEL {
                                    let _ = wv.set_position(pos);
                                    let _ = wv.set_size(size);
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
            close_real_activity_panel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}