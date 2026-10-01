//! WSA（Windows Subsystem for Android）与 adb 控制。
//!
//! 「原始录屏」要录的是 WSA 里 B 站 APP 的窗口，本模块负责把这套前置条件准备到位：
//! 找到 adb（必要时按需下载 platform-tools）→ 连上 WSA → 屏幕常亮 → 两阶段进房
//! → 找到并定型窗口；停止监听时关 APP、关 WSA。
//!
//! 所有子进程都带 `CREATE_NO_WINDOW`，避免弹黑框。
#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
    ToggleState_Off, TreeScope_Children, TreeScope_Descendants, UIA_InvokePatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    mouse_event, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextW, IsWindowVisible, PostMessageW,
    SetCursorPos, SetForegroundWindow, WM_CLOSE,
};

use crate::recorder;

/// B 站 APP 包名
pub const PACKAGE: &str = "tv.danmaku.bili";
/// 冷启动落点（两阶段进房第一段：先进主界面，避免直接 DeepLink 进直播间白屏）
const MAIN_ACTIVITY: &str = "tv.danmaku.bili/tv.danmaku.bili.MainActivityV2";
/// WSA **本体**的开始菜单 AppID（WsaClient，即「适用于 Android 的 Windows 子系统」）。
/// 唤醒 WSA 必须用它：早先靠拉起 B 站 APP（`shell:appsFolder\tv.danmaku.bili`）连带唤醒，
/// 那只在 APP **已装**时才成立 —— 而「APP 被手动卸载 → 需要重装」恰恰是 APP 不在的情形，
/// 于是唤醒永远无效，白等满 120 秒才报「等待 WSA 启动超时」，APP 也就再也装不上。
const WSA_SHELL_ID: &str = "MicrosoftCorporationII.WindowsSubsystemForAndroid_8wekyb3d8bbwe!App";
/// WSA 的**设置界面**（WsaSettings.exe）。与上面的区别很关键：清单里 `!App` 那条写着
/// `AppListEntry="none"` —— 它只把子系统虚拟机启起来，**不显示任何窗口**；能看见、能开关
/// 「开发人员模式」的是 `!SettingsApp`。而 adb 端口 58526 只有开了那个开关才监听，
/// 于是「连不上 WSA」时就把这个窗口摆到用户面前，省得他去开始菜单里翻快捷方式。
const WSA_SETTINGS_ID: &str = "MicrosoftCorporationII.WindowsSubsystemForAndroid_8wekyb3d8bbwe!SettingsApp";
/// adb over WSA 的端口（优先 58526；WSABuilds 的旧版本用过 58600）
const ADB_PORTS: [u16; 2] = [58526, 58600];
/// platform-tools 官方分发包（本机找不到 adb 时按需下载）。
/// 走 googledownloads.cn 镜像：国内直连 dl.google.com 常被墙，镜像可用性更好。
pub const PLATFORM_TOOLS_URL: &str =
    "https://googledownloads.cn/android/repository/platform-tools-latest-windows.zip";
/// 两阶段进房的**预算上限**（不再是固定等待时长：有信号就提前返回）。
/// 14 秒是原型 launch_room.ps1 的实测值，现在只作为"信号一直拿不到"时的兜底。
const WAIT_MAIN: Duration = Duration::from_secs(14);
const WAIT_ROOM: Duration = Duration::from_secs(14);
/// `am start -W` 只等到 Activity 启动，WebView 还要再渲染一会儿 —— 补一点静置时间
const SETTLE_MAIN: Duration = Duration::from_secs(2);
const SETTLE_ROOM: Duration = Duration::from_millis(2500);
/// 等待信号的轮询间隔
const POLL_MS: u64 = 250;
/// WSA 冷启动到能连上 adb 的预算。
///
/// **别按"热启动"的几秒去估**：全新安装后的**第一次**启动要先初始化 data 分区，
/// 实测这一趟花了 130 秒（端口早就监听了，卡在 `sys.boot_completed` 迟迟不为 1）。
/// 原来给 120 秒，余量只剩几秒 —— 稍微慢一点的机器就会误报「连不上 WSA」。
const WSA_BOOT_BUDGET: Duration = Duration::from_secs(180);
/// 冷启动期间探测 adb 的间隔（越小越快接上，代价是每秒开一次 adb 子进程）
const WSA_POLL: Duration = Duration::from_secs(1);
/// **WSA 首次启动**时留给用户「点掉权限申请框」的时间窗。实测：相机 / 麦克风 / 位置那类
/// 授权框是在 **WSA 自己启动**时弹的（不是启动 B 站 APP 时），模态、会压住设置窗口和
/// 后面的自动化。我们不代用户点掉（认窗口只能靠类名，会误伤别的系统对话框），改为把时间留出来。
/// 这段等待与 WSA 冷启动**重叠**：冷启动本来就要几十秒才连得上 adb，这里边等边轮询，
/// 连上就立刻结束 —— 只有真的在冷启动时才等得满，WSA 只是睡着了的时候几乎不花时间。
const WSA_FIRST_RUN_GRACE: Duration = Duration::from_secs(12);
/// 等**设备侧 adb 授权**（Android 弹出的「是否允许 ADB 调试？」）的单轮窗口。
/// 实测（Win10）：这个弹窗要等 Android 的**系统 UI 就绪**才渲染得出来，约 1~2 分钟；
/// 而 adb 端口早在第 7 秒就监听了。窗口内持续尝试自动应答 + 复查。
const ADB_AUTH_WINDOW: Duration = Duration::from_secs(30);
/// 授权窗口的轮数上限。每轮都以一次**全新握手**开始（见 [`wait_for_adb_auth`]）。
const ADB_AUTH_ROUNDS: u8 = 3;
/// 授权窗口内的轮询间隔
const ADB_AUTH_POLL: Duration = Duration::from_millis(1000);
/// **单次 `ensure_wsa` 的授权等待总预算**，按场景给：安装/修复（会摆设置窗口、可能整台冷启动）
/// 给足；点「开始录制」只给一点点 —— 那一刻用户正等着窗口弹出来，不该为授权干等。
///
/// 为什么必须封顶：`ensure_wsa` 里两个轮询循环**每轮**都会调一次 `connect_waiting_auth`，
/// 而它命中 `unauthorized` 时会走满 `ADB_AUTH_ROUNDS × ADB_AUTH_WINDOW`（90s）。不封顶时
/// 单次 `ensure_wsa` 能拖到 5 分钟以上 —— 实测反馈「点录制后一直卡住没响应」就是这个。
/// 预算花完后授权等待降级成「一次应答 + 复查」（几乎不花时间），轮询恢复每秒一次的节奏；
/// 若那时设备仍卡在 `unauthorized`，直接报错（见 `ensure_wsa` 里的提前失败分支）。
const ADB_AUTH_BUDGET_SETUP: Duration = Duration::from_secs(120);
const ADB_AUTH_BUDGET_RECORD: Duration = Duration::from_secs(12);
/// 等窗口出现的预算（进房后 Android 顶层窗口可能还要几秒才可见）
const WINDOW_BUDGET: Duration = Duration::from_secs(30);
/// 等窗口出现的轮询间隔
const WINDOW_POLL: Duration = Duration::from_millis(200);

/// 诊断日志文件：`%APPDATA%\com.bili-live.app\setup\wsa-setup.log`
/// （与 platform-tools、APK 同目录，用户和我们都能一眼找到）。
///
/// **为什么必须落盘**：release 构建没有控制台，`eprintln!` 谁都看不见，而这一步的失败原因
/// 只能靠现场证据（实测：Win10 上"授权弹窗何时弹出 / boot_completed 是不是 1 / 端口何时监听"
/// 全靠猜，来回猜了好几轮）。所以关键节点一律写文件。
fn log_file() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(base)
            .join("com.bili-live.app")
            .join("setup")
            .join("wsa-setup.log"),
    )
}

/// 记一条诊断日志：**追加写文件**（release 可见）+ 同时打 stderr（dev 可见）。
/// 不带时间戳：每次面向用户的安装流程开始时会清空日志（见 [`wlog_reset`]），
/// 所以文件里就是本次尝试的完整有序过程（std 拿不到本地时间，不值得为此加依赖）。
pub(crate) fn wlog(msg: &str) {
    eprintln!("{msg}");
    let Some(path) = log_file() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = std::io::Write::write_all(&mut f, format!("{msg}\n").as_bytes());
    }
}

/// 清空日志，只保留本次尝试。**只在面向用户的流程入口调用**（`setup::install`）。
///
/// 首行必写「原生包日期戳 + exe 路径」：release 下我们看不到任何控制台输出，而
/// "日志没生成" 最常见的两个原因就是「跑的不是这份二进制」和「文件在别的目录」——
/// 把这两件事写进第一行，一眼就能排除。
pub(crate) fn wlog_reset() {
    let path = log_file();
    if let Some(p) = &path {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, "");
    }
    wlog(&format!(
        "===== 安装 / 修复流程开始（原生包 {}）=====",
        env!("BILI_BUILD_DATE")
    ));
    if let Ok(exe) = std::env::current_exe() {
        wlog(&format!("[env] exe={}", exe.display()));
    }
    match &path {
        Some(p) => wlog(&format!("[env] 日志文件={}", p.display())),
        None => wlog("[env] 取不到 APPDATA，日志只打 stderr"),
    }
}

/// 记一条「屏幕 / 窗口几何」诊断。
///
/// 为什么值得单独记：窗口尺寸是**物理像素**、按所在显示器现算的（整窗高 = 可用区高 × 90%），
/// 而画面排版又取决于 Android 侧的 `wm density` —— 密度没写进去或写错了，录制就会
/// 「留一条黑边」或「切掉一截内容」。到底对不对，看这几行就知道，不必再猜。
pub(crate) fn wlog_geometry(hwnd: HWND, adb: &Adb) {
    let (cw, ch) = recorder::client_size(hwnd);
    let (wa_w, wa_h) = recorder::monitor_work_area(hwnd);
    let dpi = recorder::window_dpi(hwnd);
    wlog(&format!(
        "[几何] 客户区 {cw}x{ch}；所在显示器可用区 {wa_w}x{wa_h}；窗口 DPI={dpi}（96=100%）；\
         参考 {}x{}@{}（裁掉顶部 {}px 后录 {}x{}）",
        recorder::REF_CLIENT_W,
        recorder::REF_CLIENT_H,
        recorder::REF_DENSITY,
        recorder::bar_h(),
        cw,
        ch - recorder::bar_h()
    ));
    if wa_h > 0 && ch > wa_h {
        wlog(&format!(
            "[几何] 窗口比显示器可用区高 {}px —— 下沿装不下（WGC 仍能完整采集，只是看不全）",
            ch - wa_h
        ));
    }
    // Android 侧的显示尺寸 / 密度：客户区应当与 `wm size` 一致；状态栏高度（= 裁掉的 BAR_H）
    // 与密度成正比，密度一旦不同，裁切就会「留一条黑边」或「切掉一截内容」。
    if let Ok(o) = adb.shell("wm size") {
        wlog(&format!("[几何] wm size: {}", o.replace('\n', " | ").trim()));
    }
    if let Ok(o) = adb.shell("wm density") {
        wlog(&format!("[几何] wm density: {}", o.replace('\n', " | ").trim()));
    }
}

/// 已连上的 adb：可执行文件路径 + 设备序列号（后续命令都带 `-s`）
#[derive(Clone)]
pub(crate) struct Adb {
    exe: PathBuf,
    serial: String,
}

/// 当前监听会话（`None` = 没有在监听）。同一时刻只允许一路。
static ACTIVE: Mutex<Option<Adb>> = Mutex::new(None);

/// 最近一次 [`ensure_wsa`] 有没有真的把 adb 通道建起来。
///
/// 用途是让环境检测别说谎：`status()` 原来只看「WSA 装得完不完整 + 标记文件」，
/// 于是「WSA 装着、但 adb 根本连不上（设备未授权）」时照样三灯全绿 —— 实测反馈里
/// 「界面上显示成功、点录屏却卡住」的矛盾就是它。
///
/// 初始为 `true`：进程刚起来还没试过，不该凭空把灯判红。
static LAST_ADB_OK: AtomicBool = AtomicBool::new(true);

/// adb 通道最近是否可用（见 [`LAST_ADB_OK`]）。
pub fn adb_channel_ok() -> bool {
    LAST_ADB_OK.load(Ordering::Relaxed)
}

/// 是否有监听会话在进行中
pub fn is_active() -> bool {
    ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false)
}

// ==================== adb 探测 / 按需下载 ====================

/// 解析 adb 路径：PATH → `%LOCALAPPDATA%\Android\Sdk\platform-tools` → 之前按需下载的
/// → 现下载 platform-tools 到应用数据目录。
pub async fn resolve_adb(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = find_adb() {
        return Ok(p);
    }
    let dir = platform_tools_dir(app)?;
    let adb = dir.join("adb.exe");
    download_platform_tools(&dir).await?;
    if adb.is_file() {
        Ok(adb)
    } else {
        Err("ADB_NOT_FOUND::解压后仍未找到 adb.exe".into())
    }
}

/// 现成的 adb 可执行文件：PATH / 本机 SDK → 应用数据目录里按需下载的那份。
/// 只做探测，不触发下载（初始化模块据此判断「adb 是否就绪」）。
pub fn adb_exe(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = find_adb() {
        return Some(p);
    }
    let bundled = platform_tools_dir(app).ok()?.join("adb.exe");
    bundled.is_file().then_some(bundled)
}

/// 把 APK 装进一个**已经连上**的 WSA。
/// 装完由调用方写「已安装」标记文件——标记文件落在应用数据目录，所有账号共用。
///
/// 这里不再自己 `ensure_wsa`：安装流程先用 [`ensure_wsa`] 建一次连接、顺手问一句包在不在
/// （不在才去下那 120MB），然后**复用这同一条连接**装 —— 从前是「检查」和「安装」各自
/// `ensure_wsa(true)` 走一遍完整流程，第一遍没连上就整段作废、第二遍把「拉起 WSA / 开开发者
/// 模式 / 应答授权弹窗」原封不动再做一次，用户看到的就是「所有步骤又重来了一遍」。
pub(crate) fn install_apk_on(adb: &Adb, apk: &Path) -> Result<(), String> {
    // `-r` 覆盖安装（修复时重装）、`-g` 把 APP 声明的**运行时权限一次性授予**（相机 / 麦克风 /
    // 存储…）—— 不给 `-g` 的话这些权限会在 APP 首次用到时弹框要，而那时我们正在自动化里跑着，
    // 弹框没人点就卡住。装的时候就给掉，后面一次都不会弹。
    adb.call(&["install", "-r", "-g", &apk.to_string_lossy()])
        .map(|_| ())
        .map_err(|e| format!("APK_INSTALL_FAILED::安装 B 站 APP 失败: {e}"))
}

/// 实测某个包是否真的装在 WSA 里（`pm list packages`）。
/// 只在 WSA 已在跑、adb 能连上时才可能给出结论；连不上返回 `None`（不误报）。
/// 用途：用户在 WSA 里自己装过 B 站 APP（没有我们的标记文件）时也能被识别出来。
pub fn package_installed(exe: &Path, package: &str) -> Option<bool> {
    let adb = connect(exe)?;
    has_package(&adb, package)
}

/// 用**已经建好的连接**问包在不在（安装流程一次连接、检查与安装复用）
pub(crate) fn has_package(adb: &Adb, package: &str) -> Option<bool> {
    let out = adb.shell(&format!("pm list packages {package}")).ok()?;
    Some(
        out.lines()
            .any(|l| l.trim() == format!("package:{package}")),
    )
}

/// 当前前台 Activity 的组件名（形如 `tv.danmaku.bili/.ui.live.LiveRoomActivity`）。
/// 拿不到（命令失败 / 系统字段名不同）返回 `None` —— 调用方据此退回"等满预算"的老行为。
fn resumed_activity(adb: &Adb) -> Option<String> {
    let txt = adb
        .shell("dumpsys activity activities | grep -m1 ResumedActivity")
        .ok()?;
    txt.split_whitespace()
        .find(|t| t.starts_with(PACKAGE))
        .map(|t| t.trim_end_matches('}').to_string())
}

/// 轮询 `ready` 直到成立或超出预算；返回是否在预算内成立。
fn wait_until(budget: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if ready() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

pub fn find_adb() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        let hit = std::env::split_paths(&paths)
            .map(|d| d.join("adb.exe"))
            .find(|p| p.is_file());
        if hit.is_some() {
            return hit;
        }
    }
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let sdk = local
        .join("Android")
        .join("Sdk")
        .join("platform-tools")
        .join("adb.exe");
    sdk.is_file().then_some(sdk)
}

/// platform-tools 的下载/解压目录：放在 **setup 工作区内**（`setup/platform-tools`），
/// 与 WSA 包、B 站 APK 同处一块地方 —— 安装流程落到磁盘上的东西集中在一个目录里，好找也好清。
pub fn platform_tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::setup::setup_dir(app)?.join("platform-tools");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", dir.display()))?;
    Ok(dir)
}

async fn download_platform_tools(dir: &Path) -> Result<(), String> {
    let adb = dir.join("adb.exe");
    if adb.is_file() {
        return Ok(());
    }
    eprintln!("[wsa] 本机未找到 adb，开始下载 platform-tools …");
    let resp = crate::shared_client()
        .get(PLATFORM_TOOLS_URL)
        .send()
        .await
        .map_err(|e| format!("ADB_NOT_FOUND::下载 platform-tools 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "ADB_NOT_FOUND::下载 platform-tools 失败: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("ADB_NOT_FOUND::读取 platform-tools 数据失败: {e}"))?;

    let zip_path = dir.join("platform-tools.zip");
    std::fs::write(&zip_path, &bytes)
        .map_err(|e| format!("NO_WRITE_PERMISSION::写入 {} 失败: {e}", zip_path.display()))?;

    let (src, dest) = (zip_path.clone(), dir.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || extract_platform_tools(&src, &dest))
        .await
        .map_err(|e| format!("ADB_NOT_FOUND::解压任务异常: {e}"))??;
    let _ = std::fs::remove_file(&zip_path);
    Ok(())
}

/// 解压 platform-tools.zip：只取 `platform-tools/` 前缀下的内容并剥掉该层，
/// 于是 `platform-tools/adb.exe` 直接落在 `dest/adb.exe`（AdbWinApi.dll 等一并带出）。
pub(crate) fn extract_platform_tools(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("ADB_NOT_FOUND::打开 {} 失败: {e}", zip_path.display()))?;
    let mut ar = zip::ZipArchive::new(file)
        .map_err(|e| format!("ADB_NOT_FOUND::解析 platform-tools.zip 失败: {e}"))?;
    for i in 0..ar.len() {
        let mut entry = ar
            .by_index(i)
            .map_err(|e| format!("ADB_NOT_FOUND::读取 zip 条目失败: {e}"))?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix("platform-tools/") else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", parent.display()))?;
        }
        let mut f = std::fs::File::create(&out)
            .map_err(|e| format!("NO_WRITE_PERMISSION::写入 {} 失败: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut f)
            .map_err(|e| format!("ADB_NOT_FOUND::解压 {} 失败: {e}", out.display()))?;
    }
    Ok(())
}

// ==================== adb 调用 ====================

/// 本应用**私有的 adb 用户目录**（`%APPDATA%\com.bili-live.app\setup\android-home`）：
/// adb 会把客户端密钥（`adbkey` / `adbkey.pub`）生成在这里，而不是用户的 `%USERPROFILE%\.android`。
///
/// **只在「卡死授权」时才切过来**（见 [`ensure_wsa`] 里的换钥分支）：正常用户一个字节都不碰。
/// 切过来的目的是**拿到一把全新的公钥** —— WSA 宿主的「是否允许 ADB 调试？」弹窗只在它见到
/// **没见过的**公钥时才弹；一旦它把某把公钥记成「已拒绝 / 已处理过」，用同一把再连就永远是
/// `unauthorized` 且**再也不弹窗**，日志里那串「已重做全新握手 3 轮 × 30s 全超时」正是这个死锁。
fn adb_home_dir() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(base)
            .join("com.bili-live.app")
            .join("setup")
            .join("android-home"),
    )
}

/// 当前 adb 用户目录（`None` = 用系统默认的 `%USERPROFILE%\.android`）。由 [`output_of`] 注入。
static ADB_HOME: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 换用私有 adb 用户目录（见 [`adb_home_dir`]）。整个进程只切一次，之后一路沿用同一把密钥。
fn use_private_adb_home() -> bool {
    let Some(dir) = adb_home_dir() else { return false };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        wlog(&format!("[adb] 建私有密钥目录 {} 失败：{e}", dir.display()));
        return false;
    }
    if let Ok(mut g) = ADB_HOME.lock() {
        *g = Some(dir.clone());
    }
    wlog(&format!(
        "[adb] 已改用私有密钥目录 {}（不再使用用户自己的 .android 密钥）",
        dir.display()
    ));
    true
}

/// 进程内是否已经为「授权死锁」换过密钥 —— 只换一次：换完还要用户点弹窗，
/// 每次都换只会让刚点完的那次授权作废。
static ADB_KEY_ROTATED: AtomicBool = AtomicBool::new(false);

/// 跑子进程并拿到输出（`CREATE_NO_WINDOW`：不弹黑框）。
///
/// 顺带注入 `ANDROID_USER_HOME`：切到私有密钥目录后，**每一条** adb 命令都必须用同一个目录，
/// 否则 `kill-server` / `connect` / `shell` 会各自拿着一把不同的密钥，授权永远对不上。
fn output_of(exe: &Path, args: &[String]) -> Result<Output, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args).creation_flags(CREATE_NO_WINDOW.0);
    if let Ok(g) = ADB_HOME.lock() {
        if let Some(dir) = g.as_ref() {
            cmd.env("ANDROID_USER_HOME", dir);
        }
    }
    cmd.output()
        .map_err(|e| format!("ADB_NOT_FOUND::无法启动 {}: {e}", exe.display()))
}

/// stdout + stderr 合并成一段文本（adb 把错误信息混在两边）
fn combined(out: &Output) -> String {
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    text
}

impl Adb {
    /// `adb -s <serial> <args...>`；非 0 退出码视为失败
    fn call(&self, args: &[&str]) -> Result<String, String> {
        let mut argv = vec!["-s".to_string(), self.serial.clone()];
        argv.extend(args.iter().map(|s| s.to_string()));
        let out = output_of(&self.exe, &argv)?;
        let text = combined(&out);
        if out.status.success() {
            Ok(text)
        } else {
            Err(format!(
                "ADB_COMMAND_FAILED::adb {} 失败: {text}",
                args.join(" ")
            ))
        }
    }

    fn shell(&self, cmd: &str) -> Result<String, String> {
        self.call(&["shell", cmd])
    }
}

/// 在屏幕坐标 (x, y) 点一下鼠标
unsafe fn click_at(x: i32, y: i32) {
    let _ = SetCursorPos(x, y);
    std::thread::sleep(Duration::from_millis(120));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    std::thread::sleep(Duration::from_millis(80));
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
}

/// 把窗口顶到前台（最多试 3 次），返回它是否**确实**在前台 —— 不是就别点，
/// 免得这几下点击落到别的窗口上。
unsafe fn bring_to_front(hwnd: HWND) -> bool {
    for _ in 0..3 {
        if GetForegroundWindow() == hwnd {
            return true;
        }
        let _ = SetForegroundWindow(hwnd);
        std::thread::sleep(Duration::from_millis(250));
    }
    GetForegroundWindow() == hwnd
}

/// 自动应答 WSA 的 adb 授权弹窗。
///
/// 首次把本机 adb 公钥交给 Android 侧时，WSA 会在桌面上弹一个**原生 Win32 对话框**：
/// 正文是电脑的 RSA 指纹，一个「始终允许从此计算机」复选框，加「拒绝」/「允许」。
/// 不点它 `adb devices` 就永远停在 `unauthorized` —— 端口 58526 在监听也白搭，
/// 这正是「WSA 装好了、开发者模式也开了，却怎么都连不上」的真凶。
///
/// 好在内容通过 UI Automation 暴露成若干按名字可辨的元素，**每个都能读到精确屏幕矩形** ——
/// 于是可以替用户勾上「始终允许」再按「允许」，全程零点击。这些元素只暴露名字与坐标、
/// 不支持 InvokePattern，所以只能模拟鼠标点，没有更干净的路。
///
/// 「始终允许」必须勾：Android 会把公钥写进 `/data/misc/adb/adb_keys`，之后每次连都不再弹窗。
/// 找不到弹窗（没在授权中 / 早就授权过）就静默返回 `false`。
///
/// **匹配放宽了两处**：① 原来卡死「类名正好是 `#32770`」，现在「标准对话框**或**标题里带 `ADB`」
/// 都行；② 原来只在**后代元素**里找 `ADB`，而标题根本不参与 —— 可「是否允许 ADB 调试？」这类
/// 弹窗的关键字恰恰在标题上。实测 Win10 上自动应答**一次都没生效、日志里也一条痕迹都没有**，
/// 而「弹窗根本没出现」与「弹窗在、只是认法不匹配」这两种病因在放宽前**分不开**。认不到时
/// 把顶层窗口清单打进日志（见 [`dump_top_windows`]），下一次现场就能一眼区分开。
fn accept_adb_auth() -> bool {
    unsafe {
        // UI Automation 要求调用线程初始化过 COM。重复初始化、或本线程已是别的套间模型
        // （返回 RPC_E_CHANGED_MODE）都无所谓，能用就行，故不理返回值。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else {
            return false;
        };
        let Ok(cond) = uia.CreateTrueCondition() else {
            return false;
        };
        let Ok(root) = uia.GetRootElement() else {
            return false;
        };
        let Ok(tops) = root.FindAll(TreeScope_Children, &cond) else {
            return false;
        };
        let mut saw_adb = false;
        for i in 0..tops.Length().unwrap_or(0) {
            let Ok(top) = tops.GetElement(i) else { continue };
            // 先过一道**便宜的**门槛，免得在不相干窗口里乱找按钮（尤其下面放宽了类名要求，
            // 没有这道门槛就可能去点 WSA 设置窗口里的「确定」）：
            // 要么是标准 Win32 对话框（`#32770`，原来只认这一种），要么**标题**里带 `ADB`。
            let title = top
                .CurrentName()
                .map(|n| n.to_string())
                .unwrap_or_default();
            let title_has_adb = title.to_lowercase().contains("adb");
            let class = top.CurrentClassName().map(|c| c.to_string()).unwrap_or_default();
            if class != "#32770" && !title_has_adb {
                continue;
            }
            let Ok(kids) = top.FindAll(TreeScope_Descendants, &cond) else {
                continue;
            };
            let (mut checkbox, mut allow) = (None, None);
            let mut desc_has_adb = false;
            for k in 0..kids.Length().unwrap_or(0) {
                let Ok(el) = kids.GetElement(k) else { continue };
                let name = el.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                let low = name.to_lowercase();
                if low.contains("adb") {
                    // 标题 / 正文里出现 `ADB` 是**语言无关**的判据（各语言都带这三个字母）。
                    // 注意**必须也看标题**（就是上面的 `title_has_adb`）：原来只在后代里找，
                    // 而「是否允许 ADB 调试？」这类弹窗的关键字恰恰在标题上、不在后代里。
                    desc_has_adb = true;
                } else if low.contains("始终允许") || low.contains("always allow") {
                    checkbox = el.CurrentBoundingRectangle().ok();
                } else if is_allow_label(&name) {
                    allow = el.CurrentBoundingRectangle().ok();
                }
            }
            let matched = title_has_adb || desc_has_adb;
            saw_adb |= matched;
            // 认到 `ADB` 字样 + 「允许」按钮才算数：只撞上 `ADB` 字样（正文里的 RSA 指纹、
            // 别的对话框）就动手，等于赌运气。
            if !matched || allow.is_none() {
                if matched {
                    wlog("[wsa] 认到 adb 授权框但没找到「允许」按钮，无法自动应答");
                    dump_top_windows();
                }
                continue;
            }
            let hwnd = top.CurrentNativeWindowHandle().unwrap_or_default();
            // 只有确认弹窗真的在最前面才动手 —— 否则这两下点击会落在别的窗口上
            if !bring_to_front(hwnd) {
                wlog("[wsa] adb 授权框没能切到前台（被别的窗口占着），放弃自动应答");
                return false;
            }
            // 「始终允许」是那一行的**左端**小方块：该 Pane 的矩形覆盖了整行（含文字），
            // 所以取左侧内缩一小段，而不是取矩形中心。
            if let Some(r) = checkbox.filter(|r| r.right > r.left) {
                click_at(r.left + 10, r.top + (r.bottom - r.top) / 2);
                std::thread::sleep(Duration::from_millis(300));
            }
            if let Some(r) = allow.filter(|r| r.right > r.left) {
                click_at(
                    r.left + (r.right - r.left) / 2,
                    r.top + (r.bottom - r.top) / 2,
                );
            }
            wlog("[wsa] 已自动应答 adb 授权弹窗（勾选「始终允许」+ 点「允许」）");
            return true;
        }
        if !saw_adb {
            dump_top_windows();
        }
        false
    }
}

/// 「允许」类按钮的名字（中英）。原来只认 `允许` 两个字，界面换个说法就**静默**失效 ——
/// 放宽成一组常见叫法，配合 [`dump_top_windows`] 的留痕，下次照日志补即可。
fn is_allow_label(name: &str) -> bool {
    matches!(
        name.trim().to_lowercase().as_str(),
        "允许" | "是" | "确定" | "allow" | "yes" | "ok"
    )
}

/// `dump_top_windows` 的次数上限（见该函数的说明）。
static AUTH_DUMPED: AtomicU8 = AtomicU8::new(0);

/// 把当前**可见顶层窗口**的 `类名 | 标题` 打一遍日志（每进程最多 2 次）。
///
/// 为什么需要它：`accept_adb_auth` 认不到弹窗时是**静默**返回 `false` 的，日志里什么痕迹都没有，
/// 于是「弹窗压根没出现」和「弹窗在、只是认法不匹配」这两种截然不同的病因在现场分不开 ——
/// 实测就是卡在这儿来回猜了好几轮（Win10 授权永远失败、日志一片空白）。
fn dump_top_windows() {
    if AUTH_DUMPED.fetch_add(1, Ordering::Relaxed) >= 2 {
        return;
    }
    unsafe extern "system" fn hit(hwnd: HWND, lp: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut tbuf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut tbuf);
            let mut cbuf = [0u16; 256];
            let cn = GetClassNameW(hwnd, &mut cbuf);
            let title = String::from_utf16_lossy(&tbuf[..n as usize]);
            let class = String::from_utf16_lossy(&cbuf[..cn as usize]);
            (*(lp.0 as *mut Vec<String>)).push(format!("{class} | {title}"));
        }
        BOOL(1)
    }
    let mut list: Vec<String> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(hit), LPARAM(&mut list as *mut Vec<String> as isize));
    }
    wlog(&format!("[wsa][诊断] 未认到 adb 授权框；当前可见顶层窗口 {} 个：", list.len()));
    for l in &list {
        wlog(&format!("[wsa][诊断]   {l}"));
    }
}

/// `adb devices` 里该 serial 是不是正卡在 `unauthorized`（= 授权弹窗正等人点）。
fn is_unauthorized(exe: &Path, serial: &str) -> bool {
    let Ok(out) = output_of(exe, &["devices".to_string()]) else {
        return false;
    };
    combined(&out)
        .lines()
        .any(|l| l.contains(serial) && l.contains("unauthorized"))
}

/// 连接 WSA 的 adb：依次在候选端口上 `adb connect`，再用 `shell echo` 真正确认可用。
/// 卡在 `unauthorized` 时只做一次短暂应答——**状态查询**用的就是这个，不能让它长等。
fn connect(exe: &Path) -> Option<Adb> {
    connect_inner(exe, None)
}

/// 同 [`connect`]，但卡在 `unauthorized` 时愿意花时间等用户授权（见 [`wait_for_adb_auth`]）。
/// 只给 `ensure_wsa`（安装/录屏这种"就是要连上"的场景）用；`deadline` 是这次等待的**总预算**
/// 上界（见 [`ADB_AUTH_BUDGET_SETUP`]），到点后授权等待自动降级成「一次应答 + 复查」。
fn connect_waiting_auth(exe: &Path, deadline: Instant) -> Option<Adb> {
    connect_inner(exe, Some(deadline))
}

fn connect_inner(exe: &Path, auth_deadline: Option<Instant>) -> Option<Adb> {
    for port in ADB_PORTS {
        let serial = format!("127.0.0.1:{port}");
        let _ = output_of(exe, &["connect".to_string(), serial.clone()]);
        let cand = Adb {
            exe: exe.to_path_buf(),
            serial: serial.clone(),
        };
        if adb_usable(&cand) {
            wlog(&format!("[adb] {serial} 已可用"));
            return Some(cand);
        }
        let unauth = is_unauthorized(exe, &serial);
        wlog(&format!("[adb] {serial} 连不上（unauthorized={unauth}）"));
        if unauth {
            if let Some(deadline) = auth_deadline {
                return wait_for_adb_auth(&cand, deadline);
            }
            std::thread::sleep(Duration::from_millis(800)); // 等弹窗渲染出来
            accept_adb_auth();
            // 应答后**无条件**复查：用户手动点了「允许」时 accept 找不到弹窗会返回 false，
            // 若写成 `accept() && usable()` 就正好短路掉"其实已经授权好了"这条路。
            if adb_usable(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

/// `adb shell echo ok` 真的回来才算这条连接可用（`adb connect` 返回成功不代表能用）
fn adb_usable(cand: &Adb) -> bool {
    cand.shell("echo ok").map(|s| s.contains("ok")).unwrap_or(false)
}

/// 等设备侧完成 adb 授权（Android 的「是否允许 ADB 调试？」弹窗）。
///
/// **为什么不能"睡一下再复查一次"**：实测（Win10，DESKNEATH）——adb 端口在第 7 秒就监听了，
/// 而那个授权弹窗要等 Android 的**系统 UI 就绪**才渲染得出来，实测约 1~2 分钟。于是第一次
/// 握手必然发生在 UI 就绪**之前**，弹窗请求根本发不出来；更糟的是 adb 一旦把这个 serial 记成
/// 已连接，后续 `adb connect` 只回 `already connected to ...`、**不会重新协商**，于是
/// 「握手太早」会永久卡在 `unauthorized`，怎么等都不会自己好（实测：反复 `connect` 无效，
/// 用户手点「允许」也无效）。`adb disconnect` 同样无效——adb 对 TCP 设备会自动重连，刚断开
/// 就又被接回去，所以拿不到新传输。
///
/// 因此这里每轮都先**重做一次全新握手**（`kill-server` 丢掉陈旧传输 → 重新 `connect`），
/// 让授权请求能在 UI 就绪后被重新发出；然后在窗口期内持续尝试自动应答弹窗并复查连接。
/// `kill-server` 会顺带停掉本机其它 adb 使用方（如 Android Studio），但这是拿到新握手最可靠
/// 的手段，且只在已判定 `unauthorized` 时才会走到。
///
/// **必须受 `deadline` 约束**：本函数一轮就是 `ADB_AUTH_ROUNDS × ADB_AUTH_WINDOW` = 90 秒，
/// 而 [`ensure_wsa`] 的两个轮询循环**每秒**都会调进来一次 —— 不封顶时单次 `ensure_wsa` 能拖到
/// 五分钟以上（实测反馈「点录制后一直卡住没反应」正是它）。预算花完后降级成
/// 「一次应答 + 复查」，几乎不花时间，轮询恢复每秒一次的节奏。
fn wait_for_adb_auth(cand: &Adb, deadline: Instant) -> Option<Adb> {
    if Instant::now() >= deadline {
        // 预算已尽：不进入整轮等待，只顺手替用户点一下弹窗（若正好在）并复查一次。
        accept_adb_auth();
        return adb_usable(cand).then(|| cand.clone());
    }
    for round in 1..=ADB_AUTH_ROUNDS {
        if Instant::now() >= deadline {
            break;
        }
        let _ = output_of(&cand.exe, &["kill-server".to_string()]);
        let _ = output_of(&cand.exe, &["connect".to_string(), cand.serial.clone()]);
        wlog(&format!(
            "[wsa] 设备未授权，已重做全新握手（第 {round}/{ADB_AUTH_ROUNDS} 轮），等授权窗口 {}s …",
            ADB_AUTH_WINDOW.as_secs()
        ));
        let until = (Instant::now() + ADB_AUTH_WINDOW).min(deadline);
        while Instant::now() < until {
            accept_adb_auth();
            // 无条件复查：用户手动点过「允许」时 accept 找不到弹窗会返回 false，
            // 若写成 `accept() && usable()` 就会短路掉这条最该走通的路。
            if adb_usable(cand) {
                wlog(&format!("[wsa] 设备已授权，adb 可用（第 {round} 轮）"));
                return Some(cand.clone());
            }
            std::thread::sleep(ADB_AUTH_POLL);
        }
    }
    wlog("[wsa] 等设备授权超时：adb 端口在监听，但设备侧始终未授权");
    None
}

fn boot_completed(adb: &Adb) -> bool {
    adb.shell("getprop sys.boot_completed")
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

/// WSA 是否已安装：包内把 `WsaClient.exe` 注册成了 AppExecutionAlias，落在 WindowsApps 下
pub fn wsa_installed() -> bool {
    std::env::var_os("LOCALAPPDATA")
        .map(|l| {
            PathBuf::from(l)
                .join("Microsoft")
                .join("WindowsApps")
                .join("WsaClient.exe")
                .is_file()
        })
        .unwrap_or(false)
}

/// `WsaClient.exe` 的路径：`%LOCALAPPDATA%\Microsoft\WindowsApps\` 下那个**执行别名**
/// （安装时注册的重解析点，真实文件在安装目录的 `WsaClient\WsaClient.exe`）。
fn wsa_client_exe() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Microsoft")
        .join("WindowsApps")
        .join("WsaClient.exe");
    p.is_file().then_some(p)
}

/// 拉起 WSA **本体**（子系统）。
///
/// 直接跑 `WsaClient.exe`（无参数）：它不显示任何界面，只把子系统启起来 —— 比经 `explorer`
/// 走开始菜单 AppID 少一层，也不依赖资源管理器。别名不在时退回 AppID。
///
/// 实测冷启动时序：**1.4 秒**出现 `vmmemWSA`、**7.4 秒** adb 端口 58526 开始监听。
/// 所以**别拿 `vmmemWSA` 当就绪信号**（它出现得太早，那会儿端口还没开），轮询 adb 才准。
///
/// 拉起之前先 [`pre_allow_host_capabilities`]：那三个宿主隐私弹窗就是在这时候冒出来的。
fn launch_wsa() {
    pre_allow_host_capabilities();
    if let Some(exe) = wsa_client_exe() {
        if Command::new(exe)
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    launch_wsa_shell();
}

/// 刚装完 WSA 就把它拉起来跑着 —— 安装流程在注册成功后**立刻**调它。
///
/// 为什么值得提前跑一趟：WSA 冷启动要几十秒（**首次还要初始化 userdata，更慢**），而安装流程
/// 紧接着的两步（下 platform-tools、下 120MB 的 APK）是**纯等待**。让子系统边下边启动，等第 3 步
/// 真要连 adb 时它往往已经跑完，那几十秒就被藏进下载里了。
///
/// 顺手把首启的「可选诊断数据」说明框点掉：它跟子系统一块儿冒出来，不点就会压在桌面上
/// 一直等下载结束。它一辈子只弹一次，所以最多等 4 秒，没弹就直接往下走。
pub(crate) fn boot_wsa_early() {
    launch_wsa();
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(500));
        if dismiss_first_run_dialog() {
            break;
        }
    }
}

/// 经开始菜单 AppID 拉起 WSA 本体（`launch_wsa` 的直接启动走不通时的退路）
fn launch_wsa_shell() {
    let _ = Command::new("explorer.exe")
        .arg(format!("shell:appsFolder\\{WSA_SHELL_ID}"))
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// 把 WSA 的**设置窗口**摆到用户面前。那个开关在左侧「高级设置」页里
/// （本机 WSA 的设置界面没有独立的「开发人员」页）。
/// 已经开着时 `explorer` 只是把它切到前台，不会开出第二个窗口。
fn launch_wsa_settings() {
    let _ = Command::new("explorer.exe")
        .arg(format!("shell:appsFolder\\{WSA_SETTINGS_ID}"))
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// WSA 的包家族名（PackageFamilyName）。写死省一次 `Get-AppxPackage`（那是秒级的 PowerShell），
/// 与 [`WSA_SHELL_ID`] / [`WSA_SETTINGS_ID`] 里那串是同一个包，改不了。
const WSA_PFN: &str = "MicrosoftCorporationII.WindowsSubsystemForAndroid_8wekyb3d8bbwe";

/// 预先把 Windows **宿主侧**的「相机 / 麦克风 / 位置」隐私授权写成**允许** —— 让那三个弹窗
/// **根本弹不出来**（而不是等它弹了再去点）。
///
/// 为什么只删清单里的 `DeviceCapability` 不够：清单剥离只挡掉了注册时的能力声明，WSA 运行起来
/// 之后仍会向 Windows 申请这同三个能力，弹的是 **Windows 自己的隐私弹窗**，时机在子系统启动
/// 过程中的某一步、飘忽不定，没法靠"等它出现再点"来对付。
///
/// 位置是 `HKCU\...\CapabilityAccessManager\ConsentStore\<能力>\<包家族名>`，`Value` 三态：
/// `Allow` 直接放行、`Deny` 直接拒绝、**键不存在才会弹窗**。预写 `Allow` 就是"源头静默消除"。
/// 写在 HKCU，普通用户权限就够，且立即生效（不用重启资源管理器）。
fn pre_allow_host_capabilities() {
    const CAPS: [&str; 3] = ["webcam", "microphone", "location"];
    for cap in CAPS {
        let key = format!(
            "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\\
             CapabilityAccessManager\\ConsentStore\\{cap}\\{WSA_PFN}"
        );
        let _ = Command::new("reg")
            .args(["add", &key, "/v", "Value", "/t", "REG_SZ", "/d", "Allow", "/f"])
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 一个窗口标题是不是 WSA 的（本体窗口 / 设置窗口都算）。
///
/// **别写死英文前缀**：合并中文资源后标题变成了「适用于 Android™ 的 Windows 子系统」，
/// `starts_with("Windows Subsystem for Android")` 就永远不命中 —— 那种失配是**静默**的
/// （函数只是循环到超时后返回 false），表现成「设置窗口明明开着，就是不自动切到高级设置」。
/// 「Android」这几个拉丁字母中英标题里都有，拿它认最稳。
fn is_wsa_title(title: &str) -> bool {
    title.to_lowercase().contains("android")
}

/// 收起 WSA 的设置窗口 —— 「开发人员模式」已经代打开了，别让它继续占着桌面。
///
/// 按标题枚举**可见**顶层窗口，给每个命中项发 `WM_CLOSE`（等同点右上角 ×）。
/// 必须过滤可见性：WSA 进程里叫这个名字的隐藏辅助窗口还有几个，不过滤会误伤。
/// 关掉设置 UI 只是关窗口，**不会**停掉子系统 —— WSA 本体继续在后台跑着，adb 照常可用。
fn close_wsa_settings() {
    unsafe extern "system" fn hit(hwnd: HWND, _: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(hwnd, &mut buf);
            if n > 0 {
                let title = String::from_utf16_lossy(&buf[..n as usize]);
                if is_wsa_title(&title) {
                    let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
        }
        BOOL(1) // 继续枚举（同名窗口可能不止一个）；返回 0 才是中断
    }
    unsafe {
        let _ = EnumWindows(Some(hit), LPARAM(0));
    }
}

/// 首次启动 WSA 会弹一个「**可选诊断数据**」说明框：一段说明 + 一个「共享诊断日志」复选框
/// + 一个「继续」按钮。它压在 WSA 界面（设置窗口）前面，那段说明也没人会读 ——
/// 这里替用户直接点「继续」。**不勾那个复选框**：勾上等于替用户答应共享诊断数据，
/// 只点「继续」就是默认的「不共享」。
///
/// 认法先便宜后贵：
/// ① `EnumWindows` 按**标题**筛可见顶层窗口（标题里带 Android / 诊断 —— WSA 的窗口标题
///    是「适用于 Android™ 的 Windows 子系统」，说明框和设置窗口**共用这个标题**）；
/// ② 在命中的窗口里用 UI Automation 找元素，**必须同时**出现「名字含『诊断』且真能拨的
///    复选框 / 开关」与「『继续』按钮」才动手，免得点错别的对话框。
///
/// 点击优先用 UIA 的 `Invoke()`（不动鼠标、不抢焦点；XAML 按钮支持它）；标准 Win32 按钮
/// 不支持 Invoke 时退回坐标点击 —— 那就得先把窗口顶到前台，抢不到就放弃（宁可不动手）。
/// **点完一律复检说明框是不是真的没了**才报成功（见下方注释）。
/// 不是首次启动、布局换过认不出、用户自己已点过 —— 一律静默返回 `false`。
fn dismiss_first_run_dialog() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        else {
            return false;
        };
        let Ok(cond) = uia.CreateTrueCondition() else {
            return false;
        };
        let Some((hwnd, btn)) = find_first_run_dialog(&uia, &cond) else {
            return false;
        };
        // ① 先试 Invoke。**不能只看返回值**：说明框是模态的，会把底下的设置窗口压成
        //    「不可用」，那个窗口里若有同名按钮，对它的 Invoke 照样返回 S_OK 却什么也不发生
        //    —— 以前就栽在这儿：日志写着「已自动点掉」，界面上说明框还杵着。
        if let Ok(inv) = btn.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if inv.Invoke().is_ok() {
                std::thread::sleep(Duration::from_millis(400));
                if find_first_run_dialog(&uia, &cond).is_none() {
                    eprintln!("[wsa] 已自动点掉「可选诊断数据」说明框：继续");
                    return true;
                }
            }
        }
        // ② Invoke 没奏效 → 坐标点击「继续」（说明框是模态的，它就在最前面）
        let Ok(r) = btn.CurrentBoundingRectangle() else {
            return false;
        };
        if r.right <= r.left {
            return false;
        }
        if !bring_to_front(hwnd) {
            return false; // 抢不到前台就不点，免得把这一下点到别的窗口上
        }
        click_at(r.left + (r.right - r.left) / 2, r.top + (r.bottom - r.top) / 2);
        std::thread::sleep(Duration::from_millis(400));
        if find_first_run_dialog(&uia, &cond).is_none() {
            eprintln!("[wsa] 已自动点掉「可选诊断数据」说明框：继续（坐标点击）");
            return true;
        }
        eprintln!("[wsa] 点了说明框的「继续」但它没关掉，这一轮放弃重试");
        false
    }
}

/// 在可见顶层窗口里挑候选（标题带 Android / 诊断）。
/// 说明框和设置窗口**标题完全一样**，所以候选必然包含设置窗口本身 —— 真正的区分交给
/// 下面的元素签名，不靠标题。
unsafe extern "system" fn collect_wsa_windows(hwnd: HWND, lp: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n > 0 {
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            if title.contains("诊断") || title.to_lowercase().contains("android") {
                (*(lp.0 as *mut Vec<HWND>)).push(hwnd);
            }
        }
    }
    BOOL(1)
}

/// 找「可选诊断数据」说明框里的「继续」按钮，返回 (它所在的最顶层窗口, 按钮)。
/// 判据是**同一个窗口树里同时**有：
/// - 「名字含『诊断』且**真能拨**的开关」—— WSA 设置的「系统」页里也有「可选诊断数据」
///   字样（那是 Group / Text），只认 TogglePattern 就能把那一页排除掉；
/// - 「名字恰好是『继续』**且当前可用**的按钮」—— 模态说明框会把底下的设置窗口压成不可用，
///   加这个「可用」判断就不会去点被压住的按钮。
unsafe fn find_first_run_dialog(
    uia: &IUIAutomation,
    cond: &IUIAutomationCondition,
) -> Option<(HWND, IUIAutomationElement)> {
    let mut cands: Vec<HWND> = Vec::new();
    let _ = EnumWindows(
        Some(collect_wsa_windows),
        LPARAM(&mut cands as *mut Vec<HWND> as isize),
    );
    for hwnd in cands {
        let Ok(win) = uia.ElementFromHandle(hwnd) else { continue };
        let Ok(kids) = win.FindAll(TreeScope_Descendants, cond) else {
            continue;
        };
        let (mut diag, mut go) = (false, None);
        for i in 0..kids.Length().unwrap_or(0) {
            let Ok(el) = kids.GetElement(i) else { continue };
            let name = el.CurrentName().map(|n| n.to_string()).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if name.contains("诊断") {
                if el
                    .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .is_ok()
                {
                    diag = true;
                }
            } else if name == "继续" && el.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(false) {
                go = Some(el);
            }
        }
        if let (true, Some(btn)) = (diag, go) {
            return Some((hwnd, btn));
        }
    }
    None
}

/// 留给用户「自己点掉弹窗」的时间窗（见 [`wait_until_with_grace`]）
const USER_GRACE: Duration = Duration::from_secs(20);

/// 等一个「APP 已到位」的信号；**信号不来就再宽限一段**，把这段时间留给用户手动关弹窗。
///
/// 为什么不再自动关：按类名（`Shell_SystemDialog*`）认出就 `WM_CLOSE` 那套，实测确实关得掉
/// 授权框 —— 但判断依据**只有类名**（窗口刚出生时标题还是占位的 `Message Dialog`，认不了
/// 标题），一旦上游把类名复用到别的系统对话框上，我们就会把用户真正想点的那个窗口关掉，
/// 而且关掉之后没有任何补救余地。这类"代用户做决定"的事不值得为省一次点击去冒险。
///
/// 现在的分工：
/// - **源头**由 `setup::strip_wsa_device_capabilities` 把清单里三条设备能力删掉，授权框不再产生；
/// - **漏网的**（诊断 / 反馈这类非能力类弹窗，改清单压不掉）不代点，交回用户；
/// - 我们只负责**把时间留出来**，并且只在信号拿不到时才留 —— 顺利时一秒都不多等。
fn wait_until_with_grace(budget: Duration, mut ready: impl FnMut() -> bool, what: &str) -> bool {
    if wait_until(budget, &mut ready) {
        return true;
    }
    eprintln!(
        "[wsa] {what}的信号一直没来 —— 可能是有系统弹窗（权限申请 / 诊断反馈之类）挡在前面，\
         请手动关掉它；这里再等 {} 秒。",
        USER_GRACE.as_secs()
    );
    wait_until(USER_GRACE, &mut ready)
}

/// 设置窗口里两个要点的名字。安装流程会把中文资源合并进 `resources.pri`，
/// 所以装出来的 WSA 界面**一定是中文**，这里只认中文名即可（换了布局再改这里）。
///
/// 名字都取自本机实测的 UIA 树：
/// - 左侧「高级设置」是 ListItem；
/// - 「开发人员模式」开关在 UIA 里的名字是「开发人员模式**。**同一专用网络上的设备可以访问子系统。」
///   —— 名字带上了说明文字，所以用前缀匹配。
const NAV_ADVANCED: &str = "高级设置";
const DEV_MODE: &str = "开发人员模式";

/// 在 UIA 子树里找第一个「名字满足 `hit` **且** `take` 认账」的元素，返回 `take` 的产物。
///
/// 为什么不按名字直接取第一个：WinUI 一个控件在 UIA 树里是**好几个**同名元素 ——
/// 「开发人员模式」同时有 `Text`（标签）和 `Button`（开关本体，带 TogglePattern），
/// 页面标题 `Text` 也和左侧导航 `ListItem` 同名。只认名字会撞上那个没有模式的标签，
/// 于是「名字找到了却点不动」。让调用方按「支不支持那个 Pattern」来筛才稳。
unsafe fn find_matching<T>(
    root: &IUIAutomationElement,
    cond: &IUIAutomationCondition,
    hit: impl Fn(&str) -> bool,
    take: impl Fn(&IUIAutomationElement) -> Option<T>,
) -> Option<T> {
    let list = root.FindAll(TreeScope_Descendants, cond).ok()?;
    for i in 0..list.Length().unwrap_or(0) {
        let Ok(el) = list.GetElement(i) else { continue };
        let name = el.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        if hit(&name) {
            if let Some(v) = take(&el) {
                return Some(v);
            }
        }
    }
    None
}

/// 在设置窗口里先进入「高级设置」页，再把「开发人员模式」开关打开。
/// 返回「这一趟是不是真的把开关打开了」。本来是 On 的也算成，不需要区分。
unsafe fn toggle_developer_mode(
    win: &IUIAutomationElement,
    cond: &IUIAutomationCondition,
) -> bool {
    // 左侧导航项是 ListItem，要用 SelectionItemPattern 选中（实测 InvokePattern 无效）
    let Some(nav) = find_matching(
        win,
        cond,
        |n| n == NAV_ADVANCED,
        |el| {
            el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                .ok()
        },
    ) else {
        eprintln!("[wsa] 设置窗口里没找到「{NAV_ADVANCED}」导航项，跳过自动开关");
        return false;
    };
    let _ = nav.Select();
    std::thread::sleep(Duration::from_millis(900)); // 等页面切过去
    // 页内那个 ToggleSwitch（名字带一段说明文字，用前缀匹配）
    let Some(tp) = find_matching(
        win,
        cond,
        |n| n.starts_with(DEV_MODE),
        |el| {
            el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .ok()
        },
    ) else {
        eprintln!("[wsa] 「{NAV_ADVANCED}」页里没找到带 TogglePattern 的「{DEV_MODE}」开关");
        return false;
    };
    match tp.CurrentToggleState() {
        Ok(s) if s == ToggleState_Off => tp.Toggle().is_ok(),
        Ok(_) => true, // 本来就是 On，不用动
        Err(_) => false,
    }
}

/// 自动打开 WSA 的「开发人员模式」——「WSA 能不能用命令开开发者模式」的答案就落在这里。
///
/// 先说结论：WSA **没有**官方 CLI 开关；网上流传的
/// `HKCU\...\SystemAppData\<包全名>\WSA` 下写 `DeveloperMode=1` 是**编的** ——
/// 本机实测该位置既没有 `WSA` 子键、也没有 `DeveloperMode` 值，照着写只会留下一个没人读的死键。
///
/// 真正可行的自动化是驱动它的设置窗口：设置界面是原生 WinUI，左侧「高级设置」
/// 是 ListItem，页内「开发人员模式」是 ToggleSwitch，两者都能通过 UI Automation 直接操作。
///
/// 静默开开发者模式的其他路子都试过了、都不通，只剩驱动设置窗口这一条：
/// `settings.dat`（UWP ApplicationData 的注册表 hive）在 WSA 运行时被独占锁定 —— 连只读
/// 共享都打不开，WSA 停掉也照样锁着，非管理员进程根本没法写；安装包里也没有任何 ADMX / 策略
/// 模板（`HKLM\SOFTWARE\Policies\Microsoft\WindowsSubsystemForAndroid` 那套是网上编的）。
/// 好在设置界面是原生 WinUI，左侧「高级设置」是 ListItem、页内开关是 ToggleSwitch，
/// 都能用 UI Automation 直接操作。
///
/// **不需要重启子系统**：实测提前把 WSA 拉起来之后再切这个开关，adb 端口照样会监听 ——
/// 首次连接弹的凭证框由 [`accept_adb_auth`] 应答掉就通了。以前那套「刚切开就 shutdown 掉重来
/// 一轮」的多余流程已经删掉。
///
/// 需要设置窗口已经在跑（调用前先 `launch_wsa_settings()`），所以这里先等它出现。
/// 界面按中文认（见 [`NAV_ADVANCED`] / [`DEV_MODE`]）；以后换了布局就静默返回 false ——
/// 那时窗口已经摆在用户面前了，手点一下也一样。
///
/// 开关一开成，**当场就把这个设置窗口收掉**（见函数末尾）：它是我们为了代开开关才打开的，
/// 开关开完就没用了。以前只在启动流程走完时才关（`ensure_wsa` 里那处），而那段最长 120 秒，
/// 用户会盯着一个已经无用的面板干等，还以为卡住了。
fn enable_developer_mode() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else {
            return false;
        };
        let Ok(cond) = uia.CreateTrueCondition() else {
            return false;
        };
        for _ in 0..15 {
            let Ok(root) = uia.GetRootElement() else {
                return false;
            };
            let Ok(tops) = root.FindAll(TreeScope_Children, &cond) else {
                return false;
            };
            for i in 0..tops.Length().unwrap_or(0) {
                let Ok(win) = tops.GetElement(i) else { continue };
                // 设置窗口标题：中文界面是「适用于 Android™ 的 Windows 子系统」
                let title = win.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                if !is_wsa_title(&title) {
                    continue;
                }
                // 认到标题**不代表**页面已经渲染好（刚启动时导航项还不在树里），
                // 所以失败不当场认输，睡一觉再看一轮 —— 这是原来那个「名字写错就
                // 静默返回 false」的坑之外的第二层保险。
                if !toggle_developer_mode(&win, &cond) {
                    continue; // 页面可能还没渲染完，下一轮再看
                }
                // 开关已成（或本来就开着），这个面板没用了 —— 当场关掉。
                // 关的是**刚操作过的那个元素**的本体窗口（`CurrentNativeWindowHandle`），
                // 不另找窗口：省得再依赖标题 / 类名去猜，也就不会再出现「找到了却关错/关不掉」。
                std::thread::sleep(Duration::from_millis(500)); // 等开关状态落定再关
                if let Ok(h) = win.CurrentNativeWindowHandle() {
                    let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
                return true;
            }
            std::thread::sleep(Duration::from_millis(500)); // 窗口可能还在启动
        }
        eprintln!("[wsa] 没找到可操作的 WSA 设置窗口（标题里没有 android），无法自动切到「高级设置」");
        false
    }
}

/// 确保 WSA 在跑且 adb 可连：能连就直接用；连不上就唤醒 WSA（需要时先代开「开发人员模式」），
/// 再轮询到启动完成。
///
/// `show_settings`：唤醒 WSA 时是否**代开「开发人员模式」开关**（adb 端口 58526 只有开了它
/// 才监听）。安装 / 修复流程给 `true`；开始录屏那条路给 `false`，因为那里 WSA 往往只是睡着了、
/// 再弹一个设置窗口纯属打扰。
///
/// 整条链：开设置窗口 → 点掉诊断说明框 → 切开关 → 收窗口 →（没在跑才）显式 `launch_wsa()`
/// → 轮询 `connect`（首次连上会弹授权窗，由 [`accept_adb_auth`] 应答）。
///
/// 切开关**不需要**重启子系统：安装流程早就把 WSA 提前拉起来了（见 [`boot_wsa_early`]），
/// 这时候切开关照样能让端口监听，直接连上就行 —— 以前那套 shutdown + 再 launch 是多余的一轮。
///
/// [`ensure_wsa_inner`] 的对外入口：顺手把「这一次到底有没有把 adb 通道建起来」记进
/// [`LAST_ADB_OK`]，供环境检测（`setup::status`）决定该不该把灯判红。
pub(crate) fn ensure_wsa(exe: &Path, show_settings: bool) -> Result<Adb, String> {
    let r = ensure_wsa_inner(exe, show_settings);
    LAST_ADB_OK.store(r.is_ok(), Ordering::Relaxed);
    r
}

fn ensure_wsa_inner(exe: &Path, show_settings: bool) -> Result<Adb, String> {
    // 本次调用允许花在「等设备授权」上的**总预算**：安装 / 修复给足（要摆设置窗口、可能整台
    // 冷启动），点「开始录制」只给一点点 —— 那一刻用户正等着窗口弹出来。
    let auth_deadline = Instant::now()
        + if show_settings {
            ADB_AUTH_BUDGET_SETUP
        } else {
            ADB_AUTH_BUDGET_RECORD
        };
    // 日志的「清空」只在 `setup::install` 入口做一次 —— 若在这里也清，会把安装第 1、2 步
    // 的记录一起抹掉（本函数是第 3 步才被调到的）。
    if show_settings {
        wlog("[wsa] ===== 安装 / 修复：ensure_wsa(show_settings=true) =====");
    }
    wlog("[wsa] ensure_wsa 开始：先试直连现有 adb");
    if let Some(adb) = connect_waiting_auth(exe, auth_deadline) {
        // adb 已经通了，设置窗口就多余了：可能是上一轮超时留下的那一个（当时特意留给
        // 用户手点开关），现在既然连上了就顺手收起，别一直挂在桌面上。
        if show_settings {
            close_wsa_settings();
        }
        return Ok(adb);
    }
    if !wsa_installed() {
        return Err("WSA_NOT_INSTALLED::未检测到 WSA（Windows Subsystem for Android），请先安装".into());
    }
    // 走到这里说明「连不上」。若设备侧停在 `unauthorized`，就是那个著名的授权死锁现场 ——
    // WSA 宿主的授权弹窗只对**没见过的**公钥弹；旧公钥一旦被它记成「已处理」，用同一把再连
    // 就永远是 unauthorized 且再也不弹窗（实测日志：三轮全新握手 × 多次，全超时、零痕迹）。
    // 这里换一把全新公钥（换到应用私有目录，不碰用户自己的 .android），整个进程只换一次。
    let stuck = ADB_PORTS
        .iter()
        .any(|p| is_unauthorized(exe, &format!("127.0.0.1:{p}")));
    if stuck && !ADB_KEY_ROTATED.swap(true, Ordering::Relaxed) {
        wlog("[wsa] 设备停在 unauthorized 且迟迟不弹授权窗 —— 换一把全新 adb 公钥再试");
        if use_private_adb_home() {
            let _ = output_of(exe, &["kill-server".to_string()]);
            if let Some(adb) = connect_waiting_auth(exe, auth_deadline) {
                if show_settings {
                    close_wsa_settings();
                }
                return Ok(adb);
            }
            wlog("[wsa] 换钥后仍未授权（用户需在弹窗里点「允许」）");
        }
    }
    eprintln!("[wsa] adb 未连上，拉起 WSA 并等待启动 …");
    let t0 = Instant::now();
    if show_settings {
        let t1 = Instant::now();
        launch_wsa_settings();
        // 首次启动 WSA 会弹「可选诊断数据」说明框，正好压在设置窗口前面 —— 先替用户点掉
        // （只点「继续」，不勾那个复选框），否则下面的开关会被它挡着点不到。
        // 它一辈子只弹一次，所以最多等 4 秒；没弹就直接往下走，不拖流程。
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(500));
            if dismiss_first_run_dialog() {
                break;
            }
        }
        // 把「开发人员模式」打开 —— adb 端口 58526 只有开了它才监听。
        // 开关成不成都会当场把设置窗口收掉（`enable_developer_mode` 末尾那处）。
        if enable_developer_mode() {
            eprintln!("[wsa] 已自动打开「开发人员模式」并收起设置窗口");
        } else {
            eprintln!("[wsa] 没能自动操作「开发人员模式」开关，请在弹出的设置窗口里手动打开");
        }
        // 耗时一律走 wlog：release 下没有控制台，用户「觉得安装很慢」时只能靠日志里的这几行定位
        wlog(&format!("[wsa][计时] 设置窗口自动化：{:.1}s", t1.elapsed().as_secs_f32()));
    }
    // 设置窗口只是 UI，它自己**不会**把子系统拉起来（实测：窗口开着、开关也报了成功，端口照样
    // 不监听）—— 所以这里要显式拉。但 WSA 已经在跑（安装流程提前拉的）就别再拉一次，
    // `WsaClient.exe` 虽然只是激活已有实例，白跑一趟也没意义。
    // 注意：Win10 上虚拟机进程名是 `Vmmem`、不是 `vmmemWSA`，所以 `vm_running()` 在 Win10 上
    // **恒为 false**、这里每次都白拉一次 —— 先把它的返回值记下来，别让这个假信号把诊断带偏。
    wlog(&format!("[wsa] vm_running={}（Win10 上该值不可信）", vm_running()));
    if !vm_running() {
        launch_wsa();
    }
    // 相机 / 麦克风 / 位置那类**宿主侧隐私弹窗**在这时候冒出来 —— 但已经不会弹了：启动 WSA
    // 之前 [`pre_allow_host_capabilities`] 就把三个能力的结论预先写成「允许」了，Windows
    // 一看已有结论就直接放行。万一还有别的弹窗（时机不定，压不住），这里只把时间留出来，
    // 交回用户。这段等待与冷启动**重叠** —— 冷启动本来就要几十秒才连得上 adb，
    // 这里边等边轮询，连上就提前结束，不空等。
    eprintln!(
        "[wsa] 正在启动 WSA，最多等 {} 秒，连上就继续 …",
        WSA_FIRST_RUN_GRACE.as_secs()
    );
    // 顺带把「这一轮有没有问到 adb」记下来：问到就说明开发者模式本来就开着，后面不用再碰
    // 设置窗口（也顺手把可能残留的面板收起）。
    let t_grace = Instant::now();
    let mut early = None;
    let grace = Instant::now() + WSA_FIRST_RUN_GRACE;
    while Instant::now() < grace {
        if let Some(adb) = connect_waiting_auth(exe, auth_deadline) {
            early = Some(adb);
            break;
        }
        std::thread::sleep(WSA_POLL);
    }
    wlog(&format!(
        "[wsa][计时] 首启等待：{:.1}s（adb {}；累计 {:.1}s）",
        t_grace.elapsed().as_secs_f32(),
        if early.is_some() { "已连上" } else { "尚未连上" },
        t0.elapsed().as_secs_f32()
    ));
    if show_settings && early.is_some() {
        // 面板（刚打开但现在已多余 / 上一轮超时留下的）既然 adb 通了就顺手收起，别一直挂桌面上。
        // 只在这条会自己开面板的路上收；录屏那条路（`show_settings == false`）从不碰它，
        // 免得把用户自己打开的设置窗口关掉。
        close_wsa_settings();
    }
    // 上面那一轮已经问到 adb 了就别再白连一次（一次 `connect` 实测要 ~2 秒）
    if let Some(adb) = early.take() {
        let booted = boot_completed(&adb);
        wlog(&format!(
            "[wsa] 首启等待窗口内已连上 adb，sys.boot_completed={booted}"
        ));
        if booted {
            if show_settings {
                close_wsa_settings();
            }
            return Ok(adb);
        }
    }
    let deadline = Instant::now() + WSA_BOOT_BUDGET;
    let t2 = Instant::now();
    let mut logged_boot = false;
    while Instant::now() < deadline {
        std::thread::sleep(WSA_POLL);
        if let Some(adb) = connect_waiting_auth(exe, auth_deadline) {
            let booted = boot_completed(&adb);
            if !logged_boot {
                logged_boot = true;
                // 只记一次，避免每秒刷屏：这个值是"adb 都通了却仍判失败"的关键线索
                wlog(&format!(
                    "[wsa] adb 已可用，sys.boot_completed={booted}（启动预算 {}s）",
                    WSA_BOOT_BUDGET.as_secs()
                ));
            }
            if booted {
                wlog(&format!("[wsa][计时] 等 WSA 启动完成：{:.1}s", t2.elapsed().as_secs_f32()));
                // 设置窗口的使命（代开开关）已经完成，收起它再交差 —— 别把面板留在桌面上
                if show_settings {
                    close_wsa_settings();
                }
                return Ok(adb);
            }
        }
        // 授权预算已尽、设备还卡在 `unauthorized` → **立刻失败**，不必再陪跑冷启动预算。
        // 这一条正是「点录制后一直卡住没反应」的止血点：冷启动预算还有近 3 分钟，
        // 但既然授权窗口一整个预算都没人点，剩下这些秒数只是让用户干等。
        if Instant::now() >= auth_deadline
            && ADB_PORTS
                .iter()
                .any(|p| is_unauthorized(exe, &format!("127.0.0.1:{p}")))
        {
            wlog("[wsa] 授权等待预算用尽且设备仍未授权 → 立即失败，不再等冷启动预算");
            return Err(err_adb_unauthorized());
        }
    }
    // 分流：`unauthorized` 说明 adb 端口是通的（=「开发人员模式」早就开了），卡的是设备侧
    // 授权。这时候再摆设置窗口、让人去开「开发人员模式」是彻底指错方向（实测踩过这个坑）。
    wlog("[wsa] 等待预算用尽，判定失败原因");
    let unauthorized = ADB_PORTS
        .iter()
        .any(|p| is_unauthorized(exe, &format!("127.0.0.1:{p}")));
    if unauthorized {
        wlog("[wsa] 判定：端口在监听但设备未授权（与「开发人员模式」无关）");
        return Err(err_adb_unauthorized());
    }
    // 等不到就把设置窗口摆出来：多半是「开发人员模式」没开，用户点一下开关就能救活
    wlog("[wsa] 判定：adb 端口未监听（多半是「开发人员模式」未开）");
    launch_wsa_settings();
    Err("ADB_CONNECT_FAILED::连不上 WSA（等待启动超时）。已为你打开 WSA 的设置窗口：请在左侧「高级设置」里把「开发人员模式」打开 —— adb 端口 58526 只有开了它才监听。若 WSA 自己都打不开，请回到「完整录屏」卡片点「首次使用点击安装插件」修复".into())
}

/// 设备未授权时的统一错误串（几处出口共用，免得文案各自漂移）。
/// 带上日志路径：这条错误几乎必然要用户把日志发回来，路径直接写给他省一轮来回。
fn err_adb_unauthorized() -> String {
    let log = log_file()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "（日志目录取不到，见安装面板提示）".into());
    format!(
        "ADB_UNAUTHORIZED::已连上 WSA 的 adb 端口，但设备侧始终未授权。\
         请在 WSA 弹出的「是否允许 ADB 调试？」窗口点「允许」（建议勾上「始终允许从此计算机」）；\
         若窗口一直不出现、或点完仍无效，请重启 WSA 再试一次。\
         详细过程见日志：{log}"
    )
}

// ==================== 进房 / 窗口 ====================

/// 两阶段进房（原型 launch_room.ps1 验证：先冷启主界面，再 DeepLink 到直播间）。
/// 调用前应已 `force-stop` 过 APP —— 早挂 overlay 的线程要确保不会抓到上一个实例的残留窗口。
///
/// 两段都不再死等固定时长：`am start -W` 本身就会阻塞到 Activity 真正启动，之后只轮询
/// `dumpsys` 拿一个**信号**（主界面已就绪 / 前台已从主界面切走 = 直播间接手），
/// 信号一到就只补一小段渲染静置时间。信号拿不到时退回等满预算 —— 即原来的行为。
fn enter_room(adb: &Adb, room_id: i64) -> Result<(), String> {
    // 录制期间不能息屏：Android 一旦息屏 WGC 就只能拿到静止画面
    let _ = adb.shell("svc power stayon true");
    let _ = adb.shell("settings put global stay_on_while_plugged_in 7");
    let _ = adb.shell("input keyevent KEYCODE_WAKEUP");

    adb.shell(&format!("am start -W -n {MAIN_ACTIVITY}"))
        .map_err(|e| format!("DEEPLINK_FAILED::启动 B 站 APP 失败: {e}"))?;
    wait_until_with_grace(WAIT_MAIN, || resumed_activity(adb).is_some(), "B 站 APP 主界面起来");
    std::thread::sleep(SETTLE_MAIN);
    let main = resumed_activity(adb);

    adb.shell(&format!(
        "am start -a android.intent.action.VIEW -d bilibili://live/{room_id}"
    ))
    .map_err(|e| format!("DEEPLINK_FAILED::进入直播间失败: {e}"))?;
    // 直播间接手后前台 Activity 不再是冷启那一个；等到这个变化就算进房完成
    wait_until_with_grace(
        WAIT_ROOM,
        || match (resumed_activity(adb), main.as_deref()) {
            (Some(now), Some(before)) => now != before,
            _ => false,
        },
        "直播间接手",
    );
    std::thread::sleep(SETTLE_ROOM);
    Ok(())
}

/// 当前 B 站 APP 窗口。找法见 [`recorder::find_wsa_window`]：按 class 找可见且客户区最大的那个
/// （标题会随直播间变，不能按标题找）。
pub fn current_window() -> Option<HWND> {
    recorder::find_wsa_window().filter(|h| !recorder::is_unusable(*h))
}

/// 当前 B 站 APP 窗口的裸句柄（`isize`）。给 `recorder::start` 用——`HWND` 不是 `Send`，
/// 传裸值可以照常塞进 `spawn_blocking`。不滤 `is_unusable`：窗口被最小化时采集侧自己会进
/// paused 态等待，这里只需给出本体。找不到窗口返回 `None`。
pub fn current_window_raw() -> Option<isize> {
    recorder::find_wsa_window().map(|h| h.0 as isize)
}

fn wait_window() -> Result<HWND, String> {
    let deadline = Instant::now() + WINDOW_BUDGET;
    loop {
        if let Some(h) = current_window() {
            return Ok(h);
        }
        if Instant::now() >= deadline {
            return Err("WINDOW_NOT_FOUND::找不到 B 站 APP 窗口（WSA 可能没正常显示）".into());
        }
        std::thread::sleep(WINDOW_POLL);
    }
}

/// 把窗口客户区钉到 `want_w × want_h`。`SetWindowPos` 后尺寸要过一会儿才落定，故复核最多三轮。
/// 冷启动期间窗口一直是 WSA 的默认横屏尺寸，必须钉成竖屏后才好挂 overlay。
fn fit_window(hwnd: HWND, want_w: i32, want_h: i32) -> Result<(), String> {
    recorder::harden_window(hwnd, want_w, want_h)?;
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(300));
        let (w, h) = recorder::client_size(hwnd);
        if w == want_w && h == want_h {
            return Ok(());
        }
        recorder::harden_window(hwnd, want_w, want_h)?;
    }
    let (w, h) = recorder::client_size(hwnd);
    if w == want_w && h == want_h {
        Ok(())
    } else {
        Err(format!(
            "CAPTURE_INIT_FAILED::窗口定型失败（期望 {want_w}x{want_h}，实际 {w}x{h}）"
        ))
    }
}

/// 按显示器定窗口尺寸，并把 Android 密度按同一比例写进去。
///
/// 尺寸由 [`recorder::fit_geometry`] 现算：**整窗高度占所在显示器可用区的 90%**，宽度按
/// 标定比例（1800:900 = 18:9）反算。参考几何（900×1858px = 450×929dp）只有物理高度 ≥1900
/// 的显示器才装得下，100% 缩放的 1080p 屏装不下（窗口下沿会跑到屏幕外）。现在拆成
/// 「等比缩小 + 密度同步下调」，dp 尺寸不变 —— 版式与礼物动画和标定时一致，只是分辨率变化。
/// 密度写进 Android 是全局生效的，下次换显示器会被 `fit_geometry` 按新屏幕重算，不必手动复位。
fn fit_to_monitor(hwnd: HWND, adb: &Adb) -> Result<(), String> {
    let g = recorder::fit_geometry(hwnd);
    // 先落全局密度：overlay 与录制的「顶栏高度」都按它换算（`recorder::bar_h()`）
    recorder::set_density(g.density);
    wlog(&format!(
        "[几何] 定型目标：客户区 {}x{}，Android 密度 {}（参考 {}x{}@{}；整窗高按可用区 90%，宽度按 18:9 反算）",
        g.client_w,
        g.client_h,
        g.density,
        recorder::REF_CLIENT_W,
        recorder::REF_CLIENT_H,
        recorder::REF_DENSITY
    ));
    // 密度得真的写进 Android：写不进去（旧版 WSA / 权限不足）画面就会按原密度排版，
    // 与窗口尺寸对不上，所以把实测值记下来 —— 别让日志和实际状态对不上号。
    if let Err(e) = adb.shell(&format!("wm density {}", g.density)) {
        wlog(&format!("[几何] 写 wm density 失败：{e}"));
    }
    fit_window(hwnd, g.client_w, g.client_h)
}

// ==================== 对外流程 ====================

/// 完整启动流程（阻塞，调用方放 `spawn_blocking` 里）：连 WSA → 清掉旧实例 → 两阶段进房
/// → 找窗口 → 定型成竖屏 → 打 overlay。成功后进入「监听中」。
pub fn bring_up(exe: PathBuf, room_id: i64) -> Result<(), String> {
    if is_active() {
        return Err("DEEPLINK_FAILED::已有监听会话在进行中".into());
    }
    bring_up_session(exe, room_id)
}

fn bring_up_session(exe: PathBuf, room_id: i64) -> Result<(), String> {
    let adb = ensure_wsa(&exe, false)?;

    // WSA 已经跑起来了，这一问是**权威**的：APP 不在就别再走后面的「两阶段进房 → 等窗口」，
    // 那要白等一分钟，最后只报一句含糊的「找不到 B 站 APP 窗口」，还看不出该怎么修。
    if has_package(&adb, PACKAGE) == Some(false) {
        return Err(
            "APK_NOT_INSTALLED::WSA 里没有 B 站 APP（可能被手动卸载了）。请回到「完整录屏」卡片点击「首次使用点击安装插件」重新安装"
                .to_string(),
        );
    }

    // 先把可能还开着的旧实例清掉
    let _ = adb.shell(&format!("am force-stop {PACKAGE}"));

    enter_room(&adb, room_id)?;
    let hwnd = wait_window()?;
    // 先把窗口缩放/定型好再挂 overlay：冷启动期间窗口是默认横屏大小，
    // 若在定型前就挂，overlay 会贴在错的尺寸上，还得等位置同步慢慢追
    fit_to_monitor(hwnd, &adb)?;
    // 把「窗口 / 显示器 / Android 显示配置」的实测值记进日志：窗口是不是装不下、
    // 裁掉的 58px 是不是正好等于 Android 状态栏，全靠这几行判断（release 看不到 stderr）。
    wlog_geometry(hwnd, &adb);
    // 冷启动刚结束时 B 站窗口还是失活状态，此时挂上去的 overlay 不会立刻显示
    // （要手动点一下窗口激活它才冒出来）—— 先把窗口拉到前台，再挂 overlay
    recorder::activate_window(hwnd);
    if let Err(e) = crate::overlay::show(hwnd) {
        // 失败不算致命（只是少一条状态栏），录制链路照常
        eprintln!("[overlay] 显示失败（不影响录制）: {e}");
    }
    let (w, h) = recorder::client_size(hwnd);
    eprintln!(
        "[wsa] 窗口就绪 {w}x{h}（录 {w}x{}，密度 {}）",
        h - recorder::bar_h(),
        recorder::density()
    );

    *ACTIVE
        .lock()
        .map_err(|_| "ADB_CONNECT_FAILED::会话状态锁异常".to_string())? = Some(adb);
    Ok(())
}

/// 停止监听：关 B 站 APP → 关 WSA → 清会话。
pub fn shutdown() {
    let adb = ACTIVE.lock().ok().and_then(|mut g| g.take());
    if let Some(adb) = &adb {
        let _ = adb.shell(&format!("am force-stop {PACKAGE}"));
    }
    shutdown_wsa();
}

/// 关 WSA：优先 `WsaClient.exe /shutdown`（包内注册的 AppExecutionAlias）；
/// 20 秒内没退再强杀兜底（避免"点了停止但 WSA 还开着"）。
fn shutdown_wsa() {
    let Some(alias) = wsa_client_exe() else {
        return;
    };
    let _ = Command::new(&alias)
        .arg("/shutdown")
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    // 等子系统真的下去。光看 `WsaClient.exe` 不够 —— WSA 正常运行时它常常并不在场，
    // 得再等虚拟机进程 `vmmemWSA` 消失，否则「停止监听」之后它还在后台跑着。
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !process_running("WsaClient.exe") && !vm_running() {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("[wsa] WsaClient 未响应 /shutdown，改为强杀");
    let _ = Command::new("taskkill")
        .args(["/IM", "WsaClient.exe", "/F"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .status();
}

/// WSA 的子系统虚拟机在不在跑。`vmmemWSA` 是 Hyper-V 给 WSA 起的虚拟机进程 ——
/// 用它判断「子系统起没起 / 停没停干净」，比看 `WsaClient.exe` 可靠（后者正常运行时常不在场）。
fn vm_running() -> bool {
    process_running("vmmemWSA")
}

fn process_running(name: &str) -> bool {
    output_of(
        Path::new("tasklist"),
        &[
            "/FI".to_string(),
            format!("IMAGENAME eq {name}"),
            "/NH".to_string(),
        ],
    )
    .map(|o| {
        let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
        text.contains(&name.to_lowercase())
    })
    .unwrap_or(false)
}