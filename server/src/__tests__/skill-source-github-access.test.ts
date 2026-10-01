import type { Request } from 'express';
import type { Db } from '@paperclipai/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forbidden } from '../errors.js';
const mocks = vi.hoisted(() => ({ headers: vi.fn(), connectionIds: vi.fn(), snapshot: vi.fn(), grantIds: vi.fn(), managed: vi.fn() }));
vi.mock('../services/tool-access.js', () => ({ toolAccessService: () => ({ githubReadHeaders: mocks.headers, githubReadConnectionIds: mocks.connectionIds, githubReadGrantIds: mocks.grantIds }) }));
vi.mock('../services/github-operation-credentials.js', () => ({ resolveGitHubOperationCredentials: mocks.managed }));
vi.mock('../services/skill-source-git-snapshot.js', () => ({ openGitSkillSnapshot: mocks.snapshot }));
import { skillSourceGitHubReader } from '../services/skill-source-github-access.js';
import { scanGitHubSkills } from '../services/github-skill-source.js';
import { githubFixture } from './helpers/github-skills.js';
const actor = (values: Record<string, unknown>) => values as Request['actor'];
const db = {} as Db;
beforeEach(() => { mocks.grantIds.mockResolvedValue(['grant']); mocks.connectionIds.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe('GitHub source authorization', () => {
  it('uses one lease across metadata, snapshot and auditing, then permits another complete scan', async () => {
    const fixture = githubFixture({ 'SKILL.md': '---\nname: example\ndescription: Useful instructions\n---\nRead the document.' });
    const fetch = vi.fn(async (url: string) => Response.json(await fixture(new URL(url).pathname)));
    vi.stubGlobal('fetch', fetch);
    mocks.snapshot.mockImplementation(fixture.openSnapshot);
    const read = skillSourceGitHubReader(db, 'whole-scan-company', actor({ type: 'board', userId: 'whole-scan' }), null);
    for (let i = 0; i < 2; i++) {
      const result = await scanGitHubSkills({ repositoryUrl: 'https://github.com/acme/skills' }, read);
      expect(result.candidates[0]).toMatchObject({ name: 'example', error: null });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it('rejects exhausted scans before repository or commit requests and releases failed metadata reads', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const caller = actor({ type: 'board', userId: 'early-scan-quota', source: 'session' });
    for (let i = 0; i < 30; i++) {
      const read = skillSourceGitHubReader(db, 'metadata-quota-company', caller, null);
      await expect(scanGitHubSkills({ repositoryUrl: 'https://github.com/acme/public' }, read)).rejects.toThrow('GitHub could not complete');
    }
    expect(fetch).toHaveBeenCalledTimes(30);
    const read = skillSourceGitHubReader(db, 'metadata-quota-company', caller, null);
    await expect(scanGitHubSkills({ repositoryUrl: 'https://github.com/acme/public' }, read)).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(30);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('shares active scan limits across connections and releases them after failures', async () => {
    mocks.headers.mockResolvedValue({ Authorization: 'Bearer allowed' });
    mocks.snapshot.mockRejectedValueOnce(new Error('Download failed'))
      .mockResolvedValue({ commitSha: 'a'.repeat(40), release: async () => {} });
    const caller = actor({ type: 'board', userId: 'scan-limits', source: 'session' });
    const first = skillSourceGitHubReader(db, 'company', caller, 'first');
    const second = skillSourceGitHubReader(db, 'company', caller, 'second');
    const input = { repositoryUrl: 'https://github.com/acme/private', ref: 'main', commitSha: 'a'.repeat(40) };
    await expect(first.openSnapshot(input)).rejects.toThrow('Could not read GitHub');
    const snapshot = await first.openSnapshot(input);
    await expect(second.openSnapshot(input)).rejects.toMatchObject({ status: 429 });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    await snapshot.release();
    const retry = await second.openSnapshot(input);
    await retry.release();
  });

  it('automatically uses the active user’s connection for a pasted public URL and the Git download', async () => {
    mocks.connectionIds.mockResolvedValue(['own']);
    mocks.headers.mockResolvedValue({ Authorization: 'Bearer own-token' });
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 42 })); vi.stubGlobal('fetch', fetch);
    mocks.snapshot.mockResolvedValue({ commitSha: 'a'.repeat(40), release: async () => {} });
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), null);
    await read('/repos/acme/public');
    const snapshot = await read.openSnapshot({ repositoryUrl: 'https://github.com/acme/public', ref: 'main' });
    await snapshot.release();
    expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer own-token');
    expect(mocks.connectionIds).toHaveBeenCalledWith('company', 'alice', false);
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.objectContaining({ token: 'own-token', cacheScope: expect.stringContaining('alice') }), { beforeDownload: expect.any(Function) });
    expect(mocks.headers).toHaveBeenCalledTimes(2);
    expect(read.connectionId).toBe('own');
  });
  it('tries other authorized connections before anonymous public access', async () => {
    mocks.connectionIds.mockResolvedValue(['personal', 'work']);
    mocks.headers.mockImplementation(async (_company, id) => ({ Authorization: `Bearer ${id}` }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ id: 42 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), null);
    await read('/repos/acme/public');
    expect(fetch.mock.calls.map(call => new Headers(call[1].headers).get('authorization'))).toEqual(['Bearer personal', 'Bearer work']);
    expect(read.connectionId).toBe('work');
  });
  it('reauthorizes before serving a cached Git snapshot and never starts Git after revocation', async () => {
    mocks.headers.mockResolvedValueOnce({ Authorization: 'Bearer allowed' }).mockRejectedValueOnce(forbidden('Authorization revoked.'));
    mocks.snapshot.mockResolvedValue({ commitSha: 'a'.repeat(40), release: async () => {} });
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), 'connection');
    const input = { repositoryUrl: 'https://github.com/acme/private', ref: 'main', commitSha: 'a'.repeat(40) };
    const snapshot = await read.openSnapshot(input);
    await snapshot.release();
    await expect(read.openSnapshot(input)).rejects.toThrow('revoked');
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });
  it('distinguishes quota exhaustion from access denial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })));
    await expect(skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), null)('/repos/acme/public'))
      .rejects.toMatchObject({ details: { code: 'skill_source_github_rate_limited' }, message: expect.stringContaining('limit resets') });
  });
  it('aborts an in-flight GitHub fetch and does not fall through to another grant', async () => {
    mocks.grantIds.mockResolvedValue(['first', 'second']);
    mocks.headers.mockResolvedValue({ Authorization: 'Bearer allowed' });
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), 'connection');
    const request = read('/repos/acme/private', controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    expect(mocks.headers).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not start a fetch if cancelled during credential resolution', async () => {
    const controller = new AbortController();
    mocks.headers.mockImplementation(async () => { controller.abort(); return { Authorization: 'Bearer allowed' }; });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), 'connection');
    await expect(read('/repos/acme/private', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads public repositories anonymously without resolving a token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), null);
    expect(await read('/repos/acme/public')).toEqual({ id: 1 });
    expect(mocks.headers).not.toHaveBeenCalled();
    expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    await expect(read('https://evil.test/repos/acme/public')).rejects.toThrow();
  });
  it('resolves the current caller for private reads and refreshes expired OAuth once', async () => {
    mocks.headers.mockResolvedValueOnce({ Authorization: 'Bearer old' }).mockResolvedValueOnce({ Authorization: 'Bearer new' });
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), 'connection');
    await read('/repos/acme/private');
    expect(mocks.headers.mock.calls).toEqual([['company', 'connection', 'alice', false, false, 'grant'], ['company', 'connection', 'alice', false, true, 'grant']]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('tries each caller-authorized grant when a repository is unavailable through the first', async () => {
    mocks.grantIds.mockResolvedValue(['personal', 'organization']);
    mocks.headers.mockImplementation(async (_company, _connection, _user, _local, _force, grant) => ({ Authorization: `Bearer ${grant}` }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ id: 42 }));
    vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), 'connection');
    expect(await read('/repos/acme/shared')).toEqual({ id: 42 });
    expect(fetch.mock.calls.map(call => new Headers(call[1].headers).get('authorization'))).toEqual(['Bearer personal', 'Bearer organization']);
    expect(mocks.headers.mock.calls.map(call => call[5])).toEqual(['personal', 'organization']);
  });
  it('continues after a credential refresh error and sanitizes an all-grants failure', async () => {
    mocks.grantIds.mockResolvedValue(['personal', 'organization']);
    mocks.headers.mockRejectedValueOnce(new Error('sensitive refresh-provider error')).mockResolvedValueOnce({ Authorization: 'Bearer organization' });
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 42 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice' }), 'connection');
    expect(await read('/repos/acme/shared')).toEqual({ id: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
    mocks.headers.mockRejectedValue(new Error('sensitive refresh-provider error'));
    await expect(read('/repos/acme/shared')).rejects.toMatchObject({ message: 'Could not read GitHub. Check your connection and try again.' });
    expect(mocks.headers).toHaveBeenCalledTimes(4);
  });
  it('rechecks authorization if access is revoked during a repository scan', async () => {
    mocks.headers.mockResolvedValueOnce({ Authorization: 'Bearer allowed' }).mockRejectedValueOnce(forbidden('Authorization revoked.'));
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), 'connection');
    await read('/repos/acme/private');
    await expect(read('/repos/acme/private/git/trees/main')).rejects.toThrow('revoked');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to someone else’s token or anonymous access when authorization fails', async () => {
    mocks.headers.mockRejectedValue(forbidden('Reconnect your authorization.')); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'bob', source: 'session' }), 'connection')('/repos/acme/private')).rejects.toThrow('Reconnect');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses only the active agent run’s managed identity and rejects a different connection', async () => {
    mocks.managed.mockResolvedValue({ status: 'available', connectionId: 'allowed', env: { GH_TOKEN: 'managed' } });
    const fetch = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal('fetch', fetch);
    const run = actor({ type: 'agent', agentId: 'agent', companyId: 'company', runId: 'run' });
    await skillSourceGitHubReader(db, 'company', run, 'allowed')('/repos/acme/private');
    expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer managed');
    await expect(skillSourceGitHubReader(db, 'company', run, 'other')('/repos/acme/private')).rejects.toThrow(/authorized connection/);
    await expect(skillSourceGitHubReader(db, 'other-company', run, 'allowed')('/repos/acme/private')).rejects.toThrow(/authenticated agent run/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports retryable failures without returning provider bodies or credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive provider text', { status: 503 })));
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board' }), null);
    await expect(read('/repos/acme/public')).rejects.toMatchObject({ status: 422, message: 'GitHub could not complete the read. Try again.' });
  });
});
