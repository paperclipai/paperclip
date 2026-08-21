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

  // DEPTH CAP (2026-08-19, board-shipped): title-keyed dedupe cannot see CHAINS —
  // 9 Postiz roots spawned 25 uniquely-titled meta descendants in one night
  // (recover(X) -> "Unblock: inspect recover(X)" -> recover(that) ...), each title
  // distinct so every layer minted. A meta card ABOUT a meta card carries no new
  // information: the root already has its recovery card. Policy: if this mint's
  // SUBJECT is itself a meta card (by origin issue, or by the identifier embedded
  // in the generated title), suppress the mint entirely — callers already treat
  // terminal_suppressed as do-not-mint.
  const META_TITLE = /^(Recover (missing next step|stalled issue)|Unblock:)/;
  if (META_TITLE.test(input.title)) {
    let subject: { id: string; status: string; title: string } | null = null;
    if (input.originId) {
      const originRows = await db
        .select({ id: issues.id, status: issues.status, title: issues.title })
        .from(issues)
        .where(eq(issues.id, input.originId))
        .limit(1);
      subject = originRows[0] ?? null;
    }
    if (!subject) {
      const embedded = input.title.match(/\b([A-Z]{2,4}-\d{3,6})\b/);
      if (embedded) {
        const bySlug = await db
          .select({ id: issues.id, status: issues.status, title: issues.title })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), eq(issues.identifier, embedded[1]!)))
          .limit(1);
        subject = bySlug[0] ?? null;
      }
    }
    if (subject && META_TITLE.test(subject.title)) {
      return { outcome: "terminal_suppressed", issue: { id: subject.id, status: subject.status } };
    }
    // A terminal subject needs no recovery either — the work it recovered is over.
    if (subject && (subject.status === "done" || subject.status === "cancelled")) {
      return { outcome: "terminal_suppressed", issue: { id: subject.id, status: subject.status } };
    }
  }

  // 2026-08-22 ISSUE-SCOPED UNBLOCK REUSE: Unblock titles embed the lane's
  // free-prose blocker text, so exact-title reuse below never matched a
  // reworded blocker — 59 Unblock cards minted in one day for what were
  // largely the same stuck issues (the intake-vs-close ledger's #2 factory,
  // same failure shape as the guard-courier ref-drift). Policy: ONE open
  // Unblock card per source issue, ever — a new blocker statement lands on
  // the existing card, not a sibling. Title identity still governs the other
  // meta classes.
  if (/^Unblock:/.test(input.title) && input.originId) {
    const openForIssue = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originId, input.originId),
        visibleIssueCondition(),
        ...(input.excludeIssueId ? [ne(issues.id, input.excludeIssueId)] : []),
        inArray(issues.status, [...REUSABLE_META_ISSUE_STATUSES]),
      ))
      .orderBy(desc(issues.createdAt))
      .limit(5)
      .then((rows) => rows.find((r) => /^Unblock:/.test(r.title)) ?? null);
    if (openForIssue) return { outcome: "reuse_open", issue: openForIssue };
  }

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
