package main

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/guohuiyuan/music-lib/kugou"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/netease"
	"github.com/guohuiyuan/music-lib/qq"
	"github.com/guohuiyuan/music-lib/soda"
)

// streamInfo 是一次「取流」的解析结果。
// PlayAuth 只用于汽水加密流解密，绝不返回给前端。
type streamInfo struct {
	URL      string
	PlayAuth string
	Ext      string
	Quality  string
	Preview  bool
}

type ucacheEntry struct {
	info *streamInfo
	at   time.Time
}

const urlCacheTTL = 4 * time.Minute

// 汽水会员曲目需要官方客户端的签名组件（bdms.node）才能拿到完整音频，
// music-lib 文档明确表示暂不支持，只有 Cookie 时只能取到试听片段。
// 先搁置汽水取流（相关代码全部保留），等库更新后把这里改回 true 即可。
const sodaStreamingEnabled = false

var (
	uCacheMu sync.Mutex
	uCache   = map[string]ucacheEntry{}
)

func cacheKey(source, id, playID, quality string) string {
	return source + "|" + id + "|" + playID + "|" + quality
}

// resolveStream 解析出可直接播放的音频地址。
// 音质按「请求档位 → auto」阶梯降级，保证有版权但音质不足时仍能播。
func (s *musicServer) resolveStream(source, id, playID, name, artist, quality string) (*streamInfo, error) {
	if !isStreamPlatform(source) {
		return nil, fmt.Errorf("unsupported source: %s", source)
	}
	if source == "soda" && !sodaStreamingEnabled {
		return nil, errors.New("soda_unavailable")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("song id is empty")
	}
	if quality == "" {
		// 默认「标准」音质：软件内播放走服务器中转，用标准档减轻带宽与转码压力
		quality = "standard"
	}

	key := cacheKey(source, id, playID, quality)
	uCacheMu.Lock()
	if e, ok := uCache[key]; ok && time.Since(e.at) < urlCacheTTL {
		uCacheMu.Unlock()
		return e.info, nil
	}
	uCacheMu.Unlock()

	song := buildSong(source, id, playID, name, artist)
	cookie := s.accounts.cookie(source)

	qualities := []string{quality}
	if quality != "auto" {
		qualities = append(qualities, "auto")
	}
	var lastErr error
	for _, q := range qualities {
		info, err := downloadInfo(source, cookie, song, q)
		if err == nil && info != nil && info.URL != "" {
			uCacheMu.Lock()
			uCache[key] = ucacheEntry{info: info, at: time.Now()}
			if len(uCache) > 300 {
				for k := range uCache {
					delete(uCache, k)
					if len(uCache) <= 150 {
						break
					}
				}
			}
			uCacheMu.Unlock()
			return info, nil
		}
		if err != nil {
			lastErr = err
		} else {
			lastErr = errors.New("download url not found")
		}
	}
	if lastErr == nil {
		lastErr = errors.New("download url not found")
	}
	return nil, lastErr
}

func buildSong(source, id, playID, name, artist string) *model.Song {
	song := &model.Song{
		Source: source,
		ID:     id,
		Name:   name,
		Artist: artist,
		Extra:  map[string]string{},
	}
	switch source {
	case "qq":
		song.Extra["songmid"] = id
		if playID != "" {
			song.Extra["song_id"] = playID
		}
	case "kugou":
		song.Extra["hash"] = id
		if playID != "" {
			song.Extra["album_audio_id"] = playID
		}
	case "soda":
		song.Extra["track_id"] = id
	}
	return song
}

func downloadInfo(source, cookie string, song *model.Song, quality string) (*streamInfo, error) {
	switch source {
	case "netease":
		client := netease.New(cookie)
		url, err := client.GetDownloadURLWithQuality(song, quality)
		if err != nil {
			return nil, err
		}
		return &streamInfo{URL: url, Ext: firstNonEmptyExt(song.Ext, guessExt(url)), Quality: quality}, nil
	case "qq":
		client := qq.New(cookie)
		url, err := client.GetDownloadURLWithQuality(song, quality)
		if err != nil {
			return nil, err
		}
		return &streamInfo{URL: url, Ext: guessExt(url), Quality: quality}, nil
	case "kugou":
		client := kugou.New(cookie)
		url, err := client.GetDownloadURLWithQuality(song, quality)
		if err != nil {
			return nil, err
		}
		return &streamInfo{URL: url, Ext: guessExt(url), Quality: quality}, nil
	case "soda":
		client := soda.New(cookie)
		info, err := client.GetDownloadInfoWithQuality(song, quality)
		if err != nil {
			return nil, err
		}
		if info == nil {
			return nil, errors.New("soda download info is nil")
		}
		return &streamInfo{
			URL:      info.URL,
			PlayAuth: info.PlayAuth,
			Ext:      firstNonEmptyExt(info.Format, guessExt(info.URL)),
			Quality:  firstNonEmptyExt(info.Quality, quality),
			Preview:  info.Preview,
		}, nil
	}
	return nil, fmt.Errorf("unsupported source: %s", source)
}

func firstNonEmptyExt(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return "mp3"
}

func guessExt(rawURL string) string {
	u := rawURL
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	if i := strings.IndexByte(u, '#'); i >= 0 {
		u = u[:i]
	}
	i := strings.LastIndexByte(u, '.')
	if i < 0 || len(u)-i > 6 {
		return ""
	}
	ext := strings.ToLower(u[i+1:])
	switch ext {
	case "mp3", "flac", "m4a", "aac", "ogg", "wav":
		return ext
	}
	return ""
}

func mimeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case "flac":
		return "audio/flac"
	case "m4a", "aac":
		return "audio/mp4"
	case "ogg":
		return "audio/ogg"
	case "wav":
		return "audio/wav"
	default:
		return "audio/mpeg"
	}
}

// upstreamHeaders 返回平台音频 CDN 需要的请求头（很多平台会校验 Referer / UA）。
func upstreamHeaders(source string) (string, string) {
	switch source {
	case "netease":
		return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", netease.Referer
	case "qq":
		return qq.UserAgent, qq.DownloadReferer
	case "kugou":
		return kugou.MobileUserAgent, "https://www.kugou.com/"
	case "soda":
		return soda.UserAgent, "https://music.douyin.com/"
	}
	return "Mozilla/5.0", ""
}

// proxyAudio 把上游音频流（含 Range）透传给调用方。
func (s *musicServer) proxyAudio(w http.ResponseWriter, r *http.Request, source string, info *streamInfo) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, info.URL, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	ua, referer := upstreamHeaders(source)
	req.Header.Set("User-Agent", ua)
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: fmt.Sprintf("upstream status %d", resp.StatusCode)})
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", mimeForExt(info.Ext))
	}
	if w.Header().Get("Accept-Ranges") == "" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// serveSoda 处理汽水音频：
// 免费曲目是明文 m4a，可以直接透传；带 play_auth 的加密流必须先整曲下载并解密，
// 解密结果落到本地缓存文件，再用 ServeContent 支持 Range（拖动进度条）。
func (s *musicServer) serveSoda(w http.ResponseWriter, r *http.Request, info *streamInfo) {
	if strings.TrimSpace(info.PlayAuth) == "" {
		s.proxyAudio(w, r, "soda", info)
		return
	}
	path, err := s.ensureSodaFile(info)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorOut{OK: false, Error: err.Error()})
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", mimeForExt(info.Ext))
	http.ServeContent(w, r, "", time.Time{}, f)
}

var sodaDownloadMu sync.Mutex

func (s *musicServer) ensureSodaFile(info *streamInfo) (string, error) {
	sum := sha1.Sum([]byte(info.URL + "|" + info.PlayAuth))
	ext := firstNonEmptyExt(info.Ext, "m4a")
	path := filepath.Join(s.cacheDir, hex.EncodeToString(sum[:])+"."+ext)
	if st, err := os.Stat(path); err == nil && st.Size() > 0 {
		return path, nil
	}

	// 整曲解密占用内存较大，用全局锁避免同一时刻多个请求同时下载
	sodaDownloadMu.Lock()
	defer sodaDownloadMu.Unlock()
	if st, err := os.Stat(path); err == nil && st.Size() > 0 {
		return path, nil
	}

	req, err := http.NewRequest(http.MethodGet, info.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", soda.UserAgent)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("soda download status: %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	plain, err := soda.DecryptAudio(raw, info.PlayAuth)
	if err != nil {
		return "", fmt.Errorf("soda decrypt failed: %w", err)
	}
	if err := os.MkdirAll(s.cacheDir, 0o755); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, plain, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	return path, nil
}
