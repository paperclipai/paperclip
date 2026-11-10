import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import { azureDevOpsGitInvocation } from './connectors/azure-devops/git-auth.js';
import { readAzureProjectSkillHead } from './azure-project-skill-head.js';

const repoUrl = 'https://dev.azure.com/contoso/Project/_git/skills';
const token = 'project-azure-token-must-not-leak';
const sha = 'a'.repeat(40);
const input = { companyId: 'company-1', projectId: 'project-1', repoUrl, ref: 'main' };
const database = {} as Db;

function fakeGit(options: { output?: string; exitCode?: number; autoClose?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    setImmediate(() => { child.stdout.once('end', () => child.emit('close', null, signal)); child.stdout.end(); });
    return true;
  }) as typeof child.kill;
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    if (options.autoClose !== false) {
      setImmediate(() => {
        child.stdout.once('end', () => child.emit('close', options.exitCode ?? 0, null));
        child.stdout.end(options.output);
      });
    }
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { child, calls, spawn };
}

const credentials = () => azureDevOpsGitInvocation(repoUrl, { kind: 'entra', token });
afterEach(() => { vi.unstubAllEnvs(); });

describe('Azure DevOps project skill ref head', () => {
  it('reads the exact ref using only the authorized ephemeral Git environment and rechecks consent', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-secret');
    vi.stubEnv('GIT_CONFIG_COUNT', '999');
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ output: `${sha}\trefs/heads/main\n` });
    const result = await readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn });

    expect(result).toEqual({ commitSha: sha, ref: 'refs/heads/main' });
    expect(resolveCredentials).toHaveBeenCalledTimes(2);
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]).toMatchObject({
      command: 'git', args: ['ls-remote', '--exit-code', '--', repoUrl, 'main'],
      options: { cwd: expect.any(String), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    });
    const args = git.calls[0]!.args.join(' ');
    const env = git.calls[0]!.options.env!;
    expect(args).not.toContain(token);
    expect(env.PAPERCLIP_GIT_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe(credentials().env.GIT_CONFIG_COUNT);
    expect(Object.values(env).join('\n')).toContain(token);
    expect(Object.values(env).join('\n')).not.toContain('ambient-github-secret');
  });

  it('checks current repository access without treating a pinned commit as a ref pattern', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ output: `${'b'.repeat(40)}\tHEAD\n` });
    await expect(readAzureProjectSkillHead(database, { ...input, ref: sha }, { resolveCredentials, spawn: git.spawn }))
      .resolves.toEqual({ commitSha: sha, ref: sha });
    expect(git.calls[0]!.args).toEqual(['ls-remote', '--exit-code', '--', repoUrl, 'HEAD']);
    expect(resolveCredentials).toHaveBeenCalledTimes(2);
  });

  it('fails closed when consent is revoked after the ref read and never exposes provider details', async () => {
    const resolveCredentials = vi.fn()
      .mockResolvedValueOnce(credentials())
      .mockRejectedValueOnce(new Error(`revoked token ${token}`));
    const git = fakeGit({ output: `${sha}\trefs/heads/main\n` });
    let error: unknown;
    try { await readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn }); }
    catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).toContain('Azure DevOps project skill ref is unavailable');
    expect(String(error)).not.toContain(token);
    expect(resolveCredentials).toHaveBeenCalledTimes(2);
  });

  it('rejects ambiguous short refs instead of choosing between a branch and tag', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ output: `${sha}\trefs/heads/main\n${'b'.repeat(40)}\trefs/tags/main\n` });
    await expect(readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn }))
      .rejects.toThrow('Azure DevOps project skill ref is unavailable');
    expect(resolveCredentials).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted ref patterns before starting Git', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit();
    await expect(readAzureProjectSkillHead(database, { ...input, ref: 'refs/heads/*' }, { resolveCredentials, spawn: git.spawn }))
      .rejects.toThrow('Azure DevOps project skill ref is unavailable');
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(git.spawn).not.toHaveBeenCalled();
  });

  it('aborts and terminates an in-flight Git process without returning its diagnostics', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ autoClose: false });
    const controller = new AbortController();
    const pending = readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn, signal: controller.signal });
    await vi.waitFor(() => expect(git.spawn).toHaveBeenCalledOnce());
    controller.abort(new Error(`abort reason ${token}`));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(git.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(resolveCredentials).toHaveBeenCalledOnce();
  });

  it('times out and terminates a Git process without forwarding stderr', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ autoClose: false });
    const pending = readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn, timeoutMs: 10 });
    await expect(pending).rejects.toThrow('Azure DevOps project skill ref is unavailable');
    expect(git.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(resolveCredentials).toHaveBeenCalledOnce();
  });

  it('uses only generic errors for provider failures', async () => {
    const resolveCredentials = vi.fn(async () => credentials());
    const git = fakeGit({ output: `fatal: provider leaked ${token}\n`, exitCode: 2 });
    await expect(readAzureProjectSkillHead(database, input, { resolveCredentials, spawn: git.spawn }))
      .rejects.toMatchObject({ message: expect.not.stringContaining(token) });
  });
});
