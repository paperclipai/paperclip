import type { UsageSummary } from "@paperclipai/adapter-utils";

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
  | "cleared"
  | "error";

export interface CodexGoalSnapshot {
  threadId: string | null;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number | null;
  updatedAt: number | null;
  errorCode?: string | null;
  reason?: string | null;
}

export interface CodexAppServerRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  rawStderr: string;
  sessionId: string | null;
  summary: string;
  usage: UsageSummary;
  errorMessage: string | null;
}
