//! B 站 APP 的音频会话静音。
//!
//! 录制是**纯视频**（不采音频），这个模块只做两件事：
//! 1. 存「期望的静音状态」（overlay 的静音按钮写它，常驻静音守护线程读它）；
//! 2. 把一个 pid 的**全部**音频会话静音/取消静音（`ISimpleAudioVolume::SetMute`）。
//!
//! 为什么用 per-session 的 `ISimpleAudioVolume::SetMute` 而不是 `IAudioEndpointVolume`：
//! 后者是端点级（整机），一静音所有程序都没声；前者只作用于目标进程自己的会话，
//! 整机与其它程序的音量、静音状态一概不动。
//!
//! 「谁来落实」见 `wsa::start_mute_guard`：音频会话是 APP **开始播音那一刻**才建出来的
//! （换播放器 / 换线路还会重建），所以必须有个常驻线程反复落实，只在某一刻设一次必然漏。
#![cfg(windows)]

use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::{Interface, GUID};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
    ISimpleAudioVolume,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

/// `CLSID_MMDeviceEnumerator`（windows-rs 未导出，按官方值手写）
const CLSID_MMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xBCDE0395_E52F_467C_8E3D_C4579291692E);

/// 期望的静音状态。默认静音：录屏是纯视频，全程不外放 APP 声音；
/// 想看 / 想听再点一下 overlay 上的静音按钮取消。
static MUTED: AtomicBool = AtomicBool::new(true);

/// 读期望静音状态（overlay 画按钮图标、守护线程决定「静音」还是「取消静音」都读它）
pub fn muted() -> bool {
    MUTED.load(Ordering::Relaxed)
}

/// 写期望静音状态。overlay 的按钮只翻转它 —— 真正落到音频会话上由守护线程在下一拍
/// （≤50ms）完成，所以这里不做任何耗时操作，点了按钮立刻就有反馈。
pub fn set_muted(v: bool) {
    MUTED.store(v, Ordering::Relaxed);
}

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

/// 只静音「目标进程」的音频会话，其它程序与整机音量都不动。
///
/// 目标进程当前**一个音频会话都没有**时返回 `Err`（APP 还没开始播音），
/// 调用方（守护线程）下一拍再试即可，不必当失败处理。
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

/// 默认播放设备上属于 `pid` 的全部音频会话（WSA 可能同时有多路会话在出声；
/// APP 换播放器 / 换线路时还会多出新的会话，所以每一拍都重新枚举）
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