import { and, eq, gt, inArray, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { persistActivity } from "../activity-log.js";
import { proveOwnerGone, type OwnerProof, type ProcessProbe } from "../owner-proof.js";
import {
  OWNABLE_KINDS,
  resolveFenceHolders,
  type InProgressRecord,
  type OwnableKind,
  type RecordOwner,
} from "./ownership-registry.js";

/**
 * Report-only ownership reconciliation (plan section C, Phase 1).
 *
 * One pass lists every registered kind's in-progress records, classifies each
 * owner as gone, alive or unprovable, and runs the plan's invariant checks.
 * Violations are written once per process to the activity log as
 * `recovery.invariant_violation`. Nothing is settled, released or retried, and
 * nothing is sent to Telemetry (AGENTS.md §5.7).
 */

export const OWNERSHIP_INVARIANT_VIOLATION_ACTION = "recovery.invariant_violation";
export const OWNERSHIP_RECONCILER_ACTOR_ID = "ownership-reconciler";

export type InvariantRule =
  | "I1_owned"
  | "I2_settled"
  | "I3_admission_independent"
  | "I4_exactly_once_intent"
  | "I7_visible_next_action";

export type InvariantViolation = {
  rule: InvariantRule;
  kind: string;
  recordId: string;
  companyId: string | null;
  runId: string | null;
  issueId: string | null;
  reason: string;
};

export type KindReport = {
  kind: string;
  obligation: OwnableKind["obligation"];
  storage: OwnableKind["storage"];
  inProgress: number;
  truncated: boolean;
  verdicts: { gone: number; alive: number; unprovable: number };
  reasons: Record<string, number>;
  coverageGap?: string;
  error?: string;
};

export type OwnershipReport = {
  at: string;
  inProgress: number;
  kinds: KindReport[];
  violations: InvariantViolation[];
  /** Violations first seen in this pass (written to the activity log). */
  newViolations: InvariantViolation[];
  /** Invariants this pass cannot measure yet, and why. */
  coverageGaps: Record<string, string>;
};

const COVERAGE_GAPS: Record<string, string> = {
  I5_work_based_budgets: "Needs the section B outcome records (accepted turn.start) to tell charged from uncharged attempts.",
  I6_generation_fencing: "Runner events carry no generation stamp until section G lands.",
  I8_fast_turns: "Measured per run by the speed-budget check in the run log, not by this pass.",
};

/** In-memory state kept across passes of one process. */
export type OwnershipReportState = {
  /** Records whose owner was proven gone in the previous pass (rule I2 needs two passes). */
  goneLastPass: Set<string>;
  /** Violation keys already written to the activity log by this process. */
  reported: Set<string>;
  /** Lower bound for the wake-request scan of rule I4. */
  lastPassAt: Date | null;
};

export function createOwnershipReportState(): OwnershipReportState {
  return { goneLastPass: new Set(), reported: new Set(), lastPassAt: null };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
/** Accounting closure deadline used by the admission gate (run-cost-accounting.ts). */
const ACCOUNTING_CLOSURE_MS = 10 * 60_000;
/** An in-progress issue must show a next action within this time. */
const NEXT_ACTION_GRACE_MS = 5 * 60_000;
/** First I4 scan after boot looks back this far. */
const INTENT_LOOKBACK_MS = 60 * 60_000;
/** Refusal texts that name a temporary condition (invariant 4). */
const TEMPORARY_REFUSAL = /budget|paus|lock|busy|unavailable|retry|admission|hold|drain|restart|capacity|rate.?limit|timeout/i;

type Classification = { verdict: OwnerProof["verdict"]; reason: string };

async function classifyRunOwners(db: Db, records: InProgressRecord[]): Promise<Map<string, Classification>> {
  const runIds = [...new Set(records.flatMap(record => record.owner.kind === "run" ? [record.owner.runId] : []))];
  const proofs = new Map<string, Classification>();
  for (let index = 0; index < runIds.length; index += 500) {
    const batch = runIds.slice(index, index + 500);
    const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, batch));
    const byId = new Map(rows.map(row => [row.id, row.status]));
    for (const runId of batch) {
      const status = byId.get(runId);
      proofs.set(runId, status === undefined ? { verdict: "gone", reason: "owner_run_missing" }
        : TERMINAL_RUN_STATUSES.includes(status) ? { verdict: "gone", reason: "owner_run_terminal" }
        : { verdict: "alive", reason: "owner_run_active" });
    }
  }
  return proofs;
}

async function classify(owner: RecordOwner, runProofs: Map<string, Classification>, probe: ProcessProbe | undefined,
  now: Date): Promise<Classification> {
  switch (owner.kind) {
    case "process": return proveOwnerGone(owner.stamp, probe);
    case "fence": return proveOwnerGone(owner.stamp, owner.fence, now);
    case "run": return runProofs.get(owner.runId) ?? { verdict: "unprovable", reason: "owner_run_unread" };
    case "operator": return { verdict: "alive", reason: "operator_owned" };
    case "none": return { verdict: "unprovable", reason: "no_owner_stamp" };
  }
}

const violationKey = (violation: InvariantViolation) => `${violation.rule}:${violation.kind}:${violation.recordId}`;

/** Admission still waits on accounting (inventory finding 3): every terminal
 * run whose accounting outlives the closure deadline holds company admission
 * through `waitingRunCount`. */
async function checkAdmissionIndependence(db: Db, now: Date, limit: number): Promise<InvariantViolation[]> {
  const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
      lt(heartbeatRuns.finishedAt, new Date(now.getTime() - ACCOUNTING_CLOSURE_MS)))).limit(limit);
  return rows.map(row => ({ rule: "I3_admission_independent", kind: "run_accounting_debt", recordId: row.id,
    companyId: row.companyId, runId: row.id, issueId: row.issueId, reason: "accounting_debt_holds_admission" }));
}

/** A wake request that ended terminally on a refusal that names a temporary
 * condition. Heuristic until section E gives wake requests closed reasons. */
async function checkExactlyOnceIntents(db: Db, since: Date, limit: number): Promise<InvariantViolation[]> {
  const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
    runId: agentWakeupRequests.runId, error: agentWakeupRequests.error, reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests).where(and(inArray(agentWakeupRequests.status, ["skipped", "failed"]),
      gt(agentWakeupRequests.updatedAt, since))).limit(limit);
  return rows.filter(row => TEMPORARY_REFUSAL.test(`${row.error ?? ""} ${row.reason ?? ""}`)).map(row => ({
    rule: "I4_exactly_once_intent", kind: "wake_request", recordId: row.id, companyId: row.companyId,
    runId: row.runId, issueId: null, reason: "terminal_on_temporary_refusal",
  }));
}

/** An agent-assigned in-progress issue with no live run, no pending wake and
 * no open recovery action has no next action (invariant 7). */
async function checkVisibleNextAction(db: Db, now: Date, limit: number): Promise<InvariantViolation[]> {
  const rows = await db.select({ id: issues.id, companyId: issues.companyId, executionRunId: issues.executionRunId })
    .from(issues).where(and(eq(issues.status, "in_progress"), isNotNull(issues.assigneeAgentId),
      lt(issues.updatedAt, new Date(now.getTime() - NEXT_ACTION_GRACE_MS)),
      notExists(db.select({ one: sql`1` }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, issues.companyId), inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        or(eq(heartbeatRuns.issueId, issues.id), eq(heartbeatRuns.nativeIssueId, issues.id))))),
      notExists(db.select({ one: sql`1` }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issues.companyId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issues.id}::text`))),
      notExists(db.select({ one: sql`1` }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, issues.companyId), eq(issueRecoveryActions.sourceIssueId, issues.id),
        isNull(issueRecoveryActions.resolvedAt)))),
    )).limit(limit);
  return rows.map(row => ({ rule: "I7_visible_next_action", kind: "issue", recordId: row.id, companyId: row.companyId,
    runId: row.executionRunId, issueId: row.id, reason: row.executionRunId ? "lock_without_live_run" : "no_owner_no_wake" }));
}

export async function runOwnershipReconciliationPass(db: Db, options: {
  state: OwnershipReportState;
  kinds?: readonly OwnableKind[];
  limitPerKind?: number;
  probe?: ProcessProbe;
  now?: Date;
  /** Write new violations to the activity log. Defaults to true. */
  record?: boolean;
}): Promise<OwnershipReport> {
  const now = options.now ?? new Date();
  const limit = options.limitPerKind ?? 200;
  const kinds = options.kinds ?? OWNABLE_KINDS;
  const state = options.state;
  const kindReports: KindReport[] = [];
  const violations: InvariantViolation[] = [];
  const goneThisPass = new Set<string>();

  for (const kind of kinds) {
    const report: KindReport = { kind: kind.id, obligation: kind.obligation, storage: kind.storage, inProgress: 0,
      truncated: false, verdicts: { gone: 0, alive: 0, unprovable: 0 }, reasons: {},
      ...(kind.coverageGap ? { coverageGap: kind.coverageGap } : {}) };
    kindReports.push(report);
    if (!kind.listInProgress) continue;
    let records: InProgressRecord[];
    try {
      const listed = await kind.listInProgress(db, limit);
      records = listed.records;
      report.truncated = listed.truncated;
      await resolveFenceHolders(db, records);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      continue;
    }
    report.inProgress = records.length;
    const runProofs = await classifyRunOwners(db, records);
    for (const record of records) {
      const proof = await classify(record.owner, runProofs, options.probe, now);
      report.verdicts[proof.verdict] += 1;
      report.reasons[proof.reason] = (report.reasons[proof.reason] ?? 0) + 1;
      const base = { kind: kind.id, recordId: record.recordId, companyId: record.companyId,
        runId: record.runId, issueId: record.issueId };
      if (kind.invariantChecks.includes(1) && record.owner.kind === "none") {
        violations.push({ ...base, rule: "I1_owned", reason: "no_owner_stamp" });
      }
      if (kind.invariantChecks.includes(2) && proof.verdict === "gone") {
        const key = `${kind.id}:${record.recordId}`;
        goneThisPass.add(key);
        // Settled means terminal within one reconciler pass of the proof.
        if (state.goneLastPass.has(key)) violations.push({ ...base, rule: "I2_settled", reason: proof.reason });
      }
    }
  }

  const since = state.lastPassAt ?? new Date(now.getTime() - INTENT_LOOKBACK_MS);
  for (const check of [
    () => checkAdmissionIndependence(db, now, limit),
    () => checkExactlyOnceIntents(db, since, limit),
    () => checkVisibleNextAction(db, now, limit),
  ]) {
    try {
      violations.push(...await check());
    } catch (error) {
      logger.warn({ err: error }, "ownership invariant check failed; the report continues");
    }
  }

  state.goneLastPass = goneThisPass;
  state.lastPassAt = now;
  const newViolations = violations.filter(violation => !state.reported.has(violationKey(violation)));
  if (options.record !== false) {
    for (const violation of newViolations) {
      if (!violation.companyId) continue;
      try {
        await persistActivity(db, {
          companyId: violation.companyId, actorType: "system", actorId: OWNERSHIP_RECONCILER_ACTOR_ID,
          action: OWNERSHIP_INVARIANT_VIOLATION_ACTION, entityType: "ownership_record", entityId: violation.recordId,
          details: { rule: violation.rule, kind: violation.kind, reason: violation.reason,
            runId: violation.runId, issueId: violation.issueId, mode: "report_only" },
        });
      } catch (error) {
        logger.warn({ err: error, rule: violation.rule, kind: violation.kind }, "failed to record ownership invariant violation");
        continue;
      }
      state.reported.add(violationKey(violation));
    }
    for (const violation of newViolations) {
      if (!violation.companyId) state.reported.add(violationKey(violation));
    }
  }

  const inProgress = kindReports.reduce((total, report) => total + report.inProgress, 0);
  const report: OwnershipReport = { at: now.toISOString(), inProgress, kinds: kindReports, violations,
    newViolations, coverageGaps: COVERAGE_GAPS };
  if (newViolations.length > 0 || kindReports.some(kind => kind.error)) {
    logger.info({
      inProgress, violations: violations.length, newViolations: newViolations.length,
      byRule: countBy(violations, violation => violation.rule),
      byKind: countBy(violations, violation => violation.kind),
      errors: kindReports.filter(kind => kind.error).map(kind => ({ kind: kind.kind, error: kind.error })),
    }, "ownership reconciliation report");
  }
  return report;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** A stable fingerprint of the in-progress set, so the worker can tell a
 * changing set from a stuck one. */
export function ownershipReportFingerprint(report: OwnershipReport): string {
  return report.kinds.map(kind => `${kind.kind}:${kind.inProgress}:${kind.verdicts.gone}:${kind.verdicts.alive}`).join("|");
}
