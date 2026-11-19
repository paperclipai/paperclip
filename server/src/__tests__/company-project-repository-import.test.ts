import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  assertProject: vi.fn(), projectCredentials: vi.fn(), runCredentials: vi.fn(), authorizationRead: vi.fn(),
  openSnapshot: vi.fn(), readBlob: vi.fn(), release: vi.fn(),
}));
vi.mock('../services/task-workspace-access.js', () => ({ assertTaskWorkspaceSourceProjectAccess: mocks.assertProject }));
vi.mock('../services/azure-project-git-credentials.js', () => ({ resolveAzureDevOpsProjectGitCredentials: mocks.projectCredentials }));
vi.mock('../services/azure-devops-run-git-credentials.js', () => ({ resolveAzureDevOpsRunGitCredentials: mocks.runCredentials }));
vi.mock('../services/project-provider-authorization.js', () => ({ projectProviderAuthorizationService: () => ({ read: mocks.authorizationRead }) }));
vi.mock('../services/skill-source-git-snapshot.js', () => ({ openGitSkillSnapshot: mocks.openSnapshot }));

import { resolveCompanyProjectRepository } from '../services/company-project-repository-import.js';

const workspace = {
  id: 'workspace-1', companyId: 'company-1', projectId: 'project-1',
  repoUrl: 'https://dev.azure.com/acme/project/_git/repo', defaultRef: 'main', repoRef: null,
  metadata: { repositoryProvider: 'azure-devops', repositoryId: 'azure-devops:acme:12345678-1234-1234-1234-123456789012' },
};
const repositoryUrl = 'https://dev.azure.com/acme/project/_git/repo';
const projectAuth = {
  grantId: 'grant-1', repositoryId: workspace.metadata.repositoryId, token: 'super-secret', source: 'managed_connection', configArgs: [], env: {},
  repositoryAuthority: { provider: 'azure-devops', url: repositoryUrl },
};
const agentAuth = {
  grantId: 'agent-grant', token: 'run-secret', source: 'managed_connection', configArgs: [], env: {},
  repositoryAuthority: { provider: 'azure-devops', url: repositoryUrl },
};
const entry = { type: 'blob', mode: '100644', path: 'README.md', size: 5 };
const board: Request['actor'] = { type: 'board', userId: 'user-1', source: 'session' };
const agent: Request['actor'] = { type: 'agent', companyId: 'company-1', agentId: 'agent-1', runId: 'run-1', source: 'agent_key' };

function makeDb(rows: Array<typeof workspace | undefined> = [workspace, workspace]) {
  let index = 0;
  return { select: () => ({ from: () => ({ where: async () => {
    const row = rows[index++];
    return row ? [row] : [];
  } }) }) } as never;
}

function snapshot() {
  mocks.openSnapshot.mockResolvedValue({ entries: [entry], readBlob: mocks.readBlob, release: mocks.release });
  mocks.readBlob.mockResolvedValue(Buffer.from('hello'));
  mocks.release.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertProject.mockResolvedValue(undefined);
  mocks.projectCredentials.mockResolvedValue(projectAuth);
  mocks.authorizationRead.mockResolvedValue({ options: [{ grantId: 'grant-1' }] });
  mocks.runCredentials.mockResolvedValue(agentAuth);
  snapshot();
});

describe('resolveCompanyProjectRepository', () => {
  it('keeps lookup and project access scoped to the requested company and workspace', async () => {
    await expect(resolveCompanyProjectRepository(makeDb([undefined]), board, {
      companyId: 'company-other', workspaceId: 'workspace-other',
    })).rejects.toMatchObject({ status: 403 });
    expect(mocks.assertProject).not.toHaveBeenCalled();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('uses credentials from the agent’s own active run', async () => {
    const result = await resolveCompanyProjectRepository(makeDb(), agent, { companyId: 'company-1', workspaceId: 'workspace-1' });
    expect(mocks.runCredentials).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'company-1', agentId: 'agent-1', runId: 'run-1', repoUrl: 'https://dev.azure.com/acme/project/_git/repo', projectId: 'project-1',
    });
    expect(mocks.openSnapshot).toHaveBeenCalledWith(expect.objectContaining({ providerAuth: agentAuth }));
    expect(result.type).toBe('inline');
  });

  it('denies an agent whose actor company does not match the requested company', async () => {
    await expect(resolveCompanyProjectRepository(makeDb(), { ...agent, companyId: 'company-other' }, {
      companyId: 'company-1', workspaceId: 'workspace-1',
    })).rejects.toMatchObject({ status: 403 });
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('denies a board user whose grant is absent from that user’s project authorization options', async () => {
    mocks.authorizationRead.mockResolvedValue({ options: [{ grantId: 'different-user-grant' }] });
    await expect(resolveCompanyProjectRepository(makeDb(), board, {
      companyId: 'company-1', workspaceId: 'workspace-1',
    })).rejects.toMatchObject({ status: 403 });
    expect(mocks.authorizationRead).toHaveBeenCalledWith(
      'company-1', 'project-1', 'user-1', 'azure-devops', 'acme',
    );
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('denies project credentials bound to a different repository identity', async () => {
    mocks.projectCredentials.mockResolvedValue({ ...projectAuth, repositoryId: 'azure-devops:acme:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    await expect(resolveCompanyProjectRepository(makeDb(), board, {
      companyId: 'company-1', workspaceId: 'workspace-1',
    })).rejects.toMatchObject({ status: 403 });
    expect(mocks.authorizationRead).not.toHaveBeenCalled();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it('rechecks current project authorization after download and releases the snapshot if revoked', async () => {
    mocks.authorizationRead.mockResolvedValueOnce({ options: [{ grantId: 'grant-1' }] }).mockResolvedValueOnce({ options: [] });
    await expect(resolveCompanyProjectRepository(makeDb(), board, { companyId: 'company-1', workspaceId: 'workspace-1' }))
      .rejects.toThrow('Azure DevOps connection authorization is unavailable');
    expect(mocks.readBlob).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('returns a successful inline package without exposing repository credentials', async () => {
    const result = await resolveCompanyProjectRepository(makeDb(), board, {
      companyId: 'company-1', workspaceId: 'workspace-1', ref: 'release',
    });
    expect(result).toEqual({ type: 'inline', files: { 'README.md': 'hello' }, expectedFileCount: 1 });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(mocks.openSnapshot).toHaveBeenCalledWith(expect.objectContaining({ token: '', ref: 'release' }));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('ignores large non-package blobs and reads only package files', async () => {
    const ignored = { type: 'blob', mode: '100644', path: 'src/large.bin', size: 3_000_000_000, sha: 'large-sha' };
    mocks.openSnapshot.mockResolvedValue({
      entries: [entry, ignored],
      readBlob: mocks.readBlob,
      release: mocks.release,
    });

    const result = await resolveCompanyProjectRepository(makeDb(), board, {
      companyId: 'company-1', workspaceId: 'workspace-1',
    });

    expect(result).toEqual({ type: 'inline', files: { 'README.md': 'hello' }, expectedFileCount: 1 });
    expect(mocks.readBlob).toHaveBeenCalledOnce();
    expect(mocks.readBlob).toHaveBeenCalledWith(entry);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
