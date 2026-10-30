import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { activityLog, companySkills, companySkillSources, projectSkillSources, projects, type Db } from '@paperclipai/db';
import { authorizationService, projectReadSqlCondition, type AuthorizationActor } from './authorization.js';
import { notFound } from '../errors.js';

// Carries the authenticated identity through shared services, including native API dispatch.
// Background operations must install their stored, revalidated setup identity explicitly.
const actors = new AsyncLocalStorage<AuthorizationActor>();
export const currentSkillActor = () => actors.getStore();
export function withSkillActor<T>(actor: AuthorizationActor, operation: () => T): T {
  return actors.run(actor, operation);
}
export const skillAccessRequestContext: RequestHandler = (req, _res, next) => withSkillActor(req.actor, next);

export function skillAccessService(db: Db, actor = currentSkillActor()) {
  function canReadCompany(companyId: string) {
    return actor?.type !== 'none' && !(actor?.type === 'agent' && actor.companyId !== companyId)
      && !(actor?.type === 'board' && actor.companyIds && !actor.companyIds.includes(companyId)
        && actor.source !== 'local_implicit' && !actor.isInstanceAdmin);
  }
  async function projectIds(companyId: string, sourceId?: string) {
    const bindings = await db.select({ sourceId: projectSkillSources.sourceId, projectId: projectSkillSources.projectId })
      .from(projectSkillSources).where(and(eq(projectSkillSources.companyId, companyId), isNotNull(projectSkillSources.sourceId),
        ...(sourceId ? [eq(projectSkillSources.sourceId, sourceId)] : [])));
    if (!actor) return bindings;
    const access = authorizationService(db);
    const ids = [...new Set(bindings.map(binding => binding.projectId))];
    const decisions = await access.decideReads(actor, ids.map(projectId => ({ type: 'project', companyId, projectId })));
    const allowed = new Set(ids.filter((_, index) => decisions[index]?.allowed));
    return bindings.filter(binding => allowed.has(binding.projectId));
  }
  async function visibleSourceIds(companyId: string) {
    if (!canReadCompany(companyId)) return [];
    if (!actor) return null;
    const sources = await db.select({ id: companySkillSources.id, scope: companySkillSources.accessScope })
      .from(companySkillSources).where(eq(companySkillSources.companyId, companyId));
    const permitted = new Set((await projectIds(companyId)).map(binding => binding.sourceId));
    return sources.filter(source => source.scope === 'company' || permitted.has(source.id)).map(source => source.id);
  }
  async function condition(companyId: string) {
    if (!canReadCompany(companyId)) return sql`false`;
    const ids = await visibleSourceIds(companyId);
    if (ids === null) return sql`true`;
    return or(isNull(companySkills.accessSourceId), ids.length ? inArray(companySkills.accessSourceId, ids) : sql`false`)!;
  }
  async function assertSkill(companyId: string, skillId: string) {
    const [row] = await db.select({ id: companySkills.id }).from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skillId), await condition(companyId)));
    if (!row) throw notFound('Skill not found');
  }
  async function assertSource(companyId: string, sourceId: string) {
    const ids = await visibleSourceIds(companyId);
    if (ids !== null && !ids.includes(sourceId)) throw notFound('Skill source not found');
  }
  async function activityCondition(companyId: string) {
    if (!actor) return sql<boolean>`true`;
    const ids = await visibleSourceIds(companyId);
    const skillCondition = await condition(companyId);
    const projectCondition = await projectReadSqlCondition(db, actor);
    return sql<boolean>`(
      (${activityLog.entityType} != 'company_skill' or exists (
        select 1 from ${companySkills} where ${companySkills.companyId} = ${companyId}
          and ${companySkills.id}::text = ${activityLog.entityId} and ${skillCondition}))
      and (${activityLog.entityType} != 'company_skill_source' or ${ids?.length ? inArray(activityLog.entityId, ids) : sql`false`})
      and (${activityLog.entityType} != 'project' or exists (
        select 1 from ${projects} where ${projects.companyId} = ${companyId}
          and ${projects.id}::text = ${activityLog.entityId} and ${projectCondition})))`;
  }
  return { canReadCompany, condition, projectIds, visibleSourceIds, assertSkill, assertSource, activityCondition };
}

/** Independent editable forks retain the originating project set at creation.
 * Membership/visibility remain dynamic; later repository attachments grant no access.
 */
export async function retainProjectSkillAccess(db: Db, companyId: string, sourceId: string | null | undefined) {
  if (!sourceId) return null;
  return db.transaction(async tx => {
    const [source] = await tx.select().from(companySkillSources).where(and(
      eq(companySkillSources.companyId, companyId), eq(companySkillSources.id, sourceId)));
    if (!source || source.removedAt || source.accessScope !== 'projects') return sourceId;
    const origins = await tx.select({ projectId: projectSkillSources.projectId }).from(projectSkillSources)
      .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, sourceId)));
    const id = randomUUID();
    await tx.insert(companySkillSources).values({ id, companyId, repositoryId: source.repositoryId,
      repositoryUrl: source.repositoryUrl, fullName: source.fullName, trackingRef: source.trackingRef,
      accessScope: 'projects', removedAt: new Date(), enabled: false, automaticUpdates: false });
    const projectIds = [...new Set(origins.map(origin => origin.projectId))];
    if (projectIds.length) await tx.insert(projectSkillSources).values(projectIds.map(projectId => ({
      companyId, projectId, sourceId: id, repositoryUrl: source.repositoryUrl, trackingRef: source.trackingRef,
      active: false, status: 'ready' as const,
    })));
    return id;
  });
}
