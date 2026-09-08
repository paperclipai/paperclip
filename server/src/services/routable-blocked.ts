import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

/**
 * Single source of truth for the `blockedTransitionAt` stamp. Every write
 * site that can leave a row in `status: "blocked"` — a fresh transition into
 * blocked, a born-blocked insert, an import, or any other write that
 * happens to land on an already-blocked-but-unstamped row (e.g. an
 * `unblockDescriptor` added after the fact) — must run the row's current
 * stamp through this helper instead of stamping ad hoc.
 *
 * Idempotent by design: a row that already carries a stamp gets back an
 * empty patch, so calling this unconditionally on every write to a blocked
 * row is always safe and self-heals rows that were born blocked without one
 * (`create()`, `importIssues()`, and the heartbeat pre-dispatch guard all
 * bypassed the only stamping logic, which lived in `update()` and only
 * fired on a transition, never on an already-blocked row).
 *
 * Reserved for self-heal sites specifically. A fresh transition into
 * `blocked` must NOT go through this helper — see the entry branch in
 * `issues.ts`'s `update()`, which stamps unconditionally instead, because
 * `blockedTransitionAt` doubles as the dependency-wakeup cycle key and a
 * stale stamp surviving an exit must never be reused on the next entry.
 */
export function deriveBlockedEntryPatch(
  currentBlockedTransitionAt: Date | null | undefined,
  now: Date,
): { blockedTransitionAt: Date } | Record<string, never> {
  if (currentBlockedTransitionAt) return {};
  return { blockedTransitionAt: now };
}

/**
 * The patch every write must apply when a row leaves `status: "blocked"`,
 * whichever writer performs the transition. Centralised so `unblockDescriptor`
 * can never again be stranded on a non-blocked row: `update()`'s own exit
 * branch and `issuesSvc.checkout()`'s raw re-assignment write both spread
 * this in, instead of each independently deciding which fields to clear
 * (`checkout()` did not clear these before this fix, so a row a Board
 * member had just parked with an `unblockDescriptor` could be silently
 * flipped back to `in_progress` by a dependency-wakeup race while keeping
 * the stale descriptor — a shape the public API itself rejects on write,
 * `routes/issues.ts`'s `unblockDescriptor requires blocked status` check,
 * but which this internal path was free to produce because it never ran
 * through that guard).
 */
export const BLOCKED_EXIT_PATCH = {
  unblockDescriptor: null,
  blockedTransitionAt: null,
  blockedOwnerNotifiedAt: null,
} as const;

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
