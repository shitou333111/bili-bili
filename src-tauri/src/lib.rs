use serde_json::Value;
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pldownloader::init())
        // 启动时调整主窗口：
        // 宽度 = page-config.json 的 page_max_width（单一源头，TypeScript 也读同一文件）
        // 高度按 16:9 计算，但不超过可用区域（排除任务栏）高度的 90%。
        // 窗口初始隐藏，设置尺寸/位置后再 show()，避免先闪默认大小再变形。
        .setup(|app| {
            // 从 page-config.json 读取页面最大宽度（编译时嵌入，运行时解析）
            let page_max_width: f64 = {
                let raw = include_str!("../../src/lib/page-config.json");
                let v: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::json!({"page_max_width": 1000}));
                v["page_max_width"].as_f64().unwrap_or(1000.0)
            };
            if let Some(window) = app.get_webview_window("main") {
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
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![debug_acl, fetch_json])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}