/**
 * Latest context-window occupancy for the agent session working on a task,
 * read from the provider usage the runner recorded for the task's runs.
 */
export interface IssueContextUsage {
  runId: string;
  agentId: string;
  /** Normalized runner session the measurement belongs to. */
  sessionId: string | null;
  usedTokens: number;
  windowTokens: number;
  observedAt: string;
  /** Session totals when the provider reported non-zero counters. */
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
  /** Provider-reported session cost in USD, when non-zero. */
  costUsd: number | null;
  /** Compactions recorded for this session. */
  compactions: number;
}
