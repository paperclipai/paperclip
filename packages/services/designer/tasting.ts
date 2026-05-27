import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { IS_WIN, IS_MAC, xspawn, xspawnSync } from './cross-platform.ts';

// Pick an available Python launcher for this OS.
// Windows ships with `py` (the launcher) and may have `python` in PATH.
// macOS/Linux typically have `python3`.
function findPython(): string | null {
  const candidates = IS_WIN ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = xspawnSync(c, ['--version'], { stdio: 'pipe' });
    if (r.status === 0) return c;
  }
  return null;
}

// Cross-platform "open this URL in the user's default browser".
function openUrl(url: string): void {
  if (IS_WIN) {
    // `start` is a cmd built-in, not an exe — needs shell. The empty "" is the
    // window title positional that `start` consumes when the next arg is quoted.
    spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
  } else if (IS_MAC) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

export interface TastingOptions {
  projectDir: string;
  variants: Array<{ name: string; file: string }>;
  outPath?: string;
  title?: string;
}

export function writeTastingHtml({ projectDir, variants, outPath, title = 'Tasting' }: TastingOptions): string {
  const target = outPath || path.join(projectDir, 'tasting.html');
  const html = renderTastingHtml({ variants, title });
  fs.writeFileSync(target, html);
  return target;
}

function renderTastingHtml({ variants, title }: { variants: Array<{ name: string; file: string }>; title: string }): string {
  const tabs = variants
    .map(
      (v, i) =>
        `<button class="tab${i === 0 ? ' active' : ''}" data-src="${encodeURI(v.file)}">${escapeHtml(v.name)}</button>`
    )
    .join('');
  const firstSrc = variants[0] ? encodeURI(variants[0].file) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — tasting</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: #0f0f10; color: #e8e6e3; }
  .bar { position: fixed; top: 0; left: 0; right: 0; height: 44px; display: flex; align-items: center; gap: 0; padding: 0 12px; background: rgba(20,20,22,0.92); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.08); z-index: 9999; }
  .title { font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: #8a8680; margin-right: 18px; }
  .tabs { display: flex; gap: 2px; }
  .tab { appearance: none; border: 0; background: transparent; color: #b4b0a9; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; transition: color 120ms, border-color 120ms; }
  .tab:hover { color: #e8e6e3; }
  .tab.active { color: #ffffff; border-bottom-color: #ff8a3d; font-weight: 500; }
  .spacer { flex: 1; }
  .notes { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 10px; color: #e8e6e3; font: inherit; font-size: 13px; min-width: 280px; }
  .notes::placeholder { color: #6a665f; }
  .keys { font-size: 11px; color: #6a665f; margin-left: 12px; }
  iframe.stage { position: fixed; top: 44px; left: 0; right: 0; bottom: 0; width: 100%; height: calc(100% - 44px); border: 0; background: #fff; }
</style>
</head>
<body>
  <nav class="bar" role="toolbar" aria-label="Variant switcher">
    <span class="title">${escapeHtml(title)}</span>
    <div class="tabs">${tabs}</div>
    <span class="keys">[1]–[${variants.length}] to switch</span>
    <span class="spacer"></span>
    <input class="notes" placeholder="Reaction in your own words — saved to tasting-notes.txt" />
  </nav>
  <iframe class="stage" id="stage" src="${firstSrc}" title="variant"></iframe>
<script>
  const tabs = document.querySelectorAll('.tab');
  const stage = document.getElementById('stage');
  const notes = document.querySelector('.notes');
  const NOTES_KEY = 'designer-tasting-notes:${encodeURIComponent(title)}';
  const saved = localStorage.getItem(NOTES_KEY);
  if (saved) notes.value = saved;
  notes.addEventListener('input', () => localStorage.setItem(NOTES_KEY, notes.value));

  function activate(tab) {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    stage.src = tab.dataset.src;
  }
  function onKey(e) {
    if (e.target === notes) return;
    const n = parseInt(e.key, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= tabs.length) {
      e.preventDefault();
      activate(tabs[n - 1]);
    }
  }
  tabs.forEach(t => t.addEventListener('click', () => activate(t)));
  // Parent-document listener handles keys when focus is on the bar/notes/body.
  document.addEventListener('keydown', onKey);
  // Iframe content captures keys when the user has interacted with the variant.
  // Same-origin (we serve via http.server on the same port) so we can reach in.
  stage.addEventListener('load', () => {
    try { stage.contentDocument && stage.contentDocument.addEventListener('keydown', onKey); } catch {}
  });
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const servers = new Map<string, { port: number; pid: number }>();

export async function serveAndOpen(
  projectDir: string,
  { file = 'tasting.html', port }: { file?: string; port?: number } = {}
): Promise<{ url: string; port: number; pid: number }> {
  const chosenPort = port || (await pickFreePort(8765));
  const python = findPython();
  if (!python) {
    throw new Error('tasting requires Python 3. Install python3 (macOS/Linux) or Python 3 from python.org (Windows).');
  }
  const child: ChildProcess = xspawn(python, ['-m', 'http.server', String(chosenPort)], {
    cwd: projectDir,
    stdio: 'ignore',
    detached: true
  });
  child.unref();
  await sleep(500);
  const url = `http://127.0.0.1:${chosenPort}/${encodeURI(file)}`;
  openUrl(url);
  const pid = child.pid ?? -1;
  servers.set(projectDir, { port: chosenPort, pid });
  return { url, port: chosenPort, pid };
}

async function pickFreePort(start: number): Promise<number> {
  const net = await import('node:net');
  // Python's http.server binds 0.0.0.0 — test the same interface or
  // we'll miss a conflict with another python server already on *:port.
  for (let p = start; p < start + 100; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '0.0.0.0');
    });
    if (free) return p;
  }
  throw new Error(`No free port between ${start} and ${start + 100}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
