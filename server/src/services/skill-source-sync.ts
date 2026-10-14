import { lockProjectRootMutation } from './projects.js';
import { reserveInitialSkillWork, settleInitialSkillWork } from './skill-source-import-budget.js';
import { admitDeferredSkillImports, lockSkillImportQueue, SKILL_IMPORT_CAPACITY_WAIT } from './skill-source-import-queue.js';
import { randomUUID } from 'node:crypto';
import { skillSourceRetryAt } from './skill-source-retry.js';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { activityLog, agents, authUsers, heartbeatRuns, companies, companyMemberships, companySkillSources, companySkillSourceEntries,
  projectSkillSources, projectWorkspaces, projects, type Db } from '@paperclipai/db';
import type { ProjectSkillRepository } from '@paperclipai/shared';
import { authorizationService, type AuthorizationActor } from './authorization.js';
import { skillSourceGitHubReader } from './skill-source-github-access.js';
import { skillSourceService, type SkillSourceContext } from './skill-sources.js';
import { scanGitHubSkillsWithPackageFallback } from './github-skill-source.js';
import { companySkillPolicyService } from './company-skill-policy.js';
import { persistActivity, publishActivity } from './activity-log.js';
import type { ActivityPublication } from './activity-log.js';
import { currentSkillActor, skillAccessService } from './skill-access.js';
import { enqueueProjectSkillSource, projectSkillRepository, projectSkillSetupIdentity } from './project-skill-source-bindings.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { loadConfig } from '../config.js';

export const SKILL_SOURCE_REFRESH_MS = 5 * 60_000;
type Setup = { companyId: string; refreshUserId: string | null; refreshAgentId: string | null;
  refreshLocalTrusted: boolean; refreshGrantId: string | null; connectionId: string | null };

export async function projectSkillRepositories(db: Db, companyId: string, actor: AuthorizationActor): Promise<ProjectSkillRepository[]> {
  const rows = await db.select({ workspace: projectWorkspaces, project: projects }).from(projectWorkspaces)
    .innerJoin(projects, and(eq(projects.id, projectWorkspaces.projectId), eq(projects.companyId, companyId)))
    .where(eq(projectWorkspaces.companyId, companyId)).orderBy(asc(projects.name), asc(projectWorkspaces.name));
  const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, companyId));
  const removed = new Set((await db.select({ id: companySkillSources.id }).from(companySkillSources)
    .where(and(eq(companySkillSources.companyId, companyId), sql`${companySkillSources.removedAt} is not null`))).map(source => source.id));
  const allowed = new Map<string, boolean>();
  const access = authorizationService(db);
  const result: ProjectSkillRepository[] = [];
  for (const { workspace, project } of rows) {
    const repo = projectSkillRepository(workspace);
    if (!repo) continue;
    if (!allowed.has(project.id)) allowed.set(project.id, (await access.decide({ actor, action: 'project:read',
      resource: { type: 'project', companyId, projectId: project.id } })).allowed);
    if (!allowed.get(project.id)) continue;
    const binding = bindings.find(item => (item.active || (!item.sourceId && item.lastError !== null)) && item.workspaceId === workspace.id && item.repositoryUrl === repo.repositoryUrl && item.trackingRef === repo.trackingRef);
    result.push({ projectId: project.id, projectName: project.name, projectVisibility: project.visibility as 'open' | 'private',
      workspaceId: workspace.id, ...repo, bindingId: binding?.id ?? null, sourceId: binding?.sourceId && !removed.has(binding.sourceId) ? binding.sourceId : null,
      status: binding?.sourceId && removed.has(binding.sourceId) ? 'available' : binding?.status ?? 'available', lastError: binding?.lastError ?? null });
  }
  return result;
}

export async function adoptProjectSkillRepository(db: Db, companyId: string, workspaceId: string, authorize: SkillSourceContext['authorize']) {
  const actor = currentSkillActor();
  if (!actor) throw forbidden('Authentication required');
  const [workspace] = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.id, workspaceId)));
  if (!workspace || !(await authorizationService(db).decide({ actor, action: 'project:read', resource: { type: 'project', companyId, projectId: workspace.projectId } })).allowed) throw notFound('Project repository not found');
  const repository = projectSkillRepository(workspace);
  if (!repository) throw notFound('Project repository not found');
  await authorize('skills.import', { sourceType: 'git', sourceLocator: repository.repositoryUrl });
  return db.transaction(async tx => {
    const database = tx as unknown as Db;
    // Follow the editor: root provenance, project, workspace, then queue/binding.
    const project = await lockProjectRootMutation(tx, workspace.projectId);
    if (!project || project.companyId !== companyId) throw notFound('Project repository not found');
    const [currentWorkspace] = await tx.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, project.id), eq(projectWorkspaces.id, workspaceId))).for('update');
    if (!currentWorkspace) throw notFound('Project repository not found');
    const currentRepository = projectSkillRepository(currentWorkspace);
    if (!currentRepository || currentRepository.repositoryUrl !== repository.repositoryUrl || currentRepository.trackingRef !== repository.trackingRef) {
      throw conflict('Project repository changed. Reload Sources and try again.');
    }
    if (!(await authorizationService(database).decide({ actor, action: 'project:read', resource: { type: 'project', companyId, projectId: project.id } })).allowed) throw notFound('Project repository not found');
    // Capture the setup before the company queue, consistently with attachment.
    const setup = await projectSkillSetupIdentity(database, companyId);
    await lockSkillImportQueue(database, companyId);
    const [previous] = await tx.select({ bindingId: projectSkillSources.id, removedAt: companySkillSources.removedAt })
      .from(projectSkillSources).innerJoin(companySkillSources, eq(companySkillSources.id, projectSkillSources.sourceId))
      .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.workspaceId, workspace.id),
        eq(projectSkillSources.repositoryUrl, repository.repositoryUrl), eq(projectSkillSources.trackingRef, repository.trackingRef)))
      .for('update');
    if (previous?.removedAt) {
      // Retain the original project's access provenance, but free this workspace
      // for a new tracking identity. Never attach new readers to retained copies.
      await tx.update(projectSkillSources).set({ workspaceId: null, active: false })
        .where(eq(projectSkillSources.id, previous.bindingId));
    }
    const binding = await enqueueProjectSkillSource(database, currentWorkspace, setup);
    if (!binding) throw notFound('Project repository not found');
    if (!binding.sourceId) await tx.update(projectSkillSources).set({ status: 'pending', nextSyncAt: new Date(), failureCount: 0, lastError: binding.lastError === SKILL_IMPORT_CAPACITY_WAIT ? SKILL_IMPORT_CAPACITY_WAIT : null,
      ...setup,
    }).where(eq(projectSkillSources.id, binding.id));
    const { publication } = await persistActivity(database, { companyId, actorType: actor.type === 'agent' ? 'agent' : 'user',
      actorId: actor.agentId ?? actor.userId ?? 'board', agentId: actor.agentId, runId: actor.runId,
      action: 'project.skills_import_requested', entityType: 'project', entityId: workspace.projectId, details: { workspaceId, bindingId: binding.id } });
    // Publish only after the transaction completes (caller's route refreshes query state).
    return { bindingId: binding.id, publication };
  });
}

function setupActor(setup: Setup): AuthorizationActor {
  return setup.refreshAgentId ? { type: 'agent', agentId: setup.refreshAgentId, companyId: setup.companyId,
    onBehalfOfUserId: setup.refreshUserId === 'local-board' ? null : setup.refreshUserId, source: 'agent_key' }
    : { type: 'board', userId: setup.refreshUserId, source: setup.refreshLocalTrusted ? 'local_implicit' : 'session', companyIds: [setup.companyId] };
}
async function setupContext(db: Db, setup: Setup): Promise<SkillSourceContext> {
  if (!setup.refreshUserId && !setup.refreshLocalTrusted) throw forbidden('Choose a GitHub connection to enable automatic updates.');
  if (!setup.refreshLocalTrusted) {
    const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(
      eq(companyMemberships.companyId, setup.companyId), eq(companyMemberships.principalType, 'user'),
      eq(companyMemberships.principalId, setup.refreshUserId!), eq(companyMemberships.status, 'active')));
    if (!member) throw forbidden('The person who connected this source no longer has company access. Choose another GitHub connection.');
  }
  if (setup.refreshAgentId) {
    const [agent] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.companyId, setup.companyId), eq(agents.id, setup.refreshAgentId)));
    if (!agent || agent.status === 'terminated') throw forbidden('The agent who connected this source is unavailable. Choose a GitHub connection.');
  }
  if (setup.refreshAgentId && (!setup.connectionId || !setup.refreshGrantId)) throw forbidden('Choose a GitHub connection to authorize this agent-created repository.');
  const readerActor: AuthorizationActor = { type: 'board', userId: setup.refreshUserId,
    source: setup.refreshLocalTrusted ? 'local_implicit' : 'session', companyIds: [setup.companyId] };
  const actor = setupActor(setup);
  const access = authorizationService(db), policies = companySkillPolicyService(db);
  const principal = setup.refreshAgentId ? await policies.resolveAgentPrincipal(setup.companyId, setup.refreshAgentId)
    : { type: 'board' as const, id: setup.refreshUserId ?? 'board', role: 'board' };
  const readers = new Map<string, ReturnType<typeof skillSourceGitHubReader>>();
  const publications: ActivityPublication[] = [];
  return {
    actor: { type: 'system', userId: setup.refreshUserId, agentId: setup.refreshAgentId },
    setup: { userId: setup.refreshUserId, agentId: setup.refreshAgentId, localTrusted: setup.refreshLocalTrusted, grantId: setup.refreshGrantId },
    read: connectionId => {
      const key = connectionId ?? '';
      for (const reader of readers.values()) if (reader.connectionId && reader.connectionId === connectionId) return reader;
      if (!readers.has(key)) readers.set(key, skillSourceGitHubReader(db, setup.companyId, readerActor as Parameters<typeof skillSourceGitHubReader>[2], connectionId, { grantId: setup.refreshGrantId }));
      return readers.get(key)!;
    },
    authorize: async (action, resource) => {
      const platform = await access.decide({ actor, action: 'skill_config:update', resource: { type: 'company', companyId: setup.companyId } });
      if (!platform.allowed && !['deny_no_grant', 'deny_missing_consent', 'deny_missing_grant'].includes(platform.reason)) throw forbidden('Automatic skill updates are unavailable for the setup identity.');
      if (resource.skillId) await skillAccessService(db, actor).assertSkill(setup.companyId, resource.skillId);
      const decision = await policies.evaluate({ companyId: setup.companyId, principal, action, resource });
      if (!decision.allowed) throw forbidden('Automatic skill updates are denied by company policy.');
    },
    audit: async (tx, sourceId, action, details) => {
      const { publication } = await persistActivity(tx as unknown as Db, { companyId: setup.companyId, actorType: 'system', actorId: 'skill-source-sync',
        agentId: setup.refreshAgentId, action, entityType: 'company_skill_source', entityId: sourceId,
        details: { ...details, refreshUserId: setup.refreshUserId } });
      publications.push(publication);
    },
    publishCommittedActivity: () => { for (const publication of publications.splice(0)) publishActivity(publication); },
  };
}

export function skillSourceSyncService(db: Db, options: { context?: (setup: Setup) => Promise<SkillSourceContext> } = {}) {
  const contextFor = options.context ?? (setup => setupContext(db, setup));
  const sources = skillSourceService(db);
  let running: Promise<{ imported: number; checked: number }> | null = null;
  const shutdown = new AbortController();

  async function recoverSetup(source: typeof companySkillSources.$inferSelect) {
    if (source.refreshUserId || source.refreshLocalTrusted || source.refreshAgentId) return source;
    const installed = await db.select({ id: companySkillSourceEntries.skillId }).from(companySkillSourceEntries)
      .where(and(eq(companySkillSourceEntries.companyId, source.companyId), eq(companySkillSourceEntries.sourceId, source.id)));
    const skillIds = installed.map(entry => entry.id).filter((id): id is string => Boolean(id));
    const [event] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, source.companyId),
      or(eq(activityLog.actorType, 'user'), and(eq(activityLog.actorType, 'agent'), isNotNull(activityLog.runId))),
      inArray(activityLog.action, ['company.skill_source_refreshed', 'company.skill_imported', 'company.skills_imported']),
      or(eq(activityLog.entityId, source.id), ...(skillIds.length ? [inArray(activityLog.entityId, skillIds)] : []))))
      .orderBy(asc(activityLog.createdAt)).limit(1);
    if (!event || !event.actorId || event.actorId === 'board') return source;
    let userId = event.actorId;
    if (event.actorType === 'agent') {
      const [run] = await db.select({ userId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, event.runId!),
        eq(heartbeatRuns.agentId, event.agentId ?? event.actorId)));
      if (!run?.userId) return source;
      userId = run.userId;
    }
    if (!userId) return source;
    const localTrusted = userId === 'local-board' && loadConfig().deploymentMode === 'local_trusted';
    const [updated] = await db.update(companySkillSources).set({ refreshUserId: userId,
      refreshAgentId: event.actorType === 'agent' ? event.agentId ?? event.actorId : null,
      refreshLocalTrusted: localTrusted,
    }).where(and(eq(companySkillSources.id, source.id), isNull(companySkillSources.refreshUserId))).returning();
    return updated ?? (await db.select().from(companySkillSources).where(eq(companySkillSources.id, source.id)))[0]!;
  }

  async function importBinding(binding: typeof projectSkillSources.$inferSelect, now: Date) {
    const token = randomUUID();
    const [claimed] = await db.update(projectSkillSources).set({ leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000) })
      .where(and(eq(projectSkillSources.id, binding.id), eq(projectSkillSources.active, true), isNull(projectSkillSources.sourceId),
        or(isNull(projectSkillSources.leaseToken), lte(projectSkillSources.leaseExpiresAt, now)))).returning();
    if (!claimed) return false;
    try {
      if (!options.context) {
        const actor = setupActor(binding);
        if (!(await authorizationService(db).decide({ actor, action: 'project:read', resource: { type: 'project', companyId: binding.companyId, projectId: binding.projectId } })).allowed) throw forbidden('Project access changed. Choose an authorized GitHub connection to retry.');
      }
      const context = await contextFor(binding);
      await context.authorize('skills.import', { sourceType: 'git', sourceLocator: binding.repositoryUrl });
      await reserveInitialSkillWork(db, binding, token, now);
      const reader = context.read(binding.connectionId);
      const scan = await scanGitHubSkillsWithPackageFallback({ repositoryUrl: binding.repositoryUrl, trackingRef: binding.trackingRef, packageMode: 'repository' }, reader, { signal: shutdown.signal });
      const [existing] = await db.select().from(companySkillSources).where(and(eq(companySkillSources.companyId, binding.companyId),
        eq(companySkillSources.repositoryUrl, scan.repositoryUrl), eq(companySkillSources.trackingRef, binding.trackingRef), isNull(companySkillSources.removedAt)));
      let sourceId: string;
      if (existing) {
        await context.authorize('skills.import', { sourceType: 'git', sourceLocator: existing.repositoryUrl });
        sourceId = existing.id;
      } else {
        try {
          const result = await sources.create(binding.companyId, { repositoryUrl: scan.repositoryUrl, trackingRef: binding.trackingRef,
            commitSha: scan.commitSha, packageMode: scan.packageMode, selectedPaths: scan.candidates.map(candidate => candidate.path),
            connectionId: scan.connectionId ?? binding.connectionId }, { ...context, projectBindingId: binding.id, projectBindingLeaseToken: token }, scan);
          sourceId = result.source.id;
        } catch (error) {
          if (!(error instanceof Error && 'status' in error && error.status === 409)) throw error;
          const [concurrent] = await db.select().from(companySkillSources).where(and(eq(companySkillSources.companyId, binding.companyId), eq(companySkillSources.repositoryUrl, scan.repositoryUrl), eq(companySkillSources.trackingRef, binding.trackingRef), isNull(companySkillSources.removedAt)));
          if (!concurrent) throw error;
          sourceId = concurrent.id;
        }
      }
      return await db.transaction(async tx => {
        // Removal locks the source before its bindings. Follow the same order
        // and recheck provenance while that lock prevents concurrent removal.
        const [source] = await tx.select().from(companySkillSources).where(and(
          eq(companySkillSources.companyId, binding.companyId), eq(companySkillSources.id, sourceId))).for('update');
        if (!source || source.removedAt) throw conflict('Source was removed during import. Retry to start independent tracking.');
        const linked = await tx.update(projectSkillSources).set({ sourceId, status: 'ready', lastError: null, failureCount: 0, leaseToken: null, leaseExpiresAt: null })
          .where(and(eq(projectSkillSources.id, binding.id), eq(projectSkillSources.companyId, binding.companyId),
            eq(projectSkillSources.active, true), eq(projectSkillSources.leaseToken, token))).returning({ id: projectSkillSources.id });
        if (linked.length) await settleInitialSkillWork(tx as unknown as Db, binding.companyId, scan.packageMode === 'skills' ? {} : scan);
        return linked.length > 0;
      });
    } catch (error) {
      const message = shutdown.signal.aborted ? binding.lastError : error instanceof Error && 'status' in error ? error.message : 'Skill import failed. Retry from Skills.';
      await db.update(projectSkillSources).set({ status: shutdown.signal.aborted ? 'pending' : 'error', lastError: message, leaseToken: null, leaseExpiresAt: null,
        ...(error instanceof Error && 'status' in error && error.status === 403 ? { active: false } : {}),
        failureCount: shutdown.signal.aborted ? binding.failureCount : binding.failureCount + 1, nextSyncAt: shutdown.signal.aborted ? now : skillSourceRetryAt(error, binding.failureCount, now) })
        .where(and(eq(projectSkillSources.id, binding.id), eq(projectSkillSources.leaseToken, token)));
      return false;
    }
  }

  async function sweep(now: Date) {
    const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, 'active'));
    const ids = activeCompanies.map(company => company.id);
    if (!ids.length) return { imported: 0, checked: 0 };
    for (const id of ids) await admitDeferredSkillImports(db, id, now);
    const pending = await db.select().from(projectSkillSources).where(and(inArray(projectSkillSources.companyId, ids),
      eq(projectSkillSources.active, true), isNull(projectSkillSources.sourceId), lte(projectSkillSources.nextSyncAt, now),
      or(isNull(projectSkillSources.leaseToken), lte(projectSkillSources.leaseExpiresAt, now))))
      .orderBy(asc(projectSkillSources.nextSyncAt)).limit(10);
    let imported = 0, checked = 0;
    for (const binding of pending) { if (shutdown.signal.aborted) break; if (await importBinding(binding, now)) imported++; }
    const due = await db.select().from(companySkillSources).where(and(inArray(companySkillSources.companyId, ids),
      eq(companySkillSources.enabled, true), eq(companySkillSources.automaticUpdates, true), lte(companySkillSources.nextSyncAt, now),
      or(isNull(companySkillSources.leaseToken), lte(companySkillSources.leaseExpiresAt, now)),
      or(eq(companySkillSources.accessScope, 'company'), sql`exists (select 1 from ${projectSkillSources} b where b.source_id = ${companySkillSources.id} and b.company_id = ${companySkillSources.companyId} and b.active)`)))
      .orderBy(asc(companySkillSources.nextSyncAt)).limit(10);
    for (const entry of due) {
      if (shutdown.signal.aborted) break;
      const source = await recoverSetup(entry);
      try {
        const context = await contextFor(source);
        if (!options.context) {
          try { await skillAccessService(db, setupActor(source)).assertSource(source.companyId, source.id); }
          catch (error) {
            if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error;
            throw forbidden('The person who connected this source no longer has project access. Choose another GitHub connection.');
          }
        }
        await sources.refresh(source.companyId, source.id, context, undefined, undefined, { checkCommit: true, automatic: true, now, signal: shutdown.signal });
        checked++;
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 409) continue;
        // Failures in context or policy authorization precede the refresh lease.
        // Compare the attempt and revision so another worker's result wins.
        if (!shutdown.signal.aborted) {
          await db.update(companySkillSources).set({ lastError: error instanceof Error && 'status' in error ? error.message : 'Automatic update failed. The installed skills were kept.',
            failureCount: source.failureCount + 1, nextSyncAt: skillSourceRetryAt(error, source.failureCount, now), lastAttemptAt: now })
            .where(and(eq(companySkillSources.id, source.id), eq(companySkillSources.revision, source.revision),
              eq(companySkillSources.failureCount, source.failureCount),
              source.lastAttemptAt ? eq(companySkillSources.lastAttemptAt, source.lastAttemptAt) : isNull(companySkillSources.lastAttemptAt),
              or(isNull(companySkillSources.leaseToken), lte(companySkillSources.leaseExpiresAt, now))));
        }
      }
    }
    return { imported, checked };
  }
  async function refreshSource(companyId: string, sourceId: string, initiator: SkillSourceContext) {
    const [source] = await db.select().from(companySkillSources).where(and(eq(companySkillSources.companyId, companyId), eq(companySkillSources.id, sourceId)));
    if (!source) throw notFound('Skill source not found');
    await initiator.authorize('skills.update', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    if (!source.refreshUserId && !source.refreshLocalTrusted) return sources.refresh(companyId, sourceId, initiator);
    const setup = await contextFor(source);
    if (!options.context) {
      try { await skillAccessService(db, setupActor(source)).assertSource(companyId, sourceId); }
      catch (error) {
        if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error;
        throw forbidden('The person who connected this source no longer has project access. Choose another GitHub connection.');
      }
    }
    return sources.refresh(companyId, sourceId, { ...setup, actor: initiator.actor,
      publishCommittedActivity: initiator.publishCommittedActivity,
      authorize: async (action, resource) => { await initiator.authorize(action, resource); await setup.authorize(action, resource); },
      audit: async (tx, id, action, details) => initiator.audit(tx, id, action, { ...details, refreshUserId: source.refreshUserId }),
    });
  }
  function tick(now = new Date()) {
    if (shutdown.signal.aborted) return Promise.resolve({ imported: 0, checked: 0 });
    if (running) return running;
    running = sweep(now).finally(() => { running = null; });
    return running;
  }
  return { tick, refreshSource, stop: async () => { shutdown.abort(); await running; } };
}
