const BILIBILI_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BILIBILI_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 os/android model/SM-G9910 build/8870400 osVer/13 sdkInt/33 network/2 BiliApp/8870400 mobi_app/android";

const BILIBILI_WEB_HEADERS = {
  "User-Agent": BILIBILI_WEB_UA,
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

const BILIBILI_MOBILE_HEADERS = {
  "User-Agent": BILIBILI_MOBILE_UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};

const BILIBILI_LIVE_HEADERS = {
  "User-Agent": BILIBILI_WEB_UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};

type FetchJsonOptions = {
  url: string;
  cookie?: string;
  method?: "GET" | "POST";
  body?: string;
  mobile?: boolean;
  live?: boolean;
};

export async function fetchBilibiliJson<T>({
  url,
  cookie,
  method = "GET",
  body,
  mobile = false,
  live = false,
}: FetchJsonOptions): Promise<T> {
  const headers = new Headers(
    mobile ? BILIBILI_MOBILE_HEADERS : live ? BILIBILI_LIVE_HEADERS : BILIBILI_WEB_HEADERS
  );
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  if (body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Bilibili request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function buildCookieHeader(cookies: string[]) {
  return cookies.filter(Boolean).join("; ");
}

let buvidPromise: Promise<string> | null = null;

/**
 * 获取 Bilibili 访客 buvid3 Cookie（用于通过 412 反爬校验）
 * 通过 SPI 接口获取，无需登录
 */
export async function getBuvidCookie(): Promise<string> {
  if (buvidPromise) return buvidPromise;

  buvidPromise = (async () => {
    try {
      const resp = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: BILIBILI_WEB_HEADERS,
        cache: "no-store",
      });
      if (!resp.ok) throw new Error(`SPI failed: ${resp.status}`);
      const data = await resp.json() as { code: number; data?: { b_3: string; b_4: string } };
      if (data.code === 0 && data.data?.b_3) {
        const cookie = `buvid3=${data.data.b_3};buvid4=${data.data.b_4 || ""}`;
        console.log("[buvid] 成功获取访客Cookie");
        return cookie;
      }
      throw new Error(`SPI code=${data.code}`);
    } catch (err) {
      console.warn("[buvid] 获取失败，将尝试直接访问首页获取:", err instanceof Error ? err.message : String(err));
      // Fallback: 访问首页从 Set-Cookie 获取
      try {
        const resp = await fetch("https://www.bilibili.com/", {
          headers: BILIBILI_WEB_HEADERS,
          cache: "no-store",
          redirect: "follow",
        });
        const cookies = resp.headers.getSetCookie?.() || [];
        const buvid3 = cookies.find(c => c.startsWith("buvid3="));
        if (buvid3) {
          return buvid3.split(";")[0];
        }
      } catch {}
      return "";
    }
  })();

  return buvidPromise;
}
