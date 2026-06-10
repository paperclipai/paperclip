import type { agents } from "@paperclipai/db";
import { parseObject, asNumber } from "../adapters/utils.js";

export const ASSIGNED_ISSUE_TIMEOUT_RETRY_COOLDOWN_SEC_DEFAULT = 60 * 60;

export function assignedIssueTimeoutRetryCooldownSec(agent: typeof agents.$inferSelect) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return Math.max(
    0,
    asNumber(
      heartbeat.assignedIssueTimeoutRetryCooldownSec ?? heartbeat.timeoutRetryCooldownSec,
      ASSIGNED_ISSUE_TIMEOUT_RETRY_COOLDOWN_SEC_DEFAULT,
    ),
  );
}
