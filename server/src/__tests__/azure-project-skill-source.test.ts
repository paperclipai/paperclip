import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import type { GitAuthInvocation } from '../services/git-credentials.js';
import type { GitSkillSnapshot, GitSkillSnapshotOptions } from '../services/skill-source-git-snapshot.js';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  openSnapshot: vi.fn(),
}));

vi.mock('../services/azure-project-git-credentials.js', () => ({
  resolveAzureDevOpsProjectGitCredentials: mocks.resolve,
}));
vi.mock('../services/skill-source-git-snapshot.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/skill-source-git-snapshot.js')>();
  return { ...actual, openGitSkillSnapshot: mocks.openSnapshot };
});

import { scanAzureDevOpsProjectSkills } from '../services/azure-project-skill-source.js';

const companyId = 'company-a';
const projectId = 'project-a';
const repositoryUrl = 'https://dev.azure.com/contoso/Platform/_git/paperclip';
const commitSha = 'a'.repeat(40);
const secret = 'azure-skill-pat-canary';
const connectionId = 'connection-a';
const grantId = 'grant-a';

const workspace = {
  id: 'workspace-a',
  companyId,
  projectId,
  repoUrl: repositoryUrl,
  name: 'Platform/paperclip',
  metadata: { repositoryProvider: 'azure-devops', repositoryId: 'contoso:12345678-1234-1234-1234-1234567890ab' },
};
const authority = { grantId, connectionId };
const gitAuth: GitAuthInvocation = {
  configArgs: [],
  env: { PAPERCLIP_AZURE_GIT_TOKEN: secret },
  source: 'managed_connection',
  secretName: null,
  repositoryAuthority: { provider: 'azure-devops', url: repositoryUrl },
};

function fakeDb(rows: unknown[][]) {
  let index = 0;
  const select = vi.fn(() => {
    const query: Record<string, unknown> = {};
    query.from = vi.fn(() => query);
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(async () => rows[index++] ?? []);
    return query;
  });
  return { select } as unknown as Db;
}

function snapshotFixture(overrides: Partial<GitSkillSnapshot> = {}): GitSkillSnapshot {
  return {
    commitSha,
    treeSha: 'b'.repeat(40),
    entries: [],
    readBlob: vi.fn(async () => Buffer.alloc(0)),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

function dbFor(...rows: unknown[][]) {
  return fakeDb(rows);
}

describe('scanAzureDevOpsProjectSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scans only the selected project repository and grant, pins the immutable commit, and keeps credentials out of scan output', async () => {
    const snapshot = snapshotFixture();
    const db = dbFor([workspace], [authority], [authority]);
    mocks.resolve.mockResolvedValue(gitAuth);
    mocks.openSnapshot.mockResolvedValue(snapshot);

    const result = await scanAzureDevOpsProjectSkills(db, {
      companyId,
      projectId,
      repositoryUrl,
      trackingRef: 'refs/heads/main',
      commitSha,
      packageMode: 'repository',
    });

    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenNthCalledWith(1, db, { companyId, projectId, repoUrl: repositoryUrl });
    expect(mocks.resolve).toHaveBeenNthCalledWith(2, db, { companyId, projectId, repoUrl: repositoryUrl });
    expect(mocks.openSnapshot).toHaveBeenCalledOnce();
    const [snapshotInput] = mocks.openSnapshot.mock.calls[0] as [Parameters<typeof mocks.openSnapshot>[0]];
    expect(snapshotInput).toMatchObject({
      repositoryUrl,
      ref: 'refs/heads/main',
      commitSha,
      token: '',
      cacheScope: `${companyId}:${projectId}:${grantId}`,
      providerAuth: gitAuth,
    });
    expect(result).toMatchObject({
      repositoryId: workspace.metadata.repositoryId,
      repositoryUrl,
      fullName: workspace.name,
      trackingRef: 'refs/heads/main',
      defaultBranch: 'refs/heads/main',
      commitSha,
      connectionId,
      packageMode: 'repository',
      skills: [],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshot.release).toHaveBeenCalledOnce();
  });

  it.each<[string, unknown[], unknown[]]>([
    ['repository is outside this project', [], [authority]],
    ['workspace identifies a different provider', [{ ...workspace, metadata: { ...workspace.metadata, repositoryProvider: 'github' } }], [authority]],
    ['project organization has no selected authorization', [workspace], []],
  ])('rejects when %s before resolving credentials or opening Git', async (_label, workspaces, authorizations) => {
    const db = dbFor(workspaces, authorizations);

    await expect(scanAzureDevOpsProjectSkills(db, { companyId, projectId, repositoryUrl })).rejects.toThrow(/authorization is unavailable/i);

    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('does not resolve a workspace from another company', async () => {
    const otherCompanyId = 'company-b';
    const db = dbFor([], []);

    await expect(scanAzureDevOpsProjectSkills(db, { companyId: otherCompanyId, projectId, repositoryUrl }))
      .rejects.toThrow(/authorization is unavailable/i);

    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('does not open a snapshot when the chosen project credential is already revoked', async () => {
    const db = dbFor([workspace], [authority]);
    mocks.resolve.mockRejectedValue(new Error('Azure authorization unavailable'));

    await expect(scanAzureDevOpsProjectSkills(db, { companyId, projectId, repositoryUrl })).rejects.toThrow('Azure authorization unavailable');

    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('rechecks project credentials after fetch and releases the snapshot if authorization was revoked', async () => {
    const snapshot = snapshotFixture();
    const db = dbFor([workspace], [authority]);
    mocks.resolve.mockResolvedValueOnce(gitAuth).mockRejectedValueOnce(new Error('Azure authorization unavailable'));
    mocks.openSnapshot.mockResolvedValue(snapshot);

    await expect(scanAzureDevOpsProjectSkills(db, { companyId, projectId, repositoryUrl })).rejects.toThrow('Azure authorization unavailable');

    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(snapshot.release).toHaveBeenCalledOnce();
  });

  it.each(['grantId', 'connectionId'] as const)('releases the fetched snapshot if the selected project %s changes during authorization recheck', async field => {
    const snapshot = snapshotFixture();
    const db = dbFor([workspace], [authority], [{ ...authority, [field]: `replacement-${field}` }]);
    mocks.resolve.mockResolvedValue(gitAuth);
    mocks.openSnapshot.mockResolvedValue(snapshot);

    await expect(scanAzureDevOpsProjectSkills(db, { companyId, projectId, repositoryUrl })).rejects.toThrow(/authorization is unavailable/i);

    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(snapshot.release).toHaveBeenCalledOnce();
  });

  it('releases the snapshot if cancellation occurs during snapshot download progress', async () => {
    const snapshot = snapshotFixture();
    const db = dbFor([workspace], [authority], [authority]);
    const controller = new AbortController();
    mocks.resolve.mockResolvedValue(gitAuth);
    mocks.openSnapshot.mockImplementation(async (_input: unknown, options: GitSkillSnapshotOptions) => {
      await options.onDownload?.({ stage: 'receiving', percent: 50 });
      return snapshot;
    });

    await expect(scanAzureDevOpsProjectSkills(db, {
      companyId,
      projectId,
      repositoryUrl,
    }, {
      signal: controller.signal,
      onProgress: async event => { if (event.type === 'progress' && event.phase === 'downloading' && event.download) controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(snapshot.release).toHaveBeenCalledOnce();
  });
});
