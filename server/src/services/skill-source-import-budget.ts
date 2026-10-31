import { and, eq, isNull, sql } from 'drizzle-orm';
import { companySkillImportBudgets, projectSkillSources, type Db } from '@paperclipai/db';
import { conflict, tooManyRequests } from '../errors.js';
import { automaticSkillWorkAvailable, automaticSkillWorkRefund, AUTOMATIC_SKILL_WORK_CAPACITY_BYTES,
  AUTOMATIC_SKILL_WORK_RESERVATION_BYTES, REFILL_WINDOW_MS } from './skill-source-refresh-budget.js';

/** Reserve before provider work; failed attempts retain their reservation. */
export async function reserveInitialSkillWork(db: Db, binding: typeof projectSkillSources.$inferSelect, token: string, now: Date) {
  await db.transaction(async tx => {
    const [current] = await tx.select({ id: projectSkillSources.id }).from(projectSkillSources).where(and(
      eq(projectSkillSources.companyId, binding.companyId), eq(projectSkillSources.id, binding.id),
      eq(projectSkillSources.leaseToken, token), eq(projectSkillSources.active, true), isNull(projectSkillSources.sourceId))).for('no key update');
    if (!current) throw conflict('Repository import changed. Retry from Skills.');
    await tx.insert(companySkillImportBudgets).values({ companyId: binding.companyId, updatedAt: now }).onConflictDoNothing();
    const [budget] = await tx.select().from(companySkillImportBudgets).where(eq(companySkillImportBudgets.companyId, binding.companyId)).for('update');
    const effectiveNow = new Date(Math.max(now.getTime(), budget!.updatedAt.getTime()));
    const available = automaticSkillWorkAvailable(budget!.availableBytes, budget!.updatedAt, effectiveNow);
    if (available < AUTOMATIC_SKILL_WORK_RESERVATION_BYTES) throw tooManyRequests('Automatic repository import is temporarily limited. It will resume when work credits refill.', {
      code: 'skill_source_initial_work_limited',
      retryAfterMs: Math.ceil((AUTOMATIC_SKILL_WORK_RESERVATION_BYTES - available) * REFILL_WINDOW_MS / AUTOMATIC_SKILL_WORK_CAPACITY_BYTES),
    });
    await tx.update(companySkillImportBudgets).set({ availableBytes: available - AUTOMATIC_SKILL_WORK_RESERVATION_BYTES, updatedAt: effectiveNow })
      .where(eq(companySkillImportBudgets.companyId, binding.companyId));
  });
}

/** Called once, inside the transaction that successfully links the binding. */
export async function settleInitialSkillWork(db: Db, companyId: string, work: { downloadBytes?: number; scanBytes?: number }) {
  const refund = automaticSkillWorkRefund(work);
  if (refund) await db.update(companySkillImportBudgets).set({ availableBytes: sql`least(${AUTOMATIC_SKILL_WORK_CAPACITY_BYTES}, ${companySkillImportBudgets.availableBytes} + ${refund})` })
    .where(eq(companySkillImportBudgets.companyId, companyId));
}
