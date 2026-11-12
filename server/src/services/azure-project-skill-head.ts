import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import { forbidden } from '../errors.js';
import type { Db } from '@paperclipai/db';
import { resolveAzureDevOpsProjectGitCredentials } from './azure-project-git-credentials.js';
import type { GitAuthInvocation } from './git-credentials.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

type AzureProjectSkillHeadInput = { companyId: string; projectId: string; repoUrl: string; ref: string };
type CredentialResolver = (db: Db, input: { companyId: string; projectId: string; repoUrl: string }) => Promise<GitAuthInvocation>;
type SpawnGit = typeof spawn;

export type AzureProjectSkillHeadDependencies = {
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveCredentials?: CredentialResolver;
  spawn?: SpawnGit;
};

const unavailable = () => forbidden('Azure DevOps project skill ref is unavailable.');

function aborted() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function canonicalRepositoryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'dev.azure.com' || url.port ||
        url.username || url.password || url.search || url.hash ||
        !/^\/[A-Za-z0-9][A-Za-z0-9-]{0,49}\/[^/]+\/_git\/[^/]+\/?$/.test(url.pathname)) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

/** Accept ordinary Git refs only; ls-remote patterns and option-like strings are not refs. */
function isValidRef(ref: string): boolean {
  if (!ref || ref.length > 512 || ref.startsWith('-') || ref === '@' ||
      /[\x00-\x20\x7f ~^:?*\\\[]/.test(ref) || ref.includes('..') || ref.includes('//') || ref.includes('@{') ||
      ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  return ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function expectedRefs(ref: string): string[] {
  if (ref === 'HEAD' || ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`];
}

function parseHead(output: Buffer, ref: string): { commitSha: string; ref: string } {
  const text = output.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(output) || !text || !text.endsWith('\n')) throw unavailable();
  const rows = text.slice(0, -1).split('\n').map(line => {
    const match = /^([a-f0-9]{40})\t([^\r\n\t]+)$/i.exec(line);
    if (!match) throw unavailable();
    return { sha: match[1]!.toLowerCase(), ref: match[2]! };
  });
  const candidates = expectedRefs(ref);
  // ls-remote matches ref-name suffixes, so `main` also returns rows such as `refs/heads/release/main`.
  const relevant = rows.filter(row => candidates.some(candidate => row.ref === candidate || row.ref === `${candidate}^{}`));
  const bases = relevant.filter(row => candidates.includes(row.ref));
  if (bases.length !== 1) throw unavailable();
  const base = bases[0]!;
  const peeledName = `${base.ref}^{}`;
  const peeled = relevant.filter(row => row.ref === peeledName);
  if (relevant.some(row => row.ref !== base.ref && row.ref !== peeledName) || peeled.length > 1 ||
      (peeled.length && !base.ref.startsWith('refs/tags/'))) throw unavailable();
  return { commitSha: peeled[0]?.sha ?? base.sha, ref: base.ref };
}

function controlledEnvironment(auth: GitAuthInvocation): NodeJS.ProcessEnv {
  if (auth.configArgs.length || auth.source !== 'managed_connection' || auth.secretName !== null ||
      auth.repositoryAuthority?.provider !== 'azure-devops') throw unavailable();
  const env = auth.env;
  const allowedExact = new Set([
    'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS',
    'GIT_CONFIG_COUNT', 'PAPERCLIP_AZURE_GIT_PATH', 'PAPERCLIP_AZURE_GIT_TOKEN',
  ]);
  const keys = Object.keys(env);
  for (const key of keys) {
    if (allowedExact.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) continue;
    throw unavailable();
  }
  if (keys.some(key => /github|gh_token|paperclip_git_token/i.test(key)) ||
      Object.values(env).some(value => /github\.com/i.test(value ?? '')) ||
      env.GIT_CONFIG_NOSYSTEM !== '1' || env.GIT_CONFIG_GLOBAL !== '/dev/null' ||
      env.GIT_TERMINAL_PROMPT !== '0' || env.GIT_ASKPASS !== '' || env.SSH_ASKPASS !== '') throw unavailable();
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw unavailable();
  for (let index = 0; index < count; index++) {
    if (typeof env[`GIT_CONFIG_KEY_${index}`] !== 'string' || typeof env[`GIT_CONFIG_VALUE_${index}`] !== 'string') throw unavailable();
  }
  if (keys.some(key => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) && Number(key.match(/\d+$/)?.[0]) >= count)) throw unavailable();
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_SYSTEM: '/dev/null',
    ...env,
  };
}

async function runLsRemote(
  repoUrl: string,
  ref: string,
  env: NodeJS.ProcessEnv,
  deps: { signal?: AbortSignal; timeoutMs: number; spawn: SpawnGit },
): Promise<Buffer> {
  const { signal, timeoutMs, spawn: spawnGit } = deps;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const options: SpawnOptions = { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        detached: process.platform !== 'win32' };
      child = spawnGit('git', ['ls-remote', '--exit-code', '--', repoUrl, ref], options);
    } catch { reject(unavailable()); return; }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: unknown;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signalName: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch { /* The process already exited. */ }
    };
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error;
      if (closed) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const abort = () => stop(aborted());
    const timeout = setTimeout(() => stop(unavailable()), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { stop(unavailable()); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.on('error', () => stop(unavailable()));
    child.on('close', (code: number | null) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(unavailable()); return; }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Read one exact Azure DevOps ref head under fresh project consent before and after Git. */
export async function readAzureProjectSkillHead(
  db: Db,
  input: AzureProjectSkillHeadInput,
  deps: AzureProjectSkillHeadDependencies = {},
): Promise<{ commitSha: string; ref: string }> {
  const { signal } = deps;
  const canonicalUrl = canonicalRepositoryUrl(input.repoUrl);
  if (!canonicalUrl || !isValidRef(input.ref)) throw unavailable();
  if (signal?.aborted) throw aborted();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw unavailable();
  const resolveCredentials = deps.resolveCredentials ?? resolveAzureDevOpsProjectGitCredentials;
  const spawnGit = deps.spawn ?? spawn;
  try {
    const auth = await resolveCredentials(db, { companyId: input.companyId, projectId: input.projectId, repoUrl: input.repoUrl });
    if (auth.repositoryAuthority?.url !== canonicalUrl) throw unavailable();
    const env = controlledEnvironment(auth);
    signal?.throwIfAborted();
    const pinned = /^[a-f0-9]{40}$/i.test(input.ref);
    const output = await runLsRemote(input.repoUrl, pinned ? "HEAD" : input.ref, env, { signal, timeoutMs, spawn: spawnGit });
    signal?.throwIfAborted();
    await resolveCredentials(db, { companyId: input.companyId, projectId: input.projectId, repoUrl: input.repoUrl });
    signal?.throwIfAborted();
    const head = parseHead(output, pinned ? "HEAD" : input.ref);
    return pinned ? { commitSha: input.ref.toLowerCase(), ref: input.ref } : head;
  } catch {
    if (signal?.aborted) throw aborted();
    throw unavailable();
  }
}
