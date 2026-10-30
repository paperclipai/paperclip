import { agents } from "@paperclipai/db";
import { asBoolean, parseObject } from "../adapters/utils.js";

/** Runner work needs a task; generic interval heartbeats have no task owner.
 * Task-bound schedules, monitors and external-provider assignments use their
 * existing wake paths and are unaffected by this interval policy.
 */
export function supportsUnscopedTimerHeartbeat(
  agent: Pick<typeof agents.$inferSelect, "adapterType">,
) {
  return agent.adapterType !== "paperclip_runner";
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
