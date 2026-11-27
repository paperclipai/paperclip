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
  /** Whether the board can ask the agent to compact now. */
  compaction?: IssueContextCompaction;
}

/** "Compact now" state for the task's assignee session. */
export interface IssueContextCompaction {
  status: "available" | "pending" | "unavailable";
  reasonCode: "no_assignee" | "task_closed" | "unsupported" | "agent_busy" | null;
  /** Why compaction is unavailable, in words the board can act on. */
  reason: string | null;
  /** The queued or running compaction run while pending. */
  runId?: string;
}
