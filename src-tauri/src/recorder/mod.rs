//! 「原始录屏」的画面采集与编码会话。
//!
//! 职责划分：**前端当"触发脑"，这里当"执行器"**。阈值比较、15 秒尾窗计时、
//! 礼物名累积与文件名字串都由前端决定；本模块只负责「开录 / 收尾」以及落盘命名。
//!
//! 采集链路：`CreateForWindow` → `CreateFreeThreaded` 帧池 → 回调里按 1/30s 时间槽节流
//! → 裁掉顶部 `BAR_H` 标题栏 → 交 [`encoder::Encoder`] 编 H.264 mp4。
#![cfg(windows)]

pub mod audio;
mod capture;
mod encoder;

pub use capture::{
    activate_window, client_size, create_device, find_wsa_window, harden_window,
    hide_capture_border, is_unusable, monitor_work_area, monitor_work_rect, window_dpi,
    window_frame,
};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

use encoder::Encoder;
use tauri::Manager;

// ==================== 参考几何与本次会话的定型目标 ====================
//
// 标定基准：WSA 的原始物理密度 320（2.0 px/dp）下的竖屏手机画面 —— 900×1858px = 450×929dp，
// 裁掉顶部 58px（29dp 的 Android 状态栏）后录 900×1800，即 **18:9**（现代手机的长屏比例，
// 高是宽的 2 倍）。**只有这套尺寸做过实测**。
//
// 但窗口尺寸是**物理像素**：900×1858 加上外框（标题栏+边框）约 40px，整窗约 1900px 高，
// 100% 缩放的 1080p 屏可用高度只有约 1030，窗口下沿会跑到屏幕外（实测反馈："窗口大小过大"）。
// 所以真正用的尺寸由 [`fit_geometry`] 现算：**整窗高度固定占显示器可用区的 90%**，宽度按
// 标定的 9:18 比例反算，Android 密度按同比例下调 —— dp 尺寸（版式、礼物动画）保持不变，
// 只是画面分辨率随屏幕大小伸缩。

/// 参考密度（WSA 原始物理密度，px/dp × 160）
pub const REF_DENSITY: i32 = 320;

/// 参考密度下 Android 状态栏的高度（px）—— 录制裁掉它、overlay 盖住它
pub const REF_BAR_H: i32 = 58;

/// 参考客户区宽度（px）= 450dp
pub const REF_CLIENT_W: i32 = 900;

/// 参考**录制区**高度（px）= 宽度 × 2 = 1800，即 18:9 竖屏（裁掉状态栏后录到的画面）
pub const REF_REC_H: i32 = 1800;

/// 参考客户区高度（px）= 录制区 + 顶部状态栏
pub const REF_CLIENT_H: i32 = REF_REC_H + REF_BAR_H;

/// 本次会话的 Android 密度（px/dp × 160）。由 [`set_density`] 在定型时写入，
/// 录制与 overlay 都按它换算物理像素。
static DENSITY: AtomicI32 = AtomicI32::new(REF_DENSITY);

pub fn density() -> i32 {
    DENSITY.load(Ordering::Relaxed)
}

pub fn set_density(d: i32) {
    DENSITY.store(d.max(80), Ordering::Relaxed);
}

/// 把参考密度下量出来的尺寸换算成本次会话的物理像素。
pub fn px(v: i32) -> i32 {
    let scaled = (v as f64) * density() as f64 / REF_DENSITY as f64;
    (scaled.round() as i32).max(1)
}

/// 本次会话 Android 状态栏的高度（px）：密度随窗口等比缩小，所以它不能再是常量。
pub fn bar_h() -> i32 {
    px(REF_BAR_H)
}

/// 本次会话的窗口定型目标：客户区尺寸 + 要写进 Android 的密度。
#[derive(Clone, Copy)]
pub struct Geometry {
    pub client_w: i32,
    pub client_h: i32,
    pub density: i32,
}

/// 算本次会话该把窗口定成多大：**高度固定占 `hwnd` 所在显示器可用区的 90%**，宽度按标定
/// 比例（录制区 1800:900 = 18:9）反算，Android 密度同比例换算。于是任何分辨率下都装得下、
/// 版式（dp 尺寸、礼物动画比例）与标定完全一致，只是画面分辨率随屏幕大小伸缩。
///
/// 上限 1.0：密度超过标定的 320 属于没实测过的区域，而录制码率是固定的 4Mbps，
/// 画面再放大只会更糊 —— 4K 以上的屏就当按标定尺寸录，不再放大。
pub fn fit_geometry(hwnd: HWND) -> Geometry {
    /// 窗口（含外框）占显示器可用区高度的比例
    const FILL: f64 = 0.90;
    let (frame_w, frame_h) = window_frame(hwnd);
    let (wa_w, wa_h) = monitor_work_area(hwnd);
    let scale = if wa_w <= 0 || wa_h <= 0 {
        1.0 // 量不到显示器（异常情况）→ 按标定尺寸来，别把画面缩没了
    } else {
        // 目标整窗高 = 可用高 × 90%；扣掉外框得到客户区，客户区再扣掉状态栏就是录制区
        let by_h = (wa_h as f64 * FILL - frame_h as f64) / REF_CLIENT_H as f64;
        // 极窄的竖屏显示器上，按高度算出来的宽度会超出可用宽，一并夹住
        let by_w = (wa_w as f64 - frame_w as f64) / REF_CLIENT_W as f64;
        by_h.min(by_w).min(1.0).max(0.25)
    };
    Geometry {
        client_w: ((REF_CLIENT_W as f64) * scale).round() as i32,
        client_h: ((REF_CLIENT_H as f64) * scale).round() as i32,
        density: ((REF_DENSITY as f64) * scale).round() as i32,
    }
}

/// 产物目录名。三个模块（礼物截图 / 礼物模拟录屏 / 完整录屏）的产物都落在这里。
const OUT_DIR_NAME: &str = "礼物截图录屏";

/// 编码回调里的共享状态。COM 接口本身没有标 `Send`，但它们只在 `Mutex` 保护下使用，
/// 跨线程交出去是安全的（帧池是 free-threaded 的，回调在 MF 线程池里跑）。
struct Shared {
    encoder: Encoder,
    /// 首帧的采集时间戳（100ns），用作 PTS 原点
    first_src: Option<i64>,
    /// 上一写入帧的采集时间戳（100ns）
    last_src: i64,
    /// 上次写入所占的 1/30s 时间槽序号（-1 = 还没写过）
    last_slot: i64,
    /// 回调交付的帧数
    frames_seen: u32,
    written: u32,
    skipped: u32,
    /// 首个失败原因（停止时上报给前端）
    error: Option<String>,
    /// 失败日志只打一次，避免每帧刷屏
    logged: bool,
}

unsafe impl Send for Shared {}

/// 一次录制会话
struct Session {
    pool: Direct3D11CaptureFramePool,
    capture: GraphicsCaptureSession,
    /// 必须持有：`FrameArrived` 注册的委托要给帧池留一份强引用（`_` 前缀即"只保活不读取"）
    _handler: TypedEventHandler<Direct3D11CaptureFramePool, IInspectable>,
    shared: Arc<Mutex<Shared>>,
    /// 录制中的临时文件（收尾 `Finalize` 后按礼物名重命名）
    temp: PathBuf,
}

unsafe impl Send for Session {}

/// 当前会话（进程内同一时刻只允许一路录制）
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<Session>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

/// 录制是否在进行中
pub fn is_recording() -> bool {
    session_slot().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 运行期统计快照：`(交付帧数, 写入帧数, 丢弃帧数, 首个错误)`
pub fn stats() -> Option<(u32, u32, u32, Option<String>)> {
    let guard = session_slot().lock().ok()?;
    let s = guard.as_ref()?;
    let sh = s.shared.lock().ok()?;
    Some((sh.frames_seen, sh.written, sh.skipped, sh.error.clone()))
}

/// 开始录制：抓 `hwnd` 的客户区（裁掉顶部 `BAR_H`）写到 `dir` 下的临时文件。
/// 返回临时文件路径，供 [`stop`] 收尾时重命名使用。
pub fn start(hwnd: HWND, dir: &Path) -> Result<PathBuf, String> {
    if is_recording() {
        return Err("ENCODE_FAILED::已有录制会话在进行中".into());
    }
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
        return Err("CAPTURE_INIT_FAILED::系统不支持 Windows Graphics Capture".into());
    }

    // 顶部状态栏高度按**本次会话的密度**算：窗口为装进小屏显示器会整体缩小，
    // 密度同步下调，这个值不再是常量（见 `fit_geometry`）。
    let bh = bar_h();
    let (cw, ch) = client_size(hwnd);
    if cw <= 0 || ch <= bh {
        return Err(format!(
            "CAPTURE_INIT_FAILED::窗口客户区尺寸异常（{cw}x{ch}），请确认 B 站 APP 窗口正常显示"
        ));
    }
    let (ow, oh) = (cw as u32, (ch - bh) as u32);

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("NO_WRITE_PERMISSION::创建录制目录失败: {e}"))?;
    let temp = dir.join(temp_name());

    let (device, ctx) = create_device()?;
    let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("CAPTURE_INIT_FAILED::cast IDXGIDevice 失败: {e}"))?;
    let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .map_err(|e| format!("CAPTURE_INIT_FAILED::CreateDirect3D11DeviceFromDXGIDevice 失败: {e}"))?
        .cast()
        .map_err(|e| format!("CAPTURE_INIT_FAILED::cast IDirect3DDevice 失败: {e}"))?;

    let encoder = Encoder::new(&temp, &device, ow, oh, bh as u32)?;

    let interop: IGraphicsCaptureItemInterop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|e| format!("CAPTURE_INIT_FAILED::取 IGraphicsCaptureItemInterop 失败: {e}"))?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }
        .map_err(|e| format!("WINDOW_NOT_FOUND::CreateForWindow 失败（窗口可能已关闭）: {e}"))?;
    let sz = item
        .Size()
        .map_err(|e| format!("CAPTURE_INIT_FAILED::取采集尺寸失败: {e}"))?;

    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        // 3 个缓冲：CPU 读回 + 拷贝约 10ms，只给 2 个缓冲时源约 35fps 会饿死丢帧
        3,
        SizeInt32 {
            Width: sz.Width,
            Height: sz.Height,
        },
    )
    .map_err(|e| format!("CAPTURE_INIT_FAILED::CreateFreeThreaded 失败: {e}"))?;

    let shared = Arc::new(Mutex::new(Shared {
        encoder,
        first_src: None,
        last_src: 0,
        last_slot: -1,
        frames_seen: 0,
        written: 0,
        skipped: 0,
        error: None,
        logged: false,
    }));

    let sh = shared.clone();
    let (dev2, ctx2) = (device.clone(), ctx.clone());
    let handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |sender, _args| {
        let sender = sender.ok()?;
        let frame: Direct3D11CaptureFrame = sender.TryGetNextFrame()?;
        // 用采集帧自带的时间戳做节流和 PTS 原点：若按「距上次写入的耗时」算，
        // 编码耗时会被算进帧间隔，30fps 会被压到 ~19fps。
        let src = frame.SystemRelativeTime()?.Duration;
        // 归到 1/30s 时间槽：同一槽内只取最先到的那一帧。直接按「距上帧 ≥33ms」判断
        // 会在源约 35fps 时退化成每两帧取一帧（~17fps）。
        let slot = src / encoder::FRAME_DUR;

        let mut s = sh.lock().unwrap();
        s.frames_seen += 1;
        if slot == s.last_slot {
            s.skipped += 1;
            return Ok(());
        }
        s.last_slot = slot;
        s.last_src = src;
        let base = *s.first_src.get_or_insert(src);
        let pts = src - base;

        // 取纹理放在节流之后：被丢弃的帧不必做 Surface/cast
        let surface = frame.Surface()?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface() }?;

        match s.encoder.write_frame(&ctx2, &dev2, &tex, pts) {
            Ok(()) => s.written += 1,
            Err(e) => {
                s.skipped += 1;
                if !s.logged {
                    s.logged = true;
                    eprintln!("[recorder] 编码失败: {e}");
                }
                if s.error.is_none() {
                    s.error = Some(e);
                }
            }
        }
        Ok(())
    });

    let capture = pool
        .CreateCaptureSession(&item)
        .map_err(|e| format!("CAPTURE_INIT_FAILED::CreateCaptureSession 失败: {e}"))?;
    // 别让系统给被采集窗口画那条黄色高亮边框（录制期间窗口四周会整圈发黄）
    hide_capture_border(&capture);
    pool.FrameArrived(&handler)
        .map_err(|e| format!("CAPTURE_INIT_FAILED::FrameArrived 注册失败: {e}"))?;
    capture
        .StartCapture()
        .map_err(|e| format!("CAPTURE_INIT_FAILED::StartCapture 失败: {e}"))?;

    eprintln!(
        "[recorder] 开始录制 {}x{}（裁掉顶部 {bh}px，密度 {}）-> {}",
        ow,
        oh,
        density(),
        temp.display()
    );

    let ret = temp.clone();
    *session_slot().lock().unwrap() = Some(Session {
        pool,
        capture,
        _handler: handler,
        shared,
        temp,
    });
    Ok(ret)
}

/// 停止录制并收尾。`stem` 为最终文件名（不含扩展名，含日期与礼物名，由前端生成）；
/// 传 `None` 则沿用临时文件名。返回最终产物路径；没有在录时返回 `None`。
pub fn stop(dir: &Path, stem: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(sess) = session_slot().lock().unwrap().take() else {
        return Ok(None);
    };

    // 1) 先停采集，回调不再进来，才能安全 Finalize
    let _ = sess.capture.Close();
    let _ = sess.pool.Close();

    let (written, frames_seen, error) = {
        let mut sh = sess.shared.lock().unwrap();
        let error = sh
            .encoder
            .finish()
            .err()
            .or_else(|| sh.error.clone());
        (sh.written, sh.frames_seen, error)
    };
    eprintln!(
        "[recorder] 采集停止：交付 {frames_seen} 帧，写入 {written} 帧 -> {}",
        sess.temp.display()
    );

    if written == 0 {
        // 一帧都没写成，产物是空壳：删掉临时文件并如实上报
        let _ = std::fs::remove_file(&sess.temp);
        return Err(error.unwrap_or_else(|| {
            "ENCODE_FAILED::本次录制没有写入任何帧（窗口可能全程静止或被最小化）".into()
        }));
    }

    // 2) 按礼物名收尾命名（重名追加 -2 / -3 …）
    let final_path = match stem {
        Some(s) if !s.trim().is_empty() => {
            let target = unique_path(dir, &sanitize_stem(s), "mp4");
            match std::fs::rename(&sess.temp, &target) {
                Ok(()) => target,
                Err(e) => {
                    eprintln!("[recorder] 重命名失败（保留临时文件名）: {e}");
                    sess.temp.clone()
                }
            }
        }
        _ => sess.temp.clone(),
    };
    eprintln!("[recorder] 收尾完成 -> {}", final_path.display());
    Ok(Some(final_path))
}

/// 产物目录：优先 exe 同级 `礼物截图录屏`（绿色单文件的使用习惯），不可写则回退应用数据目录。
pub fn resolve_output_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dir = parent.join(OUT_DIR_NAME);
            if std::fs::create_dir_all(&dir).is_ok() && probe_writable(&dir) {
                return dir;
            }
        }
    }
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join(OUT_DIR_NAME);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join("_w.tmp");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 录制中的临时文件名（带 pid + 时间戳，避免并发/上次残留冲突）。
/// 以 `_` 开头，和最终产物 `YYYYMMDD-…` 明显区分。
fn temp_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("_rec-{}-{nanos}.mp4", std::process::id())
}

/// 非法文件名字符统一替成 `_`，并限制长度（Windows 全路径上限 260）
pub(crate) fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let mut out: String = cleaned.chars().take(80).collect();
    if out.is_empty() {
        out = "未命名礼物".to_string();
    }
    out
}

/// 重名则追加 `-2` / `-3` …
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{stem}-{n}.{ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!(
        "{stem}-{}.{ext}",
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    ))
}

/// 产物目录里的落盘路径：拆出扩展名 → 主体做非法字符替换 → 重名追加 `-2`/`-3`。
/// `file_name` 可带扩展名（如 `20260930-粉丝名-小心心.png`），缺省按 `.bin` 处理。
pub fn output_path(dir: &Path, file_name: &str) -> PathBuf {
    let p = Path::new(file_name);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("未命名");
    unique_path(dir, &sanitize_stem(stem), ext)
}

/// 产物目录的绝对路径字符串（供前端显示/打开）。
pub fn output_dir_string(app: &tauri::AppHandle) -> String {
    resolve_output_dir(app).to_string_lossy().to_string()
}