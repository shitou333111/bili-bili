# B瓜 · Bilibili 直播消费数据分析工具

一个用于查看和分析自己在 Bilibili 直播中消费记录（送礼物、开盲盒、合成活动等）的工具。

它既可以作为**网站**在浏览器里使用，也可以打包成 **Windows / macOS 桌面应用**、**Android / iOS 手机应用**。支持扫码登录 B站 账号后，自动抓取并长期保存你的消费数据，按多种维度统计，还能一键生成分享图片。

> 产品名「B瓜」在 `src-tauri/tauri.conf.json` 中定义（`productName`）。

---

## 目录

- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [整体架构](#整体架构)
- [目录结构](#目录结构)
- [数据获取路径分类（重要）](#数据获取路径分类重要)
  - [A. 直连 B站 · 需要登录凭证](#a-直连-b站--需要登录凭证)
  - [B. 直连 B站 · 无需登录](#b-直连-b站--无需登录)
  - [C. 从自己的服务器获取](#c-从自己的服务器获取)
- [数据存储位置](#数据存储位置)
- [账号体系与本机/服务器账号的区别](#账号体系与本机服务器账号的区别)
- [功能模块详解](#功能模块详解)
- [难点与特殊点](#难点与特殊点)
- [本地开发与运行](#本地开发与运行)
- [打包与部署](#打包与部署)
- [给未来自己的备忘](#给未来自己的备忘)

---

## 核心特性

- **消费记录长期统计**：自动拉取你送给主播的每一笔礼物，按电池数、次数、礼物种类等维度汇总。
- **多维度筛选**：按主播、按月份、按具体某天查看消费明细，可导出/分享图片海报。
- **盲盒盈亏分析**：心动盲盒、幸运盲盒、活动盲盒的投入/产出/盈亏统计，主播维度和日期维度钻取。
- **合成活动分析**：合成包、星石抽奖、翻牌等活动的盈亏与记录明细。
- **其他统计**：礼物清单汇总、连续签到天数、房间/主播维度的天数统计。
- **主播数据模块**：查看主播维度的收入统计，以及"消费主播分布图"（把每个主播按消费金额大小呈现为气泡/泡泡图）。
- **B站 小工具**：粉丝清理、粉丝牌清理、查询用户信息等（需要登录凭证才能使用）。
- **复活区截图工具**：托管在网站服务器上的工具页面，帮助直播多人局投屏复活曲倒计时、解决医药费争议。
- **管理后台（admin）**：网站管理员可管理用户、配置盲盒/活动、模拟登录等。
- **跨平台**：Web、Windows、macOS、Android、iOS 一套代码。

---

## 技术栈

| 领域 | 技术 |
|------|------|
| 前端框架 | **Next.js 16**（App Router）+ **React 19** |
| 样式 | **Tailwind CSS 4** |
| 原生桌面/移动 | **Tauri 2**（Rust），Windows/macOS/Android/iOS |
| 图表 | **Recharts**（普通柱状/饼图）、**d3 系列**（voronoi/treemap 气泡图）、**FoamTree** |
| 图片生成 | **html-to-image**（把 DOM 转成 PNG 分享图） |
| 二维码 | **qrcode**（扫码登录） |
| 本地持久化 | 文件系统（Tauri `plugin-fs`）+ `plugin-store`（会话） |
| 网络 | Tauri `plugin-http`（解决浏览器 CORS 限制，直连 B站） |

**核心思想**：同一套前端代码，通过「平台抽象层」同时服务 Web 和 Tauri 两种运行环境（详见下文）。

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      前端（React / Next.js）                   │
│  页面：page.tsx / login / admin / screenshot + 各组件           │
│  统一入口：dataFetch(path, init)  (src/lib/client-fetch.ts)    │
└───────────────┬──────────────────────────┬──────────────────┘
                │ Web 模式                  │ Tauri 模式
                ▼                          ▼
       服务器 API (/api/...)         平台本地客户端模块
       (Next.js 后端，node)         (src/lib/*-client.ts)
                │                          │
        ┌───────┴────────┐         ┌───────┴────────┐
        │   自己的服务器   │         │   直连 B站 API   │
        │ (admin/配置/    │         │ (带登录凭证)     │
        │  数据中转)       │         │ + 本地文件存储    │
        └────────────────┘         └────────────────┘
```

### 关键机制：平台抽象层

所有业务代码不直接感知「我在浏览器还是 Tauri 客户端」，而是通过统一的 `Platform` 接口（[src/lib/platform/types.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/platform/types.ts)）调用能力，有两个实现：

- **Web 平台**（[web.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/platform/web.ts)）：运行在浏览器，靠**服务器**做数据中转（因为浏览器直连 B站 会有 CORS 跨域限制）。
- **Tauri 平台**（[tauri.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/platform/tauri.ts)）：运行在原生客户端，用 Tauri 的 `plugin-http` **直接请求 B站 API**（绕过 CORS），并把数据写到**本地文件**。

前端的所有请求都走 [dataFetch()](file:///c:/Users/song/vscode_projects/bili_live/src/lib/client-fetch.ts)：

```ts
if (platform.isNative)  → dispatchNative()  // Tauri：分发到本地客户端模块
else                    → fetch(服务器)       // Web：交给 Next.js 服务器
```

所以同一个 `/api/revenue/pay-record` 请求，在 Tauri 里走 [pay-record-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/pay-record-client.ts) 直连 B站，在浏览器里走 [route.ts](file:///c:/Users/song/vscode_projects/bili_live/src/app/api/revenue/pay-record/route.ts) 由服务器代连。这就是「一套代码、两种跑法」的核心。

---

## 目录结构

```
bili_live/
├── src/                          # 前端 + 服务器代码
│   ├── app/
│   │   ├── page.tsx              # 主页面（底部托盘四个模块都在这里）
│   │   ├── login/page.tsx        # 登录页（扫码登录 / 开发者登录）
│   │   ├── admin/page.tsx        # 管理后台
│   │   ├── screenshot/page.tsx   # 复活区截图工具（托管服务器）
│   │   ├── layout.tsx / globals.css
│   │   └── api/                  # 服务器端 API 路由（Next.js Route Handlers）
│   │       ├── revenue/pay-record/   # 消费记录
│   │       ├── stats/*               # 盲盒/合成/认证/其他统计
│   │       ├── anchor/*              # 主播数据
│   │       ├── tools/*               # 粉丝/粉丝牌等小工具
│   │       ├── auth/*                # 登录/登出/账号
│   │       ├── admin/*               # 管理后台
│   │       └── ...（upload/config/faces 等）
│   ├── components/               # UI 组件（BottomDock、图表、模块组件等）
│   ├── lib/                      # 核心逻辑
│   │   ├── platform/             # ★ 平台抽象层（types/web/tauri）
│   │   ├── bilibili/             # B站 API 封装（app.ts / client.ts / gift-api.ts）
│   │   ├── client-fetch.ts       # ★ 统一请求分发（Web vs Tauri）
│   │   ├── server-api.ts         # 服务器地址 & 请求
│   │   ├── *-client.ts           # Tauri 本地客户端模块（直连 B站）
│   │   ├── user-data.ts          # Web 端本地数据文件读写
│   │   ├── auth/                 # 会话管理（session / client-auth / admin）
│   │   ├── config*.ts            # 活动/盲盒配置（可被 admin 覆盖）
│   │   └── ...（stats/toast/offline 等工具）
│   ├── middleware.ts
│   └── types/
├── src-tauri/                    # Tauri 原生壳（Rust）
│   ├── src/lib.rs / main.rs      # 桌面窗口尺寸、fetch_json 命令等
│   ├── tauri.conf.json           # 应用名「B瓜」、图标、窗口配置
│   ├── capabilities/             # 权限声明
│   └── Cargo.toml
├── public/                       # 静态资源 + 应用图标 orig_icon.png
├── scripts/                      # build-tauri.mjs / 数据分析脚本 / 迁移脚本
├── .github/workflows/            # CI/CD（见「打包与部署」）
└── package.json / next.config.ts
```

---

## 数据获取路径分类（重要）

这是本项目最容易绕晕的地方，先记住一句话：

> **在 Web（浏览器）里，所有数据都经由「自己的服务器」中转；在 Tauri 客户端里，大部分数据「直连 B站」，只有管理/配置/复活区截图等走「自己的服务器」。**

下面按「最终数据从哪来」分类，方便排查问题。

### A. 直连 B站 · 需要登录凭证

这些接口必须携带你的 B站 登录凭证（`SESSDATA` / Cookie），用于拉取**你自己的**数据。

| 功能 | B站 接口 | 实现位置 |
|------|---------|---------|
| 消费记录（送礼物明细） | `xlive/revenue/v2/giftStream/payRecord` | [pay-record-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/pay-record-client.ts) / [app.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/bilibili/app.ts) |
| 粉丝列表 / 粉丝清理 | `tools/fans` 相关 | [tools-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/tools-client.ts) |
| 粉丝牌列表 / 清理 | `tools/medals` 相关 | [tools-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/tools-client.ts) |
| 查询用户信息 | `tools/user-info` | [tools-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/tools-client.ts) |
| 主播礼物数据 | `anchor/gifts` | [anchor-gifts-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/anchor-gifts-client.ts) |
| 盲盒抽取记录 | `blind-box/drawStream` | [stats-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/stats-client.ts) |
| 认证/合成/其他统计 | `stats/*` | [stats-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/stats-client.ts) |
| 扫码登录 / 刷新凭证 | B站 登录接口 | [auth/](file:///c:/Users/song/vscode_projects/bili_live/src/lib/auth/) |

> 这些功能在「服务器账号」（source=`server`）下**不可用**，因为没有 B站 登录凭证，详见下文「账号体系」。

### B. 直连 B站 · 无需登录

这些是公开/通用数据，不需要你的账号凭证：

| 功能 | B站 接口 | 说明 |
|------|---------|------|
| 天选礼物列表 | `guardBenefit/GiftPanel` | 判断哪些礼物属于"天选" |
| 红包礼物列表 | `popularityRedPocket/RedPocketDetail` | 判断红包礼物 |
| 盲盒信息（内含礼物列表） | `blindFirstWin/getInfo` | 盲盒内有哪些礼物 |
| 主播信息 / 头像 | `anchor-info` / `faces` | 根据 uid 查昵称、头像 |
| 礼物特效配置 | `fullScSpecialEffect/GetEffectConfListV2` | 礼物特效列表 |
| **礼物图标目录** | `xlive/web-room/v1/giftPanel/giftConfig` | 全量礼物的图标（`img_basic`），无需登录，**12h 缓存**（见「难点与特殊点 8」） |

### C. 从自己的服务器获取

这些和 B站 无关，数据存在你自己的服务器上（也就是部署的 Next.js 后端，`.data/` 目录）：

| 功能 | 接口 | 说明 |
|------|------|------|
| 管理后台 / 用户列表 | `api/admin/*` | 管理员管理用户、模拟登录 |
| 配置中心 | `api/config` / `api/admin/config` | 盲盒、合成活动等可变配置（admin-config.json） |
| 用户数据中转 | `api/upload` / `api/server-data` | 服务器账号的数据上传/下载（详见账号体系） |
| 复活区截图 | `screenshot` 页面 | 内容变动频繁，托管在服务器上，不打包进安装包 |
| 图片代理 | `api/proxy/image` | 代理图片请求（解决部分图片来源问题） |

---

## 数据存储位置

| 环境 | 路径 | 存什么 |
|------|------|--------|
| Web（浏览器） | 服务器 `项目根/.data/` | 所有用户的持久数据 |
| Tauri 客户端 | 原生应用数据目录（`appDataDir/data/`） | 本地持久数据 |

在数据目录下，每个用户一个文件夹 `uid_<mid>/`（`mid` 是 B站 用户ID，昵称会变所以文件夹名固定用ID），里面常见文件：

| 文件 | 内容 |
|------|------|
| `pay-records.json` | 消费记录（送礼物明细） |
| `synthesis-*.json` | 各合成活动记录 |
| `received-anchors-list.json` | 主播头像缓存 |
| `blindbox_info/*.json` | 盲盒信息 |
| `account-info.json` | 用户个人资料 |
| `special-gift-ids.json` | 天选/红包礼物 ID 的历史累积（按用户本地，用于识别特殊礼物） |

顶层还有：

| 文件 | 内容 |
|------|------|
| `bili-live-state.json` | 会话状态（Web 端）|
| `users-list.json` | 用户列表索引 |
| `admin-config.json` | 管理后台配置 |
| `upload-state.json` | 增量上传哈希记录（Tauri 端）|
| `gift-catalog.json` | 礼物图标目录缓存（服务端，来自 B站 giftConfig API，12h 更新一次）|

> Tauri 端的会话存在 `plugin-store`（`bili-live-state.json`），Web 端的会话存在服务器的 `.data/bili-live-state.json`。它们结构相同，但**互不通**——在 Web 登录的账号和在本机客户端登录的账号是各自独立的。

---

## 账号体系与本机/服务器账号的区别

这是本项目另一个关键点。一个「账号」其实分两种来源（`AuthSession.source`）：

| 来源 | 说明 | 有 B站 凭证？ | 能做什么 |
|------|------|:---:|---------|
| `qr` | **本机扫码登录**（在 Web 或 Tauri 客户端里扫码） | ✅ 有 `SESSDATA`/Cookie | 可以增量拉取消费记录、用粉丝/粉丝牌工具等 |
| `dev` | **开发者登录**（测试用） | ✅ 有凭证 | 同 `qr` |
| `server` | **服务器账号**（管理员在服务器上已存好数据） | ❌ 无凭证 | 只能**整体从服务器重载数据**，不能增量更新、不能用需要凭证的工具 |

### 服务器账号（source=server）的特别之处

- 数据保存在**自己的服务器**上，通过 `api/upload`（上传）和 `api/server-data`（下载）获取。
- 因为本机没有 B站 登录凭证，所以：
  - 无法做增量更新，只能"从服务器重新拉取整体数据覆盖本地"。
  - **「粉丝清理」「粉丝牌清理」等需要登录凭证的工具会置灰不可点击**，并给出轻提示（在 page.tsx 中通过 `showOfflineToast` 处理）。
- 这类账号适合"你自己在别处（比如服务器上）已经收集好数据，只想用本工具来看统计"的场景。

> 判断当前是否服务器账号：`currentAccount.source === "server"`，前端在 [page.tsx](file:///c:/Users/song/vscode_projects/bili_live/src/app/page.tsx) 中据此决定刷新走 `reloadServerData()` 还是 `refreshData()`。

---

## 功能模块详解

主页面 [page.tsx](file:///c:/Users/song/vscode_projects/bili_live/src/app/page.tsx) 使用**底部悬浮托盘导航**（[BottomDock.tsx](file:///c:/Users/song/vscode_projects/bili_live/src/components/BottomDock.tsx)），有四个模块页签：

### 1. 粉丝（默认，即"消费"）
核心组件 [RevenueModuleContent.tsx](file:///c:/Users/song/vscode_projects/bili_live/src/components/RevenueModuleContent.tsx)，包含多个子 tab：

- **消费**：消费电池、消费次数、礼物种类三张统计卡 + 消费主播分布气泡图。可按主播/日期/月/天筛选。
- **盲盒**：每个盲盒（心动/幸运/活动）的投入、产出、盈亏；主播维度、日期维度钻取；城堡统计；盈亏证书。
- **合成**：合成包、星石抽奖、翻牌等活动的盈亏与记录。
- **其他**：礼物清单汇总、连续签到天数、房间/主播维度统计。

支持**生成分享图片**（`html-to-image` 把卡片转成 PNG，可下载或保存到相册）。

### 2. 主播
核心组件 [AnchorDataModule.tsx](file:///c:/Users/song/vscode_projects/bili_live/src/components/AnchorDataModule.tsx)：主播维度的收入统计、按主播筛选数据。

### 3. 帮助
- **B站 小工具**：粉丝清理、粉丝牌清理、查询用户信息等（需登录凭证；服务器账号置灰）。
- **复活区截图**：跳转到服务器托管的截图工具页。
- **账号管理**：查看当前账号、切换本机账号、退出登录。

### 4. 待定
占位页（预留后续功能）。

### 其他页面
- **登录页**（`/login`）：扫码登录（QR 轮询）、开发者登录。
- **管理后台**（`/admin`）：用户列表、盲盒/活动配置、模拟登录。
- **复活区截图**（`/screenshot`）：工具介绍与使用，内容由服务器实时提供。

---

## 难点与特殊点

### 1. 增量获取消费记录（含 1 周回溯）

**为什么是难点**：B站 的消费记录接口一次只返回少量（分页、按 id 递减），如果每次都全量拉取会非常慢。所以要做**增量更新**——只拉上次之后的新记录。

**基本思路**（以 `id` 为界线）：
- 记录按时间倒序返回，`id` 单调递减。
- 读本地已有的最大 id（`existingMaxId`），拉取时一旦遇到 `id <= existingMaxId` 就说明"已经到上次更新点了"，停止翻页。

**新增的 1 周回溯**（关键）：
> 有些活动结束后，会把"没完成"的消费电池**退还**，并在**原时期的消费记录上原地修改**（标记"已退回"），而不是新建一条记录。

这就导致一个问题：如果只增量拉新，那些"被改成已退回"的旧记录永远不会被重新读到。所以现在增量逻辑是：

1. 先按原方案找到**上次更新点**（本地最大 id 记录的时间戳）。
2. 在更新点基础上**再向前回溯 1 周**（活动一般持续一周）：继续往前翻页，把所有"更新点往前 1 周窗口内"的记录重新拉下来。
3. 合并时用重新拉到的记录**覆盖**本地同 id 的旧记录（合并且去重时新记录在前），从而把"已退回"的最新状态更新进来。

实现位置：[pay-record-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/pay-record-client.ts)（Tauri）和 [app.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/bilibili/app.ts) + [route.ts](file:///c:/Users/song/vscode_projects/bili_live/src/app/api/revenue/pay-record/route.ts)（Web）。

> ⚠️ 这条"1 周回溯"只对**消费记录**做了。盲盒/合成等没有退款修改的问题，不需要回溯。

### 2. 平台差异：CORS 与本地存储

- 浏览器直连 B站 有 **CORS 跨域限制**，所以 Web 模式必须让服务器代连。
- Tauri 客户端没有这个限制，用 `plugin-http` 直接连，并把数据落到**本地文件**，因此**不上传 B站 凭证到服务器**，隐私更好。
- 同一接口在两种环境下实现不同（`* -client.ts` vs `route.ts`），改数据逻辑时**两处都要改**，保持行为一致。

### 3. 本地优先 + 静默后台同步

打开应用时先快速显示**本地缓存**，再在后台静默同步 B站 最新数据（不阻塞界面），体验流畅。首次使用（无本地缓存）才会走完整初始化。

### 4. 服务器账号与凭证缺失

见上文「账号体系」。核心是：有凭证的账号能增量/用工具，服务器账号只能整体重载 + 工具置灰。

### 5. 移动端适配（iOS 安全区 / 触摸）

- 用 `SafeAreaStyler` + CSS 变量处理 iOS 顶部安全区（刘海屏）。
- 底部悬浮托盘（毛玻璃胶囊）固定定位，注意 `z-index` 与 `isolation: isolate` 防止被覆盖。
- **曾踩过的坑**：在 iOS 上对窗口 `set_size`/`set_position` 会导致 WebView 偏移，产生"左侧触摸死区"（约 103px 区域点击无效）。**修复方式**：移动端跳过窗口尺寸/位置设置，保持全屏（见 [lib.rs](file:///c:/Users/song/vscode_projects/bili_live/src-tauri/src/lib.rs) 中的 `#[cfg(not(any(target_os = "ios", target_os = "android")))]`）。
- 生成分享图时，隐藏的卡片用 `position:absolute; left:-9999px` 移出视口（而非 `display:none`），保证 `html-to-image` 能正确截图。

### 6. 增量上传到服务器（内容哈希）

Tauri 客户端把数据上传到服务器时，用**内容哈希**记录每个文件上次上传的值，只上传有变化的文件，减少带宽（见 [tauri.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/platform/tauri.ts) 的 `uploadUserData`）。

### 7. 图标问题（历史教训）

Tauri 的图标由 `cargo tauri icon <源图>` 生成。CI 打包时若**不指定源图**，会用默认的蓝色图标。所以 CI 里要显式写 `cargo tauri icon public/orig_icon.png`（见 [build-mobile.yml](file:///c:/Users/song/vscode_projects/bili_live/.github/workflows/build-mobile.yml)）。

### 8. 礼物图标目录（替代原来的礼物数据库共享）

**历史问题**：以前项目没有一个"全量礼物信息"列表。主播收到某礼物的**图标**只能靠用户自己的消费记录带出来，再上传、合并、下载一个全局的 `gift-db.json` 给所有用户共享——维护复杂、依赖用户贡献。

**新方案**：B站 提供了一个**无需登录**的公开接口 `xlive/web-room/v1/giftPanel/giftConfig`（固定用一个经典 `room_id`），一次返回**全量礼物的图标**（`img_basic`）。于是每个客户端都能自己直连 B站 拿到礼物图标，**不再需要上传/共享/下载**。处理方式参照 `gift_effects`：**12 小时缓存**，缓存过期时才重新拉取。

- **实现位置**：服务端 [gift-catalog.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/gift-catalog.ts)（`/api/gift-catalog`，`.data/gift-catalog.json` 兜底）；Tauri 客户端 [gift-catalog-client.ts](file:///c:/Users/song/vscode_projects/bili_live/src/lib/gift-catalog-client.ts)（`localStorage` 缓存）。
- **只取图标，不取价格**：新接口也含价格等字段，但不同数据源记录方式不同，**只使用 `img_basic`**，价格等仍由各统计模块按原有逻辑各自处理，避免破坏已有计算。
- **天选/红包 ID 单独处理**：giftConfig 无法可靠识别"天选/红包"这类特殊礼物。这些 ID 的历史累积从全局 `gift-db.json` 迁移到**每个用户本地**的 `special-gift-ids.json`（按 `uid_<mid>/` 隔离），参与合成盈亏等礼物计算。
- **`gift-db.json` 已废弃**：所有上传/下载/合并逻辑已移除，`/api/gift-db` 路由已删除，服务器上的 `gift-db.json` 可删除，不再需要维护。

---

## 本地开发与运行

**前置**：Node.js 22+、pnpm/npm。

```bash
# 安装依赖
npm install

# 启动开发服务器（浏览器访问 http://localhost:3000）
npm run dev

# 构建 Web 生产版（standalone，用于部署到服务器）
npm run build
```

**运行 Tauri 客户端开发版**（需安装 Rust）：

```bash
# 在 src-tauri 目录
cargo tauri dev
```

**Tauri 客户端的服务器地址**：客户端里的 `/api/...` 请求会转发到你自己部署的服务器。通过环境变量 `NEXT_PUBLIC_SERVER_URL` 指定：

```bash
# 例如指向本地服务器
cross-env NEXT_PUBLIC_SERVER_URL=http://192.168.1.2:3000 npm run build:tauri
# 或写入 .env.local: NEXT_PUBLIC_SERVER_URL=http://你的服务器
```

> 打包 Tauri 客户端前**必须**确保服务器地址正确，否则客户端所有 API 请求会失败。

---

## 打包与部署

### CI/CD 打包（GitHub Actions）

两个 workflow：

1. **[build-mobile.yml](file:///c:/Users/song/vscode_projects/bili_live/.github/workflows/build-mobile.yml)** — 打客户端安装包。
   - 由 **commit message 关键字**触发：
     - `exe` → Windows EXE
     - `apk` → Android APK
     - `ipa` → iOS IPA
     - 含 `debug` → 打 Debug 包
   - 例如 commit message 写 `"fix bug exe ipa"` 会同时打 Windows 和 iOS 包。
   - 服务器地址通过 GitHub Secrets `NEXT_PUBLIC_SERVER_URL` 或手动 `workflow_dispatch` 传入。

2. **[deploy.yml](file:///c:/Users/song/vscode_projects/bili_live/.github/workflows/deploy.yml)** — 部署 Web 服务器。
   - 触发：commit 含 `server` 关键字或手动触发。
   - 构建 Next.js `standalone` 后通过 SSH/SCP 上传到服务器，用**符号链接 + 原子切换**做多版本发布，`.data/` 数据目录跨版本保留（`preserved`），保留最近 5 个版本。

---

## 给未来自己的备忘

- **改数据逻辑 = 改两处**：Web 在 `src/app/api/.../route.ts`，Tauri 在 `src/lib/*-client.ts`。漏改会导致两种环境行为不一致。
- **服务器地址**：`NEXT_PUBLIC_SERVER_URL`，同时影响 `server-api.ts` 和 `tauri.ts`，改配置记得同步。
- **平台判断**：`isTauri()` / `getPlatform().isNative`，别在业务代码里手写 `if (window.__TAURI__)` 到处散落。
- **配置单一源头**：盲盒/活动配置集中在 `src/lib/config.ts`，管理后台可通过 `admin-config.json` 覆盖（`config-override.ts`）。改默认配置记得看 admin 是否覆盖。
- **页面宽度单一源头**：`src/lib/page-config.json` 的 `page_max_width` 同时被前端布局和 Tauri 窗口尺寸读取，改一处即可。
- **iOS 触摸死区教训**：移动端千万别对窗口做 `set_size`/`set_position`，保持全屏。
- **消费记录有 1 周回溯**：这是为了覆盖退款（"已退回"）的原地修改，改增量逻辑时不要丢掉这个回溯。
- **图标**：改图标要同步 `public/orig_icon.png`，并在 CI 里 `cargo tauri icon public/orig_icon.png`。
- **礼物图标已改用 giftConfig API**：礼物图标不再走上传/共享 `gift-db.json`，改由每个客户端直连 B站 giftConfig（无需登录、12h 缓存）。`gift-db.json` 及其 API 已废弃，别再为它加回上传/下载逻辑。
- **`.data/` 是核心数据**：Web 服务器升级时 `.data/` 必须保留（deploy.yml 已处理），丢了用户数据无法找回。
