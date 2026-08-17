import { and, desc, eq, gt, inArray, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { visibleIssueCondition } from "./issue-visibility.js";

/**
 * TSMC-20961: platform-minted "meta" cards ("Unblock: ...", "Recover stalled
 * issue ...", "Recover missing next step ...") were re-minted per occurrence
 * (~68/day fleet-wide), drowning real work. The mint sites now reuse an
 * identical open card instead of creating a twin, and — modelled on
 * DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS in issue-dependency-wakeups.ts —
 * treat an identical card that just reached a terminal status as still
 * occupying the slot, so a close cannot trigger an immediate remint loop.
 * Suppression is recency-bounded: a genuinely new occurrence after the window
 * mints a fresh card.
 */
export const UNBLOCK_CARD_TERMINAL_SUPPRESSION_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_CARD_TERMINAL_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

export const REUSABLE_META_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "in_review",
] as const;

export type ReusableMetaIssueMatch =
  | { outcome: "reuse_open"; issue: typeof issues.$inferSelect }
  | { outcome: "terminal_suppressed"; issue: { id: string; status: string } };

export async function findReusableMetaIssue(
  db: Db,
  input: {
    companyId: string;
    /** The exact generated card title; mint sites are deterministic per occurrence class. */
    title: string;
    /** Prevents a same-titled source card from matching (and blocking on) itself. */
    excludeIssueId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    terminalSuppressionMs: number;
    now?: Date;
  },
): Promise<ReusableMetaIssueMatch | null> {
  const now = input.now ?? new Date();
  const identity = [
    eq(issues.companyId, input.companyId),
    eq(issues.title, input.title),
    visibleIssueCondition(),
    ...(input.excludeIssueId ? [ne(issues.id, input.excludeIssueId)] : []),
    ...(input.originKind ? [eq(issues.originKind, input.originKind)] : []),
    ...(input.originId ? [eq(issues.originId, input.originId)] : []),
  ];

  const open = await db
    .select()
    .from(issues)
    .where(and(...identity, inArray(issues.status, [...REUSABLE_META_ISSUE_STATUSES])))
    .orderBy(desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (open) return { outcome: "reuse_open", issue: open };

  // completedAt/cancelledAt are stamped by the status side effects in
  // issueService.update, so they mark the terminal transition itself; a
  // terminal row without its stamp cannot prove recency and does not suppress.
  const cutoff = new Date(now.getTime() - input.terminalSuppressionMs);
  const terminal = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(
      and(
        ...identity,
        or(
          and(eq(issues.status, "done"), gt(issues.completedAt, cutoff)),
          and(eq(issues.status, "cancelled"), gt(issues.cancelledAt, cutoff)),
        ),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (terminal) return { outcome: "terminal_suppressed", issue: terminal };

  return null;
}
