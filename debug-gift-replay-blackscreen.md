# Debug Session: gift-replay-blackscreen

**Status**: [OPEN]

## 症状
1. 礼物录屏跨 run（场次/片段 DISCONTINUITY）切换时刻出现黑屏，观看与录制均受影响，全平台，低性能设备更明显。
2. 点击"录屏"后先有 2-3s 卡顿（录制已开始但画面/视频停滞）。
3. 每个 run 之间会出现上一 run 礼物动画的残留影像，上下方向撕裂（残影/鬼影）。

## 目标文件
`src/components/GiftReplayPanel.tsx`

## 关联已改动（勿回退）
- 已有 freezeCanvas 过渡遮罩 + transFreezingRef 冻结绘制（跨 run seek 时贴上一帧快照），用户报告未根治。需确认为何没兜住。
- 录制起点 `live.currentTime = safeStartPos(live,0)` + 首帧等待。

## 假设（falsifiable）
- A: 跨 run seek 后下一 run 首帧未就绪，但 `videoReady=live.videoWidth>0&&readyState>=2` 在 seek/重建后短暂为 false，freeze 未生效 → 画布回落到背景（非黑）或黑。需观测切换时刻 videoReady/seeking/currentTime。
- B: 跨 run 过渡期`settled`判定（`!live.seeking && currentTime>=transUntil-0.05`）过早/过晚，导致 freeze 提前解除 → draws black or stale。
- C: 点击录屏后 doSave 回拨 currentTime 到起点再 play → 触发 seek 重缓冲 + 首帧等待 loop，导致 2-3s 卡顿。
- D: MediaRecorder/captureStream 预热或首 chunk 耗时过长。
- E: 录制期间循环回绕被禁用，但跨 run 主动 seek/重建逻辑在录制中触发，与 recorder 抢同一帧流，导致周期黑屏。

## 插桩点
- P1 drawLoop 切换区：打印 videoReady/seeking/readyState/currentTime/transFreezing。
- P2 跨 run seek 触发：打印 nextStart/transUntil。
- P3 doSave 起始：seek 用时、首帧就绪耗时、rec.start 后首 chunk 耗时。

## 状态记录
- 2026-08-25 会话建立，Debug Server 端口 51999（高千位避开 7777 冲突）。
- 已埋点(仅插桩，未改业务逻辑)，tsc --noEmit 通过：
  - P1(GiftReplay:seek, hyp A, force)：跨 run seek 触发时上报 from/to/curRi/saving。
  - P2(GiftReplay:trans, hyp B, 120ms)：过渡期每帧上报 settled/seeking/ready/vw/ct/until/black(中心12x12最大分量)，用于判断"黑屏是否发生在 settle 后且 ready 未就绪"。
  - P3(GiftReplay:doSave, hyp C, force)：进入、seek+play 后、首帧就绪耗时(ms) 三处时间戳。
  - P4(GiftReplay:doSave, hyp D, force)：recorder started(自进入 ms) 与首个 ondataavailable 距 rec.start 的 ms。
- 待用户复现收集日志。
- 证据分析完成：
  - 症状1 根因确认(A/B)：跨 run seek 在同一帧内、`clearRect` 已清空画布但 `drawFrame` 尚未执行时快照 `canvasRef` 得到**黑帧**，过渡期贴上去即黑（F 探针：seek 后 `trans:true ready:1 bmax:0` 黑约200-300ms）。
  - 症状2 证据：`doSave:chunk` 首个非空 chunk 距 rec.start 约 3755/3784ms，仅 763 字节（近空）；F 探针显示录制期间画布内容正常 → 绘制正常但 MediaRecorder/captureStream 开头约3.5s无有效数据 → 录制输出开头空白/卡住。
- 已应用修复(业务逻辑)：
  - 症状1 修复：drawLoop 每帧末尾把完整合成帧复制到 freezeCanvasRef 留存；跨 run seek 不再当帧快照，直接复用该"上一张好帧"作为过渡遮罩。
  - 症状2 尚在取证：已加 `doSave:chunkall` 探针（记录前6s每个dataavailable含空chunk的 size/el/ct）。

## 诊断结论（第二轮 evidence）
- 症状1 关键证据：F 探针在每个 run 起始（ct=14/28/42/56）报 `trans:true ready:1 vw:1600 bmax:0` —— seek 后 readyState 消退到 1（仅 metadata、无当前帧），`videoReady=false`。
  - 此时 trans 块 `settled = !seeking && currentTime>=until-0.05` 过早为 true → `drawFrame` 被跳过 → 画布黑；
  - 且该黑帧又经 hold-frame 写入 freezeCanvasRef → **污染后续过渡遮罩**，导致每个 run 起点系统性黑屏。
  - 次证据：`trans:false ready:4 bmax:14-15` 出现在 run 内片段交接处（ct=61.5/66.6），为 run 内 DISCONTINUITY 解码间隙短暂黑。
- 症状2 关键证据：F 探针录制起始 `saving:true ct:0/0.3 ready:1 bmax:0` —— 录制开始时视频仅 metadata、画布黑；
  - 原等待条件 `currentTime > startT+0.03` 不可靠：seek 会推进播放头但不解码帧（readyState 停在 1），drawFrame 被跳过、画布黑 → captureStream 开头录的是黑屏/卡住。

## 已应用修复（第三轮 map-hold，runId=map-hold 待取证）
- 症状1：
  - trans 块 `settled` 增加 `videoReady` 要求：`!seeking && videoReady && currentTime>=until-0.05`。seek 刚结束时 readyState=1 时不再解除冻结，持续贴上一张好帧直到真正出帧。
  - hold-frame 仅在 `videoReady` 时才把当前帧写入 freezeCanvasRef，杜绝黑/未出帧污染过渡遮罩。
  - 非转场且 `!videoReady`（run 内片段交接/解码间隙）时贴上一张好帧兜底，避免黑闪。
- 症状2：
  - 录制前等待条件改为：`videoWidth>0 && readyState>=2 && 画布中心非黑(>20)` 才放行 captureStream，确保 drawLoop 已把视频首帧画上画布，录制开头不再是黑屏/卡住（仍 4s 上限兜底）。

## 已应用修复（第四轮 clean-base，针对症状3残影/鬼影）
- 症状3 根因：跨 run 冻结过渡贴的是**完整合成帧** freezeCanvasRef（含上一 run 末帧的礼物动画），同时下方 `idx>=0` 又会把**新 run 的动画**叠加其上 → 两个动画叠成"上下撕裂的残影/鬼影"。
- 修复：
  - 新增 `transBaseRef`：在 `else if (videoReady)` 分支 drawFrame 之后、尚未叠加特效/横幅前捕获"干净过渡基底"（背景+视频）。
  - 跨 run 冻结过渡期改贴 `transBaseRef`（干净基底），不再贴含动画的 freezeCanvasRef；chrome 仍由下方共享逻辑补画。
  - 过渡期间门控掉礼物特效叠加与送礼横幅（`if (idx >= 0 && !transFreezingRef.current)` / 横幅同理），杜绝新 run 动画叠加成鬼影。
  - 保留 freezeCanvasRef 仅用于 run 内 `!videoReady` 断裂时的就近兜底。
- 录制前等待条件同第三轮：`videoWidth>0 && readyState>=2 && 画布中心非黑(>20)`。

## 已应用修复（第五轮 progress-stop，针对"开头卡住占时长致尾巴被切"）
- 症状2 新认知（用户复现反馈）："录制总时长没变，前面卡住占用了几秒 → 最后几秒没录上，开头有第一个礼物动画撕裂残影"。
  - 根因：录制窗口是**固定 totalSec 墙钟计时** `setTimeout(totalSec*1000)`。低性能设备上首段 hls 起始缓冲会冻住播放头几秒（currentTime 停在 ≈0、画布贴死帧），此时 MediaRecorder 因画布无变化不产出数据 → "开头卡住几秒 + 死帧撕裂残影"；且停滞把内容整体后推，固定计时器在内容播完前就停止 → 末尾丢帧。
- 修复：
  1. 录制起点判定加入 "播放头确已前进"：等待条件改为 `videoWidth>0 && readyState>=2 && currentTime>0.02 && 画布中心非黑`，上限放宽到 8s。确保 captureStream 在播放真正流动、画布逐帧变化后才接管，把起始缓冲停滞排除在录制之外。
  2. 停止条件由固定时长改为**播放进度**：轮询等 `currentTime>=totalSec-1.0` 且播放头不再前进（B站真实时长略短于名义时长，到达真实末尾后会在死区停滞）或超出 `totalSec+20s` 兜底后才 rec.stop。保证末尾完整录上，不因开头卡顿被切。

## 已应用修复（第六轮 loop-stop，针对"录制不停止/循环播放/循环录制"）
- 现象：点录屏后不停止，视频循环播放、无限循环录制。
- 分析：handleEnded(回绕到0) 与 播放接近末尾的回绕 都已用 `!savingRef.current` 分趟门控，但仍会循环 → 另有路径（如末尾 hls 错误导致 createHls 重建并从头播放）会重启播放，播放头跌破 totalSec-1.0，进度式停止永不触发。
- 修复：停止轮询新增**完整播遍/回绕检测**——一旦发现播放头显著倒退(>2s)即判定绕回一圈，立即 rec.stop()，保证只录一遍内容；保留"逼近结尾停滞"与 totalSec+20s 兜底。无论循环来自何路径（handleEnded/回绕/hls 重建）都能可靠停止。

## 已应用修复（第七轮 robust-stop，针对"视频播到结尾停止但录制仍不停止"）
- 现象：视频到结尾会停下，但 MediaRecorder 一直不收尾。
- 根因：停止判定只认 `currentTime>=totalSec-1.0`，而 B站真实媒体结束点可能比 totalSec 短超过 1s（dead zone 更大），视频停在末尾但 currentTime 达不到阈值 → 一直挂住。
- 修复：停止轮询新增条件——③live.ended 自然播完即停；④播放头超过 5s 不再前进即停（覆盖"停在末尾但达不到 totalSec-1.0"的死区）。最终停止条件：绕圈倒退>2s / 逼近结尾停滞 / ended / 5s无前进 / totalSec+20s 兜底，任一满足即 rec.stop。
- 用户提示："之前黑屏和开头卡顿都解决了，只是引入循环录制；但解决循环后又使得开头卡顿"。且控制台出现 `gap-controller Playback stalling at @0.637`，`nextStart:918.017`，buffered 区块 `[0.017,28] [918,920] [3088,3090]`——说明本次测试数据（全部礼物列表）剪辑跨全天直播、run 间时间差巨大（0→918→3088）。

## 已应用修复（第八轮 tail-stop，针对"循环播放/循环录制"仍存在）
- 取证（map-hold）：
  - `GiftReplay:seek` 在录制期间(saving:true)持续触发，模式 14→28→42→56→14→28…（curRi 0→3 后回落到 0）——跨 run seek 无限循环推进；seek 的 `from==to`（=下一个 run 起点）。
  - F 探针（tail 帧）：`ct:72 ready:2` 后紧跟 `BLACK/ready:0/vw:0/ct:0`，再 `ct:2.3 ready:4 vw:1600`——即最后一个 run 播到真实物理末尾(≈72)后媒体被整体重置(ready:0 vw:0)，从头重播。
  - 结论：循环驱动 = 看门狗(停滞检测)在录制尾声对已到物理末尾的播放头执行 `startLoad()/微调 seek`，令 hls 重填缓冲从头(0)再播；handleEnded/近末尾预回绕/近末尾重建虽已 `saving` 门控，但**看门狗恢复逻辑未门控**，故仍循环。doSave 的"重绕→停(>2s)"判据依赖 ct 单帧回跳，实际被缓冲重填掩盖未触发。
- 修复（录制期专用，防回归勿删）：
  1. 看门狗停滞分支：当 `savingRef.current && 播放头已到最后一个 run 的真实物理末尾(segEnd*SEG_SECONDS-0.6)` 时，跳过一切恢复(startLoad/微调/重建)，只刷新停滞计时 → 不再触发 hls 重填从头重播。
  2. doSave 停止轮询新增确定性判停：`ct >= 最后一个 run 真实末尾 - 0.6 && 3s 无前进 → rec.stop()`，与 totalSec 名义时长解耦，无论名义/真实时长差异、无论循环来自何路径都可靠收尾。
- 边界：跨 run 之间(非末 run)的 mid-run 停滞仍会被看门狗恢复，录制拼接连续性不受影响；末尾 3s 冻结尾随自然结束，doSave 收尾。

## 已应用修复（第九轮 no-loop+drawloop-stop，针对"视频到结尾停止但录屏仍继续"）
- 取证（map-hold 第二轮）：视频播到 `ct:72 ready:2` 后 `saving:true` 持续约 248s 未收尾，直至视频被整体重置(ready:0/vw:0)。doSave 停止轮询的 `totalSec+20s` 兜底本应在 92s 触发却未触发 → **doSave 内部独立的 rAF 轮询(_tick)链断了**（异常/卸载等），导致所有判定失效。F 探针证明 drawLoop 主循环一直在跑。
- 用户指示：可取消自动循环播放，只播放一次。
- 修复：
  1. 取消循环播放：handleEnded 不再回绕(只 setPlaying(false))；删除近末尾预回绕块；看门狗"到达最后一个 run 物理末尾"恒跳过恢复(不再区分是否录制，杜绝 hls 重填从头再播)。
  2. 录制收尾移至 drawLoop 主循环(每帧必跑，可靠)：`recRef && savingRef && videoReady && !paused && !ended && ct>=最后run真实末尾-0.6 && 停滞>3s → rec.stop()`；另有 `totalSec+20s` 超时兜底与 `live.ended` 立即收尾。
  3. doSave 不再自建 rAF 轮询，只 `await stopped`；stopped 增加 setInterval(250ms) 轮询 rec.state 兜底(不依赖 onstop 事件)。
  4. 新增 recRef/recStartAtRef；doSave 挂载 rec、finally 清理。
- 对"开头卡顿/黑屏"无影响：起点等待(currentTime>=0.5, 15s)与跨 run seek/过渡逻辑均未改动。

## 已应用修复（第十轮 rec-start 顺序，针对"录制结果为空"）
- 症状：rec.start 后不到 1s 即 saving:false，仅录到 0 字节 chunk → `录制结果为空` 抛错。
- 根因：第九轮新增的 `stopped` Promise 在 `rec.start(500)` **之前**创建，此时 rec.state 还是 "inactive"，其 setInterval 兜底的 `if (rec.state === "inactive") resolve()` 立即执行 → `await stopped` 秒过，保存空结果。
- 修复：把 `stopped` Promise 的创建移到 `rec.start(500)` 之后（start 后 state 为 recording，兜底不再误触发）。

## 已应用修复（第十一轮 toggle 末尾重播，针对"播完停止后点击无反应"）
- 症状：取消循环后播放结束停止，但点击播放按钮无反应，应从头重播。
- 根因：停在**物理末尾死区**时未 fire ended、`paused` 仍为 false，toggle 走了 `else` 暂停分支 → 只是暂停无重播。
- 修复：toggle 开头检测"已到末尾"——`live.ended` 或 `!paused && readyState>=2 && ct>=最后run物理末尾-0.6`，满足则 `currentTime=safeStartPos(0)` + startLoad + play 从头重播。

## 已应用修复（第十二轮 perf，录制帧率优化，画面保持纯净）
- 症状：所有平台录制视频帧率远低于 24/30 设定，微微卡顿。
- 解释：`canvas.captureStream(fps)` 的 fps 是**目标上限**；WebRTC 相同帧抑制会在画布内容不变时（跨 run 过渡/静止/末尾死区）丢弃相同帧 → 静止段帧率骤降（浏览器机制，无法绕过）。动态段帧率低的主因是**特效像素级 alpha 合成每帧开销**：drawEffect 每帧 getImageData(2×全画布读回,GPU→CPU 同步) + O(W*H) JS 像素循环。
- 修复（保持画面纯净，用户选择"只做性能优化"）：
  1. 特效工作画布(fxWorkCanvas/fxAlphaCanvas)的 2d context 加 `{ willReadFrequently: true }`：读回走 CPU 缓冲，消除每帧 GPU→CPU 同步停顿（也消除 300 行 willReadFrequently 警告）。主画布(captureStream 源)不动，保持 GPU 合成。
  2. drawEffect 加**合成结果缓存**：cacheKey = fx.currentTime+尺寸+裁剪参数+输出尺寸；特效未出新帧(同一帧跨多个 rAF)时直接复用上次合成画布，跳过像素循环与 getImageData → 像素级合成频率从 rAF(60fps)降到特效帧率(24/30)，省约 60% 开销。

## 已应用修复（第十三轮 fx-cache-fix，修复性能优化引入的残影/开头卡顿）
- 症状：第十二轮性能优化后，录制开头几秒卡顿 + 上一个特效的残影。
- 根因：
  1. **drawEffect 缓存误命中**：缓存键仅含 currentTime/尺寸/裁剪参数，未区分特效视频元素。不同特效（B站配置常相似）currentTime/尺寸恰好相同时，缓存命中画出上一个特效的帧 → 残影；该污染帧又经 hold-frame 写入 freezeCanvasRef，录制 seek 到 0 后开头贴污染帧 → 视觉卡顿。
  2. **willReadFrequently 加在 work 画布**：该画布每帧 drawImage 到主画布(GPU)，软件渲染导致每帧软件→GPU 上传，拖慢 drawLoop。
- 修复：
  1. 缓存命中改为 `fxCacheFx !== fx || key !== cacheKey`（视频元素引用 + currentSrc 双重校验），不同特效必重合成。
  2. work 画布改回 GPU 渲染（缓存后其 getImageData 仅特效新帧时执行，无需 willReadFrequently）；alphaCanvas 保留 willReadFrequently（警告来源，读回频繁）。

## 已回退（第十四轮 revert-perf，撤销第十二/十三轮性能优化）
- 用户反馈残影/开头卡顿在性能优化后仍存在，明确指示"可以接受 willReadFrequently 警告、接受帧率低，之前已基本实现需求"。
- 回退内容：drawEffect 恢复原始实现（无合成结果缓存、无 willReadFrequently）；删除 fxCacheFx/fxCacheKey；特效画布(wxWork/fxAlpha)改回普通 getContext("2d")。willReadFrequently 警告会回来（用户接受）。
- 保留不回退（核心功能修复）：取消循环播放 + drawLoop 录制收尾 + stopped 超时兜底(第九轮)、stopped 移至 rec.start 后(第十轮)、toggle 末尾点击重播(第十一轮)。

## 已应用修复（第十五轮 fx-rvfc，温和方案：消警告+提帧率，无残影风险）
- 用户选择温和方案（消警告+提帧率），要求不触发新问题。
- 实现：
  1. 特效合成改为 **requestVideoFrameCallback 事件驱动**：视频真正出新帧时才做像素级 alpha 合成（24/30fps），rAF 其余帧直接复用结果画布。**每特效元素独立结果画布（WeakMap）** + 事件驱动 → 无"内容相同误判"类残影（区别于第十二轮按 currentTime 缓存，后者因共享 key 误命中产生残影）。
  2. 参数未变直接 drawImage 结果画布（GPU）；参数变化立即重合成+重注册 rVFC；无 rVFC 支持时退化为每帧同步合成。
  3. alphaCanvas 加 willReadFrequently（消除 300 行警告，getImageData 走 CPU 缓冲）；work/result 画布保持 GPU 渲染（每帧输出到主画布，避免软件→GPU 上传拖慢）。
- 保留：取消循环+drawLoop 收尾、stopped 位置、toggle 重播。

## 待办/未解
- 起始卡顿回潮 + gap-controller 跨 run 大时间隙停滞：当前数据 run 间 gap 达数百秒，hls 无法连续缓冲跨越，依赖跨 run seek 跳跃。需核验录制期间跨 run seek 是否稳定触发、以及 gap 大时 bufferStalledError 反复触发导致开头卡顿。第五轮的 `currentTime>=0.5` 起点判定与跨 run seek 及本次数据相关，需重新画像证据。

## 日志
`.dbg/gift-replay-blackscreen.env` / `trae-debug-log-gift-replay-blackscreen.ndjson`