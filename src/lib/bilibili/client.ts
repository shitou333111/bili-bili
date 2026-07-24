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
  Accept: "application/json, text/plain, */*",
  Referer: "https://live.bilibili.com/",
  Origin: "https://live.bilibili.com",
};

type FetchJsonOptions = {
  url: string;
  cookie?: string;
  method?: "GET" | "POST";
  body?: string;
  mobile?: boolean;
};

export async function fetchBilibiliJson<T>({
  url,
  cookie,
  method = "GET",
  body,
  mobile = false,
}: FetchJsonOptions): Promise<T> {
  const headers = new Headers(mobile ? BILIBILI_MOBILE_HEADERS : BILIBILI_WEB_HEADERS);
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
