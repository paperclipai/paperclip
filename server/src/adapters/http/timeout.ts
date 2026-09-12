import { asNumber } from "../utils.js";

// Node holds a setTimeout delay in a 32-bit signed integer. It coerces a larger
// delay to 1ms, which would abort the request almost at once, so a longer
// configured timeout is held at this ceiling instead.
export const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve the http adapter request timeout, in milliseconds. `0` means no
 * timeout, which is the default and matches the process adapter.
 *
 * `timeoutSec` is the field the adapter documents in `agentConfigurationDoc`.
 * `timeoutMs` stays supported as an undocumented alias, and wins when it holds
 * a usable number. Both the adapter and the run stop metadata read the timeout
 * through here, so the recorded policy cannot drift from the timer that runs.
 */
export function resolveHttpTimeoutMs(config: Record<string, unknown>): number {
  const timeoutMs = asNumber(config.timeoutMs, asNumber(config.timeoutSec, 0) * 1000);
  if (!(timeoutMs > 0)) return 0;
  // Anything past this line is positive, so hold it at 1ms rather than let
  // flooring turn a sub-millisecond timeout into the no-timeout sentinel.
  return Math.min(Math.max(1, Math.floor(timeoutMs)), MAX_HTTP_TIMEOUT_MS);
}
