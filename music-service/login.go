package main

import (
	"fmt"
	"strings"

	"github.com/guohuiyuan/music-lib/kugou"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/netease"
	"github.com/guohuiyuan/music-lib/qq"
)

// 汽水音乐的扫码流程依赖官方动态风控签名（a_bogus / msToken），
// music-lib 的 README 明确标注「未调通、不要作为稳定扫码能力暴露给用户」，
// 因此这里直接拒绝，改由管理后台手动填写 Cookie 绑定账号。
var errSodaQRUnsupported = fmt.Errorf("汽水音乐扫码登录暂未调通，请手动填写 Cookie")

// qrStart 创建扫码登录会话。
// source 支持 netease / qq / qq_wx / kugou / soda；qq_wx 是 QQ 音乐的微信扫码入口。
func qrStart(source string) (*model.QRLoginSession, error) {
	switch source {
	case "netease":
		return netease.New("").CreateQRLogin()
	case "qq":
		return qq.New("").CreateQRLogin()
	case "qq_wx":
		return qq.New("").CreateWXQRLogin()
	case "kugou":
		return kugou.New("").CreateQRLogin()
	case "soda":
		return nil, errSodaQRUnsupported
	}
	return nil, fmt.Errorf("unsupported login source: %s", source)
}

// qrCheck 轮询扫码状态；成功时返回的 Cookie 由调用方落盘。
func qrCheck(source, key string) (*model.QRLoginResult, error) {
	switch source {
	case "netease":
		return netease.New("").CheckQRLogin(key)
	case "qq":
		return qq.New("").CheckQRLogin(key)
	case "qq_wx":
		return qq.New("").CheckWXQRLogin(key)
	case "kugou":
		return kugou.New("").CheckQRLogin(key)
	case "soda":
		return nil, errSodaQRUnsupported
	}
	return nil, fmt.Errorf("unsupported login source: %s", source)
}

// accountSource 把登录入口映射到账号归属的平台（qq_wx 登录后同样是 QQ 音乐账号）。
func accountSource(source string) string {
	if source == "qq_wx" {
		return "qq"
	}
	return source
}

func isLoginSource(source string) bool {
	switch source {
	case "netease", "qq", "qq_wx", "kugou", "soda":
		return true
	}
	return false
}

func normalizeKey(key string) string {
	return strings.TrimSpace(key)
}
