import type { Issue } from "@paperclipai/shared";

export const ISSUE_DETAIL_POLL_INTERVAL_MS = 15_000;
export const ISSUE_DETAIL_LIVE_RUN_POLL_INTERVAL_MS = 5_000;

export function getIssueDetailRefetchInterval(input: {
  isDocumentVisible: boolean;
  hasLiveRuns: boolean;
}): number | false {
  if (!input.isDocumentVisible) return false;
  return input.hasLiveRuns
    ? ISSUE_DETAIL_LIVE_RUN_POLL_INTERVAL_MS
    : ISSUE_DETAIL_POLL_INTERVAL_MS;
}

type IssueReadState = Pick<Issue, "id" | "isUnreadForMe" | "lastExternalCommentAt">;

export function getUnreadIssueReadVersion(issue: IssueReadState | null | undefined): string | null {
  if (!issue?.id || !issue.isUnreadForMe) return null;
  const lastExternalCommentAt = issue.lastExternalCommentAt instanceof Date
    ? issue.lastExternalCommentAt.toISOString()
    : "none";
  return `${issue.id}:${lastExternalCommentAt}`;
}
