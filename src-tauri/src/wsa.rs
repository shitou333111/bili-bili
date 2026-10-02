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
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::SystemInformation::GetLocalTime;
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
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SetCursorPos, SetForegroundWindow,
    WM_CLOSE,
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
/// 等**设备侧 adb 授权**（WSA 弹出的「是否允许 ADB 调试？」）时的轮询间隔。
///
/// 实测（Win10）：这个弹窗要等 Android 的**系统 UI 就绪**才渲染得出来，约 1~2 分钟；
/// 而 adb 端口早在第 7 秒就监听了 —— 所以只能**耐心等**，见 [`wait_for_adb_auth`]。
///
/// 为什么是 500ms 而不是 1s：弹窗**在场的时间很短**（实测两次弹出都没撞进轮询窗口）。
/// 原来 [`accept_adb_auth`] 每轮要对全部顶层窗口做全量 UIA 后代扫描，单轮被拖到 2.5s+
/// （日志里补发间隔 17~18s > 目标 15s 就是这么来的），比弹窗存活还长，必然次次错过。
/// 扫描改成「先 Win32 廉价挑候选、再 UIA 定向查」之后单轮降到毫秒级，才能压到亚秒。
const ADB_AUTH_POLL: Duration = Duration::from_millis(500);
/// **单次 `ensure_wsa` 的授权等待总预算**，按场景给：安装/修复（会摆设置窗口、可能整台冷启动）
/// 给足；点「开始录制」只给一点点 —— 那一刻用户正等着窗口弹出来，不该为授权干等。
///
/// 为什么必须封顶：以前 `wait_for_adb_auth` 内部是「3 轮 × 30s」的嵌套循环，而 `ensure_wsa`
/// 的两个轮询循环**每秒**都会调进来一次 —— 单次 `ensure_wsa` 能拖到 5 分钟以上
/// （实测反馈「点录制后一直卡住没响应」就是这个）。预算花完后授权等待降级成
/// 「一次应答 + 复查」（几乎不花时间）；若那时设备仍卡在 `unauthorized`，直接报错
/// （见 `ensure_wsa` 里的提前失败分支）。
///
/// 注意这个预算是**从「等到起点」重新锚定**的（见 [`wait_for_adb_auth`] 开头）：
/// 弹窗渲染延迟从「设备进入 unauthorized」起算，实测最慢 89s（第 4 次测试），
/// 加上「点击失败 → 补发重弹」一轮约 10s 和余量 → 150s。原来锚在 `ensure` 入口，
/// 冷启动吃掉 106s 后只剩 29s（第 3 次测试），数学上必然超时。
const ADB_AUTH_BUDGET_SETUP: Duration = Duration::from_secs(150);
const ADB_AUTH_BUDGET_RECORD: Duration = Duration::from_secs(12);
/// **点掉一次授权框之后的宽限期**（见 [`wait_for_adb_auth`]）。
///
/// 实测（Win10）：授权框常在握手后 60~104 秒才渲染出来，而总预算刚好在「点掉弹窗后 1 秒」
/// 到期 —— 我们判了失败，设备侧却还在把这次「允许」落定，于是「点了确认仍连不上」。
/// 所以每成功点掉一次弹窗，就把 deadline 往后推这么久；最多推 3 次（弹两次是常态，
/// 见下面的循环），推的过程中一旦 `adb_usable` 立刻返回。
const ADB_AUTH_GRACE: Duration = Duration::from_secs(30);
/// **重发授权握手的间隔**（见 [`wait_for_adb_auth`]）。
///
/// 首次握手是「adb 端口一开就发」的，而端口在 WSA 启动 ~11s 就监听了 —— 那时安卓的提示服务
/// （`system_server` 里的 AdbDebuggingManager）常常还没起来，设备侧会把这个请求**直接丢掉**，
/// 且 adb 不会为同一条已存在的连接重新协商（`adb connect` 只回 already connected）。于是
/// 「等多久都不弹框」—— 实测 3 次连续失败里窗口快照从头到尾没有授权框，而成功的几次都是
/// 端口晚些才开。解法不是等更久，是**按节奏把那个被丢掉的请求补发一次**。
const ADB_AUTH_REARM: Duration = Duration::from_secs(15);
/// **整台重启 WSA** 之后，等设备侧重新授权 / 重新起来的预算（只走一次，且只在安装 / 修复
/// 路径上 —— 见 [`restart_wsa_and_reconnect`]）。
///
/// 90 → 150：实测两次重启后的等待窗都恰好只有 81s（90s 减去 shutdown+launch 的 ~22s 再被
/// 首次 observed unauthorized 吃掉 9s），零弹窗超时；而重启前那次冷启动的弹窗渲染花了 89s。
/// 81 < 89，第二次机会天然比第一次短 —— 必须给足与冷启动同级的预算，并同样从等待起点锚定。
const WSA_RESTART_AUTH: Duration = Duration::from_secs(150);
const WSA_RESTART_BOOT: Duration = Duration::from_secs(150);
/// 等窗口出现的预算（进房后 Android 顶层窗口可能还要几秒才可见）
const WINDOW_BUDGET: Duration = Duration::from_secs(30);
/// 等窗口出现的轮询间隔
const WINDOW_POLL: Duration = Duration::from_millis(200);
/// 「进直播间**之前**定型」这一步愿意为主界面窗口等多久。
///
/// 主界面（`MainActivityV2`）起来了，它的窗口通常同时就有；只有 WSA 刚整台冷启、
/// APP 首次加载很慢时才会拖到十几秒（实测那一次超过了 10 秒）。
/// 所以这里直接给足 [`WINDOW_BUDGET`] —— 等的是**同一个窗口**，只是把「等」提前到
/// DeepLink 之前，成功路径上不多花一秒；而退到「先进房再定型」是要付出黑屏重载代价的。
const PRE_FIT_BUDGET: Duration = WINDOW_BUDGET;
/// 定型（改窗口尺寸）后、发 DeepLink 前等 APP 消化这次 Android 配置变更的时间
const CONFIG_SETTLE: Duration = Duration::from_millis(2500);
/// 「静音守护线程」的轮询间隔（见 [`start_mute_guard`]）。
///
/// 录屏是纯视频、默认**全程静音**，所以从拉起 APP 之前就要盯住音频会话：会话一露头
/// （这时往往还在缓冲、根本没出声）就静音。50ms 是「人耳听不出来」与「不白烧 CPU」
/// 的折中 —— 会话重建到被重新静音之间最多漏 50ms 的音频。
const MUTE_POLL: Duration = Duration::from_millis(50);

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

/// 记一条诊断日志：**追加写文件**（release 可见）+ 同时打 stderr（dev 可见），
/// 行首带本地时间 `[HH:MM:SS.mmm]`。
///
/// 为什么要时间戳：日志是**多线程**写进去的（进房、静音守护、安装流程各写各的），
/// 行与行之间没有先后保证。实测「打开直播间先出声、过几秒才静音」这类**时机**问题，
/// 没有时间戳就分不清某条 `[音频]` 到底发生在拉活 APP 之前还是之后 —— 只能来回猜。
pub(crate) fn wlog(msg: &str) {
    let ts = local_stamp();
    eprintln!("[{ts}] {msg}");
    let Some(path) = log_file() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = std::io::Write::write_all(&mut f, format!("[{ts}] {msg}\n").as_bytes());
    }
}

/// 本地时间 `HH:MM:SS.mmm`（`GetLocalTime` 直接给本地时区，不用自己算偏移）
fn local_stamp() -> String {
    let st = unsafe { GetLocalTime() };
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
    )
}

/// 在面向用户的流程入口（`setup::install`）打一条「新一轮」分隔线。**不清空**旧内容，
/// 只顺手清掉一次性的诊断额度。
///
/// 首行必写「原生包日期戳 + exe 路径」：release 下我们看不到任何控制台输出，而
/// "日志没生成" 最常见的两个原因就是「跑的不是这份二进制」和「文件在别的目录」——
/// 把这两件事写进第一行，一眼就能排除。
///
/// **为什么不再清空**：清空会把「同一进程里更早那次尝试」的证据整段抹掉。实测吃过这个亏 ——
/// 用户点「录屏」失败（那一轮才换过密钥、才 dump 过窗口），再点「安装/修复」时日志被清，
/// 于是剩下这轮里孤零零一句 `本进程是否已换过密钥=true` 却找不到对应的换钥记录，现场直接断线。
pub(crate) fn wlog_reset() {
    let path = log_file();
    if let Some(p) = &path {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // 只在文件过大时截断，避免长跑之后无限增长
        const MAX_LEN: u64 = 4 * 1024 * 1024;
        if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) > MAX_LEN {
            let _ = std::fs::write(p, "");
        }
    }
    // 顶层窗口 dump 也按「新一轮」重新给额度：上一轮用光后，这一轮就再也看不到窗口快照了
    AUTH_DUMPED.store(0, Ordering::Relaxed);
    // 两个「只做一次」的自救标志同样复位：用户点一次「安装/修复」就是在要求重新自愈一轮。
    // 不复位的话，第一次失败后后续几次点安装都变成空跑（实测用户会连点好几次）。
    ADB_KEY_ROTATED.store(false, Ordering::Relaxed);
    WSA_RESTARTED.store(false, Ordering::Relaxed);
    // 授权框识别的「出现 / 消失 / 认不出 / UIA 失败 / 在场」标记同样按新一轮复位，
    // 否则新一轮弹出的框不再打「出现」日志，UIA 失败也一条都出不来（日志只截断不清空）。
    AUTH_DLG_SEEN.store(0, Ordering::Relaxed);
    UNMATCHED_LOGGED.store(0, Ordering::Relaxed);
    UIA_FAIL_LOGGED.store(0, Ordering::Relaxed);
    DIALOG_ON_DESK.store(false, Ordering::Relaxed);
    // 说明框标记按新一轮复位：重装 WSA 会重置它的一次性状态，说明框可能再弹一次；
    // 探测日志游标也要清 —— 否则新一轮的头几条探测会被当成「结论没变」吞掉，
    // 日志里只剩一条 banner、看不出到底有没有开始连。
    FIRST_RUN_DIALOG_GONE.store(false, Ordering::Relaxed);
    if let Ok(mut g) = ADB_PROBE_LAST.lock() {
        g.clear();
    }
    // 说明框诊断日志游标同理：新一轮的头一条结论必须能打出来。
    if let Ok(mut p) = FIRST_RUN_PROBE.lock() {
        p.0.clear();
        p.1 = 0;
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
    wlog("[wsa] 本机未找到 adb，开始下载 platform-tools …");
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

/// **换一把全新密钥**：切到私有 adb 用户目录（见 [`adb_home_dir`]）并删掉里面已有的密钥文件。
///
/// 删文件是必要的：光切目录，adb 第二次还是接着用同一把密钥，等于白换。整个进程内由
/// [`ADB_KEY_ROTATED`] 保证只换一次（每轮安装会复位它，见 [`wlog_reset`]）。
fn use_private_adb_home() -> bool {
    let Some(dir) = adb_home_dir() else {
        // 不留静默分支：这条路一旦悄悄失败，日志里就会出现「已换过密钥=true」却没有换钥记录，
        // 现场直接断线（实测吃过这个亏）。
        wlog("[adb] 取不到 %APPDATA%，无法改用私有密钥目录");
        return false;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        wlog(&format!("[adb] 建私有密钥目录 {} 失败：{e}", dir.display()));
        return false;
    }
    // 删掉旧密钥 → adb 下次调用时会现场生成一把全新的
    for name in ["adbkey", "adbkey.pub"] {
        let f = dir.join(name);
        if f.exists() {
            let _ = std::fs::remove_file(&f);
            wlog(&format!("[adb] 已删除旧密钥 {}", f.display()));
        }
    }
    if let Ok(mut g) = ADB_HOME.lock() {
        *g = Some(dir.clone());
    }
    wlog(&format!(
        "[adb] 已改用私有密钥目录 {} 并将生成全新密钥（不碰用户自己的 .android）",
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
/// 找不到弹窗（没在授权中 / 早就授权过）就返回 `false`。
///
/// **先便宜后贵**（实测根因之一）：老实现对**全部**顶层窗口各做一次 UIA 全量后代扫描，
/// 单轮要 1 秒多 —— 加上补发握手的开销，轮询周期被拖到 2.5s+（日志里补发间隔 17~18s >
/// 目标 15s 就是证据），比弹窗存活时间还长，两次弹窗**次次错过**（6 次 30s 窗口快照
/// 也全没拍到 `#32770`）。现在先用 [`collect_auth_candidates`] 用 Win32 廉价挑候选
/// （可见 + 标准对话框 / 标题带 adb，毫秒级），只对候选做 UIA 定向扫描，
/// 一个候选都没有就直接返回。
///
/// **认不出必须留痕**（实测根因之二）：老实现在 `matched=false` 时是**静默** `continue`，
/// 「弹窗不在场」和「弹窗在、只是认不出来」在日志里完全分不开 —— 现场就是一片空白。
/// 现在：认到对话框但判据不过 → 按窗口句柄**只打一次**、附后代元素名样本；
/// 判据过了 → [`mark_auth_dialog_present`] 打「出现」边沿；关掉了 → [`auth_dialog_gone`]
/// 打「消失」边沿 —— 两条边沿之间若没有「已自动应答」记录，就坐实了「没被点、自己关了」。
///
/// **判据两条**：① 字面 `ADB` / `RSA`（各语言界面都不翻译，标题和后代都看）；
/// ② **结构签名** —— 标准对话框里同时有「允许」和「拒绝」按钮对。授权框措辞再怎么随
/// 系统语言 / Android 版本变，这个按钮对变不掉；实测两次弹窗都栽在字面判据没赶上。
/// 两条都过、且拿到「允许」按钮才动手（[`bring_to_front`] 切不到前台就不点）。
fn accept_adb_auth() -> bool {
    // ① 廉价候选（Win32 枚举，毫秒级）。顺手记下「桌面上有没有对话框在场」，
    // 供 [`wait_for_adb_auth`] 决定要不要补发握手 —— `disconnect` 会把在场的弹窗掐掉。
    let candidates = unsafe { collect_auth_candidates() };
    DIALOG_ON_DESK.store(!candidates.is_empty(), Ordering::Relaxed);
    // 之前认到的那个框若已经关掉，在这里打「消失」边沿（每次只花一次 IsWindowVisible）。
    let _ = auth_dialog_gone();
    if candidates.is_empty() {
        return false;
    }
    unsafe {
        // UI Automation 要求调用线程初始化过 COM。重复初始化、或本线程已是别的套间模型
        // （返回 RPC_E_CHANGED_MODE）都无所谓，能用就行，故不理返回值。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(uia) =
            CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        else {
            note_uia_failure("CoCreateInstance(CUIAutomation)");
            return false;
        };
        let Ok(cond) = uia.CreateTrueCondition() else {
            note_uia_failure("CreateTrueCondition");
            return false;
        };
        for (hwnd, class, title) in candidates {
            let Ok(top) = uia.ElementFromHandle(hwnd) else {
                continue;
            };
            let title_has_adb = title.to_lowercase().contains("adb");
            let Ok(kids) = top.FindAll(TreeScope_Descendants, &cond) else {
                continue;
            };
            let (mut checkbox, mut allow) = (None, None);
            let (mut desc_has_adb, mut desc_has_rsa, mut allow_is_strict, mut has_deny) =
                (false, false, false, false);
            // 认不出时的**证据**：前几个非空后代元素名。没有它，「认法不匹配」永远只能靠猜。
            let mut samples: Vec<String> = Vec::new();
            for k in 0..kids.Length().unwrap_or(0) {
                let Ok(el) = kids.GetElement(k) else { continue };
                let name = el.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                if !name.trim().is_empty() && samples.len() < 6 {
                    samples.push(name.chars().take(30).collect());
                }
                let low = name.to_lowercase();
                // **各判据独立判断，不再用 else-if**：老写法里 `low.contains("adb")` 一旦命中
                // 就吞掉后续分支（一个元素只能归一类），按钮识别可能整轮被跳过。
                if low.contains("adb") {
                    desc_has_adb = true;
                }
                if low.contains("rsa") {
                    // 正文写着「本计算机的 RSA 密钥指纹是 …」——`RSA` 各语言界面都不翻译。
                    desc_has_rsa = true;
                }
                if low.contains("始终允许") || low.contains("always allow") {
                    checkbox = el.CurrentBoundingRectangle().ok();
                }
                if is_allow_label(&name) {
                    allow = el.CurrentBoundingRectangle().ok();
                    allow_is_strict = true;
                }
                if is_deny_label(&name) {
                    has_deny = true;
                }
            }
            let matched = title_has_adb
                || desc_has_adb
                || desc_has_rsa
                || (class == "#32770" && allow_is_strict && has_deny);
            if !matched {
                // 按窗口句柄只打一次（500ms 一轮，不设限会刷屏）；关掉再弹新窗口还会再打。
                let h = hwnd.0 as isize;
                if UNMATCHED_LOGGED.swap(h, Ordering::Relaxed) != h {
                    wlog(&format!(
                        "[wsa] 认到对话框 {class} | {title} 但认不出是 adb 授权框（后代元素样本：{}）",
                        if samples.is_empty() {
                            "（无）".to_string()
                        } else {
                            samples.join(" / ")
                        }
                    ));
                }
                continue;
            }
            mark_auth_dialog_present(hwnd, &format!("{class} | {title}"));
            if allow.is_none() {
                wlog(&format!(
                    "[wsa] 认到 adb 授权框但没找到「允许」按钮，无法自动应答（后代元素样本：{}）",
                    samples.join(" / ")
                ));
                dump_top_windows();
                continue;
            }
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
                // 勾选那下点击可能被系统弹层（「文档」文件夹、诊断说明框）抢走前台 ——
                // 点「允许」前复查一次，被抢就抢回来；抢不回来就放弃本轮，
                // 绝不把点击落在别的窗口上（那正是「框关了但设备没授权」的一种来源）。
                if GetForegroundWindow() != hwnd && !bring_to_front(hwnd) {
                    wlog("[wsa] 勾选后授权框失去前台且抢不回来 —— 放弃本轮点击，下轮重试");
                    return false;
                }
            }
            let allow_pt = allow
                .filter(|r| r.right > r.left)
                .map(|r| (r.left + (r.right - r.left) / 2, r.top + (r.bottom - r.top) / 2));
            if let Some((x, y)) = allow_pt {
                click_at(x, y);
            }
            // 命中窗口的 `类名 | 标题` 与点击坐标一并留痕：上一轮实测里这里只写「已自动应答」
            // 却毫无效果，分辨不出点的是真授权框还是别的窗口、点在了哪 —— 有了这些下次一眼定案。
            wlog(&format!(
                "[wsa] 已自动应答 adb 授权弹窗（勾选「始终允许」+ 点「允许」）；命中窗口 {class} | {title}；\
                 点击坐标 checkbox={} allow={}",
                checkbox
                    .filter(|r| r.right > r.left)
                    .map(|r| format!("({},{})", r.left + 10, r.top + (r.bottom - r.top) / 2))
                    .unwrap_or_else(|| "（无）".into()),
                allow_pt
                    .map(|(x, y)| format!("({x},{y})"))
                    .unwrap_or_else(|| "（无）".into()),
            ));
            return true;
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

/// 「拒绝」类按钮的名字（中英）。只和「允许」成对出现才算**结构签名**（见 [`accept_adb_auth`]）。
fn is_deny_label(name: &str) -> bool {
    matches!(
        name.trim().to_lowercase().as_str(),
        "拒绝" | "否" | "deny" | "no"
    )
}

/// 上一次**认到**的授权框的原生句柄（0 = 当前不在场）。两个用途：
/// ① 打「出现 / 消失」两条**边沿**日志（500ms 一轮，不边沿化会刷屏）；
/// ② 「消失」日志上方若没有「已自动应答」记录，就坐实了「弹窗没被点、自己关了」——
/// 这正是用户现场描述「弹出来两次、没人点就消失」需要的证据链。
static AUTH_DLG_SEEN: AtomicIsize = AtomicIsize::new(0);
/// 认到对话框但**判据不过**时，上一次打过日志的窗口句柄（按窗口只打一次）。
static UNMATCHED_LOGGED: AtomicIsize = AtomicIsize::new(0);
/// UIA 初始化失败的计数（每轮安装最多打 3 条 —— 失败时它每 500ms 就会再失败一次）。
static UIA_FAIL_LOGGED: AtomicU8 = AtomicU8::new(0);
/// 桌面上**有对话框候选在场**（可见的 `#32770` / 标题带 adb，不管认没认出来）。
/// [`wait_for_adb_auth`] 据此跳过补发握手：`disconnect` 会把正等点击的弹窗掐掉 ——
/// 与 `kill-server` 同机制，是「弹窗没人点却自己消失」的直接嫌疑。
static DIALOG_ON_DESK: AtomicBool = AtomicBool::new(false);
/// 本轮 `ensure` 是否已经把授权预算**重新锚定到等待起点**（见 [`wait_for_adb_auth`]）。
/// 每轮 ensure 只锚一次：外层按秒轮询反复进等待时不会无限续期；`restart_wsa_and_reconnect`
/// 起 phase2 前复位一次，给重启后的新一轮等待一个全新锚点。
static AUTH_BUDGET_ANCHORED: AtomicBool = AtomicBool::new(false);
/// 「可选诊断数据」说明框**已经被点掉**。它一辈子只弹一次，点掉过就再也不必等它 ——
/// 实测三轮 `设置窗口自动化` 全是 6.5s：说明框不在场时，[`ensure_wsa_inner`] 那个
/// `8 × 500ms` 的等待就是纯空转 4.0 秒。boot 期点掉后置位，后面的等待直接跳过。
static FIRST_RUN_DIALOG_GONE: AtomicBool = AtomicBool::new(false);
/// adb 探测日志的**去重游标**：[`connect_inner`] 每 1~2 秒跑一趟，成功/失败各刷一条会把
/// 日志刷成瀑布（实测一轮等待 50+ 条 `连不上`，有用的行全被淹掉）。只在**结论变化**时打。
static ADB_PROBE_LAST: Mutex<String> = Mutex::new(String::new());
/// 说明框识别的诊断日志游标：`(上一条结论, 已打条数)`。
///
/// 为什么非加不可 —— 说明框**认不出来时是全静默的**：`dismiss_first_run_dialog` 在一轮安装里
/// 会被调上百次，候选窗口一个都认不到就一条日志都不落，事后只能靠授权框 dump 的窗口快照倒推
/// 根因（run1 正是如此）。这里把「候选了哪些窗口 / 签名差在哪半」按**结论变化**打出来，
/// 并把总量封顶，免得 500ms 一轮把它刷成瀑布。
static FIRST_RUN_PROBE: Mutex<(String, u8)> = Mutex::new((String::new(), 0));

/// 按「结论」打 adb 探测日志：结论不变就静默，变了才落一条（带上最后一次的具体 serial）。
fn log_probe(outcome: &str, msg: String) {
    let mut last = ADB_PROBE_LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last != outcome {
        *last = outcome.to_string();
        drop(last);
        wlog(&msg);
    }
}

/// 打一条说明框识别的诊断日志：**结论没变就不打，总量封顶**（见 [`FIRST_RUN_PROBE`]）。
///
/// 两种结论都值得留：
/// - 候选 0 个 —— 说明框还没出现，或它挂在一个「标题 / 类名都认不到」的宿主上（run1 的根因）；
/// - 有候选但签名不符 —— 说明宿主认对了，是元素签名（缺诊断开关 / 缺可用的「继续」）没对上。
fn log_first_run_probe(seen: &[String], gaps: &[String]) {
    const MAX: u8 = 6;
    let clip = |v: &[String], n: usize| -> String {
        let head: Vec<String> = v.iter().take(n).cloned().collect();
        let mut s = head.join("；");
        if v.len() > n {
            s.push_str(&format!("…（共 {} 个）", v.len()));
        }
        s
    };
    let msg = if seen.is_empty() {
        "说明框候选窗口 0 个（标题 / 类名都没认到；可能还没弹，也可能宿主换皮了）".to_string()
    } else {
        let mut s = format!(
            "说明框候选 {} 个：{}；签名不符 {} 个",
            seen.len(),
            clip(seen, 4),
            gaps.len()
        );
        if !gaps.is_empty() {
            s.push_str(&format!("（{}）", clip(gaps, 3)));
        }
        s
    };
    let mut st = FIRST_RUN_PROBE.lock().unwrap_or_else(|e| e.into_inner());
    if st.0 == msg || st.1 >= MAX {
        return;
    }
    st.0 = msg.clone();
    st.1 += 1;
    drop(st);
    wlog(&format!("[wsa][诊断] {msg}"));
}

/// 用 Win32 廉价挑出「像授权框」的顶层窗口：可见 **且**（标准对话框 `#32770` **或**
/// 标题里带 `adb`），连类名 / 标题一起返回 —— 后面匹配、日志都用这套（窗口快照
/// [`dump_top_windows`] 打的也是这两个字段，口径一致）。整个枚举毫秒级，
/// 这是「单轮从 2.5s 降到亚秒」的关键：老实现是拿 UIA 对**所有**顶层窗口做全量后代扫描。
unsafe fn collect_auth_candidates() -> Vec<(HWND, String, String)> {
    unsafe extern "system" fn hit(hwnd: HWND, lp: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut tbuf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut tbuf);
            let mut cbuf = [0u16; 256];
            let cn = GetClassNameW(hwnd, &mut cbuf);
            let title = String::from_utf16_lossy(&tbuf[..n as usize]);
            let class = String::from_utf16_lossy(&cbuf[..cn as usize]);
            if class == "#32770" || title.to_lowercase().contains("adb") {
                (*(lp.0 as *mut Vec<(HWND, String, String)>)).push((hwnd, class, title));
            }
        }
        BOOL(1)
    }
    let mut list: Vec<(HWND, String, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(hit),
            LPARAM(&mut list as *mut Vec<(HWND, String, String)> as isize),
        );
    }
    list
}

/// 登记「授权框出现了」：同句柄不重复打；句柄变了（上一个关掉、又弹了一个新的）打一次边沿。
fn mark_auth_dialog_present(hwnd: HWND, detail: &str) {
    let h = hwnd.0 as isize;
    if AUTH_DLG_SEEN.swap(h, Ordering::Relaxed) != h {
        wlog(&format!(
            "[wsa] 授权框出现在桌面上（{detail}）—— 开始自动应答"
        ));
    }
}

/// 上一次认到的授权框是否**已经关掉**：关掉了就复位在场标记并打「消失」边沿。
/// 句柄可能被系统复用给别的可见窗口，那种情况下宁可当作还在（少打一条边沿而已）。
fn auth_dialog_gone() -> bool {
    let h = AUTH_DLG_SEEN.load(Ordering::Relaxed);
    if h == 0 {
        return false;
    }
    if unsafe { IsWindowVisible(HWND(h as *mut _)) }.as_bool() {
        return false;
    }
    if AUTH_DLG_SEEN
        .compare_exchange(h, 0, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        wlog("[wsa] 授权框已从桌面消失（上方若有「已自动应答」就是我们点掉的；没有就是它没被点、自己关了）");
    }
    true
}

/// UIA 起不来时**必须留痕**：它一失败，`accept_adb_auth` 每轮都是静默 `false`，
/// 日志又会回到「一片空白、分不清病因」的老状态。每轮安装最多打 3 条防刷屏。
fn note_uia_failure(what: &str) {
    if UIA_FAIL_LOGGED.fetch_add(1, Ordering::Relaxed) < 3 {
        wlog(&format!(
            "[wsa] UI Automation 初始化失败（{what}）—— 本轮无法识别授权框"
        ));
    }
}

/// `dump_top_windows` 的次数上限（见该函数的说明）。额度每次 [`wlog_reset`] 重新给。
static AUTH_DUMPED: AtomicU8 = AtomicU8::new(0);

/// 把当前**可见顶层窗口**的 `类名 | 标题` 打一遍日志（每轮安装最多 8 次）。
///
/// 为什么需要它：`accept_adb_auth` 现在会打「出现 / 消失 / 认不出（带元素样本）」的**点状**
/// 日志，但「弹窗**从来没出现过**」这种情形依然什么都拍不到 —— 需要一份**定时的顶层窗口
/// 清单**来区分「压根没弹」和「弹了没认出来」（实测就是卡在这儿来回猜了好几轮）。
fn dump_top_windows() {
    if AUTH_DUMPED.fetch_add(1, Ordering::Relaxed) >= 8 {
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
///
/// `budget` 是「每次开始等授权」的**起算预算**：[`wait_for_adb_auth`] 首次进入时会把
/// `deadline` 重锚到 `now + budget`（每轮 ensure 只锚一次）—— 弹窗渲染延迟是从「设备进入
/// unauthorized」起算的（实测 64~89s），而不是从 ensure 入口起算；锚错会让冷启动后的等待
/// 窗只剩十几秒，数学上必然超时（第 3 次测试：入口设的 deadline 只剩 29s 就到点）。
fn connect_waiting_auth(exe: &Path, auth_deadline: &mut Instant, budget: Duration) -> Option<Adb> {
    connect_inner(exe, Some((auth_deadline, budget)))
}

fn connect_inner<'a>(exe: &Path, mut auth: Option<(&'a mut Instant, Duration)>) -> Option<Adb> {
    for port in ADB_PORTS {
        let serial = format!("127.0.0.1:{port}");
        let _ = output_of(exe, &["connect".to_string(), serial.clone()]);
        let cand = Adb {
            exe: exe.to_path_buf(),
            serial: serial.clone(),
        };
        if adb_usable(&cand) {
            log_probe("ok", format!("[adb] {serial} 已可用"));
            return Some(cand);
        }
        let unauth = is_unauthorized(exe, &serial);
        log_probe(
            if unauth { "fail:unauth" } else { "fail" },
            format!("[adb] {serial} 连不上（unauthorized={unauth}）"),
        );
        if unauth {
            if let Some((deadline, budget)) = auth.take() {
                return wait_for_adb_auth(&cand, deadline, budget);
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

/// 等设备侧完成 adb 授权（WSA 弹出的「是否允许 ADB 调试？」）。
///
/// **为什么不能"睡一下再复查一次"**：实测（Win10，DESKNEATH）——adb 端口在第 7 秒就监听了，
/// 而那个授权弹窗要等 Android 的**系统 UI 就绪**才渲染得出来，实测约 1~2 分钟。于是第一次
/// 握手必然发生在 UI 就绪**之前**，弹窗请求根本发不出来；更糟的是 adb 一旦把这个 serial 记成
/// 已连接，后续 `adb connect` 只回 `already connected to ...`、**不会重新协商**，于是
/// 「握手太早」会永久卡在 `unauthorized`，怎么等都不会自己好（实测：反复 `connect` 无效）。
/// 所以这里的做法是**保留现有那条连接，按 [`ADB_AUTH_REARM`] 的节奏补发请求**
/// （`disconnect` + `connect`，只针对这一个 serial，不碰 adb server）—— 补发会让设备侧
/// 重新走一次协商，请求就有机会落在系统就绪之后。
///
/// **绝不 `kill-server`；请求丢了只补发，不重做服务端** —— 原实现是「3 轮 × 30s，每轮开头
/// 都 kill-server」，而 `kill-server` 会把 adb server 连同它那条**正在等授权的连接**一起掐掉，
/// WSA 侧的授权框是挂在那条连接上的，于是刚弹出来就跟着消失。用户的现场描述是弹窗
/// 「闪现了一下就没了」，日志里则从头到尾看不到任何授权框 —— 正是我们自己把它点掉了。
/// 走到这个函数时 `connect_inner` 刚 `adb connect` 过、并确认设备 `unauthorized`，那条连接
/// 就是「请求正挂着」的那条，必须原样留着。
///
/// **等待期间绝不换钥**。实测（4 次换钥 4 次失败、3 次没换 3 次成功）：换钥的那次 `kill-server`
/// 会掐掉正在等授权的连接，用户点掉的「允许」记在旧钥上，新钥依旧 unauthorized。换钥只允许
/// 发生在进入等待**之前**（见 [`ensure_wsa_inner`] 的 `ADB_KEY_ROTATED` 分支）。
///
/// **点掉弹窗就往后宽限**（见 [`ADB_AUTH_GRACE`]）：弹窗要等系统 UI 就绪才渲染，常在握手后
/// 60~104 秒才出现，而预算往往在「点掉后 1 秒」就到 —— 设备侧还没来得及把授权落定。
///
/// **必须受 `deadline` 约束**：否则 `ensure_wsa` 的两个轮询循环每秒调进来一次，能把单次调用
/// 拖到五分钟以上（实测「点录制后一直卡住没反应」就是它）。预算花完就降级成
/// 「一次应答 + 复查」，几乎不花时间。
///
/// **预算从等待起点重新锚定**（第 3、4 次测试的根因之一）：deadline 原来在 `ensure` 入口
/// 就固定成一个 `Instant`，可入口到「设备真正进入 unauthorized」之间隔着整段冷启动
/// （实测 106s）—— 到开始等时只剩 29s，而弹窗渲染要 64~89s，**数学上必然超时**，
/// 白白触发一次整台重启。现在首次进入时重锚到 `now + budget`（`deadline` 是 `&mut`，
/// 重锚与宽限都回写给外层「预算用尽 → 结束冷启动 / 整台重启」的判据；每轮 ensure 只锚
/// 一次，否则外层每秒轮询会把预算无限续期 —— 那就成了加时补丁而不是修锚点）。
///
/// **点击必须闭环**（第 3、4 次测试 4 点 2 中的根因）：成功的两次点后 **0.17s** 就授权；
/// 失败的两次是「框关了、设备始终没授权」，老实现只能等 grace 30s 和 15s 补发周期碰运气
/// （实测空耗 27s 才靠重弹恢复）。现在点完立刻回读 `adb_usable`：成功就地返回；
/// 框已关还不成功 → **立即**补发握手要回新弹窗；框还在 → 下一轮用刷新坐标重点。
///
/// **每 2s 顺手排掉「可选诊断数据」说明框**：它模态压住桌面（第 3 次测试亲眼所见、
/// 没人点掉），出现时机不受启动阶段约束，而老实现只在启动期给 4 秒窗口试一次、
/// 重启路径干脆不试。放进等待循环后，冷启动与重启两条路径都被覆盖。
fn wait_for_adb_auth(cand: &Adb, deadline: &mut Instant, budget: Duration) -> Option<Adb> {
    // **预算锚点修正**：首次进入等待时重锚（取较晚值），实测依据见函数文档。
    if !AUTH_BUDGET_ANCHORED.swap(true, Ordering::Relaxed) {
        let anchored = Instant::now() + budget;
        if anchored > *deadline {
            *deadline = anchored;
            wlog(&format!(
                "[wsa] 授权预算重新锚定在等待起点（+{:.0}s；弹窗渲染延迟从设备进入 unauthorized 起算，实测最慢 89s）",
                budget.as_secs_f32()
            ));
        }
    }
    if Instant::now() >= *deadline {
        // 预算已尽：不进入等待，只顺手替用户点一下弹窗（若正好在）并复查一次。
        accept_adb_auth();
        return adb_usable(cand).then(|| cand.clone());
    }
    let total = (*deadline).saturating_duration_since(Instant::now());
    // 预算宽裕 = 安装 / 修复这条路（≥30s）。点「开始录制」那条路只给 12s，要的是快，
    // 所以下面「点掉弹窗就再宽限一会儿」只在宽裕时生效。
    let generous = total >= Duration::from_secs(30);
    // **从进入等待到结束，密钥必须一动不动。** 实测（4 次换钥 4 次失败、3 次没换 3 次成功）：
    // 换钥前那次握手会在安卓侧挂起一条「等授权的连接」，它的弹窗往往要等系统起来才渲染出来；
    // 等它终于弹出来时，`kill-server` 早把服务端换成新钥了 —— 用户点掉的「允许」记在**旧钥**
    // 上，新钥依旧 unauthorized。换钥只允许发生在进入等待**之前**（见 `ensure_wsa_inner`）。
    wlog(&format!(
        "[wsa] 设备未授权：保留现有连接等授权框（总预算 {:.0}s；每 {:.0}s 补发一次握手，绝不 kill-server）",
        total.as_secs_f32(),
        ADB_AUTH_REARM.as_secs_f32()
    ));
    // **定时给桌面拍快照**：只在「认不到弹窗时」顺手 dump 是不够的 —— 那两次额度往往在
    // 等待刚开始的一秒内就被用光，而那时弹窗根本还没渲染出来，于是最关键的中段一片空白
    // （实测就是这样：120s 等待里一条窗口快照都没有）。改成按时间点强制 dump。
    let mut next_dump = Instant::now() + Duration::from_secs(15);
    // 「点掉了弹窗」还能宽限几次 —— 见 [`ADB_AUTH_GRACE`]。
    let mut grace_left = 3u8;
    // 上一次认到（并点掉）弹窗的时刻。弹窗点完不会立刻关，下一秒轮询会再匹配到同一个窗口
    // （实测「连续弹出两次、间隔约 2 秒」就是这么来的）—— 重复点击既不该再吃掉一次宽限，
    // 也不该触发下面那次「补发握手」（那会掐掉刚被点掉的授权）。
    let mut last_click: Option<Instant> = None;
    let mut clicked = false;
    let mut next_rearm = Instant::now() + ADB_AUTH_REARM;
    // 「可选诊断数据」说明框的定期排除（2s 一次，见函数文档）。没候选时只花一次窗口枚举，
    // 有设置窗口时才做一次 UIA 定向扫 —— 对 500ms 的轮询节奏无感。
    let mut next_dismiss = Instant::now();
    while Instant::now() < *deadline {
        // ① 先排掉可能压住授权框的模态说明框（Invoke 不抢焦点；失败它自己会留痕）。
        if Instant::now() >= next_dismiss {
            next_dismiss = Instant::now() + Duration::from_secs(2);
            dismiss_first_run_dialog();
        }
        // ② 应答授权框 + **点击闭环验证**（点完立刻回读，见函数文档）。
        if accept_adb_auth() {
            clicked = true;
            let now = Instant::now();
            let repeat = last_click
                .map(|t| now.duration_since(t) < Duration::from_secs(5))
                .unwrap_or(false);
            last_click = Some(now);
            if generous && grace_left > 0 && !repeat {
                grace_left -= 1;
                // 只**放宽**、绝不缩短：宽限是在既有预算上追加的，否则点一次框反而把
                // 剩余预算砍到 30s（预算锚点修正的意义就被这一行抵消了）。
                let g = now + ADB_AUTH_GRACE;
                if g > *deadline {
                    *deadline = g;
                }
                wlog(&format!(
                    "[wsa] 已点掉授权框 —— 再宽限 {:.0}s 等设备侧把授权落定（可能还要再点一次）",
                    ADB_AUTH_GRACE.as_secs_f32()
                ));
            }
            if verify_after_click(cand) {
                wlog("[wsa] 设备已授权，adb 可用（点击后闭环验证通过）");
                return Some(cand.clone());
            }
            if unsafe { collect_auth_candidates() }.is_empty() {
                // 框关了但设备没认：点击没生效（坐标过期 / 点偏）或这条握手已废。
                // 立即补发要回新弹窗，不等 15s 周期 —— 前两次失败各空耗 27s 就耗在这一步。
                rearm_auth_handshake(cand, "点后授权框已关但设备仍未授权");
                next_rearm = Instant::now() + ADB_AUTH_REARM;
            } else {
                wlog("[wsa] 点击后授权框仍在场 —— 下一轮会用刷新后的坐标重点");
            }
        }
        // **补发那个可能被丢掉的授权请求**（见 [`ADB_AUTH_REARM`]）。只 `disconnect` 这一个
        // serial 再 `connect`，不碰 adb server，所以不会伤到别的连接、也不算「重新开始」。
        if Instant::now() >= next_rearm {
            next_rearm = Instant::now() + ADB_AUTH_REARM;
            let just_clicked = last_click
                .map(|t| t.elapsed() < ADB_AUTH_REARM)
                .unwrap_or(false);
            if DIALOG_ON_DESK.load(Ordering::Relaxed) {
                // 桌面上有对话框正等应答（本轮开头的 accept 刚刷新过这个标记，是最新的）——
                // `disconnect` 会把弹窗掐掉，和 `kill-server` 同机制，正是「弹窗没人点
                // 却自己消失」的来源。这一轮宁可不补发，等它关掉再补。
                wlog("[wsa] 桌面上有对话框在场 —— 本轮跳过补发握手（disconnect 会把弹窗掐掉）");
            } else if !just_clicked {
                rearm_auth_handshake(
                    cand,
                    "首次握手常在安卓提示服务就绪前发出，会被设备侧丢掉",
                );
            }
        }
        // 无条件复查：用户手动点过「允许」时 accept 找不到弹窗会返回 false，
        // 若写成 `accept() && usable()` 就会短路掉这条最该走通的路。
        if adb_usable(cand) {
            wlog("[wsa] 设备已授权，adb 可用");
            return Some(cand.clone());
        }
        if Instant::now() >= next_dump {
            next_dump = Instant::now() + Duration::from_secs(30);
            dump_top_windows();
        }
        std::thread::sleep(ADB_AUTH_POLL);
    }
    wlog(&format!(
        "[wsa] 等设备授权超时：adb 端口在监听，但设备侧始终未授权（{}）",
        if clicked {
            "点掉过授权框，但设备侧没认"
        } else {
            "全程没认到授权框"
        }
    ));
    None
}

/// **点击闭环验证**：点完授权框后立刻回读设备状态。实测两次成功的等待里，
/// 「点掉授权框」到 `device authorized` 只隔 **0.17s** —— 所以给 3 轮 × 500ms 足够；
/// 若 1.5s 后设备仍未授权，说明这次点击没生效（坐标过期 / 被抢前台 / 握手已废），
/// 调用方据 [`collect_auth_candidates`] 的结果决定「立即补发」还是「下轮重点」。
/// 这就是「4 点 2 中、失败那次白等 27s」的闭环修复。
fn verify_after_click(cand: &Adb) -> bool {
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(500));
        if adb_usable(cand) {
            return true;
        }
    }
    false
}

/// **补发授权握手**：只 `disconnect` 这一个 serial 再 `connect`，不碰 adb server，
/// 所以不会伤到别的连接、也不算「重新开始」。结果打进日志（原来 `let _ =` 丢弃，
/// 补发失败与否无从取证）。
fn rearm_auth_handshake(cand: &Adb, why: &str) {
    let _ = output_of(&cand.exe, &["disconnect".to_string(), cand.serial.clone()]);
    let conn = output_of(&cand.exe, &["connect".to_string(), cand.serial.clone()]);
    let receipt = match &conn {
        Ok(o) => combined(o).trim().to_string(),
        Err(e) => format!("connect 失败: {e}"),
    };
    wlog(&format!(
        "[wsa] 补发一次授权握手（{}）→ {receipt}",
        why
    ));
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
///
/// 留一行「已发起」日志：`explorer.exe` 拿到解析不了的 `shell:appsFolder\…` 时会**退化成打开
/// 默认文件夹（「文档」）**，而全仓能开出文件夹的只有这两处 `explorer` 调用。日志里紧挨着
/// 「文档」窗口冒出来的那次调用，就是它。
fn launch_wsa_shell() {
    wlog(&format!("[wsa] 经 explorer 拉起 WSA 本体：shell:appsFolder\\{WSA_SHELL_ID}"));
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
///
/// 同 [`launch_wsa_shell`]：留一行「已发起」日志，好把桌面上莫名多出来的「文档」窗口对到
/// 具体是哪次 `explorer` 调用上。
fn launch_wsa_settings() {
    wlog(&format!("[wsa] 经 explorer 打开 WSA 设置：shell:appsFolder\\{WSA_SETTINGS_ID}"));
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
    // 已经点掉过就直接返回：说明框一辈子只弹一次，再去建 UIA 树纯属浪费 ——
    // [`wait_for_adb_auth`] 每轮轮询都会调这里。
    if FIRST_RUN_DIALOG_GONE.load(Ordering::Relaxed) {
        return false;
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        else {
            return false;
        };
        let Ok(cond) = uia.CreateTrueCondition() else {
            return false;
        };
        let Some((hwnd, btn)) = find_first_run_dialog(&uia, &cond, true) else {
            return false;
        };
        // ① 先试 Invoke。**不能只看返回值**：说明框是模态的，会把底下的设置窗口压成
        //    「不可用」，那个窗口里若有同名按钮，对它的 Invoke 照样返回 S_OK 却什么也不发生
        //    —— 以前就栽在这儿：日志写着「已自动点掉」，界面上说明框还杵着。
        if let Ok(inv) = btn.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if inv.Invoke().is_ok() {
                std::thread::sleep(Duration::from_millis(400));
                if find_first_run_dialog(&uia, &cond, false).is_none() {
                    wlog("[wsa] 已自动点掉「可选诊断数据」说明框：继续");
                    FIRST_RUN_DIALOG_GONE.store(true, Ordering::Relaxed);
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
        if find_first_run_dialog(&uia, &cond, false).is_none() {
            wlog("[wsa] 已自动点掉「可选诊断数据」说明框：继续（坐标点击）");
            FIRST_RUN_DIALOG_GONE.store(true, Ordering::Relaxed);
            return true;
        }
        wlog("[wsa] 点了说明框的「继续」但它没关掉，这一轮放弃重试");
        false
    }
}

/// 在可见顶层窗口里挑候选。真正的区分交给下面的元素签名（必须同时有「诊断开关」+
/// 「可用的『继续』按钮」），所以这里的入口可以放宽 —— 放宽只会多做几次 UIA 检查，
/// 收紧却会**整轮漏掉**说明框。
///
/// 三类入口：
/// ① 标题带「Android / 诊断」—— 说明框压在 WSA 界面上时，标题就是「适用于 Android™ 的
///    Windows 子系统」；
/// ② 标题以 `CN=` 开头—— 说明框以**独立 XAML 弹层**（`Windows.UI.Core.CoreWindow`）冒出来时，
///    标题取的是**包签名证书 DN**（`CN=Microsoft Windows, O=Microsoft Corporation, …`），
///    ①那两条一个都匹配不上。实测就栽在这儿：那一轮桌面窗口数比别轮多 1、全程零
///    「已自动点掉」记录，说明框从头压到尾；
/// ③ 类名 `#32770` / `Windows.UI.Core.CoreWindow`——按内容认弹窗的兜底，覆盖标题换皮的情况。
unsafe extern "system" fn collect_wsa_windows(hwnd: HWND, lp: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        // 类名兜底**不看标题**：授权框实测标题就是空的（窗口快照里是 `#32770 | `，
        // 竖线后面没字），说明框完全可能同样无标题 —— 类名判断若塞在 `n > 0` 里面，
        // 无标题窗口直接被跳过，这条兜底就等于没有。
        let mut cbuf = [0u16; 256];
        let cn = GetClassNameW(hwnd, &mut cbuf);
        let class = if cn > 0 {
            String::from_utf16_lossy(&cbuf[..cn as usize])
        } else {
            String::new()
        };
        let by_class = class == "#32770" || class == "Windows.UI.Core.CoreWindow";

        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            String::new()
        };
        if by_class
            || title.contains("诊断")
            || title.to_lowercase().contains("android")
            || title.starts_with("CN=")
        {
            (*(lp.0 as *mut Vec<HWND>)).push(hwnd);
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
    probe: bool,
) -> Option<(HWND, IUIAutomationElement)> {
    let mut cands: Vec<HWND> = Vec::new();
    let _ = EnumWindows(
        Some(collect_wsa_windows),
        LPARAM(&mut cands as *mut Vec<HWND> as isize),
    );
    // 识别失败原来是**全静默**的：候选窗口一个都认不到 → 连 UIA 都不建，什么都不留。
    // 这里把「扫了哪些候选」「只差一半签名的是谁」记下来，失败时至少能分清是
    // ① 宿主没认到（见 [`collect_wsa_windows`]）还是 ② 认到了但元素签名没对上。
    let mut seen: Vec<String> = Vec::new();
    let mut gaps: Vec<String> = Vec::new();
    for hwnd in cands {
        let mut cbuf = [0u16; 64];
        let cn = GetClassNameW(hwnd, &mut cbuf);
        let class = if cn > 0 {
            String::from_utf16_lossy(&cbuf[..cn as usize])
        } else {
            String::new()
        };
        let mut tbuf = [0u16; 128];
        let tn = GetWindowTextW(hwnd, &mut tbuf);
        let title = if tn > 0 {
            String::from_utf16_lossy(&tbuf[..tn as usize])
        } else {
            String::new()
        };
        let who = format!("{class} | {title}");
        seen.push(who.clone());
        let Ok(win) = uia.ElementFromHandle(hwnd) else {
            gaps.push(format!("{who} — UIA 取不到该窗口"));
            continue;
        };
        let Ok(kids) = win.FindAll(TreeScope_Descendants, cond) else {
            gaps.push(format!("{who} — UIA 建不出元素树"));
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
            } else if name == "继续" && el.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(false)
            {
                go = Some(el);
            }
        }
        let go_some = go.is_some();
        if let (true, Some(btn)) = (diag, go) {
            return Some((hwnd, btn));
        }
        if diag || go_some {
            gaps.push(format!("{who} — 诊断开关={diag} 可用「继续」={go_some}"));
        }
    }
    if probe {
        log_first_run_probe(&seen, &gaps);
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
    wlog(&format!(
        "[wsa] {what}的信号一直没来 —— 可能是有系统弹窗（权限申请 / 诊断反馈之类）挡在前面，\
         请手动关掉它；这里再等 {} 秒。",
        USER_GRACE.as_secs()
    ));
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
        wlog(&format!("[wsa] 设置窗口里没找到「{NAV_ADVANCED}」导航项，跳过自动开关"));
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
        wlog(&format!("[wsa] 「{NAV_ADVANCED}」页里没找到带 TogglePattern 的「{DEV_MODE}」开关"));
        return false;
    };
    // **点完必须回读确认**：实测有一次开关"点了没生效"，而这里直接返回 true（`Toggle()` 只要
    // 调用没报错就当成成功）—— 调用方以为开发者模式开好了，adb 端口却 200 秒从未监听，
    // 最后报 `ADB_CONNECT_FAILED`。所以只在**读到 On** 时才算成功；读到 Off 就再点一次
    // （最多 3 轮，避免反复切换把开关来回拨）。
    for _ in 0..3 {
        match tp.CurrentToggleState() {
            Ok(s) if s != ToggleState_Off => return true,
            Ok(_) => {
                let _ = tp.Toggle();
            }
            Err(_) => return false,
        }
        std::thread::sleep(Duration::from_millis(600)); // 等开关状态落定后再回读
    }
    let on = matches!(tp.CurrentToggleState(), Ok(s) if s != ToggleState_Off);
    if !on {
        wlog("[wsa] 反复点「开发人员模式」开关，回读始终不是 On —— 多半没打开");
    }
    on
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
        wlog("[wsa] 没找到可操作的 WSA 设置窗口（标题里没有 android），无法自动切到「高级设置」");
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
    // 预算从**进入等待的那一刻**起算（见 [`wait_for_adb_auth`] 开头的重新锚定）：
    // 冷启动的窗口自动化 + 首启等待实测可吃掉 106s，若锚在本函数入口，剩下的 29s
    // 连弹窗渲染（实测最慢 89s）都撑不满 —— 数学上必然超时。
    let auth_budget = if show_settings {
        ADB_AUTH_BUDGET_SETUP
    } else {
        ADB_AUTH_BUDGET_RECORD
    };
    let mut auth_deadline = Instant::now() + auth_budget;
    // 每轮 ensure 只给一次重新锚定的机会（外层若按秒轮询反复进等待，不能无限续期）。
    AUTH_BUDGET_ANCHORED.store(false, Ordering::Relaxed);
    // 日志的「清空」只在 `setup::install` 入口做一次 —— 若在这里也清，会把安装第 1、2 步
    // 的记录一起抹掉（本函数是第 3 步才被调到的）。
    if show_settings {
        wlog("[wsa] ===== 安装 / 修复：ensure_wsa(show_settings=true) =====");
    }
    wlog("[wsa] ensure_wsa 开始：先试直连现有 adb");
    if let Some(adb) = connect_waiting_auth(exe, &mut auth_deadline, auth_budget) {
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
    let unauth: Vec<bool> = ADB_PORTS
        .iter()
        .map(|p| is_unauthorized(exe, &format!("127.0.0.1:{p}")))
        .collect();
    let stuck = unauth.iter().any(|&b| b);
    // 留痕：这一行能同时回答「设备到底什么状态」和「换钥为什么没触发」（进程内已换过 / 没卡在
    // unauthorized）。上一轮实测里换钥分支静默没生效，正是缺这一行。
    wlog(&format!(
        "[adb] 直连失败后的端口状态：{}；本进程是否已换过密钥={}",
        ADB_PORTS
            .iter()
            .zip(&unauth)
            .map(|(p, u)| format!("{p} unauthorized={u}"))
            .collect::<Vec<_>>()
            .join("，"),
        ADB_KEY_ROTATED.load(Ordering::Relaxed)
    ));
    if stuck && !ADB_KEY_ROTATED.swap(true, Ordering::Relaxed) {
        wlog("[wsa] 设备停在 unauthorized 且迟迟不弹授权窗 —— 换一把全新 adb 公钥再试");
        if use_private_adb_home() {
            let _ = output_of(exe, &["kill-server".to_string()]);
            if let Some(adb) = connect_waiting_auth(exe, &mut auth_deadline, auth_budget) {
                if show_settings {
                    close_wsa_settings();
                }
                return Ok(adb);
            }
            wlog("[wsa] 换钥后仍未授权（用户需在弹窗里点「允许」）");
        }
    }
    wlog("[wsa] adb 未连上，拉起 WSA 并等待启动 …");
    let t0 = Instant::now();
    if show_settings {
        let t1 = Instant::now();
        launch_wsa_settings();
        // 首次启动 WSA 会弹「可选诊断数据」说明框，正好压在设置窗口前面 —— 先替用户点掉
        // （只点「继续」，不勾那个复选框），否则下面的开关会被它挡着点不到。
        // 它一辈子只弹一次，所以最多等 4 秒；没弹就直接往下走，不拖流程。
        // boot 期已经点掉过就整个跳过 —— 三轮实测这一段固定空转 4.0s（`设置窗口自动化`
        // 三轮全是 6.5s，而 boot 期日志都写着「已自动点掉」）。
        if !FIRST_RUN_DIALOG_GONE.load(Ordering::Relaxed) {
            for _ in 0..8 {
                std::thread::sleep(Duration::from_millis(500));
                if dismiss_first_run_dialog() {
                    break;
                }
            }
        }
        // 把「开发人员模式」打开 —— adb 端口 58526 只有开了它才监听。
        // 开关成不成都会当场把设置窗口收掉（`enable_developer_mode` 末尾那处）。
        if enable_developer_mode() {
            wlog("[wsa] 已自动打开「开发人员模式」并收起设置窗口");
        } else {
            wlog("[wsa] 没能自动操作「开发人员模式」开关，请在弹出的设置窗口里手动打开");
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
    wlog(&format!(
        "[wsa] 正在启动 WSA，最多等 {} 秒，连上就继续 …",
        WSA_FIRST_RUN_GRACE.as_secs()
    ));
    // 顺带把「这一轮有没有问到 adb」记下来：问到就说明开发者模式本来就开着，后面不用再碰
    // 设置窗口（也顺手把可能残留的面板收起）。
    let t_grace = Instant::now();
    let mut early = None;
    let grace = Instant::now() + WSA_FIRST_RUN_GRACE;
    while Instant::now() < grace {
        if let Some(adb) = connect_waiting_auth(exe, &mut auth_deadline, auth_budget) {
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
        if let Some(adb) = connect_waiting_auth(exe, &mut auth_deadline, auth_budget) {
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
        // 授权预算已尽、设备还卡在 `unauthorized` → 不等冷启动预算了（那一整段只是让用户干等）。
        // 这是「点录制后一直卡住没反应」的止血点。
        if Instant::now() >= auth_deadline
            && ADB_PORTS
                .iter()
                .any(|p| is_unauthorized(exe, &format!("127.0.0.1:{p}")))
        {
            wlog("[wsa] 授权等待预算用尽且设备仍未授权 → 立即结束本轮冷启动等待");
            // 安装 / 修复路径上再试最后一招：整台重启 WSA（见 restart_wsa_and_reconnect）。
            // 点录屏那条路不给做 —— 那里用户只等着窗口弹出来，会直接报错引导去点「安装/修复」。
            if show_settings {
                if let Some(adb) = restart_wsa_and_reconnect(exe) {
                    close_wsa_settings();
                    return Ok(adb);
                }
            }
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
        // 授权预算从等待起点锚定后可能比冷启动预算更长 —— 循环会先被 boot deadline 截断，
        // 于是走到这里。原来这个出口直接报错，等于把「最后一招」整台重启永久掐死，
        // 所以与循环内那个分支一样，先给 restart 一次机会。
        if show_settings {
            if let Some(adb) = restart_wsa_and_reconnect(exe) {
                close_wsa_settings();
                return Ok(adb);
            }
        }
        return Err(err_adb_unauthorized());
    }
    // 等不到就把设置窗口摆出来：多半是「开发人员模式」没开，用户点一下开关就能救活
    wlog("[wsa] 判定：adb 端口未监听（多半是「开发人员模式」未开）");
    launch_wsa_settings();
    Err("ADB_CONNECT_FAILED::连不上 WSA（等待启动超时）。已为你打开 WSA 的设置窗口：请在左侧「高级设置」里把「开发人员模式」打开 —— adb 端口 58526 只有开了它才监听。若 WSA 自己都打不开，请回到「完整录屏」卡片点「首次使用点击安装插件」修复".into())
}

/// 进程内是否已经整台重启过 WSA（见 [`restart_wsa_and_reconnect`]）。
static WSA_RESTARTED: AtomicBool = AtomicBool::new(false);

/// 最后一招：**整台重启 WSA**（`WsaClient.exe /shutdown` → 重新拉起），复位设备侧的 adb 状态。
///
/// 与 `adb kill-server` 有**本质区别**：`kill-server` 只动 Windows 这头的 adb 服务，Android 侧
/// 「这台计算机的密钥已被处理过」那个结论还留在子系统里 —— 实测反复重做握手、换新公钥、
/// 耐心等满 120s，全都无效。只有把整台子系统重启，guest 侧的 adbd 状态才会被一起清掉，
/// 让公钥重新走一遍「没见过 → 弹授权框」的流程。
///
/// 只在安装 / 修复路径上做，且整个进程只做一次；点「开始录制」时**不给做** —— 那一刻用户
/// 只等着窗口弹出来，不该被卷进一次几分钟的子系统重启（那条路会直接报错并引导去点安装）。
fn restart_wsa_and_reconnect(exe: &Path) -> Option<Adb> {
    if WSA_RESTARTED.swap(true, Ordering::Relaxed) {
        return None;
    }
    wlog("[wsa] 整台重启 WSA，以复位设备侧的 adb 授权状态（kill-server 做不到这件事）…");
    let _ = output_of(exe, &["kill-server".to_string()]);
    shutdown_wsa();
    launch_wsa();
    let t = Instant::now();
    // phase2 是一轮**全新**的授权等待：给它一个新的预算锚点（否则 ensure 入口那次
    // 锚定已消费，重启后会沿用旧 deadline，等待窗反而更短）。
    AUTH_BUDGET_ANCHORED.store(false, Ordering::Relaxed);
    let mut auth_deadline = Instant::now() + WSA_RESTART_AUTH;
    let boot_deadline = Instant::now() + WSA_RESTART_BOOT;
    while Instant::now() < boot_deadline {
        std::thread::sleep(WSA_POLL);
        let Some(adb) = connect_waiting_auth(exe, &mut auth_deadline, WSA_RESTART_AUTH) else {
            continue;
        };
        if boot_completed(&adb) {
            wlog(&format!(
                "[wsa] 重启 WSA 后已连上且启动完成（{:.1}s）",
                t.elapsed().as_secs_f32()
            ));
            return Some(adb);
        }
    }
    wlog("[wsa] 重启 WSA 后仍未拿到可用 adb");
    None
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
         若窗口一直不出现、或点完仍无效，请回到「完整录屏」卡片点「首次使用点击安装插件」——\
         安装 / 修复流程会整台重启一次 WSA，把设备侧的授权状态复位。\
         详细过程见日志：{log}"
    )
}

// ==================== 进房 / 窗口 ====================

/// 进房**第一段**：冷启主界面。返回结束时前台的 Activity 名（第二段拿它当"有没有切走"的基准）。
///
/// 两段都不死等固定时长：`am start -W` 本身就会阻塞到 Activity 真正启动，之后只轮询
/// `dumpsys` 拿一个**信号**，信号一到就只补一小段渲染静置时间。信号拿不到时退回等满预算。
///
/// **调用方必须在第二段（DeepLink）之前把窗口定型好** —— 见 [`enter_and_show`]。
/// 写 `wm density` 与改窗口尺寸都会让 Android 发生**配置变更**，当前前台 Activity 会被重建。
/// 密度赶在 APP 起来之前写（前台只有 WSA 自己的界面）；尺寸改在主界面上做，重建的也是主界面，
/// 用户看不出来。要是等进了直播间才做，直播播放器会被整个重建一遍 —— 现象就是「画面黑一下、
/// 然后从头重新加载」（用户实测反馈的就是这个，而且是**每一次**都会发生）。
fn open_app(adb: &Adb) -> Result<Option<String>, String> {
    // 录制期间不能息屏：Android 一旦息屏 WGC 就只能拿到静止画面
    let _ = adb.shell("svc power stayon true");
    let _ = adb.shell("settings put global stay_on_while_plugged_in 7");
    let _ = adb.shell("input keyevent KEYCODE_WAKEUP");

    adb.shell(&format!("am start -W -n {MAIN_ACTIVITY}"))
        .map_err(|e| format!("DEEPLINK_FAILED::启动 B 站 APP 失败: {e}"))?;
    wait_until_with_grace(WAIT_MAIN, || resumed_activity(adb).is_some(), "B 站 APP 主界面起来");
    std::thread::sleep(SETTLE_MAIN);
    Ok(resumed_activity(adb))
}

/// 进房**第二段**：DeepLink 进直播间。`main` 是第一段结束时前台的 Activity ——
/// 直播间接手后前台不再是它，等到这个变化就算进房完成。
fn open_live(adb: &Adb, room_id: i64, main: Option<String>) -> Result<(), String> {
    adb.shell(&format!(
        "am start -a android.intent.action.VIEW -d bilibili://live/{room_id}"
    ))
    .map_err(|e| format!("DEEPLINK_FAILED::进入直播间失败: {e}"))?;
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
    wait_window_within(WINDOW_BUDGET)
        .ok_or_else(|| "WINDOW_NOT_FOUND::找不到 B 站 APP 窗口（WSA 可能没正常显示）".to_string())
}

/// 同上，但只等 `budget` 且不报错（拿不到就 `None`）—— 给「顺手定型，拿不到就退回老顺序」用
fn wait_window_within(budget: Duration) -> Option<HWND> {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(h) = current_window() {
            return Some(h);
        }
        if Instant::now() >= deadline {
            return None;
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

/// 本次会话的定型目标，**在 B 站 APP 起来之前**就算好（`enter_and_show` 第一步）。
///
/// 为什么不能等窗口出来再算：写 `wm density` 会让 Android 发生**配置变更**、重建前台
/// Activity —— APP 起来之后再写，重建的就是 APP；直播间起来之后再写，重建的就是直播间
/// （「画面黑一下、然后从头重新加载」）。所以密度必须赶在 `am start` **之前**写进 Android，
/// 那时前台只有 WSA 自己的界面，重建它没人看得出来。
///
/// 几何按**主显示器可用区**算：此刻还拿不到窗口（APP 没起、WSA 宿主窗口可能也不可见），
/// 量不到外框，就按 0 算 —— WSA 窗口总是冷启在主显示器上，与按窗口算只差十几像素。
/// 算出来的目标全程复用（密度与窗口尺寸都用它），**整场只有一次配置变更**。
fn pre_launch_geometry() -> recorder::Geometry {
    let (wa_w, wa_h) = recorder::primary_work_area();
    recorder::fit_geometry_for(wa_w, wa_h, 0, 0)
}

/// 定型（改窗口尺寸）后、发 DeepLink 前，等 APP 把这次 Android **配置变更**消化完。
///
/// 配置变更会**重建当前前台 Activity**（此刻是主界面）。重建没结束就发 DeepLink，
/// 直播间会在「半重建」的主界面上启动 —— 实测（用户反馈）这比「进房后再定型」黑屏更严重，
/// 所以这一段静置是必须的：主界面的重建 + 重绘都在这段时间里结束。
fn settle_after_config() {
    std::thread::sleep(CONFIG_SETTLE);
}

// ==================== 对外流程 ====================

/// 守护线程是否该继续跑（`stop_mute_guard` 置 false）
static MUTE_RUNNING: AtomicBool = AtomicBool::new(false);
/// 守护线程句柄（同一时刻只留一个；停止时要 join，别让它和收尾打架）
static MUTE_GUARD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// WSA 宿主进程（Android 侧的声音全由它渲染到默认播放设备上，就是 Windows「音量合成器」
/// 里 WSA 那一项）。
const WSA_CLIENT_EXE: &str = "WsaClient.exe";

/// 该静音哪些进程：**按进程名找 WSA 宿主**，找不到才退回「B 站窗口所属进程」。
///
/// 为什么不认窗口：B 站窗口是 Android 侧 Activity 画出来的，**冷启动慢时窗口会先白屏
/// 好几秒，而声音在那之前就出来了**（实测：窗口空白的几秒里一直有声）。窗口没出来就
/// 认不到目标 → 一整段漏音。`WsaClient.exe` 只要 WSA 起着就在，与直播间加载快慢无关。
///
/// **绝不去猜「当前正在出声的会话」**：会话是 APP 开始播音那一刻才建出来的，猜法在窗口
/// 还没起来时会静音到别的正在播音的程序上（浏览器 / 音乐播放器），而且一旦认下来就再改
/// 不回来 —— 第一轮实测就是这个。
fn wsa_audio_pids() -> Vec<u32> {
    let mut pids = process_ids(WSA_CLIENT_EXE);
    if pids.is_empty() {
        // 兜底：万一哪天宿主改名了，至少还能按窗口进程认（窗口没出来时这里是空的，
        // 所以它只是保险，不是主路径）
        if let Some(hwnd) = current_window() {
            let mut pid = 0u32;
            unsafe {
                let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            }
            if pid != 0 {
                pids.push(pid);
            }
        }
    }
    pids
}

/// **全程静音守护**：从拉起 B 站 APP **之前**一直盯到本次会话结束。
///
/// 为什么必须是**常驻**线程，而不是「进房阶段盯一下、之后交给 overlay」：
/// - overlay 要等「进房 → 等窗口 → 定型 → 激活」全走完才建得起来，实测那几秒里
///   声音早就外放出来了；
/// - 静音是 **per-session** 的：APP 换播放器 / 换线路 / 重新拉起时音频会话都会**重建**，
///   新会话默认不静音。只在开头设一次必然漏。
///
/// 每 [`MUTE_POLL`] 一拍：解析目标 pid（拿不到就等下一拍）→ 按 `recorder::audio::muted()`
/// 的**期望状态**把它名下**所有**会话设一遍。所以无论会话什么时候冒出来、重建多少次，
/// 最多 50ms 内就会被静音 —— APP 还没出声就已经哑了。
///
/// 目标 pid 解析失败（会话还没建出来 / 进程没了）只会重置 pid 下拍重来，不算错误。
fn start_mute_guard() {
    let Ok(mut slot) = MUTE_GUARD.lock() else {
        return;
    };
    if slot.is_some() {
        return;
    }
    MUTE_RUNNING.store(true, Ordering::SeqCst);
    // 每个新会话都回到默认：静音。用户上一次取消静音的选择不带过来。
    crate::recorder::audio::set_muted(true);
    let spawned = std::thread::Builder::new()
        .name("bili-mute-guard".into())
        .spawn(|| {
            let mut logged = false;
            while MUTE_RUNNING.load(Ordering::Relaxed) {
                let want = crate::recorder::audio::muted();
                let pids = wsa_audio_pids();
                let mut hit = Vec::new();
                for pid in &pids {
                    // 会话还没建出来（APP 还没开始播音）时这里是 Err，下一拍再试即可 ——
                    // pids 每拍重算，进程/会话重建都能跟上。
                    if crate::recorder::audio::set_process_mute(*pid, want).is_ok() {
                        hit.push(*pid);
                    }
                }
                if !hit.is_empty() {
                    if want && !logged {
                        logged = true;
                        wlog(&format!(
                            "[音频] 全程静音：已静音 WSA（{WSA_CLIENT_EXE}）的音频会话（pid {}）—— 与直播间加载快慢无关",
                            hit.iter().map(|p| p.to_string()).collect::<Vec<_>>().join("/")
                        ));
                    } else if !want && logged {
                        // 用户点了按钮取消静音 → 之后再静音时重新记一条
                        logged = false;
                    }
                }
                std::thread::sleep(MUTE_POLL);
            }
            // 收尾：把静音还原。WSA 正常会被整个关掉，这行是兜底 ——
            // 万一关不干净，也别让用户之后再手动用 WSA 时一直是哑的。
            for pid in wsa_audio_pids() {
                let _ = crate::recorder::audio::set_process_mute(pid, false);
            }
        });
    match spawned {
        Ok(h) => *slot = Some(h),
        Err(_) => MUTE_RUNNING.store(false, Ordering::SeqCst),
    }
}

/// 停守护线程并等它退出（收尾顺序：**先停它**，再关 APP / 关 WSA，免得它在中途又把目标静音回去）
fn stop_mute_guard() {
    MUTE_RUNNING.store(false, Ordering::SeqCst);
    let handle = MUTE_GUARD.lock().ok().and_then(|mut g| g.take());
    if let Some(h) = handle {
        let _ = h.join();
    }
}

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

    // 全程静音：**赶在拉活 APP 之前**就把静音守护挂上（见 [`start_mute_guard`]）。
    // 放在 `am force-stop` 之前也一样 —— 那时守护还在等 APP 窗口出现，只是把「盯」的开始
    // 时间提前到最靠前，越早越没有漏音的可能。
    start_mute_guard();
    let shown = enter_and_show(adb, room_id);
    if shown.is_err() {
        // 进房/定型失败：不会有会话了，把守护收掉，别让它一直空转、也别把它静音过的
        // 旧实例（上一轮残留）留在静音状态。
        stop_mute_guard();
    }
    shown
}

/// `bring_up_session` 的后半段：清旧实例 → 写密度 → 冷启 APP → 定型窗口 → DeepLink 进房
/// → 挂 overlay → 记会话。单独拆出来是为了让 [`start_mute_guard`] 的收尾只在「本次会话真的失败」时发生。
///
/// **顺序是这一整套的关键**（详见 [`pre_launch_geometry`] / [`settle_after_config`]）：
/// Android 的配置变更会重建当前前台 Activity，所以两处配置都必须在「没有直播播放器在前台」
/// 的时候落下去，并且要让 APP 消化完再进房，否则直播画面就会黑一下、重新加载一遍。
fn enter_and_show(adb: Adb, room_id: i64) -> Result<(), String> {
    // 先把可能还开着的旧实例清掉
    let _ = adb.shell(&format!("am force-stop {PACKAGE}"));

    // ① 定型目标 + 写密度：**赶在 APP 起来之前**。此刻前台只有 WSA 自己的界面，
    //    密度变更重建它也看不见。目标算一次、全程复用，后面不再改写密度。
    let g = pre_launch_geometry();
    recorder::set_density(g.density);
    wlog(&format!(
        "[几何] 定型目标（APP 起来前）：客户区 {}x{}，Android 密度 {}（参考 {}x{}@{}；整窗高按可用区 90%，宽度按 17:9 反算）",
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

    // ② 第一段：冷启主界面
    let main = open_app(&adb)?;

    // ③ 趁还在主界面把窗口尺寸定下来（这是进房前的最后一处配置变更），并等 APP 消化完。
    //    窗口要等主界面画出来才有，所以只能排在这一段之后。
    //    主界面一直没建出窗口时**不勉强**：退回老顺序（先进房、再定型），流程不会坏，只是黑闪一次。
    let fitted = match wait_window_within(PRE_FIT_BUDGET) {
        Some(h) => {
            fit_window(h, g.client_w, g.client_h)?;
            settle_after_config();
            true
        }
        None => false,
    };

    // ④ 第二段：DeepLink 进直播间（尺寸 / 密度都已就位，进去之后不再动配置）
    open_live(&adb, room_id, main)?;

    let hwnd = wait_window()?;
    if !fitted {
        // 冷启动慢到主界面阶段一直没抓到窗口：只能现在补。这次配置变更落在直播间上，
        // 会黑一下 —— 但比例是错的更糟，只能两害相权。
        fit_window(hwnd, g.client_w, g.client_h)?;
    }
    // 把「窗口 / 显示器 / Android 显示配置」的实测值记进日志：窗口是不是装不下、
    // 裁掉的 56px 是不是正好等于 Android 状态栏，全靠这几行判断（release 看不到 stderr）。
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

/// 停止监听：停静音守护 → 关 B 站 APP → 关 WSA → 清会话。
pub fn shutdown() {
    // **先停守护再动手**：它每 50ms 就会把目标静音一次，不收掉的话会和后面的
    // 「还原静音」抢，收尾完还可能被它静音回去。
    stop_mute_guard();
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

/// 按映像名（如 `WsaClient.exe`）找出**所有**同名进程的 pid。
///
/// 用进程快照（`CreateToolhelp32Snapshot`）而不是 `tasklist`：快照是本机 API、一次约 1ms，
/// 可以放进 50ms 的静音守护循环里每拍都做；`tasklist` 每拍起一个子进程，太贵。
fn process_ids(name: &str) -> Vec<u32> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let image = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if image.eq_ignore_ascii_case(name) {
                    out.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}