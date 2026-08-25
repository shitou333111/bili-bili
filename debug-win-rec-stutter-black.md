# Debug Session: win-rec-stutter-black

- Status: [OPEN]
- SessionId: `win-rec-stutter-black`
- Symptoms: Windows 端录制长视频，开始卡顿，中间黑屏 1-2 秒。
- Reproduction: 复现时需在 Windows 上触发一次长视频礼物录屏保存。
- Env: Windows / Tauri / GiftReplayPanel.tsx

## Hypotheses (待验证)
- A. 中段黑屏 = 停滞看门狗在 recording 期间触发 `rebuildHlsRef`（重建销毁 `<video>` 源）→ 画布无画面 → 黑帧进文件。
- B. 中段黑屏 = 跨 run 主动 seek（`currentTime = nextStart`）一瞬间 hls 未就绪 → 短暂无源黑帧。
- C. 开始卡顿 = `live.currentTime = safeStartPos(0)` seek 到缓冲起点附近引发短暂 re-buffer；首个 keyframe/编码器预热阶段帧率低。
- D. 开始卡顿 = 录制按墙钟 `setTimeout(totalSec*1000)`，与真实播放进度漂移；或 `videoBitsPerSecond` 在长视频被压得过低，画面质量/帧率不足但非黑。
- E. 记录截止不准：墙钟计时与实际播完偏离 → 结尾多录一段黑/静态。

## Instrumentation Points
- P1 doSave 开始 seek/首帧等待前后时间点（A/C）
- P2 doSave stop 判定（墙钟 vs 进度）时点（D/E）
- P3 看门狗：停滞时走到 gentle(startLoad) 还是 rebuild（A）
- P4 跨 run seek 触发点（B）
- P5 canvas 是否产生黑帧（videoReady 状态 + 是否在 rebuild 窗口内）

## Plan
1. 插桩（本文件首个业务改动仅为埋点）
2. 用户复现录制 → 收集日志
3. 依证据确认/否决假设 → 最小修复
4. 复现验证 pre/post → 用户确认后清理