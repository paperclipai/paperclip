// Browser terminal server: ghostty-web frontend + node-pty over WebSocket.
// Modeled on how OpenChamber embeds ghostty-web (xterm.js-compatible API,
// WASM VT100 parser) against a pty bridged over a websocket.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

const PORT = Number(process.env.PORT || 7681);
const PUBLIC_DIR = path.join(__dirname, "public");
const VENDOR_DIR = path.join(__dirname, "node_modules", "ghostty-web", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".d.ts": "text/plain",
};

function serve(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = url.pathname;
  if (p === "/" || p === "") p = "/index.html";
  if (p.startsWith("/vendor/")) {
    const rel = p.slice("/vendor/".length);
    const target = path.normalize(path.join(VENDOR_DIR, rel));
    if (!target.startsWith(VENDOR_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    serve(res, target);
    return;
  }
  const target = path.normalize(path.join(PUBLIC_DIR, p));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  serve(res, target);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const shell = pty.spawn(process.env.SHELL || "bash", ["-l"], {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd: process.env.HOME || "/root",
    env: { ...process.env, TERM: "xterm-256color" },
  });

  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  shell.onExit(() => {
    try {
      ws.close();
    } catch {}
  });

  ws.on("message", (msg) => {
    const s = msg.toString();
    // Control frame: \x01{"cols":N,"rows":M} for resize.
    if (s.charCodeAt(0) === 1) {
      try {
        const { cols, rows } = JSON.parse(s.slice(1));
        shell.resize(cols, rows);
      } catch {}
      return;
    }
    shell.write(s);
  });

  ws.on("close", () => {
    try {
      shell.kill();
    } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ghostty terminal server listening on 0.0.0.0:${PORT}`);
});
