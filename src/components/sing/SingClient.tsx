"use client";

/**
 * /sing 点歌机歌单页（无需登录）
 *
 * - 输入 B 站 UID 认领自己的歌单；勾选「主播」即切换为主播类别。
 * - 导入各音乐平台歌单/歌曲链接（由服务端 Go 解析服务完成）。
 * - 每次打开自动向各音乐平台刷新所有歌单。
 * - 底部显示与自己歌单最匹配的主播列表；点击可只读查看对方歌单。
 *
 * 版式参考 /red：居中渐变标题、径向渐变背景、底部声明 + 主站按钮。
 * 配色按类别区分：粉丝=黄绿，主播=低饱和红。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { serverFetch } from "@/lib/server-api";
import PlatformIcon from "@/components/PlatformIcon";
import HintBubble from "@/components/HintBubble";
import SiteHomeButton from "@/components/SiteHomeButton";
import {
  platformLabel,
  type HostMatch,
  type PlaylistItem,
  type SingPlatform,
  type SingProfile,
  type SingRole,
  type SongItem,
} from "@/lib/sing/types";

interface ApiRes<T> {
  code: number;
  message: string;
  data: T;
}

async function apiGet<T>(path: string, timeout = 20_000): Promise<ApiRes<T>> {
  return serverFetch<ApiRes<T>>(path, undefined, timeout);
}

async function apiSend<T>(
  path: string,
  method: "POST" | "DELETE",
  body: unknown,
  timeout = 60_000,
): Promise<ApiRes<T>> {
  return serverFetch<ApiRes<T>>(
    path,
    { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    timeout,
  );
}

/** 粉丝：黄绿色 */
const FAN_THEME = {
  "--s-text": "#26301a",
  "--s-muted": "#7d8a6a",
  "--s-ink2": "#43502c",
  "--s-border": "#e0e8cf",
  "--s-accent": "#8aae2f",
  "--s-accent-strong": "#67891c",
  "--s-accent-soft": "#eef5da",
  "--s-card": "#ffffff",
  "--s-danger": "#b4543f",
} as CSSProperties;

/** 主播：低饱和红（与软件内点歌机卡片一致） */
const ANCHOR_THEME = {
  "--s-text": "#2b1b1b",
  "--s-muted": "#8a7373",
  "--s-ink2": "#5a3636",
  "--s-border": "#e6d2d1",
  "--s-accent": "#b26a6a",
  "--s-accent-strong": "#8f4f4f",
  "--s-accent-soft": "#f6e7e6",
  "--s-card": "#ffffff",
  "--s-danger": "#a84848",
} as CSSProperties;

const FAN_BG =
  "radial-gradient(1100px 600px at 10% -10%, rgba(205,232,128,0.45), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(140,205,160,0.32), transparent 55%), #eef3e4";
const ANCHOR_BG =
  "radial-gradient(1100px 600px at 10% -10%, rgba(238,168,160,0.36), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(188,172,205,0.30), transparent 55%), #ece4e8";

const FAN_TITLE = "from-[#cbe36a] via-[#9cc23c] to-[#5f9e3a]";
const ANCHOR_TITLE = "from-[#d3a09a] via-[#b26a6a] to-[#8f7ba8]";

/** B 站头像地址补全协议（接口常返回 //i0.hdslb.com/...） */
function fixFace(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

/** 头像：有 URL 用图片，否则用昵称首字兜底 */
function Avatar({ src, uname, size = 28 }: { src?: string; uname?: string; size?: number }) {
  if (src) {
    return (
      <img
        src={src}
        alt={uname || "头像"}
        referrerPolicy="no-referrer"
        draggable={false}
        className="shrink-0 rounded-full object-cover ring-1 ring-black/5"
        style={{ width: size, height: size }}
      />
    );
  }
  const ch = (uname || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--s-accent-soft)] font-semibold text-[var(--s-accent-strong)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      aria-hidden
    >
      {ch}
    </span>
  );
}

/** 单曲一行：歌名 — 歌手，右侧复制（只读模式隐藏删除） */
function SongLine({
  song,
  onCopy,
  onDelete,
  showPlatform,
  index,
}: {
  song: SongItem["song"];
  onCopy: () => Promise<void>;
  onDelete?: () => void;
  /** 单独导入的歌曲没有歌单分组头，需要在行首显示平台图标 */
  showPlatform?: boolean;
  /** 序号（歌单内/单独歌曲列表内各自从 1 开始） */
  index?: number;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (copied) return;
    await onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };
  return (
    <div className="flex items-center gap-2 py-2">
      {index != null && (
        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-[var(--s-muted)]">
          {index}.
        </span>
      )}
      {showPlatform && <PlatformIcon platform={song.platform} size={15} />}
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium text-[var(--s-text)]">{song.name}</span>
        <span className="text-[var(--s-ink2)]">
          {" — "}
          {song.artists.join(" / ") || "未知歌手"}
        </span>
      </p>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className={`shrink-0 rounded-full px-2 py-1 text-xs transition ${
          copied
            ? "bg-[var(--s-accent-soft)] font-medium text-[var(--s-accent-strong)]"
            : "text-[var(--s-muted)] hover:bg-[var(--s-accent-soft)] hover:text-[var(--s-accent-strong)]"
        }`}
      >
        {copied ? "已复制，去直播间粘贴点歌" : "复制"}
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded-full px-2 py-1 text-xs text-[var(--s-muted)] transition hover:bg-[var(--s-accent-soft)] hover:text-[var(--s-danger)]"
        >
          删除
        </button>
      )}
    </div>
  );
}

/** 歌单折叠卡：整条可点（删除除外），箭头在最右，标题与歌曲数同行 */
function PlaylistGroup({
  item,
  expanded,
  readOnly,
  onToggle,
  onDelete,
  onCopy,
}: {
  item: PlaylistItem;
  expanded: boolean;
  readOnly?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onCopy: (name: string) => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--s-border)] bg-[var(--s-card)]">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 transition hover:bg-[var(--s-accent-soft)]/50"
      >
        <PlatformIcon platform={item.platform} size={16} />
        <span className="min-w-0 shrink truncate text-sm font-semibold text-[var(--s-text)]">
          {item.title}
        </span>
        <span className="shrink-0 text-xs font-medium text-[var(--s-ink2)]">
          {item.songs.length} 首
        </span>
        {item.lastError && (
          <span className="min-w-0 truncate text-[11px] text-[var(--s-danger)]/80">
            {item.lastError}
          </span>
        )}
        <span className="flex-1" />
        {!readOnly && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="shrink-0 rounded-full px-2 py-1 text-xs text-[var(--s-muted)] transition hover:bg-[var(--s-accent-soft)] hover:text-[var(--s-danger)]"
          >
            删除
          </button>
        )}
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-[var(--s-muted)] transition-transform"
          style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {expanded && (
        <div className="max-h-80 overflow-y-auto border-t border-[var(--s-border)] px-3">
          {item.songs.length === 0 ? (
            <p className="py-3 text-xs text-[var(--s-muted)]">歌单为空</p>
          ) : (
            <ul className="divide-y divide-[var(--s-border)]">
              {item.songs.map((song, i) => (
                <li key={`${song.platform}:${song.id}:${i}`}>
                  <SongLine song={song} index={i + 1} onCopy={() => onCopy(song.name)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function SingPage({ routeUid }: { routeUid?: string }) {
  const pathUid = (routeUid || "").trim();
  const [uidInput, setUidInput] = useState("");
  const [ownUid, setOwnUid] = useState("");
  const [viewHost, setViewHost] = useState(/^\d+$/.test(pathUid) ? pathUid : "");
  const [profile, setProfile] = useState<SingProfile | null>(null);
  const [role, setRole] = useState<SingRole>("fan");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  /** 导入框示例链接轮流展示，提示支持多个平台 */
  const [phIndex, setPhIndex] = useState(0);
  const [flash, setFlash] = useState<{
    kind: "ok" | "err";
    text: string;
    /** 提示出现的位置：紧跟对应操作元素，不设独立提示区 */
    at: "uid" | "import" | "list";
  } | null>(null);
  const [matches, setMatches] = useState<HostMatch[]>([]);
  const [openPlaylists, setOpenPlaylists] = useState<Record<string, boolean>>({});
  /** B 站用户信息（昵称 / 头像），歌单里没存时按 UID 补齐 */
  const [faces, setFaces] = useState<Record<string, { uname?: string; face?: string }>>({});
  /** UID → 直播间号（用于「直播间」入口） */
  const [roomIds, setRoomIds] = useState<Record<string, number>>({});

  const isHost = !!viewHost;
  const displayUid = isHost ? viewHost : ownUid;
  const theme = isHost || role === "anchor" ? ANCHOR_THEME : FAN_THEME;
  const isAnchorLook = isHost || role === "anchor";

  const loadUserInfo = useCallback(async (uids: string[]) => {
    const list = Array.from(new Set(uids.filter((u) => /^\d+$/.test(u)))).slice(0, 20);
    if (list.length === 0) return;
    try {
      const res = await apiGet<Record<string, { name?: string; face?: string }>>(
        `/api/tools/user-info?uids=${list.join(",")}`,
        20_000,
      );
      if (res.code !== 0) return;
      const next: Record<string, { uname?: string; face?: string }> = {};
      for (const [uid, info] of Object.entries(res.data || {})) {
        if (!info) continue;
        next[uid] = { uname: info.name || undefined, face: fixFace(info.face) };
      }
      if (Object.keys(next).length > 0) setFaces((prev) => ({ ...prev, ...next }));
    } catch {
      /* 静默：取不到昵称/头像时用 UID 与首字兜底 */
    }
  }, []);

  /** 展示用昵称 / 头像：优先歌单里存的信息，其次按 UID 查到的信息 */
  const nameOf = (uid: string, uname?: string) => uname || faces[uid]?.uname || "";
  const faceOf = (uid: string, face?: string) => face || faces[uid]?.face;

  /** 按 UID 查直播间号，用于主播页「直播间」入口（查不到则不显示该按钮） */
  const loadRoomId = useCallback(async (uid: string) => {
    try {
      const res = await apiGet<{ roomid: number }>(`/api/medical/room-id?mid=${encodeURIComponent(uid)}`);
      const roomid = res.code === 0 ? Number(res.data?.roomid) || 0 : 0;
      if (roomid > 0) setRoomIds((prev) => ({ ...prev, [uid]: roomid }));
    } catch {
      /* 静默 */
    }
  }, []);

  const loadMatches = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const res = await apiGet<{ matches: HostMatch[] }>(
          `/api/sing/matches?uid=${encodeURIComponent(id)}`,
        );
        if (res.code === 0) {
          const list = res.data.matches || [];
          setMatches(list);
          void loadUserInfo(list.map((m) => m.uid));
        }
      } catch {
        /* 静默 */
      }
    },
    [loadUserInfo],
  );

  const doRefresh = useCallback(async (id: string) => {
    setSyncing(true);
    try {
      const res = await apiSend<{ profile: SingProfile | null }>(
        "/api/sing/refresh",
        "POST",
        { uid: id },
        180_000,
      );
      if (res.code === 0 && res.data.profile) {
        setProfile(res.data.profile);
        setRole(res.data.profile.role);
        setLastSync(Date.now());
      } else if (res.code !== 404) {
        setFlash({ kind: "err", text: res.message || "同步歌单失败", at: "uid" });
      }
    } catch {
      setFlash({ kind: "err", text: "同步歌单失败，请检查网络后重试", at: "uid" });
    } finally {
      setSyncing(false);
    }
  }, []);

  const fetchProfile = useCallback(
    async (id: string, opts: { sync: boolean; readOnly: boolean }) => {
      setLoading(true);
      setFlash(null);
      void loadUserInfo([id]);
      try {
        const res = await apiGet<{ profile: SingProfile | null }>(
          `/api/sing/user?uid=${encodeURIComponent(id)}`,
        );
        if (res.code !== 0) {
          setFlash({ kind: "err", text: res.message || "读取歌单失败", at: "uid" });
          return;
        }
        setProfile(res.data.profile);
        if (!opts.readOnly && res.data.profile) setRole(res.data.profile.role);
        setLoading(false);
        if (opts.sync && res.data.profile) void doRefresh(id);
      } catch {
        setFlash({ kind: "err", text: "读取歌单失败，请检查网络", at: "uid" });
        setLoading(false);
      }
    },
    [doRefresh, loadUserInfo],
  );

  // 首次进入：恢复本地 uid / 角色；/sing/<uid> 打开他人页时只读查看
  useEffect(() => {
    const savedUid = localStorage.getItem("sing:uid") || "";
    const savedRole = localStorage.getItem("sing:role") === "anchor" ? "anchor" : "fan";
    setRole(savedRole);
    setOwnUid(savedUid);
    if (savedUid) {
      setUidInput(savedUid);
      void loadMatches(savedUid);
    }
    if (/^\d+$/.test(pathUid)) {
      if (pathUid === savedUid) {
        // 打开的是自己的固定地址：回到可编辑模式（配色随自己的类别）
        setViewHost("");
        void fetchProfile(pathUid, { sync: true, readOnly: false });
      } else {
        setViewHost(pathUid);
        void fetchProfile(pathUid, { sync: false, readOnly: true });
        void loadRoomId(pathUid);
      }
    } else if (savedUid) {
      void fetchProfile(savedUid, { sync: true, readOnly: false });
    }
  }, [fetchProfile, loadMatches, loadRoomId, pathUid]);

  /** 导入框示例链接（轮流展示，提示支持哪些平台） */
  const importExamples = useMemo(
    () => [
      "网易云 https://music.163.com/#/playlist?id=14388209",
      "QQ音乐 https://y.qq.com/n/ryqq_v2/playlist/7447379075",
      "酷狗音乐 https://t1.kugou.com/2aQBtb2G7V3",
      "汽水音乐 https://qishui.douyin.com/s/i4J9phCE",
    ],
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setPhIndex((i) => (i + 1) % importExamples.length),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [importExamples]);

  const commitUid = useCallback(() => {
    const id = uidInput.trim();
    if (!/^\d{1,20}$/.test(id)) {
      setFlash({ kind: "err", text: "请输入正确的 B 站 UID（纯数字）", at: "uid" });
      return;
    }
    localStorage.setItem("sing:uid", id);
    setOwnUid(id);
    void fetchProfile(id, { sync: true, readOnly: false });
    void loadMatches(id);
  }, [uidInput, fetchProfile, loadMatches]);

  const changeRole = useCallback(
    async (next: SingRole) => {
      if (next === role) return;
      setRole(next);
      localStorage.setItem("sing:role", next);
      if (!profile || isHost) return;
      try {
        const res = await apiSend<{ profile: SingProfile }>("/api/sing/user", "POST", {
          uid: ownUid,
          role: next,
        });
        if (res.code === 0) setProfile(res.data.profile);
      } catch {
        /* 静默 */
      }
    },
    [profile, role, ownUid, isHost],
  );

  const doImport = useCallback(async () => {
    const url = importUrl.trim();
    if (!url) return;
    if (!ownUid) {
      setFlash({ kind: "err", text: "请先输入 UID", at: "uid" });
      return;
    }
    setImporting(true);
    setFlash(null);
    try {
      const res = await apiSend<{
        profile: SingProfile;
        imported: { kind: string; platform: SingPlatform; name: string; count: number };
        deduped: boolean;
      }>("/api/sing/import", "POST", { uid: ownUid, url, role }, 60_000);
      if (res.code !== 0) {
        setFlash({ kind: "err", text: res.message || "导入失败", at: "import" });
        return;
      }
      setProfile(res.data.profile);
      setImportUrl("");
      const imp = res.data.imported;
      setFlash({
        kind: "ok",
        text: res.data.deduped
          ? `已更新重复导入的条目（${platformLabel(imp.platform)}）`
          : `已导入${platformLabel(imp.platform)}${imp.kind === "song" ? "歌曲" : "歌单"} · ${imp.count} 首`,
        at: "import",
      });
      void loadMatches(ownUid);
    } catch {
      setFlash({ kind: "err", text: "导入失败，请检查网络或稍后重试", at: "import" });
    } finally {
      setImporting(false);
    }
  }, [importUrl, ownUid, role, loadMatches]);

  /** 复制「点歌 歌名」到剪贴板；成功与否由按钮自身给出就近反馈 */
  const copySong = useCallback(async (name: string) => {
    const text = `点歌 ${name}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    } catch {
      /* 失败时按钮仍会显示已复制，避免打断操作 */
    }
  }, []);

  const removeSong = useCallback(
    async (platform: SingPlatform, id: string) => {
      try {
        const res = await apiSend<{ profile: SingProfile }>("/api/sing/item", "DELETE", {
          uid: ownUid,
          kind: "song",
          platform,
          id,
        });
        if (res.code === 0) {
          setProfile(res.data.profile);
          void loadMatches(ownUid);
        }
      } catch {
        setFlash({ kind: "err", text: "删除失败", at: "list" });
      }
    },
    [ownUid, loadMatches],
  );

  const removePlaylist = useCallback(
    async (link: string) => {
      if (!window.confirm("删除整个歌单？")) return;
      try {
        const res = await apiSend<{ profile: SingProfile }>("/api/sing/item", "DELETE", {
          uid: ownUid,
          kind: "playlist",
          link,
        });
        if (res.code === 0) {
          setProfile(res.data.profile);
          void loadMatches(ownUid);
        }
      } catch {
        setFlash({ kind: "err", text: "删除失败", at: "list" });
      }
    },
    [ownUid, loadMatches],
  );

  const goHost = (id: string) => {
    window.location.assign(`/sing/${encodeURIComponent(id)}`);
  };
  const goHome = () => {
    window.location.assign("/sing");
  };

  const songCount = useMemo(() => {
    if (!profile) return 0;
    return profile.songs.length + profile.playlists.reduce((n, p) => n + p.songs.length, 0);
  }, [profile]);

  const hasList = songCount > 0;

  /** 轻提示：紧跟在对应的操作元素下方 */
  const renderFlash = (at: "uid" | "import" | "list") =>
    flash && flash.at === at ? (
      <p
        className={`mt-2 text-[11px] ${
          flash.kind === "err" ? "text-[var(--s-danger)]" : "text-[var(--s-accent-strong)]"
        }`}
      >
        {flash.text}
      </p>
    ) : null;

  return (
    <main
      className="relative min-h-screen text-[var(--s-text)]"
      style={{
        ...theme,
        background: isAnchorLook ? ANCHOR_BG : FAN_BG,
        minHeight: "100dvh",
      }}
    >
      <div className="mx-auto w-full max-w-3xl px-3 pb-16 pt-8 sm:px-6 sm:pt-10">
        {/* 标题（参考 /red：居中 + 渐变字） */}
        <div className="relative text-center">
          <h1
            className={`bg-gradient-to-br bg-clip-text text-[26px] font-semibold tracking-tight text-transparent sm:text-[32px] ${
              isAnchorLook ? ANCHOR_TITLE : FAN_TITLE
            }`}
          >
            {isHost ? "主播歌单" : "点歌机"}
          </h1>
          <div className="mt-2 flex items-start justify-center gap-1.5">
            <p className="text-[13px] text-[var(--s-muted)]">
              {isHost
                ? "查看主播会唱/喜欢的歌曲，去TA的直播间逛逛吧"
                : role === "anchor"
                  ? "主播歌单：导入你会唱或喜欢的歌，会推荐给歌曲喜好相近的粉丝"
                  : "导入你的歌单，在直播间发送「点歌 歌名」就能精确点歌"}
            </p>
            {!isHost && (
              <HintBubble label="主播说明">
                <p>
                  主播需要使用[B瓜]软件，粉丝才可以点歌，可在网站首页下载安装。
                </p>

                <p>
                  如果你是主播，导入自己会唱或喜欢的歌曲，勾选☑️主播，会推荐给歌曲喜好相近的用户。
                </p>
              </HintBubble>
            )}
          </div>
          {isHost && (
            <button
              type="button"
              onClick={goHome}
              aria-label="返回我的歌单"
              className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--s-card)] text-[var(--s-muted)] shadow-sm ring-1 ring-black/5 transition hover:text-[var(--s-accent-strong)]"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m3 10 9-7 9 7" />
                <path d="M5 9.5V20h14V9.5" />
              </svg>
            </button>
          )}
        </div>

        {/* UID / 身份 / 导入（同一张卡） */}
        <section
          className={`mt-6 rounded-xl border border-[var(--s-border)] bg-[var(--s-card)] shadow-sm ${
            isHost ? "px-4 py-2.5" : "p-4 sm:p-5"
          }`}
        >
          {isHost ? (
            <div className="flex flex-wrap items-center gap-3">
              <Avatar
                src={faceOf(displayUid, profile?.avatar)}
                uname={nameOf(displayUid, profile?.uname) || displayUid}
                size={40}
              />
              <span className="min-w-0 flex-1 truncate text-lg font-semibold">
                {nameOf(displayUid, profile?.uname) || `UID ${displayUid}`}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`https://space.bilibili.com/${displayUid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-[var(--s-accent)] px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-[var(--s-accent-strong)]"
                >
                  个人中心
                </a>
                {roomIds[displayUid] > 0 && (
                  <a
                    href={`https://live.bilibili.com/${roomIds[displayUid]}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-[var(--s-accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--s-accent-strong)] transition hover:bg-[var(--s-accent-soft)]"
                  >
                    直播间
                  </a>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <input
                  value={uidInput}
                  onChange={(e) => setUidInput(e.target.value.replace(/[^\d]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitUid();
                  }}
                  placeholder="B 站 UID"
                  inputMode="numeric"
                  className="h-8 w-44 max-w-full rounded-full border border-[var(--s-border)] bg-[var(--s-accent-soft)] px-4 text-sm text-[var(--s-text)] outline-none transition placeholder:text-[var(--s-muted)] focus:border-[var(--s-accent)]"
                />
                <button
                  type="button"
                  onClick={commitUid}
                  disabled={loading}
                  className="h-8 rounded-full bg-[var(--s-accent)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--s-accent-strong)] disabled:opacity-50"
                >
                  {ownUid ? "更新" : "加载"}
                </button>
                <span className="text-[11px] text-[var(--s-muted)]">
                  {syncing
                    ? "正在更新…"
                    : lastSync
                      ? `已更新 ${new Date(lastSync).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : ""}
                </span>

                {ownUid && (
                  <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-start sm:gap-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar
                        src={faceOf(ownUid, profile?.avatar)}
                        uname={nameOf(ownUid, profile?.uname) || ownUid}
                        size={32}
                      />
                      <span className="max-w-[9rem] truncate text-base font-semibold text-[var(--s-ink2)]">
                        {nameOf(ownUid, profile?.uname) || `UID ${ownUid}`}
                      </span>
                    </div>
                    {ownUid && !loading && (
                      <label className="inline-flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full bg-[var(--s-accent-soft)] px-2.5 py-1 text-sm text-[var(--s-ink2)]">
                        <input
                          type="checkbox"
                          checked={role === "anchor"}
                          onChange={(e) => void changeRole(e.target.checked ? "anchor" : "fan")}
                          className="h-4 w-4 accent-[var(--s-accent)]"
                        />
                        主播
                      </label>
                    )}
                  </div>
                )}
              </div>

              {renderFlash("uid")}

              <div className="mt-3 border-t border-[var(--s-border)] pt-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold">导入歌单 / 歌曲</h3>
                  <p className="text-[11px] leading-5 text-[var(--s-muted)]">
                    支持网易云/QQ音乐/酷狗音乐/汽水音乐等主流平台的歌单/歌曲导入，在APP中“分享”链接粘贴到此即可
                  </p>
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doImport();
                    }}
                    placeholder={importExamples[phIndex]}
                    className="min-w-0 flex-1 rounded-full border border-[var(--s-border)] bg-[var(--s-accent-soft)]/40 px-4 py-1.5 text-[13px] leading-5 outline-none placeholder:text-[11px] placeholder:text-[var(--s-muted)] focus:border-[var(--s-accent)] sm:placeholder:text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => void doImport()}
                    disabled={importing || !importUrl.trim()}
                    className="rounded-full bg-[var(--s-accent)] px-6 py-1.5 text-[13px] font-semibold leading-5 text-white transition hover:bg-[var(--s-accent-strong)] disabled:opacity-50"
                  >
                    {importing ? "导入中…" : "导入"}
                  </button>
                </div>
                {renderFlash("import")}
              </div>
            </>
          )}
        </section>

        {!displayUid ? (
          <section className="mt-6 rounded-xl border border-dashed border-[var(--s-border)] bg-[var(--s-card)]/70 p-8 text-center">
            <p className="text-base font-semibold">先输入你的 B 站 UID</p>
            <p className="mt-2 text-sm text-[var(--s-muted)]">
              不需要登录B站和音乐软件，UID只用于关联你的B站和你的音乐软件歌单。
            </p>
          </section>
        ) : (
          <>
            <section className="mt-6">
              <div className="flex items-center justify-center gap-2">
                <h2 className="text-xl font-bold tracking-tight text-[var(--s-text)]">
                  {isHost ? "TA的歌单" : "我的歌单"}
                </h2>
                <span className="text-base font-medium text-[var(--s-ink2)]">{songCount} 首</span>
              </div>
              {renderFlash("list")}

              {!hasList && (
                <div className="mt-3 rounded-xl border border-dashed border-[var(--s-border)] bg-[var(--s-card)]/70 p-6 text-center text-sm text-[var(--s-muted)]">
                  {isHost ? "TA 还没有导入任何歌曲。" : "还没有歌曲，先导入一个歌单或歌曲链接。"}
                </div>
              )}

              {profile && profile.songs.length > 0 && (
                <div className="mt-3 rounded-xl border border-[var(--s-border)] bg-[var(--s-card)] px-3">
                  <ul className="divide-y divide-[var(--s-border)]">
                    {profile.songs.map((item, i) => (
                      <li key={`${item.song.platform}:${item.song.id}:${i}`}>
                        <SongLine
                          song={item.song}
                          showPlatform
                          index={i + 1}
                          onCopy={() => copySong(item.song.name)}
                          onDelete={
                            isHost
                              ? undefined
                              : () => void removeSong(item.song.platform, item.song.id)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {profile && profile.playlists.length > 0 && (
                <div className="mt-3 space-y-2">
                  {profile.playlists.map((item) => {
                    const key = item.link;
                    const expanded = !!openPlaylists[key];
                    return (
                      <PlaylistGroup
                        key={key}
                        item={item}
                        expanded={expanded}
                        readOnly={isHost}
                        onToggle={() =>
                          setOpenPlaylists((prev) => ({ ...prev, [key]: !prev[key] }))
                        }
                        onDelete={() => void removePlaylist(item.link)}
                        onCopy={copySong}
                      />
                    );
                  })}
                </div>
              )}
            </section>

            {/* 匹配主播：始终基于「我」的 UID 计算 */}
            {matches.length > 0 && (
              <section className="mt-8">
                <h2 className="text-center text-base font-semibold">和我最匹配的主播</h2>
                <div className="mt-3 space-y-2">
                  {matches.map((m, i) => (
                    <button
                      key={m.uid}
                      type="button"
                      onClick={() => goHost(m.uid)}
                      className="w-full rounded-xl border border-[#e6d2d1] bg-white p-3 text-left transition hover:border-[#b26a6a] hover:shadow-sm"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#f6e7e6] text-xs font-bold text-[#8f4f4f]">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Avatar
                              src={faceOf(m.uid, m.avatar)}
                              uname={nameOf(m.uid, m.uname) || m.uid}
                              size={22}
                            />
                            <span className="min-w-0 truncate text-sm font-semibold">
                              {nameOf(m.uid, m.uname) || `UID ${m.uid}`}
                            </span>
                            <span className="shrink-0 text-[11px] text-[var(--s-muted)]">
                              UID {m.uid}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <div className="h-1.5 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-[#f6e7e6] sm:basis-auto sm:max-w-[14rem]">
                              <div
                                className="h-full rounded-full bg-[#b26a6a]"
                                style={{ width: `${Math.max(4, Math.round(m.score * 100))}%` }}
                              />
                            </div>
                            <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--s-muted)] sm:ml-auto">
                              共同歌手 {m.sharedSingers} 位 · 共同歌曲 {m.sharedSongs} 首 · 匹配度{" "}
                              {(m.score * 100).toFixed(1)}%
                            </span>
                          </div>
                          {m.singerNames.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {m.singerNames.map((name) => (
                                <span
                                  key={name}
                                  className="rounded-full bg-[#f6e7e6] px-2 py-0.5 text-[11px] text-[#8f4f4f]"
                                >
                                  {name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[var(--s-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* 说明（默认折叠，样式参考 /red 的声明卡） */}
        <details className="group mt-10 rounded-3xl border border-black/[0.06] bg-white/60 text-[12px] leading-6 text-black/45">
          <summary className="flex cursor-pointer select-none list-none items-center justify-between px-4 py-3.5 text-[13px] font-semibold text-black/60 sm:px-6 [&::-webkit-details-marker]:hidden">
            说明
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4 text-black/35 transition-transform group-open:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <ul className="list-disc space-y-2 px-4 pb-5 pl-9 sm:px-6 sm:pl-11">
            <li>
              在主播的直播间发送「点歌 歌名」，可以模糊匹配，主播需要安装 [B瓜] 软件并开启点歌机功能；本页面只负责保存和匹配歌单。
            </li>
            <li>
              发送「点歌 随机」随机播放自己的歌单；发送「点歌 歌手名」播放自己歌单中该歌手的随机一首歌曲。
            </li>
            <li>
              歌单仅用于直播间点歌匹配，以及匹配音乐爱好相同的主播，不涉及登录与账号信息。由于 B 站和音乐软件都不需要登录，主播可以为粉丝创建歌单：知道用户的 UID 和常用音乐软件的红心歌单，就能让粉丝在直播间通过弹幕精确点歌。
            </li>
            <li>
              容易误解的地方：本网站配合直播间发送弹幕，并不是点唱主播的才艺歌曲，而是让主播播放用户喜欢的歌曲，大家一起「听歌」。查看主播歌单可以知道主播的才艺歌曲，感兴趣可发送「点歌 主播」随机播放主播歌单中的一首。
            </li>
            <li>
              相比于一般直播间点歌机，特点是：一是可以精确点自己平常喜欢听的歌曲（同一首歌往往有多个版本，让主播手动搜索很麻烦）；二是主播端可以自动在音乐软件中播放，不用再手动搜索。
            </li>
            <li>
              这些功能比较偏，最初计划做全面的网站和主播插件；但调研过程中发现一个非常优秀的点歌插件
              <a
                href="https://play-live.bilibili.com/details/1793973485495"
                target="_blank"
                rel="noreferrer"
                className="mx-1 inline-flex items-center gap-0.5 rounded-full bg-[var(--s-accent-soft)] px-2 py-0.5 align-middle text-[11px] font-medium leading-4 text-[var(--s-accent-strong)] transition hover:bg-[var(--s-accent)] hover:text-white"
              >
                歌单点歌机 ↗
              </a>
              ，完善程度超出计划、堪称完美。该插件与我无关，但非常推荐主播使用，因此改为只实现其他插件没有覆盖的功能，最终形成这个网站。
            </li>
          </ul>
        </details>

        <SiteHomeButton />
      </div>
    </main>
  );
}
