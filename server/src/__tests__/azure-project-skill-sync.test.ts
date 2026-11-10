import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  companies, companyMemberships, companySecrets, companySkillSources, companySkills,
  companySkillSourceEntries, connectionGrants, createDb, projectProviderAuthorizations, projectSkillSources,
  projectWorkspaces, projects, toolApplications, toolConnectionInstalls, toolConnections,
  userSecretDefinitions,
} from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import type { GitAuthInvocation } from '../services/git-credentials.js';
import type { GitSkillSnapshot } from '../services/skill-source-git-snapshot.js';
import type { SkillSourceContext } from '../services/skill-sources.js';
import type { AuthorizationActor } from '../services/authorization.js';
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_PAT_METHOD } from '../services/connectors/azure-devops/index.js';
import { resolveAzureDevOpsProjectGitCredentials } from '../services/azure-project-git-credentials.js';
import { adoptProjectSkillRepository, skillSourceSyncService } from '../services/skill-source-sync.js';
import { skillSourceService } from '../services/skill-sources.js';
import { withSkillActor } from '../services/skill-access.js';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const mocks = vi.hoisted(() => ({ openSnapshot: vi.fn(), readHead: vi.fn(), secrets: new Map<string, string>() }));
vi.mock('../services/skill-source-git-snapshot.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/skill-source-git-snapshot.js')>();
  return { ...actual, openGitSkillSnapshot: mocks.openSnapshot };
});
vi.mock('../services/azure-project-skill-head.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/azure-project-skill-head.js')>();
  return { ...actual, readAzureProjectSkillHead: mocks.readHead };
});
vi.mock('../services/secrets.js', () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => mocks.secrets.get(secretId) ?? '',
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: mocks.secrets.get(input.definitionId) ?? '' }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('Azure DevOps project skill source sync', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let projectId: string;
  let workspaceId: string;
  let grantId: string;
  let connectionId: string;
  let sourceId: string;
  let skillId: string;
  let secretValue: string;
  let oldPackageSetting: string | undefined;
  let snapshotText: string;
  let snapshotCommit: string;
  let snapshotOpenCount: number;
  let azureFetchCount: number;

  const repoUuid = '12345678-1234-1234-1234-1234567890ab';
  const repoUrl = 'https://dev.azure.com/contoso/Platform/_git/paperclip';
  const skillPath = 'skills/demo/SKILL.md';
  const blobSha = 'c'.repeat(40);
  const actor: AuthorizationActor = { type: 'board', userId: 'alice', source: 'session', companyIds: [] };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase('paperclip-azure-project-skill-sync-');
    db = createDb(database.connectionString);
  }, 30_000);

  beforeEach(async () => {
    mocks.secrets.clear();
    snapshotText = '---\nname: demo\ndescription: Azure skill fixture\n---\nVersion one.\n';
    snapshotCommit = 'a'.repeat(40);
    snapshotOpenCount = 0;
    azureFetchCount = 0;
    oldPackageSetting = process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;
    process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = 'false';

    [companyId] = (await db.insert(companies).values({
      name: `Azure skill sync ${crypto.randomUUID()}`,
      issuePrefix: crypto.randomUUID().slice(0, 8),
    }).returning({ id: companies.id })).map(row => row.id);
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: 'alice', membershipRole: 'admin', status: 'active' });
    [projectId] = (await db.insert(projects).values({ companyId, name: 'Azure skills project' }).returning({ id: projects.id })).map(row => row.id);
    [workspaceId] = (await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: 'Platform/paperclip',
      sourceType: 'git',
      repoUrl,
      defaultRef: 'main',
      metadata: { repositoryProvider: 'azure-devops', repositoryId: `azure-devops:contoso:${repoUuid}` },
      isPrimary: true,
    }).returning({ id: projectWorkspaces.id })).map(row => row.id);

    const [application] = await db.insert(toolApplications).values({
      companyId,
      name: `Azure DevOps ${crypto.randomUUID()}`,
      type: 'rest_api',
      applicationKey: `azure-devops-${crypto.randomUUID()}`,
    }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId,
      name: 'Azure DevOps PAT',
      key: `azure-pat-${crypto.randomUUID()}`,
    }).returning();
    secretValue = `azure-skill-secret-${crypto.randomUUID()}`;
    const [secret] = await db.insert(companySecrets).values({
      companyId,
      name: 'Azure DevOps PAT',
      key: `azure-pat-${crypto.randomUUID()}`,
      scope: 'user',
      ownerUserId: 'alice',
      userSecretDefinitionId: definition!.id,
    }).returning();
    mocks.secrets.set(secret!.id, secretValue);
    mocks.secrets.set(definition!.id, secretValue);
    const [connection] = await db.insert(toolConnections).values({
      companyId,
      applicationId: application!.id,
      name: 'Contoso Azure DevOps',
      uid: crypto.randomUUID(),
      transport: 'rest_api',
      authKind: 'api_key',
      credentialSource: 'paperclip_vault',
      credentialPolicy: 'per_user',
      status: 'active',
      enabled: true,
      config: { sourceTemplateKey: 'azure-devops', connectionMethodKey: AZURE_DEVOPS_PAT_METHOD, url: AZURE_DEVOPS_API_URL,
        methodConfig: { organization: 'contoso' } },
    }).returning();
    connectionId = connection!.id;
    const [grant] = await db.insert(connectionGrants).values({
      companyId,
      connectionId,
      kind: 'user',
      subjectUserId: 'alice',
      status: 'active',
      credentialSecretRefs: [{ secretId: secret!.id, configPath: 'credentials.authorization', versionSelector: 'latest' }],
    }).returning();
    grantId = grant!.id;
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: 'company', targetId: companyId });
    await db.insert(projectProviderAuthorizations).values({
      companyId, projectId, provider: 'azure-devops', scopeKey: 'contoso', grantId, authorizedByUserId: 'alice',
    });

    mocks.openSnapshot.mockImplementation(async (input: { token: string; providerAuth?: GitAuthInvocation }, _options: unknown) => {
      snapshotOpenCount++;
      expect(input.token).toBe('');
      expect(input.providerAuth?.repositoryAuthority).toEqual({ provider: 'azure-devops', url: repoUrl });
      const bytes = Buffer.from(snapshotText);
      const entry = { path: skillPath, type: 'blob', mode: '100644', sha: blobSha, size: bytes.length };
      const snapshot: GitSkillSnapshot = {
        commitSha: snapshotCommit,
        treeSha: 'b'.repeat(40),
        entries: [entry],
        readBlob: async () => bytes,
        readBlobs: async entries => new Map(entries.map(item => [item.sha, bytes])),
        release: vi.fn(async () => undefined),
      };
      return snapshot;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      azureFetchCount++;
      expect(String(input)).toBe('https://dev.azure.com/contoso/_apis/git/repositories?api-version=7.1');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from(`:${secretValue}`).toString('base64')}`);
      return Response.json({ value: [{ id: repoUuid, name: 'paperclip', project: { name: 'Platform' } }] });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.openSnapshot.mockReset();
    mocks.readHead.mockReset();
    mocks.secrets.clear();
    if (oldPackageSetting === undefined) delete process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;
    else process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = oldPackageSetting;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  function context(setup?: { refreshUserId: string | null; refreshAgentId: string | null; refreshLocalTrusted: boolean; refreshGrantId: string | null; connectionId: string | null; companyId: string }): SkillSourceContext {
    const reader = Object.assign(async () => ({}), { connectionId: setup?.connectionId ?? null, grantId: setup?.refreshGrantId ?? null });
    return {
      actor: { type: 'user', userId: 'alice' },
      setup: { userId: 'alice', agentId: null, localTrusted: false, grantId: setup?.refreshGrantId ?? grantId },
      read: () => reader as unknown as ReturnType<SkillSourceContext['read']>,
      authorize: async () => undefined,
      audit: async () => undefined,
    };
  }

  it('adopts the selected Azure project repository, scans a pinned snapshot, creates its skill, refreshes it, then fails closed after consent revocation', async () => {
    const setupActor: AuthorizationActor = { ...actor, companyIds: [companyId] };
    const adopted = await withSkillActor(setupActor, () => adoptProjectSkillRepository(db, companyId, workspaceId, async () => undefined));
    expect(adopted.bindingId).toBeTruthy();
    await db.update(projectSkillSources).set({ nextSyncAt: new Date(Date.now() - 10_000) }).where(eq(projectSkillSources.id, adopted.bindingId));

    const worker = skillSourceSyncService(db, { context: async setup => context(setup) });
    const imported = await worker.tick(new Date(Date.now() - 5_000));
    expect(imported.imported).toBe(1);
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, adopted.bindingId));
    expect(binding).toMatchObject({ status: 'ready', active: true });
    sourceId = binding!.sourceId!;
    const [source] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(source).toMatchObject({ repositoryUrl: repoUrl, repositoryId: `azure-devops:contoso:${repoUuid}`, accessScope: 'projects', connectionId, refreshGrantId: grantId });
    expect(snapshotOpenCount).toBe(1);
    expect(JSON.stringify(source)).not.toContain(secretValue);

    const [entry] = await db.select().from(companySkillSourceEntries).where(eq(companySkillSourceEntries.sourceId, sourceId));
    skillId = entry!.skillId!;
    const [createdSkill] = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(createdSkill).toMatchObject({ name: 'demo', sourceLocator: repoUrl, markdown: expect.stringContaining('Version one.') });
    expect(JSON.stringify(createdSkill)).not.toContain(secretValue);

    snapshotText = '---\nname: demo\ndescription: Azure skill fixture\n---\nVersion two.\n';
    snapshotCommit = 'd'.repeat(40);
    const service = skillSourceService(db);
    mocks.readHead.mockImplementation(async (database: ReturnType<typeof createDb>, input: { companyId: string; projectId: string; repoUrl: string; ref: string }) => {
      await resolveAzureDevOpsProjectGitCredentials(database, input);
      await resolveAzureDevOpsProjectGitCredentials(database, input);
      return { commitSha: snapshotCommit, ref: 'refs/heads/main' };
    });
    const fetchesBeforeChangedHead = azureFetchCount;
    const refreshed = await service.refresh(companyId, sourceId, context({ companyId, refreshUserId: 'alice', refreshAgentId: null,
      refreshLocalTrusted: false, refreshGrantId: grantId, connectionId }), undefined, undefined, { checkCommit: true });
    expect(refreshed.updated).toHaveLength(1);
    expect(mocks.readHead).toHaveBeenCalledOnce();
    expect(azureFetchCount - fetchesBeforeChangedHead).toBeGreaterThanOrEqual(5);
    const [updatedSkill] = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(updatedSkill).toMatchObject({ markdown: expect.stringContaining('Version two.'), sourceType: 'url' });
    expect(updatedSkill?.sourceRef).toBe(snapshotCommit);
    expect(snapshotOpenCount).toBe(2);
    const [refreshedSource] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(refreshedSource?.lastScanCommit).toBe(snapshotCommit);

    const snapshotsBeforeUnchanged = snapshotOpenCount;
    const fetchesBeforeUnchangedHead = azureFetchCount;
    const unchanged = await service.refresh(companyId, sourceId, context({ companyId, refreshUserId: 'alice', refreshAgentId: null,
      refreshLocalTrusted: false, refreshGrantId: grantId, connectionId }), undefined, undefined, { checkCommit: true });
    expect(unchanged.updated).toHaveLength(0);
    expect(unchanged.unchanged).toBe(1);
    expect(snapshotOpenCount).toBe(snapshotsBeforeUnchanged);
    expect(mocks.readHead).toHaveBeenCalledTimes(2);
    // Check the active project binding before and after the HEAD read; the test HEAD reader also revalidates twice.
    expect(azureFetchCount - fetchesBeforeUnchangedHead).toBe(4);

    const [activeProjectBinding] = await db.select().from(projectSkillSources).where(and(eq(projectSkillSources.projectId, projectId),
      eq(projectSkillSources.sourceId, sourceId), eq(projectSkillSources.active, true)));
    await db.update(projectSkillSources).set({ active: false }).where(eq(projectSkillSources.id, activeProjectBinding!.id));
    const headCallsBeforeInactiveBinding = mocks.readHead.mock.calls.length;
    await expect(service.refresh(companyId, sourceId, context({ companyId, refreshUserId: 'alice', refreshAgentId: null,
      refreshLocalTrusted: false, refreshGrantId: grantId, connectionId }), undefined, undefined, { checkCommit: true }))
      .rejects.toThrow(/authorization/i);
    expect(mocks.readHead).toHaveBeenCalledTimes(headCallsBeforeInactiveBinding);
    expect(snapshotOpenCount).toBe(snapshotsBeforeUnchanged);
    await db.update(projectSkillSources).set({ active: true }).where(eq(projectSkillSources.id, activeProjectBinding!.id));

    mocks.readHead.mockImplementation(async (database: ReturnType<typeof createDb>, input: { companyId: string; projectId: string; repoUrl: string; ref: string }) => {
      await resolveAzureDevOpsProjectGitCredentials(database, input);
      await db.delete(projectProviderAuthorizations).where(and(eq(projectProviderAuthorizations.projectId, projectId),
        eq(projectProviderAuthorizations.provider, 'azure-devops'), eq(projectProviderAuthorizations.scopeKey, 'contoso')));
      await resolveAzureDevOpsProjectGitCredentials(database, input);
      return { commitSha: snapshotCommit, ref: 'refs/heads/main' };
    });
    const snapshotsBeforeRevokedConsent = snapshotOpenCount;
    await expect(service.refresh(companyId, sourceId, context({ companyId, refreshUserId: 'alice', refreshAgentId: null,
      refreshLocalTrusted: false, refreshGrantId: grantId, connectionId }), undefined, undefined, { checkCommit: true }))
      .rejects.toThrow(/authorization/i);
    expect(snapshotOpenCount).toBe(snapshotsBeforeRevokedConsent);
    const [afterRevoke] = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(afterRevoke?.markdown).toContain('Version two.');
  }, 30_000);
});
