# syntax=docker/dockerfile:1.20
FROM node:lts-alpine

# Build tools needed to compile node-pty native module
RUN apk add --no-cache python3 make g++ linux-headers && \
    npm install -g @anthropic-ai/claude-code@latest

# Install server dependencies (node-pty compiles a native addon here)
WORKDIR /app
RUN npm init -y && npm install node-pty ws

# Pre-seed settings so Claude skips the first-run theme wizard
RUN mkdir -p /root/.claude && \
    printf '{"theme":"dark","hasCompletedOnboarding":true,"onboardingVersion":5}\n' \
    > /root/.claude/settings.json

COPY <<'SERVER' /app/server.js
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

let ptyProc = null;
let outputBuf = '';
const clients = new Set();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
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
    const msg = `\r\n[claude login exited: ${exitCode}]\r\n`;
    outputBuf += msg;
    broadcast({ type: 'data', data: msg });
    checkCreds();
  });
}

startLogin();

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Auth</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
  <style>
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;padding:0;background:#1a1a1a;color:#ddd;font-family:monospace}
    body{display:flex;flex-direction:column;padding:16px;gap:10px}
    h2{color:#a78bfa;margin:0}
    .note{color:#fbbf24;font-size:13px;margin:0}
    #status{font-size:12px;color:#888}
    #status.ok{color:#22c55e}
    #status.err{color:#f87171}
    #tc{flex:1;min-height:500px;border:1px solid #444;border-radius:4px;overflow:hidden}
    .creds{background:#0a1f0a;border:2px solid #22c55e;padding:16px;border-radius:4px}
    .creds pre{color:#22c55e;white-space:pre-wrap;word-break:break-all;margin:8px 0;font-size:13px;background:#000;padding:12px;border-radius:3px}
    .btn{margin-top:10px;padding:8px 18px;background:#7c3aed;color:#fff;border:none;cursor:pointer;border-radius:4px;font-size:14px}
    .btn:hover{background:#6d28d9}
    .btn+.btn{margin-left:8px}
  </style>
</head>
<body>
  <h2>Claude Auth</h2>
  <p class="note">Interactive terminal &mdash; use arrow keys + Enter to pick a theme, then follow the login prompts.</p>
  <div id="status">Connecting...</div>
  <div id="tc"></div>
  <div id="creds" style="display:none" class="creds">
    <strong style="color:#22c55e">&#10003; Login complete!</strong><br>
    Copy the JSON below &rarr; set as <code>CLAUDE_CREDENTIALS_JSON</code> in Railway (Paperclip service), then redeploy Paperclip.
    <pre id="cj"></pre>
    <button class="btn" id="copybtn" onclick="navigator.clipboard.writeText(document.getElementById('cj').textContent).then(()=>document.getElementById('copybtn').textContent='Copied!')">Copy to clipboard</button>
    <button class="btn" onclick="location.href='/restart'">Restart login</button>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const statusEl = document.getElementById('status');
    const tc = document.getElementById('tc');

    const term = new Terminal({
      theme:{background:'#000000',foreground:'#dddddd'},
      cursorBlink:true,
      fontSize:14,
      fontFamily:'"Cascadia Code","Fira Mono",monospace',
      scrollback:2000
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(tc);
    // Give the DOM a tick to lay out before fitting
    requestAnimationFrame(() => { fit.fit(); term.focus(); });

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = () => {
      statusEl.textContent = 'Connected';
      statusEl.className = 'ok';
      ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'data' || m.type === 'history') {
        term.write(m.data);
      } else if (m.type === 'creds') {
        document.getElementById('cj').textContent = m.data;
        document.getElementById('creds').style.display = 'block';
      }
    };
    ws.onerror = () => { statusEl.textContent = 'WebSocket error'; statusEl.className = 'err'; };
    ws.onclose = () => {
      statusEl.textContent = 'Disconnected — reload to reconnect';
      statusEl.className = 'err';
      term.writeln('\r\n\r\n[Disconnected — reload to reconnect]');
    };

    term.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({type:'data',data:d})); });
    term.onResize(({cols,rows}) => { if (ws.readyState === 1) ws.send(JSON.stringify({type:'resize',cols,rows})); });
    window.addEventListener('resize', () => { fit.fit(); });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/restart') {
    startLogin();
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  clients.add(ws);
  if (outputBuf) ws.send(JSON.stringify({ type: 'history', data: outputBuf }));
  checkCreds();
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'data' && ptyProc) ptyProc.write(m.data);
      else if (m.type === 'resize' && ptyProc) ptyProc.resize(m.cols, m.rows);
    } catch(_) {}
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => console.log('Claude auth terminal on port ' + PORT));
SERVER

ENV NODE_NO_WARNINGS=1
CMD ["node", "/app/server.js"]
