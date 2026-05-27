import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from './repo-root.ts';
import { defaultChromeBin, isChromeRunning, xspawnSync, WHICH, IS_WIN, QUIT_CHROME_HINT } from './cross-platform.ts';
import { createBrowser, type Browser } from './browser.ts';

const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'designer-loop', 'SKILL.md');
const SKILL_DEST_DIR = path.join(os.homedir(), '.claude', 'skills', 'designer-loop');
const SKILL_DEST = path.join(SKILL_DEST_DIR, 'SKILL.md');
const CHROME_BIN = process.env.CHROME_BIN || defaultChromeBin();
const PROFILE = process.env.DESIGNER_CHROME_PROFILE || path.join(os.homedir(), '.chrome-designer-profile');

const _RUN_DIR = process.env.DESIGNER_RUN_DIR;
function resolveCdpUrl(): string {
  if (process.env.DESIGNER_CDP_URL) return process.env.DESIGNER_CDP_URL;
  if (_RUN_DIR) {
    try {
      const fromFile = fs.readFileSync(path.join(_RUN_DIR, 'cdp-url'), 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {}
  }
  // Legacy desktop default
  return `http://127.0.0.1:${process.env.DESIGNER_CDP || '9222'}`;
}
const DEFAULT_CDP_URL = resolveCdpUrl();
// Extract port for Chrome --remote-debugging-port and error messages
const DEFAULT_PORT = (() => { try { return new URL(DEFAULT_CDP_URL).port || '9222'; } catch { return process.env.DESIGNER_CDP || '9222'; } })();

type Status = 'ok' | 'wait' | 'fail';

function log(stage: string, status: Status, msg: string): void {
  const icon = status === 'ok' ? '✓' : status === 'wait' ? '·' : '✗';
  console.log(`${icon} [${stage}] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isCdpUp(cdpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function verifySignedIn(browser: Browser): Promise<boolean> {
  // A signed-in claude.ai/design session renders one of these app-shell
  // anchors — `project-creator` on the home surface, `chat-composer-input`
  // inside a project. A logged-out visit to claude.ai/design renders a
  // login wall with neither.
  //
  // This replaces the old URL-only check (URL matches /design && !/login/).
  // That check passed the login wall served AT the /design URL — the URL
  // stays `/design` when logged out, no `/login` substring — which is the
  // #16 false positive. The DOM is the only reliable signal.
  const js =
    '!!(document.querySelector(\'[data-testid="project-creator"]\') || document.querySelector(\'[data-testid="chat-composer-input"]\'))';
  return browser.evalValue<boolean>(js).catch(() => false);
}

function chromeRunning(): boolean {
  return isChromeRunning();
}

type ProfileStatus = 'match' | 'mismatch' | 'unknown';

function cdpChromeProfileStatus(port: string): ProfileStatus {
  // Does the Chrome bound to this CDP port use OUR profile (PROFILE)?
  //
  // We deliberately do NOT try to parse an arbitrary --user-data-dir value
  // out of `ps`'s output: ps renders the command line flat and unquoted, so
  // a `/(\S+)/` capture truncates any path containing a space (e.g. a macOS
  // home dir like `/Users/First Last/...`) and yields a false mismatch.
  // Instead, since PROFILE is known, test for that exact path as a complete
  // token. Returns 'unknown' when there's no Chrome / no --user-data-dir /
  // ps failed; callers treat 'unknown' like 'match' (adopt-ok) because
  // step4's DOM-marker check is the backstop.
  if (!/^\d+$/.test(port)) return 'unknown';
  const r = spawnSync(
    'sh',
    ['-c', `ps -Axww -o command | grep -- '--remote-debugging-port=${port}' | grep -v grep`],
    { stdio: 'pipe' }
  );
  if (r.status !== 0) return 'unknown';
  const out = r.stdout?.toString() ?? '';
  if (!out.includes('--user-data-dir=')) return 'unknown';
  // Literal match of PROFILE with a trailing boundary (space = next flag/URL,
  // or end of line). Escaping handles regex metacharacters in the path.
  const escaped = PROFILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`--user-data-dir=${escaped}(?= |$)`, 'm').test(out) ? 'match' : 'mismatch';
}

async function pollUntil(
  name: string,
  fn: () => Promise<boolean> | boolean,
  opts: { intervalMs: number; timeoutMs: number; reminder: string; hint60s?: string }
): Promise<boolean> {
  const start = Date.now();
  let emittedReminder = false;
  let emittedHint = false;
  let dots = 0;
  while (Date.now() - start < opts.timeoutMs) {
    if (await fn()) {
      if (dots > 0) process.stdout.write('\n');
      return true;
    }
    const elapsed = Date.now() - start;
    if (!emittedReminder) {
      log(name, 'wait', opts.reminder);
      emittedReminder = true;
    } else {
      process.stdout.write('.');
      dots++;
    }
    if (!emittedHint && opts.hint60s && elapsed > 60_000) {
      process.stdout.write('\n');
      dots = 0;
      log(name, 'wait', opts.hint60s);
      emittedHint = true;
    }
    await sleep(opts.intervalMs);
  }
  if (dots > 0) process.stdout.write('\n');
  return false;
}

function lockfileHash(p: string): string | null {
  try {
    return createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

async function step1NpmInstall(): Promise<boolean> {
  const nm = path.join(REPO_ROOT, 'node_modules');
  const rootLock = path.join(REPO_ROOT, 'package-lock.json');
  const innerLock = path.join(nm, '.package-lock.json');
  // Installed mode: shipped tarball has no package-lock.json. Bun/pnpm/npx
  // resolve deps outside the package dir, so don't inspect node_modules here —
  // if we got this far, the package manager has done its job.
  if (!fs.existsSync(rootLock)) {
    log('deps', 'ok', 'installed-mode');
    return true;
  }
  if (fs.existsSync(nm)) {
    const a = lockfileHash(rootLock);
    const b = lockfileHash(innerLock);
    if (a && b && a === b) {
      log('deps', 'ok', 'node_modules in sync with package-lock');
      return true;
    }
    log('deps', 'wait', b ? 'lockfile mismatch; reinstalling...' : 'no inner lockfile; reinstalling to sync...');
  } else {
    log('deps', 'wait', 'running npm install...');
  }
  const r = xspawnSync('npm', ['install'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    log('deps', 'fail', `npm install exited ${r.status}`);
    return false;
  }
  log('deps', 'ok', 'installed');
  return true;
}

function step2AgentBrowser(): boolean {
  const r = xspawnSync('agent-browser', ['--version'], { stdio: 'pipe' });
  if (r.status !== 0) {
    log('agent-browser', 'fail', 'not found on PATH. Install: npm i -g agent-browser');
    return false;
  }
  log('agent-browser', 'ok', r.stdout?.toString().trim() || 'present');
  return true;
}

async function step3Chrome(cdpUrl: string, port: string): Promise<boolean> {
  if (await isCdpUp(cdpUrl)) {
    // CDP being reachable doesn't prove it's OUR debug Chrome. Adopt only
    // when the profile matches (or can't be determined — step4's DOM-marker
    // check backstops that case).
    const profileStatus = cdpChromeProfileStatus(port);
    if (profileStatus !== 'mismatch') {
      log('chrome', 'ok', `CDP already up on :${port}${profileStatus === 'match' ? ' (profile matches)' : ''}`);
      return true;
    }
    // A debug Chrome on this port under a different --user-data-dir can't be
    // adopted — sign-in would land in the wrong profile. Don't bail outright:
    // mirror the non-debug-Chrome branch below — ask the user to quit it,
    // poll, then fall through and launch one with the right profile.
    log(
      'chrome',
      'wait',
      `A debug Chrome is on :${port} with a different --user-data-dir (expected ${PROFILE}).\n` +
        `   Quit it — I'll launch one with the right profile once it's gone. (Or set DESIGNER_CDP to a free port.)`
    );
    const freed = await pollUntil('chrome', async () => !(await isCdpUp(cdpUrl)), {
      intervalMs: 1000,
      timeoutMs: 5 * 60_000,
      reminder: `Still waiting for the wrong-profile debug Chrome on :${port} to quit.`
    });
    if (!freed) {
      log('chrome', 'fail', `Timed out waiting for the debug Chrome on :${port} to quit. Quit it manually, then re-run setup.`);
      return false;
    }
    // fall through to the launch path
  }
  if (chromeRunning()) {
    log('chrome', 'wait', `A non-debug Chrome is running. ${QUIT_CHROME_HINT} I am polling.`);
    const quit = await pollUntil('chrome', () => !chromeRunning(), {
      intervalMs: 1000,
      timeoutMs: 5 * 60_000,
      reminder: `Still waiting for Chrome to fully quit. ${QUIT_CHROME_HINT}`
    });
    if (!quit) {
      log('chrome', 'fail', 'Timed out waiting for Chrome to quit. Quit manually then re-run setup.');
      return false;
    }
  }
  log('chrome', 'wait', `Launching debug Chrome on :${port} with --user-data-dir=${PROFILE}`);
  if (!fs.existsSync(CHROME_BIN)) {
    log('chrome', 'fail', `Chrome not found at ${CHROME_BIN}. Set CHROME_BIN to override.`);
    return false;
  }
  const child = spawn(CHROME_BIN, ['--remote-debugging-port=' + port, '--user-data-dir=' + PROFILE, 'https://claude.ai/design'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  const up = await pollUntil('chrome', () => isCdpUp(cdpUrl), {
    intervalMs: 800,
    timeoutMs: 30_000,
    reminder: `Waiting for CDP at :${port}...`
  });
  if (!up) {
    const fallback = IS_WIN ? 'scripts\\designer-chrome.ps1' : './scripts/designer-chrome.sh';
    log('chrome', 'fail', `Chrome launched but CDP did not come up. Try \`${fallback}\` manually.`);
    return false;
  }
  log('chrome', 'ok', `CDP up on :${port}`);
  return true;
}

async function step4SignIn(port: string): Promise<boolean> {
  const browser = createBrowser({ session: 'designer-setup', cdp: port });
  // Normalize: the adopted Chrome's tab could be anywhere (about:blank, a
  // stale page, a project). Land it on the design home so the poll has a
  // consistent surface, then let the SPA paint before the first check.
  await browser.open('https://claude.ai/design').catch(() => undefined);
  await sleep(2500);

  // pollUntil checks the predicate before emitting any reminder — so an
  // already-signed-in session returns true on the first iteration and the
  // user never sees the sign-in prompt.
  const ok = await pollUntil('login', () => verifySignedIn(browser), {
    intervalMs: 2000,
    timeoutMs: 10 * 60_000,
    reminder:
      'Sign in to Claude in the DEBUG Chrome window I just opened (a separate window with no extensions/bookmarks — NOT your normal Chrome; the two have separate cookie jars). Then return to claude.ai/design. I am polling.',
    hint60s: "If Chrome shows a Google 'new device' or 2FA prompt, complete that first — setup is waiting on you."
  });
  if (!ok) {
    log('login', 'fail', 'Timed out waiting for a signed-in claude.ai/design session. Re-run setup when ready.');
    return false;
  }
  const url = (await browser.url().catch(() => '')) || 'claude.ai/design';
  log('login', 'ok', `Signed in. Tab on ${url.replace(/\?.*$/, '')}`);
  return true;
}

function step5Skill(): boolean {
  if (fs.existsSync(SKILL_DEST)) {
    let detail = `Already at ${SKILL_DEST}`;
    try {
      if (fs.lstatSync(SKILL_DEST_DIR).isSymbolicLink()) {
        detail = `Already at ${SKILL_DEST_DIR} → ${fs.realpathSync(SKILL_DEST_DIR)} (bootstrap-managed, leaving alone)`;
      }
    } catch {}
    log('skill', 'ok', detail);
    return true;
  }
  if (!fs.existsSync(SKILL_SRC)) {
    log('skill', 'fail', `Source missing at ${SKILL_SRC}; reclone repo?`);
    return false;
  }
  fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
  fs.copyFileSync(SKILL_SRC, SKILL_DEST);
  log('skill', 'ok', `Copied to ${SKILL_DEST}`);
  return true;
}

function step6Mcp(port: string): boolean {
  const claudeBin = xspawnSync(WHICH, ['claude'], { stdio: 'pipe' });
  if (claudeBin.status !== 0) {
    log('mcp', 'wait', 'claude CLI not on PATH; skipping MCP registration. Install Claude Code to register.');
    return true;
  }
  const list = xspawnSync('claude', ['mcp', 'list'], { stdio: 'pipe' });
  const stdout = list.stdout?.toString() || '';
  if (/(\s|^)designer\b/i.test(stdout)) {
    log('mcp', 'ok', 'Already registered.');
    return true;
  }
  // Register by command name (claude resolves via PATH; on Windows that's the
  // npm-generated .cmd shim, on macOS/Linux the symlinked node script). This
  // avoids encoding the absolute file path of a bash wrapper into the MCP
  // config — which would break on Windows entirely.
  //
  // claude mcp add supports `-e KEY=VALUE` for env vars, which works on every
  // OS — replaces the Unix-only `env DESIGNER_CDP=X` prefix the prior version
  // used. We only emit it when the port is non-default to keep the config tidy.
  const envFlags = port === '9222' ? [] : ['-e', `DESIGNER_CDP=${port}`];
  const cmd = ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', ...envFlags, 'designer', '--', 'designer', 'mcp', 'serve'];
  log('mcp', 'wait', `Registering: claude ${cmd.join(' ')}`);
  const reg = xspawnSync('claude', cmd, { stdio: 'inherit' });
  if (reg.status !== 0) {
    log('mcp', 'fail', `claude mcp add exited ${reg.status}. Run manually:\n   claude ${cmd.join(' ')}`);
    return false;
  }
  log('mcp', 'ok', 'Registered.');
  return true;
}

export async function runSetup(): Promise<number> {
  console.log(`designer setup — port=${DEFAULT_PORT}, profile=${PROFILE}\n`);

  if (!(await step1NpmInstall())) return 1;
  if (!step2AgentBrowser()) return 1;
  if (!(await step3Chrome(DEFAULT_CDP_URL, DEFAULT_PORT))) return 1;
  if (!(await step4SignIn(DEFAULT_PORT))) return 1;
  if (!step5Skill()) return 1;
  if (!step6Mcp(DEFAULT_PORT)) return 1;

  console.log('\n✓ designer is ready. Verify:  designer doctor');
  console.log(`  (or: DESIGNER_CDP=${DEFAULT_PORT} tsx cli.ts doctor)`);
  if (!process.env.DESIGNER_CDP) {
    console.log(`\nTip: export DESIGNER_CDP=${DEFAULT_PORT} in your shell rc if you'll invoke the CLI directly (MCP callers don't need this).`);
  }
  return 0;
}
