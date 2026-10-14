import { lockSkillImportQueue, MAX_COMPANY_PENDING_SKILL_IMPORTS, MAX_PROJECT_PENDING_SKILL_IMPORTS, SKILL_IMPORT_CAPACITY_WAIT } from './skill-source-import-queue.js';
import { and, eq, ne } from 'drizzle-orm';
import { projectSkillSources, type Db, projectWorkspaces } from '@paperclipai/db';
import { parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { currentSkillActor } from './skill-access.js';
import { captureRunIdentity } from './run-identity.js';
import { forbidden } from '../errors.js';

export async function projectSkillSetupIdentity(db: Db, companyId: string, actor = currentSkillActor()) {
  let userId = actor?.type === 'board' ? actor.userId ?? null : null;
  let connectionId: string | null = null, refreshGrantId: string | null = null;
  if (actor?.type === 'agent' && actor.source === 'agent_jwt') {
    if (!actor.runId || !actor.agentId || actor.companyId !== companyId) throw forbidden('Project skill setup requires an authenticated agent run.');
    const identity = await captureRunIdentity(db, { companyId, agentId: actor.agentId, runId: actor.runId });
    userId = identity.run.responsibleUserId;
    // Only reuse the connection already authorized by managed GitHub delivery
    // for this active run. Responsibility alone cannot discover another grant.
    if (identity.context?.github?.status === 'available') {
      connectionId = identity.context.github.connectionId ?? null;
      refreshGrantId = identity.context.github.grantId ?? null;
    }
  }
  // An API key can attach repositories, but cannot supply a setup person.
  // Keep the durable job so an authorized person can adopt it from Sources.
  return { refreshUserId: userId, refreshAgentId: actor?.type === 'agent' ? actor.agentId ?? null : null,
    refreshLocalTrusted: actor?.source === 'local_implicit' || userId === 'local-board', connectionId, refreshGrantId };
}

export function projectSkillRepository(workspace: Pick<typeof projectWorkspaces.$inferSelect, 'repoUrl' | 'defaultRef' | 'repoRef'>) {
  const url = workspace.repoUrl?.replace(/^git@github\.com:/i, 'https://github.com/');
  const parsed = url ? parseGitHubSkillRepositoryUrl(url) : null;
  if (!parsed) return null;
  return { repositoryUrl: parsed.repositoryUrl.toLowerCase(), trackingRef: workspace.defaultRef ?? workspace.repoRef ?? parsed.trackingRef ?? 'HEAD' };
}

/** Called inside the workspace mutation transaction; no provider calls here. */
export async function enqueueProjectSkillSource(db: Db, workspace: typeof projectWorkspaces.$inferSelect, setupIdentity?: Awaited<ReturnType<typeof projectSkillSetupIdentity>>) {
  return db.transaction(async tx => {
    const db = tx as unknown as Db;
    const repository = projectSkillRepository(workspace);
    const setup = repository ? setupIdentity ?? await projectSkillSetupIdentity(db, workspace.companyId) : undefined;
    const pending = await lockSkillImportQueue(db, workspace.companyId);
    await db.update(projectSkillSources).set({ active: false, lastError: null })
      .where(and(eq(projectSkillSources.companyId, workspace.companyId), eq(projectSkillSources.workspaceId, workspace.id),
        ...(repository ? [ne(projectSkillSources.trackingRef, repository.trackingRef)] : [])));
    if (!repository) return null;
    await db.update(projectSkillSources).set({ active: false, lastError: null })
      .where(and(eq(projectSkillSources.companyId, workspace.companyId), eq(projectSkillSources.workspaceId, workspace.id), ne(projectSkillSources.repositoryUrl, repository.repositoryUrl)));
    const [existing] = await db.select().from(projectSkillSources).where(and(eq(projectSkillSources.workspaceId, workspace.id),
      eq(projectSkillSources.repositoryUrl, repository.repositoryUrl), eq(projectSkillSources.trackingRef, repository.trackingRef)));
    const available = Boolean(existing?.sourceId || pending.some(row => row.id === existing?.id))
      || (pending.length < MAX_COMPANY_PENDING_SKILL_IMPORTS && pending.filter(row => row.projectId === workspace.projectId).length < MAX_PROJECT_PENDING_SKILL_IMPORTS);
    const [binding] = await db.insert(projectSkillSources).values({
      companyId: workspace.companyId, projectId: workspace.projectId, workspaceId: workspace.id, ...repository, nextSyncAt: new Date(),
      ...setup, active: available, lastError: available ? null : SKILL_IMPORT_CAPACITY_WAIT,
    }).onConflictDoUpdate({ target: [projectSkillSources.workspaceId, projectSkillSources.repositoryUrl, projectSkillSources.trackingRef],
      set: { active: available, lastError: available ? existing?.lastError === SKILL_IMPORT_CAPACITY_WAIT ? null : existing?.lastError : SKILL_IMPORT_CAPACITY_WAIT } }).returning();
    return binding!;
  });
}

export async function detachProjectSkillSource(db: Db, companyId: string, workspaceId: string) {
  await db.update(projectSkillSources).set({ active: false, lastError: null }).where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.workspaceId, workspaceId)));
}
