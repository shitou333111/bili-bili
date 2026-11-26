package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// musicServer 是点歌机「软件内播放」的常驻服务：
// 只监听本机回环地址，由 Next 服务端反向代理，外部无法直连。
type musicServer struct {
	accounts *accountStore
	cacheDir string
	token    string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	addr := fs.String("addr", "127.0.0.1:8081", "监听地址（建议只绑定回环地址）")
	data := fs.String("data", filepath.Join(".data", "music", "accounts.json"), "账号 Cookie 存储文件")
	cache := fs.String("cache", filepath.Join(".data", "music", "cache"), "汽水加密流解密缓存目录")
	token := fs.String("token", os.Getenv("MUSIC_SERVICE_TOKEN"), "内部访问令牌（非空时要求 X-Music-Token 请求头）")
	if err := fs.Parse(args); err != nil {
		return err
	}

	store, err := newAccountStore(*data)
	if err != nil {
		return fmt.Errorf("load accounts: %w", err)
	}
	if err := os.MkdirAll(*cache, 0o755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	s := &musicServer{accounts: store, cacheDir: *cache, token: *token}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "music-service"})
	})

	api := http.NewServeMux()
	api.HandleFunc("GET /api/music/accounts", s.handleAccounts)
	api.HandleFunc("POST /api/music/accounts/{source}/clear", s.handleAccountClear)
	api.HandleFunc("POST /api/music/accounts/{source}/cookie", s.handleAccountCookie)
	api.HandleFunc("POST /api/music/login/{source}/start", s.handleLoginStart)
	api.HandleFunc("GET /api/music/login/{source}/check", s.handleLoginCheck)
	api.HandleFunc("POST /api/music/search", s.handleSearch)
	api.HandleFunc("GET /api/music/probe", s.handleProbe)
	api.HandleFunc("GET /api/music/stream", s.handleStream)
	api.HandleFunc("HEAD /api/music/stream", s.handleStream)
	mux.Handle("/api/music/", s.auth(api))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("music-service serve on http://%s (auth=%v, data=%s)", *addr, *token != "", *data)
	return srv.ListenAndServe()
}

func (s *musicServer) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" && r.Header.Get("X-Music-Token") != s.token {
			writeJSON(w, http.StatusUnauthorized, errorOut{OK: false, Error: "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *musicServer) handleAccounts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"platforms": streamPlatforms,
		"accounts":  s.accounts.status(),
	})
}

func (s *musicServer) handleAccountClear(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("source")
	if !isStreamPlatform(accountSource(source)) {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "unsupported source"})
		return
	}
	if err := s.accounts.clear(accountSource(source)); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorOut{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "loggedIn": false})
}

// handleSearch 用账号 Cookie 搜索（带会员权益，避免 VIP 原唱被匿名过滤）。
func (s *musicServer) handleSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source string `json:"source"`
		Q      string `json:"q"`
		Limit  int    `json:"limit"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "invalid json"})
		return
	}
	source := accountSource(strings.ToLower(strings.TrimSpace(body.Source)))
	query := strings.TrimSpace(body.Q)
	if !isStreamPlatform(source) {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "unsupported source"})
		return
	}
	if query == "" {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "missing q"})
		return
	}
	limit := body.Limit
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	songs, err := searchWithCookie(source, s.accounts.cookie(source), query, limit)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "songs": mapSongs(source, songs)})
}

// handleAccountCookie 手动绑定账号 Cookie（汽水扫码未调通，只能走这里）。
// 只接受 JSON：{"cookie":"..."}；Cookie 仅保存在服务器，不回传。
func (s *musicServer) handleAccountCookie(w http.ResponseWriter, r *http.Request) {
	source := accountSource(r.PathValue("source"))
	if !isStreamPlatform(source) {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "unsupported source"})
		return
	}
	var body struct {
		Cookie string `json:"cookie"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "invalid json"})
		return
	}
	cookie, err := normalizeCookieInput(body.Cookie)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: err.Error()})
		return
	}
	if err := s.accounts.set(source, cookie); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorOut{OK: false, Error: err.Error()})
		return
	}
	// 已缓存的音频地址可能是在匿名态解析的，绑定后立即失效
	uCacheMu.Lock()
	uCache = map[string]ucacheEntry{}
	uCacheMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"loggedIn":   true,
		"cookieKeys": cookieKeyNames(cookie),
	})
}

func (s *musicServer) handleLoginStart(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("source")
	if !isLoginSource(source) {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "unsupported source"})
		return
	}
	session, err := qrStart(source)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"source":    source,
		"key":       session.Key,
		"url":       session.URL,
		"image":     session.ImageURL,
		"expiresAt": session.ExpiresAt,
	})
}

func (s *musicServer) handleLoginCheck(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("source")
	if !isLoginSource(source) {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "unsupported source"})
		return
	}
	key := normalizeKey(r.URL.Query().Get("key"))
	if key == "" {
		writeJSON(w, http.StatusBadRequest, errorOut{OK: false, Error: "missing key"})
		return
	}
	result, err := qrCheck(source, key)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	payload := map[string]any{
		"ok":      true,
		"status":  result.Status,
		"message": result.Message,
		"key":     result.Key,
	}
	// 汽水短信验证等场景需要把中间状态与额外参数透传给前端
	if len(result.Extra) > 0 {
		payload["extra"] = result.Extra
	}
	if result.Status == "success" && result.Cookie != "" {
		if err := s.accounts.set(accountSource(source), result.Cookie); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorOut{OK: false, Error: err.Error()})
			return
		}
		payload["loggedIn"] = true
		// 登录成功即失效 URL 缓存（此前可能是匿名态解析出的低音质地址）
		uCacheMu.Lock()
		uCache = map[string]ucacheEntry{}
		uCacheMu.Unlock()
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *musicServer) handleProbe(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := q.Get("source")
	info, err := s.resolveStream(source, q.Get("id"), q.Get("playid"), q.Get("name"), q.Get("artist"), q.Get("quality"))
	if err != nil {
		writeJSON(w, http.StatusOK, errorOut{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"ext":     info.Ext,
		"quality": info.Quality,
		"preview": info.Preview,
	})
}

func (s *musicServer) handleStream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := q.Get("source")
	info, err := s.resolveStream(source, q.Get("id"), q.Get("playid"), q.Get("name"), q.Get("artist"), q.Get("quality"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorOut{OK: false, Error: err.Error()})
		return
	}
	if source == "soda" {
		s.serveSoda(w, r, info)
		return
	}
	s.proxyAudio(w, r, source, info)
}
