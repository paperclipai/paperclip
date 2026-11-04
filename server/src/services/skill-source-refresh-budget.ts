import { and, eq, sql } from 'drizzle-orm';
import { companySkillSources, type Db } from '@paperclipai/db';
import { conflict, tooManyRequests } from '../errors.js';

export const AUTOMATIC_SKILL_WORK_CAPACITY_BYTES = 512 * 1024 * 1024;
export const AUTOMATIC_SKILL_WORK_RESERVATION_BYTES = 128 * 1024 * 1024;
export const REFILL_WINDOW_MS = 60 * 60_000;

export function automaticSkillWorkAvailable(bytes: number, updatedAt: Date, now: Date) {
  const elapsed = Math.max(0, now.getTime() - updatedAt.getTime());
  return Math.min(AUTOMATIC_SKILL_WORK_CAPACITY_BYTES,
    bytes + Math.floor(Math.min(elapsed, REFILL_WINDOW_MS) * AUTOMATIC_SKILL_WORK_CAPACITY_BYTES / REFILL_WINDOW_MS));
}
export function automaticSkillWorkRefund(work: { downloadBytes?: number; scanBytes?: number }) {
  return AUTOMATIC_SKILL_WORK_RESERVATION_BYTES - Math.ceil(Math.min(AUTOMATIC_SKILL_WORK_RESERVATION_BYTES,
    Math.max(work.downloadBytes ?? AUTOMATIC_SKILL_WORK_RESERVATION_BYTES, work.scanBytes ?? AUTOMATIC_SKILL_WORK_RESERVATION_BYTES, 0)));
}

/** The refresh lease serializes this durable token bucket across workers/restarts. */
export async function reserveAutomaticSkillWork(db: Db, source: typeof companySkillSources.$inferSelect, token: string, now: Date) {
  const effectiveNow = new Date(Math.max(now.getTime(), source.automaticBudgetAt.getTime()));
  const available = automaticSkillWorkAvailable(source.automaticBudgetBytes, source.automaticBudgetAt, effectiveNow);
  if (available < AUTOMATIC_SKILL_WORK_RESERVATION_BYTES) {
    throw tooManyRequests('Automatic refresh is temporarily limited. Use Refresh now, or wait for automatic updates to resume.', {
      code: 'skill_source_automatic_work_limited',
      retryAfterSeconds: Math.ceil((AUTOMATIC_SKILL_WORK_RESERVATION_BYTES - available) * REFILL_WINDOW_MS / AUTOMATIC_SKILL_WORK_CAPACITY_BYTES / 1000),
    });
  }
  const changed = await db.update(companySkillSources).set({ automaticBudgetAt: effectiveNow,
    automaticBudgetBytes: available - AUTOMATIC_SKILL_WORK_RESERVATION_BYTES })
    .where(and(eq(companySkillSources.companyId, source.companyId), eq(companySkillSources.id, source.id),
      eq(companySkillSources.leaseToken, token))).returning({ id: companySkillSources.id });
  if (!changed.length) throw conflict('Source refresh changed. Try again.');
}

/** Small repositories refund unused capacity; failures keep the bounded reservation. */
export async function settleAutomaticSkillWork(db: Db, companyId: string, sourceId: string, token: string,
  work: { downloadBytes?: number; scanBytes?: number }) {
  const refund = automaticSkillWorkRefund(work);
  if (!refund) return;
  await db.update(companySkillSources).set({ automaticBudgetBytes: sql`least(${AUTOMATIC_SKILL_WORK_CAPACITY_BYTES}, ${companySkillSources.automaticBudgetBytes} + ${refund})` })
    .where(and(eq(companySkillSources.companyId, companyId), eq(companySkillSources.id, sourceId), eq(companySkillSources.leaseToken, token)));
}
