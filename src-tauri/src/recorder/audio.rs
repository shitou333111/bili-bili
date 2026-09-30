//! B 站 APP 的音频会话静音（overlay 标题栏静音按钮的后端）。
//!
//! 录制是**纯视频**（不采音频），这里只负责一件事：把「WSA 里 B 站 APP 那一进程」
//! 的音频会话静音/取消静音。
//!
//! 为什么用 per-session 的 `ISimpleAudioVolume::SetMute` 而不是 `IAudioEndpointVolume`：
//! 后者是端点级（整机），一静音所有程序都没声；前者只作用于目标进程自己的会话，
//! 整机与其它程序的音量、静音状态一概不动。
#![cfg(windows)]

use std::ptr;

use windows::core::{Interface, GUID};
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
    ISimpleAudioVolume,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

/// `CLSID_MMDeviceEnumerator`（windows-rs 未导出，按官方值手写）
const CLSID_MMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xBCDE0395_E52F_467C_8E3D_C4579291692E);

/// 默认播放设备
unsafe fn default_render_device() -> Result<IMMDevice, String> {
    let en: IMMDeviceEnumerator = CoCreateInstance(&CLSID_MMDEVICE_ENUMERATOR, None, CLSCTX_ALL)
        .map_err(|e| format!("AUDIO_MUTE_FAILED::创建设备枚举器失败: {e}"))?;
    en.GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("AUDIO_MUTE_FAILED::取默认播放设备失败: {e}"))
}

/// 从 `IMMDevice` 上激活一个接口（`IMMDevice::Activate` 本身就是泛型包装）
unsafe fn activate<T: Interface>(dev: &IMMDevice) -> Result<T, String> {
    dev.Activate::<T>(CLSCTX_ALL, None)
        .map_err(|e| format!("AUDIO_MUTE_FAILED::Activate 失败: {e}"))
}

/// 静音目标的确认：环境变量 `BILI_AUDIO_PID` 优先（排查用），
/// 否则在默认播放设备的音频会话里找「正在出声」的那个进程；
/// 都拿不到就退回 B 站 APP 窗口所属进程。
pub fn resolve_target_pid(window_pid: u32) -> u32 {
    if let Ok(v) = std::env::var("BILI_AUDIO_PID") {
        if let Ok(p) = v.trim().parse::<u32>() {
            return p;
        }
    }
    unsafe { loudest_session_pid(window_pid).unwrap_or(window_pid) }
}

unsafe fn loudest_session_pid(prefer: u32) -> Option<u32> {
    let dev = default_render_device().ok()?;
    let mgr: IAudioSessionManager2 = activate(&dev).ok()?;
    let sessions = mgr.GetSessionEnumerator().ok()?;
    let count = sessions.GetCount().ok()?;
    let me = std::process::id();

    let mut best: Option<(f32, u32)> = None;
    for i in 0..count {
        let Ok(ctl) = sessions.GetSession(i) else {
            continue;
        };
        let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        let pid = c2.GetProcessId().unwrap_or(0);
        if pid == 0 || pid == me {
            continue;
        }
        if pid == prefer {
            return Some(pid);
        }
        let peak = ctl
            .cast::<IAudioMeterInformation>()
            .ok()
            .and_then(|m| m.GetPeakValue().ok())
            .unwrap_or(0.0);
        if peak > 0.0001 && best.map_or(true, |(bp, _)| bp < peak) {
            best = Some((peak, pid));
        }
    }
    best.map(|(_, pid)| pid)
}

/// 只静音「目标进程」的音频会话，其它程序与整机音量都不动。
pub fn set_process_mute(pid: u32, mute: bool) -> Result<(), String> {
    unsafe {
        let vols = session_volumes(pid)?;
        if vols.is_empty() {
            return Err(format!("AUDIO_MUTE_FAILED::没找到 pid {pid} 的音频会话"));
        }
        for v in &vols {
            v.SetMute(mute, ptr::null())
                .map_err(|e| format!("AUDIO_MUTE_FAILED::设置会话静音失败: {e}"))?;
        }
        Ok(())
    }
}

/// 默认播放设备上属于 `pid` 的全部音频会话（WSA 可能同时有多路会话在出声）
unsafe fn session_volumes(pid: u32) -> Result<Vec<ISimpleAudioVolume>, String> {
    let dev = default_render_device()?;
    let mgr: IAudioSessionManager2 = activate(&dev)?;
    let sessions = mgr
        .GetSessionEnumerator()
        .map_err(|e| format!("AUDIO_MUTE_FAILED::枚举音频会话失败: {e}"))?;
    let count = sessions
        .GetCount()
        .map_err(|e| format!("AUDIO_MUTE_FAILED::取会话数量失败: {e}"))?;

    let mut out = Vec::new();
    for i in 0..count {
        let Ok(ctl) = sessions.GetSession(i) else {
            continue;
        };
        let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        if c2.GetProcessId().unwrap_or(0) != pid {
            continue;
        }
        if let Ok(v) = ctl.cast::<ISimpleAudioVolume>() {
            out.push(v);
        }
    }
    Ok(out)
}