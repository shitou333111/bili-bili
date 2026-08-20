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

/// 全局复用单个 reqwest Client（连接池/TLS 会话跨请求复用，避免每请求重建握手）。
/// 各命令的超时通过 tokio::time::timeout 单独控制，不影响连接池复用。
/// 并发安全：reqwest::Client 是 Arc<inner>，可被多个命令并发使用。
fn shared_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
                .build()
                .expect("构建全局 HTTP 客户端失败")
        })
        .clone()
}

/// 为 Future 包裹超时，返回 Err(String)（reqwest Client 本身无 per-request timeout，
/// 需在各命令层按业务需要设置超时）
async fn with_timeout<T, F>(secs: u64, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    match tokio::time::timeout(std::time::Duration::from_secs(secs), fut).await {
        Ok(inner) => inner,
        Err(_) => Err(format!("请求超时（{}s）", secs)),
    }
}

#[tauri::command]
async fn fetch_json(url: String) -> Result<Value, String> {
    // 复用全局 client（连接池/TLS 复用）；B站 API 请求需 Referer，单独设置
    let resp = with_timeout(30, async {
        shared_client()
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
            .header("Referer", "https://live.bilibili.com/")
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))
    })
    .await?;

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
///  - 桌面端 = 0（标题栏贴顶，子 WebView 面板本身已占下方 2/3）
///  - 移动端 = -1（iOS/Android 窗口天然全屏，无法用原生尺寸裁剪；由脚本按视口高度动态计算：
///    偏移 = 视口高度 / 3，即活动面板从底部起占屏 2/3，上方 1/3 为可点击收起区 + 标题栏）
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
  var TOTAL_H = 0;
  // top_offset < 0 表示移动端：按视口高度的 1/3 计算偏移（面板从底部起占屏 2/3）。
  function resolveTop() {{
    if (TOP_OFFSET >= 0) return TOP_OFFSET;
    var vh = window.innerHeight || document.documentElement.clientHeight || 600;
    return Math.max(40, Math.round(vh / 3));
  }}
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
      window.__TAURI_INTERNALS__.invoke("close_activity_panel");
    }}, 320);
  }}
  function mount() {{
    try {{
      if (!document.body) return false;
      var TOP = resolveTop();
      TOTAL_H = BAR_H + TOP;
      var existing = document.getElementById("__bili_activity_titlebar__");
      if (existing) existing.remove();
      var oldMask = document.getElementById("__bili_activity_titlebar_mask__");
      if (oldMask) oldMask.remove();
      var oldScrim = document.getElementById("__bili_activity_scrim__");
      if (oldScrim) oldScrim.remove();
      // 1. 可点击收起区（仅移动端 TOP_OFFSET>0）：覆盖标题栏上方偏移区，
      //    暗紫色遮罩，点击整页向下收起（同礼物栏交互）。
      //    背景改为完全不透明：否则页面内容滚动时会从半透明处"透到标题栏上方"，
      //    造成"内容可以滑动超出标题栏"的错觉。不再用纯黑铺满偏移区（避免黑屏观感）。
      //    曾在此区居中显示"↑ 收起"胶囊作视觉提示，已按需求删除，仅保留可点击暗紫遮罩。
      if (TOP > 0) {{
        var scrim = document.createElement("div");
        scrim.id = "__bili_activity_scrim__";
        scrim.style.cssText =
          "position:fixed;top:0;left:0;right:0;height:" + TOP + "px;z-index:2147483644;" +
          "background:linear-gradient(to bottom, #2b1f2b 0%, #241a2e 60%, #1c1426 100%);" +
          "display:flex;align-items:center;justify-content:center;cursor:pointer;";
        scrim.onclick = dismiss;
        document.body.appendChild(scrim);
      }}
      // 2. 标题栏圆角缝隙遮罩：黑色，仅盖住标题栏一行（不再向上延伸铺黑）。
      var mask = document.createElement("div");
      mask.id = "__bili_activity_titlebar_mask__";
      mask.style.cssText =
        "position:fixed;top:" + TOP + "px;left:0;right:0;height:" + BAR_H + "px;z-index:2147483645;" +
        "background:#000;pointer-events:none;";
      // 3. 标题栏本体（黑色、顶部两角圆角、居中显示标题、固定不随页面滚动）
      var bar = document.createElement("div");
      bar.id = "__bili_activity_titlebar__";
      bar.textContent = TITLE;
      bar.style.cssText =
        "position:fixed;top:" + TOP + "px;left:0;right:0;height:" + BAR_H + "px;z-index:2147483646;" +
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
      var need = resolveTop() > 0 ? (!bar || !mask || !scrim) : (!bar || !mask);
      if (need) mount();
      // SPA 可能重置 body 样式，持续保证 paddingTop
      if (document.body.style.paddingTop !== TOTAL_H + "px") {{
        document.body.style.paddingTop = TOTAL_H + "px";
      }}
    }} catch (e) {{}}
  }}
  // Android 系统返回键拦截：向历史压入哨兵记录，使 WryActivity 的返回键回调
  // 判定 canGoBack()=true → goBack() → 触发本页 popstate → 关闭面板。
  // Rust/tao 在 Android 上收不到返回键事件（tao 输入事件处理整段被注释），只能靠 WebView 历史栈。
  (function installAndroidBackGuard() {{
    try {{
      if (!/Android/i.test(navigator.userAgent || "")) return;
      if (window.__bili_activity_back_guard) return;
      window.__bili_activity_back_guard = true;
      history.pushState({{ __biliBack: true }}, "");
      window.addEventListener("popstate", function () {{
        dismiss();
      }});
    }} catch (e) {{}}
  }})();
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
/// 宽 = min(窗口宽, 页面最大宽度) 并水平居中；高 = 窗口高 * 2/3，贴底（顶部留 1/3）。
/// 这样无论软件窗口放大缩小，活动页都只落在模拟器页面范围内，与模拟器对齐。
#[cfg(desktop)]
fn activity_panel_rect_of(
    w: f64,
    h: f64,
) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    let panel_w = if w < page_max_width() { w } else { page_max_width() };
    let panel_h = h * 2.0 / 3.0;
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

/// Android：通过 JNI 调用面板 Activity 的 finish()，真正结束它并从返回栈移除。
///
/// 这是 Tauri 官方 Android 多窗口机制（https://v2.tauri.app/learn/mobile-multiwindow/）
/// 要求的关闭方式：每个面板通过 `WebviewWindowBuilder::activity_name()` 指定独立 Activity，
/// 打开时 `startActivity` 把它压到模拟器（MainActivity）的返回栈上方。
///
/// 关闭链路（源码确认）：
///   finish() → onActivityDestroy（tao/ndk_glue.rs）→ 触发 WindowEvent::Destroyed
///   → Tauri 移除该窗口并释放 label → 下次打开可正常重建（解决"第二次打不开"）。
///
/// 系统返回键：WryActivity 原生判定 webview canGoBack() 则 goBack()，否则
/// onBackPressed() → finish()。因此标题栏脚本向历史压入一个哨兵记录，使返回键命中
/// canGoBack()=true → goBack() → 触发 popstate → 走 JS dismiss() → IPC close_*_panel
/// （先播收起动画再 finish，并 emit 关闭事件让前端复位面板状态）。
///
/// 相比旧的 setContentView 顶替方案：模拟器 Activity 始终在栈底不被顶替，
/// 因此不再有黑屏、上滑拽回、label 永久泄漏等问题。
#[cfg(target_os = "android")]
fn android_finish_activity(app: &tauri::AppHandle, webview_label: &str) {
    let Some(wv) = app.get_webview(webview_label) else {
        eprintln!("[BILI-ANDROID] android_finish_activity: 找不到 webview label={webview_label}");
        return;
    };
    // jni_handle() 定义在 PlatformWebview 上，Webview 需经 with_webview（主线程回调）取得。
    // 注意：① JniHandle::exec 是异步的（把闭包发送到 WebView 线程），返回 () 而非 Result，
    // 所以只检查 with_webview 的派发结果，JNI 调用结果在闭包内通过 call_method 的 Result 记录；
    // ② with_webview 与 exec 的闭包都要求 'static + Send，因此捕获改为 owned String。
    let label = webview_label.to_string();
    if let Err(e) = wv.with_webview(move |platform_wv| {
        platform_wv.jni_handle().exec(move |env, activity, _webview| {
            if activity.is_null() {
                eprintln!("[BILI-ANDROID] android_finish_activity: activity 为空 label={label}");
                return;
            }
            // finish() 结束 Activity 后立即 overridePendingTransition(0,0) 关闭默认的
            // Activity 退出转场动画：否则 JS 收起动画播完后系统还会再播一次
            // "黑背景页面向右收起"的转场，看起来像收起了两次。
            use jni::objects::JValue;
            let res = env.call_method(activity, "finish", "()V", &[]);
            match res {
                Ok(_) => eprintln!("[BILI-ANDROID] finish Activity ({label}) 成功"),
                Err(e) => eprintln!("[BILI-ANDROID] finish Activity ({label}) 失败: {e}"),
            }
            let _ = env.call_method(
                activity,
                "overridePendingTransition",
                "(II)V",
                &[JValue::Int(0), JValue::Int(0)],
            );
        });
    }) {
        eprintln!("[BILI-ANDROID] android_finish_activity: with_webview 派发失败 label={webview_label}: {e}");
    }
}

/// 移动端（iOS）：隐藏面板（复用策略，不销毁窗口）。
///
/// iOS 的 tao 关闭窗口不会触发 WindowEvent::Destroyed（仅应用退出时触发），Tauri 注册表中的
/// label 永远无法释放 → 再次创建必然 WebviewLabelAlreadyExists。因此 iOS 面板"创建一次 + 复用"，
/// 关闭仅隐藏（set_visible(false)），打开时导航/显示。隐藏后把主窗口重新置为 key，
/// 确保模拟器页面回到前台显示。
#[cfg(target_os = "ios")]
fn hide_mobile_panel(app: &tauri::AppHandle, label: &str) {
    if let Some(panel) = app.get_webview_window(label) {
        let _ = panel.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
}

/// 打开 B站 活动页，做成「主窗口内下方 2/3 面板」（像礼物面板弹出一部分页面）。
///
/// 实现：不是 HTML iframe（跨域沙箱限制绕不过），而是用原生 WebView 承载真实 H5，
/// 并在文档开始前注入 mock-shim.js —— 脚本运行在 B站 页面自身 origin 上下文里，
/// 覆盖 fetch/XHR 返回本地 mock，达到「真实 B站 UI + 本地数据 + 不登录 + 不扣费 + 无服务器」。
///
///  - 桌面端：向主窗口 add_child 一个子 WebView，宽度与模拟器页面一致（水平居中），占下方 2/3；
///  - 移动端：Tauri 子 WebView 不支持，回退为独立全屏窗口。
///
/// 移动端窗口生命周期（Android 采用 Tauri 官方多窗口机制，见
/// https://v2.tauri.app/learn/mobile-multiwindow/）：
///  - Android：每个面板用 `activity_name()` 指定独立 Activity，打开 = startActivity 压栈；
///    关闭 = JNI finish() → onActivityDestroy → WindowEvent::Destroyed → label 释放。
///    系统返回键由 WryActivity 原生处理（canGoBack? goBack : finish）。
///  - iOS：tao 只在应用退出时发 WindowEvent::Destroyed，单窗口关闭不发 → label 永远无法释放，
///    重复"创建→销毁→创建"必然失败。修复：窗口"创建一次 + 复用"，关闭仅隐藏（set_visible(false)），
///    每次打开都重新导航（避免复用旧页出现按钮无响应）。
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
    // 标题栏顶部偏移：桌面端子 WebView 面板占下方 2/3，标题栏贴顶（0）；
    // 移动端窗口天然全屏，由脚本按视口 1/3 动态偏移（-1 触发），使面板从底部起占屏 2/3。
    let title_bar_script = {
        #[cfg(desktop)]
        {
            activity_title_bar_script(title, 0.0)
        }
        #[cfg(not(desktop))]
        {
            activity_title_bar_script(title, -1.0)
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
        // 高占主窗口下方 2/3。无论软件窗口如何缩放，活动页都只落在模拟器页面范围内。
        let (position, size) = activity_panel_rect(&main_window)?;

        let builder = WebviewBuilder::new(ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(inject_config)
            .initialization_script(mock_shim)
            .initialization_script(&title_bar_script)
            // 仅阻止 B站 登录页跳转（跳过登录）。关闭由标题栏脚本通过 IPC 调用
            // close_activity_panel 完成（close-activity:// 旧导航方案已废弃）。
            .on_navigation(|nav_url| !is_login_url(nav_url.as_str()));

        let webview = main_window
            .add_child(builder, position, size)
            .map_err(|e| format!("创建活动面板失败: {}", e))?;
        let _ = webview.set_focus();
        Ok(())
    }

    #[cfg(target_os = "android")]
    {
        // Android 官方多窗口机制：面板是独立 Activity（activity_name 指定类名，由 CI 注入到
        // gen/android）。打开 = startActivity 压到模拟器返回栈上方；关闭 = finish()（见
        // android_finish_activity）；系统返回键由 WryActivity 原生处理。
        // 窗口被 finish 后会触发 Destroyed 并释放 label，因此正常路径下这里不会"已存在"；
        // 仅当面板仍在前台（未 finish）时命中，此时重新导航刷新页面即可。
        if app.get_webview_window(ACTIVITY_PANEL_LABEL).is_some() {
            eprintln!("[BILI-ANDROID] open_activity_panel: 面板已存在，navigate 刷新");
            if let Some(panel) = app.get_webview_window(ACTIVITY_PANEL_LABEL) {
                let _ = panel.navigate(parsed_url);
            }
            return Ok(());
        }

        eprintln!("[BILI-ANDROID] open_activity_panel: 首次创建面板（独立 Activity）");
        let builder = WebviewWindowBuilder::new(
            &app,
            ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .activity_name("ActivityPanelActivity")
        .initialization_script(inject_config)
        .initialization_script(mock_shim)
        .initialization_script(&title_bar_script)
        // 仅阻止 B站 登录页跳转（跳过登录）。关闭由标题栏脚本通过 IPC 调用 close_activity_panel
        .on_navigation(|nav_url| !is_login_url(nav_url.as_str()));

        // 新窗口创建时即 startActivity，自动成为前台全屏内容
        let panel = builder
            .build()
            .map_err(|e| format!("创建活动面板失败: {}", e))?;
        let _ = panel.set_focus();
        Ok(())
    }

    #[cfg(target_os = "ios")]
    {
        // iOS：tao 关闭窗口不触发 Destroyed，label 无法释放 → 不能重复创建销毁。
        // 采用"创建一次 + 复用"：窗口常驻，关闭仅隐藏（见 hide_mobile_panel）。
        if let Some(panel) = app.get_webview_window(ACTIVITY_PANEL_LABEL) {
            // 每次打开都重新导航：WKWebView 窗口被隐藏后可能被系统挂起/冻结，
            // 复用旧页面会出现按钮无响应等异常（如黑抽页"已确认风险"按钮）。
            // 重新加载保证页面功能始终正常。
            let _ = panel.navigate(parsed_url);
            let _ = panel.show();
            let _ = panel.set_focus();
            return Ok(());
        }

        let builder = WebviewWindowBuilder::new(
            &app,
            ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .initialization_script(inject_config)
        .initialization_script(mock_shim)
        .initialization_script(&title_bar_script)
        // 仅阻止 B站 登录页跳转（跳过登录）。关闭由标题栏脚本通过 IPC 调用 close_activity_panel
        .on_navigation(|nav_url| !is_login_url(nav_url.as_str()));

        let panel = builder
            .build()
            .map_err(|e| format!("创建活动面板失败: {}", e))?;
        let _ = panel.show();
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
    // 移动端：
    //  - Android：JNI finish() 面板 Activity → 触发 Destroyed → label 释放、返回栈回退到模拟器
    //  - iOS：仅隐藏（复用策略，不销毁窗口，避免 label 永久泄漏导致无法再次打开）
    #[cfg(target_os = "android")]
    {
        eprintln!("[BILI-ANDROID] close_activity_panel: finish Activity");
        android_finish_activity(&app, ACTIVITY_PANEL_LABEL);
    }
    #[cfg(target_os = "ios")]
    hide_mobile_panel(&app, ACTIVITY_PANEL_LABEL);
    Ok(())
}

/// 真实活动页标题栏注入脚本：带左侧返回按钮，点击返回通过 Tauri IPC 调用
/// close_real_activity_panel 命令关闭面板。
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
      // Android：默认非 edge-to-edge（Tauri 未启用），WebView 内容本身从系统状态栏下方开始，
      // 状态栏是独立的黑条，标题栏无需再加安全区高度；否则标题栏会被额外垫高，
      // 视觉上形成"状态栏黑条 + 标题栏"两个黑条相接（标题栏高度像 2 倍）。
      // 若设备为 Android 15+ 强制 edge-to-edge，env() 探针已能取到真实 inset，不会走到这里。
      if (/Android/.test(ua)) return 0;
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
      // 3. 返回按钮（与标题文字同处 44px 行，垂直对齐；点击触发 closePanel → IPC 关闭）
      var backBtn = document.createElement("div");
      backBtn.style.cssText =
        "position:absolute;left:12px;top:" + SAFE_TOP + "px;bottom:0;width:44px;display:flex;" +
        "align-items:center;justify-content:center;cursor:pointer;";
      backBtn.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>';
      backBtn.onclick = closePanel;
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
  // 关闭黑抽面板（返回按钮 / Android 系统返回键共用）
  // 直接通过 Tauri IPC 调用关闭命令，不再用 close-activity:// 导航方案
  // （iOS WKWebView 只为 http/https 触发 on_navigation，自定义 scheme 会被静默忽略）。
  function closePanel() {{
    window.__TAURI_INTERNALS__.invoke("close_real_activity_panel");
  }}
  ensureViewportFit();
  mount();
  // Android 系统返回键拦截：压入哨兵记录 → WryActivity 返回回调判定 canGoBack()=true
  // → goBack() → 触发本页 popstate → closePanel()。Rust/tao 在 Android 收不到返回键，
  // 只能靠 WebView 历史栈拦截（与 activity_panel 脚本一致）。
  (function installAndroidBackGuard() {{
    try {{
      if (!/Android/i.test(navigator.userAgent || "")) return;
      if (window.__bili_real_back_guard) return;
      window.__bili_real_back_guard = true;
      history.pushState({{ __biliBack: true }}, "");
      window.addEventListener("popstate", function () {{
        closePanel();
      }});
    }} catch (e) {{}}
  }})();
  setInterval(keep, 400);
}})();"##
    )
}

/// 打开真实 B站 活动页（无 mock，真实交易）。
/// 与模拟器的 open_activity_panel 完全独立：不注入 mock-shim，不拦截登录，
/// 标题栏带返回按钮（点击通过 IPC 调用 close_real_activity_panel 关闭面板）。
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

        // 拼接所有初始化脚本：先注 Cookie，再挂标题栏。
        // 关闭由标题栏脚本通过 IPC 调用 close_real_activity_panel 完成（close-activity:// 旧导航方案已废弃）
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewBuilder::new(REAL_ACTIVITY_PANEL_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(&init_script);

        let webview = main_window
            .add_child(builder, position, size)
            .map_err(|e| format!("创建真实活动面板失败: {}", e))?;
        let _ = webview.set_focus();
        Ok(())
    }

    #[cfg(target_os = "android")]
    {
        // Android 官方多窗口机制：黑抽页也是独立 Activity（activity_name 指定类名）。
        // 打开 = startActivity 压栈；关闭 = JNI finish()；系统返回键由 WryActivity 原生处理。
        // 窗口被 finish 后触发 Destroyed 并释放 label，正常路径下这里不会"已存在"；
        // 仅当面板仍在前台（未 finish）时命中，此时重新导航刷新页面即可。
        if app.get_webview_window(REAL_ACTIVITY_PANEL_LABEL).is_some() {
            eprintln!("[BILI-ANDROID] open_real_activity_panel: 面板已存在，navigate 刷新");
            if let Some(panel) = app.get_webview_window(REAL_ACTIVITY_PANEL_LABEL) {
                let _ = panel.navigate(parsed_url);
            }
            return Ok(());
        }

        eprintln!("[BILI-ANDROID] open_real_activity_panel: 首次创建面板（独立 Activity）");
        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewWindowBuilder::new(
            &app,
            REAL_ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .activity_name("RealActivityPanelActivity")
        .initialization_script(&init_script);

        // 新窗口创建时即 startActivity，自动成为前台全屏内容
        let panel = builder
            .build()
            .map_err(|e| format!("创建真实活动面板失败: {}", e))?;
        let _ = panel.set_focus();
        Ok(())
    }

    #[cfg(target_os = "ios")]
    {
        // iOS：tao 关闭窗口不触发 Destroyed，label 无法释放 → 不能重复创建销毁。
        // 采用"创建一次 + 复用"：窗口常驻，关闭仅隐藏（见 hide_mobile_panel）。
        if let Some(panel) = app.get_webview_window(REAL_ACTIVITY_PANEL_LABEL) {
            // 每次打开都重新导航：WKWebView 窗口被隐藏后可能被系统挂起/冻结，
            // 复用旧页面会出现按钮无响应等异常（如黑抽页"已确认风险"按钮）。
            // 重新加载保证页面功能始终正常。
            let _ = panel.navigate(parsed_url);
            let _ = panel.show();
            let _ = panel.set_focus();
            return Ok(());
        }

        let init_script = format!("{}\n{}", cookie_script, title_bar_script);
        let builder = WebviewWindowBuilder::new(
            &app,
            REAL_ACTIVITY_PANEL_LABEL,
            WebviewUrl::External(parsed_url),
        )
        .initialization_script(&init_script);

        let panel = builder
            .build()
            .map_err(|e| format!("创建真实活动面板失败: {}", e))?;
        let _ = panel.show();
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
    // 移动端：
    //  - Android：JNI finish() 面板 Activity → 触发 Destroyed → label 释放、返回栈回退到模拟器
    //  - iOS：仅隐藏（复用策略，不销毁窗口，避免 label 永久泄漏导致无法再次打开）
    #[cfg(target_os = "android")]
    {
        eprintln!("[BILI-ANDROID] close_real_activity_panel: finish Activity");
        android_finish_activity(&app, REAL_ACTIVITY_PANEL_LABEL);
    }
    #[cfg(target_os = "ios")]
    hide_mobile_panel(&app, REAL_ACTIVITY_PANEL_LABEL);
    Ok(())
}

// ==================== 更新系统 ====================

/// 检查原生包更新（三平台通用）
/// 前端传入服务器地址，Rust 请求 versions.json，比对本地版本号。
/// versions.json 由 CI 在 publish-artifacts 步骤生成，包含 version 字段（原生版本号）
/// 和各平台日期。本地版本号从 app.package_info() 获取（tauri.conf.json 的 version）。
#[tauri::command]
async fn check_native_update(app: tauri::AppHandle, server_url: String) -> Result<Value, String> {
    // 复用全局 client（连接池复用），10s 超时
    let versions: Value = with_timeout(10, async {
        let resp = shared_client()
            .get(format!("{}/artifacts/versions.json", server_url))
            .send()
            .await
            .map_err(|e| format!("请求版本信息失败: {}", e))?;
        resp.json()
            .await
            .map_err(|e| format!("解析版本信息失败: {}", e))
    })
    .await?;

    let server_version = versions
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let current_version = app.package_info().version.to_string();

    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(target_os = "android")]
    let platform = "android";
    #[cfg(target_os = "ios")]
    let platform = "ios";

    let date = versions.get(platform).and_then(|v| v.as_str()).unwrap_or("");

    Ok(serde_json::json!({
        "hasUpdate": !server_version.is_empty() && server_version != current_version,
        "currentVersion": current_version,
        "serverVersion": server_version,
        "platform": platform,
        "date": date,
    }))
}

/// 清理 app cache 中的旧原生更新安装包，仅保留当前版本文件。
/// - 匹配旧格式 `update.<ext>` 与版本化格式 `update-<version>.<ext>`
/// - keep 为 None 时清理全部；为 Some 时保留该文件（当前下载目标）
/// 仅 Android/iOS 使用（Windows 改走当前文件夹下载，不经过 cache）
#[cfg(any(target_os = "android", target_os = "ios"))]
fn cleanup_native_update_cache(cache_dir: &std::path::Path, ext: &str, keep: Option<&str>) {
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_legacy = name == format!("update.{}", ext);
            let is_versioned = name.starts_with("update-") && name.ends_with(&format!(".{}", ext));
            if (is_legacy || is_versioned) && Some(name.as_str()) != keep {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Android：仅下载 APK 到 app cache 目录，返回文件路径
/// 前端拿到路径后交给 tauri-plugin-android-installer 的 install() 触发系统安装器。
/// 拆分原因：支持"静默后台先下载，用户点击按钮再安装"的统一用户体验。
/// 缓存策略：按版本号命名（update-<version>.apk），同版本已存在则直接复用，避免每次检查重复下载。
#[cfg(target_os = "android")]
#[tauri::command]
async fn download_apk(app: tauri::AppHandle, url: String, version: Option<String>) -> Result<String, String> {
    // 0. 准备缓存目录
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {}", e))?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;

    // 版本化文件名：同版本复用本地缓存，避免每次检查更新重复下载
    let file_name = match version.as_deref() {
        Some(v) if !v.trim().is_empty() => format!("update-{}.apk", v.trim()),
        _ => "update.apk".to_string(),
    };
    let apk_path = cache_dir.join(&file_name);

    // 已有同版本缓存（非空文件）→ 直接复用，跳过重复下载
    if apk_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(apk_path.to_string_lossy().to_string());
    }

    // 1. 下载 APK（复用全局 client；600s 整体超时）
    let (status, bytes) = with_timeout(600, async {
        let resp = shared_client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("下载 APK 失败: {}", e))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取 APK 数据失败: {}", e))?;
        Ok((status, bytes))
    })
    .await?;

    // 保存前校验 HTTP 状态（下载失败时不写入损坏文件）
    if !status.is_success() {
        return Err(format!("下载 APK 失败: HTTP {}", status.as_u16()));
    }

    // 2. 保存到 app cache 目录
    std::fs::write(&apk_path, &bytes).map_err(|e| format!("写入 APK 文件失败: {}", e))?;

    // 3. 清理旧版本缓存（仅保留当前版本，含旧格式 update.apk）
    cleanup_native_update_cache(&cache_dir, "apk", Some(&file_name));

    Ok(apk_path.to_string_lossy().to_string())
}

/// Android：重启 APP
/// 流程：AlarmManager.set(100ms 后拉起本包 LAUNCHER Activity) → 立即 killProcess(...)
/// 系统会在 100ms 后启动一个全新进程，等同于冷启动，新前端 bundle 生效。
#[cfg(target_os = "android")]
#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    use jni::objects::JValue;

    let main_wv = app.get_webview("main").ok_or("找不到主 webview")?;
    main_wv.with_webview(move |platform_wv| {
        platform_wv.jni_handle().exec(move |env, activity, _webview| {
            if activity.is_null() {
                eprintln!("[BILI-RESTART] activity 为空");
                return;
            }

            // 1. 获取包名
            let pkg_obj = match env.call_method(activity, "getPackageName", "()Ljava/lang/String;", &[]) {
                Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()),
                Err(e) => { eprintln!("[BILI-RESTART] getPackageName 失败: {e}"); return; }
            };
            let pkg_str: String = if pkg_obj.is_null() {
                eprintln!("[BILI-RESTART] getPackageName 返回空");
                return;
            } else {
                env.get_string(&pkg_obj.into()).map(|s| s.into()).unwrap_or_default()
            };

            // 2. 用 PackageManager.getLaunchIntentForPackage(pkg) 获取启动本 APP 的 Intent
            //    这是最简单可靠的方式（不用 hardcode Activity 类名）
            let pm_obj = match env.call_method(
                activity,
                "getPackageManager",
                "()Landroid/content/pm/PackageManager;",
                &[],
            ) {
                Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()),
                Err(e) => { eprintln!("[BILI-RESTART] getPackageManager 失败: {e}"); return; }
            };
            if pm_obj.is_null() {
                eprintln!("[BILI-RESTART] PackageManager 为空");
                return;
            }
            let pkg_jstr = match env.new_string(&pkg_str) {
                Ok(s) => s,
                Err(e) => { eprintln!("[BILI-RESTART] new_string pkg 失败: {e}"); return; }
            };
            let intent_obj = match env.call_method(
                &pm_obj,
                "getLaunchIntentForPackage",
                "(Ljava/lang/String;)Landroid/content/Intent;",
                &[JValue::Object(&pkg_jstr)],
            ) {
                Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()),
                Err(e) => { eprintln!("[BILI-RESTART] getLaunchIntentForPackage 失败: {e}"); return; }
            };
            if intent_obj.is_null() {
                eprintln!("[BILI-RESTART] launch intent 为空");
                return;
            }
            // FLAG_ACTIVITY_CLEAR_TOP | FLAG_ACTIVITY_NEW_TASK：确保新 Activity 覆盖整个返回栈
            const FLAGS: i32 = 0x00008000 | 0x10000000; // CLEAR_TOP | NEW_TASK
            if let Err(e) = env.call_method(&intent_obj, "addFlags", "(I)Landroid/content/Intent;", &[JValue::Int(FLAGS)]) {
                eprintln!("[BILI-RESTART] addFlags 失败: {e}");
                return;
            }

            // 3. 包装 Intent 为 PendingIntent.getBroadcast → 用 AlarmManager.RTC_WAKEUP 设 150ms 后触发
            //    使用 PendingIntent.getActivity 直接拉起 Activity
            let context_class = match env.find_class("android/content/Context") {
                Ok(c) => c,
                Err(e) => { eprintln!("[BILI-RESTART] find_class Context 失败: {e}"); return; }
            };
            let alarm_service_field = match env.get_static_field(context_class, "ALARM_SERVICE", "Ljava/lang/String;") {
                Ok(f) => f,
                Err(e) => { eprintln!("[BILI-RESTART] ALARM_SERVICE field 失败: {e}"); return; }
            };
            let alarm_service_jstr = match alarm_service_field.l() {
                Ok(s) => s,
                Err(e) => { eprintln!("[BILI-RESTART] ALARM_SERVICE get 失败: {e}"); return; }
            };
            // 显式标注 String：否则两个 .into()（JObject→JString、JavaStr→String）
            // 在 unwrap_or_default 下会推断塌缩成 ()，编译失败
            let alarm_service: String = if alarm_service_jstr.is_null() {
                eprintln!("[BILI-RESTART] ALARM_SERVICE 为空");
                return;
            } else {
                env.get_string(&alarm_service_jstr.into()).map(|s| s.into()).unwrap_or_default()
            };
            let alarm_service_arg = match env.new_string(&alarm_service) {
                Ok(s) => s,
                Err(e) => { eprintln!("[BILI-RESTART] new_string alarm_service 失败: {e}"); return; }
            };
            let am_obj = match env.call_method(
                activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[JValue::Object(&alarm_service_arg)],
            ) {
                Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()),
                Err(e) => { eprintln!("[BILI-RESTART] getSystemService 失败: {e}"); return; }
            };
            if am_obj.is_null() {
                eprintln!("[BILI-RESTART] AlarmManager 为空");
                return;
            }

            // 4. 创建 PendingIntent.getActivity
            let pi_class = match env.find_class("android/app/PendingIntent") {
                Ok(c) => c,
                Err(e) => { eprintln!("[BILI-RESTART] find_class PendingIntent 失败: {e}"); return; }
            };
            // requestCode = 12345（任意值，唯一即可）
            const REQUEST_CODE: i32 = 12345;
            // flags: FLAG_IMMUTABLE (0x04000000)
            const PI_FLAGS: i32 = 0x04000000; // FLAG_IMMUTABLE
            let current_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64 + 150) // 150ms 后
                .unwrap_or(150);

            let pi_obj = match env.call_static_method(
                pi_class,
                "getActivity",
                "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
                &[
                    JValue::Object(activity),
                    JValue::Int(REQUEST_CODE),
                    JValue::Object(&intent_obj),
                    JValue::Int(PI_FLAGS),
                ],
            ) {
                Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()),
                Err(e) => { eprintln!("[BILI-RESTART] PendingIntent.getActivity 失败: {e}"); return; }
            };
            if pi_obj.is_null() {
                eprintln!("[BILI-RESTART] PendingIntent 为空");
                return;
            }

            // 5. AlarmManager.set(RTC_WAKEUP, triggerAtMillis, pi)
            const RTC_WAKEUP: i32 = 0;
            if let Err(e) = env.call_method(
                &am_obj,
                "set",
                "(IJLandroid/app/PendingIntent;)V",
                &[
                    JValue::Int(RTC_WAKEUP),
                    JValue::Long(current_time),
                    JValue::Object(&pi_obj),
                ],
            ) {
                eprintln!("[BILI-RESTART] AlarmManager.set 失败: {e}");
                return;
            }

            // 6. 立即杀掉自己（Process.killProcess(Process.myPid())）
            let proc_class = match env.find_class("android/os/Process") {
                Ok(c) => c,
                Err(e) => { eprintln!("[BILI-RESTART] find_class Process 失败: {e}"); return; }
            };
            let my_pid = match env.call_static_method(&proc_class, "myPid", "()I", &[]) {
                Ok(v) => v.i().unwrap_or(0),
                Err(e) => { eprintln!("[BILI-RESTART] myPid 失败: {e}"); return; }
            };
            let _ = env.call_static_method(&proc_class, "killProcess", "(I)V", &[JValue::Int(my_pid)]);
        });
    }).map_err(|e| format!("with_webview 派发失败: {}", e))
}

/// 非 Android 平台的 restart_app（保持编译通过）
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn restart_app(_app: tauri::AppHandle) -> Result<(), String> {
    Err("restart_app 仅 Android 实现；桌面端用 process 插件，iOS 无 API".into())
}

/// 非 Android 平台的 download_apk stub（保证 invoke_handler 在所有平台编译通过）
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn download_apk(_app: tauri::AppHandle, _url: String, _version: Option<String>) -> Result<String, String> {
    Err("download_apk 仅在 Android 平台可用".into())
}

/// iOS：仅下载 IPA 到 app cache 目录，返回文件路径
/// 前端拿到路径后可再次调用或直接用 openPath 触发"Open In"面板。
/// 拆分与 download_apk 相同的目的：静默下载，用户点击按钮再打开面板。
/// 缓存策略：按版本号命名（update-<version>.ipa），同版本已存在则直接复用，避免重复下载。
#[cfg(target_os = "ios")]
#[tauri::command]
async fn download_ipa(app: tauri::AppHandle, url: String, version: Option<String>) -> Result<String, String> {
    // 0. 准备缓存目录
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {}", e))?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;

    // 版本化文件名：同版本复用本地缓存，避免每次检查更新重复下载
    let file_name = match version.as_deref() {
        Some(v) if !v.trim().is_empty() => format!("update-{}.ipa", v.trim()),
        _ => "update.ipa".to_string(),
    };
    let ipa_path = cache_dir.join(&file_name);

    // 已有同版本缓存（非空文件）→ 直接复用，跳过重复下载
    if ipa_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(ipa_path.to_string_lossy().to_string());
    }

    // 1. 下载 IPA（复用全局 client；600s 整体超时）
    let (status, bytes) = with_timeout(600, async {
        let resp = shared_client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("下载 IPA 失败: {}", e))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取 IPA 数据失败: {}", e))?;
        Ok((status, bytes))
    })
    .await?;

    // 保存前校验 HTTP 状态（下载失败时不写入损坏文件）
    if !status.is_success() {
        return Err(format!("下载 IPA 失败: HTTP {}", status.as_u16()));
    }

    // 2. 保存到 app cache 目录
    std::fs::write(&ipa_path, &bytes).map_err(|e| format!("写入 IPA 文件失败: {}", e))?;

    // 3. 清理旧版本缓存（仅保留当前版本，含旧格式 update.ipa）
    cleanup_native_update_cache(&cache_dir, "ipa", Some(&file_name));

    Ok(ipa_path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn download_ipa(_app: tauri::AppHandle, _url: String, _version: Option<String>) -> Result<String, String> {
    Err("download_ipa 仅在 iOS 平台可用".into())
}

/// Windows：仅下载新版本 EXE 到当前文件夹（应用所在目录），返回文件路径。
/// 与 Android download_apk 同模式：静默后台先下载，用户点击按钮再原地替换安装。
/// 不经过缓存目录：新版本与正式 exe 同目录，替换时同目录 rename 原子可靠；
/// 文件名为 <原名>-新版本-<版本>.exe，同版本已存在则复用，避免重复下载。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn download_exe(_app: tauri::AppHandle, url: String, version: Option<String>) -> Result<String, String> {
    // 0. 目标 EXE（用户启动的绿色单文件）所在目录 = 当前文件夹
    let target = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let target_dir = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);

    // 版本化临时文件名：<原名>-新版本-<版本>.exe，与正式 exe 同目录（与旧版本备份命名风格统一）
    let exe_stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bili-live")
        .to_string();
    let file_name = match version.as_deref() {
        Some(v) if !v.trim().is_empty() => format!("{}-新版本-{}.exe", exe_stem, v.trim()),
        _ => format!("{}-新版本.exe", exe_stem),
    };
    let exe_path = target_dir.join(&file_name);

    // 已有同版本文件（非空）→ 直接复用，跳过重复下载
    if exe_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(exe_path.to_string_lossy().to_string());
    }

    // 1. 下载新版本 EXE（复用全局 client；600s 整体超时）
    let (status, bytes) = with_timeout(600, async {
        let resp = shared_client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("下载新版本失败: {}", e))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取新版本数据失败: {}", e))?;
        Ok((status, bytes))
    })
    .await?;

    // 保存前校验 HTTP 状态（下载失败时不写入损坏文件）
    if !status.is_success() {
        return Err(format!("下载新版本失败: HTTP {}", status.as_u16()));
    }

    // 2. 写入当前文件夹（应用目录需可写，原地替换同样要求）
    std::fs::write(&exe_path, &bytes)
        .map_err(|e| format!("写入新版本文件失败（请确认应用所在文件夹可写）: {}", e))?;

    Ok(exe_path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn download_exe(_app: tauri::AppHandle, _url: String, _version: Option<String>) -> Result<String, String> {
    Err("download_exe 仅在 Windows 平台可用".into())
}

/// Windows：原地替换更新（绿色单文件免安装方案的持久化更新）。
///
/// 背景：官方 tauri-plugin-updater 只支持 NSIS/MSI 安装包，裸 exe 更新会"假成功"——
/// 新 exe 被从临时目录直接运行，关闭后消失，旧 exe 原封不动。此命令解决该问题。
///
/// 更新策略：不经过缓存目录，直接在应用所在文件夹完成——
///   · 新版本文件 <原名>-新版本-<版本>.exe 与正式 exe 同目录（download_exe 已下载）
///   · 旧版本重命名为 <原名>-旧版本-<版本>.exe 保留，用户可随时找回/回退
///   · 新版本 rename 为正式名，重启即生效
///
/// 流程：
///  1. 把当前运行中的 exe 复制一份到 %TEMP% 作为 helper（正在运行的 exe 可被复制）
///  2. 以 --in-place-update <new_exe> <target_exe> <parent_pid> <old_version> 启动 helper
///  3. 立即退出当前进程，释放 exe 文件锁
///  4. helper 等待当前进程退出 → 旧版本改名保留 → 用新 exe 替换原 exe → 重启新版本
#[cfg(target_os = "windows")]
#[tauri::command]
fn apply_in_place_update(new_exe_path: String, old_version: String) -> Result<(), String> {
    use std::path::PathBuf;

    let current = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {}", e))?;
    let new_exe = PathBuf::from(&new_exe_path);
    if !new_exe.is_file() {
        return Err(format!("新版本文件不存在: {}", new_exe_path));
    }
    if current.canonicalize().ok() == new_exe.canonicalize().ok() {
        return Err("新版本文件与当前文件相同".into());
    }

    // helper 放临时目录（独立副本，可自由操作被锁的原 exe）
    let exe_stem = current
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bili-live")
        .to_string();
    let helper_dir = std::env::temp_dir().join(format!("{}-updater-{}", exe_stem, std::process::id()));
    std::fs::create_dir_all(&helper_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let helper = helper_dir.join(format!("{}-updater.exe", exe_stem));
    std::fs::copy(&current, &helper).map_err(|e| format!("复制更新器失败: {}", e))?;

    std::process::Command::new(&helper)
        .arg("--in-place-update")
        .arg(&new_exe)
        .arg(&current)
        .arg(std::process::id().to_string())
        .arg(&old_version)
        .spawn()
        .map_err(|e| format!("启动更新器失败: {}", e))?;

    // 当前进程立即退出，释放 exe 文件锁，helper 等待退出后替换
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn apply_in_place_update(_new_exe_path: String, _old_version: String) -> Result<(), String> {
    Err("apply_in_place_update 仅在 Windows 平台可用".into())
}

/// Windows：原地替换更新 helper 主逻辑。
/// 由旧进程复制自身到 %TEMP% 后以
/// --in-place-update <new_exe> <target_exe> <parent_pid> <old_version> 启动。
/// 等待旧进程退出 → 旧版本重命名为 <原名>-旧版本-<版本>.exe 保留 → 新版本替换 → 重启新版本。
#[cfg(target_os = "windows")]
fn run_in_place_update() -> i32 {
    use std::path::PathBuf;
    use std::process::Command;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // windows-sys 0.61 中 SYNCHRONIZE 定义在 Win32::Storage::FileSystem（0x00100000），
    // 这里直接本地定义，避免引入额外的 feature 与跨模块常量导入。
    const SYNCHRONIZE: u32 = 0x0010_0000;

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) != Some("--in-place-update") {
        return 1;
    }
    let (Some(new_exe), Some(target), Some(pid_str), Some(old_version)) =
        (args.get(2), args.get(3), args.get(4), args.get(5))
    else {
        return 1;
    };
    let new_exe = PathBuf::from(new_exe);
    let target = PathBuf::from(target);
    let Ok(parent_pid) = pid_str.parse::<u32>() else { return 1 };

    // 1. 等待原进程完全退出（释放 target exe 文件锁）
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, parent_pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 0xFFFFFFFF); // INFINITE
            CloseHandle(handle);
        }
    }

    // 2. 旧版本重命名保留：<原名>-旧版本-<版本>.exe（与应用同目录，用户可找回/回退）
    //    与 target 同目录 rename，保证原子成功；同名备份残留时先清理避免覆盖失败。
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("bili-live");
    let backup = target.with_file_name(format!("{}-旧版本-{}.exe", stem, old_version));
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
    if let Err(e) = std::fs::rename(&target, &backup) {
        eprintln!("[BILI-UPDATE] 重命名旧版本失败: {e}");
        let _ = Command::new(&target).spawn(); // 尽力重启旧版本
        return 3;
    }

    // 3. 新版本替换为正式名（与应用同目录，rename 原子成功）
    if let Err(e) = std::fs::rename(&new_exe, &target) {
        eprintln!("[BILI-UPDATE] 替换 exe 失败: {e}");
        // 恢复旧版本，避免用户"打不开应用"
        let _ = std::fs::rename(&backup, &target);
        let _ = Command::new(&target).spawn();
        return 4;
    }

    // 4. 重启新版本（helper 为独立进程，自身退出后新版本继续运行）
    if let Err(e) = Command::new(&target).spawn() {
        eprintln!("[BILI-UPDATE] 重启失败: {e}");
        return 5;
    }

    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ==================== Windows 原地替换更新 helper ====================
    // 若以 --in-place-update 参数启动，说明是更新 helper（由旧进程复制自身到 %TEMP% 后拉起）：
    // 等待旧进程退出 → 替换 exe → 重启。执行完直接退出，不启动 GUI、不闪窗口。
    #[cfg(target_os = "windows")]
    if std::env::args().any(|a| a == "--in-place-update") {
        let code = run_in_place_update();
        std::process::exit(code);
    }

    // ==================== 热更新插件初始化 ====================
    // tauri-plugin-hotswap：三平台通用的前端资源 OTA（CodePush 风格）。
    // 与 hot-update 不同：hotswap 在启动时用 Context::set_assets() 替换 embedded
    // asset provider，live_asset_dir 是运行时共享的 Arc<RwLock>，apply/activate 后
    // 立即切换，window.location.reload() 即加载新资源（无需重启进程，iOS 也可用）。
    // init() 必须最先调用：它消费原 context 并返回替换了 asset provider 的新 context，
    // 后续 Builder 必须用新 context run，WebView 才从 hotswap 服务资源。
    let context = tauri::generate_context!();
    let (hotswap, context) =
        tauri_plugin_hotswap::init(context).expect("failed to initialize hotswap plugin");

    // builder 仅在移动端因插件注册需要 mut；桌面端不加允许属性会产生 unused_mut 警告。
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // 热更新插件（asset provider 替换已在 init() 完成，这里注册命令与状态）
        .plugin(hotswap)
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pldownloader::init())
        // 分享插件：iOS 端 shareFile 用 UIActivityViewController 弹出分享面板，
        // 把 IPA 交给自签工具覆盖安装（opener 的 UIApplication.open 处理不了 IPA）。
        .plugin(tauri_plugin_sharekit::init());
    // iOS：注册 webview-insets 插件，把 WKWebView 的 contentInsetAdjustmentBehavior 设为 .never，
    // 关闭系统对 WebView 自动施加的安全区内边距，使 Web 内容真正铺满全屏（edge-to-edge），
    // 此时 env(safe-area-inset-*) 才返回真实值 —— 竖屏直播视频才能扩展到状态栏/Home 指示区，
    // 否则视频上下各露出一条黑边（本次顽固问题 #6 的根因）。
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_ios_webview_insets::init());
    }
    // Android：注册 APK 安装插件（替换手写 JNI 的 install_apk）。
    // 自带 FileProvider + REQUEST_INSTALL_PACKAGES 权限（manifest 自动合并），
    // 提供 install / canInstall / requestInstallPermission 命令。
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_installer::init());
    }

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
                // 桌面端仅支持 Windows（不支持 macOS/Linux）。
                #[cfg(windows)]
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
            check_native_update,
            // 安装 APK 由 tauri-plugin-android-installer 插件处理（不再注册自定义命令）。
            download_apk,
            download_ipa,
            download_exe,
            apply_in_place_update,
            restart_app,
        ])
        .run(context)
        .expect("error while running tauri application");
}