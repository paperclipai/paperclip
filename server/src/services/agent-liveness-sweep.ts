/**
 * Stale-agent reconciliation sweep (LEG-1927 / LEG-1924 Ask #1).
 *
 * A read-only background sweep that scans every agent in active companies for
 * the "non-live" shape — explicit `status='error'`, OR a lingering
 * `errorReason` paired with a stale heartbeat — and flags the ones that have
 * been stuck long enough (configurable ~24h) so the board/operator notices.
 *
 * What this sweep does NOT do: mutate `agents.status` or restart anything.
 * Seat repair is board-gated for agents (LEG-1923); this issue is about
 * detection/flagging only. The sweep writes a deduped `activity_log` flag per
 * detected agent (one per threshold window, not one per tick) so the activity
 * feed and downstream notifications surface it, and the attention surface
 * independently shows the live shape at read time.
 *
 * The detection predicate reuses the shared classifier landed for Ask #2
 * (`classifyAgentReconciliationLiveness` / `isAgentInNonLiveErrorShape` in
 * `@paperclipai/shared`), which in turn reuse `isAgentAssignmentHeartbeatStale`
 * so on-demand (heartbeat-disabled) agents are never false-flagged by the
 * stale-heartbeat branch.
 */

import { and, desc, eq, gt, isNotNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies } from "@paperclipai/db";
import {
  classifyAgentReconciliationLiveness,
  DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { readHeartbeatLivenessConfig } from "./agent-assignability.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "agent-liveness-sweep" });

/** Activity-log action recorded for each newly-detected non-live agent. */
export const AGENT_NON_LIVE_DETECTED_ACTION = "agent.non_live_detected";

export interface SweepStaleAgentsOptions {
  /** Override the default ~24h threshold before a non-live agent is flagged. */
  thresholdMs?: number;
  /** Injected clock for tests. */
  now?: Date;
}

export interface SweepStaleAgentsResult {
  /** Number of candidate agents inspected (status='error' or errorReason set). */
  checked: number;
  /** Number of agents that matched the non-live shape past the threshold. */
  flagged: number;
  /** Number of deduped activity-log flags actually written this tick. */
  logged: number;
}

/**
 * Scan all agents in active companies for the non-live shape and flag the ones
 * stuck past the threshold. Safe to run every scheduler tick: the per-agent
 * activity-log flag is deduped against the threshold window so a long-stuck
 * agent produces one flag per ~24h, not one per 30s tick. Does not mutate
 * agent status.
 */
export async function sweepStaleAgents(
  db: Db,
  options: SweepStaleAgentsOptions = {},
): Promise<SweepStaleAgentsResult> {
  const now = options.now ?? new Date();
  const thresholdMs = typeof options.thresholdMs === "number" && options.thresholdMs > 0
    ? options.thresholdMs
    : DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS;

  // Candidate set: any agent that could plausibly be non-live. The index on
  // (companyId, status) covers the status='error' disjunct; the errorReason
  // disjunct is a wider scan but still bounded per company. We then classify
  // in-process so on-demand agents and sub-threshold blips are filtered out.
  const candidates = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      errorReason: agents.errorReason,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      createdAt: agents.createdAt,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(
      eq(companies.status, "active"),
      or(eq(agents.status, "error"), isNotNull(agents.errorReason)),
    ));

  let checked = 0;
  let flagged = 0;
  let logged = 0;

  for (const candidate of candidates) {
    checked += 1;
    const heartbeat = readHeartbeatLivenessConfig(candidate.runtimeConfig);
    const result = classifyAgentReconciliationLiveness({
      name: candidate.name,
      status: candidate.status,
      errorReason: candidate.errorReason,
      lastHeartbeatAt: candidate.lastHeartbeatAt,
      createdAt: candidate.createdAt,
      heartbeatEnabled: heartbeat.enabled,
      heartbeatIntervalSec: heartbeat.intervalSec,
      staleReconciliationThresholdMs: thresholdMs,
      now,
    });
    if (!result.nonLive) continue;
    flagged += 1;

    // Dedup: skip if we already flagged this agent within the threshold window.
    // The activity_log_company_agent_created_idx index makes this cheap.
    const since = new Date(now.getTime() - thresholdMs);
    const existing = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, candidate.companyId),
        eq(activityLog.agentId, candidate.id),
        eq(activityLog.action, AGENT_NON_LIVE_DETECTED_ACTION),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, candidate.id),
        gt(activityLog.createdAt, since),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) continue;

    await logActivity(db, {
      companyId: candidate.companyId,
      actorType: "system",
      actorId: "agent-liveness-sweep",
      action: AGENT_NON_LIVE_DETECTED_ACTION,
      entityType: "agent",
      entityId: candidate.id,
      agentId: candidate.id,
      details: {
        agentName: candidate.name,
        agentStatus: candidate.status,
        reason: result.reason,
        ageSinceHeartbeatMs: result.ageSinceHeartbeatMs,
        thresholdMs: result.thresholdMs,
        errorReason: candidate.errorReason,
        source: "agent_liveness_sweep",
        securityPrinciples: ["Fail Securely", "Complete Mediation"],
        note: "Detection only; agent status is not mutated. Repair is gated by LEG-1923.",
      },
    });
    logged += 1;
  }

  if (flagged > 0) {
    log.warn(
      { checked, flagged, logged, thresholdMs },
      "stale-agent reconciliation sweep flagged non-live agents",
    );
  } else {
    log.debug({ checked, thresholdMs }, "stale-agent reconciliation sweep found no non-live agents");
  }

  return { checked, flagged, logged };
}
