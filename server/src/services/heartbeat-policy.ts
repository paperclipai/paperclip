import { agents } from "@paperclipai/db";
import { asBoolean, parseObject } from "../adapters/utils.js";

/** Runner work needs a task; unscoped heartbeats (timer or manual) have no task owner.
 * Task-bound schedules, monitors and external-provider assignments use their
 * existing wake paths and are unaffected by this policy.
 */
export function supportsUnscopedHeartbeat(
  agent: Pick<typeof agents.$inferSelect, "adapterType">,
) {
  return agent.adapterType !== "paperclip_runner";
}

export function supportsUnscopedTimerHeartbeat(
  agent: Pick<typeof agents.$inferSelect, "adapterType">,
) {
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
