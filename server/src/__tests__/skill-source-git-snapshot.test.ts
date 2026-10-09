import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const interception = vi.hoisted(() => ({ remote: '', commands: [] as Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }>, hang: false, closedFetches: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    interception.commands.push({ args, cwd: String(options.cwd), env: options.env! });
    if (interception.hang && args.includes('fetch')) return actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    // Exercise real Git objects/processes without depending on the network in CI.
    const localArgs = args.map(arg => arg === 'https://github.com/acme/skills.git' ? `file://${interception.remote}` : arg);
    if (args.includes('fetch')) localArgs.unshift('-c', 'protocol.file.allow=always');
    const child = actual.spawn(command, localArgs, options);
    if (args.includes('fetch')) child.once('close', () => { interception.closedFetches++; });
    return child;
  } };
});
import { clearGitSkillSnapshotCache, openGitSkillSnapshot, parseGitDownloadProgress } from '../services/skill-source-git-snapshot.js';
const exec = promisify(execFile);
let directory: string, commit: string, laterCommit: string;
const git = (...args: string[]) => exec('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args]);
const request = (values: Partial<Parameters<typeof openGitSkillSnapshot>[0]> = {}) => ({ repositoryUrl: 'https://github.com/acme/skills', ref: 'feature/skills', token: 'test-token-never-on-disk', cacheScope: 'company:alice', ...values });
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'paperclip-snapshot-fixture-'));
  interception.remote = directory;
  await git('init', '-b', 'feature/skills');
  await mkdir(path.join(directory, '.agents/deep/scripts'), { recursive: true });
  await writeFile(path.join(directory, '.agents/deep/SKILL.md'), '---\nname: skill\ndescription: Useful\n---\nInstructions');
  await writeFile(path.join(directory, '.agents/deep/scripts/run.sh'), '#!/bin/sh\ntouch SHOULD_NOT_RUN\n');
  await chmod(path.join(directory, '.agents/deep/scripts/run.sh'), 0o755);
  await writeFile(path.join(directory, '.agents/deep/asset.bin'), Buffer.from([0, 255, 137, 13, 10]));
  await writeFile(path.join(directory, '.gitattributes'), '.agents/deep/asset.bin export-ignore\n*.md export-subst\n');
  await symlink('/etc/passwd', path.join(directory, '.agents/deep/link'));
  await git('add', '.'); await git('commit', '-m', 'Fixture');
  commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('update-index', '--add', '--cacheinfo', `160000,${commit},external/submodule`);
  await git('commit', '-m', 'Gitlink');
  laterCommit = (await git('rev-parse', 'HEAD')).stdout.trim();
});
afterEach(async () => { vi.useRealTimers(); interception.hang = false; await clearGitSkillSnapshotCache(); interception.commands = []; interception.closedFetches = 0; vi.unstubAllEnvs(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('Git skill snapshots', () => {
  it('preserves exact bytes, hidden paths and executable bits without checkout, archive exclusions, or submodule traversal', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'DO-NOT-INHERIT');
    vi.stubEnv('GIT_TRACE', '/tmp/do-not-write-git-trace');
    const snapshot = await openGitSkillSnapshot(request());
    expect(snapshot.commitSha).toBe(laterCommit);
    const asset = snapshot.entries.find(entry => entry.path.endsWith('asset.bin'))!;
    expect(await snapshot.readBlob(asset)).toEqual(Buffer.from([0, 255, 137, 13, 10]));
    expect(snapshot.entries.find(entry => entry.path.endsWith('run.sh'))?.mode).toBe('100755');
    expect(snapshot.entries.find(entry => entry.path.endsWith('/link'))?.mode).toBe('120000');
    expect(snapshot.entries.find(entry => entry.path === 'external/submodule')?.type).toBe('commit');
    const fetch = interception.commands.find(command => command.args.includes('fetch'))!;
    expect(fetch.args).toContain('--depth=1');
    expect(fetch.args.join(' ')).not.toContain('test-token');
    expect(fetch.env.PAPERCLIP_GIT_TOKEN).toBe('test-token-never-on-disk');
    const authKey = Object.entries(fetch.env).find(([, value]) => value === 'http.https://github.com/.extraHeader')![0];
    expect(fetch.env[authKey.replace('_KEY_', '_VALUE_')]).toBe(`Authorization: Basic ${Buffer.from('x-access-token:test-token-never-on-disk').toString('base64')}`);
    expect(fetch.env.GIT_TRACE).toBeUndefined();
    expect(Object.values(fetch.env)).not.toContain('DO-NOT-INHERIT');
    expect(await readFile(path.join(fetch.cwd, 'config'), 'utf8')).not.toContain('test-token');
    await expect(readFile(path.join(fetch.cwd, '.agents/deep/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await snapshot.release();
  });
  it('reuses the exact scanned commit for import and isolates snapshots between callers', async () => {
    const beforeDownload = vi.fn();
    const first = await openGitSkillSnapshot(request(), { beforeDownload }); await first.release();
    const pinned = await openGitSkillSnapshot(request({ commitSha: first.commitSha }), { beforeDownload });
    expect(pinned.commitSha).toBe(first.commitSha); await pinned.release();
    expect(interception.commands.filter(command => command.args.includes('fetch'))).toHaveLength(1);
    expect(beforeDownload).toHaveBeenCalledOnce();
    const other = await openGitSkillSnapshot(request({ commitSha: first.commitSha, cacheScope: 'company:bob' })); await other.release();
    expect(interception.commands.filter(command => command.args.includes('fetch'))).toHaveLength(2);
  });
  it('fetches an older pinned commit rather than silently using the current branch', async () => {
    const snapshot = await openGitSkillSnapshot(request({ commitSha: commit }));
    expect(snapshot.commitSha).toBe(commit);
    expect(snapshot.entries.some(entry => entry.type === 'commit')).toBe(false);
    await snapshot.release();
  });
  it('cleans up cancelled downloads, terminates the child and permits retry', async () => {
    interception.hang = true;
    const controller = new AbortController();
    const pending = openGitSkillSnapshot(request(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(interception.commands.some(command => command.args.includes('fetch'))).toBe(true));
    const download = interception.commands.find(command => command.args.includes('fetch'))!;
    controller.abort(); await rejected;
    await expect(readFile(path.join(download.cwd, 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    interception.hang = false;
    const retry = await openGitSkillSnapshot(request()); expect(retry.commitSha).toBe(laterCommit); await retry.release();
  });
  it.each(['timeout', 'cancel'] as const)('releases both download slots after %s when Git exits but progress never drains', async reason => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const onDownload = vi.fn(() => new Promise<void>(() => {}));
    const rejected = [0, 1].map(index => expect(openGitSkillSnapshot(request({ cacheScope: `stalled:${index}` }), {
      signal: controller.signal, onDownload,
    })).rejects.toThrow(reason === 'timeout' ? 'timed out' : 'aborted'));
    await vi.waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(2);
      expect(interception.closedFetches).toBe(2);
    });
    const downloads = interception.commands.filter(command => command.args.includes('fetch'));
    await expect(openGitSkillSnapshot(request())).rejects.toThrow('Other repositories are downloading');
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(180_000);
    else controller.abort();
    await Promise.all(rejected);
    for (const download of downloads) await expect(readFile(path.join(download.cwd, 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.useRealTimers();
    const retry = await openGitSkillSnapshot(request());
    expect(retry.commitSha).toBe(laterCommit);
    await retry.release();
  });
  it.each(['https://evil.test/acme/skills', 'https://token@github.com/acme/skills', 'file:///tmp/repo'])('rejects unauthorized remote %s before starting Git', async repositoryUrl => {
    await expect(openGitSkillSnapshot(request({ repositoryUrl }))).rejects.toThrow('Invalid GitHub');
    expect(interception.commands).toHaveLength(0);
  });
  it('rejects revision expressions and command options', async () => {
    for (const ref of ['--upload-pack=malicious', 'main:refs/heads/change', 'main~1', 'main^{tree}']) {
      await expect(openGitSkillSnapshot(request({ ref }))).rejects.toThrow();
    }
    expect(interception.commands.some(command => command.args.includes('fetch'))).toBe(false);
  });
  it('reports only numeric download progress, never provider text or credentials', () => {
    expect(parseGitDownloadProgress('Receiving objects:  64% (64/100), 18.50 MiB | 2.0 MiB/s')).toEqual({ stage: 'receiving', percent: 64, receivedBytes: 19_398_656 });
    expect(parseGitDownloadProgress('Resolving deltas:  32% (32/100)')).toEqual({ stage: 'resolving', percent: 32 });
    expect(parseGitDownloadProgress('fatal: token=secret error')).toBeNull();
  });
});
