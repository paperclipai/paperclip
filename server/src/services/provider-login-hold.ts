import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isAiAuthenticationFailure } from "./ai-auth-failure.js";

/**
 * Login lanes hold queued runs while a shared provider login is rejected.
 *
 * Agents that use the same adapter and the same credential settings also use
 * the same provider login. An AI connection can resolve per responsible user,
 * so for those agents the responsible user is part of the lane. When that login fails,
 * every queued run in the lane fails the same way within seconds. One
 * authentication failure therefore holds the lane. Held runs stay `queued`.
 * Queue recovery claims them again later. One probe run is released after a
 * cooldown. A successful probe opens the lane. A failed probe holds it again
 * with a doubled cooldown. An agent whose AI connection is repaired gets a new
 * lane key, so the repair is not held.
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
};

export type ProviderLoginHoldDecision =
  | { hold: false; reason: "disabled" | "lane_open" | "probe_cooldown_elapsed"; probe?: boolean; failures?: number }
  | { hold: true; reason: "login_failed" | "probe_in_flight"; failures: number; errorCode: string; holdUntil: Date };

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
  state: { probeGrantedAt?: Date | null } = {},
): ProviderLoginHoldDecision {
  if (config.disabled) return { hold: false, reason: "disabled" };
  const nowMs = now.getTime();
  let failures = 0;
  let newestFailureMs: number | null = null;
  let newestFinishedMs: number | null = null;
  let errorCode = "";
  for (const run of runs) {
    const finishedMs = run.finishedAt?.getTime() ?? null;
    if (finishedMs === null || finishedMs < nowMs - config.windowMs) break;
    if (finishedMs > nowMs) continue;
    newestFinishedMs ??= finishedMs;
    if (run.status === "succeeded") break;
    if (!FAILED_STATUSES.has(run.status) || !isAiAuthenticationFailure(run.errorCode)) continue;
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
  const probeMs = state.probeGrantedAt?.getTime() ?? null;
  if (
    probeMs !== null &&
    probeMs > newestFailureMs &&
    (newestFinishedMs === null || newestFinishedMs < probeMs) &&
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

export function providerLoginHoldService(db: Db, config: ProviderLoginHoldConfig = readProviderLoginHoldConfig()) {
  const probeByLane = new Map<string, Date>();

  /**
   * Returns the hold for a queued run. A query error opens the lane: one extra
   * failed run costs less than a stopped queue.
   */
  async function evaluate(run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "responsibleUserId">) {
    if (config.disabled) return { hold: false, reason: "disabled" } as const;
    try {
      const candidates = await db
        .select({
          id: agents.id,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(eq(agents.companyId, run.companyId));
      const self = candidates.find((candidate) => candidate.id === run.agentId);
      if (!self) return { hold: false, reason: "lane_open" } as const;
      const laneKey = providerLoginLaneKey(self);
      const lane = candidates.filter((candidate) => providerLoginLaneKey(candidate) === laneKey);
      const perUser = Boolean(record(self.runtimeConfig).aiConnection);
      const responsibleUserId = perUser ? run.responsibleUserId ?? null : null;

      const now = new Date();
      const runs = await db
        .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          inArray(heartbeatRuns.agentId, lane.map((candidate) => candidate.id)),
          perUser
            ? responsibleUserId
              ? eq(heartbeatRuns.responsibleUserId, responsibleUserId)
              : isNull(heartbeatRuns.responsibleUserId)
            : undefined,
          gte(heartbeatRuns.startedAt, new Date(now.getTime() - config.windowMs)),
          isNotNull(heartbeatRuns.finishedAt),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
        ))
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(60);

      const probeKey = JSON.stringify([run.companyId, responsibleUserId, laneKey]);
      // Decide and grant the probe without an await in between, so two
      // concurrent claims cannot both receive the probe.
      const decision = decideProviderLoginHold(runs, new Date(), config, {
        probeGrantedAt: probeByLane.get(probeKey) ?? null,
      });
      if (!decision.hold && decision.probe) probeByLane.set(probeKey, new Date());
      return decision;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "Could not evaluate the provider login hold; the run is not held");
      return { hold: false, reason: "lane_open" } as const;
    }
  }

  return { evaluate };
}
