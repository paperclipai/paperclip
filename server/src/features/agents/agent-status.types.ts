export const AGENT_STATUSES = [
  "available",
  "tokens_low",
  "tokens_empty",
  "rate_limited",
  "unavailable",
  "unknown",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export function normalizeAgentStatus(value: unknown): AgentStatus {
  return typeof value === "string" && AGENT_STATUSES.includes(value as AgentStatus)
    ? value as AgentStatus
    : "unknown";
}
