import type { IssueWriteDenialCode, IssueWriteDenialContext } from "@paperclipai/shared";

/**
 * Map the activity events the server writes when it refuses an issue write onto
 * the shared denial copy contract (the open cross-task write design (failure UX)).
 *
 * These are the denials that leave a durable trace on the task, so they are the
 * ones the board can read after the fact — the agent already saw the same words
 * in the API error body.
 */
const DENIAL_ACTIVITY_CODES: Record<string, IssueWriteDenialCode> = {
  "issue.cross_issue_influence_cap_rejected": "cross_issue_influence_cap_exceeded",
  // `issue.issue_create_cap_rejected` is deliberately absent. Those rows are keyed on
  // the heartbeat run, not an issue, because the charge is taken before the insert and
  // there is no task id yet — so they never appear in the issue activity this mapping
  // feeds. Add them here together with a surface that reads run activity.
  "issue.attribution_spoof_rejected": "issue_write_attribution_spoof_rejected",
};

export function issueWriteDenialForActivity(
  action: string,
  details: Record<string, unknown> | null | undefined,
  labels: Pick<IssueWriteDenialContext, "actorLabel" | "assigneeLabel" | "responsibleUserName"> = {},
): { code: IssueWriteDenialCode; context: IssueWriteDenialContext } | null {
  const code = DENIAL_ACTIVITY_CODES[action];
  if (!code) return null;
  return {
    code,
    context: {
      ...labels,
      issueIdentifier: typeof details?.identifier === "string" ? details.identifier : null,
      cap: typeof details?.cap === "number" ? details.cap : null,
      count: typeof details?.count === "number" ? details.count : null,
      enforceAt: typeof details?.enforceAt === "string" ? details.enforceAt : null,
    },
  };
}
