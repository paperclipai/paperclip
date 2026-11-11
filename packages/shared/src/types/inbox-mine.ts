import type { HeartbeatRun } from "./heartbeat.js";
import type { CompactIssue } from "./issue.js";

export interface InboxSourceError {
  status: number;
  message: string;
}

/** The initial Mine rows and their structural context share one reveal boundary. */
export interface InboxMineSnapshot {
  userId: string;
  issues: CompactIssue[];
  contextIssues: CompactIssue[];
  failureRuns: HeartbeatRun[];
  /** Includes missing tasks whose rich read completed successfully. */
  failureIssueIds: string[];
  failureError?: InboxSourceError;
  contextError?: InboxSourceError;
}
