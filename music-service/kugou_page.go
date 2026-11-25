package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/guohuiyuan/music-lib/kugou"
	"github.com/guohuiyuan/music-lib/model"
)

// 酷狗「精选集」页（分享短链的落地页）是服务端渲染的，页面内嵌了完整歌曲数组。
// music-lib 的 ParsePlaylist 只认纯数字 specialid，这里直接读页面数据补齐。

var kugouPageClient = &http.Client{Timeout: 20 * time.Second}

const kugouPageUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

var (
	kugouSpecialIDRe   = regexp.MustCompile(`(?i)/yy/special/single/([a-z0-9_]+)\.html`)
	kugouDataVarRe     = regexp.MustCompile(`var\s+data\s*=`)
	kugouSpecialNameRe = regexp.MustCompile(`specialName\s*:\s*"([^"]*)"`)
	kugouSpecialImgRe  = regexp.MustCompile(`specialImg\s*:\s*"([^"]*)"`)
	kugouSongHashRe    = regexp.MustCompile(`(?i)hash=([0-9a-f]{32})`)
)

// kugouPageSong 是页面 var data=[...] 里的单条歌曲。
type kugouPageSong struct {
	Hash               string      `json:"HASH"`
	SongName           string      `json:"songname"`
	SingerName         string      `json:"singername"`
	AlbumName          string      `json:"album_name"`
	Duration           int         `json:"duration"`
	TimeLength         int         `json:"timelength"`
	Size               int64       `json:"size"`
	AlbumAudioID       interface{} `json:"album_audio_id"`
	EncodeAlbumAudioID string      `json:"encode_album_audio_id"`
	SongURL            string      `json:"song_url"`
}

func httpGetText(link string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", kugouPageUA)
	req.Header.Set("Referer", "https://www.kugou.com/")
	resp, err := kugouPageClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("http %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return string(b), err
}

func kugouIDString(v interface{}) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case float64:
		return strconv.FormatInt(int64(x), 10)
	case json.Number:
		return x.String()
	}
	return ""
}

// parseKugouSong 解析酷狗单曲链接（song/#hash=<32 位>）。
// 库的 Parse 要求接口返回可播放 URL，付费/受版权限制的歌会直接失败；
// 点歌只需要歌名/歌手/mixsongid，所以这里放宽为「能拿到元数据就算成功」。
func parseKugouSong(link string) (*model.Song, error) {
	m := kugouSongHashRe.FindStringSubmatch(link)
	if len(m) < 2 {
		return kugou.Parse(link)
	}
	hash := strings.ToUpper(m[1])
	if song, ok := fetchKugouSongMeta(hash); ok {
		return song, nil
	}
	return kugou.Parse(link)
}

type kugouSongInfo struct {
	SongName     string      `json:"songName"`
	SingerName   string      `json:"singerName"`
	AuthorName   string      `json:"author_name"`
	AlbumImg     string      `json:"album_img"`
	TimeLength   int         `json:"timeLength"`
	FileSize     int64       `json:"fileSize"`
	BitRate      int         `json:"bitRate"`
	AlbumAudioID interface{} `json:"album_audio_id"`
	Extra        struct {
		Hash128 string `json:"128hash"`
		Time128 int    `json:"128timelength"`
		Size128 int64  `json:"128filesize"`
	} `json:"extra"`
}

func fetchKugouSongMeta(hash string) (*model.Song, bool) {
	apiURL := "https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=" + url.QueryEscape(hash)
	body, err := httpGetText(apiURL)
	if err != nil {
		return nil, false
	}
	var resp kugouSongInfo
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		return nil, false
	}
	if strings.TrimSpace(resp.SongName) == "" {
		return nil, false
	}
	dur := resp.TimeLength
	if dur <= 0 {
		dur = resp.Extra.Time128 / 1000
	}
	size := resp.FileSize
	if size <= 0 {
		size = resp.Extra.Size128
	}
	artist := resp.AuthorName
	if strings.TrimSpace(artist) == "" {
		artist = resp.SingerName
	}
	playID := kugouIDString(resp.AlbumAudioID)
	extra := map[string]string{"hash": hash}
	if playID != "" {
		extra["album_audio_id"] = playID
	}
	return &model.Song{
		Source:   "kugou",
		ID:       hash,
		Name:     resp.SongName,
		Artist:   artist,
		Duration: dur,
		Size:     size,
		Bitrate:  resp.BitRate,
		Cover:    strings.Replace(resp.AlbumImg, "{size}", "240", 1),
		Link:     "https://www.kugou.com/song/#hash=" + hash,
		Extra:    extra,
	}, true
}

// parseKugouSpecialPage 解析酷狗精选集分享页（id 形如 collection_3_<uid>_<listid>_0）。
func parseKugouSpecialPage(link string) (parseOK, bool) {
	m := kugouSpecialIDRe.FindStringSubmatch(link)
	if len(m) < 2 || isAllDigits(m[1]) {
		// 纯数字 specialid 走库原有逻辑
		return parseOK{}, false
	}

	body, err := httpGetText(link)
	if err != nil {
		return parseOK{}, false
	}

	loc := kugouDataVarRe.FindStringIndex(body)
	if loc == nil {
		return parseOK{}, false
	}
	rest := body[loc[1]:]
	br := strings.Index(rest, "[")
	if br < 0 {
		return parseOK{}, false
	}
	var items []kugouPageSong
	if err := json.NewDecoder(strings.NewReader(rest[br:])).Decode(&items); err != nil || len(items) == 0 {
		return parseOK{}, false
	}

	songs := make([]model.Song, 0, len(items))
	for _, it := range items {
		h := strings.ToUpper(strings.TrimSpace(it.Hash))
		if !kugouHash32Re.MatchString(h) {
			continue
		}
		dur := it.Duration
		if dur <= 0 {
			dur = it.TimeLength
		}
		if dur > 1000 {
			dur /= 1000
		}
		extra := map[string]string{"hash": h}
		// 播放要的是十进制 mixsongid（= album_audio_id）
		if id := kugouIDString(it.AlbumAudioID); id != "" {
			extra["album_audio_id"] = id
		} else if it.EncodeAlbumAudioID != "" {
			extra["album_audio_id"] = it.EncodeAlbumAudioID
		}
		songs = append(songs, model.Song{
			Source:   "kugou",
			ID:       h,
			Name:     it.SongName,
			Artist:   it.SingerName,
			Album:    it.AlbumName,
			Duration: dur,
			Size:     it.Size,
			Link:     "https://www.kugou.com/song/#hash=" + h,
			Extra:    extra,
		})
	}
	if len(songs) == 0 {
		return parseOK{}, false
	}

	var name, cover string
	if mm := kugouSpecialNameRe.FindStringSubmatch(body); len(mm) == 2 {
		name = mm[1]
	}
	if mm := kugouSpecialImgRe.FindStringSubmatch(body); len(mm) == 2 {
		cover = mm[1]
	}

	return parseOK{
		OK:       true,
		Platform: "kugou",
		Kind:     "playlist",
		Name:     name,
		Cover:    cover,
		Songs:    mapSongs("kugou", songs),
	}, true
}
