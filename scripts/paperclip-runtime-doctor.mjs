#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args = [], options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 8000,
      env: { ...process.env, ...options.env },
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stdout ?? '').trim(),
      error: String(error.stderr ?? error.message ?? '').trim(),
      status: error.status ?? null,
    };
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

function printCheck(name, state, details = '') {
  const suffix = details ? ` — ${details}` : '';
  console.log(`- ${name}: ${state}${suffix}`);
}

function urlHasCredentials(raw) {
  try {
    const parsed = new URL(raw);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /(https?:\/\/)[^\s/@:]+(:[^\s/@]*)?@/i.test(raw);
  }
}

async function fetchHealth(url) {
  if (urlHasCredentials(url)) {
    return { ok: false, status: 'skipped', snippet: 'URL contains credentials' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      snippet: healthSummary(text),
    };
  } catch (error) {
    return { ok: false, status: 'error', snippet: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(command, args) {
  const result = run(command, args);
  if (!result.ok || !result.output) return null;
  try {
    return JSON.parse(result.output);
  } catch {
    return null;
  }
}

function sanitizeUrl(raw) {
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = '<redacted>';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return raw.replace(/(https?:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi, '$1<redacted>@');
  }
}

function healthSummary(text) {
  try {
    const json = JSON.parse(text);
    const allowed = ['status', 'deploymentMode', 'bootstrapStatus', 'bootstrapInviteActive'];
    const summary = Object.fromEntries(allowed.filter((key) => key in json).map((key) => [key, json[key]]));
    if (Object.keys(summary).length) return JSON.stringify(summary);
  } catch {
    // Fall through to a content-free response summary.
  }
  const normalized = text.trim();
  return normalized ? `body ${normalized.length} chars` : 'empty body';
}

section('Git');
const status = run('git', ['status', '--short', '--branch']);
printCheck('status', status.ok ? 'ok' : 'error', status.output || status.error);
const head = run('git', ['rev-parse', '--short=12', 'HEAD']);
const branch = run('git', ['branch', '--show-current']);
const remote = run('git', ['remote', 'get-url', 'origin']);
printCheck('branch', branch.ok ? branch.output : 'unknown', `HEAD ${head.output || 'unknown'}`);
printCheck('origin', remote.ok ? 'ok' : 'error', sanitizeUrl(remote.output) || remote.error);
const aheadBehind = run('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/master']);
printCheck('origin/master drift', aheadBehind.ok ? 'ok' : 'unknown', aheadBehind.output || aheadBehind.error);

section('GitHub');
const repoView = safeJson('gh', ['repo', 'view', 'TheThomais/paperclip', '--json', 'nameWithOwner,visibility,isPrivate,defaultBranchRef']);
if (repoView) {
  printCheck('repo', 'ok', `${repoView.nameWithOwner}, ${repoView.visibility}, default ${repoView.defaultBranchRef?.name ?? 'unknown'}`);
} else {
  printCheck('repo', 'unknown', 'gh repo view failed or gh unavailable');
}
const prs = safeJson('gh', ['pr', 'list', '--repo', 'TheThomais/paperclip', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url']);
if (Array.isArray(prs)) {
  printCheck('open PRs', prs.length === 0 ? 'clean' : 'attention', prs.length === 0 ? 'none' : prs.map((pr) => `#${pr.number} ${pr.headRefName}`).join('; '));
} else {
  printCheck('open PRs', 'unknown', 'gh pr list failed or gh unavailable');
}

section('Local runtime');
const tsxCli = `${repoRoot}/cli/node_modules/tsx/dist/cli.mjs`;
if (existsSync(tsxCli)) {
  const devList = run('node', [tsxCli, 'scripts/dev-service.ts', 'list'], { timeout: 10000 });
  printCheck('dev services', devList.ok ? 'ok' : 'unknown', devList.output || devList.error || 'no output');
} else {
  printCheck('dev services', 'skipped', 'cli/node_modules/tsx is not installed in this checkout; run pnpm install before using dev service commands');
}
const dockerPs = run('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'], { timeout: 10000 });
if (dockerPs.ok) {
  const lines = dockerPs.output.split('\n').filter(Boolean);
  const paperclipLines = lines.filter((line) => /paperclip|hermes|traefik/i.test(line));
  printCheck('containers', paperclipLines.length ? 'ok' : 'none', paperclipLines.join(' | ') || 'no paperclip/hermes/traefik containers found');
} else {
  printCheck('containers', 'unknown', dockerPs.error || dockerPs.output || 'docker unavailable');
}
const bridge = run('systemctl', ['is-active', 'thomas-hermes-bridge.service']);
printCheck('Thomas bridge service', bridge.ok ? bridge.output : 'unknown', bridge.error || '');

section('Health endpoints');
const urls = [
  process.env.PAPERCLIP_PUBLIC_URL && `${process.env.PAPERCLIP_PUBLIC_URL.replace(/\/$/, '')}/api/health`,
  'https://paperclip-vqnh.onrender.com/api/health',
  'http://127.0.0.1:3100/api/health',
  'http://127.0.0.1:3101/api/health',
].filter(Boolean);
for (const url of urls) {
  const result = await fetchHealth(url);
  printCheck(sanitizeUrl(url), result.ok ? 'ok' : 'not-ready', `${result.status}; ${result.snippet}`);
  await sleep(50);
}

section('Expected deployment contract');
printCheck('Render repo/branch', existsSync(`${repoRoot}/render.yaml`) ? 'declared' : 'missing', 'TheThomais/paperclip master, /api/health, PORT=3100');
printCheck('VPS mode', 'readback', 'Thomas bridge may run on VPS while Paperclip app can be Render-hosted; local Paperclip server is optional unless explicitly started.');
