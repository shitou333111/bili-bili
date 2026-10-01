//! 录屏环境初始化（检测 + 安装）。
//!
//! 「完整录屏」依赖三样东西：adb(platform-tools)、WSA、WSA 里的 B 站 APP(APK)。
//! 本模块负责**检测**这三样是否就绪，并提供**一键安装**：下载 → 解压 → 安装，
//! 每一步都通过 `wsa-setup:progress` 事件回执（阶段 / 进度 / 结果），前端据此画进度条。
//! 安装顺序与上面一致（前两步互不依赖，第三步才需要前两步都就绪），见 [`STEP_ADB`]。
//!
//! 三条铁律：
//! 1. 每一步先检测再动手，已装好就跳过（绝不重复下载 1.5GB 的 WSA）。
//! 2. 结果以**实测复核**为准（不是"命令没报错就当成功"）。
//! 3. 检测结果与「已安装」标记都落在应用数据目录 —— 所有账号共用，切账号不重装。
#![cfg(windows)]

use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::wsa;

/// 安装进度事件名（前端订阅它画进度条）。
pub const PROGRESS_EVENT: &str = "wsa-setup:progress";

/// 用户点「中止」时置位。下载循环每收一段就查一次，各步骤入口也查 —— 命中即尽快收手，
/// 但**不会**删掉已下载的 `.part` / 已解压的 `pkg`，下次接着来。
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// 中止错误的前缀。前端据此把提示显示成「已中止」而不是「安装失败」。
const CANCEL_CODE: &str = "CANCELLED";

/// 三步的步号。**顺序就是安装顺序**：先 adb（体积小、与 WSA 互不依赖，先让用户看到进展），
/// 再 WSA（528MB 的大包，装完顺手后台冷启动），最后才是在 WSA 里装 B 站 APP ——
/// 只有这第 3 步需要「adb 就绪 + WSA 已注册」两个前提同时满足。
/// 前端进度条的「第 N / 3 步」与 `emit` / `download` 的 `step` 参数都用这几个常量，
/// 免得日后调顺序时漏改某一处、让进度条指错步骤。
const STEP_ADB: u8 = 1;
const STEP_WSA: u8 = 2;
const STEP_APK: u8 = 3;

/// 请求中止安装（`wsa_setup_abort` 命令调用）。
pub fn request_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

/// 中止检查：命中就返回带 `CANCELLED::` 前缀的错误，一路 `?` 抛给前端。
fn check_cancel() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) {
        Err(format!("{CANCEL_CODE}::安装已中止（已下载/已解压的部分会保留，下次接着进行）"))
    } else {
        Ok(())
    }
}

/// WSA 分发包（MustardChef/WSABuilds，官方 LTS 8 无 GApps 版）。
const WSA_WIN11_X64: &str = "https://github.com/MustardChef/WSABuilds/releases/download/Windows_11_2407.40000.4.0_LTS_8/WSA_2407.40000.4.0_x64_Release-Nightly-NoGApps-NoAmazon.7z";
const WSA_WIN11_ARM: &str = "https://github.com/MustardChef/WSABuilds/releases/download/Windows_11_2407.40000.4.0_LTS_8_arm64/WSA_2407.40000.4.0_arm64_Release-Nightly-NoGApps-NoAmazon.7z";
const WSA_WIN10_X64: &str = "https://github.com/MustardChef/WSABuilds/releases/download/Windows_10_2407.40000.4.0_LTS_8/WSA_2407.40000.4.0_x64_Release-Nightly-NoGApps-NoAmazon_Windows_10.7z";
/// 哔哩哔哩 Android 客户端（官方渠道包）
const BILI_APK_URL: &str = "https://dl.hdslb.com/mobile/latest/android64/iBiliPlayer-bili.apk";

/// 三步安装的环境检测结果（`wsa_setup_status` 的返回体）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    /// 当前平台/架构是否能自动安装（Win11 x64/ARM64 或 Win10 x64）
    pub supported: bool,
    /// 三样全就绪 —— 前端绿灯「插件已安装」、开始按钮可点
    pub ready: bool,
    /// 形如「Windows 11 x64」，给前端提示用
    pub platform: String,
    /// 第 1 步：adb（platform-tools）
    pub adb: bool,
    /// 第 2 步：WSA
    pub wsa: bool,
    /// 第 3 步：B 站 APP（APK）。WSA 没就绪时恒为 `false`（APP 装在 WSA 里，子系统坏了它必然不可用）
    pub apk: bool,
}

/// 安装进度负载。`step`：1 adb / 2 WSA / 3 APK（0 = 整轮结束）。
/// `phase`：`download` / `extract` / `install` / `skip` / `done` / `error`。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    step: u8,
    phase: String,
    message: String,
    /// 已下载字节数（非下载阶段为 0）
    received: u64,
    /// 总字节数（服务端未给 Content-Length 时为 0，前端按不确定进度处理）
    total: u64,
}

fn emit(app: &AppHandle, step: u8, phase: &str, message: impl Into<String>, received: u64, total: u64) {
    let _ = app.emit(
        PROGRESS_EVENT,
        SetupProgress {
            step,
            phase: phase.to_string(),
            message: message.into(),
            received,
            total,
        },
    );
}

// ==================== 平台探测 ====================

/// 系统主版本号（注册表 CurrentBuildNumber）。取不到按 0 处理。
fn windows_build() -> u32 {
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "/v",
            "CurrentBuildNumber",
        ])
        .creation_flags(CREATE_NO_WINDOW.0)
        .output();
    let Ok(out) = out else { return 0 };
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .last()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
}

/// 是否 Windows 11（build ≥ 22000）。探测失败时按 Win11 处理——
/// 宁可给出 Win11 的包（新系统也能装），别把 ARM 设备误判成"不支持"。
fn is_win11() -> bool {
    let b = windows_build();
    b == 0 || b >= 22000
}

/// 当前平台对应的 WSA 分发包；没有对应包（如 Win10 ARM64 / 32 位）返回 `None`。
fn wsa_url() -> Option<&'static str> {
    match (is_win11(), std::env::consts::ARCH) {
        (true, "x86_64") => Some(WSA_WIN11_X64),
        (true, "aarch64") => Some(WSA_WIN11_ARM),
        (false, "x86_64") => Some(WSA_WIN10_X64),
        _ => None,
    }
}

fn platform_label() -> String {
    let os = if is_win11() { "Windows 11" } else { "Windows 10" };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "ARM64",
        other => other,
    };
    format!("{os} + {arch}")
}

// ==================== 检测 ====================

/// 应用数据目录下的初始化工作区（WSA 包、platform-tools、APK、标记文件都放这）。
/// `pub(crate)`：`wsa::platform_tools_dir` 也把东西放到这里，别再各拼一份路径。
pub(crate) fn setup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("NO_WRITE_PERMISSION::取应用数据目录失败: {e}"))?;
    let dir = base.join("setup");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", dir.display()))?;
    Ok(dir)
}

/// B 站 APP 的「已安装」标记文件。APK 装一次全账号可用，用它避免重复下载安装。
fn apk_flag(app: &AppHandle) -> Option<PathBuf> {
    setup_dir(app).ok().map(|d| d.join("bili-apk.installed"))
}

/// 写「已安装」标记（所有账号共用，切账号不再重复下载安装）
fn mark_apk(app: &AppHandle) {
    let Some(flag) = apk_flag(app) else { return };
    if let Some(p) = flag.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(&flag, b"1");
}

/// 清掉「已安装」标记。实测发现 APP 其实不在时调用 —— 纠正被「手动卸载」弄脏的标记。
fn unmark_apk(app: &AppHandle) {
    if let Some(flag) = apk_flag(app) {
        let _ = std::fs::remove_file(flag);
    }
}

/// **实测** B 站 APP 是否真在 WSA 里（`pm list packages`）。只有 adb 能连上 WSA 才有结论
/// （连不上，或本机还没 adb → `None`）。`connect` 不会拉起 WSA，问不到就很快返回。
fn apk_probe(app: &AppHandle) -> Option<bool> {
    wsa::package_installed(&wsa::adb_exe(app)?, wsa::PACKAGE)
}

/// B 站 APP 是否已装：**能实测就以实测为准**，并顺手纠正标记文件；实测不了（WSA 没在跑）
/// 才退回标记文件 —— 检测不会为了问一句去唤醒 WSA。
///
/// 为什么不能只信标记：用户在 WSA 里手动卸载 APP 后标记文件还留着，只信它就会一直误报
/// 「已安装」—— 卡片常绿、点按钮没反应、启动录屏时才卡住。
fn apk_installed(app: &AppHandle) -> bool {
    if let Some(real) = apk_probe(app) {
        if real {
            mark_apk(app);
        } else {
            unmark_apk(app);
        }
        return real;
    }
    apk_flag(app).map(|p| p.is_file()).unwrap_or(false)
}

/// 每用户包仓库里 WSA 的「注册目录」（开发模式注册时 Windows 就从这个目录激活它的程序）。
/// 读不到（商店 / MSIX 安装、别的用户装的）返回 `None`。
fn wsa_loose_root() -> Option<PathBuf> {
    const PARENT: &str = r"HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
    let out = Command::new("reg")
        .args([
            "query",
            PARENT,
            "/f",
            "MicrosoftCorporationII.WindowsSubsystemForAndroid",
            "/k",
        ])
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()?;
    let key = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.contains("MicrosoftCorporationII.WindowsSubsystemForAndroid_"))?
        .trim()
        .to_string();
    let out = Command::new("reg")
        .args(["query", &key, "/v", "PackageRootFolder"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.contains("PackageRootFolder"))?
        .to_string();
    let root = line.split("REG_SZ").nth(1)?.trim();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

/// WSA 是否**可用**（红绿灯与「跳过安装」的判据都用它）。
///
/// 光看「WsaClient 别名存在」不够：我们装的 WSA 是**开发模式 + 注册目录**，Windows 激活
/// WsaClient 时直接读注册目录里的文件。目录一旦不完整（实测：丢了 `AppxManifest.xml`），
/// WsaClient 一启动就 fail-fast 崩溃（`0xc0000602` in `combase.dll`）→ VM 永远起不来、
/// adb 连不上，而别名文件还在 —— 只按别名判就成了「卡片常绿 + 跳过安装」，把问题永久锁死。
/// 所以注册目录若就在我们的工作区里，必须再核一遍它的完整性；缺文件即判定为坏，走重装修复。
fn wsa_ready(app: &AppHandle) -> bool {
    if !wsa::wsa_installed() {
        return false;
    }
    let (Some(root), Ok(dir)) = (wsa_loose_root(), setup_dir(app)) else {
        return true; // 读不到注册目录 / 取不到工作区 → 无从判断，按可用算
    };
    if !root.starts_with(&dir) {
        return true; // 不是我们装的那份（如商店版 WSA），不越权检查
    }
    pkg_ready(&root)
}

/// 检测三步是否就绪。
pub fn status(app: &AppHandle) -> SetupStatus {
    // WSA 这一项还要叠加「adb 通道最近是不是真的建起来过」：`wsa_ready` 只核「注册目录完不完整」，
    // 于是「WSA 装着、开发者模式开着，但设备侧永远 unauthorized」照样报绿 —— 实测反馈里
    // 「界面上显示成功、三灯全绿，点录屏却卡住」的矛盾正是它（见 `wsa::adb_channel_ok`）。
    // 进程刚起来还没试过连 adb 时该标志为 true，不会凭空把灯判红。
    let wsa_ok = wsa::adb_channel_ok() && wsa_ready(app);
    let adb_ok = wsa::adb_exe(app).is_some();
    // WSA 没就绪时 APP 一律按「未装」算：APP 是装在 WSA 里的，子系统起不来它就一定用不了。
    // 这也顺手挡掉了那个假绿灯 —— 此时问 adb 问不到、只会退回标记文件，而标记文件在
    // 「用户手动卸载了 APP」或「WSA 坏了」时都是过期的。WSA 修好后下次检测会自动恢复真实状态。
    let apk_ok = wsa_ok && apk_installed(app);
    let supported = wsa_url().is_some();
    SetupStatus {
        supported,
        ready: supported && wsa_ok && adb_ok && apk_ok,
        platform: platform_label(),
        wsa: wsa_ok,
        adb: adb_ok,
        apk: apk_ok,
    }
}

/// 异步版 `status`：APK 那一项可能要跑 adb 子进程（几百毫秒），放到阻塞线程池里做，
/// 别把 async 运行时堵住。
pub async fn status_async(app: &AppHandle) -> SetupStatus {
    let handle = app.clone();
    match tauri::async_runtime::spawn_blocking(move || status(&handle)).await {
        Ok(s) => s,
        Err(_) => status(app),
    }
}

// ==================== 安装 ====================

/// 一键安装：WSA → adb → APK，依次进行。
///
/// **每一步、甚至每一步内的每个环节都先检测再动手**：已下好的包 / 已解压的目录 /
/// 已注册的 WSA / 已装的 APK 都会跳过 —— 中途失败或用户中止后再点一次，会从中断处继续，
/// 不会把 1.5GB 的 WSA 包重下一遍。
/// 任一步失败即中止并把错误抛给前端（错误串 `CODE::中文`，CODE 为 `CANCELLED` 表示用户中止）。
pub async fn install(app: AppHandle) -> Result<SetupStatus, String> {
    CANCELLED.store(false, Ordering::SeqCst);
    // 日志在这里清空 + 落第一行（原生包日期戳 / exe 路径 / 日志路径）。
    // 放在**入口**而不是 `ensure_wsa` 里：三步里任何一步跳过时都要保证文件已经存在，
    // 否则用户按提示去找、只会看到"根本没生成日志"。
    wsa::wlog_reset();
    let st = status_async(&app).await;
    wsa::wlog(&format!(
        "[安装] 平台={}（supported={}）起始状态：WSA={} adb={} APK={}",
        st.platform, st.supported, st.wsa, st.adb, st.apk
    ));
    if !st.supported {
        return Err(format!(
            "UNSUPPORTED::当前环境（{}）暂无对应的 WSA 分发包，请按页面提示手动安装",
            st.platform
        ));
    }

    // 三步各自的耗时都进日志：用户只说得出"比较耗时"，到底慢在下载 WSA、解压、还是拉起
    // WSA 等授权，只能靠这几行区分（release 没有控制台）。
    //
    // 顺序：adb → WSA → B 站 APP。前两步**互不依赖**（`install_adb` 只碰 platform-tools，
    // `install_wsa` 只碰注册目录/注册表），换顺序不会互相拖累；只有第 3 步同时需要两者
    // （先 `adb_exe` 取到 adb，再由 `ensure_wsa` 连上 WSA），所以它必须排最后。
    let t_start = Instant::now();
    let mut step = 0u8;
    let mut t_step = Instant::now();
    let run: Result<(), String> = async {
        step = STEP_ADB;
        t_step = Instant::now();
        install_adb(&app).await?;
        wsa::wlog(&format!(
            "[安装][计时] 第 {STEP_ADB} 步 adb：{:.1}s",
            t_step.elapsed().as_secs_f32()
        ));
        step = STEP_WSA;
        t_step = Instant::now();
        install_wsa(&app).await?;
        wsa::wlog(&format!(
            "[安装][计时] 第 {STEP_WSA} 步 WSA：{:.1}s",
            t_step.elapsed().as_secs_f32()
        ));
        step = STEP_APK;
        t_step = Instant::now();
        install_bili_apk(&app).await?;
        wsa::wlog(&format!(
            "[安装][计时] 第 {STEP_APK} 步 B站APP：{:.1}s",
            t_step.elapsed().as_secs_f32()
        ));
        Ok(())
    }
    .await;

    if let Err(e) = run {
        wsa::wlog(&format!(
            "[安装][计时] 第 {step} 步失败（总 {:.1}s）：{e}",
            t_start.elapsed().as_secs_f32()
        ));
        let cancelled = e.starts_with(CANCEL_CODE);
        emit(
            &app,
            0,
            if cancelled { "cancelled" } else { "error" },
            if cancelled {
                "已中止安装。已下载 / 已解压的部分都留着，下次点按钮会从中断处继续".to_string()
            } else {
                e.clone()
            },
            0,
            0,
        );
        return Err(e);
    }

    let done = status_async(&app).await;
    emit(
        &app,
        0,
        if done.ready { "done" } else { "error" },
        if done.ready {
            "环境已就绪，可以开始录屏了".to_string()
        } else {
            "安装流程已结束，但仍有未就绪的项，请再点一次按钮检查".to_string()
        },
        0,
        0,
    );
    Ok(done)
}

/// 第 2 步（`STEP_WSA`）：WSA。拆成三段各自判断，**任何一段做完都会被下一轮跳过**：
/// ① 工作区里已有解压产物（含包根 `filelist.txt`，按它逐项核对完整性）→ 下载与解压全跳过
/// ② 否则下载 `.7z`（带 `.part` 断点续传，并按包结构校验已有文件）
/// ③ 再解压到 `pkg.tmp`（**完整才搬到最终位置**，半成品不会被误认成已完成）
/// 之后提权跑 Run.bat 注册 WSA。**分发包与解压目录都一直留着**（下载慢，留着以后重装/修复
/// 直接用），只有解压中转目录 `pkg.tmp` 会被清掉。
///
/// 落盘布局：**工作区根下直接就是解压出来的包目录**（`setup/WSA_2407.40000.4.0_x64`），
/// 分发包与 `pkg.tmp` 也在这一层 —— 中间不再套 `wsa/pkg` 这类纯中转目录。
async fn install_wsa(app: &AppHandle) -> Result<(), String> {
    let dir = setup_dir(app)?;

    if wsa_ready(app) {
        emit(app, STEP_WSA, "skip", "已检测到 WSA，跳过安装", 0, 0);
        cleanup_extract_tmp(&dir);
        return Ok(());
    }
    if wsa::wsa_installed() {
        // 别名在、但注册目录缺文件：这种 WSA 是打不开的，必须重新解压 + 重新注册才能修好
        emit(app, STEP_WSA, "install", "正在修复 WSA…", 0, 0);
    }
    let url = wsa_url().ok_or_else(|| {
        format!("UNSUPPORTED::当前平台（{}）没有对应的 WSA 分发包", platform_label())
    })?;

    // 保留下载地址里的原始文件名（形如 WSA_2407.40000.4.0_x64_..._NoAmazon.7z），
    // 这样在磁盘上一眼看出下的是哪个平台/架构、带不带 GApps。
    // 旧版本统一存成 `wsa.7z`（不分平台），顺手迁移过来，保住已下载的部分好继续续传。
    let archive = dir.join(url_file_name(url));
    for (old, new) in [("wsa.7z", archive.clone()), ("wsa.7z.part", part_path(&archive))] {
        let old = dir.join(old);
        if !new.exists() && old.is_file() {
            let _ = std::fs::rename(&old, &new);
        }
    }

    // 先看工作区里是否已有**完整**的解压产物：有就完全不需要分发包了。
    // 这一步必须排在下载检查之前 —— 旧版本解压完会把 528MB 的包删掉，
    // 若先查包的存在性，就会白下一遍（用户报的「已下载已解压还从头下」正是如此）。
    let bat = if let Some(pkg) = extracted_wsa(&dir) {
        emit(app, STEP_WSA, "skip", "WSA 已下载完成，跳过下载", 0, 0);
        find_file(&pkg, "Run.bat").ok_or_else(|| {
            format!("EXTRACT_FAILED::解压目录中未找到 Run.bat：{}", pkg.display())
        })?
    } else {
        // ① 下载分发包。**只认「结构完整」**（`sevenz_complete` 纯离线读开头签名头算总长）：
        // 早期版本直写最终名、没有 `.part`，中断会留下「名字对、内容不全」的包，必须挡住；
        // 不完整就降级成 `.part` 交给下载器从断点续传，绝不从头再来。
        if archive.is_file() && sevenz_complete(&archive) {
            emit(app, STEP_WSA, "skip", "WSA 分发包上次已下载完成，跳过下载", 0, 0);
        } else {
            if archive.is_file() {
                let _ = std::fs::rename(&archive, part_path(&archive));
            }
            emit(app, STEP_WSA, "download", "正在下载 WSA…", 0, 0);
            download(app, STEP_WSA, "WSA", url, &archive).await?;
        }
        // 下完（或本来就在）再核一次结构，杜绝把半成品送进解压
        if !sevenz_complete(&archive) {
            // 降级成 `.part` 而不是删掉：字节留着，下次带 Range 从断点续传，不白费已下的部分
            let _ = std::fs::rename(&archive, part_path(&archive));
            return Err(
                "DOWNLOAD_FAILED::WSA 分发包下载后校验不完整（连接被中断或数据损坏），请再点一次按钮从断点继续"
                    .to_string(),
            );
        }
        check_cancel()?;

        // ② 解压到 `pkg.tmp`，**完整才搬到工作区根下** —— 那个最终目录存在即代表「解压完整」
        emit(app, STEP_WSA, "extract", "正在解压 WSA…", 0, 0);
        // 上次可能解压到一半被打断：半成品先清掉
        let tmp = dir.join("pkg.tmp");
        let _ = std::fs::remove_dir_all(&tmp);

        let (src, dst) = (archive.clone(), tmp.clone());
        let un7z = tauri::async_runtime::spawn_blocking(move || sevenz_rust2::decompress_file(&src, &dst))
            .await
            .map_err(|e| format!("EXTRACT_FAILED::解压任务异常: {e}"))?;
        // 解压工具在包被截断时会把能解的先解出来、却不报错，所以**必须自己核对完整性**
        let bad = match &un7z {
            Err(e) => e.to_string(),
            Ok(()) if !pkg_ready(&tmp) => "解压结果缺文件".to_string(),
            Ok(()) => String::new(),
        };
        if !bad.is_empty() {
            // 包已经过了 `sevenz_complete` 结构校验（开头签名 + 总长都对得上），
            // 说明包本身不是「被截断」的 —— 再解压失败多半是解压库的问题。
            // **不删包**：528MB 重下代价太大，留着包好让下次能直接重试。
            // 真实原因打到 stderr，方便排查（此前只对外说「解压失败」，信息太少）。
            eprintln!("[wsa] 解压失败，分发包保留在 {}，原因：{bad}", archive.display());
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!(
                "EXTRACT_FAILED::WSA 分发包解压失败（{bad}）。分发包已保留（{}），请再点一次按钮重试",
                archive.display()
            ));
        }
        // 包里套着一层同名目录（`pkg.tmp/WSA_2407.40000.4.0_x64/…`）：把这一层整体搬到工作区根下，
        // 于是磁盘上直接就是 `setup/WSA_2407.40000.4.0_x64`，不再多两级纯中转层。
        let inner = find_file(&tmp, "filelist.txt")
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .ok_or_else(|| {
                format!("EXTRACT_FAILED::解压结果中未找到 filelist.txt：{}", tmp.display())
            })?;
        let name = inner.file_name().ok_or_else(|| {
            format!("EXTRACT_FAILED::解压目录名异常：{}", inner.display())
        })?;
        let pkg = dir.join(name);
        // 同名的残缺目录（历史遗留）先清掉，免得 rename 撞车
        let _ = std::fs::remove_dir_all(&pkg);
        std::fs::rename(&inner, &pkg).map_err(|e| {
            format!("EXTRACT_FAILED::解压目录归位失败（{}）: {e}", pkg.display())
        })?;
        let _ = std::fs::remove_dir_all(&tmp);
        find_file(&pkg, "Run.bat").ok_or_else(|| {
            format!("EXTRACT_FAILED::解压后未找到 Run.bat，解压目录：{}", pkg.display())
        })?
    };
    check_cancel()?;

    // 要修的若是「已注册、但注册目录缺文件」这种（WsaClient 一启动就崩），
    // 把目录补齐就已经修好了 —— 注册信息还在（注册表 `PackageRootFolder` 指着这个目录），
    // 再跑一遍安装脚本反而会被系统拒掉（同版本的开发模式包不允许重注册：0x80073CFB），
    // 于是脚本走它自己的失败分支、要用户按键确认卸载重装。这里能修就收手，不提权、不折腾。
    if wsa_ready(app) {
        emit(
            app,
            STEP_WSA,
            "install",
            "已补齐 WSA 注册目录（无需重新注册），修复完成",
            0,
            0,
        );
        cleanup_extract_tmp(&dir);
        return Ok(());
    }

    // ③ 注册 WSA（UAC 提权跑 Run.bat）
    // 官方脚本装完会停在「Press any key to exit」等按键，那个提权窗口就得用户手动关 ——
    // 改掉我们这份副本里**成功路径末尾**的按键等待，装完窗口自己关。
    // 只动这一处：失败分支的按键是「要不要卸载已有安装」的确认，必须留给用户自己按。
    defuse_final_pause(&bat.with_file_name("Install.ps1"));
    // 官方脚本注册成功后会顺手把 Magisk / Play 商店拉起来（`Finish` 里那两行 `Start-Process
    // "wsa://…"`），这两个 APP 一启动就弹权限申请（位置等），而且是**模态**的、时机不定，
    // 正好砸在我们紧接着的自动化上。我们根本不需要它们（adb 就够），直接掐掉这两行。
    strip_install_autolaunch(&bat.with_file_name("Install.ps1"));
    // 注册前把清单里的能力声明删掉 —— 从源头掐掉宿主侧的能力授权弹窗。
    // 必须在**注册之前**改：注册时读的就是这份清单；注册之后再改文件是不生效的。
    let pkg_dir = bat.parent().unwrap_or(Path::new("."));
    strip_wsa_device_capabilities(pkg_dir);
    // 注册前先把中文资源合进包 —— 否则装出来的 WSA 设置界面永远是英文。失败不拦路。
    if pri_pending(pkg_dir) {
        emit(app, STEP_WSA, "install", "正在配置 WSA 界面…", 0, 0);
        merge_pri_resources(pkg_dir).await;
    }
    emit(app, STEP_WSA, "install", "即将弹出授权窗口，请点「是」…", 0, 0);
    run_run_bat(&bat).await?;

    emit(app, STEP_WSA, "install", "正在等待 WSA 安装完成…", 0, 0);
    let deadline = Instant::now() + Duration::from_secs(240);
    while Instant::now() < deadline {
        check_cancel()?;
        if wsa::wsa_installed() {
            // 注册成功。分发包**留着**（下载慢，以后重装/修复直接用）；解压目录是注册目录，必须留
            cleanup_extract_tmp(&dir);
            // **第一时间把 WSA 拉起来**：它冷启动要几十秒（首次还要初始化 userdata，更慢），
            // 这里先把它踢起来、下面的第 3 步再连 adb（`ensure_wsa`），冷启动的等待就没白等。
            // 绝不靠"打开设置面板"来启动它：设置窗口只是 UI，实测它不会把子系统拉起来。
            emit(app, STEP_WSA, "install", "正在后台启动 WSA…", 0, 0);
            tauri::async_runtime::spawn_blocking(wsa::boot_wsa_early)
                .await
                .ok();
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    Err(format!(
        "WSA_INSTALL_FAILED::等待 WSA 安装完成超时。可手动以管理员身份运行 {} 后重试（该目录已保留）",
        bat.display()
    ))
}

/// 第 1 步（`STEP_ADB`）：adb（platform-tools.zip → 剥掉顶层目录解压到应用数据目录）。
/// 与 WSA 同理分段：zip 已在就跳过下载，解压后 `adb.exe` 在就直接返回。
/// **与 WSA 没有任何依赖**：只用到文件系统与网络，所以能与 WSA 互换先后。
async fn install_adb(app: &AppHandle) -> Result<(), String> {
    check_cancel()?;
    if wsa::adb_exe(app).is_some() {
        emit(app, STEP_ADB, "skip", "已检测到 adb，跳过下载", 0, 0);
        return Ok(());
    }
    let dir = wsa::platform_tools_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", dir.display()))?;
    let zip = dir.join("platform-tools.zip");

    if zip.is_file() {
        emit(app, STEP_ADB, "skip", "adb 压缩包上次已下载完成，跳过下载", 0, 0);
    } else {
        emit(app, STEP_ADB, "download", "正在下载 adb…", 0, 0);
        download(app, STEP_ADB, "adb", wsa::PLATFORM_TOOLS_URL, &zip).await?;
    }
    check_cancel()?;

    emit(app, STEP_ADB, "extract", "正在解压 adb…", 0, 0);
    let (src, dest) = (zip.clone(), dir.clone());
    tauri::async_runtime::spawn_blocking(move || wsa::extract_platform_tools(&src, &dest))
        .await
        .map_err(|e| format!("ADB_NOT_FOUND::解压任务异常: {e}"))??;
    let _ = std::fs::remove_file(&zip);

    if dir.join("adb.exe").is_file() {
        Ok(())
    } else {
        Err("ADB_NOT_FOUND::解压后仍未找到 adb.exe".into())
    }
}

/// 第 3 步（`STEP_APK`）：B 站 APP（下载 APK → adb install → 写「已安装」标记）。
/// **唯一有前提的一步**：既要 adb（第 1 步）、又要 WSA 已注册（第 2 步），所以排在最后。
async fn install_bili_apk(app: &AppHandle) -> Result<(), String> {
    check_cancel()?;
    let exe = wsa::adb_exe(app)
        .ok_or_else(|| format!("ADB_NOT_FOUND::未找到 adb，请先完成第 {STEP_ADB} 步（adb）"))?;

    // 先做一次**不唤醒 WSA** 的实测：WSA 正开着就有准确结论，直接跳过。
    if apk_probe(app) == Some(true) {
        mark_apk(app);
        emit(app, STEP_APK, "skip", "WSA 中已安装 B 站 APP，跳过安装", 0, 0);
        return Ok(());
    }

    // 问不到（WSA 没在跑）就把 WSA 唤醒再实测一次。**绝不只凭标记文件跳过安装** ——
    // 用户手动卸载 APP 后标记就成了假情报，那时跳过安装只是把问题留到启动录屏时才爆。
    //
    // 这一次唤醒建起来的连接**留给下面的安装复用**（`install_apk_on`）。从前这里是两段各自
    // `ensure_wsa`：先 `boot_and_check_package`，后面 `install_apk` 再走一遍。第一段连不上就
    // 整段作废，第二段把「拉起 WSA / 开开发者模式 / 应答授权弹窗」原封不动再做一次 ——
    // 用户看到的就是「所有步骤又重来了一遍」。
    emit(app, STEP_APK, "install", "正在检查 B 站 APP…", 0, 0);
    let exe_conn = exe.clone();
    let t_check = Instant::now();
    let adb = tauri::async_runtime::spawn_blocking(move || wsa::ensure_wsa(&exe_conn, true))
        .await
        .map_err(|e| format!("ADB_CONNECT_FAILED::连接 WSA 的任务异常: {e}"))??;
    wsa::wlog(&format!("[wsa][计时] 拉起 WSA 并确认 B 站 APP 是否已装：{:.1}s", t_check.elapsed().as_secs_f32()));
    match wsa::has_package(&adb, wsa::PACKAGE) {
        Some(true) => {
            mark_apk(app);
            emit(app, STEP_APK, "skip", "WSA 中已安装 B 站 APP，跳过下载与安装", 0, 0);
            return Ok(());
        }
        // 实测确认 APP 不在 → 标记是假情报，清掉它再往下走重新安装
        Some(false) => unmark_apk(app),
        None => {}
    }

    let apk = setup_dir(app)?.join("iBiliPlayer-bili.apk");

    check_cancel()?;
    // APK **一律留着**：它 120MB、国内下载不快，装完删掉的话下次重装 / 修复又要重下一遍。
    // `download()` 只在**收满**时才把 `.part` 改名成这个最终名，所以「文件在」本身就等于
    // 「上次下载是完整的」，直接用，不必重下（半截的下载会留在 `.part` 里，接着续传）。
    if apk.is_file() {
        emit(app, STEP_APK, "skip", "B 站 APK 本地已有，跳过下载", 0, 0);
    } else {
        emit(app, STEP_APK, "download", "正在下载 B 站 APP…", 0, 0);
        download(app, STEP_APK, "B 站 APP", BILI_APK_URL, &apk).await?;
    }
    check_cancel()?;

    emit(app, STEP_APK, "install", "正在安装 B 站 APP…", 0, 0);
    let adb_for_task = adb.clone();
    let apk_for_task = apk.clone();
    let t_install = Instant::now();
    tauri::async_runtime::spawn_blocking(move || wsa::install_apk_on(&adb_for_task, &apk_for_task))
        .await
        .map_err(|e| format!("APK_INSTALL_FAILED::安装任务异常: {e}"))??;
    wsa::wlog(&format!("[wsa][计时] 安装 B 站 APP：{:.1}s", t_install.elapsed().as_secs_f32()));
    // 装完**不删 APK**：留着，下次重装 / 修复直接用（见上面那段注释）

    // 标记「已安装」：所有账号共用，切账号不再重复下载安装
    mark_apk(app);
    Ok(())
}

// ==================== 下载 / 解压 / 提权工具 ====================

/// 本地 7z 是否**结构完整**（纯离线判断，不用问服务器）。
///
/// 7z 开头 32 字节是「签名头」：签名(6) + 版本(2) + StartHeaderCRC(4) +
/// nextHeaderOffset(8) + nextHeaderSize(8) + nextHeaderCRC(4)。
/// 其中后两项指出「头部」在文件里的位置与长度，于是
/// **整个包应有的长度 = 32 + nextHeaderOffset + nextHeaderSize**（实测对得上）。
/// 包被截断时，读出来的这两个值算出的总长就对不上实际文件大小 —— 一眼就能判出来。
///
/// 为什么非要自己判：CDN 在慢网下经常提前断流，`download()` 只按「流读完了」当成功的话，
/// 会留下一个**名字对、内容不全**的包；下一次又被当成「已下载完成」直接去解压，必然失败。
fn sevenz_complete(path: &Path) -> bool {
    const SIG: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return false;
    };
    if len < 32 {
        return false;
    }
    let mut buf = [0u8; 32];
    if f.seek(SeekFrom::Start(0)).is_err() || f.read_exact(&mut buf).is_err() || buf[..6] != SIG {
        return false;
    }
    let off = u64::from_le_bytes(buf[12..20].try_into().unwrap());
    let size = u64::from_le_bytes(buf[20..28].try_into().unwrap());
    // checked：两个字段可能被截断成任意值，普通相加会溢出 panic
    32u64
        .checked_add(off)
        .and_then(|v| v.checked_add(size))
        == Some(len)
}

/// 清掉解压过程留下的 `pkg.tmp` 中转目录（上次被中止时残留的那种）。
///
/// **分发包 `.7z` / `.7z.part` 一律保留**：它 528MB、下载很慢，留着以后重装/修复能直接用，
/// 那点磁盘空间不值得换一次重下。
///
/// **绝不能删解压出来的包目录**：我们是开发模式「注册目录」安装（`Add-AppxPackage -Register`），
/// 注册目录就是激活 WsaClient 时读文件的地方（注册表 `PackageRootFolder` 指向它）。
/// 删了它 WsaClient 会直接崩溃（`0xc0000602`）、WSA 再也起不来 —— 之前顺手「回收 2.4GB」
/// 把注册目录一起删掉，正是「WSA 显示已安装却永远卡在启动阶段」的根源。
fn cleanup_extract_tmp(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir.join("pkg.tmp"));
}

/// URL 路径里的最后一段，作下载落盘文件名（保留下载地址里的原始文件名）。
fn url_file_name(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or("download.7z")
}

/// 工作区里已解压好的 WSA 注册目录：`setup` 根下**直接**那一层、自带包根 `filelist.txt` 的目录，
/// 形如 `setup/WSA_2407.40000.4.0_x64`。
///
/// 只认这一层：老布局那种 `setup/wsa/pkg/WSA_…` 的深层嵌套不算成品，否则会继续按深路径去注册，
/// 与「包目录直接摊在工作区根下」不符。找不到就是还没解压过。
fn extracted_wsa(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.join("filelist.txt").is_file() && pkg_ready(p))
}

/// `pkg` 是否**完整解压**：包内 `filelist.txt` 列出的每一项都真实存在。
/// 这就是 Install.ps1 自己用的完整性判据 —— 解压工具在包被截断时常常"能解的先解、
/// 不报错"，若只按「存在 Run.bat」判，用户机器上那种缺 22 个关键文件的半成品
/// 就会漏过去，直接跳到 Run.bat 然后装失败。
fn pkg_ready(pkg: &Path) -> bool {
    // 7z 里还套着一层同名目录（`pkg\WSA_2407.40000.4.0_x64\filelist.txt`），按名去找
    let Some(list) = find_file(pkg, "filelist.txt") else {
        return false; // 连清单都没有，肯定没解压完
    };
    let Ok(text) = std::fs::read_to_string(&list) else {
        return false;
    };
    // 清单里是相对路径，基准是清单所在目录
    let base = list.parent().unwrap_or(pkg);
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .all(|l| base.join(l).exists())
}

/// 下载中的临时文件名（`wsa.7z` → `wsa.7z.part`）。
/// **只有下完才会改名成最终名** —— 所以「最终文件存在」就等于「下载已完成」，
/// 被中止 / 断网留下的 `.part` 下次用 HTTP Range 接着下，不用从头再来。
fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    dest.with_file_name(format!("{name}.part"))
}

/// 流式下载到 `dest`，按 250ms 节流上报进度，支持**断点续传**与**中止**。
///
/// - 已有 `dest.part` 就带 `Range: bytes=<已下字节>-` 续传；服务端不支持续传
///   （不回 206 而是回 200）就从零重来。
/// - 每收一段查一次中止标志，中止时直接返回，`.part` 原样留着。
/// - `shared_client()` 没有默认超时：大文件（WSA 1.5GB）在慢网络下不能中途被掐断。
async fn download(
    app: &AppHandle,
    step: u8,
    label: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let mut req = crate::shared_client().get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("DOWNLOAD_FAILED::连接{label}下载地址失败（网络不通或被墙？）: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 206 {
        // 服务端按续传来了剩余部分，从断点接着写
    } else if status.is_success() {
        // 服务端不支持 Range（或本来就没下过）：从头开始
        have = 0;
    } else {
        return Err(format!(
            "DOWNLOAD_FAILED::下载{label}失败：HTTP {}",
            status.as_u16()
        ));
    }

    let total = have + resp.content_length().unwrap_or(0);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(have == 0)
        .open(&part)
        .map_err(|e| format!("NO_WRITE_PERMISSION::创建 {} 失败: {e}", part.display()))?;
    if have > 0 {
        file.seek(SeekFrom::End(0))
            .map_err(|e| format!("NO_WRITE_PERMISSION::定位 {} 失败: {e}", part.display()))?;
    }

    let mut received = have;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if CANCELLED.load(Ordering::SeqCst) {
            // 中止：不删 `.part`，下次从断点续传
            let _ = file.flush();
            return Err(format!(
                "{CANCEL_CODE}::下载{label}已中止（已下 {received} 字节，下次从这里继续）"
            ));
        }
        let chunk = chunk.map_err(|e| format!("DOWNLOAD_FAILED::下载{label}中断: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("NO_WRITE_PERMISSION::写入 {} 失败: {e}", part.display()))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            emit(
                app,
                step,
                "download",
                format!("正在下载{label}…"),
                received,
                total,
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .map_err(|e| format!("NO_WRITE_PERMISSION::落盘 {} 失败: {e}", part.display()))?;
    drop(file);

    if received == have {
        // 一个字节都没收到（新下载为空，或续传没给数据）
        return Err(format!("DOWNLOAD_FAILED::{label}没有收到数据（网络中断或地址失效），请稍后重试"));
    }
    // **收满才算下完**：CDN 在慢网下常常提前断流 —— 流正常结束、`received` 却没到 `total`。
    // 若不检查就改名成最终名，之后会被当成「已下载完成」直接去解压，必然报「安装包不完整」。
    // 这时保留 `.part`（下次带 Range 从断点续传），绝不改名。
    if total > 0 && received < total {
        return Err(format!(
            "DOWNLOAD_FAILED::{label}下载不完整（{received} / {total} 字节），连接可能被中断，请再点一次按钮从断点继续"
        ));
    }
    // 下完才改名：文件名本身就是「下载完成」的标记
    std::fs::rename(&part, dest).map_err(|e| {
        format!("NO_WRITE_PERMISSION::{} 改名失败: {e}", part.display())
    })?;
    emit(
        app,
        step,
        "download",
        format!("{label}下载完成"),
        received,
        total.max(received),
    );
    Ok(())
}

/// 在 `dir` 下（含至多 3 层子目录）按文件名找文件。
/// WSABuilds 的 7z 有时会把内容再套一层同名文件夹，所以不能只看根目录。
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut level = vec![dir.to_path_buf()];
    for _ in 0..4 {
        let mut next = Vec::new();
        for d in level {
            let Ok(entries) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    next.push(p);
                } else if p
                    .file_name()
                    .map(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
                    .unwrap_or(false)
                {
                    return Some(p);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    None
}

/// 去掉官方 `Install.ps1` **成功路径末尾**的「按任意键退出」。
///
/// 脚本最后是 `Write-Output "All Done!…Press any key to exit"` + 一个 `ReadKey`，
/// 而它跑在一个**提权出来的独立 PowerShell 窗口**里（Run.bat 用 `start` 拉起的），
/// 于是即便 WSA 早已注册成功，那个窗口也会一直挂着等按键，用户得自己去关。
///
/// 只改这一处：脚本里另有几处 `ReadKey`，那是「要不要重启 / 要不要卸载已有安装」的
/// **确认闸门**（其中一处的下一句就是无条件的 `Remove-AppxPackage`），自动放行会造成
/// 未经用户同意就卸载 —— 必须原样留给用户自己按。
///
/// 幂等：只有「`All Done!` 那行后面紧跟 `ReadKey`」时才动手，改过一次后再调就什么都不做。
fn defuse_final_pause(install_ps1: &Path) {
    let Ok(text) = std::fs::read_to_string(install_ps1) else {
        return;
    };
    let mut lines: Vec<&str> = text.lines().collect();
    let Some(i) = lines.iter().rposition(|l| l.contains("All Done!")) else {
        return;
    };
    // 认不出「All Done! 后面紧跟 ReadKey」这个形状就不动它，宁可窗口不合也别改错别的地方
    match lines.get(i + 1) {
        Some(next) if next.contains("ReadKey") => {}
        _ => return,
    }
    lines.truncate(i + 1);
    lines[i] = r#"Write-Output "All Done!""#;
    if std::fs::write(install_ps1, lines.join("\r\n") + "\r\n").is_ok() {
        eprintln!("[wsa] 已去掉 Install.ps1 末尾的「按任意键退出」，装完提权窗口会自动关闭");
    }
}

/// 删掉官方 `Install.ps1` 里的**自动拉起 APP** 那两行（`Finish` 函数里的
/// `Start-Process "wsa://com.topjohnwu.magisk"` / `"wsa://com.android.vending"`）。
///
/// 为什么要删：注册成功后脚本会立刻把 Magisk 和 Play 商店拉起来，而 WSA 里**首次**运行的
/// APP 会弹出一连串权限申请（位置等）。这些框是**模态**的 —— 一出来就把界面盖住，
/// 并且因为 APP 冷启动耗时不定，弹出的**时间点完全没法预判**，正好砸在我们紧接着的
/// 自动开开发者模式 / 装 APK 上。我们只用 adb，这两个 APP 一个都不需要。
///
/// 只删**带 `wsa://` 的 Start-Process 行**：脚本里其余 `Start-Process`（提权重启自己、
/// 跑 MakePri、`WsaClient /shutdown` 等）都是安装必需，动不得。
fn strip_install_autolaunch(install_ps1: &Path) {
    let Ok(text) = std::fs::read_to_string(install_ps1) else {
        return;
    };
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("Start-Process \"wsa://"))
        .collect();
    if kept.len() == text.lines().count() {
        return; // 本来就没有（已处理过 / 上游改了写法），不动文件
    }
    if std::fs::write(install_ps1, kept.join("\r\n") + "\r\n").is_ok() {
        eprintln!("[wsa] 已删掉 Install.ps1 里自动拉起 Magisk / Play 商店的两行，避免首启权限弹窗");
    }
}

/// `MakePri.ps1` 与 `makepri.exe` 都还在 = 中文资源**还没**合并过。
/// 判据很可靠：脚本跑成功后会把这两个文件连同 `pri` / `xml` 一起删掉（见其末尾几行）。
fn pri_pending(dir: &Path) -> bool {
    dir.join("MakePri.ps1").is_file() && dir.join("makepri.exe").is_file()
}

/// 从包目录的 `AppxManifest.xml` 里删掉 WSA 声明的三条 `DeviceCapability`。
///
/// 为什么删：宿主侧那个能力授权框（`Shell_SystemDialog`，宿主进程 `PickerHost`）会弹，
/// 前提是**这个包声明了对应能力**。清单里没有它，"要不要问用户"这一步根本不会发生 ——
/// WSA 里的 APP 去请求时在宿主侧直接失败。看直播用不到相机 / 麦克风 / 位置，删掉零损失。
///
/// 为什么我们改了没事：
/// - 我们本来就是**开发模式注册目录**安装（`Install.ps1` 末段的
///   `Add-AppxPackage -Register .\AppxManifest.xml`），签名破坏不影响这种装法；
/// - 包内 `MakePri.ps1` 跑完会把自己删掉（见 [`pri_pending`]），此后没有任何步骤会重写
///   这份清单，我们的改动不会被覆盖。
///
/// **只删这三行**：`runFullTrust` / `packagedServices` / `packageManagement` 那些是 WSA
/// 能跑起来的前提，一个都不能动。
fn strip_wsa_device_capabilities(pkg_dir: &Path) {
    /// 要删掉的三个能力名（实测就是这三个在弹窗）
    const DROP: [&str; 3] = ["webcam", "microphone", "location"];
    /// 匹配 `<DeviceCapability Name="xxx"`，自闭合写法（`/>` 或 ` />`）都能盖上
    fn is_dropped(line: &str) -> bool {
        let t = line.trim();
        t.starts_with("<DeviceCapability Name=\"") && DROP.iter().any(|cap| t.starts_with(&format!("<DeviceCapability Name=\"{cap}\"")))
    }

    let manifest = pkg_dir.join("AppxManifest.xml");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return;
    };
    let kept: Vec<&str> = text.lines().filter(|l| !is_dropped(l)).collect();
    if kept.len() == text.lines().count() {
        return; // 本来就没有（已处理过 / 上游改了写法），不动文件
    }
    if std::fs::write(&manifest, kept.join("\r\n") + "\r\n").is_ok() {
        eprintln!(
            "[wsa] 已从 AppxManifest.xml 删掉 webcam / microphone / location 三条设备能力声明（从源头掐掉权限弹窗）"
        );
    }
}

/// 跑分包自带的 `MakePri.ps1`，把中文资源合进 `resources.pri` / `AppxManifest.xml`。
///
/// 为什么要补这一步：分发包里的 `resources.pri` 只声明了 `EN-GB` / `EN-US`，中文资源
/// （`pri/resources.language-zh-hans.pri`、`xml/resources.language-zh-hans.xml`）明明都在包里，
/// 却从没被合并 —— 注册出来的 WSA 设置界面于是**永远是英文**，装完在「设置 → 系统 → 语言」
/// 里怎么切都没用。上游 `Install.ps1` 本来会在注册前调它，但只判断「脚本文件在不在」：
/// 上次装到一半中断、或我们提前从修复分支返回过，它就再也不会被调用。
///
/// 必须在 `run_run_bat` **之前**跑：注册时读的就是此刻的 `resources.pri` / manifest。
/// 脚本自己收尾（重建 pri、把语言声明写回 manifest、删掉 `pri`/`xml`/`makepri.exe`/自身，
/// 并同步更新 `filelist.txt` 的清单），所以跑完再调不会重复执行、`pkg_ready` 也不会失真。
/// 失败**不拦路**：最坏不过是界面仍旧英文，不值得为它把整个安装卡住。
async fn merge_pri_resources(dir: &Path) {
    let dir = dir.to_path_buf();
    let script = dir.join("MakePri.ps1");
    let out = tauri::async_runtime::spawn_blocking(move || {
        let script_s = script.to_string_lossy().to_string();
        // MakePri.ps1 里全是相对路径（`.\pri`、`.\xml`、`.\AppxManifest.xml`），
        // 必须把工作目录设在包根，否则会去别处找、或者把文件写到别处。
        Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script_s.as_str()])
            .current_dir(&dir)
            .creation_flags(CREATE_NO_WINDOW.0)
            .output()
    })
    .await;
    match out {
        Ok(Ok(o)) if o.status.success() => {
            eprintln!("[wsa] 已合并 WSA 中文资源，设置界面将跟随系统语言");
        }
        Ok(Ok(o)) => eprintln!(
            "[wsa] WSA 资源合并失败（设置界面可能仍是英文）：{}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Ok(Err(e)) => eprintln!("[wsa] 无法启动 MakePri.ps1：{e}"),
        Err(e) => eprintln!("[wsa] WSA 资源合并任务异常：{e}"),
    }
}

/// 以管理员身份运行 Run.bat，等它结束（UAC 弹窗由用户确认），期间可被中止。
///
/// **不能**用 `Start-Process -Wait`：提权后的进程脱离了 PowerShell 的作业对象，
/// `-Wait` 对它是不可靠的（可能立刻返回、也可能永远不返回）—— 之前"安装过程被中断"
/// 多半就是这里：外层 PowerShell 早早退出、流程以为装完了，或者干等着永不返回。
/// 改成 `-PassThru` 拿 PID，再自己轮询进程是否还在（顺便查中止标志）。
async fn run_run_bat(bat: &Path) -> Result<(), String> {
    let bat = bat.to_path_buf();
    let cwd = bat.parent().map(Path::to_path_buf).unwrap_or_default();

    // 只负责把提权进程拉起来并把 PID 打到 stdout，拿到就退出（不等它）
    let bat_s = bat.to_string_lossy().replace('\'', "''");
    let cwd_s = cwd.to_string_lossy().replace('\'', "''");
    let script = format!(
        "(Start-Process -FilePath '{bat_s}' -WorkingDirectory '{cwd_s}' -Verb RunAs -PassThru).Id"
    );
    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW.0)
            .output()
    })
    .await
    .map_err(|e| format!("WSA_INSTALL_FAILED::启动安装任务异常: {e}"))?
    .map_err(|e| format!("WSA_INSTALL_FAILED::无法启动安装脚本: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "WSA_INSTALL_FAILED::安装脚本未启动（可能取消了管理员授权）：{}",
            msg.trim()
        ));
    }
    let pid: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| "WSA_INSTALL_FAILED::拿不到安装进程号，请手动以管理员身份运行 Run.bat".to_string())?;

    // 轮询等待：进程还在 → 继续等；用户点了中止 → 立刻收手
    loop {
        if CANCELLED.load(Ordering::SeqCst) {
            // 提权进程不属于我们能杀的范围，只能不再等它
            return Err(format!(
                "{CANCEL_CODE}::已中止等待 WSA 安装。管理员安装窗口可能仍在运行，请自行关闭；已完成的部分会保留"
            ));
        }
        if !process_alive(pid) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

/// 进程是否还活着（`taskkill` 查不了，用 `tasklist` 按 PID 过滤）。
fn process_alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .output();
    match out {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.contains(&pid.to_string())
        }
        // 查不到就当它还活着，宁可按老行为继续等，也别误判成"装完了"
        Err(_) => true,
    }
}