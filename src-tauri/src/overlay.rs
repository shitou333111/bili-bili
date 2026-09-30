//! WSA 窗口的标题栏 overlay：贴在 WSA 客户区顶部 58px 上的一条自绘标题栏。
//!
//! 从原型 `bar_overlay.ps1` 移植（原型已实测：挖洞穿透、拖拽、底色跟随、置底都正常）：
//! - 原生 Win32 窗口（不是 Tauri 窗口，省内存），`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`
//! - 创建时就把 WSA 窗口当 **owner** 传进 `CreateWindowExW`（不能事后 `SetWindowLongPtrW` 补，
//!   那样 owner 关系生效但 z-order 不刷新 → owner 未激活时 overlay 不显示），
//!   之后每次同步都用 `SetWindowPos(ov, Some(wsa), …)` 把它钉在 owner 上一层
//! - `SetWindowRgn` 三块并集挖洞（左块 / 右块 / 顶部通条）：中间空白不在窗口区域内，
//!   点击直接穿透到 WSA 自己的标题栏 —— 所以"拖标题栏空白处拖窗口"是白送的，不必做 hit-test
//! - 150ms 采样 WSA 真实标题栏像素（采样点每拍按窗口当前位置重算）→ 激活暖黄 / 失活灰自动跟随
//! - `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` 跟窗口移动，500ms 定时器兜底同步
//! - 最右侧「隐藏」按钮 → 把 WSA 窗口 `SetWindowPos` 到 `HWND_BOTTOM`（等价最小化，但录制不受影响）
#![cfg(windows)]

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, ClientToScreen, CombineRgn, CreateFontIndirectW, CreateRectRgn, CreateSolidBrush,
    DeleteObject, DrawTextW, Ellipse, EndPaint, ExtCreatePen, FillRect, GetDC, GetPixel,
    GetStockObject, GetTextExtentPoint32W, InvalidateRect, LineTo, MoveToEx, Polygon, ReleaseDC,
    SelectObject, SetBkMode, SetTextColor, SetWindowRgn, BS_SOLID, CLEARTYPE_QUALITY,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE,
    DT_VCENTER,
    FF_DONTCARE, FW_NORMAL, HDC, HFONT, HGDIOBJ, LOGFONTW, LOGBRUSH, NULL_PEN, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, PS_ENDCAP_ROUND, PS_GEOMETRIC, PS_JOIN_ROUND, PS_SOLID, RGN_OR, TRANSPARENT,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{
    SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, CreateWindowExW, DefWindowProcW, DestroyIcon, DispatchMessageW,
    DrawIconEx, GetClientRect, GetMessageW, GetWindowThreadProcessId, HWND_BOTTOM, IMAGE_FLAGS,
    KillTimer, MSG, PostMessageW, PostQuitMessage, RegisterClassW, SetTimer,
    SetWindowPos, TranslateMessage, CS_HREDRAW, CS_VREDRAW, DI_NORMAL, HICON,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WM_CLOSE, WM_DESTROY,
    WM_ERASEBKGND, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::recorder;

// ==================== 尺寸（物理像素，与原型一致） ====================

/// 标题栏高度（与 `recorder::BAR_H` 同一数值：WSA 客户区顶部 Android 自绘的那条）
const BAR_H: i32 = 58;
/// 顶部通条高度（把窗口顶边封住）
const TOP_BAND: i32 = 13;
/// 左块宽度（图标 + 「B瓜录屏」+ 静音按钮）——实际宽度见 [`left_block_w`]，它只会更宽
const BAR_L: i32 = 230;
/// 右块宽度的兜底值（状态灯 + 状态文字 + 隐藏按钮）。真实宽度由 [`measure_right_block`]
/// 按当前字体量出来（见 [`right_block_w`]）——定值 340 会在右侧留一截空白，
/// 既白占地方又让中间可拖拽的「洞」变窄。
const BAR_RW_FALLBACK: i32 = 340;
/// 右块内的间距：隐藏按钮 ←→ 状态文字
const BTN_GAP: i32 = 16;
/// 右块内的间距：状态文字 ←→ 状态灯
const DOT_GAP: i32 = 10;
/// 右块左右两侧的留白
const SIDE_PAD: i32 = 8;
/// 「隐藏」按钮里文字两侧的留白（按钮宽 = 文字宽 + 2×它）
const HIDE_PAD: i32 = 10;
/// 右块最右侧按钮的文案。原先是向下的箭头（= 置底），箭头看不出是什么意思，换成字。
const HIDE_LABEL: &str = "隐藏";
/// 两种状态文案（右块宽度按更宽的那个量）
const STATUS_LISTEN: &str = "监听礼物中···";
const STATUS_RECORD: &str = "礼物录屏中···";
/// 字号。单位必须是物理像素：写成「点」会被 200% DPI 放大到撑爆标题栏
const FS: i32 = 26;
/// 图标绘制边长
const ICON_PX: i32 = 40;
/// 标题文字（静音按钮紧跟其后，位置依赖它的宽度）
const TITLE: &str = "B瓜录屏";
/// 标题文字左边界（图标右边再留一点空隙）
const TITLE_X: i32 = 14 + ICON_PX + 8;
/// 静音按钮与标题文字之间的间距
const TITLE_GAP: i32 = 10;
/// 按钮宽度（置底 / 静音共用）
const BTN_W: i32 = 46;
/// 按钮右边距
const BTN_PAD: i32 = 8;
/// 状态灯直径
const DOT_D: i32 = 14;
/// 底色采样点相对 WSA 客户区原点的偏移（取「洞」正中，y 取标题栏中线）
const SAMPLE_OFF_Y: i32 = 29;

/// 定时器 id 与周期
const TIMER_SYNC: usize = 1;
const TIMER_BG: usize = 2;
const SYNC_MS: u32 = 500;
const BG_MS: u32 = 150;

/// `WM_MOUSELEAVE`（`Win32::UI::Controls` 里的常量，本模块不引那整个 feature）
const WM_MOUSELEAVE: u32 = 0x02A3;
/// `EVENT_OBJECT_LOCATIONCHANGE` / `WINEVENT_*`（同理，直接写数值避免多引 feature）
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;
/// `OBJID_WINDOW`
const OBJID_WINDOW: i32 = 0;

/// COLORREF 是 `0x00BBGGRR`（红在最低字节）
const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    COLORREF(r | (g << 8) | (b << 16))
}

const C_INK_TITLE: COLORREF = rgb(58, 58, 62);
const C_INK_STATUS: COLORREF = rgb(90, 90, 96);
const C_GREEN: COLORREF = rgb(34, 170, 80);
const C_RED: COLORREF = rgb(226, 62, 62);
const C_ARROW: COLORREF = rgb(70, 70, 76);
/// 底色初值（浅灰）。真实底色由 150ms 采样跟随 WSA 标题栏，这里只是首帧兜底
const C_BG_FALLBACK: COLORREF = rgb(243, 243, 243);

// ==================== 进程内状态 ====================

static OVERLAY: AtomicIsize = AtomicIsize::new(0);
static WSA: AtomicIsize = AtomicIsize::new(0);
static HOOK: AtomicIsize = AtomicIsize::new(0);
static FONT: AtomicIsize = AtomicIsize::new(0);
static ICON: AtomicIsize = AtomicIsize::new(0);
static WIDTH: AtomicIsize = AtomicIsize::new(0);
/// 右块宽度 / 「隐藏」按钮宽度（创建窗口时按当前字体量一次，见 `measure_right_block`）
static RIGHT_W: AtomicI32 = AtomicI32::new(0);
static HIDE_W: AtomicI32 = AtomicI32::new(0);
/// 标题「B瓜录屏」在当前字体下的像素宽度（创建窗口时量一次，按钮位置要跟着它走）
static TITLE_W: AtomicI32 = AtomicI32::new(0);
/// 当前底色（COLORREF 原值）
static BG: AtomicU32 = AtomicU32::new(C_BG_FALLBACK.0);
static RECORDING: AtomicBool = AtomicBool::new(false);
/// 鼠标悬停的按钮（-1 无 / 0 置底 / 1 静音）
static HOVER_BTN: AtomicI32 = AtomicI32::new(-1);
/// B 站 APP 的**期望**静音状态。默认静音：录屏时不外放 APP 声音，
/// 想看/想听再点一下取消（音频会话可能要过一会儿才出现，靠定时器反复落实）
static MUTED: AtomicBool = AtomicBool::new(true);
/// 当前被静音的进程 pid（0 = 没静音）。取消静音时要按它来，不能重新解析
static MUTED_PID: AtomicU32 = AtomicU32::new(0);
static CLASS_READY: AtomicBool = AtomicBool::new(false);

fn overlay_hwnd() -> HWND {
    HWND(OVERLAY.load(Ordering::Relaxed) as *mut c_void)
}

fn wsa_hwnd() -> HWND {
    HWND(WSA.load(Ordering::Relaxed) as *mut c_void)
}

// ==================== 对外 API ====================

/// 显示 overlay，贴在 `wsa` 客户区顶部。成功返回后窗口已创建并可见。
pub fn show(wsa: HWND) -> Result<(), String> {
    if OVERLAY.load(Ordering::Relaxed) != 0 {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let raw = wsa.0 as isize; // HWND 本身不是 Send，跨线程只带裸值
    std::thread::Builder::new()
        .name("bili-rec-bar".into())
        .spawn(move || run(raw, tx))
        .map_err(|e| format!("OVERLAY_FAILED::创建 overlay 线程失败: {e}"))?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(r) => r,
        Err(_) => Err("OVERLAY_FAILED::overlay 窗口创建超时".into()),
    }
}

/// 销毁 overlay，并等它的线程退出（避免下次 show 撞上旧窗口）
pub fn hide() {
    let hwnd = overlay_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    for _ in 0..40 {
        if OVERLAY.load(Ordering::Relaxed) == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 切换状态文案：「监听礼物中···」/「礼物录屏中···」
pub fn set_recording(rec: bool) {
    if RECORDING.swap(rec, Ordering::Relaxed) == rec {
        return;
    }
    let hwnd = overlay_hwnd();
    if !hwnd.0.is_null() {
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
        }
    }
}

// ==================== 线程主体 ====================

fn run(wsa_raw: isize, tx: mpsc::Sender<Result<(), String>>) {
    // 静音按钮要调 WASAPI（端点音量），消息循环线程先备好 COM 套间
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    match unsafe { create(HWND(wsa_raw as *mut c_void)) } {
        Ok(hwnd) => {
            WSA.store(wsa_raw, Ordering::SeqCst);
            OVERLAY.store(hwnd.0 as isize, Ordering::SeqCst);
            BG.store(C_BG_FALLBACK.0, Ordering::SeqCst);
            // 每次新会话都回到默认：静音、无悬停、没有已生效的 pid
            MUTED.store(true, Ordering::SeqCst);
            MUTED_PID.store(0, Ordering::SeqCst);
            HOVER_BTN.store(-1, Ordering::SeqCst);
            let _ = tx.send(Ok(()));
            unsafe { message_loop() };
            OVERLAY.store(0, Ordering::SeqCst);
            WSA.store(0, Ordering::SeqCst);
            unsafe { CoUninitialize() };
            eprintln!("[overlay] 已销毁");
        }
        Err(e) => {
            let _ = tx.send(Err(e));
        }
    }
}

unsafe fn create(wsa: HWND) -> Result<HWND, String> {
    let hinst = GetModuleHandleW(None).map_err(|e| format!("OVERLAY_FAILED::GetModuleHandle 失败: {e}"))?;

    if !CLASS_READY.swap(true, Ordering::SeqCst) {
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            hInstance: HINSTANCE(hinst.0),
            lpszClassName: w!("BiliLiveRecBar"),
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err("OVERLAY_FAILED::RegisterClassW 失败".into());
        }
    }

    let (cw, _) = recorder::client_size(wsa);
    if cw <= 0 {
        return Err("OVERLAY_FAILED::WSA 窗口客户区尺寸异常".into());
    }
    let mut pt = POINT::default();
    if ClientToScreen(wsa, &mut pt).0 == 0 {
        return Err("OVERLAY_FAILED::ClientToScreen 失败".into());
    }

    let hwnd = CreateWindowExW(
        WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        w!("BiliLiveRecBar"),
        w!("B瓜录屏"),
        WS_POPUP,
        pt.x,
        pt.y,
        cw,
        BAR_H,
        // 认 WSA 窗口作 **owner**：被拥有的窗口恒在其 owner 之上，且不占任务栏。
        // 必须在创建时就传，不能事后 `SetWindowLongPtrW` 补 —— 事后补的话
        // owner 关系生效了但 z-order 不会刷新，表现就是「WSA 窗口没被激活时
        // overlay 不显示，点一下窗口把它激活了才冒出来」。
        Some(wsa),
        None,
        Some(HINSTANCE(hinst.0)),
        None,
    )
    .map_err(|e| format!("OVERLAY_FAILED::CreateWindowExW 失败: {e}"))?;

    FONT.store(make_font().0 as isize, Ordering::SeqCst);
    ICON.store(load_icon().map(|i| i.0 as isize).unwrap_or(0), Ordering::SeqCst);
    // 静音按钮要紧跟在标题文字后面，先把标题宽度量出来（按钮位置全靠它）
    TITLE_W.store(measure_title_width(), Ordering::SeqCst);
    // 右块的宽度同样按实际文字量（状态文字 + 「隐藏」标签），不留死宽
    let (hide_w, right_w) = measure_right_block();
    HIDE_W.store(hide_w, Ordering::SeqCst);
    RIGHT_W.store(right_w, Ordering::SeqCst);
    apply_region(hwnd, cw);
    WIDTH.store(cw as isize, Ordering::SeqCst);

    // `Some(wsa)` 作 insertAfter：把 overlay 紧贴在 WSA 窗口上面一层。
    // 不用 `HWND_TOPMOST` —— 那样它会盖到别的窗口上；不用 `SWP_NOZORDER` —— 那样
    // z-order 交给系统猜，owner 未激活时就可能被压住不显示。
    SetWindowPos(
        hwnd,
        Some(wsa),
        pt.x,
        pt.y,
        cw,
        BAR_H,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    )
    .map_err(|e| format!("OVERLAY_FAILED::SetWindowPos 失败: {e}"))?;

    SetTimer(Some(hwnd), TIMER_SYNC, SYNC_MS, None);
    SetTimer(Some(hwnd), TIMER_BG, BG_MS, None);

    // 跟窗口移动：只在 WSA 进程的 OBJID_WINDOW 位置变化时回调
    let mut pid = 0u32;
    GetWindowThreadProcessId(wsa, Some(&mut pid));
    let hook = SetWinEventHook(
        EVENT_OBJECT_LOCATIONCHANGE,
        EVENT_OBJECT_LOCATIONCHANGE,
        None,
        Some(win_event),
        pid,
        0,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    );
    HOOK.store(hook.0 as isize, Ordering::SeqCst);
    Ok(hwnd)
}

unsafe fn message_loop() {
    let mut msg = MSG::default();
    loop {
        // 0 = WM_QUIT，-1 = 错误，两种都退出
        if GetMessageW(&mut msg, None, 0, 0).0 <= 0 {
            break;
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

// ==================== 位置同步 / 底色跟随 ====================

/// 把 overlay 贴回 WSA 客户区原点；客户区宽度变了要重做挖洞（右块位置跟着宽度走）
unsafe fn sync() {
    let (wsa, ov) = (wsa_hwnd(), overlay_hwnd());
    if wsa.0.is_null() || ov.0.is_null() {
        return;
    }
    let (cw, _) = recorder::client_size(wsa);
    if cw <= 0 {
        return;
    }
    let mut pt = POINT::default();
    if ClientToScreen(wsa, &mut pt).0 == 0 {
        return;
    }
    if WIDTH.swap(cw as isize, Ordering::Relaxed) != cw as isize {
        apply_region(ov, cw);
        let _ = InvalidateRect(Some(ov), None, false);
    }
    // `Some(wsa)` 作 insertAfter：持续把 overlay 钉在 WSA 窗口上面一层。
    // 不传 z-order 的话，owner 关系虽然还在，但其它窗口有动作时系统可能把它压到下面
    let _ = SetWindowPos(
        ov,
        Some(wsa),
        pt.x,
        pt.y,
        cw,
        BAR_H,
        SWP_NOACTIVATE,
    );
}

/// 从「洞」正中采样 WSA 原始标题栏底色（未激活=灰 / 激活=暖黄），自动跟随，不猜色值。
/// 采样点每拍按窗口当前位置重算 —— 窗口被拖动后不能还采旧坐标。
unsafe fn sample_bg() {
    let (wsa, ov) = (wsa_hwnd(), overlay_hwnd());
    if wsa.0.is_null() || ov.0.is_null() {
        return;
    }
    let (cw, _) = recorder::client_size(wsa);
    if cw <= 0 {
        return;
    }
    let mut pt = POINT::default();
    if ClientToScreen(wsa, &mut pt).0 == 0 {
        return;
    }
    let dc = GetDC(None);
    if dc.0.is_null() {
        return;
    }
    let c = GetPixel(
        dc,
        pt.x + (left_block_w() + (cw - right_block_w())) / 2,
        pt.y + SAMPLE_OFF_Y,
    );
    let _ = ReleaseDC(None, dc);

    // 0xFFFFFFFF = CLR_INVALID（点不可见 / 越界）
    if c.0 == u32::MAX || c.0 == BG.load(Ordering::Relaxed) {
        return;
    }
    BG.store(c.0, Ordering::Relaxed);
    let _ = InvalidateRect(Some(ov), None, false);
}

unsafe extern "system" fn win_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // 只要窗口自身的移动，子对象的位置变化一律忽略
    if id_object == OBJID_WINDOW && hwnd == wsa_hwnd() {
        sync();
    }
}

// ==================== 窗口过程 ====================

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        // 全部自己画，不让系统擦背景（否则拖动时闪）
        WM_ERASEBKGND => LRESULT(1),
        WM_TIMER => {
            match wparam.0 {
                TIMER_SYNC => {
                    sync();
                    // 默认静音：音频会话可能比 overlay 晚出现，每拍补一次静音
                    enforce_mute();
                }
                TIMER_BG => sample_bg(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            on_move(hwnd, lparam);
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            if HOVER_BTN.swap(-1, Ordering::Relaxed) != -1 {
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            on_click(hwnd, lparam);
            LRESULT(0)
        }
        WM_DESTROY => {
            let _ = KillTimer(Some(hwnd), TIMER_SYNC);
            let _ = KillTimer(Some(hwnd), TIMER_BG);
            let hook = HOOK.swap(0, Ordering::SeqCst);
            if hook != 0 {
                let _ = UnhookWinEvent(HWINEVENTHOOK(hook as *mut c_void));
            }
            let font = FONT.swap(0, Ordering::SeqCst);
            if font != 0 {
                let _ = DeleteObject(HGDIOBJ(font as *mut c_void));
            }
            let icon = ICON.swap(0, Ordering::SeqCst);
            if icon != 0 {
                let _ = DestroyIcon(HICON(icon as *mut c_void));
            }
            // 别把 B 站 APP 留在静音状态
            if MUTED.swap(false, Ordering::SeqCst) {
                let pid = MUTED_PID.swap(0, Ordering::SeqCst);
                if pid != 0 {
                    let _ = crate::recorder::audio::set_process_mute(pid, false);
                }
            }
            WIDTH.store(0, Ordering::SeqCst);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 最右侧「隐藏」按钮与「紧跟标题」的静音按钮的左边界
fn button_x(cw: i32) -> (i32, i32) {
    (cw - BTN_PAD - hide_button_w(), mute_button_x())
}

/// 静音按钮的左边界：紧跟在标题文字后面
fn mute_button_x() -> i32 {
    TITLE_X + TITLE_W.load(Ordering::Relaxed) + TITLE_GAP
}

/// 左块宽度：图标 + 标题 + 紧跟在标题之后的静音按钮（标题一宽就跟着宽）。
/// 挖洞与底色采样都用它 —— 采样点必须落在「洞」里，用定值 BAR_L 会在标题偏宽时
/// 把采样点落到左块自身上，采到的就成了我们自己画的底色。
fn left_block_w() -> i32 {
    (mute_button_x() + BTN_W + BTN_PAD).max(BAR_L)
}

/// 右块宽度（量不出来时退回 [`BAR_RW_FALLBACK`]）
fn right_block_w() -> i32 {
    match RIGHT_W.load(Ordering::Relaxed) {
        0 => BAR_RW_FALLBACK,
        v => v,
    }
}

/// 「隐藏」按钮宽度（量不出来时退回图标按钮的宽度）
fn hide_button_w() -> i32 {
    match HIDE_W.load(Ordering::Relaxed) {
        0 => BTN_W,
        v => v,
    }
}

/// 命中哪个按钮（-1 无 / 0 「隐藏」（置底）/ 1 静音）。只看 X，与原型一致
fn hit_button(cw: i32, x: i32) -> i32 {
    let (down, mute) = button_x(cw);
    if x >= mute && x < mute + BTN_W {
        1
    } else if x >= down && x < down + hide_button_w() {
        0
    } else {
        -1
    }
}

unsafe fn on_move(hwnd: HWND, lparam: LPARAM) {
    // 登记一次「离开」通知，否则收不到 WM_MOUSELEAVE
    let mut tme = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let _ = TrackMouseEvent(&mut tme);

    let (cw, _) = recorder::client_size(hwnd);
    let hit = hit_button(cw, (lparam.0 & 0xFFFF) as i32);
    if hit != HOVER_BTN.load(Ordering::Relaxed) {
        HOVER_BTN.store(hit, Ordering::Relaxed);
        // 静音按钮在左块、置底按钮在右块，两边都要重画，索性整条失效
        let _ = InvalidateRect(Some(hwnd), None, false);
    }
}

unsafe fn on_click(hwnd: HWND, lparam: LPARAM) {
    let (cw, _) = recorder::client_size(hwnd);
    match hit_button(cw, (lparam.0 & 0xFFFF) as i32) {
        1 => toggle_mute(hwnd),
        0 => {
            // 置底：等价"最小化"，但录制不受影响（WGC 抓的是窗口内容，不看 z-order）
            let wsa = wsa_hwnd();
            if !wsa.0.is_null() {
                let _ = SetWindowPos(
                    wsa,
                    Some(HWND_BOTTOM),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
                );
            }
        }
        _ => {}
    }
}

/// B 站 APP 窗口所属进程（不一定就是出声进程，只是解析的起点）
fn window_pid() -> u32 {
    let mut pid = 0u32;
    let h = wsa_hwnd();
    if !h.0.is_null() {
        unsafe {
            let _ = GetWindowThreadProcessId(h, Some(&mut pid));
        }
    }
    pid
}

/// 静音开关：只静音 B 站 APP 的音频会话（`ISimpleAudioVolume`），不动端点音量。
/// 这里只翻转「期望状态」，真正落到音频会话上交 [`enforce_mute`]（它会重试到成功为止）。
unsafe fn toggle_mute(hwnd: HWND) {
    let want = !MUTED.load(Ordering::Relaxed);
    MUTED.store(want, Ordering::Relaxed);
    if !want {
        // 取消静音必须用「当初静音的那个 pid」：静音之后该进程峰值归零，
        // 再解析一次很可能解析到别的进程，就解不掉了。
        let pid = MUTED_PID.swap(0, Ordering::Relaxed);
        if pid != 0 {
            let _ = crate::recorder::audio::set_process_mute(pid, false);
        }
    }
    let _ = InvalidateRect(Some(hwnd), None, false);
    enforce_mute();
}

/// 把「期望的静音状态」落实到音频会话上。
///
/// 默认就是静音：overlay 刚建好时 B 站 APP 可能还没出声、音频会话还没建起来，
/// 所以定时器每一拍都试一次，成功后就记住 pid（`MUTED_PID`）不再重复调用。
unsafe fn enforce_mute() {
    let want = MUTED.load(Ordering::Relaxed);
    let muted_pid = MUTED_PID.load(Ordering::Relaxed);
    let (target, next) = if want {
        if muted_pid != 0 {
            return; // 已经在静音
        }
        let wp = window_pid();
        if wp == 0 {
            return;
        }
        (crate::recorder::audio::resolve_target_pid(wp), true)
    } else {
        if muted_pid == 0 {
            return; // 本来就没静音
        }
        (muted_pid, false)
    };
    if target == 0 {
        return;
    }
    match crate::recorder::audio::set_process_mute(target, next) {
        Ok(()) => {
            MUTED_PID.store(if next { target } else { 0 }, Ordering::Relaxed);
            let hwnd = overlay_hwnd();
            if !hwnd.0.is_null() {
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
        }
        // 会话还没出现属常见情况（APP 还没开始播音），等下一拍再试，不刷日志
        Err(e) => {
            if !e.contains("没找到") {
                eprintln!("[overlay] 静音切换失败: {e}");
            }
        }
    }
}

// ==================== 绘制 ====================

unsafe fn paint(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut rc = RECT::default();
    let _ = GetClientRect(hwnd, &mut rc);
    let (w, h) = (rc.right, rc.bottom);
    let bg = COLORREF(BG.load(Ordering::Relaxed));

    let brush = CreateSolidBrush(bg);
    FillRect(hdc, &rc, brush);
    let _ = DeleteObject(HGDIOBJ(brush.0));

    let _ = SetBkMode(hdc, TRANSPARENT);
    let font = HFONT(FONT.load(Ordering::Relaxed) as *mut c_void);
    let old_font = SelectObject(hdc, HGDIOBJ(font.0));

    // ---- 左：图标 + B瓜录屏 + 静音按钮（紧跟标题）----
    let icon = HICON(ICON.load(Ordering::Relaxed) as *mut c_void);
    if !icon.0.is_null() {
        let _ = DrawIconEx(hdc, 14, (h - ICON_PX) / 2, icon, ICON_PX, ICON_PX, 0, None, DI_NORMAL);
    }
    draw_text(hdc, TITLE, TITLE_X, h, C_INK_TITLE);

    // ---- 右：隐藏按钮（最右） ← 状态灯 + 状态文字 ----
    let (btn_x, mute_x) = button_x(w);
    let hide_w = hide_button_w();
    let hovered = HOVER_BTN.load(Ordering::Relaxed);
    for (id, x, bw) in [(0, btn_x, hide_w), (1, mute_x, BTN_W)] {
        if hovered == id {
            let hover = CreateSolidBrush(shade(bg, -38));
            let rc_btn = RECT {
                left: x,
                top: 4,
                right: x + bw,
                bottom: h - 4,
            };
            FillRect(hdc, &rc_btn, hover);
            let _ = DeleteObject(HGDIOBJ(hover.0));
        }
    }

    let (txt, ink, dot) = if RECORDING.load(Ordering::Relaxed) {
        (STATUS_RECORD, C_RED, C_RED)
    } else {
        (STATUS_LISTEN, C_INK_STATUS, C_GREEN)
    };
    let txt_w = text_width(hdc, txt);
    let stat_right = btn_x - BTN_GAP;
    let mut stat_x = stat_right - txt_w;
    let mut dot_x = stat_x - DOT_D - DOT_GAP;
    if dot_x < w - right_block_w() + SIDE_PAD {
        // 别越出右块的裁剪边界
        dot_x = w - right_block_w() + SIDE_PAD;
        stat_x = dot_x + DOT_D + DOT_GAP;
    }
    draw_text(hdc, txt, stat_x, h, ink);
    let dot_brush = CreateSolidBrush(dot);
    let old_brush = SelectObject(hdc, HGDIOBJ(dot_brush.0));
    let dot_y = (h - DOT_D) / 2;
    let _ = Ellipse(hdc, dot_x, dot_y, dot_x + DOT_D, dot_y + DOT_D);
    SelectObject(hdc, old_brush);
    let _ = DeleteObject(HGDIOBJ(dot_brush.0));

    // ---- 隐藏按钮：直接写「隐藏」两个字（原来的向下箭头看不出是干什么的）----
    draw_text_centered(hdc, HIDE_LABEL, btn_x, hide_w, h, C_ARROW);

    // ---- 静音按钮：喇叭 + 声波（静音时换成红色斜杠）----
    draw_mute_icon(hdc, mute_x, h);

    // ---- 底部分隔线：跟着底色深浅自动微调 ----
    let line = CreateSolidBrush(shade(bg, -16));
    let rc_line = RECT {
        left: 0,
        top: h - 1,
        right: w,
        bottom: h,
    };
    FillRect(hdc, &rc_line, line);
    let _ = DeleteObject(HGDIOBJ(line.0));

    SelectObject(hdc, old_font);
    let _ = EndPaint(hwnd, &ps);
}

/// 静音按钮图形：喇叭本体（填充多边形）+ 两道声波；已静音时画红色斜杠代替声波
unsafe fn draw_mute_icon(hdc: HDC, x: i32, h: i32) {
    let cx = x + BTN_W / 2;
    let cy = h / 2;
    let muted = MUTED.load(Ordering::Relaxed);

    // 喇叭：矩形箱体 + 喇叭口，用 Polygon 一次填出来
    let body = [
        POINT { x: cx - 10, y: cy - 4 },
        POINT { x: cx - 4, y: cy - 4 },
        POINT { x: cx + 2, y: cy - 10 },
        POINT { x: cx + 2, y: cy + 10 },
        POINT { x: cx - 4, y: cy + 4 },
        POINT { x: cx - 10, y: cy + 4 },
    ];
    let brush = CreateSolidBrush(C_ARROW);
    let old_brush = SelectObject(hdc, HGDIOBJ(brush.0));
    let old_pen = SelectObject(hdc, GetStockObject(NULL_PEN));
    let _ = Polygon(hdc, &body);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    let _ = DeleteObject(HGDIOBJ(brush.0));

    let lb = LOGBRUSH {
        lbStyle: BS_SOLID,
        lbColor: if muted { C_RED } else { C_ARROW },
        lbHatch: 0,
    };
    let pen = ExtCreatePen(
        PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_ROUND | PS_JOIN_ROUND,
        3,
        &lb,
        None,
    );
    let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
    if muted {
        let _ = MoveToEx(hdc, cx - 6, cy - 12, None);
        let _ = LineTo(hdc, cx + 12, cy + 12);
    } else {
        let _ = MoveToEx(hdc, cx + 6, cy - 6, None);
        let _ = LineTo(hdc, cx + 6, cy + 6);
        let _ = MoveToEx(hdc, cx + 11, cy - 11, None);
        let _ = LineTo(hdc, cx + 11, cy + 11);
    }
    SelectObject(hdc, old_pen);
    let _ = DeleteObject(HGDIOBJ(pen.0));
}

/// 画一段文本（按行盒在整条标题栏里垂直居中），`x` 为左边界
unsafe fn draw_text(hdc: HDC, text: &str, x: i32, h: i32, color: COLORREF) {
    let mut buf: Vec<u16> = text.encode_utf16().collect();
    let _ = SetTextColor(hdc, color);
    let mut rc = RECT {
        left: x,
        top: 0,
        right: x + text_width(hdc, text) + 8,
        bottom: h,
    };
    DrawTextW(
        hdc,
        &mut buf,
        &mut rc,
        DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX,
    );
}

/// 在一段矩形里居中画文本（按钮标签用）
unsafe fn draw_text_centered(hdc: HDC, text: &str, x: i32, w: i32, h: i32, color: COLORREF) {
    let mut buf: Vec<u16> = text.encode_utf16().collect();
    let _ = SetTextColor(hdc, color);
    let mut rc = RECT {
        left: x,
        top: 0,
        right: x + w,
        bottom: h,
    };
    DrawTextW(
        hdc,
        &mut buf,
        &mut rc,
        DT_SINGLELINE | DT_VCENTER | DT_CENTER | DT_NOPREFIX,
    );
}

unsafe fn text_width(hdc: HDC, text: &str) -> i32 {
    let buf: Vec<u16> = text.encode_utf16().collect();
    let mut sz = SIZE::default();
    let _ = GetTextExtentPoint32W(hdc, &buf, &mut sz);
    sz.cx
}

/// 每个通道加 `delta`（负=压暗），用于从底色推 hover 高亮 / 分隔线
fn shade(c: COLORREF, delta: i32) -> COLORREF {
    let ch = |v: u32| -> u32 {
        (v as i32 + delta).clamp(0, 255) as u32
    };
    rgb(ch(c.0 & 0xFF), ch((c.0 >> 8) & 0xFF), ch((c.0 >> 16) & 0xFF))
}

// ==================== 资源 ====================

/// 挖洞：左块 ∪ 右块 ∪ 顶部通条。三块之外（中间空白）不在窗口区域内 → 点击穿透到 WSA。
/// **起始必须是空区域**：若从整条矩形开始，并集仍是整条，洞就没了，
/// 中间那段的点击全被本窗口吃掉 —— 表现就是「WSA 标题栏拖不动」。
/// `SetWindowRgn` 成功后区域归系统所有，不能再删。
unsafe fn apply_region(hwnd: HWND, cw: i32) {
    // 左块宽度跟着标题实际宽度走：静音按钮紧跟在标题之后，标题一宽（换字体/不同 DPI）
    // 按钮就可能越过 BAR_L 而被裁掉 —— 看不见也点不到。
    let bar_l = left_block_w();
    let full = CreateRectRgn(0, 0, 0, 0);
    let left = CreateRectRgn(0, 0, bar_l, BAR_H);
    let right = CreateRectRgn(cw - right_block_w(), 0, cw, BAR_H);
    let top = CreateRectRgn(0, 0, cw, TOP_BAND);
    CombineRgn(Some(full), Some(full), Some(left), RGN_OR);
    CombineRgn(Some(full), Some(full), Some(right), RGN_OR);
    CombineRgn(Some(full), Some(full), Some(top), RGN_OR);
    for r in [left, right, top] {
        let _ = DeleteObject(HGDIOBJ(r.0));
    }
    SetWindowRgn(hwnd, Some(full), true);
}

/// 量一次标题「B瓜录屏」在当前字体下的宽度（借一个临时 DC 量，量完还回去）
unsafe fn measure_title_width() -> i32 {
    let font = HFONT(FONT.load(Ordering::Relaxed) as *mut c_void);
    if font.0.is_null() {
        return 0;
    }
    let dc = GetDC(None);
    if dc.0.is_null() {
        return 0;
    }
    let old = SelectObject(dc, HGDIOBJ(font.0));
    let w = text_width(dc, TITLE);
    SelectObject(dc, old);
    let _ = ReleaseDC(None, dc);
    w
}

/// 量「隐藏」按钮与整个右块的宽度（借一个临时 DC 量，量完还回去）。
///
/// 右块 = 隐藏按钮 + 间距 + 状态文字（两种状态取更宽的那个）+ 状态灯 + 两侧留白。
/// 按实际宽度来，右块就只盖到该盖的地方（窗口的最小化 / 关闭按钮也在这一段里）。
unsafe fn measure_right_block() -> (i32, i32) {
    let font = HFONT(FONT.load(Ordering::Relaxed) as *mut c_void);
    let dc = GetDC(None);
    if dc.0.is_null() || font.0.is_null() {
        return (BTN_W, BAR_RW_FALLBACK);
    }
    let old = SelectObject(dc, HGDIOBJ(font.0));
    let stat_w = text_width(dc, STATUS_LISTEN).max(text_width(dc, STATUS_RECORD));
    let hide_w = text_width(dc, HIDE_LABEL) + 2 * HIDE_PAD;
    SelectObject(dc, old);
    let _ = ReleaseDC(None, dc);

    let right_w = SIDE_PAD + hide_w + BTN_GAP + stat_w + DOT_GAP + DOT_D + SIDE_PAD;
    (hide_w, right_w)
}

unsafe fn make_font() -> HFONT {
    let mut lf = LOGFONTW {
        lfHeight: -FS,
        lfWeight: FW_NORMAL.0 as i32,
        lfCharSet: DEFAULT_CHARSET,
        lfOutPrecision: OUT_DEFAULT_PRECIS,
        lfClipPrecision: CLIP_DEFAULT_PRECIS,
        lfQuality: CLEARTYPE_QUALITY,
        lfPitchAndFamily: FF_DONTCARE.0,
        ..Default::default()
    };
    fill_face(&mut lf.lfFaceName, "Microsoft YaHei UI");
    CreateFontIndirectW(&lf)
}

fn fill_face(buf: &mut [u16; 32], name: &str) {
    for (i, c) in name.encode_utf16().take(buf.len() - 1).enumerate() {
        buf[i] = c;
    }
}

/// 左侧小图标：从编译进来的 `icons/icon.ico` 里挑最接近 40px 的一个条目。
/// 用内嵌字节而不是运行期读文件 —— dev 下 exe 旁边没有 icons 目录。
fn load_icon() -> Option<HICON> {
    const ICO: &[u8] = include_bytes!("../icons/icon.ico");
    if ICO.len() < 6 {
        return None;
    }
    let count = u16::from_le_bytes([ICO[4], ICO[5]]) as usize;
    let mut entries: Vec<(i32, usize, usize)> = Vec::new();
    for i in 0..count {
        let off = 6 + i * 16;
        if off + 16 > ICO.len() {
            break;
        }
        let w = ICO[off] as i32; // 0 表示 256
        let px = if w == 0 { 256 } else { w };
        let size = u32::from_le_bytes([ICO[off + 8], ICO[off + 9], ICO[off + 10], ICO[off + 11]]) as usize;
        let at = u32::from_le_bytes([ICO[off + 12], ICO[off + 13], ICO[off + 14], ICO[off + 15]]) as usize;
        if size > 0 && at + size <= ICO.len() {
            entries.push((px, at, size));
        }
    }
    // 按「离目标尺寸的差距」排序，逐个试：ICO 里 256px 条目常是 PNG 压缩，GDI 解不了，跳过即可
    entries.sort_by_key(|(px, _, _)| (*px - ICON_PX).unsigned_abs());
    for (_, at, size) in &entries {
        let ic = unsafe {
            CreateIconFromResourceEx(
                &ICO[*at..*at + *size],
                true,
                0x0003_0000,
                ICON_PX,
                ICON_PX,
                IMAGE_FLAGS(0),
            )
        };
        if let Ok(ic) = ic {
            return Some(ic);
        }
    }
    None
}