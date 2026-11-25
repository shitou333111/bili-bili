package main

import (
	"regexp"
	"strings"

	"github.com/guohuiyuan/music-lib/apple"
	"github.com/guohuiyuan/music-lib/bilibili"
	"github.com/guohuiyuan/music-lib/fivesing"
	"github.com/guohuiyuan/music-lib/jamendo"
	"github.com/guohuiyuan/music-lib/joox"
	"github.com/guohuiyuan/music-lib/kugou"
	"github.com/guohuiyuan/music-lib/kuwo"
	"github.com/guohuiyuan/music-lib/migu"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/netease"
	"github.com/guohuiyuan/music-lib/qianqian"
	"github.com/guohuiyuan/music-lib/qq"
	"github.com/guohuiyuan/music-lib/soda"
	"github.com/guohuiyuan/music-lib/spotify"
)

// platform 汇总一个音乐源对外暴露的能力。
// 部分平台（bilibili、fivesing）在 music-lib 中没有 ParseAlbum，字段为 nil。
type platform struct {
	name          string
	search        func(keyword string) ([]model.Song, error)
	parseSong     func(link string) (*model.Song, error)
	parsePlaylist func(link string) (*model.Playlist, []model.Song, error)
	parseAlbum    func(link string) (*model.Playlist, []model.Song, error)
}

var platforms = map[string]*platform{
	"netease": {
		name:          "netease",
		search:        netease.Search,
		parseSong:     netease.Parse,
		parsePlaylist: netease.ParsePlaylist,
		parseAlbum:    netease.ParseAlbum,
	},
	"qq": {
		name:          "qq",
		search:        qq.Search,
		parseSong:     parseQQSong,
		parsePlaylist: qq.ParsePlaylist,
		parseAlbum:    qq.ParseAlbum,
	},
	"kugou": {
		name:          "kugou",
		search:        kugou.Search,
		parseSong:     parseKugouSong,
		parsePlaylist: kugou.ParsePlaylist,
		parseAlbum:    kugou.ParseAlbum,
	},
	"kuwo": {
		name:          "kuwo",
		search:        kuwo.Search,
		parseSong:     kuwo.Parse,
		parsePlaylist: kuwo.ParsePlaylist,
		parseAlbum:    kuwo.ParseAlbum,
	},
	"migu": {
		name:          "migu",
		search:        migu.Search,
		parseSong:     migu.Parse,
		parsePlaylist: migu.ParsePlaylist,
		parseAlbum:    migu.ParseAlbum,
	},
	"qianqian": {
		name:          "qianqian",
		search:        qianqian.Search,
		parseSong:     qianqian.Parse,
		parsePlaylist: qianqian.ParsePlaylist,
		parseAlbum:    qianqian.ParseAlbum,
	},
	"soda": {
		name:          "soda",
		search:        soda.Search,
		parseSong:     soda.Parse,
		parsePlaylist: soda.ParsePlaylist,
		parseAlbum:    soda.ParseAlbum,
	},
	"fivesing": {
		name:          "fivesing",
		search:        fivesing.Search,
		parseSong:     fivesing.Parse,
		parsePlaylist: fivesing.ParsePlaylist,
		parseAlbum:    nil,
	},
	"jamendo": {
		name:          "jamendo",
		search:        jamendo.Search,
		parseSong:     jamendo.Parse,
		parsePlaylist: jamendo.ParsePlaylist,
		parseAlbum:    jamendo.ParseAlbum,
	},
	"joox": {
		name:          "joox",
		search:        joox.Search,
		parseSong:     joox.Parse,
		parsePlaylist: joox.ParsePlaylist,
		parseAlbum:    joox.ParseAlbum,
	},
	"apple": {
		name:          "apple",
		search:        apple.Search,
		parseSong:     apple.Parse,
		parsePlaylist: apple.ParsePlaylist,
		parseAlbum:    apple.ParseAlbum,
	},
	"spotify": {
		name:          "spotify",
		search:        spotify.Search,
		parseSong:     spotify.Parse,
		parsePlaylist: spotify.ParsePlaylist,
		parseAlbum:    spotify.ParseAlbum,
	},
	"bilibili": {
		name:          "bilibili",
		search:        bilibili.Search,
		parseSong:     bilibili.Parse,
		parsePlaylist: bilibili.ParsePlaylist,
		parseAlbum:    nil,
	},
}

// qq.Parse 只把 songDetail/<mid> 当作 songmid，但分享短链跳转后
// 可能是 songDetail/<纯数字 songid>，此时需要改走 songid 查询入口。
var qqSongDetailRe = regexp.MustCompile(`songDetail/([A-Za-z0-9]+)`)

func parseQQSong(link string) (*model.Song, error) {
	if m := qqSongDetailRe.FindStringSubmatch(link); len(m) >= 2 {
		if isAllDigits(m[1]) {
			return qq.Parse("https://y.qq.com/playsong.html?songid=" + m[1])
		}
	}
	return qq.Parse(link)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// splitArtists 把 music-lib 的 Artist 字符串（多歌手用“、”拼接）拆成数组。
func splitArtists(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		switch r {
		case '、', '/', '，', ';', '；':
			return true
		}
		return false
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	if len(out) == 0 {
		return []string{}
	}
	return out
}

func mapSongs(platformName string, songs []model.Song) []outSong {
	out := make([]outSong, 0, len(songs))
	for _, s := range songs {
		out = append(out, toOutSong(platformName, s))
	}
	return out
}

func toOutSong(platformName string, s model.Song) outSong {
	out := outSong{
		Platform: platformName,
		ID:       s.ID,
		Name:     s.Name,
		Artists:  splitArtists(s.Artist),
		Album:    s.Album,
		Duration: s.Duration,
	}
	// 酷狗播放接口需要 mixsongid，库放在 Extra["album_audio_id"]（搜索/榜单结果才有）
	if platformName == "kugou" {
		if v := strings.TrimSpace(s.Extra["album_audio_id"]); v != "" {
			out.PlayID = v
		}
	}
	// QQ 音乐客户端只认十进制 songid；库的 Song.ID 是 SongMID（字母数字），
	// 数字 id 放在 Extra["song_id"]（搜索与详情接口都会带）。
	if platformName == "qq" {
		if v := strings.TrimSpace(s.Extra["song_id"]); v != "" {
			out.PlayID = v
		}
	}
	return out
}
