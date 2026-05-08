# syntax=docker/dockerfile:1.20
FROM node:lts-alpine

# Build tools needed to compile node-pty native module
RUN apk add --no-cache python3 make g++ linux-headers && \
    npm install -g @anthropic-ai/claude-code@latest

# Install server dependencies
WORKDIR /app
RUN npm init -y && npm install node-pty

# Pre-seed settings so Claude skips the first-run theme wizard
RUN mkdir -p /root/.claude && \
    printf '{"theme":"dark","hasCompletedOnboarding":true,"onboardingVersion":5}\n' \
    > /root/.claude/settings.json

COPY <<'SERVER' /app/server.js
const http = require('http');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

let ptyProc = null;
let outputBuf = '';
const sseClients = new Set();

function sseWrite(res, msg) {
  try { res.write('data: ' + JSON.stringify(msg) + '\n\n'); } catch(_) {}
}

function broadcast(msg) {
  for (const c of sseClients) sseWrite(c, msg);
}

function checkCreds() {
  if (fs.existsSync(CRED_PATH)) {
    try { broadcast({ type: 'creds', data: fs.readFileSync(CRED_PATH, 'utf8') }); } catch(_) {}
  }
}

function startLogin() {
  outputBuf = '';
  if (ptyProc) { try { ptyProc.kill(); } catch(_) {} ptyProc = null; }

  ptyProc = pty.spawn('claude', ['login'], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: '/',
    env: { ...process.env }
  });

  ptyProc.onData(data => {
    outputBuf += data;
    broadcast({ type: 'data', data });
    checkCreds();
  });

  ptyProc.onExit(({ exitCode }) => {
    const msg = '\r\n[claude login exited: ' + exitCode + ']\r\n';
    outputBuf += msg;
    broadcast({ type: 'data', data: msg });
    checkCreds();
  });
}

startLogin();

const HTML = '<!DOCTYPE html>\n\
<html>\n\
<head>\n\
  <meta charset="utf-8">\n\
  <title>Claude Auth</title>\n\
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">\n\
  <style>\n\
    *{box-sizing:border-box}\n\
    html,body{height:100%;margin:0;padding:0;background:#1a1a1a;color:#ddd;font-family:monospace}\n\
    body{display:flex;flex-direction:column;padding:16px;gap:8px}\n\
    h2{color:#a78bfa;margin:0}\n\
    .note{color:#fbbf24;font-size:13px;margin:0}\n\
    #status{font-size:12px;color:#888}\n\
    #tc{flex:1;min-height:400px;border:1px solid #444;border-radius:4px;overflow:hidden}\n\
    .creds{background:#0a1f0a;border:2px solid #22c55e;padding:16px;border-radius:4px}\n\
    .creds pre{color:#22c55e;white-space:pre-wrap;word-break:break-all;margin:8px 0;font-size:13px;background:#000;padding:12px;border-radius:3px}\n\
    .btn{margin-top:10px;padding:8px 18px;background:#7c3aed;color:#fff;border:none;cursor:pointer;border-radius:4px;font-size:14px}\n\
    .btn:hover{background:#6d28d9}\n\
    .btn+.btn{margin-left:8px}\n\
  </style>\n\
</head>\n\
<body>\n\
  <h2>Claude Auth</h2>\n\
  <p class="note">Interactive terminal — use arrow keys + Enter to select a theme, then follow the login prompts.</p>\n\
  <div id="status">Connecting...</div>\n\
  <div id="tc"></div>\n\
  <div id="creds" style="display:none" class="creds">\n\
    <strong style="color:#22c55e">&#10003; Login complete!</strong><br>\n\
    Copy the JSON below and set as <code>CLAUDE_CREDENTIALS_JSON</code> in Railway (Paperclip service), then redeploy Paperclip.\n\
    <pre id="cj"></pre>\n\
    <button class="btn" id="copybtn">Copy to clipboard</button>\n\
    <button class="btn" onclick="location.href=\'/restart\'">Restart login</button>\n\
  </div>\n\
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>\n\
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>\n\
  <script>\n\
    var term = new Terminal({theme:{background:"#000"},cursorBlink:true,fontSize:14,scrollback:2000});\n\
    var fit = new FitAddon.FitAddon();\n\
    term.loadAddon(fit);\n\
    term.open(document.getElementById("tc"));\n\
    requestAnimationFrame(function(){ fit.fit(); term.focus(); });\n\
    window.addEventListener("resize", function(){ fit.fit(); });\n\
\n\
    var statusEl = document.getElementById("status");\n\
    var es = new EventSource("/events");\n\
    es.onopen = function(){ statusEl.textContent = "Connected"; statusEl.style.color = "#22c55e"; };\n\
    es.onerror = function(){ statusEl.textContent = "Connection error — reload to retry"; statusEl.style.color = "#f87171"; };\n\
    es.onmessage = function(e){\n\
      var m = JSON.parse(e.data);\n\
      if(m.type==="data"||m.type==="history"){ term.write(m.data); }\n\
      else if(m.type==="creds"){\n\
        document.getElementById("cj").textContent = m.data;\n\
        document.getElementById("creds").style.display = "block";\n\
        document.getElementById("copybtn").onclick = function(){\n\
          navigator.clipboard.writeText(m.data).then(function(){ document.getElementById("copybtn").textContent="Copied!"; });\n\
        };\n\
      }\n\
    };\n\
\n\
    term.onData(function(d){\n\
      fetch("/input", {method:"POST", body:d, headers:{"Content-Type":"application/octet-stream"}});\n\
    });\n\
  </script>\n\
</body>\n\
</html>';

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n'); // initial comment to open the connection
    if (outputBuf) sseWrite(res, { type: 'history', data: outputBuf });
    checkCreds();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && req.url === '/input') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if (ptyProc) ptyProc.write(body);
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (req.url === '/restart') {
    startLogin();
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
}).listen(PORT, () => console.log('Claude auth terminal on port ' + PORT));
SERVER

ENV NODE_NO_WARNINGS=1
CMD ["node", "/app/server.js"]
