import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// Drop-in replacements for `child_process.spawn` / `spawnSync`.
//
// On Windows, npm-installed CLIs are `<name>.cmd` shims (sometimes `.ps1`)
// that Node ≥ 21 refuses to spawn directly (security policy: `EINVAL`), and
// that misbehave under `shell: true` when args contain shell metacharacters
// (parens, quotes, redirects — common in JS code passed to `agent-browser eval`).
//
// `cross-spawn` resolves shim paths and invokes them via `cmd /c` with proper
// argv quoting. Used by 100M+ npm packages; this is the standard fix.
//
// On macOS/Linux it's a passthrough to `child_process` — no behavior change.
export const xspawn = crossSpawn;
export const xspawnSync = crossSpawn.sync;

// Returns the `which` / `where` command name for the current OS.
export const WHICH = IS_WIN ? 'where' : 'which';

// Default Chrome binary path per OS. Override with the CHROME_BIN env var.
export function defaultChromeBin(): string {
  if (IS_WIN) {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    return candidates[0] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  if (IS_MAC) return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(c)) return c;
  }
  return '/usr/bin/google-chrome';
}

// Cross-platform "is a non-debug Chrome currently running?" check.
export function isChromeRunning(): boolean {
  if (IS_WIN) {
    const r = nodeSpawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV'], { stdio: 'pipe' });
    if (r.status !== 0) return false;
    const out = r.stdout?.toString() || '';
    return out.toLowerCase().includes('chrome.exe');
  }
  if (IS_MAC) {
    const r = nodeSpawnSync('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'], { stdio: 'pipe' });
    return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
  }
  const r = nodeSpawnSync('pgrep', ['-f', 'chrome'], { stdio: 'pipe' });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

// User-friendly "press X to quit Chrome" hint per OS.
export const QUIT_CHROME_HINT = IS_WIN
  ? 'Close all Chrome windows (or end chrome.exe in Task Manager).'
  : IS_MAC
    ? 'Cmd+Q on the Chrome menu, then close Activity Monitor entries if any.'
    : 'Close all Chrome windows or `pkill chrome`.';

// Re-export node's native spawn for callers that explicitly need it
// (e.g. spawning Chrome itself, where path is fully resolved already).
export { nodeSpawn, nodeSpawnSync };
