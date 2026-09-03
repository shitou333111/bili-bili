/**
 * bilibili-live-ws 心跳补丁（postinstall 自动执行）
 *
 * 问题：B站弹幕服务器在收不到心跳包时会在 ~60s 后强制断开连接。
 * 原库（Live 类）的心跳是"回应驱动"的——只有在收到服务器心跳回应（人气包）后，
 * 才会 setTimeout 安排下一次心跳。当服务器不回应心跳时（如房间未开播），
 * 客户端只发出 welcome 后的那一次心跳，随后不再发送 → 60s 后连接被服务器断开，
 * KeepLive 重连 → 无限 open/auth/close 循环。
 *
 * 修复：改为固定间隔心跳（每 30s 发送一次，不依赖服务器回应），
 * 与官方协议建议一致；心跳回应的处理仅保留"更新人气 + 触发事件"。
 *
 * 幂等：已打补丁时直接跳过。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "node_modules", "bilibili-live-ws", "src", "common.js");

try {
  if (!existsSync(file)) {
    console.warn("[patch-bilibili-ws] 未找到 bilibili-live-ws/src/common.js（依赖未安装？），跳过");
    process.exit(0);
  }
  let src = readFileSync(file, "utf8");
  let changed = false;

  // 补丁 1：初始化固定心跳定时器字段
  const OLD_INIT = "        this.timeout = setTimeout(() => { }, 0);";
  const NEW_INIT =
    "        this.timeout = setTimeout(() => { }, 0);\n        this._hbTimer = null; // [patch-bilibili-ws] 固定间隔心跳定时器";
  if (src.includes(OLD_INIT) && !src.includes("_hbTimer = null")) {
    src = src.replace(OLD_INIT, NEW_INIT);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁1: 已初始化固定心跳定时器");
  }

  // 补丁 2：welcome 后启动固定 30s 心跳（不依赖服务器回应）
  const OLD_WELCOME = `                if (type === 'welcome') {
                    this.live = true;
                    this.emit('live');
                    this.send((0, buffer_1.encoder)('heartbeat', inflates));
                }`;
  const NEW_WELCOME = `                if (type === 'welcome') {
                    this.live = true;
                    this.emit('live');
                    this.send((0, buffer_1.encoder)('heartbeat', inflates));
                    // [patch-bilibili-ws] 每 30s 固定发送心跳，不依赖服务器回应。
                    // 原逻辑只在收到心跳回应后才安排下一次，服务器不回（如未开播）时
                    // 只发一次心跳 → 60s 后被服务器断开 → 无限 open/auth/close 循环。
                    if (!this._hbTimer) {
                        this._hbTimer = setInterval(() => this.heartbeat(), 1000 * 30);
                    }
                }`;
  if (src.includes(OLD_WELCOME) && !src.includes("this._hbTimer = setInterval")) {
    src = src.replace(OLD_WELCOME, NEW_WELCOME);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁2: 已启用固定 30s 心跳");
  }

  // 补丁 3：心跳回应分支去掉"回应驱动"的 setTimeout 调度（由固定定时器负责）
  const OLD_HEARTBEAT = `                if (type === 'heartbeat') {
                    this.online = data;
                    clearTimeout(this.timeout);
                    this.timeout = setTimeout(() => this.heartbeat(), 1000 * 30);
                    this.emit('heartbeat', this.online);
                }`;
  const NEW_HEARTBEAT = `                if (type === 'heartbeat') {
                    this.online = data;
                    // [patch-bilibili-ws] 心跳由固定间隔定时器发送，这里只更新人气并通知
                    this.emit('heartbeat', this.online);
                }`;
  if (src.includes(OLD_HEARTBEAT) && !src.includes("// [patch-bilibili-ws] 心跳由固定间隔定时器发送")) {
    src = src.replace(OLD_HEARTBEAT, NEW_HEARTBEAT);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁3: 心跳调度改为固定间隔");
  }

  // 补丁 4：连接关闭时停止固定心跳定时器
  const OLD_CLOSE = `        this.on('close', () => {
            clearTimeout(this.timeout);
        });`;
  const NEW_CLOSE = `        this.on('close', () => {
            clearTimeout(this.timeout);
            // [patch-bilibili-ws] 连接关闭时停止固定心跳定时器
            if (this._hbTimer) {
                clearInterval(this._hbTimer);
                this._hbTimer = null;
            }
        });`;
  if (src.includes(OLD_CLOSE) && !src.includes("clearInterval(this._hbTimer)")) {
    src = src.replace(OLD_CLOSE, NEW_CLOSE);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁4: 关闭时停止心跳定时器");
  }

  // 补丁 5：Live.heartbeat() 发送成功后发出 heartbeat-sent 事件（供 KeepLive 看门狗复位）
  const OLD_HB_SEND = `    heartbeat() {
        this.send((0, buffer_1.encoder)('heartbeat', this.inflates));
    }`;
  const NEW_HB_SEND = `    heartbeat() {
        this.send((0, buffer_1.encoder)('heartbeat', this.inflates));
        this.emit('heartbeat-sent'); // [patch-bilibili-ws]
    }`;
  if (src.includes(OLD_HB_SEND) && !src.includes("this.emit('heartbeat-sent')")) {
    src = src.replace(OLD_HB_SEND, NEW_HB_SEND);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁5: heartbeat() 发送后发出 heartbeat-sent");
  }

  // 补丁 6：KeepLive 看门狗改按"客户端发送心跳"复位，不依赖服务器心跳回应。
  // 服务器对未开播房间可能不回应心跳，若仍按回应复位，45s 后会误杀本可用的连接。
  const OLD_WATCHDOG = `        connection.on('heartbeat', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                connection.close();
                connection.emit('timeout');
            }, this.timeout);
        });`;
  const NEW_WATCHDOG = `        connection.on('heartbeat', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                connection.close();
                connection.emit('timeout');
            }, this.timeout);
        });
        // [patch-bilibili-ws] 客户端每 30s 固定发送心跳，只要心跳能发出去连接就是活的，
        // 也复位看门狗；避免服务器不回应心跳（如未开播）时看门狗 45s 误杀连接。
        connection.on('heartbeat-sent', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                connection.close();
                connection.emit('timeout');
            }, this.timeout);
        });`;
  if (src.includes(OLD_WATCHDOG) && !src.includes("connection.on('heartbeat-sent'")) {
    src = src.replace(OLD_WATCHDOG, NEW_WATCHDOG);
    changed = true;
    console.log("[patch-bilibili-ws] 补丁6: 看门狗按心跳发送复位");
  }

  if (changed) {
    writeFileSync(file, src, "utf8");
    console.log("[patch-bilibili-ws] 补丁完成");
  } else {
    console.log("[patch-bilibili-ws] 已打补丁，跳过");
  }
} catch (e) {
  console.warn("[patch-bilibili-ws] 补丁失败:", e.message);
  process.exit(0);
}
