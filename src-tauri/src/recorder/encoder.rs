//! Media Foundation H.264 编码器封装（SinkWriter）。
//!
//! 输入形态固定为「CPU 系统内存样本」：WGC 给的 BGRA 纹理先 `CopySubresourceRegion`
//! 裁掉顶部标题栏并拷进 `USAGE_STAGING` 纹理，`Map` 读回后逐行 memcpy 进
//! `MFCreateMemoryBuffer`，再打成 `IMFSample` 写进 SinkWriter。
//!
//! 试过直接喂 `MFCreateDXGISurfaceBuffer` 的 DXGI 纹理（另挂 D3D 设备管理器 /
//! `VIDEO_SUPPORT` / `MISC_SHARED` / `SetMultithreadProtected` 四种修法），`WriteSample`
//! 恒定返回 `E_INVALIDARG`，故不采用。CPU staging 是 SinkWriter 最标准、最兼容的输入形态。
#![cfg(windows)]

use std::path::Path;
use std::sync::OnceLock;

use windows::core::{HSTRING, Interface};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, D3D11_BOX,
    D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaType, IMFSample, IMFSinkWriter,
    MFCreateAttributes, MFCreateDXGIDeviceManager, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Video, MFStartup, MFSTARTUP_LITE,
    MFVideoFormat_ARGB32, MFVideoFormat_H264, MFVideoInterlace_Progressive,
    MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_D3D_MANAGER, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// 目标码率：固定 4 Mbps。900×1700 竖屏手机画面这个量级足够清晰
/// （B 站直播源本身就在 2~6 Mbps），15 秒片段约 7.5MB。
pub const BITRATE: u32 = 4_000_000;
/// 目标帧率
pub const FPS: u32 = 30;
/// 单帧时长（100ns 单位），同时用作 `SetSampleDuration`
pub const FRAME_DUR: i64 = 10_000_000 / FPS as i64;

/// MF 只需在进程内初始化一次（不配对 `MFShutdown`：应用长期运行，保持初始化更省事，
/// 也避免会话反复起停时的初始化竞争）。
static MF_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_mf() -> Result<(), String> {
    // RPC_E_CHANGED_MODE 属正常情况（线程已有其他套间模型），忽略返回值
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    MF_INIT
        .get_or_init(|| unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_LITE)
                .map_err(|e| format!("ENCODER_INIT_FAILED::MFStartup 失败: {e}"))
        })
        .clone()
}

/// MF 的属性打包：高 32 位 | 低 32 位（对应 C++ 的 MFSetAttributeSize / MFSetAttributeRatio）
fn pack2(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

/// 一路 H.264 输出。会话级对象，跨帧持有暂存纹理与 SinkWriter。
pub struct Encoder {
    writer: IMFSinkWriter,
    stream: u32,
    /// 输出（裁掉标题栏后）的尺寸
    ow: u32,
    oh: u32,
    /// 顶部裁掉的高度（WSA 标题栏）
    crop_top: u32,
    /// 跨帧复用的暂存纹理：尺寸不变就重复用，避免每帧新建纹理的分配抖动
    stage: Option<ID3D11Texture2D>,
}

impl Encoder {
    /// 建立一路 H.264 编码输出到 `path`（纯视频，不录声音）。
    ///
    /// `device` 用于挂 `MF_SINK_WRITER_D3D_MANAGER`（硬编优先，MF 自带软件 H.264 编码器兜底）。
    pub fn new(
        path: &Path,
        device: &ID3D11Device,
        ow: u32,
        oh: u32,
        crop_top: u32,
    ) -> Result<Self, String> {
        ensure_mf()?;
        unsafe { Self::new_inner(path, device, ow, oh, crop_top) }
    }

    unsafe fn new_inner(
        path: &Path,
        device: &ID3D11Device,
        ow: u32,
        oh: u32,
        crop_top: u32,
    ) -> Result<Self, String> {
        macro_rules! step {
            ($label:expr, $e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(err) => return Err(format!("ENCODER_INIT_FAILED::{} 失败: {err}", $label)),
                }
            };
        }

        let mut attrs_opt: Option<IMFAttributes> = None;
        step!("MFCreateAttributes", MFCreateAttributes(&mut attrs_opt, 3));
        let attrs = attrs_opt.unwrap();
        step!(
            "SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS)",
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
        );
        // 挂 D3D 设备管理器：让 SinkWriter 走硬件编码器（样本由 MF 自己上传到 GPU）
        let mut mgr_opt: Option<IMFDXGIDeviceManager> = None;
        let mut reset_token = 0u32;
        step!(
            "MFCreateDXGIDeviceManager",
            MFCreateDXGIDeviceManager(&mut reset_token, &mut mgr_opt)
        );
        let mgr = mgr_opt.unwrap();
        step!("ResetDevice", mgr.ResetDevice(device, reset_token));
        step!(
            "SetUnknown(MF_SINK_WRITER_D3D_MANAGER)",
            attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &mgr)
        );

        let path_w = HSTRING::from(path.as_os_str());
        let writer: IMFSinkWriter =
            step!("MFCreateSinkWriterFromURL", MFCreateSinkWriterFromURL(&path_w, None, Some(&attrs)));

        // ---- 输出类型：H264 ----
        let out_type: IMFMediaType = step!("MFCreateMediaType(out)", MFCreateMediaType());
        let out_attrs: IMFAttributes = step!("cast IMFAttributes(out)", out_type.cast());
        step!(
            "out.SetGUID(MAJOR_TYPE)",
            out_attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        );
        step!(
            "out.SetGUID(SUBTYPE)",
            out_attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
        );
        step!(
            "out.SetUINT32(AVG_BITRATE)",
            out_attrs.SetUINT32(&MF_MT_AVG_BITRATE, BITRATE)
        );
        // windows-rs 没有 MFSetAttributeSize/Ratio（那是 C++ inline helper），手工打包
        step!(
            "out.SetUINT64(FRAME_SIZE)",
            out_attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack2(ow, oh))
        );
        step!(
            "out.SetUINT64(FRAME_RATE)",
            out_attrs.SetUINT64(&MF_MT_FRAME_RATE, pack2(FPS, 1))
        );
        step!(
            "out.SetUINT32(INTERLACE_MODE)",
            out_attrs.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        );
        let stream = step!("AddStream", writer.AddStream(&out_type));

        // ---- 输入类型：ARGB32（WGC 给的就是 BGRA，MF 里叫 ARGB32）----
        let in_type: IMFMediaType = step!("MFCreateMediaType(in)", MFCreateMediaType());
        let in_attrs: IMFAttributes = step!("cast IMFAttributes(in)", in_type.cast());
        step!(
            "in.SetGUID(MAJOR_TYPE)",
            in_attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        );
        step!(
            "in.SetGUID(SUBTYPE)",
            in_attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_ARGB32)
        );
        step!(
            "in.SetUINT64(FRAME_SIZE)",
            in_attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack2(ow, oh))
        );
        step!(
            "in.SetUINT64(FRAME_RATE)",
            in_attrs.SetUINT64(&MF_MT_FRAME_RATE, pack2(FPS, 1))
        );
        step!(
            "in.SetUINT64(PIXEL_ASPECT_RATIO)",
            in_attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack2(1, 1))
        );
        step!(
            "in.SetUINT32(INTERLACE_MODE)",
            in_attrs.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        );
        step!(
            "in.SetUINT32(ALL_SAMPLES_INDEPENDENT)",
            in_attrs.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)
        );
        step!(
            "SetInputMediaType",
            writer.SetInputMediaType(stream, &in_type, None)
        );

        // 必须先 BeginWriting，否则 WriteSample/Finalize 一律返回 MF_E_INVALIDREQUEST(0xC00D36B2)
        step!("BeginWriting", writer.BeginWriting());

        Ok(Self {
            writer,
            stream,
            ow,
            oh,
            crop_top,
            stage: None,
        })
    }

    /// 把一帧采集纹理裁掉顶部 `crop_top` 后编码写入。`pts` 单位 100ns，相对首帧。
    pub fn write_frame(
        &mut self,
        ctx: &ID3D11DeviceContext,
        device: &ID3D11Device,
        src: &ID3D11Texture2D,
        pts: i64,
    ) -> Result<(), String> {
        unsafe { self.write_frame_inner(ctx, device, src, pts) }
    }

    unsafe fn write_frame_inner(
        &mut self,
        ctx: &ID3D11DeviceContext,
        device: &ID3D11Device,
        src: &ID3D11Texture2D,
        pts: i64,
    ) -> Result<(), String> {
        macro_rules! step {
            ($label:expr, $e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(err) => return Err(format!("ENCODE_FAILED::{} 失败: {err}", $label)),
                }
            };
        }
        let (ow, oh) = (self.ow, self.oh);

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        src.GetDesc(&mut desc);

        // 裁掉顶部标题栏：src box 从 (0, crop_top) 取 ow × oh
        let bx = D3D11_BOX {
            left: 0,
            top: self.crop_top,
            front: 0,
            right: ow.min(desc.Width),
            bottom: (self.crop_top + oh).min(desc.Height),
            back: 1,
        };
        let src_res: ID3D11Resource = step!("src.cast<ID3D11Resource>", src.cast());

        // ---- 暂存纹理读回 → 拷进 MF 系统内存样本 ----
        let stage = match self.stage.take() {
            Some(t) => t,
            None => {
                let stage_desc = D3D11_TEXTURE2D_DESC {
                    Width: ow,
                    Height: oh,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut stage_opt: Option<ID3D11Texture2D> = None;
                step!(
                    "CreateTexture2D(staging)",
                    device.CreateTexture2D(&stage_desc, None, Some(&mut stage_opt))
                );
                stage_opt.unwrap()
            }
        };
        let stage_res: ID3D11Resource = step!("stage.cast<ID3D11Resource>", stage.cast());
        // CopySubresourceRegion 在 windows-rs 里直接返回 ()（内部就忽略了 HRESULT），不能套 step!
        ctx.CopySubresourceRegion(&stage_res, 0, 0, 0, 0, &src_res, 0, Some(&bx));

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        step!(
            "Map",
            ctx.Map(&stage_res, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        );

        let row = (ow as usize) * 4;
        let total = (row * oh as usize) as u32;
        let buf: IMFMediaBuffer = step!("MFCreateMemoryBuffer", MFCreateMemoryBuffer(total));
        let mut ptr: *mut u8 = std::ptr::null_mut();
        step!("buffer.Lock", buf.Lock(&mut ptr, None, None));
        // 逐行拷贝：staging 的 RowPitch 可能大于 ow*4，不能整体 memcpy
        for y in 0..oh as usize {
            let src_row = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
            std::ptr::copy_nonoverlapping(src_row, ptr.add(y * row), row);
        }
        step!("buffer.Unlock", buf.Unlock());
        ctx.Unmap(&stage_res, 0);
        step!("SetCurrentLength", buf.SetCurrentLength(total));
        self.stage = Some(stage);

        let sample: IMFSample = step!("MFCreateSample", MFCreateSample());
        step!("AddBuffer", sample.AddBuffer(&buf));
        step!("SetSampleTime", sample.SetSampleTime(pts));
        step!("SetSampleDuration", sample.SetSampleDuration(FRAME_DUR));
        step!("WriteSample", self.writer.WriteSample(self.stream, &sample));
        Ok(())
    }

    /// 收尾：把 moov 写进文件。必须在停止采集之后、文件可播之前调用。
    pub fn finish(&mut self) -> Result<(), String> {
        unsafe {
            self.writer
                .Finalize()
                .map_err(|e| format!("ENCODE_FAILED::Finalize 失败: {e}"))
        }
    }
}