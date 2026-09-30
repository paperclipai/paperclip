import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SkillSourceScanProgress } from '@paperclipai/shared';
import { parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { unprocessable } from '../errors.js';
import { buildGitAuthInvocation } from './git-credentials.js';

export type GitSkillTreeEntry = { path: string; type: string; mode: string; sha: string; size?: number };
export interface GitSkillSnapshot {
  commitSha: string;
  entries: GitSkillTreeEntry[];
  readBlob: (entry: GitSkillTreeEntry, signal?: AbortSignal) => Promise<Buffer>;
  release: () => Promise<void>;
}
export interface GitSkillSnapshotOptions {
  signal?: AbortSignal;
  onDownload?: (progress: NonNullable<SkillSourceScanProgress['download']>) => void | Promise<void>;
}

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHED_SNAPSHOTS = 4;
const snapshots = new Map<string, { directory: string; commitSha: string; entries: GitSkillTreeEntry[]; users: number; expires: number; timer?: NodeJS.Timeout }>();
let activeDownloads = 0;

/** Only structured numeric progress crosses the process boundary; never forward stderr. */
export function parseGitDownloadProgress(line: string): NonNullable<SkillSourceScanProgress['download']> | null {
  const match = /(?:^|\s)(Receiving objects|Resolving deltas):\s+(\d{1,3})%[^\r\n]*/.exec(line);
  if (!match) return null;
  const size = /,\s*([\d.]+)\s+(bytes|KiB|MiB|GiB)(?:\s|\||,|$)/.exec(match[0]);
  return { stage: match[1] === 'Receiving objects' ? 'receiving' : 'resolving', percent: Math.min(100, Number(match[2])),
    ...(size ? { receivedBytes: Math.round(Number(size[1]) * ({ bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[size[2]!] ?? 1)) } : {}) };
}

function gitEnvironment(token: string) {
  // Do not inherit host Git config, credential helpers, tracing, object directories,
  // URL rewrites, or checkout filters. The existing host-scoped helper keeps tokens
  // in the child environment, never argv, remote URLs, or repository config.
  const authorization = buildGitAuthInvocation({ token, source: 'managed_connection', secretName: null }).env;
  // Public GitHub remotes need not issue a credential challenge. Send the chosen
  // caller's authorization proactively, scoped to GitHub with redirects disabled.
  const index = Number(authorization.GIT_CONFIG_COUNT);
  if (token) {
    authorization.GIT_CONFIG_COUNT = String(index + 1);
    authorization[`GIT_CONFIG_KEY_${index}`] = 'http.https://github.com/.extraHeader';
    authorization[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR,
    ...authorization,
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_NO_REPLACE_OBJECTS: '1',
  };
}

async function directoryBytes(directory: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) size += await directoryBytes(filename);
    else if (entry.isFile()) {
      try { size += (await stat(filename)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return size;
}

async function runGit(directory: string, args: string[], token: string, options: GitSkillSnapshotOptions & { download?: boolean; maxOutput?: number } = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'init.templateDir=', '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
    { cwd: directory, env: gitEnvironment(token), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = '', unfinishedLine = '';
    let failure: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    let sizeCheckRunning = false, closed = false;
    let latest: NonNullable<SkillSourceScanProgress['download']> | null = null;
    let reporting: Promise<void> | null = null;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error;
      if (closed) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => stop(unprocessable('Repository download timed out. Try again or use a smaller repository.')), 180_000);
    const monitor = options.download ? setInterval(() => {
      if (sizeCheckRunning) return;
      sizeCheckRunning = true;
      void directoryBytes(directory).then(size => { if (!closed && size > MAX_DOWNLOAD_BYTES) stop(unprocessable('Repository download exceeds the 128 MB limit. Use a smaller skills repository.')); })
        .catch(() => { if (!closed) stop(unprocessable('Could not read the downloaded repository. Try again.')); }).finally(() => { sizeCheckRunning = false; });
    }, 250) : undefined;
    const report = () => {
      if (reporting) return;
      reporting = (async () => {
        while (latest && !failure) {
          const progress = latest; latest = null;
          await options.onDownload?.(progress);
        }
      })().catch(stop).finally(() => { reporting = null; if (latest && !failure && !closed) report(); });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutput ?? MAX_TREE_BYTES)) stop(unprocessable('Repository contents exceed the scan limit. Use a smaller skills repository.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      const lines = (unfinishedLine + chunk.toString('utf8')).split(/[\r\n]/);
      unfinishedLine = lines.pop()!.slice(-4096);
      for (const line of lines) {
        const progress = parseGitDownloadProgress(line);
        if (progress) { latest = progress; report(); }
      }
    });
    child.on('error', error => { failure = unprocessable((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Git is required to import repositories. Install Git on the Paperclip server and try again.' : 'Could not start the repository download. Try again.'); });
    child.on('close', async code => {
      closed = true;
      clearTimeout(timeout); clearInterval(monitor); clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      await reporting;
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        const denied = /authentication failed|could not read Username|repository not found|HTTP 40[13]|returned error: 40[13]/i.test(stderr);
        reject(unprocessable(denied ? 'GitHub denied repository access. Reconnect GitHub or choose an authorized connection.'
          : /couldn.t find remote ref|not our ref|invalid refspec/i.test(stderr) ? 'The repository branch or commit is unavailable. Check the URL and try again.'
          : 'Could not download the GitHub repository. Check your connection and try again.', { code: 'skill_source_git_read_failed', status: denied ? 401 : 422 }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function parseTree(bytes: Buffer): GitSkillTreeEntry[] {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw unprocessable('Repository paths must use UTF-8.');
  const entries = text.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([\d-]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw unprocessable('Git returned an incomplete repository tree.');
    return { mode: match[1]!, type: match[2]!, sha: match[3]!, ...(match[4] === '-' ? {} : { size: Number(match[4]) }), path: match[5]! };
  });
  if (entries.length > 100_000) throw unprocessable('Repository exceeds the 100,000 file scan limit.');
  return entries;
}

async function discard(key: string) {
  const cached = snapshots.get(key);
  if (!cached || cached.users) return;
  snapshots.delete(key);
  clearTimeout(cached.timer);
  await rm(cached.directory, { recursive: true, force: true });
}

function acquire(cached: NonNullable<ReturnType<typeof snapshots.get>>, key: string): GitSkillSnapshot {
  cached.users++;
  clearTimeout(cached.timer);
  let released = false;
  return { commitSha: cached.commitSha, entries: cached.entries,
    readBlob: async (entry, signal) => {
      if (released || !/^[a-f0-9]{40}$/.test(entry.sha) || entry.type !== 'blob' || (entry.size ?? Infinity) > 1024 * 1024) throw unprocessable('Invalid snapshot file.');
      return runGit(cached.directory, ['cat-file', 'blob', entry.sha], '', { signal, maxOutput: 1024 * 1024 });
    },
    release: async () => {
      if (released) return;
      released = true;
      cached.users--;
      if (!cached.users) {
        cached.timer = setTimeout(() => { void discard(key).catch(() => {}); }, Math.max(0, cached.expires - Date.now()));
        cached.timer.unref();
      }
    },
  };
}

/** Caller authorization must be resolved before every invocation, including cache hits. */
export async function openGitSkillSnapshot(input: { repositoryUrl: string; ref: string; commitSha?: string; token: string; cacheScope: string }, options: GitSkillSnapshotOptions = {}): Promise<GitSkillSnapshot> {
  options.signal?.throwIfAborted();
  const parsed = parseGitHubSkillRepositoryUrl(input.repositoryUrl);
  if (!parsed || parsed.trackingRef || (input.commitSha && !/^[a-f0-9]{40}$/i.test(input.commitSha))) throw unprocessable('Invalid GitHub snapshot request.');
  const prefix = `${input.cacheScope}:${parsed.repositoryUrl}:`;
  const pinnedKey = input.commitSha ? `${prefix}${input.commitSha.toLowerCase()}` : null;
  const existing = pinnedKey ? snapshots.get(pinnedKey) : undefined;
  if (existing && existing.expires > Date.now()) return acquire(existing, pinnedKey!);
  for (const [key, cached] of snapshots) if (!cached.users && (cached.expires <= Date.now() || snapshots.size >= MAX_CACHED_SNAPSHOTS)) await discard(key);
  if (activeDownloads >= 2 || snapshots.size + activeDownloads >= MAX_CACHED_SNAPSHOTS) throw unprocessable('Other repositories are downloading. Try again when they finish.');
  activeDownloads++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'paperclip-skill-git-'));
    await chmod(directory, 0o700);
    await runGit(directory, ['init', '--bare', '--quiet', '.'], '', options);
    if (!input.commitSha && !/^[a-f0-9]{40}$/i.test(input.ref)) await runGit(directory, ['check-ref-format', '--branch', input.ref], '', options);
    await runGit(directory, ['-c', 'fetch.unpackLimit=1', 'fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--progress',
      '--', `${parsed.repositoryUrl}.git`, input.commitSha ?? input.ref], input.token, { ...options, download: true });
    if (await directoryBytes(directory) > MAX_DOWNLOAD_BYTES) throw unprocessable('Repository download exceeds the 128 MB limit. Use a smaller skills repository.');
    const commitSha = (await runGit(directory, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], '', options)).toString('utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(commitSha) || (input.commitSha && commitSha !== input.commitSha.toLowerCase())) throw unprocessable('The downloaded commit did not match the requested snapshot.');
    const entries = parseTree(await runGit(directory, ['ls-tree', '-r', '-l', '-z', '--full-tree', commitSha], '', options));
    const key = `${prefix}${commitSha}`;
    const duplicate = snapshots.get(key);
    if (duplicate) return acquire(duplicate, key);
    const cached = { directory, commitSha, entries, users: 0, expires: Date.now() + CACHE_TTL_MS };
    snapshots.set(key, cached);
    directory = undefined;
    return acquire(cached, key);
  } finally {
    activeDownloads--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function clearGitSkillSnapshotCache() {
  for (const key of snapshots.keys()) await discard(key);
}
