import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
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

type GrantedProbe = { runId: string; grantedAt: Date };

// The scheduler, HTTP wakes, and other entry points each build their own
// heartbeat service. Probes are shared per database so that every entry point
// respects the single probe of a lane.
const probesByDb = new WeakMap<object, Map<string, GrantedProbe>>();

function probeRegistry(db: Db) {
  let registry = probesByDb.get(db);
  if (!registry) {
    registry = new Map();
    probesByDb.set(db, registry);
  }
  return registry;
}

export function providerLoginHoldService(db: Db, config: ProviderLoginHoldConfig = readProviderLoginHoldConfig()) {
  const probeByLane = probeRegistry(db);

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

      const laneIds = lane.map((candidate) => candidate.id);
      const now = new Date();
      const windowStart = new Date(now.getTime() - config.windowMs);
      // A run counts for the lane only if its agent used the same login
      // settings when the run started. A change of those settings drops the
      // agent's older runs; other edits (name, budget, model) keep them.
      const revisions = await db
        .select({
          agentId: agentConfigRevisions.agentId,
          createdAt: agentConfigRevisions.createdAt,
          changedKeys: agentConfigRevisions.changedKeys,
          beforeConfig: agentConfigRevisions.beforeConfig,
          afterConfig: agentConfigRevisions.afterConfig,
        })
        .from(agentConfigRevisions)
        .where(and(
          eq(agentConfigRevisions.companyId, run.companyId),
          inArray(agentConfigRevisions.agentId, laneIds),
          gte(agentConfigRevisions.createdAt, windowStart),
        ));
      const loginChangedAt = new Map<string, Date>();
      for (const revision of revisions) {
        if (!loginSettingsChanged(revision)) continue;
        const previous = loginChangedAt.get(revision.agentId);
        if (!previous || previous < revision.createdAt) loginChangedAt.set(revision.agentId, revision.createdAt);
      }
      const unchangedIds = laneIds.filter((id) => !loginChangedAt.has(id));
      // The cutoff is part of the query, so discarded runs do not use up the
      // history limit.
      const laneHistory = or(
        unchangedIds.length > 0 ? inArray(heartbeatRuns.agentId, unchangedIds) : undefined,
        ...[...loginChangedAt].map(([agentId, changedAt]) =>
          and(eq(heartbeatRuns.agentId, agentId), gte(heartbeatRuns.startedAt, changedAt))),
      );

      const readLaneRuns = () => db
        .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          laneHistory,
          perUser
            ? responsibleUserId
              ? eq(heartbeatRuns.responsibleUserId, responsibleUserId)
              : isNull(heartbeatRuns.responsibleUserId)
            : undefined,
          gte(heartbeatRuns.startedAt, windowStart),
          isNotNull(heartbeatRuns.finishedAt),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
        ))
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(60);
      let runs = await readLaneRuns();

      const probeKey = JSON.stringify([run.companyId, responsibleUserId, laneKey]);
      const stored = probeByLane.get(probeKey) ?? null;
      if (stored?.runId === run.id) {
        // The probe was granted but did not start. Once the grant expires,
        // another run may probe.
        if (now.getTime() - stored.grantedAt.getTime() >= config.probeTimeoutMs) {
          probeByLane.delete(probeKey);
          return { hold: true, reason: "probe_expired", failures: 0, errorCode: "", holdUntil: now } as const;
        }
        // Another run of the lane may have failed authentication meanwhile.
        // That starts a new cooldown, and a later probe is granted afresh.
        const recheck = decideProviderLoginHold(runs, now, config);
        if (recheck.hold) {
          probeByLane.delete(probeKey);
          return recheck;
        }
        // Claim the probe again without renewing the grant.
        return recheck;
      }
      let probeFinished = false;
      if (stored) {
        const [probeRun] = await db
          .select({ finishedAt: heartbeatRuns.finishedAt })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, stored.runId));
        probeFinished = !probeRun || probeRun.finishedAt !== null;
        // The probe can fail after the lane history above was read. Its
        // failure starts the next cooldown, so decide on fresh history.
        if (probeFinished) runs = await readLaneRuns();
        const latest = probeByLane.get(probeKey);
        if (latest && latest !== stored) {
          // Another claim granted a new probe while this one was reading.
          return {
            hold: true,
            reason: "probe_in_flight",
            failures: 0,
            errorCode: "",
            holdUntil: new Date(latest.grantedAt.getTime() + config.probeTimeoutMs),
          } as const;
        }
      }
      // Decide and grant the probe without an await in between, so two
      // concurrent claims cannot both receive the probe.
      const decision = decideProviderLoginHold(runs, new Date(), config, {
        probe: stored ? { grantedAt: stored.grantedAt, finished: probeFinished } : null,
      });
      if (!decision.hold && decision.probe) probeByLane.set(probeKey, { runId: run.id, grantedAt: new Date() });
      return decision;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "Could not evaluate the provider login hold; the run is not held");
      return { hold: false, reason: "lane_open" } as const;
    }
  }

  return { evaluate };
}
