/** The lifecycle controls admission. Execution status describes current work. */
export const AGENT_LIFECYCLE_STATES = [
  "pending_approval", "preparing", "verifying", "ready", "pausing", "paused",
  "resuming", "terminating", "cleaning_up", "terminated", "rejected",
] as const;
export type AgentLifecycleState = typeof AGENT_LIFECYCLE_STATES[number];

export interface AgentLifecycleOperation {
  id: string;
  resumeState?: "preparing" | "verifying" | "ready";
  hostComplete: boolean;
  completedPluginIds: string[];
  leaseOwner?: string;
  leaseUntil?: string;
  /** The controller process holding the lease; restart recovery settles it once proven gone. */
  leaseHolder?: { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };
  retryAt?: string;
  /** Healthy host verification awaits a durable external producer, not a retry timer. */
  waitingForSignal?: boolean;
  /** A committed recheck raced an active host attempt; its defer must not park it. */
  recheckRequested?: boolean;
  /** A failed configuration check waits for configuration repair or an explicit retry. */
  retryRequired?: boolean;
  /** Failed generic host verification tests for this saved configuration. */
  verificationFailures?: number;
  attempts: number;
  responsibleUserId?: string | null;
  /** Why a pause started: its holds and the company's pause reason at that moment. Runs the
   * pause stops record it, so a budget resume continues only work its own budget stopped. */
  pauseCause?: { holds: string[]; companyPauseReason: string | null };
}

export interface AgentLifecycleRequest {
  companyId: string;
  agentId: string;
  operationId: string;
  version: number;
  phase: AgentLifecycleState;
  instanceSecrets?: Record<string, string>;
}
export interface AgentLifecycleResult {
  operationId: string;
  version: number;
  status: "complete" | "pending";
  instanceSecrets?: Record<string, string | null>;
}
