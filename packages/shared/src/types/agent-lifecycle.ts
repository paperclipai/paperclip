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
  retryAt?: string;
  attempts: number;
  responsibleUserId?: string | null;
}

export interface AgentLifecycleRequest {
  companyId: string;
  agentId: string;
  operationId: string;
  version: number;
  phase: AgentLifecycleState;
}
export interface AgentLifecycleResult {
  operationId: string;
  version: number;
  status: "complete" | "pending";
}
