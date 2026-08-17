"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { serverApiUrl, serverPost, isTauri, pageUrl } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { dataFetch } from "@/lib/client-fetch";
import Dropdown from "@/components/Dropdown";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import WindowTitleBar from "@/components/WindowTitleBar";

function fixImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

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
};

type BlindBoxItem = { id: number; name: string; icon: string };
type ActivityItem = { id: string; type: string; info_url: string; record_url: string; active?: boolean };

type RecommendedAnchorItem = {
  uid: number;
  uname: string;
  face?: string;
  room_id: number;
  visible: boolean;
  order: number;
};

type AdminConfigData = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  synthesis_activities: ActivityItem[];
  valid_activity_types: string[];
  recommended_anchors: RecommendedAnchorItem[];
};

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
  // 活动名称映射（从本地活动信息 JSON 读取，只读展示）
  const [activityNames, setActivityNames] = useState<Record<string, string>>({});
  // 从服务器拉取账号数据时的阻塞遮罩
  const [serverLoading, setServerLoading] = useState(false);
  // 礼物目录（用于盲盒按名称搜索：gift_id -> { name, img }）
  const [giftCatalog, setGiftCatalog] = useState<Record<number, { name: string; img: string }>>({});
  // 盲盒名称搜索建议（当前展开的行索引）
  const [blindBoxSearchIndex, setBlindBoxSearchIndex] = useState<number | null>(null);

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

  const loadActivityNames = useCallback(async (activities: ActivityItem[]) => {
    const names: Record<string, string> = {};
    await Promise.all(
      activities.map(async (act) => {
        if (!act.id) return;
        try {
          const res = await adminFetch(serverApiUrl(`/api/admin/activity-info?activity_id=${encodeURIComponent(act.id)}`));
          const data = await res.json();
          if (data.code === 0 && data.data?.name) {
            names[act.id] = data.data.name;
          }
        } catch { /* ignore */ }
      }),
    );
    setActivityNames(names);
  }, []);

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
        // 数组字段全部兜底，避免老配置文件缺字段引发 TypeError: undefined.length
        const normalized: AdminConfigData = {
          current_activity_blind_box_ids: Array.isArray(data.current_activity_blind_box_ids)
            ? data.current_activity_blind_box_ids
            : [],
          blind_boxes: Array.isArray(data.blind_boxes) ? data.blind_boxes : [],
          synthesis_activities: Array.isArray(data.synthesis_activities)
            ? data.synthesis_activities
            : [],
          valid_activity_types: Array.isArray(data.valid_activity_types)
            ? data.valid_activity_types
            : [],
          recommended_anchors: Array.isArray(data.recommended_anchors)
            ? data.recommended_anchors
            : [],
        };
        setConfig(normalized);
        loadActivityNames(normalized.synthesis_activities);
        // 解析礼物目录（用于盲盒按名称搜索）
        try {
          const catalogData = await catalogRes.json();
          if (catalogData.code === 0 && catalogData.data?.gifts) {
            const catalog: Record<number, { name: string; img: string }> = catalogData.data.gifts;
            setGiftCatalog(catalog);
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
  }, [loadActivityNames]);

  useEffect(() => {
    if (adminLoggedIn) loadData();
  }, [adminLoggedIn, loadData]);

  // 服务器收集账号无本地头像，用 B站公开信息接口按 UID 补齐头像（已尝试过的 mid 不再重复请求）
  const avatarAttempted = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!adminLoggedIn || users.length === 0) return;
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
  }, [adminLoggedIn, users]);

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
    setServerLoading(true);
    try {
      const platform = await getPlatform();
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
    const res = await adminFetch(serverApiUrl("/api/admin/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.code === 0) {
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } else {
      alert(data.message || "保存失败");
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
    setConfig({
      ...config,
      blind_boxes: [...config.blind_boxes, { id: 0, name: "", icon: "" }],
    });
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
    });
  };

  // 上移下移盲盒条目（固定盲盒 32251/35206 不参与排序，仅调整其余条目顺序）
  const moveBlindBox = (filteredIndex: number, dir: -1 | 1) => {
    if (!config) return;
    const fixedIds = [32251, 35206];
    const boxes = [...config.blind_boxes];
    const nonFixed: number[] = [];
    boxes.forEach((b, i) => { if (!fixedIds.includes(b.id)) nonFixed.push(i); });
    const target = filteredIndex + dir;
    if (target < 0 || target >= nonFixed.length) return;
    const a = nonFixed[filteredIndex];
    const b = nonFixed[target];
    [boxes[a], boxes[b]] = [boxes[b], boxes[a]];
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

  const updateActivity = (index: number, field: keyof ActivityItem, value: string) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    acts[index] = { ...acts[index], [field]: value };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const addActivity = () => {
    if (!config) return;
    setConfig({
      ...config,
      synthesis_activities: [
        ...config.synthesis_activities,
        { id: "", type: config.valid_activity_types[0] || "material_package", info_url: "", record_url: "" },
      ],
    });
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
      const list = [...config.recommended_anchors];
      const nextOrder = list.reduce((m, a) => Math.max(m, a.order), 0) + 1;
      list.push({
        uid,
        uname: info.uname,
        face: info.face ? fixImageUrl(info.face) : undefined,
        room_id: info.room_id || 0,
        visible: true,
        order: nextOrder,
      });
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

  const toggleCurrentBoxId = (id: number) => {
    if (!config) return;
    const ids = config.current_activity_blind_box_ids;
    setConfig({
      ...config,
      current_activity_blind_box_ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    });
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
    <div className="min-h-screen bg-[#faf9f6] py-6 px-4 overflow-x-hidden" style={{ paddingTop: "var(--safe-top, 0px)" }}>
      <SafeAreaStyler />
      <WindowTitleBar />
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">管理后台</h1>
          <a href="/" className="text-xs text-black/40 hover:text-black/70 transition">← 返回首页</a>
        </div>

        {/* 数据加载失败提示 */}
        {loadError && (
          <div className="rounded-xl border border-[#e74c3c]/30 bg-[#fdf0ef] p-4">
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
        <div className="rounded-xl border border-black/10 bg-white/80 p-4">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-sm font-bold">用户列表 ({filteredUsers.length})</h2>
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="搜索用户名 / UID"
              className="w-44 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs focus:outline-none focus:border-black/30"
            />
          </div>
          {filteredUsers.length === 0 ? (
            <p className="text-xs text-black/30">{users.length === 0 ? "暂无用户" : "无匹配用户"}</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {filteredUsers.map((user) => (
                <div key={user.mid} className={`flex items-center gap-3 rounded-lg border p-2.5 ${user.isCurrent ? "border-[#00a1d6] bg-[#eef3fb]" : "border-black/10"}`}>
                  {user.face ? <img src={fixImageUrl(user.face)} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" /> : <div className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-1.5">
                      <span className="text-sm font-medium min-w-0 break-all leading-snug">{user.uname}</span>
                      {user.isLocal && <span className="text-[10px] px-1.5 rounded bg-[#2ecc71]/10 text-[#2ecc71] shrink-0">本机</span>}
                    </div>
                    <div className="text-[10px] text-black/30 mt-0.5">UID {user.mid}</div>
                    <div className="text-[10px] text-black/30 mt-0.5">更新: {new Date(user.updatedAt).toLocaleString("zh-CN")}</div>
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
            </div>
          )}
        </div>

        {/* Config */}
        {config && (
          <div className="rounded-xl border border-black/10 bg-white/80 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">配置管理</h2>
              <div className="flex items-center gap-2">
                {configSaved && <span className="text-xs text-[#2ecc71]">已保存 ✓</span>}
                <button
                  onClick={handleSaveConfig}
                  className="rounded-lg bg-[#1f1c17] px-4 py-1.5 text-xs text-white font-medium hover:opacity-90 transition"
                >
                  保存配置
                </button>
              </div>
            </div>

            {/* Blind boxes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">盲盒配置</h3>
                <button onClick={addBlindBox} className="text-xs text-[#00a1d6] hover:underline">+ 添加盲盒</button>
              </div>
              <p className="text-[10px] text-black/40">勾选 = 在页面上展示为当前活动盲盒</p>
              <div className="space-y-2">
                {/* 心动盲盒 - 固定项，始终勾选，不可更改 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0 opacity-50"
                  />
                  <span className="w-16 text-xs text-black/50">32251</span>
                  <span className="w-auto text-xs text-black/50">心动盲盒</span>
                  <span className="text-[10px] text-black/30 shrink-0">默认显示，不可更改</span>
                </div>
                {/* 幸运盲盒 - 固定项，始终勾选，不可更改 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0 opacity-50"
                  />
                  <span className="w-16 text-xs text-black/50">35206</span>
                  <span className="w-auto text-xs text-black/50">幸运盲盒</span>
                  <span className="text-[10px] text-black/30 shrink-0">默认显示，不可更改</span>
                </div>
                {/* 其他盲盒（可配置，支持上移下移排序） */}
                {config.blind_boxes
                  .filter((box) => box.id !== 32251 && box.id !== 35206)
                  .map((box, filteredIndex) => {
                    const realIndex = config.blind_boxes.findIndex((b) => b === box);
                    return (
                  <div key={realIndex} className={`rounded-lg border border-black/10 p-2 space-y-2 ${!config.current_activity_blind_box_ids.includes(box.id) ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveBlindBox(filteredIndex, -1)}
                          disabled={filteredIndex === 0}
                          className="admin-move-btn"
                          title="上移"
                        >▲</button>
                        <button
                          onClick={() => moveBlindBox(filteredIndex, 1)}
                          disabled={filteredIndex === config.blind_boxes.filter((b) => b.id !== 32251 && b.id !== 35206).length - 1}
                          className="admin-move-btn"
                          title="下移"
                        >▼</button>
                      </div>
                      <input
                        type="checkbox"
                        checked={config.current_activity_blind_box_ids.includes(box.id)}
                        onChange={() => toggleCurrentBoxId(box.id)}
                        className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                        title="勾选为当前活动盲盒"
                      />
                      {box.id > 0 && box.icon && (
                        <img src={box.icon} alt="" className="w-7 h-7 rounded shrink-0" />
                      )}
                      {/* 名称输入 + 下拉搜索建议 */}
                      <div className="relative flex-1 min-w-[120px]">
                        <input
                          type="text"
                          value={box.name}
                          onChange={(e) => {
                            updateBlindBox(realIndex, "name", e.target.value);
                            // 输入名称时清除已匹配的 id 和 icon（待重新选择）
                            if (box.id > 0) updateBlindBox(realIndex, "id", 0);
                            setBlindBoxSearchIndex(realIndex);
                          }}
                          onFocus={() => setBlindBoxSearchIndex(realIndex)}
                          onBlur={() => setTimeout(() => setBlindBoxSearchIndex(null), 200)}
                          placeholder="输入盲盒名称搜索"
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
                      <span className="text-xs text-black/50 shrink-0">{box.id > 0 ? box.id : "?"}</span>
                      <button onClick={() => removeBlindBox(realIndex)} className="text-xs text-[#e74c3c] hover:underline shrink-0 ml-auto">删除</button>
                    </div>
                    <input
                      type="text"
                      value={box.icon}
                      onChange={(e) => updateBlindBox(realIndex, "icon", e.target.value)}
                      placeholder="图标链接（选择礼物后自动填充，可手动修改）"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                  </div>
                  );
                })}
              </div>
            </div>

            <hr className="border-black/5" />

            {/* Synthesis activities */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">合成活动配置</h3>
                <button onClick={addActivity} className="text-xs text-[#00a1d6] hover:underline">+ 添加活动</button>
              </div>
              <p className="text-[10px] text-black/40">勾选 = 在页面上展示该活动</p>
              <div className="space-y-3">
                {config.synthesis_activities.map((act, i) => (
                  <div key={i} className={`rounded-lg border border-black/10 p-3 space-y-2 ${act.active === false ? "opacity-50" : ""}`}>
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
                        value={act.id}
                        onChange={(e) => updateActivity(i, "id", e.target.value)}
                        placeholder="活动ID"
                        className="w-24 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                      />
                      {/* 活动名称 - 自动从 info_url 提取，只读显示 */}
                      <input
                        type="text"
                        value={activityNames[act.id] ?? ""}
                        readOnly
                        placeholder="自动获取名称"
                        className="flex-1 min-w-[120px] rounded border border-black/10 bg-black/5 px-2 py-1.5 text-xs text-black/50 cursor-not-allowed"
                      />
                      <Dropdown
                        value={act.type}
                        onChange={(v) => updateActivity(i, "type", v)}
                        className="w-32 shrink-0 rounded border border-black/10 bg-white px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                        options={config.valid_activity_types.map((t) => ({ value: t, label: t }))}
                      />
                      <button onClick={() => removeActivity(i)} className="text-xs text-[#e74c3c] hover:underline ml-auto">删除</button>
                    </div>
                    <input
                      type="text"
                      value={act.info_url}
                      onChange={(e) => updateActivity(i, "info_url", e.target.value)}
                      placeholder="info_url"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                    <input
                      type="text"
                      value={act.record_url}
                      onChange={(e) => updateActivity(i, "record_url", e.target.value)}
                      placeholder="record_url"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                  </div>
                ))}
              </div>
            </div>

            <hr className="border-black/5" />

            {/* 推荐主播管理 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">推荐主播配置</h3>
              </div>
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
              <div className="space-y-2">
                {config.recommended_anchors.length === 0 ? (
                  <p className="text-[10px] text-black/30 py-3 text-center">暂无推荐主播，在上方输入UID添加</p>
                ) : (
                  [...config.recommended_anchors]
                    .sort((a, b) => a.order - b.order)
                    .map((anchor, index) => (
                      <div
                        key={anchor.uid}
                        className={`rounded-lg border border-black/10 p-2.5 ${!anchor.visible ? "opacity-50" : ""}`}
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
            </div>
          </div>
        )}
      </div>

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
