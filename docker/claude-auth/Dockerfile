# syntax=docker/dockerfile:1.20
FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest

# Pre-seed settings so Claude skips the first-run theme wizard
RUN mkdir -p /root/.claude && \
    printf '{"theme":"dark","hasCompletedOnboarding":true,"onboardingVersion":5}\n' \
    > /root/.claude/settings.json

COPY <<'SERVER' /server.js
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

let lines = [];
let proc = null;
let done = false;

function strip(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function startLogin() {
  lines.push('[Starting claude login...]\n');
  proc = spawn('claude', ['login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
  });

  proc.stdout.on('data', d => { lines.push(strip(d.toString())); });
  proc.stderr.on('data', d => { lines.push(strip(d.toString())); });

  proc.on('exit', code => {
    lines.push(`\n[claude login exited: ${code}]\n`);
    if (fs.existsSync(CRED_PATH)) {
      const c = fs.readFileSync(CRED_PATH, 'utf8');
      lines.push('\n__CREDS__\n' + c + '\n__CREDS__\n');
      done = true;
    }
  });
}

startLogin();

function submitCode(code) {
  if (proc && proc.stdin.writable) {
    proc.stdin.write(code.trim() + '\n');
    lines.push(`[Submitted code]\n`);
  }
}

const HTML = (body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Claude Auth</title>
<meta http-equiv="refresh" content="4">
<style>
  body{font-family:monospace;background:#111;color:#ddd;padding:24px;max-width:900px;margin:0 auto}
  h2{color:#a78bfa}
  pre{background:#000;padding:16px;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow-y:auto;border:1px solid #333;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:10px;font-size:15px;background:#000;color:#ddd;border:1px solid #555;margin-bottom:12px}
  button{padding:10px 24px;background:#7c3aed;color:#fff;border:none;cursor:pointer;font-size:15px;border-radius:4px}
  .ok{border:2px solid #22c55e;padding:16px;margin-top:16px;background:#0a1f0a}
  .ok pre{max-height:none}
  .step{color:#fbbf24;margin:4px 0}
</style></head><body>${body}</body></html>`;

http.createServer((req, res) => {
  // Handle code submission
  if (req.method === 'POST' && req.url === '/code') {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => {
      const code = new URLSearchParams(b).get('code') || '';
      submitCode(code);
      res.writeHead(302, { Location: '/' });
      res.end();
    });
    return;
  }

  // Handle restart
  if (req.url === '/restart') {
    lines = [];
    done = false;
    if (proc) try { proc.kill(); } catch(_) {}
    startLogin();
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });

  const all = lines.join('');
  const credsMatch = all.match(/__CREDS__\n([\s\S]+?)\n__CREDS__/);
  const output = all.replace(/__CREDS__[\s\S]*__CREDS__/g, '').trim();

  const urlMatch = output.match(/https:\/\/claude\.ai\/[^\s\n"]+/);
  const url = urlMatch ? urlMatch[0] : null;

  if (credsMatch) {
    res.end(HTML(`
      <h2>✓ Claude Login Complete</h2>
      <div class="ok">
        <strong style="color:#22c55e">Copy the JSON below and set it as <code>CLAUDE_CREDENTIALS_JSON</code> in Railway:</strong>
        <pre>${credsMatch[1].replace(/</g,'&lt;')}</pre>
      </div>
      <p>Then remove <code>CLAUDE_CODE_OAUTH_TOKEN</code> if set, and redeploy the Paperclip service.</p>
      <p><a href="/restart" style="color:#a78bfa">Restart login</a></p>
    `));
    return;
  }

  res.end(HTML(`
    <h2>Claude Auth Helper</h2>
    <p class="step">Auto-refreshes every 4s — page will update as Claude outputs the login URL.</p>

    ${url ? `
    <p style="margin:12px 0"><strong>Step 1:</strong>
      <a href="${url}" target="_blank" style="color:#60a5fa;word-break:break-all">${url}</a>
    </p>
    <p class="step">Step 2: Authorize in your browser. If it shows a code instead of redirecting, paste it below.</p>
    <form method="POST" action="/code">
      <input name="code" placeholder="Paste the code shown by your browser here (if prompted)" autofocus>
      <button type="submit">Submit Code</button>
    </form>
    ` : `<p class="step">Waiting for Claude to print the login URL…</p>`}

    <h3>Claude output:</h3>
    <pre>${output.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
    <p><a href="/restart" style="color:#a78bfa">Restart login</a></p>
  `));
}).listen(PORT, () => console.log(`Claude auth helper on port ${PORT}`));
SERVER

ENV NODE_NO_WARNINGS=1
CMD ["node", "/server.js"]
