import { NextResponse } from "next/server";
import { probeMusicStream } from "@/lib/sing/music-service";
import { createStreamUrl } from "@/lib/sing/stream-token";
import { isSingPlatform, type SongRef } from "@/lib/sing/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sing/stream/url
 * body: { platform, id, playId?, name, artists, duration? }
 *
 * 先探测该平台能否取到音频（失败时客户端可以明确回复「这首歌暂时播不了」），
 * 再签发短时令牌，返回可直接赋给 <audio src> 的地址。
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体不是合法 JSON", data: null }, { status: 400 });
  }
  const platform = body?.platform;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!isSingPlatform(platform) || !id) {
    return NextResponse.json(
      { code: 0, message: "bad_request", data: { ok: false, error: "bad_request" } },
      { status: 400 },
    );
  }
  const song: SongRef = {
    platform,
    id,
    playId: typeof body?.playId === "string" && body.playId ? body.playId : undefined,
    name: typeof body?.name === "string" ? body.name : "",
    artists: Array.isArray(body?.artists) ? body.artists.map(String) : [],
    duration: Number(body?.duration) > 0 ? Number(body.duration) : undefined,
  };
  const probe = await probeMusicStream(song);
  if (!probe.ok) {
    return NextResponse.json({
      code: 0,
      message: probe.error || "stream_unavailable",
      data: { ok: false, error: probe.error || "stream_unavailable" },
    });
  }
  const { url, expiresAt } = await createStreamUrl(song);
  return NextResponse.json({
    code: 0,
    message: "ok",
    data: {
      ok: true,
      url,
      expiresAt,
      quality: probe.quality,
      ext: probe.ext,
      preview: probe.preview,
    },
  });
}
