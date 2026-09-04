import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = "c:/Users/song/vscode_projects/bili_live/out";
const PORT = 25102;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".avif": "image/avif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain",
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith("/")) p += "index.html";
    let file = path.join(ROOT, p);
    if (!path.extname(file) && !(await exists(file))) file = file + ".html";
    const data = await readFile(file);
    const ct = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": ct, "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

async function exists(f) { try { await readFile(f); return true; } catch { return false; } }

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("[ws] client connected, total=", clients.size);
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    console.log("[client->server]", JSON.stringify(msg).slice(0, 200));
    if (msg.type === "ready") {
      const init = {
        type: "init", orientation: "landscape",
        layouts: {
          gift: { landscape: { x: 50, y: 50, scale: 1 }, portrait: { x: 60, y: 60, scale: 1 } },
          entry: { landscape: { x: 400, y: 70, scale: 1 }, portrait: { x: 190, y: 80, scale: 1 } },
          anime: { landscape: { x: 0, y: 0, scale: 1 }, portrait: { x: 0, y: 0, scale: 1 } },
        },
        gifts: [], animeSample: null,
        flags: { master: true, entry: true, gift: true, anime: true },
      };
      for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(init));
      console.log("[server->client] init broadcast, clients=", clients.size);
    } else if (msg.type === "log") {
      console.log("[canvas-log]", msg.text);
    }
  });
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

server.listen(PORT, "127.0.0.1", () => console.log(`prod out/ test server on http://127.0.0.1:${PORT}`));
