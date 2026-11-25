import { agents } from "@paperclipai/db";
import { asBoolean, parseObject } from "../adapters/utils.js";

/**
 * Direct Runner work needs a task. A pool can dispatch a company heartbeat
 * through its member harness without a task owner.
 */
type UnscopedHeartbeatAgent = Pick<typeof agents.$inferSelect, "adapterType">
  & Partial<Pick<typeof agents.$inferSelect, "runtimeConfig">>;

export function supportsUnscopedHeartbeat(agent: UnscopedHeartbeatAgent) {
  return agent.adapterType !== "paperclip_runner" || Boolean(parseObject(agent.runtimeConfig).harnessPool);
}

export function supportsUnscopedTimerHeartbeat(agent: UnscopedHeartbeatAgent) {
  return supportsUnscopedHeartbeat(agent);
}

export function isHeartbeatWakeOnDemandEnabled(
  agent: Pick<typeof agents.$inferSelect, "runtimeConfig">,
) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return asBoolean(
    heartbeat.wakeOnDemand ??
      heartbeat.wakeOnAssignment ??
      heartbeat.wakeOnOnDemand ??
      heartbeat.wakeOnAutomation,
    true,
  );
}
