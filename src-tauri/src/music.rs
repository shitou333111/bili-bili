//! 点歌机本地音乐控制桥（仅 Windows）。
//!
//! 前端 invoke → 本模块 → 常驻 PowerShell worker 子进程（music_worker.ps1）→ 酷狗/QQ音乐/网易云。
//! worker 通过 stdin/stdout 逐行 JSON 通信（一行请求、一行响应），日志只走 stderr。
//! 脚本用 `include_str!` 内嵌，运行时落到临时目录，安装目录只读 / 单文件打包也能跑。

use serde_json::Value;

/// 读取指定平台当前播放状态。
#[tauri::command]
pub async fn music_state(platform: String) -> Result<Value, String> {
    imp::state(platform).await
}

/// 按歌曲 id 播放。
/// - mode="replace"：直接点播（orpheus / 酷狗 / QQ 原生协议）
/// - mode="next"：插到「下一首播放」，不打断当前曲（仅网易云 + 已开启 CDP 调试端口）
#[tauri::command]
pub async fn music_play(platform: String, song_id: String, mode: String) -> Result<Value, String> {
    if mode != "replace" && mode != "next" {
        return Err(format!("暂不支持的播放模式: {mode}（目前仅支持 replace / next）"));
    }
    imp::play(platform, song_id, mode).await
}

/// 探测三个音乐软件是否在运行 / 是否已安装。
#[tauri::command]
pub async fn music_probe() -> Result<Value, String> {
    imp::probe().await
}

/// 带调试端口重启网易云（会中断当前播放）。
/// 仅支持网易云：调试端口只能由启动参数开启，重启是唯一补救方式。
#[tauri::command]
pub async fn music_restart(platform: String) -> Result<Value, String> {
    if platform != "netease" {
        return Err(format!("暂不支持重启该平台: {platform}"));
    }
    imp::restart(platform).await
}

#[cfg(windows)]
mod imp {
    use super::Value;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::sync::OnceLock;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::{Child, ChildStdin, ChildStdout, Command};
    use tokio::sync::Mutex;

    /// 单次请求的响应上限（worker 里酷狗握手最长轮询 5s，留足余量）
    const WORKER_TIMEOUT: Duration = Duration::from_secs(30);
    /// 播放请求上限：要覆盖「客户端冷启动 + 握手 + 下发 + 播放确认」，
    /// 酷狗未运行时会先被拉起（最长等 20s）再握手（最长 20s）。
    const PLAY_TIMEOUT: Duration = Duration::from_secs(75);
    /// 重启网易云的上限：关旧进程 + 等新进程端口就绪，最长约 27s（留余量）
    const RESTART_TIMEOUT: Duration = Duration::from_secs(60);
    /// 内嵌 worker 脚本（编译期打进二进制）
    const WORKER_SCRIPT: &str = include_str!("music_worker.ps1");
    /// CREATE_NO_WINDOW：不弹黑框
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    struct Worker {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();

    fn worker_mutex() -> &'static Mutex<Option<Worker>> {
        WORKER.get_or_init(|| Mutex::new(None))
    }

    /// 把内嵌脚本写到临时目录（每次启动重写，保证与二进制版本一致）
    fn script_path() -> Result<PathBuf, String> {
        let dir = std::env::temp_dir().join("bili-music-worker");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 music worker 目录失败: {e}"))?;
        let path = dir.join("music_worker.ps1");
        // 必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 脚本按系统 ANSI 解码，
        // 脚本里的中文会乱码，个别多字节序列还会把引号吃掉导致语法错误。
        let mut bytes = Vec::with_capacity(WORKER_SCRIPT.len() + 3);
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        bytes.extend_from_slice(WORKER_SCRIPT.as_bytes());
        std::fs::write(&path, bytes).map_err(|e| format!("写入 music_worker.ps1 失败: {e}"))?;
        Ok(path)
    }

    fn spawn_worker() -> Result<Worker, String> {
        let script = script_path()?;
        let mut cmd = Command::new("powershell.exe");
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("启动 music worker 失败: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "music worker stdin 不可用".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "music worker stdout 不可用".to_string())?;
        Ok(Worker {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// 写一行请求并读一行响应
    async fn exchange(w: &mut Worker, line: &str, timeout: Duration) -> Result<Value, String> {
        w.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写入 music worker 失败: {e}"))?;
        w.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写入 music worker 失败: {e}"))?;
        w.stdin
            .flush()
            .await
            .map_err(|e| format!("刷新 music worker 输入失败: {e}"))?;

        let mut buf = String::new();
        let n = tokio::time::timeout(timeout, w.stdout.read_line(&mut buf))
            .await
            .map_err(|_| format!("music worker 响应超时（{}s）", timeout.as_secs()))?
            .map_err(|e| format!("读取 music worker 响应失败: {e}"))?;
        if n == 0 {
            return Err("music worker 已退出".to_string());
        }
        let text = buf.trim();
        serde_json::from_str(text).map_err(|e| format!("music worker 响应解析失败: {e}; raw={text}"))
    }

    /// 串行请求 worker；进程异常（退出/超时/坏 JSON）时重启一次并重试
    async fn request(req: Value) -> Result<Value, String> {
        request_with_timeout(req, WORKER_TIMEOUT).await
    }

    async fn request_with_timeout(req: Value, timeout: Duration) -> Result<Value, String> {
        let line = serde_json::to_string(&req).map_err(|e| format!("序列化请求失败: {e}"))?;
        let mut guard = worker_mutex().lock().await;
        if guard.is_none() {
            *guard = Some(spawn_worker()?);
        }
        match exchange(guard.as_mut().unwrap(), &line, timeout).await {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("[music] worker 交互失败，重启一次后重试: {e}");
                if let Some(mut old) = guard.take() {
                    let _ = old.child.kill().await;
                }
                *guard = Some(spawn_worker()?);
                exchange(guard.as_mut().unwrap(), &line, timeout).await
            }
        }
    }

    pub async fn state(platform: String) -> Result<Value, String> {
        request(json!({ "cmd": "state", "platform": platform })).await
    }

    pub async fn play(platform: String, song_id: String, mode: String) -> Result<Value, String> {
        request_with_timeout(
            json!({
                "cmd": "play",
                "platform": platform,
                "song_id": song_id,
                "mode": mode
            }),
            PLAY_TIMEOUT,
        )
        .await
    }

    pub async fn restart(platform: String) -> Result<Value, String> {
        request_with_timeout(
            json!({ "cmd": "restart", "platform": platform }),
            RESTART_TIMEOUT,
        )
        .await
    }

    /// 进程名（映像名）是否在运行；QQ 音乐的常驻/播放进程可能叫 QQMusicExternal.exe
    fn running(names: &[&str]) -> bool {
        names.iter().any(|n| !crate::wsa::process_ids(n).is_empty())
    }

    fn installed(paths: &[&str]) -> bool {
        paths.iter().any(|p| Path::new(p).exists())
    }

    pub async fn probe() -> Result<Value, String> {
        let apps = vec![
            json!({
                "platform": "netease",
                "running": running(&["cloudmusic.exe"]),
                "installed": installed(&[
                    r"C:\Program Files\NetEase\CloudMusic\cloudmusic.exe",
                    r"C:\Program Files (x86)\NetEase\CloudMusic\cloudmusic.exe",
                ]),
            }),
            json!({
                "platform": "qq",
                "running": running(&["QQMusic.exe", "QQMusicExternal.exe"]),
                "installed": installed(&[
                    r"C:\Program Files (x86)\Tencent\QQMusic\QQMusic.exe",
                    r"C:\Program Files\Tencent\QQMusic\QQMusic.exe",
                ]),
            }),
            json!({
                "platform": "kugou",
                "running": running(&["KuGou.exe"]),
                "installed": installed(&[
                    r"C:\Program Files\KuGou\KGMusic\KuGou.exe",
                    r"C:\Program Files (x86)\KuGou\KGMusic\KuGou.exe",
                ]),
            }),
        ];
        Ok(json!({ "apps": apps }))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Value;

    pub async fn state(_platform: String) -> Result<Value, String> {
        Err("unsupported platform".to_string())
    }

    pub async fn play(_platform: String, _song_id: String, _mode: String) -> Result<Value, String> {
        Err("unsupported platform".to_string())
    }

    pub async fn probe() -> Result<Value, String> {
        Err("unsupported platform".to_string())
    }

    pub async fn restart(_platform: String) -> Result<Value, String> {
        Err("unsupported platform".to_string())
    }
}
