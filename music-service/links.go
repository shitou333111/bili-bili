package main

import (
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var shortLinkClient = &http.Client{
	Timeout: 20 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

const shortLinkUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"

// shortLinkPatterns 命中这些片段的链接需要先跟随跳转才能确定真实地址。
var shortLinkPatterns = []string{
	"base/fcgi-bin",
	"share/song.html",
	"share/song",
	"b23.tv/",
	"163cn.tv/",
	"music.163.com/share",
	// 酷狗分享短链：t1.kugou.com/<短码>、旧域名 t.kugou.com、share/<id>.html
	"t1.kugou.com/",
	"t.kugou.com/",
	"kugou.com/share/",
}

func hostOf(link string) string {
	u, err := url.Parse(link)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func normalizeInput(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.Trim(s, "\"'")
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "//") {
		return "https:" + s
	}
	if !strings.Contains(s, "://") {
		return "https://" + s
	}
	return s
}

func needsRedirectResolution(link string) bool {
	lower := strings.ToLower(link)
	for _, p := range shortLinkPatterns {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// resolveShortLink 跟随重定向，返回最终地址以及（必要时）页面内容。
func resolveShortLink(link string) (string, []byte) {
	if !needsRedirectResolution(link) {
		return link, nil
	}
	req, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil {
		return link, nil
	}
	req.Header.Set("User-Agent", shortLinkUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")

	resp, err := shortLinkClient.Do(req)
	if err != nil {
		return link, nil
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))

	final := link
	if resp.Request != nil && resp.Request.URL != nil {
		final = resp.Request.URL.String()
	}
	return final, body
}

// kugouShareHashRe 从酷狗分享页内嵌数据中提取音频 hash。
var kugouShareHashRe = regexp.MustCompile(`(?i)"(?:req_hash|hash)"\s*:\s*"([0-9a-f]{32})"`)

// kugouHashLink 针对酷狗分享页（m.kugou.com/share/song.html?chain=...）返回带 hash 的链接。
func kugouHashLink(link string, body []byte) string {
	if body == nil || !strings.Contains(strings.ToLower(link), "kugou.com") {
		return ""
	}
	m := kugouShareHashRe.FindSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return "https://www.kugou.com/song/#hash=" + strings.ToUpper(string(m[1]))
}

var kugouHash32Re = regexp.MustCompile(`(?i)^[0-9a-f]{32}$`)

// kugouShare 是酷狗分享短链跳转后的可解析目标。
type kugouShare struct {
	link   string
	playID string // 单曲分享里的十进制 album_audio_id（= mixsongid）
}

// kugouShareURL 解析酷狗分享跳转后的落地地址：
//   - 歌单：global_specialid=collection_3_<uid>_<listid>_0 / gcid_xxx / 数字
//     → 精选集页（yy/special/single/<id>.html）或歌单中心页（songlist/<gcid>/）
//   - 单曲：hash=<32 位> → song/#hash=<HASH>，并带上 album_audio_id
func kugouShareURL(final string) kugouShare {
	if !strings.Contains(strings.ToLower(final), "kugou.com") {
		return kugouShare{}
	}
	u, err := url.Parse(final)
	if err != nil {
		return kugouShare{}
	}
	q := u.Query()
	id := strings.TrimSpace(q.Get("global_specialid"))
	if id == "" || id == "0" {
		id = strings.TrimSpace(q.Get("global_collection_id"))
	}
	if id == "" || id == "0" {
		id = strings.TrimSpace(q.Get("specialid"))
	}
	if id != "" && id != "0" {
		if strings.HasPrefix(id, "gcid_") {
			return kugouShare{link: "https://www.kugou.com/songlist/" + id + "/"}
		}
		return kugouShare{link: "https://www.kugou.com/yy/special/single/" + id + ".html"}
	}
	if h := strings.TrimSpace(q.Get("hash")); kugouHash32Re.MatchString(h) {
		return kugouShare{
			link:   "https://www.kugou.com/song/#hash=" + strings.ToUpper(h),
			playID: strings.TrimSpace(q.Get("album_audio_id")),
		}
	}
	return kugouShare{}
}

// detectPlatform 依据 URL host 判断平台，5sing 需先于 kugou 判断。
func detectPlatform(link string) string {
	host := hostOf(link)
	if host == "" {
		return ""
	}
	switch {
	case strings.HasSuffix(host, "music.163.com"):
		return "netease"
	case host == "5sing.kugou.com" || strings.HasSuffix(host, ".5sing.kugou.com"):
		return "fivesing"
	case strings.HasSuffix(host, "y.qq.com"):
		return "qq"
	case strings.HasSuffix(host, "kugou.com"):
		return "kugou"
	case strings.HasSuffix(host, "kuwo.cn"):
		return "kuwo"
	case strings.HasSuffix(host, "music.migu.cn"):
		return "migu"
	case strings.HasSuffix(host, "music.taihe.com") || strings.HasSuffix(host, "qianqian.com") || strings.HasSuffix(host, "91q.com"):
		return "qianqian"
	case strings.HasSuffix(host, "qishui.douyin.com"):
		return "soda"
	case strings.HasSuffix(host, "jamendo.com"):
		return "jamendo"
	case strings.HasSuffix(host, "joox.com"):
		return "joox"
	case strings.HasSuffix(host, "music.apple.com"):
		return "apple"
	case strings.HasSuffix(host, "open.spotify.com") || strings.HasSuffix(host, "spotify.com"):
		return "spotify"
	case strings.HasSuffix(host, "bilibili.com") || strings.HasSuffix(host, "b23.tv"):
		return "bilibili"
	}
	return ""
}

// detectKind 依据 URL 片段推测链接类型；解析失败时会回退尝试其它类型。
func detectKind(link string) string {
	l := strings.ToLower(link)
	switch {
	case strings.Contains(l, "/album"),
		strings.Contains(l, "albumdetail"),
		strings.Contains(l, "albumassetcode"),
		strings.Contains(l, "albumid="):
		return "album"
	case strings.Contains(l, "playlist"),
		strings.Contains(l, "songlist"),
		strings.Contains(l, "special/single"),
		strings.Contains(l, "/dj/"),
		strings.Contains(l, "musiclistid"),
		strings.Contains(l, "gcid_"),
		strings.Contains(l, "plist"):
		return "playlist"
	default:
		return "song"
	}
}

func kindOrder(hint string) []string {
	switch hint {
	case "playlist":
		return []string{"playlist", "album", "song"}
	case "album":
		return []string{"album", "playlist", "song"}
	default:
		return []string{"song", "playlist", "album"}
	}
}
