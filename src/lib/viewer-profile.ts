/**
 * 「收发医药费 / 备用药」两个页面共享的登录信息缓存。
 *
 * 两个页面使用同一个 UID（localStorage），但各自向后端请求记录时都会带回
 * 昵称/头像。如果切页后才拿到数据，就会出现「先显示 UID、再闪变成昵称」，
 * 头像也要重新等待加载。这里用一个本地缓存先渲染昵称/头像，再由接口校准。
 */

const PROFILE_CACHE_KEY = "bili_live_viewer_profile_v1";
/** 昵称/头像变化不频繁，缓存 7 天足够，过期后由接口数据刷新 */
const PROFILE_TTL = 7 * 24 * 3600 * 1000;
/** 最多保留几个 UID 的资料，避免长期累积 */
const PROFILE_MAX = 6;

export type ViewerProfile = {
  uid: number;
  uname: string;
  face: string;
  savedAt: number;
};

type ProfileMap = Record<string, ViewerProfile>;

function readMap(): ProfileMap {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ProfileMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 读取本地缓存的昵称/头像（同步，可在挂载时立即渲染，无闪烁） */
export function readViewerProfile(uid: number): ViewerProfile | null {
  if (!uid) return null;
  const profile = readMap()[String(uid)];
  if (!profile?.uname) return null;
  if (Date.now() - (Number(profile.savedAt) || 0) > PROFILE_TTL) return null;
  return profile;
}

/** 接口返回昵称/头像后写入缓存，两个页面共用，切页时不再重新等待 */
export function writeViewerProfile(uid: number, uname: string, face: string) {
  if (!uid || !uname) return;
  try {
    const map = readMap();
    map[String(uid)] = { uid, uname, face: face || "", savedAt: Date.now() };
    // 只保留最近写入的若干个 UID
    const entries = Object.entries(map)
      .sort((a, b) => (Number(b[1]?.savedAt) || 0) - (Number(a[1]?.savedAt) || 0))
      .slice(0, PROFILE_MAX);
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 隐私模式 / 超额等场景忽略 */
  }
}
