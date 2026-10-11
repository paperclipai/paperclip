import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import type { issues } from "@paperclipai/db";

/**
 * The authority a chat-bound task executes under. Admitting a sponsored guest
 * stamps the task with the low-trust preset. Promoting that task's output
 * changes its disposition, not its execution lane, so the lane is a property
 * of the task and not of whoever spoke last.
 */
export type ChatTrustLane = "guest" | "verified";

export function chatTrustLaneOfIssue(
  issue: Pick<typeof issues.$inferSelect, "sourceTrust">,
): ChatTrustLane {
  return issue.sourceTrust?.preset === LOW_TRUST_REVIEW_PRESET
    ? "guest"
    : "verified";
}

/** Bound on how many other participants one verified-lane admission will vet. */
export const TRUST_LANE_AUDIENCE_MAX_PRINCIPALS = 25;

/** Newest conversations of one thread that a command considers. */
export const TRUST_LANE_THREAD_ROWS_MAX = 50;

export const TRUST_LANE_AUDIENCE_NOTICE =
  "I can't run this request in this thread because it includes participants who aren't linked to a Paperclip account, and my replies would be visible to them. Start a new thread or send a direct message to continue.";

/**
 * The task a command or Stop in a native thread acts on: the invoker's own
 * lane, newest first. A verified invoker may fall back to the newest guest
 * task. A guest never reaches a verified task.
 */
export function invokerLaneRow<
  Row extends { issue: Pick<typeof issues.$inferSelect, "sourceTrust"> },
>(rowsNewestFirst: Row[], invokerVerified: boolean): Row | null {
  const own = rowsNewestFirst.find(
    (row) =>
      (chatTrustLaneOfIssue(row.issue) === "verified") === invokerVerified,
  );
  return own ?? (invokerVerified ? (rowsNewestFirst[0] ?? null) : null);
}
