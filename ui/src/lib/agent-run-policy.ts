function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    if (normalized === "1") return true;
    if (normalized === "0") return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export interface AgentRunPolicy {
  heartbeatEnabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
  hasTimerHeartbeat: boolean;
}

export function getAgentRunPolicy(runtimeConfig: unknown): AgentRunPolicy {
  const config = asRecord(runtimeConfig);
  const heartbeat = asRecord(config?.heartbeat);
  const heartbeatEnabled = asBoolean(heartbeat?.enabled, true);
  const intervalSec = Math.max(0, asNumber(heartbeat?.intervalSec, 0));
  const wakeOnDemand = asBoolean(
    heartbeat?.wakeOnDemand ??
      heartbeat?.wakeOnAssignment ??
      heartbeat?.wakeOnOnDemand ??
      heartbeat?.wakeOnAutomation,
    true,
  );

  return {
    heartbeatEnabled,
    intervalSec,
    wakeOnDemand,
    hasTimerHeartbeat: heartbeatEnabled && intervalSec > 0,
  };
}
