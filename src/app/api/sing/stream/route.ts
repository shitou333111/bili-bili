import { musicServiceBase, musicServiceToken } from "@/lib/sing/music-service";
import { verifyStreamToken } from "@/lib/sing/stream-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 透传给客户端的上游响应头（Range / 类型 / 长度相关） */
const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
];

async function proxy(request: Request, method: "GET" | "HEAD"): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") || "";
  const verified = await verifyStreamToken(token);
  if (!verified.ok) {
    return new Response(JSON.stringify({ ok: false, error: verified.error }), {
      status: verified.error === "expired" ? 410 : 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { payload } = verified;
  const qs = new URLSearchParams({
    source: payload.p,
    id: payload.i,
    name: payload.n || "",
    artist: payload.a || "",
    quality: "standard",
  });
  if (payload.pd) qs.set("playid", payload.pd);

  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers["Range"] = range;
  const tokenHeader = musicServiceToken();
  if (tokenHeader) headers["X-Music-Token"] = tokenHeader;

  let upstream: Response;
  try {
    upstream = await fetch(`${musicServiceBase()}/api/music/stream?${qs.toString()}`, {
      method,
      headers,
      cache: "no-store",
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "service_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const out = new Headers();
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
  if (!out.has("cache-control")) out.set("cache-control", "no-store");

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export async function GET(request: Request): Promise<Response> {
  return proxy(request, "GET");
}

export async function HEAD(request: Request): Promise<Response> {
  return proxy(request, "HEAD");
}
