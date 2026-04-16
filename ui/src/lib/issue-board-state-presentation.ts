import type { Issue, IssueBoardState } from "@paperclipai/shared";
import { createIssueDetailPath } from "./issueDetailBreadcrumb";

type Tone = {
  panelClassName: string;
  eyebrow: string;
  dotClassName: string;
  summaryClassName: string;
};

export function getIssueBoardStateTone(kind: IssueBoardState["kind"]): Tone {
  switch (kind) {
    case "blocked":
      return {
        panelClassName: "border-red-500/30 bg-red-500/8",
        eyebrow: "Blocked",
        dotClassName: "bg-red-500",
        summaryClassName: "text-red-600 dark:text-red-300",
      };
    case "redirected":
      return {
        panelClassName: "border-slate-500/25 bg-slate-500/8",
        eyebrow: "Redirected",
        dotClassName: "bg-slate-500",
        summaryClassName: "text-slate-600 dark:text-slate-300",
      };
    case "system_error":
      return {
        panelClassName: "border-amber-500/30 bg-amber-500/10",
        eyebrow: "System error",
        dotClassName: "bg-amber-400",
        summaryClassName: "text-amber-700 dark:text-amber-300",
      };
    case "waiting":
      return {
        panelClassName: "border-blue-500/25 bg-blue-500/8",
        eyebrow: "Waiting",
        dotClassName: "bg-blue-500",
        summaryClassName: "text-blue-600 dark:text-blue-300",
      };
    case "ready":
      return {
        panelClassName: "border-emerald-500/25 bg-emerald-500/8",
        eyebrow: "Ready",
        dotClassName: "bg-emerald-500",
        summaryClassName: "text-emerald-600 dark:text-emerald-300",
      };
    case "done":
    default:
      return {
        panelClassName: "border-border bg-card/70",
        eyebrow: "Done",
        dotClassName: "bg-muted-foreground/70",
        summaryClassName: "text-muted-foreground",
      };
  }
}

export function describeIssueBoardState(issue: Issue): string | null {
  const boardState = issue.boardState;
  if (!boardState) return null;

  switch (boardState.kind) {
    case "blocked":
      return "This issue is waiting on the root blocker below. Open it directly to resolve the real dependency.";
    case "redirected":
      return "This issue was superseded by a newer issue. Open the latest successor instead of continuing work here.";
    case "system_error":
      return "This issue is marked blocked without a linked blocker. Fix the issue state or add the missing dependency.";
    case "waiting":
      switch (boardState.reasonCode) {
        case "review":
          return "Review is the next gate on this issue. Open the issue state to see the latest QA or review context.";
        case "board_decision":
          return "A board decision is the next unblocker for this issue.";
        case "assignee_followup":
          return "The current assignee owns the next move on this issue.";
        case "recovery":
          return "Recovery is in progress for this issue. Inspect the recovery context before changing status.";
        default:
          return "This issue is waiting on a concrete next action.";
      }
    case "ready":
      return "No blocker is linked. This issue is ready for the next owner to pick up.";
    case "done":
    default:
      return "No immediate action is required.";
  }
}

export function resolveIssueBoardStateActionHref(issue: Issue): string | null {
  const action = issue.boardState?.primaryAction;
  if (!action) return null;
  if (action.targetEntity === "agent") {
    return `/agents/${action.targetId}`;
  }
  if (action.type === "open_blocker") {
    return createIssueDetailPath(issue.primaryBlocker?.identifier ?? action.targetId);
  }
  if (action.targetId !== issue.id) {
    return createIssueDetailPath(action.targetId);
  }
  return createIssueDetailPath(issue.identifier ?? action.targetId);
}
