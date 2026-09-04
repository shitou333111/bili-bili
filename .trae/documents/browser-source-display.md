# 展示模块改造：直播姬「浏览器源」+ 透明

## Context（为什么做）
当前"展示"模块用一个独立 Tauri 展示窗口（`/display` 页，960x540，背景 #B7EBA4）被直播姬「窗口捕捉」采集，缺陷是必须维持一个显式窗口不能关、影响体验且不透明。
已在直播姬实测确认：本地网页**真透明**、带 alpha 的**视频也透明**。

目标：改为直播姬「浏览器源」——Rust 内嵌本地 HTTP+WS 服务器 serve 前端，展示页透明叠加，不再有任何独立窗口。

**已定的约束（来自用户拍板）**：
- **删除**现有展示窗口代码（open_display_window / set_display_orientation / close_display_window 及其前端调用、`WebviewUrl::App("/display")` 窗口、display-window-closed/display-ready/display-orientation 通道）。
- **不新建 Tauri 窗口**。编辑/测试放到"展示"页 **APP 内模态框 iframe**（加载 `/display?mode=edit`），模态框内可**切换横/竖屏**分别编辑两套布局。
- 浏览器源**背景完全透明**（去掉 #B7EBA4）。
- **固定端口** 127.0.0.1:25100（占用退避 25100..25119）。
- 入场视频**保留音频**。
- 布局不能靠 localStorage（直播姬 CEF 与 APP iframe 不同存储域）→ 改由主进程持久化到 `.data/display-config.json`，WS 下发。

## 架构
主进程 Rust 内嵌服务器，只绑定 127.0.0.1：serve 静态 `out/` + `/api/video`(Range)，提供 `/ws`。展示页与编辑 iframe 都是标准 WebSocket 客户端。事件由主窗口 JS 经 `broadcast_display` 命令 → Rust 广播到所有 WS 客户端；客户端消息经 `display-server-message` 事件回主窗口。

数据链路：
- 直播姬浏览器源 / 编辑 iframe → `ws://127.0.0.1:<port>/ws`
- 弹幕事件：danmaku `emitTo` → `invoke("broadcast_display",{json})` → server 广播 `{type:"event",payload}`
- client→server：`ready` / `saveLayout` / `orientation` / `log` → server `emit_to("main","display-server-message",msg)` → 主窗口监听处理
- 布局/朝向/礼物/样例动画由主窗口在 `ready` 时组装 `{type:"init",...}` 广播下发

## 依赖与文件

### src-tauri/Cargo.toml 新增
```toml
axum = { version = "0.8", features = ["ws"] }
tower-http = { version = "0.6", features = ["fs", "set-header"] }
futures-util = "0.3"
mime_guess = "2"
```
tokio 现有 features 已够用。axum 的 `ws` 隐式引入 tokio-tungstenite，无需单独声明。

### src-tauri/src/server.rs（新建，服务器核心）
- `DisplayServerState { inner: Mutex<Option<Arc<RunningServer>>> }`；`RunningServer { port, join, broadcast: broadcast::Sender<String> }`（Tauri managed state）。
- 启动（async command `start_display_server`）：幂等；`TcpListener::bind(("127.0.0.1",25100..25119 逐个))`；成功 `tauri::async_runtime::spawn(axum::serve)`；返回 `u16`。
- 停止（`stop_display_server`）：take + join.abort()。
- 广播（`broadcast_display(json)`）：`state.broadcast.send(json.to_string())`，无连接 no-op。
- 路由：
  - `GET /ws` → WebSocketUpgrade → `handle_socket`：split 后后台任务 `brx→sink` 广播；前台 `stream→app.emit_to("main","display-server-message",json)`。
  - `GET /api/video?p=` → `ServeFile::new(path)`（自带 Range/MIME）+ `fs::metadata` 校验存在为文件 + 扩展名白名单（mp4/webm/mov/mkv）。
  - fallback → ServeDir outflow/；做"无扩展名→`.html`"映射（`/display`→`display.html`、`/`→`index.html`）；磁盘缺失时兜底用 `app.assets()`（asset 内嵌 + hotswap 替换的 provider），`mime_guess` 补 Content-Type。
  - 全局 `SetResponseHeaderLayer::overriding(CACHE_CONTROL,"no-cache")` 防 CEF 缓存。
- webroot 解析：`BILI_DISPLAY_WEBROOT` env → `current_dir()/out` → `exe_dir()/out`、`exe_dir()/../out` → 内嵌兜底。

### src-tauri/src/lib.rs
- 删 open_display_window(957-998)/set_display_orientation(1000-1022)/close_display_window(1024-1031)；留 pick_video_file。
- setup 删 CloseRequested 关 "display" 窗口块(1756-1761)；`app.manage(server::DisplayServerState::default())`。
- invoke_handler 删 3 命令、加 `start/stop/broadcast`。
- 顶部注释(946-955)改描述浏览器源方案。

### src-tauri/capabilities/default.json
- windows 删 "display"；permissions 删 allow-open/close-display-window、allow-set-display-orientation，加 allow-start/stop-display-server、allow-broadcast-display（tauri-build 自动生成）。

## WS 消息协议（JSON 文本）
client→server：`{type:"ready", mode}` `{type:"saveLayout", id, orientation, rect}` `{type:"orientation", v}` `{type:"log", level, text}`
server→client：`{type:"init", orientation, layouts, gifts, animeSample}` `{type:"event", payload}` `{type:"layout", id, orientation, rect}` `{type:"orientation", v}`

## 前端改动

### src/lib/display/types.ts
- 提升 `MovableRect` 进本文件；`type LayoutElementId="gift"|"entry"`；`interface DisplayLayout { gift: Record<ScreenOrientation,MovableRect>; entry: Record<ScreenOrientation,MovableRect> }`；`DisplayConfig.layout`；`DEFAULT_DISPLAY_CONFIG.layout`（对齐 DEFAULT_RECT）。
- 删/保留 `DISPLAY_EVENT_CHANNEL`（不再有使用方则删）。

### src/lib/display/config.ts
- `normalizeConfig` 加 `layout` 归一化（逐元素×朝向补默认、数值校验非法回退）。load/save 缓存机制不变。

### src/lib/display/danmaku.ts
- 删 `convertFileSrc` import；**`toDisplayVideoSrc(path)` → `/api/video?p=${encodeURIComponent(path)}`**（相对 URL，消费端与 server 同源）。
- **`emitTo(event)` → `invoke("broadcast_display",{json:{type:"event",payload:event}})`**（standby try/catch；server 未运行 Rust 端 no-op）。
- `ensureDisplayReadyListener`(315) 改为：调用 `startServer` 时注册一次 `listen("display-server-message")`，按 `msg.type` 分发：ready→`broadcastInit()`；saveLayout→改 config.layout→save→回放 layout；orientation→save screenOrientation→回放 orientation；log→console。
- `broadcastInit()`：`loadDisplayConfig` + `loadTodayQualifyingGifts(mid,threshold)` + 首个启用且带视频的 animeList 项→`animeSample{videoSrc(用新toDisplayVideoSrc),startSec,endSec}` → `broadcast_display({type:"init",orientation,layouts:cfg.layout,gifts,animeSample})`。
- 新增 `startServer():Promise<number>`（invoke+缓存 port+注册上面监听）、`stopServer()`、`getServerPort()`。
- 删 `setTestMode`(692-762)与 `testGen`（编辑/测试改由 `?mode=edit` 驱动；正式源只按事件渲染）。

### src/components/display/DisplayCanvas.tsx
- 容器去 `bg-[#B7EBA4]` → 透明。
- 删 Tauri `listen`/`emitTo ready` effect(170-199) → WS 客户端：`ws://${location.host}/ws`，onopen 发 `{type:"ready",mode}`，onmessage 分发 init/event/layout/orientation，onclose 3s 退避重连，unmount 关闭。
- `applyEvent` 删 `test` 分支；保留 entry/anime/gift。
- 新增 state `layouts`、`animeSample`；orientation 由 init/orientation 驱动。
- `isEdit = location.search 含 mode=edit`：`editable={isEdit}`；edit 常驻渲染礼物(空则示例)+`TestEntryLoop`+anime(animeSample 或占位)；rect 来自 `layouts[id][orientation]`，MovableBox 受控。
- 编辑提示文案改为直播姬"素材→浏览器源→http://127.0.0.1:25100/display"。

### src/components/display/MovableBox.tsx
- 删 localStorage；改半受控：props `rect` + `onCommit(rect)`；拖动中用内部 state 即时反馈，`onPointerUp` 调 `onCommit`；rect 变化且未拖动时同步回推。

### src/components/display/VideoOverlay.tsx
- 功能基本不动；`srcWithFragment` 对 `/api/video?...` 的 `#t=` 有效。
- **音频（保留音频）**：`<video autoPlay loop>` 默认 muted 以通过 autoplay policy；监听首次用户交互（pointerdown）后 `unmute()`。CEF 若本就允许有声 autoplay 则有声，否则点击画布后出声（直播姬场景多数源无声，可接受）。

### src/app/display/page.tsx
- 删全部 Tauri 窗口逻辑（onCloseRequested/console 转发 via Tauri/startDragging）。
- 根容器 `bg-transparent`；console 仅 `mode!=="edit"` 时批量(500ms)经 WS 发 `{type:"log"}`（检查 readyState）。

### src/components/display/DisplayPanel.tsx
- 删 display-window-closed/display-ready/display-console 监听、`set_display_orientation`、toggleTest/testing、setTestMode 调用。
- handleMaster(true)：`startServer()` 替代 open_display_window → `start(roomId,mid)` → master=true；失败分支保留。
- handleMaster(false)：`stop()` + `stopServer()` 替代 close_display_window。
- "首次使用设置"按钮 → "编辑布局"：打开 DisplayEditModal（须 master && port>0，禁用态同旧）。
- 新增 state `editModalOpen`、`serverPort`；顶部文案改浏览器源引导。

### src/components/display/DisplayEditModal.tsx（新建）
- Props `{port,orientation,onOrientationChange,onClose}`。
- fixed 遮罩 z-50 + 顶栏（标题 + 横/竖屏 segmented 复用 + 关闭）+ 主体。
- iframe `src="http://127.0.0.1:${port}/display?mode=edit"`，w/h=`CANVAS_SIZE[orientation]`，外层 `scale=min(availW/w,availH/h)` + `transform:scale`、`transformOrigin:"top left"`，wrapper=cw*scale×ch*scale。
- 朝向切换：`onOrientationChange(v)` → DisplayPanel `update({screenOrientation:v})` + `broadcast_display({type:"orientation",payload:v})` → 持久化+广播，iframe 经 WS 自动切，不 reload。

### src/lib/display/auto-start.ts
- 47 行 `invoke("open_display_window")` → `displayDanmaku.startServer()`；其余保留。

### src/app/page.tsx
- 无改动（autoStartDisplay 内部逻辑在 auto-start.ts 改）。

## init 时序
1. 总开关/auto-start：`startServer()` → 绑定端口 → 返回 port → 注册 display-server-message 监听；`start(roomId,mid)`。
2. 直播姬源/编辑 iframe 加载 `/display` → WS open → 发 `{type:"ready",mode}`。
3. server → `emit_to("main","display-server-message",ready)`。
4. 主窗口 → `broadcastInit()` → `broadcast_display({type:"init",orientation,layouts,gifts,animeSample})`。
5. server broadcast → 全端设 orientation/layouts/gifts/animeSample。
6. 后续：拖放→saveLayout→持久化+回放；朝向→修改+广播；弹幕→event 广播。

## 端口/安全
- 仅 127.0.0.1；25100..25119 试 bind，全失败 Err（面板 toast）。
- no-cache 全局；`/api/video` 校验文件存在 + 扩展名白名单。
- 主进程退出即释放。

## 验证
1. `npm run build:tauri` 先生成最新 out/（当前 out 旧、缺 display.html，务必重建）。
2. `npm run tauri dev` → 展示页开总开关 → 日志"server port=25100"。
3. 浏览器开 `http://127.0.0.1:25100/display`：透明背景、三元素按事件出现；`?mode=edit` 常驻测试+虚线可拖/缩。
4. 视频：Network 看 `/api/video?p=` 返回 206 + Accept-Ranges；`#t=` 片段生效。
5. 编辑 modal：拖动→关→开位置保留（.data/display-config.json layout 落盘）；横/竖屏切换→iframe 尺寸变、两套布局独立。
6. 重启软件布局仍在。
7. 占用 25100 后开总开关→退避 25101，iframe/WS 均用新端口。
8. 直播姬添加浏览器源 `http://127.0.0.1:25100/display`，真透明叠加，视频透明+有声。