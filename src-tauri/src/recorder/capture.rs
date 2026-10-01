//! WGC 采集侧的窗口与 D3D 设备准备。
//!
//! 找窗口：WSA 里 Android 顶层窗口的 class 就是包名本身（含 `danmaku`），
//! **不能按标题找**（直播间切来切去标题会变），按 class + 可见 + 客户区面积最大最稳。
#![cfg(windows)]

use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, ID3D11Device, ID3D11DeviceContext,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetClientRect, GetWindowLongPtrW, GetWindowRect, IsWindowVisible,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_NOACTIVATE, SWP_NOZORDER,
};

/// WSA 窗口的 class 特征（Android 顶层窗口 class 即包名 `tv.danmaku.bili`）
const WSA_CLASS_HINT: &str = "danmaku";

/// 禁掉的窗口样式位：WS_THICKFRAME | WS_MAXIMIZEBOX
/// （去掉边框拖拽缩放与最大化，避免录制中尺寸漂移）。
///
/// **不再清 WS_SYSMENU / WS_MINIMIZEBOX**：那会把标题栏上的最小化与关闭按钮一并去掉。
/// 现在没必要这么做了 —— overlay 的右块正好盖住这两个按钮，录制期间点不到、看不见；
/// 而关掉主程序后 overlay 随之消失、按钮重新露出来，正好能用它自己关掉 B 站 APP。
const STRIPPED_STYLE_BITS: isize = 0x0005_0000;

/// 找 WSA 里的 B 站 APP 窗口：按 class 命中 + 可见 + 客户区面积最大。
pub fn find_wsa_window() -> Option<HWND> {
    let mut found: Vec<(HWND, i32)> = Vec::new();
    let ptr = &mut found as *mut Vec<(HWND, i32)>;
    let _ = unsafe { EnumWindows(Some(enum_proc), LPARAM(ptr as isize)) };
    found.into_iter().max_by_key(|(_, area)| *area).map(|(h, _)| h)
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut buf = [0u16; 256];
    let n = GetClassNameW(hwnd, &mut buf);
    if n <= 0 {
        return BOOL(1);
    }
    let class = String::from_utf16_lossy(&buf[..n as usize]);
    if !class.to_lowercase().contains(WSA_CLASS_HINT) {
        return BOOL(1);
    }
    let (w, h) = client_size(hwnd);
    let list = &mut *(lparam.0 as *mut Vec<(HWND, i32)>);
    list.push((hwnd, w * h));
    BOOL(1)
}

/// 窗口客户区尺寸（像素）
pub fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut r = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut r) }.is_err() {
        return (0, 0);
    }
    (r.right - r.left, r.bottom - r.top)
}

/// 窗口所在显示器的**可用区矩形**（物理像素，已扣掉任务栏）。取不到返回 `None`。
pub fn monitor_work_rect(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        GetMonitorInfoW(mon, &mut mi)
            .as_bool()
            .then_some(mi.rcWork)
    }
}

/// 窗口所在显示器的可用区尺寸（取不到返回 `0,0`）
pub fn monitor_work_area(hwnd: HWND) -> (i32, i32) {
    monitor_work_rect(hwnd)
        .map(|r| (r.right - r.left, r.bottom - r.top))
        .unwrap_or((0, 0))
}

/// 「窗口外框 − 客户区」的差值（边框 + 原生标题栏）。
/// `SetWindowPos` 给的是**外框**尺寸，要按客户区算可用高度就得先把这个差值减掉。
pub fn window_frame(hwnd: HWND) -> (i32, i32) {
    let mut wr = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut wr) }.is_err() {
        return (0, 0);
    }
    let (cw, ch) = client_size(hwnd);
    ((wr.right - wr.left) - cw, (wr.bottom - wr.top) - ch)
}

/// 窗口所在显示器的 DPI（96 = 100% 缩放）。只用于诊断：窗口尺寸是物理像素，
/// 100% 缩放的屏幕拿到的是"同样数字但更占地方"的窗口。
pub fn window_dpi(hwnd: HWND) -> u32 {
    unsafe { GetDpiForWindow(hwnd) }
}

/// 窗口是否被最小化或客户区尺寸为 0（此时 WGC 拿不到帧，应进 paused 态重试）
pub fn is_unusable(hwnd: HWND) -> bool {
    let (w, h) = client_size(hwnd);
    w <= 0 || h <= 0 || unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd).as_bool() }
}

/// 关掉系统给被采集窗口画的高亮边框。
///
/// Windows Graphics Capture 默认会在被采集窗口四周画一条黄色描边（"capture border"），
/// 录制期间整圈发黄、看起来像窗口坏了。Win11 22H2（build 22621）起可以用
/// `IGraphicsCaptureSession3::IsBorderRequired` 关掉；更早的系统上取不到该接口、
/// 会返回失败 —— 那只是多一条黄边，不影响录制，所以只记日志，不上报错误。
pub fn hide_capture_border(capture: &windows::Graphics::Capture::GraphicsCaptureSession) {
    if let Err(e) = capture.SetIsBorderRequired(false) {
        eprintln!("[recorder] 关闭采集高亮边框失败（系统版本较旧时正常）: {e}");
    }
}

/// 窗口定型：禁缩放/禁最大化（**保留最小化与关闭按钮**），并把**客户区**精确调到 `want_w × want_h`。
///
/// 直接 `SetWindowPos` 给客户区尺寸会多出边框，所以先量出「窗口尺寸 − 客户区尺寸」的
/// 边框差值再补上。位置也要夹进所在显示器的**可用区**：窗口原来可能贴着屏幕下沿（WSA 冷启动
/// 的默认位置、或上一轮留下的位置），只改尺寸不搬位置的话，缩小后的窗口照样有一截在屏幕外。
pub fn harden_window(hwnd: HWND, want_w: i32, want_h: i32) -> Result<(), String> {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !STRIPPED_STYLE_BITS);

        let mut wr = RECT::default();
        GetWindowRect(hwnd, &mut wr).map_err(|e| format!("CAPTURE_INIT_FAILED::GetWindowRect 失败: {e}"))?;
        let (cw, ch) = client_size(hwnd);
        let frame_w = (wr.right - wr.left) - cw;
        let frame_h = (wr.bottom - wr.top) - ch;
        let (full_w, full_h) = (want_w + frame_w, want_h + frame_h);

        // `clamp` 的上界可能小于下界（窗口比可用区还大，极端分辨率下会发生），
        // 那样 `clamp` 会 panic —— 用 max() 兜住，等价于「贴左上角」。
        let (mut x, mut y) = (wr.left, wr.top);
        if let Some(wa) = monitor_work_rect(hwnd) {
            x = x.clamp(wa.left, (wa.right - full_w).max(wa.left));
            y = y.clamp(wa.top, (wa.bottom - full_h).max(wa.top));
        }

        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            full_w,
            full_h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|e| format!("CAPTURE_INIT_FAILED::SetWindowPos 失败: {e}"))?;
    }
    Ok(())
}

/// 把 B 站窗口激活（置于前台）。overlay 是它的 owned 窗口，前台状态下才会立刻绘制在它上面；
/// 冷启动完窗口往往还是失活状态，不激活的话要手动点一下窗口 overlay 才会冒出来。
/// 失败不致命（可能被系统的前台锁定策略拒绝），所以忽略返回值。
pub fn activate_window(hwnd: HWND) {
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
}

/// 创建 D3D11 设备。逐级降级：硬解+视频支持 → 硬解 → WARP。
///
/// `VIDEO_SUPPORT` 让设备实现 `ID3D11VideoDevice`（硬编 / 视频处理器用）；
/// WARP 是纯软件光栅器，在无 GPU、虚拟机、远程桌面场景下是唯一能建起来的设备。
pub fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let attempts: [(D3D_DRIVER_TYPE, bool); 3] = [
        (D3D_DRIVER_TYPE_HARDWARE, true),
        (D3D_DRIVER_TYPE_HARDWARE, false),
        (D3D_DRIVER_TYPE_WARP, false),
    ];
    let mut last = String::new();
    for (driver, video_support) in attempts {
        match try_create_device(driver, video_support) {
            Ok(v) => return Ok(v),
            Err(e) => {
                eprintln!(
                    "[recorder] D3D11 设备创建失败（driver={}, video_support={video_support}）: {e}",
                    if driver == D3D_DRIVER_TYPE_WARP { "WARP" } else { "HARDWARE" }
                );
                last = e;
            }
        }
    }
    Err(format!("CAPTURE_INIT_FAILED::D3D11 设备创建失败（含 WARP 兜底）: {last}"))
}

fn try_create_device(
    driver: D3D_DRIVER_TYPE,
    video_support: bool,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT.0; // WGC 必须是 BGRA
    if video_support {
        flags |= D3D11_CREATE_DEVICE_VIDEO_SUPPORT.0;
    }
    let mut device: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    let mut level = Default::default();
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            Default::default(),
            D3D11_CREATE_DEVICE_FLAG(flags),
            None,
            windows::Win32::Graphics::Direct3D11::D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut level),
            Some(&mut ctx),
        )
        .map_err(|e| e.to_string())?;
        let device = device.unwrap();
        // 设备要被编码器 MFT 跨线程使用，必须开多线程保护
        if let Ok(mt) = device.cast::<ID3D10Multithread>() {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok((device, ctx.unwrap()))
    }
}