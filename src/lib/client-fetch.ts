/**
 * 统一数据请求分发层
 *
 * 前端所有数据请求统一走 dataFetch(path, init)：
 * - Web 模式：转发到 Next.js 服务器路由（/api/...）
 * - Tauri 模式：解析 path 分发到对应的本地客户端模块（直连 B站 API + 本地文件）
 *
 * 未处理的路径（admin、图片代理、gift-db 等辅助接口）在 Tauri 下回退到服务器。
 * 返回对象与原生 fetch 的 Response 兼容（支持 .json()），调用方无需改动。
 */

import { getPlatform } from "./platform";
import type { Platform } from "./platform/types";
import { serverApiUrl } from "./server-api";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(init?: RequestInit): Record<string, unknown> | null {
  if (!init?.body) return null;
  if (typeof init.body === "string") {
    try {
      return JSON.parse(init.body);
    } catch {
      return null;
    }
  }
  return null;
}

/** 解析盲盒统计筛选参数（ruid_<id>、dateRange_<id>） */
function buildBlindBoxFilters(query: URLSearchParams): Record<number, { ruid: number | null; dateRange: string }> {
  const filters: Record<number, { ruid: number | null; dateRange: string }> = {};
  const ids = new Set<number>();
  for (const key of query.keys()) {
    const ruidMatch = key.match(/^ruid_(\d+)$/);
    const dateMatch = key.match(/^dateRange_(\d+)$/);
    if (ruidMatch) ids.add(Number(ruidMatch[1]));
    if (dateMatch) ids.add(Number(dateMatch[1]));
  }
  for (const id of ids) {
    const ruidRaw = query.get(`ruid_${id}`);
    filters[id] = {
      ruid: ruidRaw && ruidRaw !== "all" ? Number(ruidRaw) : null,
      dateRange: query.get(`dateRange_${id}`) ?? "all",
    };
  }
  return filters;
}

/** 数据获取进度回调（消费/收益记录拉取时按月份或页数上报） */
export type FetchProgress = {
  text: string;
  ratio?: number;
  current?: number;
  total?: number;
};

async function dispatchNative(
  platform: Platform,
  path: string,
  init?: RequestInit,
  onProgress?: (p: FetchProgress) => void,
): Promise<Response> {
  const [pathname, queryString] = path.split("?");
  const query = new URLSearchParams(queryString ?? "");
  const method = (init?.method ?? "GET").toUpperCase();

  switch (pathname) {
    case "/api/auth/accounts": {
      const { clientGetAccounts } = await import("./auth/client-auth");
      return jsonResponse(await clientGetAccounts(platform));
    }
    case "/api/auth/status": {
      const { clientGetStatus } = await import("./auth/client-auth");
      return jsonResponse(await clientGetStatus(platform));
    }
    case "/api/auth/switch": {
      const { clientSwitch } = await import("./auth/client-auth");
      const body = parseBody(init);
      return jsonResponse(await clientSwitch(platform, String(body?.sid ?? "")));
    }
    case "/api/auth/logout": {
      const { clientLogout } = await import("./auth/client-auth");
      await clientLogout(platform);
      return jsonResponse({ code: 0 });
    }
    case "/api/revenue/pay-record": {
      if (query.get("fast") === "1") {
        const { fetchCachedPayRecords } = await import("./pay-record-client");
        return jsonResponse(await fetchCachedPayRecords(platform));
      }
      const { fetchPayRecords } = await import("./pay-record-client");
      return jsonResponse(await fetchPayRecords(platform, query.get("refresh") === "true", onProgress));
    }
    case "/api/anchor/gifts": {
      const { fetchAnchorGifts } = await import("./anchor-gifts-client");
      const refresh = query.get("refresh") === "true";
      const dateRange = query.get("dateRange") ?? "all";
      const fan = query.get("fan") ?? "";
      return jsonResponse(await fetchAnchorGifts(platform, { refresh, dateRange, fan, onProgress }));
    }
    case "/api/stats/synthesis": {
      const { fetchSynthesisStats } = await import("./stats-client");
      return jsonResponse(await fetchSynthesisStats(platform));
    }
    case "/api/stats/certification": {
      const { fetchCertificationStats } = await import("./stats-client");
      return jsonResponse(await fetchCertificationStats(platform));
    }
    case "/api/stats/other": {
      const { fetchOtherStats } = await import("./stats-client");
      return jsonResponse(await fetchOtherStats(platform));
    }
    case "/api/stats/blind-box": {
      const { fetchBlindBoxStats } = await import("./stats-client");
      return jsonResponse(await fetchBlindBoxStats(platform, buildBlindBoxFilters(query)));
    }
    case "/api/tools/fans": {
      const { fetchFans } = await import("./tools-client");
      const pn = Number(query.get("pn") ?? "1");
      const ps = Number(query.get("ps") ?? "50");
      return jsonResponse(await fetchFans(platform, pn, ps));
    }
    case "/api/tools/medals": {
      const { fetchMedals } = await import("./tools-client");
      const page = Number(query.get("page") ?? "1");
      return jsonResponse(await fetchMedals(platform, page));
    }
    case "/api/tools/user-info": {
      const { fetchUserInfo } = await import("./tools-client");
      const uids = (query.get("uids") ?? "").split(",").filter(Boolean).map(Number);
      const refresh = query.get("refresh") === "1";
      return jsonResponse(await fetchUserInfo(platform, uids, refresh));
    }
    case "/api/tools/remove-fan": {
      const { removeFan } = await import("./tools-client");
      return jsonResponse(await removeFan(platform, (parseBody(init) as { fids: number[] }) ?? { fids: [] }));
    }
    case "/api/tools/delete-medal": {
      const { deleteMedal } = await import("./tools-client");
      return jsonResponse(await deleteMedal(platform, (parseBody(init) as { medal_id: number }) ?? {}));
    }
    case "/api/user-data/write": {
      // 本地写入用户数据文件（如 received-anchors-list.json）
      const body = parseBody(init) as { type?: string; data?: unknown } | null;
      if (body?.type) {
        const state = await platform.getSessionState();
        const session = state.sessions.find((s) => s.sid === state.currentSid);
        if (session && body.data !== undefined) {
          const dir = `${await platform.getDataDir()}/uid_${session.mid}`;
          const fileMap: Record<string, string> = {
            "received-anchors-list": "received-anchors-list.json",
          };
          const fileName = fileMap[body.type];
          if (fileName) {
            await platform.mkdir(dir);
            await platform.writeFile(`${dir}/${fileName}`, JSON.stringify(body.data, null, 2));
          }
        }
      }
      return jsonResponse({ code: 0 });
    }
    default:
      // 未客户端化的辅助路径回退到服务器
      return fetch(serverApiUrl(path), { cache: "no-store", ...init });
  }
}

/** 统一数据请求：Web 走服务器，Tauri 走本地客户端 */
export async function dataFetch(
  path: string,
  init?: RequestInit,
  onProgress?: (p: FetchProgress) => void,
): Promise<Response> {
  const platform = await getPlatform();
  if (!platform.isNative) {
    return fetch(serverApiUrl(path), { cache: "no-store", ...init });
  }
  return dispatchNative(platform, path, init, onProgress);
}

/** 统一数据 POST 请求 */
export async function dataPost(path: string, body?: unknown): Promise<Response> {
  return dataFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
