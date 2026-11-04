import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { companies, companySkillSources, projectSkillSources, type Db } from '@paperclipai/db';
import type { DeadlineReconciliationSnapshot } from './deadline-reconciliation.js';
import { idleDeadlineRowLimit, type IdleDeadlineSnapshot } from './idle-deadline-types.js';
import { MAX_COMPANY_PENDING_SKILL_IMPORTS, MAX_PROJECT_PENDING_SKILL_IMPORTS, SKILL_IMPORT_CAPACITY_WAIT } from './skill-source-import-queue.js';

type Binding = Pick<typeof projectSkillSources.$inferSelect, 'id' | 'companyId' | 'projectId' | 'workspaceId' | 'active' | 'status' | 'lastError' | 'nextSyncAt' | 'leaseToken' | 'leaseExpiresAt'>;
type Source = Pick<typeof companySkillSources.$inferSelect, 'id' | 'companyId' | 'revision' | 'accessScope' | 'nextSyncAt' | 'leaseToken' | 'leaseExpiresAt'>;

/** Pure interpretation of the same durable owners used by the sync worker. */
export function skillSourceIdleSchedule(bindings: Binding[], sources: Source[], now: number): IdleDeadlineSnapshot {
  let blocked = !Number.isFinite(now) || bindings.length > idleDeadlineRowLimit || sources.length > idleDeadlineRowLimit;
  const deadlines: number[] = [];
  const active = bindings.filter(binding => binding.active);
  function deadline(row: Binding | Source) {
    const next = row.nextSyncAt?.getTime();
    const lease = row.leaseExpiresAt?.getTime();
    if (!Number.isFinite(next) || Boolean(row.leaseToken) !== (row.leaseExpiresAt !== null)
      || (row.leaseToken !== null && (!row.leaseToken || !Number.isFinite(lease)))) { blocked = true; return; }
    const at = Math.max(next, lease ?? next);
    if (at <= now) blocked = true;
    else deadlines.push(at);
  }
  for (const binding of bindings) {
    if (!['pending', 'error'].includes(binding.status)) blocked = true;
    if (binding.active) deadline(binding);
    else {
      // Waiting admission has no independent timer. Only a full queue with
      // represented active work can safely defer it to that work's next wake.
      if (!binding.workspaceId || binding.status !== 'pending' || binding.lastError !== SKILL_IMPORT_CAPACITY_WAIT
        || binding.leaseToken !== null || binding.leaseExpiresAt !== null) blocked = true;
      const peers = active.filter(row => row.companyId === binding.companyId);
      if (peers.length < MAX_COMPANY_PENDING_SKILL_IMPORTS
        && peers.filter(row => row.projectId === binding.projectId).length < MAX_PROJECT_PENDING_SKILL_IMPORTS) blocked = true;
    }
  }
  for (const source of sources) {
    if (!['company', 'projects'].includes(source.accessScope)) blocked = true;
    deadline(source);
  }
  return { blocked, state: { bindings, sources }, deadlines };
}

/** Caller supplies its owned repeatable-read transaction; no provider reads. */
export async function readIdleSkillSourceSchedule(db: Pick<Db, 'select'>, now: number,
  reconciliationSnapshot: () => DeadlineReconciliationSnapshot): Promise<IdleDeadlineSnapshot> {
  const before = reconciliationSnapshot();
  if (!before.reconciled) return { blocked: true, state: { reconciliation: before }, deadlines: [] };
  const bindings = await db.select({ id: projectSkillSources.id, companyId: projectSkillSources.companyId,
    projectId: projectSkillSources.projectId, workspaceId: projectSkillSources.workspaceId, active: projectSkillSources.active,
    status: projectSkillSources.status, lastError: projectSkillSources.lastError, nextSyncAt: projectSkillSources.nextSyncAt,
    leaseToken: projectSkillSources.leaseToken, leaseExpiresAt: projectSkillSources.leaseExpiresAt }).from(projectSkillSources)
    .innerJoin(companies, and(eq(companies.id, projectSkillSources.companyId), eq(companies.status, 'active')))
    .where(and(isNull(projectSkillSources.sourceId), or(eq(projectSkillSources.active, true),
      and(eq(projectSkillSources.status, 'pending'), eq(projectSkillSources.lastError, SKILL_IMPORT_CAPACITY_WAIT), isNotNull(projectSkillSources.workspaceId)))))
    .orderBy(asc(projectSkillSources.id)).limit(idleDeadlineRowLimit + 1);
  const sources = await db.select({ id: companySkillSources.id, companyId: companySkillSources.companyId,
    revision: companySkillSources.revision, accessScope: companySkillSources.accessScope, nextSyncAt: companySkillSources.nextSyncAt,
    leaseToken: companySkillSources.leaseToken, leaseExpiresAt: companySkillSources.leaseExpiresAt }).from(companySkillSources)
    .innerJoin(companies, and(eq(companies.id, companySkillSources.companyId), eq(companies.status, 'active')))
    .where(and(eq(companySkillSources.enabled, true), eq(companySkillSources.automaticUpdates, true),
      or(sql`${companySkillSources.accessScope} <> 'projects'`, sql`exists (select 1 from ${projectSkillSources} b
        where b.source_id = ${companySkillSources.id} and b.company_id = ${companySkillSources.companyId} and b.active)`)))
    .orderBy(asc(companySkillSources.id)).limit(idleDeadlineRowLimit + 1);
  const after = reconciliationSnapshot();
  const snapshot = skillSourceIdleSchedule(bindings, sources, now);
  return { ...snapshot, blocked: snapshot.blocked || !after.reconciled || before.revision !== after.revision,
    state: { durable: snapshot.state, reconciliation: before } };
}
