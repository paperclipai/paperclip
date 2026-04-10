import type { agents } from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";

export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;

export interface HeartbeatPolicy {
  enabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
  maxConcurrentRuns: number;
}

export interface WakeGateResult {
  allowed: boolean;
  reason?: string;
}

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect): HeartbeatPolicy {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, true),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(
      heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation,
      true,
    ),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
  };
}

export function normalizeMaxConcurrentRuns(value: unknown): number {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

export function checkAgentStatusGate(
  agent: { status: string },
): WakeGateResult {
  if (
    agent.status === "paused" ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    return { allowed: false, reason: "Agent is not invokable in its current state" };
  }
  return { allowed: true };
}

export function checkHeartbeatPolicyGate(
  policy: HeartbeatPolicy,
  source: string,
): WakeGateResult {
  if (source === "timer" && !policy.enabled) {
    return { allowed: false, reason: "heartbeat.disabled" };
  }
  if (source !== "timer" && !policy.wakeOnDemand) {
    return { allowed: false, reason: "heartbeat.wakeOnDemand.disabled" };
  }
  return { allowed: true };
}

export function checkConcurrentRunGate(
  runningCount: number,
  policy: HeartbeatPolicy,
): WakeGateResult {
  if (runningCount >= policy.maxConcurrentRuns) {
    return {
      allowed: false,
      reason: `heartbeat.max_concurrent_runs_reached (${runningCount}/${policy.maxConcurrentRuns})`,
    };
  }
  return { allowed: true };
}

export function checkIntervalGate(
  lastHeartbeatAt: Date | null,
  createdAt: Date,
  intervalSec: number,
  now: Date = new Date(),
): WakeGateResult {
  if (intervalSec <= 0) return { allowed: true };

  const baseline = new Date(lastHeartbeatAt ?? createdAt).getTime();
  const elapsedMs = now.getTime() - baseline;

  if (elapsedMs < intervalSec * 1000) {
    return { allowed: false, reason: "heartbeat.interval_not_elapsed" };
  }
  return { allowed: true };
}
