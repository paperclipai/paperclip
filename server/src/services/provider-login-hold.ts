import type { Db } from "@paperclipai/db";
import type { heartbeatRuns } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { isAiAuthenticationFailure } from "./ai-auth-failure.js";

/**
 * Decision model for a future independently verified provider login failure.
 * Production admission is currently closed: there is no trusted source.
 *
 * Agents that use the same adapter and the same credential settings also use
 * the same provider login. An AI connection can resolve per responsible user,
 * so for those agents the responsible user is part of the lane. When that login fails,
 * every queued run in the lane fails the same way within seconds. One
 * authentication failure therefore holds the lane. Held runs stay `queued`.
 * Queue recovery claims them again later. One probe run is released after a
 * cooldown. A successful probe opens the lane. A failed probe holds it again
 * with a doubled cooldown. An agent whose login settings change gets a new lane
 * key, and its runs from before the change no longer count, so the repair is
 * not held.
 */

export type ProviderLoginHoldConfig = {
  disabled: boolean;
  baseCooldownMs: number;
  maxCooldownMs: number;
  windowMs: number;
  probeTimeoutMs: number;
};

export const PROVIDER_LOGIN_HOLD_DEFAULTS: ProviderLoginHoldConfig = {
  disabled: false,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 60 * 60_000,
  windowMs: 6 * 60 * 60_000,
  probeTimeoutMs: 10 * 60_000,
};

export function readProviderLoginHoldConfig(env: NodeJS.ProcessEnv = process.env): ProviderLoginHoldConfig {
  return {
    ...PROVIDER_LOGIN_HOLD_DEFAULTS,
    disabled: env.PAPERCLIP_PROVIDER_LOGIN_HOLD_DISABLED?.trim() === "true",
  };
}

export type LaneRun = {
  status: string;
  finishedAt: Date | null;
  errorCode: string | null;
  /** Only a trusted server source may set this; none currently exists. */
  verifiedLoginAbsent?: boolean;
};

export type ProviderLoginHoldDecision =
  | { hold: false; reason: "disabled" | "lane_open" | "probe_cooldown_elapsed"; probe?: boolean; failures?: number }
  | { hold: true; reason: "login_failed" | "probe_in_flight" | "probe_expired"; failures: number; errorCode: string; holdUntil: Date };

const FAILED_STATUSES = new Set(["failed", "timed_out"]);

/**
 * Decides the hold for one lane. `runs` are finished runs in the lane, newest
 * first. A succeeded run opens the lane. Failures that are not authentication
 * failures do not change the lane.
 */
export function decideProviderLoginHold(
  runs: LaneRun[],
  now: Date,
  config: ProviderLoginHoldConfig,
  state: { probe?: { grantedAt: Date; finished: boolean } | null } = {},
): ProviderLoginHoldDecision {
  if (config.disabled) return { hold: false, reason: "disabled" };
  const nowMs = now.getTime();
  let failures = 0;
  let newestFailureMs: number | null = null;
  let errorCode = "";
  for (const run of runs) {
    const finishedMs = run.finishedAt?.getTime() ?? null;
    if (finishedMs === null || finishedMs < nowMs - config.windowMs) break;
    if (finishedMs > nowMs) continue;
    if (run.status === "succeeded") break;
    if (!FAILED_STATUSES.has(run.status) || !isAiAuthenticationFailure(run.errorCode) || run.verifiedLoginAbsent !== true) continue;
    if (newestFailureMs === null) {
      newestFailureMs = finishedMs;
      errorCode = run.errorCode ?? "";
    }
    failures += 1;
  }
  if (newestFailureMs === null) return { hold: false, reason: "lane_open" };

  const cooldownMs = Math.min(config.baseCooldownMs * 2 ** Math.min(failures - 1, 20), config.maxCooldownMs);
  const holdUntilMs = newestFailureMs + cooldownMs;
  if (nowMs < holdUntilMs) {
    return { hold: true, reason: "login_failed", failures, errorCode, holdUntil: new Date(holdUntilMs) };
  }

  // Release one probe. Other runs wait until the probe finishes or times out.
  // Only the probe run itself ends the probe: another run of the lane that was
  // already running can finish while the probe is still in flight.
  const probeMs = state.probe?.grantedAt.getTime() ?? null;
  if (
    probeMs !== null &&
    probeMs > newestFailureMs &&
    !state.probe?.finished &&
    nowMs - probeMs < config.probeTimeoutMs
  ) {
    return { hold: true, reason: "probe_in_flight", failures, errorCode, holdUntil: new Date(probeMs + config.probeTimeoutMs) };
  }
  return { hold: false, reason: "probe_cooldown_elapsed", probe: true, failures };
}

// Settings that select which provider login an agent uses.
const CREDENTIAL_ENV_KEY = /(^|_)(HOME|CONFIG_DIR|API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN)$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Agents with the same key use the same provider login. */
export function providerLoginLaneKey(agent: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  runtimeConfig: Record<string, unknown> | null;
}): string {
  const env = record(record(agent.adapterConfig).env);
  const credentials = Object.keys(env)
    .filter((key) => CREDENTIAL_ENV_KEY.test(key))
    .sort()
    .map((key) => [key, env[key]]);
  return JSON.stringify([agent.adapterType, credentials, record(agent.runtimeConfig).aiConnection ?? null]);
}

/**
 * Whether a configuration revision changed the login an agent uses. Revision
 * snapshots redact secret values, so a change of a redacted credential cannot
 * be told apart from another adapter setting change; it counts as a login
 * change. One more failed run puts such an agent back on hold.
 */
export function loginSettingsChanged(revision: {
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
}): boolean {
  const key = (snapshot: Record<string, unknown>) => providerLoginLaneKey({
    adapterType: String(snapshot.adapterType ?? ""),
    adapterConfig: record(snapshot.adapterConfig),
    runtimeConfig: record(snapshot.runtimeConfig),
  });
  const before = key(revision.beforeConfig);
  if (before !== key(revision.afterConfig)) return true;
  return revision.changedKeys.includes("adapterConfig") && before.includes(REDACTED_EVENT_VALUE);
}

/**
 * Production admission is closed. Current execution modes let model tools
 * modify the login store, or have no proven isolation. Neither an auth code
 * nor adapter output/history is independent proof. Never read verification
 * from resultJson, configuration, or an agent API. A future source requires
 * a separately reviewed trust boundary. The pure decision function above is
 * exercised only with synthetic trusted runs.
 */
export function providerLoginHoldService(_db: Db, config: ProviderLoginHoldConfig = readProviderLoginHoldConfig()) {
  async function evaluate(
    _run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "responsibleUserId">,
  ): Promise<ProviderLoginHoldDecision> {
    return { hold: false, reason: config.disabled ? "disabled" : "lane_open" };
  }
  return { evaluate };
}
