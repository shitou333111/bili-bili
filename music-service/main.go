package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/guohuiyuan/music-lib/soda"
)

type outSong struct {
	Platform string   `json:"platform"`
	ID       string   `json:"id"`
	PlayID   string   `json:"playId,omitempty"`
	Name     string   `json:"name"`
	Artists  []string `json:"artists"`
	Album    string   `json:"album"`
	Duration int      `json:"duration"`
}

type parseOK struct {
	OK       bool      `json:"ok"`
	Platform string    `json:"platform"`
	Kind     string    `json:"kind"`
	Name     string    `json:"name"`
	Cover    string    `json:"cover"`
	Songs    []outSong `json:"songs"`
	// Link 是解析后实际使用的规范链接（例如酷狗短链会换成长期有效的精选集页），
	// 客户端应保存这个链接，避免分享短链过期后无法刷新歌单。
	Link string `json:"link"`
}

type searchOK struct {
	OK    bool      `json:"ok"`
	Songs []outSong `json:"songs"`
}

type healthOK struct {
	OK bool `json:"ok"`
}

// capabilitiesOK 描述本机环境下各平台「搜索」是否可用。
// 汽水搜索依赖官方客户端的本机签名器（bdms.node + node），
// 没装客户端的机器（例如 Linux 服务器）搜索必然返回空 body。
type capabilitiesOK struct {
	OK     bool            `json:"ok"`
	Search map[string]bool `json:"search"`
}

type errorOut struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

const usageText = `usage:
  music-service health
  music-service capabilities
  music-service parse <url>
  music-service search --source <platform> --q <keyword> [--limit 10]
  music-service serve [--addr 127.0.0.1:8081] [--data .data/music/accounts.json] [--token ...]

serve 模式提供点歌机「软件内播放」所需的取流与扫码登录接口（仅监听本机回环地址）。`

func emit(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// fail 输出单行 JSON 错误（stdout）并把可读信息写入 stderr，然后退出。
func fail(err error, code int) {
	msg := "unknown error"
	if err != nil {
		msg = err.Error()
	}
	emit(errorOut{OK: false, Error: msg})
	fmt.Fprintln(os.Stderr, "music-service: "+msg)
	os.Exit(code)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usageText)
		fail(errors.New("missing command"), 2)
	}

	switch os.Args[1] {
	case "health":
		emit(healthOK{OK: true})
	case "capabilities":
		emit(capabilitiesOK{
			OK: true,
			Search: map[string]bool{
				// 本机签名器可用 = 装了汽水客户端且能找到 node 运行时
				"soda": soda.LocalSignerAvailable(),
			},
		})
	case "parse":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, usageText)
			fail(errors.New("missing url argument"), 2)
		}
		out, err := runParse(os.Args[2])
		if err != nil {
			fail(err, 1)
		}
		emit(out)
	case "search":
		out, err := runSearch(os.Args[2:])
		if err != nil {
			fail(err, 2)
		}
		emit(out)
	case "serve":
		if err := runServe(os.Args[2:]); err != nil {
			fail(err, 1)
		}
	default:
		fmt.Fprintln(os.Stderr, usageText)
		fail(fmt.Errorf("unknown command: %s", os.Args[1]), 2)
	}
}

func runParse(raw string) (parseOK, error) {
	link := normalizeInput(raw)
	if link == "" {
		return parseOK{}, errors.New("empty url")
	}

	final, body := resolveShortLink(link)
	if final != "" {
		link = final
	}
	var kugouPlayID string
	if share := kugouShareURL(link); share.link != "" {
		link = share.link
		kugouPlayID = share.playID
	} else if hashLink := kugouHashLink(link, body); hashLink != "" {
		link = hashLink
	}

	name := detectPlatform(link)
	if name == "" {
		name = detectPlatform(normalizeInput(raw))
	}
	if name == "" {
		return parseOK{}, fmt.Errorf("unsupported url: %s", raw)
	}
	p, ok := platforms[name]
	if !ok {
		return parseOK{}, fmt.Errorf("platform not supported: %s", name)
	}

	// 酷狗精选集分享页（yy/special/single/collection_...）库只认纯数字 specialid，
	// 这里直接读页面内嵌的 var data=[...]。
	if name == "kugou" {
		if out, ok := parseKugouSpecialPage(link); ok {
			out.Link = link
			return out, nil
		}
	}

	var errs []string
	for _, kind := range kindOrder(detectKind(link)) {
		out, err := tryParseKind(p, kind, link)
		if err == nil {
			// 单曲分享短链里的 album_audio_id 就是播放要的 mixsongid，补上可省一次搜索
			if kugouPlayID != "" && len(out.Songs) == 1 && out.Songs[0].PlayID == "" {
				out.Songs[0].PlayID = kugouPlayID
			}
			out.Link = link
			return out, nil
		}
		errs = append(errs, kind+": "+err.Error())
	}
	return parseOK{}, fmt.Errorf("%s parse failed: %s", name, strings.Join(errs, " | "))
}

func tryParseKind(p *platform, kind, link string) (parseOK, error) {
	switch kind {
	case "playlist", "album":
		parse := p.parsePlaylist
		if kind == "album" {
			parse = p.parseAlbum
		}
		if parse == nil {
			return parseOK{}, fmt.Errorf("%s does not support %s links", p.name, kind)
		}
		pl, songs, err := parse(link)
		if err != nil {
			return parseOK{}, err
		}
		if pl == nil {
			return parseOK{}, errors.New("empty result")
		}
		return parseOK{
			OK:       true,
			Platform: p.name,
			Kind:     kind,
			Name:     pl.Name,
			Cover:    pl.Cover,
			Songs:    mapSongs(p.name, songs),
		}, nil
	default:
		song, err := p.parseSong(link)
		if err != nil {
			return parseOK{}, err
		}
		if song == nil {
			return parseOK{}, errors.New("empty result")
		}
		return parseOK{
			OK:       true,
			Platform: p.name,
			Kind:     "song",
			Name:     song.Name,
			Cover:    song.Cover,
			Songs:    []outSong{toOutSong(p.name, *song)},
		}, nil
	}
}

func runSearch(args []string) (searchOK, error) {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	source := fs.String("source", "", "music platform")
	query := fs.String("q", "", "search keyword")
	limit := fs.Int("limit", 10, "max results")
	if err := fs.Parse(args); err != nil {
		return searchOK{}, err
	}

	name := strings.ToLower(strings.TrimSpace(*source))
	if name == "" {
		return searchOK{}, errors.New("missing --source")
	}
	if strings.TrimSpace(*query) == "" {
		return searchOK{}, errors.New("missing --q")
	}
	p, ok := platforms[name]
	if !ok {
		return searchOK{}, fmt.Errorf("platform not supported: %s", name)
	}
	if p.search == nil {
		return searchOK{}, fmt.Errorf("%s does not support search", name)
	}

	songs, err := p.search(*query)
	if err != nil {
		return searchOK{}, fmt.Errorf("%s search failed: %w", name, err)
	}

	max := *limit
	if max <= 0 {
		max = 10
	}
	if len(songs) > max {
		songs = songs[:max]
	}
	return searchOK{OK: true, Songs: mapSongs(name, songs)}, nil
}
