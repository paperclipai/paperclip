import { agents } from "@paperclipai/db";
import { asBoolean, parseObject } from "../adapters/utils.js";

/** Native task execution needs a task; Pool can dispatch company heartbeats through its member harness.
 * Task-bound schedules, monitors and external-provider assignments use their
 * existing wake paths and are unaffected by this interval policy.
 */
export function supportsUnscopedTimerHeartbeat(
  agent: Pick<typeof agents.$inferSelect, "adapterType"> & Partial<Pick<typeof agents.$inferSelect, "runtimeConfig">>,
) {
  return agent.adapterType !== "paperclip_runner" || Boolean(parseObject(agent.runtimeConfig).harnessPool);
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
