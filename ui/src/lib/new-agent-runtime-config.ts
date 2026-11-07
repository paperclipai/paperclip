import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  heartbeatEnabled?: boolean;
  intervalSec?: number;
  activeHours?: {
    start: string;
    end: string;
    timezone: string;
  } | null;
}): Record<string, unknown> {
  const enabled = input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled;
  const heartbeat: Record<string, unknown> = {
    enabled,
    intervalSec: input?.intervalSec ?? defaultCreateValues.intervalSec,
    wakeOnDemand: true,
    skipTimerWhenNoActionableWork: true,
    cooldownSec: 10,
    maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  };
  if (enabled && input?.activeHours) {
    heartbeat.activeHours = input.activeHours;
  }

  return { heartbeat };
}
