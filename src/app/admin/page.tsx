"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { serverApiUrl, serverPost, isTauri, pageUrl } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { dataFetch } from "@/lib/client-fetch";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import WindowTitleBar from "@/components/WindowTitleBar";
import { DESKTOP_TITLEBAR_H } from "@/lib/layout";
// 模拟器活动算法注册表：作为下拉框选项的唯一数据源（新增算法只需在注册表登记）
import { ALGORITHM_REGISTRY } from "@/components/bili-simulator/activities/algorithms";
import { extractRoomUidFromUrl } from "@/components/bili-simulator/activities/types";

function fixImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

/**
 * 将活动链接中具体的 room_id / uid 数值自动替换为 {room_id} / {uid} 占位符，
 * 便于管理员直接粘贴带真实参数的链接，无需手动改写。
 * 只匹配查询参数 room_id / uid（大小写敏感，且前面必须是 ? 或 &），
 * 因此 {room_id} 等占位符、ruid / anchor_uid 等无关参数都不会被误改。
 */
function toActivityUrlTemplate(url: string): string {
  if (!url) return url;
  return url
    .replace(/([?&]room_id=)\d+/g, "$1{room_id}")
    .replace(/([?&]uid=)\d+/g, "$1{uid}");
}

/** unix 秒 → date（仅日期）输入框值 */
function tsToDateInput(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** date（仅日期）输入框值 → 该日 0 点的 unix 秒 */
function dateStartToTs(value: string): number | undefined {
  if (!value) return undefined;
  const ts = Math.floor(new Date(`${value}T00:00:00`).getTime() / 1000);
  return Number.isFinite(ts) ? ts : undefined;
}

/** date（仅日期）输入框值 → 该日 24 点（次日 0 点）的 unix 秒 */
function dateEndToTs(value: string): number | undefined {
  if (!value) return undefined;
  const ts = Math.floor(new Date(`${value}T24:00:00`).getTime() / 1000);
  return Number.isFinite(ts) ? ts : undefined;
}

type UserDevice = {
  platform: string;
  brand?: string;
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  lastSeen: string;
};

type User = {
  sid: string;
  uname: string;
  mid: number;
  face?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastUpload?: string;
  isCurrent: boolean;
  isLocal?: boolean;
  /** 最近使用平台：web/desktop/android/ios */
  platform?: string;
  /** 设备记录列表（按最近使用排序） */
  devices?: UserDevice[];
  /** 是否为主播（三态）：streamer=有收益记录 / non-streamer=已确认无收益 / unknown/undefined=未判定 */
  streamerStatus?: "streamer" | "non-streamer" | "unknown";
};

/** 平台代号 → 中文名 */
const PLATFORM_LABEL: Record<string, string> = {
  web: "web",
  desktop: "电脑",
  android: "安卓",
  ios: "iOS",
};

/** 设备记录 → 概要文本（如「Xiaomi 25102RKBEC · Android 14 · Chrome」），平台由标签单独展示 */
function deviceSummary(d: UserDevice): string {
  const parts = [
    d.brand,
    [d.os, d.osVersion].filter(Boolean).join(" ") || undefined,
    d.browser,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** 最新使用的平台（devices[0] 为最新记录），无信息返回 undefined */
function latestPlatform(u: User): string | undefined {
  return u.devices?.[0]?.platform ?? u.platform;
}

/** 盲盒内礼物明细（含过期盲盒的完整信息，可手动补充奖励礼物） */
type BlindBoxGiftItemData = {
  gift_id: number;
  gift_name: string;
  /** 电池单价 */
  price: number;
  gift_img?: string;
  /** true = 额外奖励礼物：只计价值，成本 0 */
  is_reward?: boolean;
};
type BlindBoxItem = {
  /** 客户端本地唯一 key（不持久化，仅用于折叠状态等 UI 稳定性） */
  _k?: string;
  id: number;
  name: string;
  icon: string;
  /** 盲盒单价（电池）；0/缺失回退礼物目录 */
  blind_price?: number;
  /** 礼物明细 */
  gifts?: BlindBoxGiftItemData[];
};

/** 盲盒卡片本地唯一 key 生成器（不持久化，服务端保存时会丢弃） */
let boxKeySeq = 0;
function nextBoxKey(): string {
  boxKeySeq += 1;
  return `bb_${Date.now().toString(36)}_${boxKeySeq}`;
}
type ActivityItem = {
  active?: boolean;
  name?: string;
  start_time?: number;
  end_time?: number;
  products?: string[];
  materials?: string[];
};

type RecommendedAnchorItem = {
  uid: number;
  uname: string;
  face?: string;
  room_id: number;
  visible: boolean;
  order: number;
};

/** 模拟器活动入口配置项（算法参数以 JSON 文本编辑，保存时解析为对象） */
type SimulatorActivityItem = {
  id: string;
  title: string;
  entryImage: string;
  urlTemplate: string;
  roomId: number;
  uid: number;
  enabled: boolean;
  algorithmType: string;
  algorithmParams: string;
};

type AdminConfigData = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  /** 盲盒盈亏查询配置：可被查询盈亏的盲盒 id 列表 */
  blind_box_profit_ids: number[];
  synthesis_activities: ActivityItem[];
  recommended_anchors: RecommendedAnchorItem[];
  real_activity_url: string;
  simulator_activities: SimulatorActivityItem[];
  announcement: string;
  faq: FaqItemData[];
  /** 主播活动素材（名字 + 链接地址），显示在「主播」页「其他」tab 顶部供预览/下载 */
  anchor_activity_materials: AnchorMaterialItemData[];
  /** 帮助页「扫码加入微信群」二维码图片链接（留空则回退 /feedback.jpg） */
  wechat_qr_url: string;
};

/** 帮助页「常见问题」条目 */
type FaqItemData = { q: string; a: string };

/** 主播活动素材条目 */
type AnchorMaterialItemData = { name: string; url: string };

/** 读取本地保存的管理员会话 sid */
function getStoredAdminSid(): string | null {
  try {
    return typeof window !== "undefined" ? localStorage.getItem("bili_live_admin_sid") : null;
  } catch { return null; }
}

/**
 * 管理员 API 请求封装：始终附带 X-Admin-Sid 请求头。
 * Tauri 环境下使用 @tauri-apps/plugin-http（Rust 侧 HTTP，无 CORS 限制），
 * 否则前端与远程服务器跨源，原生 fetch 会被浏览器 CORS 策略拦截。
 */
async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...(options.headers as Record<string, string> | undefined), ...(getStoredAdminSid() ? { "X-Admin-Sid": getStoredAdminSid()! } : {}) };
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, { ...options, headers });
  }
  return fetch(url, { ...options, headers, credentials: "include" });
}

/** 配置管理子模块卡片：独立卡片 + 可折叠标题栏 + 标题栏右侧“保存配置”按钮 */
function ConfigCard({
  title,
  collapsed,
  onToggle,
  onSave,
  saved,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  onSave: () => void;
  saved: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-black/10 bg-white/70 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-xs font-semibold hover:text-black/80 transition"
        >
          <svg className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
          <span className="truncate">{title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {saved && <span className="text-[10px] text-[#2ecc71]">已保存 ✓</span>}
          <button
            onClick={onSave}
            className="rounded-lg bg-[#1f1c17] px-3 py-1 text-[11px] text-white font-medium hover:opacity-90 transition"
          >
            保存配置
          </button>
        </div>
      </div>
      {!collapsed && <div className="space-y-1.5">{children}</div>}
    </div>
  );
}

export default function AdminPage() {
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  // 首次进入时静默校验/自动登录，期间不渲染登录框，避免“弹出后自动消失”的闪烁
  const [checking, setChecking] = useState(true);
  const [loginForm, setLoginForm] = useState({ password: "" });
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [config, setConfig] = useState<AdminConfigData | null>(null);
  const [configSaved, setConfigSaved] = useState(false);
  // 数据加载失败时显示错误提示（而非让组件崩溃）
  const [loadError, setLoadError] = useState(false);
  // 推荐主播管理
  const [newAnchorUid, setNewAnchorUid] = useState("");
  const [addingAnchor, setAddingAnchor] = useState(false);
  // 用户搜索
  const [userSearch, setUserSearch] = useState("");
  // 用户列表惰性渲染：先渲染前 50 条，滚动到底部再追加（避免上万用户时页面卡顿）
  const [userVisible, setUserVisible] = useState(50);
  // 用户列表默认不渲染（用户条目过多、头像补齐请求量大，拖慢页面），点“加载”后再显示；
  // 卡片顶部的统计信息基于已拉取的 users 数据计算，不受影响
  const [userListLoaded, setUserListLoaded] = useState(false);
  useEffect(() => {
    // 搜索条件变化时重置可见数量
    setUserVisible(50);
  }, [userSearch]);
  // 从服务器拉取账号数据时的阻塞遮罩
  const [serverLoading, setServerLoading] = useState(false);
  // 礼物目录（用于盲盒按名称搜索：gift_id -> { name, img }）
  const [giftCatalog, setGiftCatalog] = useState<Record<number, { name: string; img: string }>>({});
  // 礼物单价映射（gift_id -> 电池单价），用于礼物明细联想自动填价
  const [giftPriceCatalog, setGiftPriceCatalog] = useState<Record<number, number>>({});
  // 盲盒名称搜索建议（当前展开的行索引）
  const [blindBoxSearchIndex, setBlindBoxSearchIndex] = useState<number | null>(null);
  // 盲盒卡片展开状态（按本地 key；默认全部折叠）
  const [expandedBoxKeys, setExpandedBoxKeys] = useState<Record<string, boolean>>({});
  // 图标链接编辑弹窗（点击图标弹出）
  const [iconEditor, setIconEditor] = useState<{ title: string; value: string; apply: (v: string) => void } | null>(null);
  // 盲盒礼物名称搜索建议（当前展开的 {box,gift} 行）
  const [blindBoxGiftSearch, setBlindBoxGiftSearch] = useState<{ box: number; gift: number } | null>(null);
  // 正在从B站获取盲盒信息的盲盒索引
  const [fetchingBoxInfo, setFetchingBoxInfo] = useState<number | null>(null);
  // 合成产物名称搜索建议（当前展开的产品行）
  const [productSearch, setProductSearch] = useState<{ act: number; product: number } | null>(null);
  // 配置模块折叠状态：盲盒配置 / 模拟器活动配置 / 合成活动盈亏配置 / 常见问题 / 素材 默认折叠
  const [blindBoxCollapsed, setBlindBoxCollapsed] = useState(true);
  const [simulatorCollapsed, setSimulatorCollapsed] = useState(true);
  const [synthesisCollapsed, setSynthesisCollapsed] = useState(true);
  const [faqCollapsed, setFaqCollapsed] = useState(true);
  const [materialsCollapsed, setMaterialsCollapsed] = useState(true);
  // 公告 / 微信群二维码 / 黑抽 / 推荐主播：保持原有默认展开状态
  const [announcementCollapsed, setAnnouncementCollapsed] = useState(false);
  const [wechatQrCollapsed, setWechatQrCollapsed] = useState(false);
  const [blackdrawCollapsed, setBlackdrawCollapsed] = useState(false);
  const [recommendedCollapsed, setRecommendedCollapsed] = useState(false);
  // 素材本地文件上传中的条目（null = 无上传中；text 显示进度文案）
  const [materialUploading, setMaterialUploading] = useState<{ idx: number; text: string } | null>(null);
  // 帮助页微信群二维码上传进度（null = 未上传中）
  const [qrUploading, setQrUploading] = useState<string | null>(null);
  // 算法参数全屏编辑器：记录正在编辑的活动序号 / 临时文本 / 校验错误
  const [paramsEditIndex, setParamsEditIndex] = useState<number | null>(null);
  const [paramsEditText, setParamsEditText] = useState("");
  const [paramsEditError, setParamsEditError] = useState("");
  // 抽奖记录（管理后台左下角模块）
  const [lotteryRecords, setLotteryRecords] = useState<
    Array<{ mid: number; uname: string; drawnAt: string; won: boolean; prize: string; odds: string; rewardGranted: boolean }>
  >([]);
  // 服务器当前抽奖概率配置（admin 可改，改后所有平台立即生效）
  const [lotteryOddsDenom, setLotteryOddsDenom] = useState(20);
  const [lotteryDenomInput, setLotteryDenomInput] = useState("20");
  const [lotterySavingConfig, setLotterySavingConfig] = useState(false);
  // 抽奖状态三态：all=全部开放（帮助页入口可见）；paused=已暂停；anchor=仅主播（帮助页入口不隐藏，未抽奖用户显示提醒，仅主播页入口可抽）
  const [lotteryMode, setLotteryMode] = useState<"all" | "paused" | "anchor">("all");
  const [lotteryToggling, setLotteryToggling] = useState(false);
  const [lotteryGrantingMid, setLotteryGrantingMid] = useState<number | null>(null);
  // 全局访问开关：disabled=true 时切断所有客户端对 /api/* 的访问（放行 /api/admin/*），用于出 BUG 时紧急止损
  const [globalSwitchDisabled, setGlobalSwitchDisabled] = useState(false);
  const [globalSwitchToggling, setGlobalSwitchToggling] = useState(false);
  // 主播信息查询：输入 UID，一次并行调用直播间状态 + 昵称两个公开接口，整合去重后统一展示
  const [anchorUid, setAnchorUid] = useState("");
  const [anchorQuerying, setAnchorQuerying] = useState(false);
  const [anchorResult, setAnchorResult] = useState<{
    uid: number;
    uname: string;
    face: string;
    roomId: number; // 两个接口都返回房间号（roomid / room_id），去重后只取一个
    roomStatus: number | null; // 0=无房 / 1=有房（接口失败时为 null，不展示该徽章）
    live_status: number;
    title: string;
  } | null>(null);
  const [anchorError, setAnchorError] = useState("");

  const checkAdminSession = useCallback(async (): Promise<boolean> => {
    try {
      const res = await adminFetch(serverApiUrl("/api/admin/session"));
      const data = await res.json();
      if (data.data?.valid) {
        setAdminLoggedIn(true);
        setChecking(false); // 已有有效会话，直接放行
        return true;
      }
    } catch { /* ignore */ }
    // 无有效会话：保持 checking，交由 silentLogin 尝试，避免登录框闪现
    return false;
  }, []);

  // 静默登录：有已保存的密码则后台自动验证，避免重复弹出密码框（跨源 cookie 未持久化时的兜底）
  const silentLogin = useCallback(async () => {
    const cred = typeof window !== "undefined" ? localStorage.getItem("bili_live_admin_cred") : null;
    let ok = false;
    if (cred) {
      let password = "";
      try { password = atob(cred); } catch { password = ""; }
      if (password) {
        try {
          const data = (await serverPost<{ code: number; sid?: string }>(
            "/api/admin/login",
            { password },
          )) as any;
          if (data?.code === 0) {
            if (data.sid) {
              try { localStorage.setItem("bili_live_admin_sid", data.sid); } catch { /* ignore */ }
            }
            setAdminLoggedIn(true); ok = true;
          }
        } catch { /* ignore */ }
      }
    }
    setChecking(false); // 无论成败都结束 loading，失败则显示登录表单
    return ok;
  }, []);

  useEffect(() => {
    checkAdminSession().then((loggedIn) => {
      if (!loggedIn) silentLogin();
    });
  }, [checkAdminSession, silentLogin]);

  const loadData = useCallback(async () => {
    setLoadError(false);
    try {
      // 附带当前浏览器登录账号的 sid，用于默认选中当前用户
      const sid = typeof window !== "undefined" ? localStorage.getItem("bili_live_sid") : null;
      // 本机登录标识（稳定设备令牌），用于标记"本机登录"账号并置顶
      const deviceToken = typeof window !== "undefined"
        ? (localStorage.getItem("bili_live_device_token") ?? localStorage.getItem("bili_live_user_token") ?? "")
        : "";
      console.log("[admin] loadData: sid=", sid, "deviceToken=", deviceToken?.slice(0, 8) + "...");
      const usersUrl = sid
        ? `/api/admin/users?_sid=${encodeURIComponent(sid)}&_device_token=${encodeURIComponent(deviceToken)}`
        : `/api/admin/users?_device_token=${encodeURIComponent(deviceToken)}`;
      const [usersRes, configRes, catalogRes] = await Promise.all([
        adminFetch(serverApiUrl(usersUrl)),
        adminFetch(serverApiUrl("/api/admin/config")),
        adminFetch(serverApiUrl("/api/gift-catalog")),
      ]);
      const usersData = await usersRes.json();
      const configData = await configRes.json();
      console.log("[admin] usersData.code=", usersData.code, "users count=", usersData.data?.users?.length, "currentSid=", usersData.data?.currentSid, "deviceToken=", usersData.data?.deviceToken);

      // 本机/当前标记：Tauri 本地会话为准（PC/iOS 会话只存本机，服务器 deviceToken 匹配不到）
      let finalUsers = usersData.data?.users ?? [];
      try {
        const platform = await getPlatform();
        if (platform.isNative) {
          const state = await platform.getSessionState();
          const localSessions = state.sessions;
          const localCurrentSid = state.currentSid;
          finalUsers = finalUsers.map((u: any) => {
            const local = localSessions.find((s) => s.mid === u.mid);
            if (!local) return { ...u, isLocal: false, isCurrent: false };
            const isCurrent = local.sid === localCurrentSid;
            // 本机 = 在本机登录、有 B站 登录凭证、可从 B站更新数据的账号。
            // 服务器收集账号（source=server）本机无其登录凭证，仅可查看，不算本机。
            const isLocal = local.source !== "server";
            return {
              ...u,
              sid: local.sid ?? u.sid,
              face: local.face ?? u.face,
              uname: local.uname ?? u.uname,
              isLocal,
              isCurrent,
            };
          });
          // 追加本地有而服务器没有的用户（Tauri 登录不经过服务器，users-list.json 可能无记录）
          for (const local of localSessions) {
            if (!finalUsers.some((u: any) => u.mid === local.mid)) {
              finalUsers.push({
                sid: local.sid,
                mid: local.mid,
                uname: local.uname,
                face: local.face ?? "",
                source: local.source ?? "qr",
                createdAt: local.createdAt ?? "",
                updatedAt: local.updatedAt ?? "",
                lastUpload: undefined,
                isCurrent: local.sid === localCurrentSid,
                isLocal: local.source !== "server",
              });
            }
          }
          // 本机账号置顶，其余按更新时间倒序
          finalUsers.sort((a: any, b: any) => {
            if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          });
        }
      } catch { /* 非原生环境忽略 */ }

      if (usersData.data?.users) {
        finalUsers.forEach((u: any) => {
          if (u.isLocal || u.isCurrent) console.log("[admin] user:", u.uname, "isLocal=", u.isLocal, "isCurrent=", u.isCurrent, "sid=", u.sid?.slice(0, 8));
        });
      }
      if (usersData.code === 0) setUsers(finalUsers);
      else if (usersData.code === 403) {
        // 会话失效：清除本地 sid 并提示重新登录
        try { localStorage.removeItem("bili_live_admin_sid"); } catch { /* ignore */ }
        setAdminLoggedIn(false);
        setChecking(false);
        return;
      }
      if (configData.code === 0) {
        const data = configData.data ?? {};
        // 模拟器活动列表以 admin 配置（.data/admin-config.json）为唯一数据源。
        // 空算法参数的活动：回填该算法类型的默认配置，便于管理员直接查看/编辑（json 内置参数透传给 admin）。
        const simActs: any[] = (Array.isArray(data.simulator_activities) ? data.simulator_activities : []).map((a: any) => {
          // roomId/uid 未配置（0）时，回退到 URL 模板中自带的字面参数作为默认值
          if (!Number(a.roomId) || !Number(a.uid)) {
            const fromUrl = extractRoomUidFromUrl(String(a.urlTemplate ?? ""));
            if (!Number(a.roomId) && fromUrl.roomId) a.roomId = fromUrl.roomId;
            if (!Number(a.uid) && fromUrl.uid) a.uid = fromUrl.uid;
          }
          if (!a.algorithmParams || !Object.keys(a.algorithmParams).length) {
            a.algorithmParams =
              ALGORITHM_REGISTRY[String(a.algorithmType ?? "stone-gongfang")]?.buildMockConfig?.({}) ?? {};
          }
          return a;
        });
        // 数组字段全部兜底，避免老配置文件缺字段引发 TypeError: undefined.length
        const normalized: AdminConfigData = {
          current_activity_blind_box_ids: Array.isArray(data.current_activity_blind_box_ids)
            ? data.current_activity_blind_box_ids
            : [],
          blind_boxes: Array.isArray(data.blind_boxes)
            ? data.blind_boxes.map((b: any): BlindBoxItem => ({
                _k: nextBoxKey(),
                id: Number(b?.id) || 0,
                name: String(b?.name ?? ""),
                icon: String(b?.icon ?? ""),
                blind_price: Number(b?.blind_price) || 0,
                gifts: Array.isArray(b?.gifts)
                  ? b.gifts.map((g: any): BlindBoxGiftItemData => ({
                      gift_id: Number(g?.gift_id) || 0,
                      gift_name: String(g?.gift_name ?? ""),
                      price: Number(g?.price) || 0,
                      gift_img: g?.gift_img ? String(g.gift_img) : undefined,
                      is_reward: g?.is_reward === true,
                    }))
                  : [],
              }))
            : [],
          blind_box_profit_ids: Array.isArray(data.blind_box_profit_ids)
            ? data.blind_box_profit_ids
            : [],
          synthesis_activities: Array.isArray(data.synthesis_activities)
            ? data.synthesis_activities
            : [],
          recommended_anchors: Array.isArray(data.recommended_anchors)
            ? data.recommended_anchors
            : [],
          real_activity_url: typeof data.real_activity_url === "string" ? data.real_activity_url : "",
          announcement: typeof data.announcement === "string" ? data.announcement : "",
          faq: Array.isArray(data.faq)
            ? data.faq.map((f: any) => ({ q: String(f?.q ?? ""), a: String(f?.a ?? "") }))
            : [],
          anchor_activity_materials: Array.isArray(data.anchor_activity_materials)
            ? data.anchor_activity_materials.map((m: Record<string, unknown>) => ({ name: String(m?.name ?? ""), url: String(m?.url ?? "") }))
            : [],
          wechat_qr_url: typeof data.wechat_qr_url === "string" ? data.wechat_qr_url : "",
          simulator_activities: simActs.map((a: any) => ({
                id: String(a.id ?? ""),
                title: String(a.title ?? ""),
                entryImage: String(a.entryImage ?? ""),
                urlTemplate: String(a.urlTemplate ?? ""),
                roomId: Number(a.roomId) || 0,
                uid: Number(a.uid) || 0,
                enabled: a.enabled !== false,
                algorithmType: String(a.algorithmType ?? "stone-gongfang"),
                algorithmParams: JSON.stringify(
                  a.algorithmParams && Object.keys(a.algorithmParams).length
                    ? a.algorithmParams
                    : (ALGORITHM_REGISTRY[String(a.algorithmType ?? "stone-gongfang")]?.buildMockConfig?.({}) ?? {}),
                  null,
                  2
                ),
              }))
        };
        setConfig(normalized);
        // 解析礼物目录（用于盲盒按名称搜索）
        try {
          const catalogData = await catalogRes.json();
          if (catalogData.code === 0 && catalogData.data?.gifts) {
            const catalog: Record<number, { name: string; img: string }> = catalogData.data.gifts;
            setGiftCatalog(catalog);
            // 礼物单价映射（分 → 电池），用于礼物明细联想自动填价
            const priceMap: Record<number, number> = {};
            for (const g of Array.isArray(catalogData.data.list) ? catalogData.data.list : []) {
              if (g?.id && g?.coin_type === "gold" && g?.price) priceMap[Number(g.id)] = Math.round(Number(g.price) / 100);
            }
            setGiftPriceCatalog(priceMap);
            // 自动填充名称为空的盲盒
            let modified = false;
            const boxes = normalized.blind_boxes.map((b) => {
              if (b.id > 0 && !b.name && catalog[b.id]?.name) {
                modified = true;
                return { ...b, name: catalog[b.id].name };
              }
              return b;
            });
            if (modified) {
              normalized.blind_boxes = boxes;
              setConfig({ ...normalized });
            }
          }
        } catch { /* ignore */ }
      } else if (configData.code === 403) {
        try { localStorage.removeItem("bili_live_admin_sid"); } catch { /* ignore */ }
        setAdminLoggedIn(false);
        setChecking(false);
        return;
      }
    } catch (err) {
      console.error("[admin] loadData error:", err);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (adminLoggedIn) loadData();
  }, [adminLoggedIn, loadData]);

  // 服务器收集账号无本地头像，用 B站公开信息接口按 UID 补齐头像（已尝试过的 mid 不再重复请求）
  const avatarAttempted = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!adminLoggedIn || !userListLoaded || users.length === 0) return;
    const missing = users.filter((u) => !u.face && u.mid && !avatarAttempted.current.has(u.mid));
    if (missing.length === 0) return;
    missing.forEach((u) => avatarAttempted.current.add(u.mid));
    let cancelled = false;
    (async () => {
      try {
        const batchSize = 20;
        const faces: Record<number, string> = {};
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize).map((u) => u.mid);
          const res = await dataFetch(`/api/tools/user-info?uids=${batch.join(",")}`, { cache: "no-store" });
          const data = await res.json();
          if (data.code === 0 && data.data) {
            for (const [midStr, info] of Object.entries(data.data as Record<string, { face?: string }>)) {
              const mid = Number(midStr);
              if (info?.face) faces[mid] = info.face;
            }
          }
        }
        if (!cancelled && Object.keys(faces).length > 0) {
          setUsers((prev) => prev.map((u) => (faces[u.mid] ? { ...u, face: faces[u.mid] } : u)));
        }
      } catch { /* 头像补齐失败不影响列表 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminLoggedIn, userListLoaded, users]);

  // 加载抽奖记录 + 当前概率配置（管理后台左下角抽奖模块）
  useEffect(() => {
    if (!adminLoggedIn) return;
    (async () => {
      try {
        const res = await adminFetch(serverApiUrl("/api/admin/lottery"));
        const data = await res.json();
        if (data.code === 0 && Array.isArray(data.data?.records)) {
          setLotteryRecords(data.data.records);
        }
        if (data.code === 0 && data.data?.config?.oddsDenom) {
          setLotteryOddsDenom(data.data.config.oddsDenom);
          setLotteryDenomInput(String(data.data.config.oddsDenom));
        }
        if (data.code === 0 && data.data?.config?.mode) {
          setLotteryMode(data.data.config.mode);
        }
      } catch { /* 抽奖记录加载失败不影响其他模块 */ }
      try {
        const res = await adminFetch(serverApiUrl("/api/admin/switch"));
        const data = await res.json();
        if (data.code === 0) setGlobalSwitchDisabled(data.data?.disabled === true);
      } catch { /* 全局开关读取失败不影响其他模块 */ }
    })();
  }, [adminLoggedIn]);

  /** 保存抽奖概率（格式 "1/n"，n≥2 整数），改后所有平台立即生效 */
  const saveLotteryConfig = async () => {
    const denom = Math.floor(Number(lotteryDenomInput));
    if (!Number.isInteger(denom) || denom < 2) {
      window.alert("概率分母必须是大于等于 2 的整数（格式 1/n）");
      return;
    }
    setLotterySavingConfig(true);
    try {
      const res = await adminFetch(serverApiUrl("/api/admin/lottery/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oddsDenom: denom }),
      });
      const data = await res.json();
      if (data.code === 0 && data.data?.config?.oddsDenom) {
        setLotteryOddsDenom(data.data.config.oddsDenom);
        setLotteryDenomInput(String(data.data.config.oddsDenom));
      } else {
        window.alert(data.message || "保存失败");
      }
    } catch {
      window.alert("网络错误，保存失败");
    } finally {
      setLotterySavingConfig(false);
    }
  };

  /** 抽奖状态三态点击循环：全部开放 → 已暂停 → 仅主播 → 全部开放 */
  const LOTTERY_MODE_CYCLE: Array<"all" | "paused" | "anchor"> = ["all", "paused", "anchor"];
  const cycleLotteryMode = async () => {
    const next = LOTTERY_MODE_CYCLE[(LOTTERY_MODE_CYCLE.indexOf(lotteryMode) + 1) % LOTTERY_MODE_CYCLE.length];
    setLotteryToggling(true);
    try {
      const res = await adminFetch(serverApiUrl("/api/admin/lottery/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const data = await res.json();
      if (data.code === 0 && data.data?.config?.mode) {
        setLotteryMode(data.data.config.mode);
      } else {
        window.alert(data.message || "操作失败");
      }
    } catch {
      window.alert("网络错误，操作失败");
    } finally {
      setLotteryToggling(false);
    }
  };

  /**
   * 切换全局访问开关（kill switch）：
   * disabled=true 时切断所有客户端对 /api/* 的访问（放行 /api/admin/*），用于出 BUG 时紧急止损。
   */
  const toggleGlobalSwitch = async (disabled: boolean) => {
    setGlobalSwitchToggling(true);
    try {
      const res = await adminFetch(serverApiUrl("/api/admin/switch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled }),
      });
      const data = await res.json();
      if (data.code === 0) {
        setGlobalSwitchDisabled(data.data?.disabled === true);
      } else {
        window.alert(data.message || "操作失败");
      }
    } catch {
      window.alert("网络错误，操作失败");
    } finally {
      setGlobalSwitchToggling(false);
    }
  };

  /**
   * 按 UID 查询主播信息：并行请求两个公开接口并整合去重。
   * - GET /api/medical/room-id?mid=<uid>   → roomid + roomStatus（0=无房 / 1=有房，即"是否为主播"的依据）
   * - GET /api/tools/streamer-info?uid=<uid> → 昵称/头像/房间号/开播状态/标题
   * 房间号两边都有，去重只展示一个；两个都失败才报错，单边失败用另一边结果兜底。
   */
  const queryAnchorInfo = async () => {
    const uid = Number(anchorUid.trim());
    if (!uid || uid <= 0) {
      setAnchorError("请输入正确的 UID");
      setAnchorResult(null);
      return;
    }
    setAnchorQuerying(true);
    setAnchorError("");
    setAnchorResult(null);
    try {
      const [roomRes, infoRes] = await Promise.all([
        adminFetch(serverApiUrl(`/api/medical/room-id?mid=${uid}`), { cache: "no-store" }),
        adminFetch(serverApiUrl(`/api/tools/streamer-info?uid=${uid}`), { cache: "no-store" }),
      ]);
      const [roomData, infoData] = await Promise.all([roomRes.json(), infoRes.json()]);
      const roomOk = roomData.code === 0;
      const infoOk = infoData.code === 0;
      if (!roomOk && !infoOk) {
        setAnchorError(roomData.message || infoData.message || "查询失败");
        return;
      }
      setAnchorResult({
        uid: infoOk ? infoData.data?.uid ?? uid : uid,
        uname: infoOk ? infoData.data?.uname ?? "" : "",
        face: infoOk ? infoData.data?.face ?? "" : "",
        // 去重：优先用昵称接口的 room_id，缺失时回落到直播间状态接口的 roomid
        roomId: (infoOk ? infoData.data?.room_id : 0) || (roomOk ? roomData.data?.roomid : 0) || 0,
        roomStatus: roomOk ? roomData.data?.roomStatus ?? 0 : null,
        live_status: infoOk ? infoData.data?.live_status ?? 0 : 0,
        title: infoOk ? infoData.data?.title ?? "" : "",
      });
    } catch {
      setAnchorError("网络错误，查询失败");
    } finally {
      setAnchorQuerying(false);
    }
  };

  /** 标记中奖用户奖品已发放（避免重复发放） */
  const grantLotteryReward = async (mid: number) => {
    setLotteryGrantingMid(mid);
    try {
      const res = await adminFetch(serverApiUrl("/api/admin/lottery/grant"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mid }),
      });
      const data = await res.json();
      if (data.code === 0) {
        setLotteryRecords((prev) => prev.map((r) => (r.mid === mid ? { ...r, rewardGranted: true } : r)));
      } else {
        window.alert(data.message || "标记失败");
      }
    } catch {
      window.alert("网络错误，标记失败");
    } finally {
      setLotteryGrantingMid(null);
    }
  };

  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const data = (await serverPost<{ code: number; message?: string; sid?: string }>(
        "/api/admin/login",
        { password: loginForm.password },
      )) as any;
      if (data?.code === 0) {
        if (data.sid) {
          try { localStorage.setItem("bili_live_admin_sid", data.sid); } catch { /* ignore */ }
        }
        setAdminLoggedIn(true);
      } else {
        setLoginError(data?.message || "登录失败");
      }
    } catch {
      setLoginError("网络错误");
    }
    setLoginLoading(false);
  };

  const handleImpersonate = async (user: User) => {
    try {
      // Tauri 本地模式：凭证只存本机，直接切换本地会话 currentSid
      const platform = await getPlatform();
      if (platform.isNative) {
        const state = await platform.getSessionState();
        // 优先用传入 sid；若该 sid 非本机会话，则尝试按 mid 匹配本机会话
        let targetSid: string | null = user.sid;
        if (!targetSid || !state.sessions.some((s) => s.sid === targetSid)) {
          targetSid = state.sessions.find((s) => s.mid === user.mid)?.sid ?? null;
        }
        if (!targetSid) {
          // 无本机会话（纯服务器收集账号）：本地无凭证，无法切换，直接返回（不弹提示）
          return;
        }
        const { clientSwitch } = await import("@/lib/auth/client-auth");
        const res = await clientSwitch(platform, targetSid);
        if (res.code !== 0) {
          alert("切换失败: " + (res.message || "未知错误"));
          return;
        }
        // 同步 localStorage sid（供首页快速识别当前账号）
        localStorage.setItem("bili_live_sid", targetSid);
        setUsers((prev) => prev.map((u) => ({ ...u, isCurrent: u.mid === user.mid })));
        console.log("[admin] impersonate: local session switched, sid=", targetSid!.slice(0, 8) + "...");
        return;
      }

      const res = await adminFetch(serverApiUrl("/api/admin/impersonate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: user.sid }),
      });
      const data = await res.json();
      console.log("[admin] impersonate response: code=", data.code, "userToken=", data.data?.userToken?.slice(0, 8) + "...");
      if (data.code !== 0) {
        alert("切换失败: " + (data.message || "未知错误"));
        return;
      }
      if (user.sid) localStorage.setItem("bili_live_sid", user.sid);
      // 注意：不更新 userToken/deviceToken，保持设备标识稳定
      setUsers((prev) => prev.map((u) => ({ ...u, isCurrent: u.mid === user.mid })));
      console.log("[admin] impersonate: localStorage updated, sid=", user.sid?.slice(0, 8) + "...");
    } catch (err) {
      console.error("[admin] impersonate error:", err);
      alert("切换失败: " + (err instanceof Error ? err.message : "网络错误"));
    }
  };

  /**
   * 从自建服务器加载某账号数据并切换过去（用于"纯服务器收集、本机无 B站 凭证"的账号）。
   * 流程：拉取服务器数据 → 保存到本地 uid_<mid> → 创建/切换本机会话(source=server) → 返回首页。
   * 期间显示与首次登录一致的加载遮罩（无法使用月度数据进度条，故为不确定进度条）。
   */
  const loadRemoteAndSwitch = async (user: User) => {
    const platform = await getPlatform();

    // Web 端：浏览器没有文件系统，数据全部由服务器路由按「当前会话」返回。
    // 因此不需要（也无法）把用户数据落盘，只要让服务器把当前会话切到该账号即可：
    //   - 该账号已有服务器会话 → 直接切换；
    //   - 没有会话（纯服务器收集账号）→ 服务器按 mid 建立一个只读的 server 会话。
    if (!platform.isNative) {
      setServerLoading(true);
      try {
        const res = await adminFetch(serverApiUrl("/api/admin/impersonate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid: user.sid || undefined, mid: user.mid, uname: user.uname, face: user.face }),
        });
        const data = await res.json();
        if (data.code !== 0) {
          alert("加载失败: " + (data.message || "未知错误"));
          return;
        }
        if (data.data?.sid) {
          try { localStorage.setItem("bili_live_sid", data.data.sid); } catch { /* ignore */ }
        }
        setUsers((prev) => prev.map((u) => ({ ...u, isCurrent: u.mid === user.mid })));
        window.location.href = pageUrl("/");
      } catch (err) {
        alert("加载失败: " + (err instanceof Error ? err.message : "网络错误"));
      } finally {
        setServerLoading(false);
      }
      return;
    }

    setServerLoading(true);
    try {
      // 先从服务器拉取该用户的数据文件
      const res = await adminFetch(serverApiUrl(`/api/upload?mid=${user.mid}&uname=${encodeURIComponent(user.uname)}`));
      const data = await res.json();
      if (data.code !== 0) {
        alert("加载失败: " + (data.message || "未知错误"));
        return;
      }
      const files = data.data?.files ?? {};
      const fileNames = Object.keys(files);
      if (fileNames.length === 0) {
        alert("该用户暂无上传数据");
        return;
      }
      // 保存数据文件到本地 uid_<mid>（与本地数据存储结构一致）
      const dir = `${await platform.getDataDir()}/uid_${user.mid}`;
      await platform.mkdir(dir);
      for (const name of fileNames) {
        await platform.writeFile(`${dir}/${name}`, files[name]);
      }
      // 一并保存全局盲盒信息（名称/单价/爆出礼物对照表），供盲盒/合成页正确显示。
      // 盲盒信息全局共享、非按用户存放，服务器账号无 B站 Cookie 无法自行获取，必须随切换拉取。
      if (data.data?.blindboxInfo && typeof data.data.blindboxInfo === "object") {
        const bbDir = `${await platform.getDataDir()}/blindbox_info`;
        await platform.mkdir(bbDir);
        for (const [id, info] of Object.entries(data.data.blindboxInfo as Record<string, unknown>)) {
          if (!/^\d+$/.test(id)) continue;
          await platform.writeFile(`${bbDir}/${id}.json`, JSON.stringify(info, null, 2));
        }
      }
      // 创建/切换本机会话（source=server，无 B站 Cookie，数据展示依赖上述本地文件）
      const { clientCreateServerSession } = await import("@/lib/auth/client-auth");
      const sess = await clientCreateServerSession(platform, { mid: user.mid, uname: user.uname, face: user.face });
      if (sess.code !== 0 || !sess.data) {
        alert("创建本地会话失败: " + (sess.message || "未知错误"));
        return;
      }
      // 同步 localStorage sid（供首页快速识别当前账号）
      try { localStorage.setItem("bili_live_sid", sess.data.sid); } catch { /* ignore */ }
      setUsers((prev) => prev.map((u) => ({ ...u, isCurrent: u.mid === user.mid })));
      console.log(`[admin] 已从服务器加载 ${user.uname} 的 ${fileNames.length} 个数据文件，切换到该账号`);
      window.location.href = pageUrl("/");
    } catch (err) {
      alert("加载失败: " + (err instanceof Error ? err.message : "网络错误"));
    } finally {
      setServerLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    setConfigSaved(false);
    // 模拟器活动的算法参数以 JSON 文本编辑，保存前解析为对象（解析失败则用空对象）
    const body = {
      ...config,
      simulator_activities: (config.simulator_activities ?? []).map((a) => {
        let algorithmParams: Record<string, unknown> = {};
        try {
          algorithmParams = a.algorithmParams.trim() ? JSON.parse(a.algorithmParams) : {};
        } catch {
          algorithmParams = {};
        }
        return { ...a, algorithmParams };
      }),
    };
    const res = await adminFetch(serverApiUrl("/api/admin/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code === 0) {
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } else {
      alert(data.message || "保存失败");
    }
  };

  /**
   * 分片上传图片到服务器素材端点，返回素材链接：
   * 按 512KB 切片依次提交到服务器追加落盘，最后一片返回素材链接。
   * 分片原因：线上 nginx 对请求体有大小限制（默认 1m，超限返回 413 HTML 页），
   * 整文件 base64 单发会被拦截，切成小片后任意大小的图片都能传。
   * onProgress 回传进度文案（如「上传中 2/5」）。
   */
  const uploadImageToServer = async (file: File, onProgress: (text: string) => void): Promise<string> => {
    const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!mime.startsWith("image/")) {
      throw new Error("请选择图片文件（gif 或静态图片）");
    }
    if (file.size === 0) {
      throw new Error("文件内容为空");
    }
    const CHUNK = 512 * 1024; // 每片原始字节；base64 后约 700KB，稳过 nginx 默认 1m 限制
    const total = Math.ceil(file.size / CHUNK);
    // uploadId 仅用字母数字 - _（服务端白名单），时间戳 + 随机数保证不撞名
    const uploadId = `mat${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let url = "";
    for (let part = 0; part < total; part++) {
      onProgress(total > 1 ? `上传中 ${part + 1}/${total}` : "上传中...");
      const slice = file.slice(part * CHUNK, Math.min((part + 1) * CHUNK, file.size));
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
        fr.onerror = () => reject(new Error("读取文件失败"));
        fr.readAsDataURL(slice);
      });
      // 去掉 data:...;base64, 前缀，只传纯 base64 分片
      const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const res = await adminFetch(serverApiUrl("/api/admin/material"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, part, total, mime, data }),
      });
      type UploadResp = { code?: number; message?: string; data?: { url?: string } };
      let body: UploadResp | null = null;
      try {
        body = (await res.json()) as UploadResp;
      } catch {
        // 服务器返回非 JSON（如网关 413 HTML 错误页）时给出可读提示
        throw new Error(`上传失败：服务器返回异常(${res.status})，请检查网络或服务端请求体大小限制`);
      }
      if (!res.ok || body?.code !== 0) throw new Error(body?.message || `上传失败(${res.status})`);
      if (body?.data?.url) url = body.data.url;
    }
    if (!url) throw new Error("上传失败：服务器未返回链接");
    return url;
  };

  /**
   * 上传本地素材文件：上传成功后回填到该条目的「图片链接」
   * （名称为空时用文件名填充）。注意：回填后仍需点「保存配置」才会写入 admin 配置。
   */
  const uploadMaterialFile = async (idx: number, file: File) => {
    if (!config) return;
    setMaterialUploading({ idx, text: "上传中..." });
    try {
      const url = await uploadImageToServer(file, (text) => setMaterialUploading({ idx, text }));
      const list = [...(config.anchor_activity_materials ?? [])];
      const cur = list[idx];
      if (!cur) return;
      list[idx] = {
        ...cur,
        url,
        name: cur.name.trim() ? cur.name : file.name.replace(/\.[^.]+$/, ""),
      };
      setConfig({ ...config, anchor_activity_materials: list });
    } catch (err) {
      alert(err instanceof Error ? err.message : "素材上传失败");
    } finally {
      setMaterialUploading(null);
    }
  };

  /**
   * 上传帮助页「扫码加入微信群」二维码图片：上传成功后回填到 wechat_qr_url
   * （仍需点「保存配置」才会写入 admin 配置）。
   */
  const uploadWechatQrFile = async (file: File) => {
    if (!config) return;
    setQrUploading("上传中...");
    try {
      const url = await uploadImageToServer(file, setQrUploading);
      setConfig({ ...config, wechat_qr_url: url });
    } catch (err) {
      alert(err instanceof Error ? err.message : "二维码上传失败");
    } finally {
      setQrUploading(null);
    }
  };

  const updateBlindBox = (index: number, field: keyof BlindBoxItem, value: string | number) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    boxes[index] = { ...boxes[index], [field]: field === "id" ? Number(value) : value };
    setConfig({ ...config, blind_boxes: boxes });
  };

  const addBlindBox = () => {
    if (!config) return;
    // 新元素加到列表最上方，方便直接编辑
    const key = nextBoxKey();
    setConfig({
      ...config,
      blind_boxes: [{ _k: key, id: 0, name: "", icon: "", blind_price: 0, gifts: [] }, ...config.blind_boxes],
    });
    setExpandedBoxKeys((m) => ({ ...m, [key]: true }));
  };

  const removeBlindBox = (index: number) => {
    if (!config) return;
    const removedId = config.blind_boxes[index]?.id;
    setConfig({
      ...config,
      blind_boxes: config.blind_boxes.filter((_, i) => i !== index),
      current_activity_blind_box_ids: removedId
        ? config.current_activity_blind_box_ids.filter((id) => id !== removedId)
        : config.current_activity_blind_box_ids,
      blind_box_profit_ids: removedId
        ? config.blind_box_profit_ids.filter((id) => id !== removedId)
        : config.blind_box_profit_ids,
    });
  };

  // 上移下移盲盒条目（所有盲盒统一参与排序，无固定项）
  const moveBlindBox = (index: number, dir: -1 | 1) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    const target = index + dir;
    if (target < 0 || target >= boxes.length) return;
    [boxes[index], boxes[target]] = [boxes[target], boxes[index]];
    setConfig({ ...config, blind_boxes: boxes });
  };

  // 从礼物目录按名称搜索匹配的礼物（最多返回 5 个）
  const searchGiftsByName = (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.entries(giftCatalog)
      .filter(([, g]) => g.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(([id, g]) => ({ id: Number(id), name: g.name, img: g.img }));
  };

  // 选中搜索建议后自动填充盲盒行的 id/name/icon
  const selectGiftForBlindBox = (index: number, gift: { id: number; name: string; img: string }) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    boxes[index] = { ...boxes[index], id: gift.id, name: gift.name, icon: gift.img };
    setConfig({ ...config, blind_boxes: boxes });
    setBlindBoxSearchIndex(null);
  };

  // ====== 盲盒单价 / 礼物明细（含过期盲盒） ======
  const updateBlindBoxPrice = (index: number, value: string) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    boxes[index] = { ...boxes[index], blind_price: Number(value) || 0 };
    setConfig({ ...config, blind_boxes: boxes });
  };

  const addBlindBoxGift = (index: number) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    const key = boxes[index]._k;
    boxes[index] = {
      ...boxes[index],
      // 新礼物加到明细最下方
      gifts: [...(boxes[index].gifts ?? []), { gift_id: 0, gift_name: "", price: 0 }],
    };
    setConfig({ ...config, blind_boxes: boxes });
    if (key) setExpandedBoxKeys((m) => ({ ...m, [key]: true }));
  };

  const updateBlindBoxGift = (index: number, giftIndex: number, patch: Partial<BlindBoxGiftItemData>) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    const gifts = [...(boxes[index].gifts ?? [])];
    gifts[giftIndex] = { ...gifts[giftIndex], ...patch };
    boxes[index] = { ...boxes[index], gifts };
    setConfig({ ...config, blind_boxes: boxes });
  };

  const removeBlindBoxGift = (index: number, giftIndex: number) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    boxes[index] = { ...boxes[index], gifts: (boxes[index].gifts ?? []).filter((_, i) => i !== giftIndex) };
    setConfig({ ...config, blind_boxes: boxes });
  };

  // 选中礼物联想建议：填充 gift_id/名称/图标/单价（保留原有的奖励勾选）
  const selectGiftForBlindBoxGift = (index: number, giftIndex: number, gift: { id: number; name: string; img: string }) => {
    updateBlindBoxGift(index, giftIndex, {
      gift_id: gift.id,
      gift_name: gift.name,
      gift_img: gift.img,
      price: giftPriceCatalog[gift.id] ?? 0,
    });
    setBlindBoxGiftSearch(null);
  };

  // 从B站获取盲盒信息（服务器代读 B站 blindFirstWin/getInfo），自动回填名称/单价/礼物列表
  const fetchBlindBoxFromBili = async (index: number) => {
    if (!config) return;
    const box = config.blind_boxes[index];
    if (!box || box.id <= 0) return;
    setFetchingBoxInfo(index);
    try {
      // 取当前 App 登录会话的 B站 Cookie 传给服务器
      const cookies: string[] = [];
      try {
        const platform = await getPlatform();
        const state = await platform.getSessionState();
        const current = state.sessions.find((s: any) => s.sid === state.currentSid);
        if (current) {
          if (current.biliCookies?.length) cookies.push(...current.biliCookies);
          if (current.biliSessdata && !cookies.some((c) => c.startsWith("SESSDATA="))) {
            cookies.push(`SESSDATA=${current.biliSessdata}`);
          }
        }
      } catch { /* 取会话失败则交由服务器端现有会话兜底 */ }

      const res = await adminFetch(serverApiUrl("/api/admin/blind-box-info"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gift_id: box.id, cookies }),
      });
      const data = await res.json();
      if (data.code !== 0 || !data.data) {
        alert(data.message || "从B站获取失败");
        return;
      }
      const info = data.data;
      const boxes = [...config.blind_boxes];
      const existingGifts: BlindBoxGiftItemData[] = boxes[index].gifts ?? [];
      // 奖励礼物（手动添加、B站接口不返回的）在回填时保留
      const rewardGifts = existingGifts.filter((g) => g.is_reward);
      boxes[index] = {
        ...boxes[index],
        name: info.name || boxes[index].name,
        icon: info.icon || boxes[index].icon,
        blind_price: info.blind_price || boxes[index].blind_price,
        gifts: [
          ...(info.gifts ?? []).map((g: any): BlindBoxGiftItemData => ({
            gift_id: Number(g.gift_id) || 0,
            gift_name: String(g.gift_name ?? ""),
            price: Number(g.price) || 0,
            gift_img: g.gift_img ? String(g.gift_img) : undefined,
          })),
          ...rewardGifts,
        ],
      };
      setConfig({ ...config, blind_boxes: boxes });
      const key = boxes[index]._k;
      if (key) setExpandedBoxKeys((m) => ({ ...m, [key]: true }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "从B站获取失败");
    } finally {
      setFetchingBoxInfo(null);
    }
  };

  const updateActivity = (index: number, field: keyof ActivityItem, value: string | number | boolean | undefined) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    acts[index] = { ...acts[index], [field]: value } as ActivityItem;
    setConfig({ ...config, synthesis_activities: acts });
  };

  const addActivity = () => {
    if (!config) return;
    setConfig({
      ...config,
      // 新活动加到列表最上方
      synthesis_activities: [
        { name: "", products: [], materials: [] },
        ...config.synthesis_activities,
      ],
    });
  };

  // 选中搜索建议后自动填充产物的名称
  const selectGiftForProduct = (actIndex: number, productIndex: number, name: string) => {
    updateActivityProduct(actIndex, productIndex, name);
    setProductSearch(null);
  };

  // ====== 产物配置（可独立增删，与素材无一一对应关系）=======
  const updateActivityProduct = (actIndex: number, productIndex: number, value: string) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const products = [...(acts[actIndex].products || [])];
    products[productIndex] = value;
    acts[actIndex] = { ...acts[actIndex], products };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const addActivityProduct = (actIndex: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const products = ["", ...(acts[actIndex].products || [])];
    acts[actIndex] = { ...acts[actIndex], products };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const removeActivityProduct = (actIndex: number, productIndex: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const products = [...(acts[actIndex].products || [])];
    products.splice(productIndex, 1);
    acts[actIndex] = { ...acts[actIndex], products };
    setConfig({ ...config, synthesis_activities: acts });
  };

  // ====== 素材配置（可独立增删，数量不必与产物相同）=======
  const updateActivityMaterial = (actIndex: number, materialIndex: number, value: string) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const materials = [...(acts[actIndex].materials || [])];
    materials[materialIndex] = value;
    acts[actIndex] = { ...acts[actIndex], materials };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const addActivityMaterial = (actIndex: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const materials = ["", ...(acts[actIndex].materials || [])];
    acts[actIndex] = { ...acts[actIndex], materials };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const removeActivityMaterial = (actIndex: number, materialIndex: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    const materials = [...(acts[actIndex].materials || [])];
    materials.splice(materialIndex, 1);
    acts[actIndex] = { ...acts[actIndex], materials };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const removeActivity = (index: number) => {
    if (!config) return;
    setConfig({
      ...config,
      synthesis_activities: config.synthesis_activities.filter((_, i) => i !== index),
    });
  };

  // 上移下移合成活动条目
  const moveActivity = (index: number, dir: -1 | 1) => {
    if (!config) return;
    const target = index + dir;
    if (target < 0 || target >= config.synthesis_activities.length) return;
    const acts = [...config.synthesis_activities];
    [acts[index], acts[target]] = [acts[target], acts[index]];
    setConfig({ ...config, synthesis_activities: acts });
  };

  // ========== 模拟器活动配置管理 ==========
  const addSimulatorActivity = () => {
    if (!config) return;
    setConfig({
      ...config,
      // 新活动加到列表最上方
      simulator_activities: [
        {
          id: "",
          title: "",
          entryImage: "",
          urlTemplate: "",
          roomId: 0,
          uid: 0,
          enabled: true,
          algorithmType: "stone-gongfang",
          algorithmParams: "",
        },
        ...config.simulator_activities,
      ],
    });
  };
  const updateSimulatorActivity = (
    index: number,
    field: keyof SimulatorActivityItem,
    value: string | number | boolean
  ) => {
    if (!config) return;
    const acts = [...config.simulator_activities];
    acts[index] = { ...acts[index], [field]: value } as SimulatorActivityItem;
    setConfig({ ...config, simulator_activities: acts });
  };
  const removeSimulatorActivity = (index: number) => {
    if (!config) return;
    setConfig({
      ...config,
      simulator_activities: config.simulator_activities.filter((_, i) => i !== index),
    });
  };
  // 打开算法参数全屏编辑器（临时文本，保存时才写回配置）
  const openParamsEditor = (index: number) => {
    if (!config) return;
    setParamsEditIndex(index);
    setParamsEditText(config.simulator_activities[index]?.algorithmParams ?? "{}");
    setParamsEditError("");
  };
  const saveParamsEditor = () => {
    if (paramsEditIndex === null) return;
    const text = paramsEditText.trim();
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        setParamsEditError("JSON 格式有误，请检查后重试");
        return;
      }
    }
    updateSimulatorActivity(paramsEditIndex, "algorithmParams", text || "{}");
    setParamsEditIndex(null);
  };

  // ========== 推荐主播管理 ==========
  const addRecommendedAnchor = async () => {
    if (!config || !newAnchorUid.trim()) return;
    const uid = Number(newAnchorUid.trim());
    if (!uid || uid <= 0) { alert("请输入正确的UID"); return; }
    if (config.recommended_anchors.some((a) => a.uid === uid)) { alert("该主播已存在"); return; }
    setAddingAnchor(true);
    try {
      // 使用 B站 get_status_info_by_uids API 一次性获取昵称、头像、房间号
      const res = await dataFetch(`/api/tools/streamer-info?uid=${uid}`, { cache: "no-store" });
      const data = await res.json();
      if (data.code !== 0 || !data.data) {
        alert(data.message || "未查询到主播信息");
        return;
      }
      const info = data.data as { uid: number; uname: string; face: string; room_id: number };
      if (!info.uname) {
        alert("未查询到主播昵称，请检查UID是否正确");
        return;
      }
      // 新主播加到列表最上方，随后统一重排 order
      const list = [
        {
          uid,
          uname: info.uname,
          face: info.face ? fixImageUrl(info.face) : undefined,
          room_id: info.room_id || 0,
          visible: true,
          order: 1,
        },
        ...config.recommended_anchors,
      ];
      list.forEach((a, i) => { a.order = i + 1; });
      setConfig({ ...config, recommended_anchors: list });
      setNewAnchorUid("");
    } catch {
      alert("查询主播信息失败");
    }
    setAddingAnchor(false);
  };

  const toggleAnchorVisible = (uid: number) => {
    if (!config) return;
    setConfig({
      ...config,
      recommended_anchors: config.recommended_anchors.map((a) =>
        a.uid === uid ? { ...a, visible: !a.visible } : a,
      ),
    });
  };

  const removeRecommendedAnchor = (uid: number) => {
    if (!config) return;
    setConfig({
      ...config,
      recommended_anchors: config.recommended_anchors.filter((a) => a.uid !== uid),
    });
  };

  const moveRecommendedAnchor = (index: number, dir: -1 | 1) => {
    if (!config) return;
    const list = [...config.recommended_anchors].sort((a, b) => a.order - b.order);
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    // 重新编号 order
    list.forEach((a, i) => { a.order = i + 1; });
    setConfig({ ...config, recommended_anchors: list });
  };

  // 盲盒「卡片」配置：单独作为一个盲盒卡片显示。
  // 「卡片」⊆「盈亏」不变量：显示为独立卡片就必须纳入盈亏统计（含弹幕查询），故勾「卡片」时自动补齐「盈亏」
  const toggleCurrentBoxId = (id: number) => {
    if (!config) return;
    const ids = config.current_activity_blind_box_ids;
    if (ids.includes(id)) {
      setConfig({ ...config, current_activity_blind_box_ids: ids.filter((x) => x !== id) });
      return;
    }
    const profitIds = config.blind_box_profit_ids;
    setConfig({
      ...config,
      current_activity_blind_box_ids: [...ids, id],
      blind_box_profit_ids: profitIds.includes(id) ? profitIds : [...profitIds, id],
    });
  };

  // 盲盒盈亏查询配置：增删可查询盈亏的盲盒 id（有序保留）。
  // 取消「盈亏」时同步取消「卡片」，维持「卡片」⊆「盈亏」
  const toggleProfitBoxId = (id: number) => {
    if (!config) return;
    const ids = config.blind_box_profit_ids;
    if (ids.includes(id)) {
      setConfig({
        ...config,
        blind_box_profit_ids: ids.filter((x) => x !== id),
        current_activity_blind_box_ids: config.current_activity_blind_box_ids.filter((x) => x !== id),
      });
      return;
    }
    setConfig({ ...config, blind_box_profit_ids: [...ids, id] });
  };

  const toggleActivityActive = (index: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    acts[index] = { ...acts[index], active: !acts[index].active };
    setConfig({ ...config, synthesis_activities: acts });
  };

  // 按用户名或 UID 过滤用户
  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.uname.toLowerCase().includes(q) || String(u.mid).includes(q),
    );
  }, [users, userSearch]);

  if (checking) {
    // 静默校验/自动登录中，不渲染任何登录框，避免闪烁
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f6]">
        <SafeAreaStyler />
        <WindowTitleBar />
        <div className="w-8 h-8 border-2 border-black/15 border-t-black/40 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!adminLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f6]">
        <SafeAreaStyler />
        <WindowTitleBar />
        <div className="w-full max-w-xs rounded-xl border border-black/10 bg-white p-6 shadow-sm">
          <h1 className="text-base font-bold text-center mb-4">管理员登录</h1>
          {loginError && <p className="text-xs text-[#e74c3c] mb-2 text-center">{loginError}</p>}
          <input
            type="password"
            placeholder="请输入管理密码"
            value={loginForm.password}
            onChange={(e) => setLoginForm({ password: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-3 focus:outline-none focus:border-black/30"
            autoFocus
          />
          <button
            onClick={handleLogin}
            disabled={loginLoading}
            className="w-full rounded-lg bg-[#1f1c17] py-2 text-sm text-white font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loginLoading ? "登录中..." : "登录"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-root min-h-screen bg-[#faf9f6] py-2 px-2 overflow-x-hidden" style={{ paddingTop: "calc(var(--safe-top, 0px) + 8px)" }}>
      <SafeAreaStyler />
      <WindowTitleBar />
      <div className="max-w-3xl mx-auto space-y-2">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">管理后台</h1>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-xs text-black/50 transition hover:border-black/25 hover:text-black/80"
              title="刷新页面"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8a6 6 0 1 1-1.76-4.24M14 2v4h-4" />
              </svg>
              刷新
            </button>
          </div>
          <a
            href="/"
            className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-black/50 transition hover:border-black/25 hover:text-black/80"
          >
            返回首页
          </a>
        </div>

        {/* 数据加载失败提示 */}
        {loadError && (
          <div className="rounded-xl border border-[#e74c3c]/30 bg-[#fdf0ef] p-2">
            <p className="text-sm text-[#e74c3c] font-medium">无法连接服务器，请检查网络或服务器状态</p>
            <button
              onClick={() => loadData()}
              className="mt-2 text-xs text-[#e74c3c] underline hover:opacity-70"
            >
              重新加载
            </button>
          </div>
        )}

        {/* Users */}
        <div className="rounded-xl border border-black/10 bg-white/80 p-2">
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-bold">用户列表 ({filteredUsers.length})</h2>
              <button
                onClick={() => setUserListLoaded(true)}
                disabled={userListLoaded}
                className="rounded-lg border border-black/10 bg-white px-2.5 py-1 text-[11px] font-medium text-black/55 transition hover:border-black/25 hover:text-black/80 disabled:opacity-45 disabled:hover:border-black/10 disabled:hover:text-black/55"
                title={userListLoaded ? "用户信息已加载" : "加载并显示用户信息（含头像补齐请求）"}
              >
                {userListLoaded ? "已加载" : "加载"}
              </button>
            </div>
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="搜索用户名 / UID"
              className="w-44 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs focus:outline-none focus:border-black/30"
            />
          </div>
          {(() => {
            let s = 0, n = 0, u = 0;
            let dPc = 0, dAndroid = 0, dIos = 0, dWeb = 0, dUnknown = 0;
            for (const user of filteredUsers) {
              if (user.streamerStatus === "streamer") s++;
              else if (user.streamerStatus === "non-streamer") n++;
              else u++;
              const p = latestPlatform(user);
              if (p === "desktop") dPc++;
              else if (p === "android") dAndroid++;
              else if (p === "ios") dIos++;
              else if (p === "web") dWeb++;
              else dUnknown++;
            }
            return (
              <div className="flex flex-wrap gap-x-6 text-[10px] text-black/45 mb-1.5">
                <span>主播/非主播/未判定 = {s}/{n}/{u}</span>
                <span>电脑/安卓/iOS/web/未知 = {dPc}/{dAndroid}/{dIos}/{dWeb}/{dUnknown}</span>
              </div>
            );
          })()}
          {!userListLoaded ? (
            <p className="text-xs text-black/40 py-1">
              用户信息未加载{users.length > 0 ? `（共 ${users.length} 条）` : ""}，点击左侧“加载”按钮显示。上方统计信息基于全量数据实时计算。
            </p>
          ) : filteredUsers.length === 0 ? (
            <p className="text-xs text-black/30">{users.length === 0 ? "暂无用户" : "无匹配用户"}</p>
          ) : (
            <div
              className="space-y-1 max-h-80 overflow-y-auto"
              onScroll={(e) => {
                const el = e.currentTarget;
                // 滚动接近底部时再渲染 50 条
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
                  setUserVisible((v) => (v < filteredUsers.length ? Math.min(v + 50, filteredUsers.length) : v));
                }
              }}
            >
              {filteredUsers.slice(0, userVisible).map((user) => (
                <div key={user.mid} className={`flex items-center gap-2 rounded-lg border p-1.5 ${user.isCurrent ? "border-[#00a1d6] bg-[#eef3fb]" : "border-black/10"}`}>
                  {user.face ? <img src={fixImageUrl(user.face)} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" /> : <div className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-1.5">
                      <span className="text-sm font-medium min-w-0 break-all leading-snug">{user.uname}</span>
                      {user.streamerStatus === "streamer"
                        ? <span className="text-[10px] px-1.5 rounded bg-[#e54d4c]/10 text-[#e54d4c] shrink-0">主播</span>
                        : user.streamerStatus === "non-streamer"
                        ? <span className="text-[10px] px-1.5 rounded bg-black/5 text-black/40 shrink-0">非主播</span>
                        : <span className="text-[10px] px-1.5 rounded bg-black/5 text-black/25 shrink-0">未判定</span>}
                      {user.isLocal && <span className="text-[10px] px-1.5 rounded bg-[#2ecc71]/10 text-[#2ecc71] shrink-0">本机</span>}
                    </div>
                    <div className="text-[10px] text-black/30 mt-0.5">UID {user.mid}</div>
                    <div className="text-[10px] text-black/30 mt-0.5">更新: {new Date(user.updatedAt).toLocaleString("zh-CN")}</div>
                    <div
                      className="text-[10px] text-black/40 mt-0.5 flex items-center gap-1 min-w-0"
                      title={user.devices && user.devices.length > 0
                        ? user.devices.map((d) => `${PLATFORM_LABEL[d.platform] ?? d.platform}${deviceSummary(d) ? " · " + deviceSummary(d) : ""}（${new Date(d.lastSeen).toLocaleString("zh-CN")}）`).join("\n")
                        : undefined}
                    >
                      <span className="shrink-0">设备:</span>
                      <span className="text-[10px] px-1.5 rounded bg-[#00a1d6]/10 text-[#00a1d6] shrink-0">
                        {(() => {
                          const p = latestPlatform(user);
                          return p ? PLATFORM_LABEL[p] ?? p : "未知";
                        })()}
                      </span>
                      {user.devices && user.devices.length > 0 && deviceSummary(user.devices[0]) && (
                        <span className="truncate">
                          {deviceSummary(user.devices[0])}
                          {user.devices.length > 1 && ` 等${user.devices.length}台`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {user.isLocal ? (
                      !user.isCurrent && (
                        <button
                          onClick={() => handleImpersonate(user).then(() => { window.location.href = pageUrl("/"); })}
                          className="rounded-lg border border-black/10 bg-white px-3 py-1 text-xs text-black/60 hover:bg-black/5 transition"
                        >
                          切换
                        </button>
                      )
                    ) : (
                      <button
                        onClick={() => loadRemoteAndSwitch(user)}
                        className="rounded-lg border border-[#2ecc71]/30 bg-[#2ecc71]/5 px-2 py-1 text-[10px] text-[#2ecc71] hover:bg-[#2ecc71]/10 transition"
                        title="从服务器查看该用户数据（本机无其登录凭证，仅可查看）"
                      >
                        查看数据
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {filteredUsers.length > userVisible && (
                <p className="py-1 text-center text-[10px] text-black/35">
                  已显示 {userVisible} / {filteredUsers.length}，继续向下滚动加载更多
                </p>
              )}
            </div>
          )}
        </div>

        {/* 主播信息查询（直播间状态 + 昵称两个公开接口并行查询，整合去重展示） */}
        <div className="rounded-xl border border-black/10 bg-white/80 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold">主播信息查询</h2>
            <span className="text-[10px] text-black/35">/api/medical/room-id + /api/tools/streamer-info</span>
          </div>
          <p className="text-[10px] text-black/40">
            输入 UID，一次查询直播间状态（是否为主播）与昵称/头像/开播状态。公开接口，无需登录凭证。
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={anchorUid}
              onChange={(e) => setAnchorUid(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && queryAnchorInfo()}
              placeholder="输入 UID"
              className="flex-1 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs focus:outline-none focus:border-black/30"
            />
            <button
              onClick={queryAnchorInfo}
              disabled={anchorQuerying}
              className="flex-shrink-0 rounded-lg bg-[#1f1c17] px-4 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
            >
              {anchorQuerying ? "查询中…" : "查询"}
            </button>
          </div>
          {anchorError && <p className="text-[11px] text-[#e74c3c]">{anchorError}</p>}
          {anchorResult && (
            <div className="flex items-center gap-2 rounded-lg border border-black/10 bg-black/[0.02] px-2 py-1.5">
              {anchorResult.face ? (
                <img src={fixImageUrl(anchorResult.face)} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />
              ) : (
                <div className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium truncate">{anchorResult.uname || "未获取到昵称"}</span>
                  {anchorResult.roomStatus !== null && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                        anchorResult.roomStatus === 1 ? "bg-[#e54d4c]/10 text-[#e54d4c]" : "bg-black/5 text-black/40"
                      }`}
                    >
                      {anchorResult.roomStatus === 1 ? "有房 · 主播" : "无房 · 非主播"}
                    </span>
                  )}
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 bg-black/5 text-black/50">
                    {anchorResult.live_status === 1 ? "直播中" : anchorResult.live_status === 2 ? "轮播" : "未开播"}
                  </span>
                </div>
                <div className="text-[10px] text-black/35 mt-0.5">
                  UID {anchorResult.uid} · 房间 {anchorResult.roomId || "无"}
                  {anchorResult.roomStatus !== null && ` · roomStatus=${anchorResult.roomStatus}`}
                  {anchorResult.title && <span className="truncate"> · {anchorResult.title}</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Config：每个配置模块为独立可折叠卡片，卡片标题栏右侧带各自的“保存配置”按钮 */}
        {config && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">配置管理</h2>
            </div>

            {/* 帮助页公告 */}
            <ConfigCard
              title="帮助页公告"
              collapsed={announcementCollapsed}
              onToggle={() => setAnnouncementCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">显示在“帮助”页面最上方的公告内容，留空则不显示公告卡片。支持换行。</p>
              <textarea
                value={config.announcement ?? ""}
                onChange={(e) => setConfig({ ...config, announcement: e.target.value })}
                placeholder="在此输入公告内容..."
                rows={3}
                className="w-full resize-y rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
              />
            </ConfigCard>

            {/* 帮助页常见问题（可折叠，默认折叠） */}
            <ConfigCard
              title="帮助页常见问题"
              collapsed={faqCollapsed}
              onToggle={() => setFaqCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">显示在“帮助”页面“开机自启动”下方的“常见问题”卡片，每个问题为可展开折叠项（默认折叠）。全部留空则不显示该卡片。</p>
              <div className="flex justify-end">
                <button
                  onClick={() => setConfig({ ...config, faq: [{ q: "", a: "" }, ...(config.faq ?? [])] })}
                  className="text-xs text-[#00a1d6] hover:underline shrink-0"
                >
                  + 添加问题
                </button>
              </div>
              {(config.faq ?? []).length === 0 && (
                <p className="text-[10px] text-black/30">暂无问题</p>
              )}
              <div className="space-y-1">
                {(config.faq ?? []).map((item, i) => (
                  <div key={i} className="rounded-lg border border-black/10 p-1.5 space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        value={item.q}
                        onChange={(e) => {
                          const faq = [...(config.faq ?? [])];
                          faq[i] = { ...faq[i], q: e.target.value };
                          setConfig({ ...config, faq });
                        }}
                        placeholder="问题"
                        className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                      />
                      <button
                        onClick={() => {
                          const faq = (config.faq ?? []).filter((_, idx) => idx !== i);
                          setConfig({ ...config, faq });
                        }}
                        className="text-xs text-[#e74c3c] hover:underline shrink-0"
                      >
                        删除
                      </button>
                    </div>
                    <textarea
                      value={item.a}
                      onChange={(e) => {
                        const faq = [...(config.faq ?? [])];
                        faq[i] = { ...faq[i], a: e.target.value };
                        setConfig({ ...config, faq });
                      }}
                      placeholder="回答（支持换行）"
                      rows={3}
                      className="w-full resize-y rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                  </div>
                ))}
              </div>
            </ConfigCard>

            {/* 帮助页微信群二维码（扫码反馈） */}
            <ConfigCard
              title="帮助页微信群二维码"
              collapsed={wechatQrCollapsed}
              onToggle={() => setWechatQrCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">“帮助”页面反馈卡片的微信群二维码图片，点“上传本地文件”上传到服务器（上传后需点卡片右上角“保存配置”）。留空则显示默认二维码。</p>
              <div className="flex items-center gap-2">
                {(config.wechat_qr_url ?? "").trim() === "" ? (
                  <div className="w-20 h-20 rounded border border-dashed border-black/15 shrink-0 flex items-center justify-center text-[10px] text-black/30">未配置</div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={
                      (config.wechat_qr_url ?? "").trim().startsWith("/")
                        ? serverApiUrl((config.wechat_qr_url ?? "").trim())
                        : fixImageUrl((config.wechat_qr_url ?? "").trim())
                    }
                    alt="微信群二维码预览"
                    className="w-20 h-20 rounded border border-black/10 object-contain shrink-0 bg-white"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = "hidden";
                    }}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <input
                    value={config.wechat_qr_url ?? ""}
                    onChange={(e) => setConfig({ ...config, wechat_qr_url: e.target.value })}
                    placeholder="二维码图片链接（留空则用默认二维码）"
                    className="w-full rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                  />
                  <label className={`inline-block text-xs ${qrUploading !== null ? "text-black/40" : "text-[#00a1d6] hover:underline"} cursor-pointer`}>
                    {qrUploading !== null ? qrUploading : "上传本地文件"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
                      className="hidden"
                      disabled={qrUploading !== null}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // 清空以便同一文件重选时也能触发 onChange
                        e.target.value = "";
                        if (file) void uploadWechatQrFile(file);
                      }}
                    />
                  </label>
                </div>
              </div>
            </ConfigCard>

            {/* 主播活动素材上传（可折叠，默认折叠） */}
            <ConfigCard
              title="主播活动素材上传"
              collapsed={materialsCollapsed}
              onToggle={() => setMaterialsCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">显示在“主播”页面“其他”tab 顶部的“活动素材下载”卡片，每个素材含名称与图片链接（gif 或静态图片）。链接可直接粘贴远程地址，也可点“上传本地文件”上传到服务器（上传后需点卡片右上角“保存配置”）。全部留空则不显示该卡片。</p>
              <div className="flex justify-end">
                <button
                  onClick={() => setConfig({ ...config, anchor_activity_materials: [{ name: "", url: "" }, ...(config.anchor_activity_materials ?? [])] })}
                  className="text-xs text-[#00a1d6] hover:underline shrink-0"
                >
                  + 添加素材
                </button>
              </div>
              {(config.anchor_activity_materials ?? []).length === 0 && (
                <p className="text-[10px] text-black/30">暂无素材</p>
              )}
              <div className="space-y-1">
                {(config.anchor_activity_materials ?? []).map((item, i) => (
                  <div key={i} className="rounded-lg border border-black/10 p-1.5 space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        value={item.name}
                        onChange={(e) => {
                          const list = [...(config.anchor_activity_materials ?? [])];
                          list[i] = { ...list[i], name: e.target.value };
                          setConfig({ ...config, anchor_activity_materials: list });
                        }}
                        placeholder="素材名称"
                        className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                      />
                      <button
                        onClick={() => {
                          const list = (config.anchor_activity_materials ?? []).filter((_, idx) => idx !== i);
                          setConfig({ ...config, anchor_activity_materials: list });
                        }}
                        className="text-xs text-[#e74c3c] hover:underline shrink-0"
                      >
                        删除
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        value={item.url}
                        onChange={(e) => {
                          const list = [...(config.anchor_activity_materials ?? [])];
                          list[i] = { ...list[i], url: e.target.value };
                          setConfig({ ...config, anchor_activity_materials: list });
                        }}
                        placeholder="图片链接（gif 或静态图片）"
                        className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                      />
                      <label className={`text-xs shrink-0 ${materialUploading?.idx === i ? "text-black/40" : "text-[#00a1d6] hover:underline"} ${materialUploading !== null && materialUploading.idx !== i ? "opacity-50 pointer-events-none" : ""} cursor-pointer`}>
                        {materialUploading?.idx === i ? materialUploading.text : "上传本地文件"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
                          className="hidden"
                          disabled={materialUploading !== null}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            // 清空以便同一文件重选时也能触发 onChange
                            e.target.value = "";
                            if (file) void uploadMaterialFile(i, file);
                          }}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </ConfigCard>

            {/* Blind boxes */}
            <ConfigCard
              title="盲盒配置"
              collapsed={blindBoxCollapsed}
              onToggle={() => setBlindBoxCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[10px] text-black/40">☑盈亏 = 纳入“全部盲盒”下拉框，弹幕查询盈亏涵盖该盲盒；☑卡片 = 单独作为一个盲盒卡片显示（需先勾「盈亏」）</p>
                <button onClick={addBlindBox} className="text-xs text-[#00a1d6] hover:underline shrink-0">+ 添加盲盒</button>
              </div>
              <div className="space-y-1">
                {/* 所有盲盒统一逻辑：心动/幸运盲盒同样可勾选、可排序，无默认固定状态 */}
                {config.blind_boxes.map((box, realIndex) => {
                  const boxKey = box._k ?? `idx_${realIndex}`;
                  const expanded = !!expandedBoxKeys[boxKey];
                  const dimmed =
                    !config.current_activity_blind_box_ids.includes(box.id) &&
                    !config.blind_box_profit_ids.includes(box.id);
                  return (
                  <div key={boxKey} className={`rounded-lg border border-black/10 ${dimmed ? "opacity-50" : ""}`}>
                    {/* 标题行 = 折叠选项卡：箭头 + 排序 + 图标 + 名称 + gift_id + 单价 */}
                    <div
                      onClick={() => setExpandedBoxKeys((m) => ({ ...m, [boxKey]: !m[boxKey] }))}
                      className="flex items-center gap-2 flex-wrap px-2 py-1.5 cursor-pointer hover:bg-black/[0.03]"
                    >
                      <svg className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                      <div className="flex flex-col shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => moveBlindBox(realIndex, -1)}
                          disabled={realIndex === 0}
                          className="admin-move-btn"
                          title="上移"
                        >▲</button>
                        <button
                          onClick={() => moveBlindBox(realIndex, 1)}
                          disabled={realIndex === config.blind_boxes.length - 1}
                          className="admin-move-btn"
                          title="下移"
                        >▼</button>
                      </div>
                      {/* 卡片 / 盈亏：置于上下移按钮之后、上下两行堆叠，标题行直接可见状态 */}
                      <div className="flex flex-col shrink-0 gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <label className="flex items-center gap-1 shrink-0" title="单独作为一个盲盒卡片显示（需先勾选「盈亏」，卡片必然纳入盈亏统计）">
                          <input
                            type="checkbox"
                            checked={box.id > 0 && config.current_activity_blind_box_ids.includes(box.id)}
                            onChange={() => toggleCurrentBoxId(box.id)}
                            disabled={box.id <= 0 || !config.blind_box_profit_ids.includes(box.id)}
                            className="w-3.5 h-3.5 accent-[#00a1d6] disabled:opacity-40"
                          />
                          <span className={`text-[10px] ${box.id > 0 && !config.blind_box_profit_ids.includes(box.id) ? "text-black/30" : "text-black/50"}`}>卡片</span>
                        </label>
                        <label className="flex items-center gap-1 shrink-0" title="纳入“全部盲盒”下拉框，弹幕查询盈亏涵盖该盲盒">
                          <input
                            type="checkbox"
                            checked={box.id > 0 && config.blind_box_profit_ids.includes(box.id)}
                            onChange={() => toggleProfitBoxId(box.id)}
                            disabled={box.id <= 0}
                            className="w-3.5 h-3.5 accent-[#00a1d6]"
                          />
                          <span className="text-[10px] text-black/50">盈亏</span>
                        </label>
                      </div>
                      {/* 图标：点击弹出链接编辑框 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIconEditor({
                            title: "盲盒图标链接",
                            value: box.icon,
                            apply: (v) => updateBlindBox(realIndex, "icon", v),
                          });
                        }}
                        title="点击编辑图标链接"
                        className="w-7 h-7 rounded shrink-0 border border-dashed border-black/20 flex items-center justify-center overflow-hidden hover:border-[#00a1d6]"
                      >
                        {box.icon ? (
                          <img src={box.icon} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[9px] text-black/30">图</span>
                        )}
                      </button>
                      {/* 名称输入 + 下拉搜索建议 */}
                      <div className="relative flex-1 min-w-[70px]" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={box.name}
                          onChange={(e) => {
                            // 名称可自由自定义（过期盲盒搜索不到时直接手输），不清空已有 id
                            updateBlindBox(realIndex, "name", e.target.value);
                            setBlindBoxSearchIndex(realIndex);
                          }}
                          onFocus={() => setBlindBoxSearchIndex(realIndex)}
                          onBlur={() => setTimeout(() => setBlindBoxSearchIndex(null), 200)}
                          placeholder="盲盒名称（可搜索，也可直接输入）"
                          className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                        />
                        {blindBoxSearchIndex === realIndex && box.name.trim() && (
                          <div className="absolute z-10 mt-1 w-full rounded-lg border border-black/10 bg-white shadow-lg max-h-40 overflow-y-auto">
                            {searchGiftsByName(box.name).length > 0 ? (
                              searchGiftsByName(box.name).map((g) => (
                                <button
                                  key={g.id}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    selectGiftForBlindBox(realIndex, g);
                                  }}
                                  className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-black/5 text-xs"
                                >
                                  {g.img && <img src={g.img} alt="" className="w-5 h-5 rounded shrink-0" />}
                                  <span className="truncate">{g.name}</span>
                                  <span className="ml-auto text-black/40 shrink-0">id:{g.id}</span>
                                </button>
                              ))
                            ) : (
                              <div className="px-2 py-1.5 text-xs text-black/40">未找到匹配的礼物</div>
                            )}
                          </div>
                        )}
                      </div>
                      {/* gift_id 可直接输入：过期盲盒在目录中搜索不到时手填 */}
                      <input
                        type="number"
                        value={box.id || ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => updateBlindBox(realIndex, "id", e.target.value)}
                        placeholder="gift_id"
                        title="盲盒的 gift_id（过期盲盒搜不到时可直接填写）"
                        className="w-[68px] rounded border border-black/10 px-1.5 py-1.5 text-xs focus:outline-none focus:border-black/30 shrink-0"
                      />
                      {/* 单价 */}
                      <label className="flex items-center gap-1 shrink-0" title="盲盒单价（电池），用于计算花费" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          value={box.blind_price ?? 0}
                          onChange={(e) => updateBlindBoxPrice(realIndex, e.target.value)}
                          className="w-[58px] rounded border border-black/10 px-1.5 py-1.5 text-xs focus:outline-none focus:border-black/30"
                        />
                        <span className="text-[10px] text-black/40">电池</span>
                      </label>
                    </div>
                    {/* 从B站获取 / 删除（折叠卡内；卡片/盈亏已移至标题行） */}
                    {expanded && (
                      <div className="border-t border-black/5 bg-black/[0.03] px-2 py-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap pb-1">
                          <button
                            onClick={() => fetchBlindBoxFromBili(realIndex)}
                            disabled={box.id <= 0 || fetchingBoxInfo === realIndex}
                            className="text-xs text-[#00a1d6] hover:underline disabled:text-black/30 disabled:no-underline shrink-0"
                            title="由服务器代读 B站接口，自动回填名称/单价/礼物列表（需先填写盲盒 ID）"
                          >
                            {fetchingBoxInfo === realIndex ? "获取中…" : "从B站获取"}
                          </button>
                          <button onClick={() => removeBlindBox(realIndex)} className="text-xs text-[#e74c3c] hover:underline shrink-0 ml-auto">删除</button>
                        </div>
                        {(box.gifts ?? []).length === 0 && (
                          <p className="text-[10px] text-black/40">暂无明细。可「从B站获取」，或手动添加（含过期盲盒礼物 / 奖励礼物）</p>
                        )}
                        {(box.gifts ?? []).map((gift, giftIndex) => (
                          <div key={giftIndex} className="flex items-center gap-1.5">
                            {/* 礼物图标：点击弹出链接编辑框 */}
                            <button
                              type="button"
                              onClick={() => setIconEditor({
                                title: `「${gift.gift_name || "礼物"}」图标链接`,
                                value: gift.gift_img ?? "",
                                apply: (v) => updateBlindBoxGift(realIndex, giftIndex, { gift_img: v }),
                              })}
                              title="点击编辑图标链接"
                              className="w-6 h-6 rounded shrink-0 border border-dashed border-black/20 flex items-center justify-center overflow-hidden hover:border-[#00a1d6]"
                            >
                              {gift.gift_img ? (
                                <img src={gift.gift_img} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <span className="text-[8px] text-black/30">图</span>
                              )}
                            </button>
                            {/* 礼物名称 + 联想搜索 */}
                            <div className="relative flex-1 min-w-[70px]">
                              <input
                                type="text"
                                value={gift.gift_name}
                                onChange={(e) => {
                                  updateBlindBoxGift(realIndex, giftIndex, { gift_name: e.target.value });
                                  setBlindBoxGiftSearch({ box: realIndex, gift: giftIndex });
                                }}
                                onFocus={() => setBlindBoxGiftSearch({ box: realIndex, gift: giftIndex })}
                                onBlur={() => setTimeout(() => setBlindBoxGiftSearch(null), 200)}
                                placeholder="礼物名称（可自由输入）"
                                className="w-full rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                              />
                              {blindBoxGiftSearch?.box === realIndex && blindBoxGiftSearch?.gift === giftIndex && gift.gift_name.trim() && (
                                <div className="absolute z-10 mt-1 w-full rounded-lg border border-black/10 bg-white shadow-lg max-h-40 overflow-y-auto">
                                  {searchGiftsByName(gift.gift_name).length > 0 ? (
                                    searchGiftsByName(gift.gift_name).map((g) => (
                                      <button
                                        key={g.id}
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          selectGiftForBlindBoxGift(realIndex, giftIndex, g);
                                        }}
                                        className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-black/5 text-xs"
                                      >
                                        {g.img && <img src={g.img} alt="" className="w-5 h-5 rounded shrink-0" />}
                                        <span className="truncate">{g.name}</span>
                                        <span className="ml-auto text-black/40 shrink-0">id:{g.id}</span>
                                      </button>
                                    ))
                                  ) : (
                                    <div className="px-2 py-1.5 text-xs text-black/40">未找到匹配的礼物（可直接使用输入的名称）</div>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* gift_id */}
                            <input
                              type="number"
                              value={gift.gift_id || ""}
                              onChange={(e) => updateBlindBoxGift(realIndex, giftIndex, { gift_id: Number(e.target.value) || 0 })}
                              placeholder="gift_id"
                              className="w-[68px] rounded border border-black/10 px-1.5 py-1 text-xs focus:outline-none focus:border-black/30 shrink-0"
                            />
                            {/* 价格 */}
                            <div className="flex items-center gap-0.5 shrink-0">
                              <input
                                type="number"
                                value={gift.price || ""}
                                onChange={(e) => updateBlindBoxGift(realIndex, giftIndex, { price: Number(e.target.value) || 0 })}
                                placeholder="价格"
                                className="w-[58px] rounded border border-black/10 px-1.5 py-1 text-xs focus:outline-none focus:border-black/30"
                              />
                              <span className="text-[10px] text-black/40">电池</span>
                            </div>
                            {/* 奖励勾选 */}
                            <label className="flex items-center gap-1 shrink-0" title="额外奖励礼物：只计价值，不计抽数与成本">
                              <input
                                type="checkbox"
                                checked={!!gift.is_reward}
                                onChange={(e) => updateBlindBoxGift(realIndex, giftIndex, { is_reward: e.target.checked })}
                                className="w-3.5 h-3.5 accent-[#00a1d6]"
                              />
                              <span className="text-[10px] text-black/50">奖励</span>
                            </label>
                            <button
                              onClick={() => removeBlindBoxGift(realIndex, giftIndex)}
                              className="text-xs text-[#e74c3c] hover:underline shrink-0"
                              title="删除该礼物"
                            >×</button>
                          </div>
                        ))}
                        <button onClick={() => addBlindBoxGift(realIndex)} className="text-xs text-[#00a1d6] hover:underline">+ 添加礼物</button>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
              {/* 图标链接编辑弹窗（点击图标弹出） */}
              {iconEditor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setIconEditor(null)}>
                  <div className="w-[min(90vw,420px)] rounded-xl bg-white p-2 shadow-xl space-y-1.5" onClick={(e) => e.stopPropagation()}>
                    <h4 className="text-xs font-semibold">{iconEditor.title}</h4>
                    <input
                      autoFocus
                      type="text"
                      value={iconEditor.value}
                      onChange={(e) => setIconEditor({ ...iconEditor, value: e.target.value })}
                      placeholder="图标链接（留空则不显示）"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                    <div className="flex justify-end gap-3">
                      <button onClick={() => setIconEditor(null)} className="text-xs text-black/50 hover:underline">取消</button>
                      <button
                        onClick={() => { iconEditor.apply(iconEditor.value.trim()); setIconEditor(null); }}
                        className="text-xs text-[#00a1d6] hover:underline"
                      >确定</button>
                    </div>
                  </div>
                </div>
              )}
            </ConfigCard>

            {/* Synthesis activities */}
            <ConfigCard
              title="合成活动盈亏配置"
              collapsed={synthesisCollapsed}
              onToggle={() => setSynthesisCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <div className="flex items-center justify-between">
                <button onClick={addActivity} className="text-xs text-[#00a1d6] hover:underline">+ 添加活动</button>
              </div>
              <p className="text-[10px] text-black/40">勾选 = 在页面上展示该活动</p>
              <p className="text-[10px] text-black/40">起止时间可选，不填则使用全部消费记录；材料抽取记录在 [起, 止] 内，产物送出记录截止到「止 + 49 小时」（48h 送出窗口 + 1h 容错）。产物为合成的礼物（包裹/送出记录），素材为抽取时的花费记录，素材总花费自动汇总，无需与产物一一对应。起止只填日期，开始=0点、结束=24点。</p>
              <div className="space-y-1.5">
                {config.synthesis_activities.map((act, i) => (
                  <div key={i} className={`rounded-lg border border-black/10 p-1.5 space-y-1 ${act.active === false ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveActivity(i, -1)}
                          disabled={i === 0}
                          className="admin-move-btn"
                          title="上移"
                        >▲</button>
                        <button
                          onClick={() => moveActivity(i, 1)}
                          disabled={i === config.synthesis_activities.length - 1}
                          className="admin-move-btn"
                          title="下移"
                        >▼</button>
                      </div>
                      <input
                        type="checkbox"
                        checked={act.active !== false}
                        onChange={() => toggleActivityActive(i)}
                        className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                        title="勾选为展示活动"
                      />
                      <input
                        type="text"
                        value={act.name ?? ""}
                        onChange={(e) => updateActivity(i, "name", e.target.value)}
                        placeholder="活动名称"
                        className="flex-1 min-w-[120px] rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                      />
                      <button onClick={() => removeActivity(i)} className="text-xs text-[#e74c3c] hover:underline ml-auto">删除</button>
                    </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <label className="flex items-center gap-1 text-[10px] text-black/50 shrink-0">
                            <span>起</span>
                            <input
                              type="date"
                              value={tsToDateInput(act.start_time)}
                              onChange={(e) => updateActivity(i, "start_time", dateStartToTs(e.target.value))}
                              className="rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-black/50 shrink-0">
                            <span>止</span>
                            <input
                              type="date"
                              value={tsToDateInput(act.end_time)}
                              onChange={(e) => updateActivity(i, "end_time", dateEndToTs(e.target.value))}
                              className="rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                            />
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                        {/* 产物配置 */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium text-black/60">产物</span>
                            <button onClick={() => addActivityProduct(i)} className="text-[10px] text-[#00a1d6] hover:underline">+ 添加产物</button>
                          </div>
                          {(act.products || []).length === 0 && (
                            <p className="text-[10px] text-black/30">暂无产物，添加合成的礼物名称</p>
                          )}
                          {(act.products || []).map((pname, pi) => (
                            <div key={pi} className="flex items-center gap-1.5">
                              <div className="relative flex-1 min-w-[90px]">
                                <input
                                  type="text"
                                  value={pname}
                                  onChange={(e) => {
                                    updateActivityProduct(i, pi, e.target.value);
                                    setProductSearch({ act: i, product: pi });
                                  }}
                                  onFocus={() => setProductSearch({ act: i, product: pi })}
                                  onBlur={() => setTimeout(() => setProductSearch(null), 200)}
                                  placeholder="产物礼物名称（从礼物列表选择）"
                                  className="w-full rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                                />
                                {productSearch && productSearch.act === i && productSearch.product === pi && pname.trim() && (
                                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-black/10 bg-white shadow-lg max-h-40 overflow-y-auto">
                                    {searchGiftsByName(pname).length > 0 ? (
                                      searchGiftsByName(pname).map((g) => (
                                        <button
                                          key={g.id}
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            selectGiftForProduct(i, pi, g.name);
                                          }}
                                          className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-black/5 text-[11px]"
                                        >
                                          {g.img && <img src={g.img} alt="" className="w-5 h-5 rounded shrink-0" />}
                                          <span className="truncate">{g.name}</span>
                                          <span className="ml-auto text-black/40 shrink-0">id:{g.id}</span>
                                        </button>
                                      ))
                                    ) : (
                                      <div className="px-2 py-1.5 text-[11px] text-black/40">未找到匹配的礼物</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              <button onClick={() => removeActivityProduct(i, pi)} className="text-[11px] text-[#e74c3c] hover:underline shrink-0">×</button>
                            </div>
                          ))}
                        </div>
                        {/* 素材配置 */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium text-black/60">素材</span>
                            <button onClick={() => addActivityMaterial(i)} className="text-[10px] text-[#00a1d6] hover:underline">+ 添加素材</button>
                          </div>
                          {(act.materials || []).length === 0 && (
                            <p className="text-[10px] text-black/30">暂无素材，添加抽取材料名称（同类可只填一个）</p>
                          )}
                          {(act.materials || []).map((mname, mi) => (
                            <div key={mi} className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={mname}
                                onChange={(e) => updateActivityMaterial(i, mi, e.target.value)}
                                placeholder="素材礼物名称"
                                className="flex-1 min-w-[90px] rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                              />
                              <button onClick={() => removeActivityMaterial(i, mi)} className="text-[11px] text-[#e74c3c] hover:underline shrink-0">×</button>
                            </div>
                          ))}
                        </div>
                        </div>
                  </div>
                ))}
              </div>
            </ConfigCard>

            {/* 模拟器活动配置（玩法可热更新） */}
            <ConfigCard
              title="模拟器活动配置（玩法可热更新）"
              collapsed={simulatorCollapsed}
              onToggle={() => setSimulatorCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <div className="flex items-center justify-between">
                <button onClick={addSimulatorActivity} className="text-xs text-[#00a1d6] hover:underline">+ 添加活动</button>
              </div>
              <p className="text-[10px] text-black/40">
                模拟器页面活动入口：每个活动配置真实 H5 链接 + 选择背后玩法算法类型。算法类型对应 mock-shim.js 里的一套 mock 算法；
                新活动若属于已有算法类型，只需新增配置并选择对应类型即可，无需改代码；全新玩法需实现算法后通过前端热更新推送（无需原生包更新）。
                所有活动都会列出，勾选前面的复选框即在模拟器显示入口卡片；全部未勾选则模拟器不显示活动入口。
              </p>
              <div className="space-y-1.5">
                {config.simulator_activities.map((act, i) => (
                  <div key={i} className={`rounded-lg border border-black/10 p-1.5 space-y-1 ${!act.enabled ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="checkbox"
                        checked={act.enabled}
                        onChange={(e) => updateSimulatorActivity(i, "enabled", e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                        title="勾选为展示活动"
                      />
                      <input
                        type="text"
                        value={act.title}
                        onChange={(e) => updateSimulatorActivity(i, "title", e.target.value)}
                        placeholder="活动名称（如：玲珑宝斋）"
                        className="flex-1 min-w-[120px] rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30"
                      />
                      <select
                        value={act.algorithmType}
                        onChange={(e) => updateSimulatorActivity(i, "algorithmType", e.target.value)}
                        className="rounded border border-black/10 px-2 py-1 text-xs focus:outline-none focus:border-black/30 shrink-0"
                        title="选择玩法算法类型"
                      >
                        {Object.entries(ALGORITHM_REGISTRY).map(([key, def]) => (
                          <option key={key} value={key}>{def.label}</option>
                        ))}
                      </select>
                      <button onClick={() => removeSimulatorActivity(i)} className="text-xs text-[#e74c3c] hover:underline ml-auto">删除</button>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block">
                        <span className="text-[10px] text-black/50">活动 ID（唯一，如 fans-autumn-2026）</span>
                        <input
                          type="text"
                          value={act.id}
                          onChange={(e) => updateSimulatorActivity(i, "id", e.target.value)}
                          placeholder="fans-autumn-2026"
                          className="w-full rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[10px] text-black/50">入口卡片图片 URL</span>
                        <input
                          type="text"
                          value={act.entryImage}
                          onChange={(e) => updateSimulatorActivity(i, "entryImage", e.target.value)}
                          placeholder="https://..."
                          className="w-full rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[10px] text-black/50">活动页面 URL 模板（{'{room_id}'}=直播间号、{'{uid}'}=主播UID，打开时替换）</span>
                        <input
                          type="text"
                          value={act.urlTemplate}
                          onChange={(e) => updateSimulatorActivity(i, "urlTemplate", e.target.value)}
                          placeholder="https://live.bilibili.com/activity/...?room_id={room_id}&uid={uid}#/play?..."
                          className="w-full rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-[10px] text-black/50">
                          <span>roomId</span>
                          <input
                            type="number"
                            value={act.roomId || ""}
                            onChange={(e) => updateSimulatorActivity(i, "roomId", Number(e.target.value))}
                            placeholder="0"
                            className="w-24 rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-black/50">
                          <span>uid</span>
                          <input
                            type="number"
                            value={act.uid || ""}
                            onChange={(e) => updateSimulatorActivity(i, "uid", Number(e.target.value))}
                            placeholder="0"
                            className="w-28 rounded border border-black/10 px-2 py-1 text-[11px] focus:outline-none focus:border-black/30"
                          />
                        </label>
                        <span className="text-[10px] text-black/30 ml-auto">运行时会被当前主播信息覆盖</span>
                      </div>
                      <label className="block">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-black/50">算法参数（JSON，可选；覆盖算法默认值，如 {"{"}"draw_price":3000{"}"}）</span>
                          <button
                            type="button"
                            onClick={() => openParamsEditor(i)}
                            className="text-[10px] text-[#00a1d6] hover:underline shrink-0"
                          >
                            全屏编辑
                          </button>
                        </div>
                        <textarea
                          value={act.algorithmParams}
                          onChange={(e) => updateSimulatorActivity(i, "algorithmParams", e.target.value)}
                          rows={6}
                          placeholder="{ }"
                          className="w-full rounded border border-black/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-black/30 resize-y"
                        />
                      </label>
                      {ALGORITHM_REGISTRY[act.algorithmType]?.description && (
                        <p className="text-[10px] text-black/30">{ALGORITHM_REGISTRY[act.algorithmType].description}</p>
                      )}
                    </div>
                  </div>
                ))}
                {config.simulator_activities.length === 0 && (
                  <p className="text-[10px] text-black/30">暂无活动配置，点击"+ 添加活动"新增</p>
                )}
              </div>
            </ConfigCard>

            {/* 黑抽（真实合成活动）URL 配置 */}
            <ConfigCard
              title="黑抽（真实合成活动）页面 URL"
              collapsed={blackdrawCollapsed}
              onToggle={() => setBlackdrawCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">
                填写 B站 真实合成活动页面 URL 模板，使用 {'{room_id}'} 和 {'{uid}'} 作为占位符（{'{room_id}'}=直播间号、{'{uid}'}=用户UID）；留空则"黑抽"卡片变灰不可点击。例如：https://live.bilibili.com/activity/...?room_id={'{room_id}'}&uid={'{uid}'}#/play?config_id=...
              </p>
              <textarea
                value={config.real_activity_url}
                onChange={(e) => setConfig({ ...config, real_activity_url: toActivityUrlTemplate(e.target.value) })}
                placeholder="粘贴活动 URL 模板"
                rows={Math.max(1, Math.ceil((config.real_activity_url?.length ?? 0) / 80))}
                className="w-full resize-y rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
              />
              {config.real_activity_url && (
                <p className="text-[10px] text-[#2ecc71]">✓ 已配置，黑抽入口可用</p>
              )}
              {!config.real_activity_url && (
                <p className="text-[10px] text-black/40">⚠ 未配置，首页"黑抽"卡片将变灰不可点击</p>
              )}
            </ConfigCard>

            {/* 推荐主播管理 */}
            <ConfigCard
              title="推荐主播配置"
              collapsed={recommendedCollapsed}
              onToggle={() => setRecommendedCollapsed((v) => !v)}
              onSave={handleSaveConfig}
              saved={configSaved}
            >
              <p className="text-[10px] text-black/40">勾选 = 在帮助页「主播推荐」卡片中显示；顺序决定页面展示顺序</p>
              {/* 添加主播 */}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={newAnchorUid}
                  onChange={(e) => setNewAnchorUid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newAnchorUid.trim() && !addingAnchor) addRecommendedAnchor(); }}
                  placeholder="输入主播UID"
                  className="flex-1 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                />
                <button
                  onClick={addRecommendedAnchor}
                  disabled={addingAnchor || !newAnchorUid.trim()}
                  className="rounded-lg bg-[#00a1d6] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
                >
                  {addingAnchor ? "查询中..." : "+ 添加主播"}
                </button>
              </div>
              {/* 主播列表 */}
              <div className="space-y-1">
                {config.recommended_anchors.length === 0 ? (
                  <p className="text-[10px] text-black/30 py-3 text-center">暂无推荐主播，在上方输入UID添加</p>
                ) : (
                  [...config.recommended_anchors]
                    .sort((a, b) => a.order - b.order)
                    .map((anchor, index) => (
                      <div
                        key={anchor.uid}
                        className={`rounded-lg border border-black/10 p-1.5 ${!anchor.visible ? "opacity-50" : ""}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* 上下移动按钮 */}
                          <div className="flex flex-col shrink-0">
                            <button
                              onClick={() => moveRecommendedAnchor(index, -1)}
                              disabled={index === 0}
                              className="admin-move-btn"
                              title="上移"
                            >▲</button>
                            <button
                              onClick={() => moveRecommendedAnchor(index, 1)}
                              disabled={index === config.recommended_anchors.length - 1}
                              className="admin-move-btn"
                              title="下移"
                            >▼</button>
                          </div>
                          {/* 复选框 */}
                          <input
                            type="checkbox"
                            checked={anchor.visible}
                            onChange={() => toggleAnchorVisible(anchor.uid)}
                            className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                            title="勾选后在帮助页显示"
                          />
                          {/* 头像 */}
                          {anchor.face ? (
                            <img src={fixImageUrl(anchor.face)} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />
                          ) : (
                            <div className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5 flex items-center justify-center text-xs text-black/30">👤</div>
                          )}
                          {/* 昵称+UID+房间号 */}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate">{anchor.uname}</div>
                            <div className="text-[10px] text-black/35">UID {anchor.uid} · 房间 {anchor.room_id || "未知"}</div>
                          </div>
                          {/* 删除按钮 */}
                          <button
                            onClick={() => removeRecommendedAnchor(anchor.uid)}
                            className="text-xs text-[#e74c3c] hover:underline shrink-0"
                          >删除</button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </ConfigCard>
          </div>
        )}

        {/* 抽奖记录（页面左下方） */}
        <div className="rounded-xl border border-black/10 bg-white/80 p-2">
          <div className="flex items-center justify-between mb-1.5">
            <h2 className="text-sm font-bold">抽奖记录</h2>
            <span className="text-[10px] text-black/40">
              共 {lotteryRecords.length} 次
              {lotteryRecords.some((r) => r.won) && (
                <span className="ml-1 text-[#f59e0b]">· 中奖 {lotteryRecords.filter((r) => r.won).length} 次</span>
              )}
            </span>
          </div>

          {/* 概率设置：格式 1/n，改后所有平台立即生效 + 抽奖活动开关 */}
          <div className="flex items-center gap-2 mb-1.5 rounded-lg border border-black/10 bg-black/[0.02] px-2 py-1">
            <span className="text-[11px] text-black/50 flex-shrink-0">中奖概率</span>
            <span className="text-[11px] text-black/70 flex-shrink-0">1/</span>
            <input
              value={lotteryDenomInput}
              onChange={(e) => setLotteryDenomInput(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="20"
              inputMode="numeric"
              className="w-16 rounded border border-black/10 bg-white px-1.5 py-1 text-[11px] text-black/80 outline-none focus:border-[#00a1d6]"
            />
            <button
              onClick={saveLotteryConfig}
              disabled={lotterySavingConfig || lotteryDenomInput === String(lotteryOddsDenom)}
              className="ml-auto rounded bg-[#00a1d6] px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              {lotterySavingConfig ? "保存中…" : "保存概率"}
            </button>
            <button
              onClick={cycleLotteryMode}
              disabled={lotteryToggling}
              title="点击循环切换状态：全部开放 → 已暂停 → 仅主播"
              className={`flex-shrink-0 rounded px-3 py-1 text-[11px] font-medium border transition ${
                lotteryMode === "all"
                  ? "border-green-200 bg-green-50 text-green-600 hover:bg-green-100"
                  : lotteryMode === "paused"
                    ? "border-[#e74c3c]/40 bg-[#fdf0ef] text-[#e74c3c] hover:bg-[#fde3e0]"
                    : "border-[#00a1d6]/40 bg-[#eef7fc] text-[#0088b8] hover:bg-[#e0f1fa]"
              } disabled:opacity-50`}
            >
              {lotteryToggling
                ? "切换中…"
                : lotteryMode === "all"
                  ? "● 抽奖中"
                  : lotteryMode === "paused"
                    ? "■ 已暂停"
                    : "◆ 仅主播"}
            </button>
          </div>

          {lotteryRecords.length === 0 ? (
            <p className="text-xs text-black/30 py-3 text-center">暂无抽奖记录</p>
          ) : lotteryRecords.every((rec) => !rec.won) ? (
            <p className="text-xs text-black/30 py-3 text-center">暂无中奖记录</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {/* 只渲染中奖记录（未中奖记录量大时避免渲染卡顿，头部统计仍显示完整数量） */}
              {lotteryRecords.filter((rec) => rec.won).map((rec) => (
                <div
                  key={`${rec.mid}_${rec.drawnAt}`}
                  className="flex items-center gap-2 rounded-lg border px-2 py-1 border-[#f59e0b]/40 bg-gradient-to-r from-[#fef3c7]/70 to-[#fde68a]/50"
                >
                  <span className="text-base flex-shrink-0">🎉</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">
                      {rec.uname || "未知用户"}
                    </div>
                    <div className="text-[10px] text-black/35 mt-0.5">UID {rec.mid}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-[10px] font-medium text-[#b45309]">
                      概率 {rec.odds} · {rec.prize.replace("一个月", "")}
                    </div>
                    <div className="text-[10px] text-black/30 mt-0.5">{new Date(rec.drawnAt).toLocaleString("zh-CN")}</div>
                  </div>
                  {/* 发放状态：中奖记录标记后不可重复发放 */}
                  {rec.rewardGranted ? (
                    <span className="flex-shrink-0 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-600">
                      已发放
                    </span>
                  ) : (
                    <button
                      onClick={() => grantLotteryReward(rec.mid)}
                      disabled={lotteryGrantingMid === rec.mid}
                      className="flex-shrink-0 rounded-full border border-[#f59e0b]/50 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-[#b45309] hover:bg-amber-100 disabled:opacity-50"
                    >
                      {lotteryGrantingMid === rec.mid ? "标记中…" : "未发放"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 全局访问开关（kill switch）：左侧按钮一键切断/恢复
            「所有客户端对服务器 API 的访问」（放行 /api/admin/*，管理后台始终可用），
            右侧为状态与文字说明。发布后出 BUG 时的紧急止损保底措施。 */}
        <div className="mb-8 rounded-xl border border-black/10 bg-white/80 p-2">
          <div className="flex items-stretch gap-3">
            <button
              type="button"
              onClick={() => toggleGlobalSwitch(!globalSwitchDisabled)}
              disabled={globalSwitchToggling}
              className={`flex-shrink-0 h-16 w-16 rounded-full border text-[11px] leading-tight font-medium transition active:scale-95 disabled:opacity-60 ${
                globalSwitchDisabled
                  ? "border-[#e74c3c]/40 bg-[#e74c3c] text-white hover:brightness-105"
                  : "border-black/10 bg-white text-black/70 hover:bg-black/5"
              }`}
            >
              {globalSwitchToggling ? "处理中…" : globalSwitchDisabled ? "恢复访问" : "切断访问"}
            </button>
            <div className="min-w-0 flex-1 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                全局访问开关
                <span className={globalSwitchDisabled ? "text-[#e74c3c]" : "text-[#2ecc71]"}>
                  {globalSwitchDisabled ? "已切断" : "正常"}
                </span>
              </div>
              <p className="text-[10px] text-black/40 mt-0.5">
                {globalSwitchDisabled
                  ? "所有客户端对服务器 API 的访问已切断（管理后台仍可用）。点击按钮恢复。"
                  : "切断后所有客户端无法访问服务器 API（管理后台仍可用），用于出 BUG 时紧急止损。"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 算法参数全屏编辑器：PC 端避开顶部窗口标题栏（DESKTOP_TITLEBAR_H），移动端/浏览器全屏 */}
      {paramsEditIndex !== null && config && (
        (() => {
          const isMobile = typeof navigator !== "undefined" && /iPad|iPhone|iPod|Android/.test(navigator.userAgent);
          const titlebarH = isTauri() && !isMobile ? DESKTOP_TITLEBAR_H : 0;
          return (
            <div
              className="fixed left-0 right-0 bottom-0 z-[99998] flex flex-col bg-white"
              style={{ top: titlebarH, boxShadow: "0 -8px 24px rgba(0,0,0,.14)" }}
            >
              <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 shrink-0">
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">编辑算法参数（JSON）</span>
                  <span className="text-[10px] text-black/40">
                    {config.simulator_activities[paramsEditIndex]?.title || ""} ·{" "}
                    {ALGORITHM_REGISTRY[config.simulator_activities[paramsEditIndex]?.algorithmType || ""]?.label || "未知算法"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setParamsEditIndex(null)}
                    className="rounded border border-black/10 px-3 py-1.5 text-xs text-black/60 hover:bg-black/5"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={saveParamsEditor}
                    className="rounded bg-[#00a1d6] px-4 py-1.5 text-xs text-white hover:opacity-90"
                  >
                    保存
                  </button>
                </div>
              </div>
              {paramsEditError && (
                <div className="border-b border-[#e74c3c]/20 bg-[#fdf0ef] px-4 py-2 text-xs text-[#e74c3c] shrink-0">
                  {paramsEditError}
                </div>
              )}
              <textarea
                value={paramsEditText}
                onChange={(e) => {
                  setParamsEditText(e.target.value);
                  if (paramsEditError) setParamsEditError("");
                }}
                className="flex-1 w-full resize-none p-4 font-mono text-xs outline-none"
                spellCheck={false}
                placeholder="{ }"
                autoFocus
              />
            </div>
          );
        })()
      )}

      {/* 从服务器拉取账号数据的加载遮罩（样式与首次登录一致，因无月度数据进度故为不确定进度条） */}
      {serverLoading && (
        <div className="fixed inset-0 z-[9999] bg-white/70 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 w-full max-w-[300px] px-6">
            <div className="w-12 h-12 border-4 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-base font-medium text-[#1f1c17]">加载中...</p>
            <p className="text-sm text-black/45">正在从服务器拉取该账号数据，请耐心等待</p>
            <div className="w-full">
              <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full bg-[#1f1c17] w-1/3 progress-indeterminate"></div>
              </div>
              <p className="mt-2 text-xs text-black/55 text-center">从自建服务器获取数据，非 B站数据</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
