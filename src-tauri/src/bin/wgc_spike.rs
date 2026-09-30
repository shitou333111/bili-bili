// 「原始录屏」验证入口（不属于产品代码，仅用于人工验收 recorder 模块）。
//
// 跑法：cargo run --bin wgc_spike -- <输出目录> [录制秒数] [文件名（不含扩展名）]
//
// 它现在直接驱动 `app_lib::recorder` 的产品代码（不再是独立的采集实现），
// 所以跑通就等于「产品链路可用」：找 WSA 窗口 → 定型 → WGC 采集 → 裁掉 58px 标题栏
// → Media Foundation 编 H.264 mp4 → 按礼物名收尾重命名。
#![cfg(windows)]

use std::time::Duration;

use app_lib::recorder;

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let secs: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    let stem = std::env::args().nth(3);

    let _ = unsafe {
        windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
    };

    let Some(hwnd) = recorder::find_wsa_window() else {
        eprintln!("!! 找不到 WSA(B站) 窗口");
        std::process::exit(1);
    };
    let (cw, ch) = recorder::client_size(hwnd);
    println!("窗口 hwnd = {}  client = {cw}x{ch}", hwnd.0 as isize);

    // 与产品一致：先定型（禁缩放/最大化，客户区调到 900×1658），再开录
    if let Err(e) = recorder::harden_window(hwnd, 900, recorder::WANT_CLIENT_H) {
        eprintln!("!! 窗口定型失败: {e}");
        std::process::exit(1);
    }
    let (cw, ch) = recorder::client_size(hwnd);
    println!("定型后 client = {cw}x{ch}（期望 900x{}）", recorder::WANT_CLIENT_H);

    let dir_path = std::path::PathBuf::from(&dir);
    let temp = match recorder::start(hwnd, &dir_path) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("!! 启动录制失败: {e}");
            std::process::exit(1);
        }
    };
    println!("录制中 -> {}", temp.display());

    std::thread::sleep(Duration::from_secs(secs));

    match recorder::stop(&dir_path, stem.as_deref()) {
        Ok(Some(p)) => {
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            println!("完成 -> {}（{} 字节）", p.display(), size);
        }
        Ok(None) => println!("!! 没有进行中的录制"),
        Err(e) => {
            eprintln!("!! 收尾失败: {e}");
            std::process::exit(1);
        }
    }
}