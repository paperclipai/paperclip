import { asc, count, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

const DEFAULT_NEXT_CHECK_MS = 30_000;

export type RestartDrainSource = "operator" | "dev_server" | "signal";

export type RestartDrainMode = "idle" | "draining";

export type RestartDrainReason = "planned_restart" | "manual_restart_now" | "sigterm";

export type RestartEmergencyCategory =
  | "operator_override"
  | "security_update"
  | "service_recovery"
  | "other";

export type RestartDrainStatus = {
  mode: RestartDrainMode;
  source: RestartDrainSource | null;
  reason: RestartDrainReason | null;
  startedAt: string | null;
  lastDeferredAt: string | null;
  deferredCount: number;
  emergencyOverrideAt: string | null;
  emergencyReasonPresent: boolean;
  emergencyReasonCategory: RestartEmergencyCategory | null;
  nextCheckAt: string | null;
};

export type ActiveRunDrainSummary = {
  activeRunCount: number;
  oldestRunStartedAt: string | null;
  oldestRunAgeMs: number | null;
  nextCheckAt: string | null;
};

type RestartDrainState = {
  mode: RestartDrainMode;
  source: RestartDrainSource | null;
  reason: RestartDrainReason | null;
  startedAt: Date | null;
  lastDeferredAt: Date | null;
  deferredCount: number;
  emergencyOverrideAt: Date | null;
  emergencyReasonPresent: boolean;
  emergencyReasonCategory: RestartEmergencyCategory | null;
};

const state: RestartDrainState = {
  mode: "idle",
  source: null,
  reason: null,
  startedAt: null,
  lastDeferredAt: null,
  deferredCount: 0,
  emergencyOverrideAt: null,
  emergencyReasonPresent: false,
  emergencyReasonCategory: null,
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function nextCheckAt(from: Date | null, intervalMs = DEFAULT_NEXT_CHECK_MS): string | null {
  if (!from) return null;
  return new Date(from.getTime() + intervalMs).toISOString();
}

export function beginRestartDrain(input: {
  source: RestartDrainSource;
  reason: RestartDrainReason;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (state.mode !== "draining") {
    state.startedAt = now;
    state.deferredCount = 0;
  }
  state.mode = "draining";
  state.source = input.source;
  state.reason = input.reason;
}

export function markRestartDeferred(now = new Date()) {
  if (state.mode !== "draining") {
    state.mode = "draining";
    state.source = "operator";
    state.reason = "planned_restart";
    state.startedAt = now;
  }
  state.lastDeferredAt = now;
  state.deferredCount += 1;
}

export function recordEmergencyRestartOverride(input: {
  reasonPresent: boolean;
  reasonCategory?: RestartEmergencyCategory | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  state.emergencyOverrideAt = now;
  state.emergencyReasonPresent = input.reasonPresent;
  state.emergencyReasonCategory = input.reasonCategory ?? null;
}

export function clearRestartDrain() {
  state.mode = "idle";
  state.source = null;
  state.reason = null;
  state.startedAt = null;
  state.lastDeferredAt = null;
  state.deferredCount = 0;
}

export function isRestartDrainActive() {
  return state.mode === "draining";
}

export function getRestartDrainStatus(): RestartDrainStatus {
  return {
    mode: state.mode,
    source: state.source,
    reason: state.reason,
    startedAt: toIso(state.startedAt),
    lastDeferredAt: toIso(state.lastDeferredAt),
    deferredCount: state.deferredCount,
    emergencyOverrideAt: toIso(state.emergencyOverrideAt),
    emergencyReasonPresent: state.emergencyReasonPresent,
    emergencyReasonCategory: state.emergencyReasonCategory,
    nextCheckAt: nextCheckAt(state.lastDeferredAt),
  };
}

export async function summarizeActiveRunsForDrain(
  db: Db,
  now = new Date(),
): Promise<ActiveRunDrainSummary> {
  const [countRow] = await db
    .select({ count: count() })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));
  const activeRunCount = Number(countRow?.count ?? 0);

  let oldestRunStartedAt: string | null = null;
  let oldestRunAgeMs: number | null = null;
  if (activeRunCount > 0) {
    const [oldest] = await db
      .select({
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]))
      .orderBy(asc(heartbeatRuns.startedAt), asc(heartbeatRuns.createdAt))
      .limit(1);
    const oldestAt = oldest?.startedAt ?? oldest?.createdAt ?? null;
    if (oldestAt) {
      oldestRunStartedAt = oldestAt.toISOString();
      oldestRunAgeMs = Math.max(0, now.getTime() - oldestAt.getTime());
    }
  }

  const nextCheck = new Date(now.getTime() + DEFAULT_NEXT_CHECK_MS).toISOString();
  return {
    activeRunCount,
    oldestRunStartedAt,
    oldestRunAgeMs,
    nextCheckAt: activeRunCount > 0 ? nextCheck : null,
  };
}

export async function listActiveRunCompanyIdsForDrain(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));
  return rows.map((row) => row.companyId);
}

export async function waitForRestartDrain(
  db: Db,
  opts: { timeoutMs: number; pollMs?: number; now?: () => Date },
) {
  const startedAt = Date.now();
  const pollMs = Math.max(50, opts.pollMs ?? 1_000);
  const now = opts.now ?? (() => new Date());
  let summary = await summarizeActiveRunsForDrain(db, now());
  while (summary.activeRunCount > 0 && Date.now() - startedAt < opts.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    summary = await summarizeActiveRunsForDrain(db, now());
  }
  return {
    drained: summary.activeRunCount === 0,
    waitedMs: Date.now() - startedAt,
    ...summary,
  };
}
