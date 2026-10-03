import type { Db } from "@paperclipai/db";
import {
  ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY,
  resolveAdapterRunTimeoutPolicy,
  type AdapterExecutionTargetTimeoutPolicy,
} from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Last successfully read `adapterRunTimeoutSec` value, reused when a settings
 * read throws. `undefined` means "never read successfully in this process",
 * which is the only state in which a read failure degrades to no policy.
 * A successful read that returns `null` overwrites the cache, so an operator
 * who removes the policy is not shadowed by a stale value during a later
 * outage.
 */
let lastKnownInstanceSec: number | null | undefined;

/**
 * Resolve the deployment-wide adapter run-timeout policy that the server hands
 * to every adapter invocation. This is what makes the run wall clock a single
 * company/instance value instead of N per-agent `adapterConfig.timeoutSec`
 * rows: agents that never configured a timeout inherit this one, and agents
 * that did keep winning because the per-agent value is the first rung of the
 * resolver's precedence chain.
 *
 * Layer precedence (highest first): per-agent config (resolved inside the
 * adapter), then the `adapterRunTimeoutSec` instance setting, then
 * `PAPERCLIP_ADAPTER_RUN_TIMEOUT_SEC`, then no policy at all — which keeps the
 * historical unlimited behavior for local/SSH runs instead of silently
 * time-limiting every never-configured agent.
 *
 * Fails open, but not to nothing: a settings read error must not block the
 * run, and it must not quietly delete the operator's wall clock either. The
 * last value read successfully is reused for the duration of the outage, so a
 * transient read failure degrades to a slightly stale policy instead of an
 * unbounded run. Only a cold start (no successful read yet) falls all the way
 * through to the env layer, and that case says so in the log.
 */
export async function readAdapterRunTimeoutPolicy(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<AdapterExecutionTargetTimeoutPolicy | null> {
  let instanceSec: number | null;
  try {
    instanceSec = (await instanceSettingsService(db).getGeneral()).adapterRunTimeoutSec ?? null;
    lastKnownInstanceSec = instanceSec;
  } catch (error) {
    // Deliberately not fatal: the run still has the per-agent timeout and the
    // env-var layer, and a settings outage must not take out every run. The
    // last known value is preferred over "no policy" so a read failure does not
    // silently un-time-limit agents the operator had bounded.
    instanceSec = lastKnownInstanceSec ?? null;
    logger.warn(
      { err: error, usedLastKnownValue: lastKnownInstanceSec !== undefined },
      lastKnownInstanceSec === undefined
        ? `failed to read the instance adapterRunTimeoutSec setting and no earlier read succeeded; this run falls back to ${ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY} and per-agent config, and may be unbounded`
        : `failed to read the instance adapterRunTimeoutSec setting; reusing the last value read for this process instead of dropping the operator's wall clock`,
    );
  }
  return resolveAdapterRunTimeoutPolicy({
    instanceSec,
    envSec: env[ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY] ?? null,
  });
}

/** Test seam for the last-known-good settings cache. */
export function resetAdapterRunTimeoutPolicyCache(): void {
  lastKnownInstanceSec = undefined;
}
