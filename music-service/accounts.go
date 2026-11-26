package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 可登录 / 可流式播放的平台（与客户端的点歌平台保持一致）。
var streamPlatforms = []string{"netease", "qq", "kugou", "soda"}

func isStreamPlatform(name string) bool {
	for _, p := range streamPlatforms {
		if p == name {
			return true
		}
	}
	return false
}

// accountStore 保存每个平台一个账号的 Cookie（扫码登录成功后写入）。
// 文件默认在 .data/music/accounts.json，属于运行时数据，不进仓库。
type accountStore struct {
	path string

	mu      sync.RWMutex
	cookies map[string]string
	updated map[string]int64
}

type accountFile struct {
	Cookies map[string]string `json:"cookies"`
	Updated map[string]int64  `json:"updated"`
}

func newAccountStore(path string) (*accountStore, error) {
	s := &accountStore{
		path:    path,
		cookies: map[string]string{},
		updated: map[string]int64{},
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	var f accountFile
	if err := json.Unmarshal(raw, &f); err != nil {
		// 文件损坏时重置，避免整个服务起不来（重新扫码即可）
		return s, nil
	}
	if f.Cookies != nil {
		s.cookies = f.Cookies
	}
	if f.Updated != nil {
		s.updated = f.Updated
	}
	return s, nil
}

func (s *accountStore) cookie(source string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cookies[source]
}

func (s *accountStore) set(source, cookie string) error {
	s.mu.Lock()
	s.cookies[source] = cookie
	s.updated[source] = time.Now().Unix()
	s.mu.Unlock()
	return s.save()
}

func (s *accountStore) clear(source string) error {
	s.mu.Lock()
	delete(s.cookies, source)
	delete(s.updated, source)
	s.mu.Unlock()
	return s.save()
}

// status 返回各平台是否已登录（不暴露 Cookie 内容）。
func (s *accountStore) status() map[string]map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]map[string]any, len(streamPlatforms))
	for _, p := range streamPlatforms {
		cookie := s.cookies[p]
		item := map[string]any{"loggedIn": cookie != ""}
		if at := s.updated[p]; at > 0 {
			item["updatedAt"] = at
		}
		if cookie != "" {
			item["cookieKeys"] = cookieKeyNames(cookie)
		}
		out[p] = item
	}
	return out
}

// cookieKeyNames 只返回 Cookie 的键名，便于排查登录是否完整（不泄露值）。
func cookieKeyNames(cookie string) []string {
	names := []string{}
	for _, part := range splitCookie(cookie) {
		if i := indexByte(part, '='); i > 0 {
			names = append(names, part[:i])
		}
	}
	sort.Strings(names)
	if len(names) > 24 {
		names = names[:24]
	}
	return names
}

// normalizeCookieInput 清洗手动粘贴的 Cookie：
// 允许带 "Cookie:" 前缀、换行分隔和多余空白，要求至少有一个 name=value。
func normalizeCookieInput(raw string) (string, error) {
	text := trimSpace(raw)
	if text == "" {
		return "", fmt.Errorf("cookie 为空")
	}
	// 去掉浏览器 DevTools 复制出来的 "Cookie:" 前缀
	if len(text) >= 7 && strings.EqualFold(text[:7], "cookie:") {
		text = text[7:]
	}
	parts := splitCookie(strings.NewReplacer("\r", ";", "\n", ";").Replace(text))
	valid := make([]string, 0, len(parts))
	for _, part := range parts {
		if indexByte(part, '=') > 0 {
			valid = append(valid, part)
		}
	}
	if len(valid) == 0 {
		return "", fmt.Errorf("cookie 格式不正确（应形如 name=value; name2=value2）")
	}
	return strings.Join(valid, "; "), nil
}

func splitCookie(cookie string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(cookie); i++ {
		if cookie[i] == ';' {
			part := trimSpace(cookie[start:i])
			if part != "" {
				out = append(out, part)
			}
			start = i + 1
		}
	}
	if part := trimSpace(cookie[start:]); part != "" {
		out = append(out, part)
	}
	return out
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}

func (s *accountStore) save() error {
	s.mu.RLock()
	f := accountFile{Cookies: map[string]string{}, Updated: map[string]int64{}}
	for k, v := range s.cookies {
		f.Cookies[k] = v
	}
	for k, v := range s.updated {
		f.Updated[k] = v
	}
	s.mu.RUnlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	// 先写临时文件再改名，避免进程中断时留下半个 JSON
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
