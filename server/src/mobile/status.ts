import type {
  MobileAgentStatus,
  MobileIssueRow,
  MobileIssueStatus,
  MobileSummary,
} from "./types.js";

const normalizeInput = (status: unknown): string =>
  typeof status === "string" ? status.trim().toLowerCase() : "";

export const normalizeIssueStatus = (status: unknown): MobileIssueStatus => {
  switch (normalizeInput(status)) {
    case "in_progress":
    case "running":
    case "active":
      return "running";
    case "blocked":
    case "error":
      return "blocked";
    case "done":
    case "closed":
    case "completed":
      return "done";
    default:
      return "review_needed";
  }
};

export const normalizeAgentStatus = (status: unknown): MobileAgentStatus => {
  switch (normalizeInput(status)) {
    case "running":
    case "working":
      return "running";
    case "error":
    case "failed":
      return "error";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
};

export const buildMobileSummary = (issues: MobileIssueRow[]): MobileSummary => {
  const counts = {
    running: 0,
    reviewNeeded: 0,
    blocked: 0,
    done: 0,
  };

  for (const issue of issues) {
    switch (issue.status) {
      case "running":
        counts.running += 1;
        break;
      case "review_needed":
        counts.reviewNeeded += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "done":
        counts.done += 1;
        break;
    }
  }

  return {
    health: counts.blocked > 0 ? "degraded" : "ok",
    counts,
    latestReport: null,
  };
};
