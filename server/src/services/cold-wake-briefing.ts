// Cold-wake briefing assembler — step-by-step in service of the parent
// initiative: when an agent has been hibernated past a threshold and is woken
// onto an active issue, the harness prepends a "what changed under you"
// briefing into the wake payload so the agent does not start work blind.
//
// This file holds the focused, adjacent assembler that the heartbeat service
// calls right after `buildPaperclipWakePayload`. Each piece (detection,
// section assembly, token-budget guard, telemetry) lands as a separate PR
// against the parent tracker.
//
// **This PR — step 2 — only ships staleness detection.** Per-section
// assembly, the budget guard, telemetry, and the call-site wiring all land
// in follow-up PRs.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/** Default hibernation threshold. 24h ≈ one working day; gaps longer than
 *  that are unambiguously stale from the agent's perspective. Tunable via
 *  `PAPERCLIP_HIBERNATION_THRESHOLD_HOURS` so operators can dial it down
 *  once telemetry justifies a tighter value. */
export const DEFAULT_HIBERNATION_THRESHOLD_HOURS = 24;

const SUCCEEDED_RUN_STATUS = "succeeded";
const MS_PER_HOUR = 3_600_000;

export type ColdWakeDetectionInput = {
  /** `null` when there is no prior succeeded run for the agent. */
  lastRunFinishedAt: Date | null;
  /** Override the default. Falsy values fall back to env / default. */
  thresholdHours?: number;
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: Date;
};

export type ColdWakeDetection = {
  isColdWake: boolean;
  hoursSinceLastRun: number | null;
  lastRunFinishedAt: Date | null;
  thresholdHours: number;
};

/** Resolve the hibernation threshold from the supplied env or `process.env`,
 *  falling back to the default when unset, non-numeric, or non-positive. */
export function resolveHibernationThresholdHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAPERCLIP_HIBERNATION_THRESHOLD_HOURS;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_HIBERNATION_THRESHOLD_HOURS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HIBERNATION_THRESHOLD_HOURS;
  }
  return parsed;
}

/** Pure detection — given the last succeeded run's finish time, decide
 *  whether this wake should be treated as a cold wake. No DB access.
 *
 *  Boundary rule: a gap **strictly greater than** the threshold is cold.
 *  Exactly-at-threshold is warm; this keeps daily cron wakes (~24h apart)
 *  from being flagged cold by default while still catching multi-day gaps
 *  like the ALL-779 incident that motivated the briefing. */
export function detectColdWake(input: ColdWakeDetectionInput): ColdWakeDetection {
  const thresholdHours =
    typeof input.thresholdHours === "number" && Number.isFinite(input.thresholdHours) && input.thresholdHours > 0
      ? input.thresholdHours
      : resolveHibernationThresholdHours();
  const now = input.now ?? new Date();
  const lastRunFinishedAt = input.lastRunFinishedAt;

  if (!lastRunFinishedAt) {
    return {
      isColdWake: true,
      hoursSinceLastRun: null,
      lastRunFinishedAt: null,
      thresholdHours,
    };
  }

  const hoursSinceLastRun = (now.getTime() - lastRunFinishedAt.getTime()) / MS_PER_HOUR;
  return {
    isColdWake: hoursSinceLastRun > thresholdHours,
    hoursSinceLastRun,
    lastRunFinishedAt,
    thresholdHours,
  };
}

/** Look up the most recent succeeded `heartbeat_runs.finished_at` for an
 *  agent within a company. Returns `null` when no succeeded run is on
 *  record. The query is covered by the existing
 *  `heartbeat_runs_company_agent_started_idx` for filter selectivity; the
 *  trailing `order by finished_at desc` falls back to a small in-memory
 *  sort, which is acceptable for the per-wake call cadence. */
export async function getLastSucceededRunFinishedAt(input: {
  db: Db;
  companyId: string;
  agentId: string;
}): Promise<Date | null> {
  const rows = await input.db
    .select({ finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, SUCCEEDED_RUN_STATUS),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1);
  return rows[0]?.finishedAt ?? null;
}
