import { companies, statusCards, statusCardUpdates, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { statusCardRefreshPolicySchema } from "@paperclipai/shared";
import type { DeadlineReconciliationSnapshot } from "./deadline-reconciliation.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";

export type IdleStatusCardRow = {
  id: string; companyId: string; companyStatus: string; revision: string;
  archivedAt: Date | null; generatingIssueId: string | null; unfinishedUpdate: boolean;
  state: string; refreshPolicy: unknown; nextEvalAt: Date | null; nextEvalReason: string | null;
  pendingChangeCount: number; compiled: boolean;
};

export function projectIdleStatusCardSchedule(rows: IdleStatusCardRow[], now: number, enabled: boolean | null): IdleDeadlineSnapshot {
  const state = { enabled, rows };
  const deadlines: number[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (enabled === null || !Number.isFinite(now) || rows.length > idleDeadlineRowLimit) return blocked();
  for (const card of rows) {
    if (card.generatingIssueId || card.unfinishedUpdate !== false) return blocked();
    if (enabled && !["active", "paused", "archived"].includes(card.companyStatus)) return blocked();
    if (!enabled || card.archivedAt || card.companyStatus !== "active") continue;
    const policy = statusCardRefreshPolicySchema.safeParse(card.refreshPolicy);
    if (!policy.success || !["compiling", "active", "error", "paused_budget", "paused_hours"].includes(card.state)) return blocked();
    if (card.nextEvalAt) {
      const at = card.nextEvalAt.getTime();
      if (!isFutureIdleDeadline(at, now)
        || (card.nextEvalReason !== null && !["membership", "policy", "retry", "refresh"].includes(card.nextEvalReason))) return blocked();
      deadlines.push(at);
    } else if (card.nextEvalReason !== null || card.state === "compiling"
      || (policy.data.mode !== "manual" && card.state !== "error"
        && (!card.compiled || policy.data.mode === "interval" || card.pendingChangeCount > 0
          || card.state === "paused_budget" || card.state === "paused_hours"))) return blocked();
  }
  return { blocked: false, state, deadlines };
}

export async function readIdleStatusCardSchedule(tx: Pick<Db, "select">, now: number,
  enabled: boolean | null, owner: () => DeadlineReconciliationSnapshot): Promise<IdleDeadlineSnapshot> {
  const before = owner();
  if (!before.reconciled) return { blocked: true, state: before, deadlines: [] };
  const rows = await tx.select({
    id: statusCards.id, companyId: statusCards.companyId, companyStatus: companies.status,
    revision: sql<string>`${statusCards}.xmin::text`, archivedAt: statusCards.archivedAt,
    generatingIssueId: statusCards.generatingIssueId, state: statusCards.state,
    refreshPolicy: statusCards.refreshPolicy, nextEvalAt: statusCards.nextEvalAt,
    nextEvalReason: statusCards.nextEvalReason, pendingChangeCount: statusCards.pendingChangeCount,
    compiled: sql<boolean>`jsonb_array_length(${statusCards.queries}) > 0`,
    unfinishedUpdate: sql<boolean>`EXISTS (SELECT 1 FROM ${statusCardUpdates}
      WHERE ${statusCardUpdates.cardId} = ${statusCards.id}
      AND (${statusCardUpdates.status} = 'running' OR ${statusCardUpdates.finishedAt} IS NULL))`,
  }).from(statusCards).innerJoin(companies, eq(companies.id, statusCards.companyId))
    .orderBy(statusCards.id).limit(idleDeadlineRowLimit + 1);
  const snapshot = projectIdleStatusCardSchedule(rows, now, enabled);
  const after = owner();
  return { ...snapshot, blocked: snapshot.blocked || !after.reconciled || after.revision !== before.revision,
    state: { owner: before, cards: snapshot.state } };
}
