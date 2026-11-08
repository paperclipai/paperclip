import { and, asc, eq, inArray, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { TEMPORARY_REFUSAL_TRIGGERS } from "../work-intent-outbox.js";
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
 * Ownership reconciliation (plan section C).
 *
 * One pass lists every registered kind's in-progress records, classifies each
 * owner as gone, alive or unprovable, and runs the plan's invariant checks.
 * Violations are written once per process to the activity log as
 * `recovery.invariant_violation`. A kind that registers a `settle` (Phase 2)
 * is settled when its owner is proven gone, and its `onUnprovable` action is
 * surfaced when the owner is unprovable; an unprovable owner is never
 * released. Report-only kinds are never changed. Nothing is sent to Telemetry
 * (AGENTS.md §5.7).
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
  /** Records this pass settled (kinds with a registered `settle`). */
  settled: number;
  /** Records of a settling kind whose owner was alive or gone-but-kept: the
   * owner can still die without writing a signal, so the worker keeps a
   * bounded re-check due while any exist. */
  watched: number;
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
  /** Owners proven gone for the first time, whose I2 check needs one more pass. */
  awaitingSecondProof: number;
  /** Earliest time a record inside a grace window becomes checkable, if any. */
  nextDueAt: Date | null;
  /** In-progress records of settling kinds that a later pass must re-prove. */
  settleWatch: number;
  /** Work left for a later pass: failed listings or checks, unsaved
   * violations, and an unfinished I4 window. The worker keeps a retry due. */
  retryNeeded: boolean;
};

const COVERAGE_GAPS: Record<string, string> = {
  I5_work_based_budgets: "Needs the section B outcome records (accepted turn.start) to tell charged from uncharged attempts.",
  I6_generation_fencing: "Runner events carry no generation stamp until section G lands.",
  I8_fast_turns: "Measured per run by the speed-budget check in the run log, not by this pass.",
  I7_scope: "I7 measures agent-assigned in_progress issues. todo, in_review and blocked issues are not measured yet.",
  record_cap: "Each kind and the I7 check read at most 2,000 records per pass; a larger kind is reported as truncated. "
    + "The I3 and I4 scans read ten pages per pass and continue from a cursor on the next pass.",
  wake_coverage: "Writers of workspace runtime services, remote workspace operations, snapshots, restore points, "
    + "git cache intents, provider artifacts and harness backups publish no work signal. Those kinds are read at "
    + "startup and on any other report wake. Phase 2 adds a signal when each kind moves to the shared settle path.",
};

/** In-memory state kept across passes of one process. */
export type OwnershipReportState = {
  /** Records whose owner was proven gone in the previous pass (rule I2 needs two passes). */
  goneLastPass: Set<string>;
  /** Violation keys already written to the activity log by this process. */
  reported: Set<string>;
  /** Keyset cursor of the wake-request scan of rule I4 (updated_at, id). */
  intentCursor: { at: string; id: string } | null;
  /** Violations whose activity row failed to save, with failed attempts;
   * retried on later passes and dropped after `MAX_WRITE_ATTEMPTS`. */
  unwritten: Map<string, { violation: InvariantViolation; attempts: number }>;
  /** True when the I4 scan stopped with more rows to read. */
  intentBacklog: boolean;
  /** Keyset cursors of the I3 refusal scans (wake requests and runs). */
  admissionWakeCursor: { at: string; id: string } | null;
  admissionRunCursor: { at: string; id: string } | null;
  /** True when an I3 scan stopped with more rows to read. */
  admissionBacklog: boolean;
};

export function createOwnershipReportState(): OwnershipReportState {
  return { goneLastPass: new Set(), reported: new Set(), intentCursor: null, unwritten: new Map(), intentBacklog: false,
    admissionWakeCursor: null, admissionRunCursor: null, admissionBacklog: false };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
/** An in-progress issue must show a next action within this time. */
const NEXT_ACTION_GRACE_MS = 5 * 60_000;
/** Records read per kind (and per I3/I7 check) per pass; beyond this the
 * kind is reported truncated (a named coverage gap). */
const MAX_RECORDS_PER_KIND = 2_000;
/** Failed activity writes of one violation before it is dropped. */
const MAX_WRITE_ATTEMPTS = 5;
/** First I4 scan after boot looks back this far. */
const INTENT_LOOKBACK_MS = 60 * 60_000;

type Classification = { verdict: OwnerProof["verdict"]; reason: string; legacyHostFallback?: true; localExecutionsKnown?: true };

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

/** Settles a proven-gone record, or surfaces the operator action for an
 * unprovable one. A failure is logged and retried on a later pass. */
async function settleOrSurface(db: Db, kind: OwnableKind, record: InProgressRecord, proof: Classification,
  now: Date): Promise<"settled" | "kept" | "failed"> {
  try {
    if (proof.verdict === "gone" && kind.settle) {
      const outcome = await kind.settle(db, record, { now, proof: proof as OwnerProof });
      return outcome.settled ? "settled" : "kept";
    }
    if (proof.verdict === "unprovable" && kind.onUnprovable) await kind.onUnprovable(db, record, { now, proof: proof as OwnerProof });
    return "kept";
  } catch (error) {
    logger.warn({ err: error, kind: kind.id, recordId: record.recordId }, "ownership settle failed; a later pass retries");
    return "failed";
  }
}

export type SettledRecord = { kind: string; recordId: string; runId: string | null; reason: string };

/**
 * Settles one kind now, outside the periodic pass: restart recovery calls this
 * so a dead owner's record settles in the first pass after boot. It uses the
 * same listing, prover and settle as the reconciler. `runIds` limits it to
 * those runs; `skipRunIds` names runs this process is executing.
 */
export async function settleOwnableKind(db: Db, kindId: string, options: {
  now?: Date; runIds?: readonly string[]; skipRunIds?: { has(runId: string): boolean }; probe?: ProcessProbe;
  /** The caller's `skipRunIds` names every run this process is executing. A
   * run record this process owns whose run is not among them has no holder
   * here, so its owner is gone (`current_process_idle`). The periodic pass
   * cannot know this process's executions and never concludes it. */
  currentProcessIdle?: boolean;
} = {}): Promise<SettledRecord[]> {
  return (await settleKind(db, kindId, options)).settled;
}

/**
 * The settle watch's light re-check: settles only the kinds that register a
 * `settle`, through their own (indexed) listings, without the full report pass
 * or the global invariant checks. Returns how many records are still watched.
 */
export async function recheckSettlingKinds(db: Db, options: { now?: Date; probe?: ProcessProbe; kinds?: readonly OwnableKind[] } = {}):
  Promise<{ settled: SettledRecord[]; watched: number }> {
  const settled: SettledRecord[] = [];
  let watched = 0;
  for (const kind of (options.kinds ?? OWNABLE_KINDS).filter(candidate => candidate.settle && candidate.listInProgress)) {
    const result = await settleKind(db, kind.id, options, kind);
    settled.push(...result.settled);
    watched += result.watched;
  }
  return { settled, watched };
}

async function settleKind(db: Db, kindId: string, options: {
  now?: Date; runIds?: readonly string[]; skipRunIds?: { has(runId: string): boolean }; probe?: ProcessProbe;
  currentProcessIdle?: boolean;
}, explicitKind?: OwnableKind): Promise<{ settled: SettledRecord[]; watched: number }> {
  const kind = explicitKind ?? OWNABLE_KINDS.find(candidate => candidate.id === kindId);
  if (!kind?.listInProgress || !kind.settle) throw new Error(`ownership kind ${kindId} has no settle path`);
  const now = options.now ?? new Date();
  const wanted = options.runIds ? new Set(options.runIds) : null;
  const records: InProgressRecord[] = [];
  if (wanted && kind.listForRuns) {
    // Scope before any page limit, so a requested run is never skipped.
    records.push(...await kind.listForRuns(db, [...wanted]));
  } else {
    // A one-shot settle reads the whole kind; only the periodic pass is capped.
    for (let offset = 0; ; offset += 200) {
      const listed = await kind.listInProgress(db, 200, offset);
      records.push(...listed.records);
      if (!listed.truncated) break;
    }
  }
  await resolveFenceHolders(db, records);
  const unique = [...new Map(records.map(record => [record.recordId, record])).values()]
    .filter(record => (!wanted || (record.runId !== null && wanted.has(record.runId)))
      && !(record.runId && options.skipRunIds?.has(record.runId)));
  const runProofs = await classifyRunOwners(db, unique);
  const settled: SettledRecord[] = [];
  let watched = 0;
  for (const record of unique) {
    let proof = await classify(record.owner, runProofs, options.probe, now);
    if (options.currentProcessIdle && record.runId && proof.verdict === "alive" && proof.reason === "current_process") {
      proof = { verdict: "gone", reason: "current_process_idle" };
    }
    if (options.currentProcessIdle) proof = { ...proof, localExecutionsKnown: true };
    const outcome = await settleOrSurface(db, kind, record, proof, now);
    if (outcome === "settled") {
      settled.push({ kind: kind.id, recordId: record.recordId, runId: record.runId, reason: proof.reason });
    } else if (proof.verdict !== "unprovable") {
      watched += 1;
    }
  }
  return { settled, watched };
}

const violationKey = (violation: InvariantViolation) => `${violation.rule}:${violation.kind}:${violation.recordId}`;

/** Refusal texts that name unfinished accounting or cleanup as the reason
 * work could not start, as a PostgreSQL case-insensitive regular expression.
 * Phase 3 removed every such gate, so any match is a regression. */
const ACCOUNTING_HOLD_PATTERN = "await(s|ing)? accounting|unfinished accounting|awaiting reconciliation";

/** Invariant 3: admission never waits on another run's cleanup or
 * accounting. Phase 3 removed the five gates that did (inventory finding 3),
 * so this reads the outcome instead of mirroring a gate: a wake request or a
 * run refused within the lookback window with an accounting-hold reason. */
async function checkAdmissionIndependence(db: Db, state: OwnershipReportState, now: Date, limit: number): Promise<InvariantViolation[]> {
  const start = { at: new Date(now.getTime() - INTENT_LOOKBACK_MS).toISOString(), id: "00000000-0000-0000-0000-000000000000" };
  const wakeText = sql`(coalesce(${agentWakeupRequests.error}, '') || ' '
    || coalesce(${agentWakeupRequests.payload}->'executionWait'->>'message', ''))`;
  const runText = sql`(coalesce(${heartbeatRuns.error}, '') || ' ' || coalesce(${heartbeatRuns.resultJson}->>'admissionBlockReason', ''))`;
  const violations: InvariantViolation[] = [];
  // Each table pages by (updated_at, id) from its own cursor, as rule I4
  // does, so a busy window is read in full across passes.
  let backlog = false;
  let position = state.admissionWakeCursor ?? start;
  for (let page = 0; page < 10; page++) {
    const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, runId: agentWakeupRequests.runId,
      issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'`, updatedAt: sql<string>`${agentWakeupRequests.updatedAt}::text` })
      .from(agentWakeupRequests).where(and(
        sql`(${agentWakeupRequests.updatedAt}, ${agentWakeupRequests.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`,
        sql`${wakeText} ~* ${ACCOUNTING_HOLD_PATTERN}`))
      .orderBy(asc(agentWakeupRequests.updatedAt), asc(agentWakeupRequests.id)).limit(limit);
    for (const row of rows) violations.push({ rule: "I3_admission_independent", kind: "wake_request", recordId: row.id,
      companyId: row.companyId, runId: row.runId, issueId: row.issueId, reason: "refused_for_accounting_hold" });
    if (rows.length > 0) position = { at: rows[rows.length - 1]!.updatedAt, id: rows[rows.length - 1]!.id };
    if (rows.length < limit) break;
    if (page === 9) backlog = true;
  }
  state.admissionWakeCursor = position;
  position = state.admissionRunCursor ?? start;
  for (let page = 0; page < 10; page++) {
    const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId,
      updatedAt: sql<string>`${heartbeatRuns.updatedAt}::text` })
      .from(heartbeatRuns).where(and(
        sql`(${heartbeatRuns.updatedAt}, ${heartbeatRuns.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`,
        inArray(heartbeatRuns.status, ["cancelled", "failed"]), sql`${runText} ~* ${ACCOUNTING_HOLD_PATTERN}`))
      .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id)).limit(limit);
    for (const row of rows) violations.push({ rule: "I3_admission_independent", kind: "queued_run", recordId: row.id,
      companyId: row.companyId, runId: row.id, issueId: row.issueId, reason: "refused_for_accounting_hold" });
    if (rows.length > 0) position = { at: rows[rows.length - 1]!.updatedAt, id: rows[rows.length - 1]!.id };
    if (rows.length < limit) break;
    if (page === 9) backlog = true;
  }
  state.admissionRunCursor = position;
  state.admissionBacklog = backlog;
  return violations;
}

/** A deferred intent still waiting this long after its hold can have
 * cleared missed its release event (invariant 4). */
const DEFERRED_PROMOTION_GRACE_MS = 5 * 60_000;

/** Deferred pause refusals whose pause has lifted (company active, agent not paused)
 * but that no release event promoted. The reconciliation worker promotes them
 * through `promoteDeferredWorkIntents` as a backstop. */
async function checkDeferredIntentsPromoted(db: Db, now: Date, limit: number): Promise<{ violations: InvariantViolation[]; nextDueAt: Date | null }> {
  // Only refusals whose hold this check can read cheaply and exactly.
  const pauseRefusal = sql`${agentWakeupRequests.payload}->'executionWait'->>'reason' in ('company.inactive', 'agent.not_invokable')`;
  const holdCleared = sql`exists (select 1 from companies c where c.id = ${agentWakeupRequests.companyId} and c.status = 'active')
    and exists (select 1 from agents a where a.id = ${agentWakeupRequests.agentId} and a.status not in ('paused', 'terminated', 'pending_approval'))
    -- A message saved behind a live run or a held lock still has an owner.
    and not exists (select 1 from issues i where i.id::text = ${agentWakeupRequests.payload}->>'issueId'
      and i.company_id = ${agentWakeupRequests.companyId} and i.execution_run_id is not null)
    and not exists (select 1 from heartbeat_runs live_run where live_run.company_id = ${agentWakeupRequests.companyId}
      and (live_run.context_snapshot->>'issueId' = ${agentWakeupRequests.payload}->>'issueId'
        or live_run.native_issue_id::text = ${agentWakeupRequests.payload}->>'issueId')
      and live_run.status in ('queued', 'running', 'scheduled_retry'))`;
  const graceStart = new Date(now.getTime() - DEFERRED_PROMOTION_GRACE_MS);
  const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
    issueId: sql<string | null>`${agentWakeupRequests.payload}->>'issueId'` }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), pauseRefusal,
      lt(agentWakeupRequests.updatedAt, graceStart), holdCleared))
    .orderBy(asc(agentWakeupRequests.id)).limit(Math.min(limit, MAX_RECORDS_PER_KIND));
  // A cleared hold inside its grace window is a saved deadline: the worker
  // checks again when it ends. A hold still in force needs no deadline; its
  // release (company or agent lifecycle change) wakes the worker.
  const [due] = await db.select({ at: sql<Date | null>`min(${agentWakeupRequests.updatedAt})` }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), pauseRefusal,
      sql`${agentWakeupRequests.updatedAt} >= ${graceStart.toISOString()}::timestamptz`, holdCleared));
  return {
    violations: rows.map(row => ({ rule: "I4_exactly_once_intent" as const, kind: "wake_request_deferred", recordId: row.id,
      companyId: row.companyId, runId: null, issueId: row.issueId, reason: DEFERRED_INTENT_NOT_PROMOTED })),
    nextDueAt: due?.at ? new Date(new Date(due.at).getTime() + DEFERRED_PROMOTION_GRACE_MS) : null,
  };
}

export const DEFERRED_INTENT_NOT_PROMOTED = "deferred_after_hold_cleared";

/** Invariant 4 with section E's closed outcomes: an accepted intent (a user's
 * request or a message) ended terminally on a refusal that
 * `TEMPORARY_REFUSAL_TRIGGERS` lists as temporary. The refusal code is the
 * wake's `reason`, never its free-text error, so a retry that delivered the
 * intent is not a false positive. The scan pages by (updated_at, id), so a
 * busy window is read in full across passes. */
async function checkExactlyOnceIntents(db: Db, state: OwnershipReportState, now: Date, limit: number): Promise<InvariantViolation[]> {
  // The cursor keeps PostgreSQL's microsecond text form: a JS Date would round
  // it down and read the boundary row again.
  const cursor = state.intentCursor ?? { at: new Date(now.getTime() - INTENT_LOOKBACK_MS).toISOString(),
    id: "00000000-0000-0000-0000-000000000000" };
  const violations: InvariantViolation[] = [];
  let position = cursor;
  for (let page = 0; page < 10; page++) {
    const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
      runId: agentWakeupRequests.runId, updatedAt: sql<string>`${agentWakeupRequests.updatedAt}::text` })
      .from(agentWakeupRequests).where(and(inArray(agentWakeupRequests.status, ["skipped", "failed"]),
        sql`(${agentWakeupRequests.updatedAt}, ${agentWakeupRequests.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`,
        inArray(agentWakeupRequests.reason, Object.keys(TEMPORARY_REFUSAL_TRIGGERS)),
        // A reached hard stop is a terminal outcome that shares the budget code.
        sql`not (${agentWakeupRequests.reason} = 'budget.blocked'
          and coalesce(${agentWakeupRequests.error}, '') ~* 'hard-stop|no reliable price')`,
        or(eq(agentWakeupRequests.requestedByActorType, "user"),
          sql`${agentWakeupRequests.payload} ? 'commentId'`,
          sql`jsonb_typeof(${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'`)))
      .orderBy(asc(agentWakeupRequests.updatedAt), asc(agentWakeupRequests.id)).limit(limit);
    for (const row of rows) {
      violations.push({ rule: "I4_exactly_once_intent", kind: "wake_request", recordId: row.id, companyId: row.companyId,
        runId: row.runId, issueId: null, reason: "terminal_on_temporary_refusal" });
    }
    if (rows.length > 0) position = { at: rows[rows.length - 1]!.updatedAt, id: rows[rows.length - 1]!.id };
    if (rows.length < limit) { state.intentBacklog = false; break; }
    // Ten full pages: the rest of a busy window waits for the next pass.
    state.intentBacklog = page === 9;
  }
  state.intentCursor = position;
  return violations;
}

/** An agent-assigned in-progress issue with no live run, no pending wake and
 * no open recovery action has no next action (invariant 7). Issues still in
 * their grace window return the time they become checkable. */
async function checkVisibleNextAction(db: Db, now: Date, limit: number): Promise<{ violations: InvariantViolation[]; nextDueAt: Date | null }> {
  const rows: Array<{ id: string; companyId: string; executionRunId: string | null; updatedAt: Date }> = [];
  for (let offset = 0; offset < MAX_RECORDS_PER_KIND; offset += limit) {
    const page = await db.select({ id: issues.id, companyId: issues.companyId, executionRunId: issues.executionRunId,
    updatedAt: issues.updatedAt })
    .from(issues).where(and(eq(issues.status, "in_progress"), isNotNull(issues.assigneeAgentId),
      // A saved monitor deadline is a first-class wait path (SPEC-implementation).
      or(isNull(issues.monitorNextCheckAt), lt(issues.monitorNextCheckAt, now)),
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
    )).orderBy(asc(issues.updatedAt), asc(issues.id)).limit(limit).offset(offset);
    rows.push(...page);
    if (page.length < limit) break;
  }
  const cutoff = now.getTime() - NEXT_ACTION_GRACE_MS;
  const violations: InvariantViolation[] = [];
  let nextDueAt: Date | null = null;
  for (const row of rows) {
    if (row.updatedAt.getTime() < cutoff) {
      violations.push({ rule: "I7_visible_next_action", kind: "issue", recordId: row.id, companyId: row.companyId,
        runId: row.executionRunId, issueId: row.id, reason: row.executionRunId ? "lock_without_live_run" : "no_owner_no_wake" });
    } else {
      // Rows are ordered by updated_at, so the first one in grace is earliest.
      nextDueAt ??= new Date(row.updatedAt.getTime() + NEXT_ACTION_GRACE_MS);
    }
  }
  return { violations, nextDueAt };
}

export async function runOwnershipReconciliationPass(db: Db, options: {
  state: OwnershipReportState;
  kinds?: readonly OwnableKind[];
  limitPerKind?: number;
  probe?: ProcessProbe;
  now?: Date;
  /** Write new violations to the activity log. Defaults to true. */
  record?: boolean;
  /** Settle proven-gone records of kinds that register a `settle`, and surface
   * their unprovable operator actions. Defaults to `record`; a read-only pass
   * never changes a record. */
  settle?: boolean;
}): Promise<OwnershipReport> {
  const now = options.now ?? new Date();
  const limit = options.limitPerKind ?? 200;
  const kinds = options.kinds ?? OWNABLE_KINDS;
  const state = options.state;
  const kindReports: KindReport[] = [];
  const violations: InvariantViolation[] = [];
  const goneThisPass = new Set<string>();
  const settleRecords = options.settle ?? options.record !== false;
  let retryNeeded = false;

  for (const kind of kinds) {
    const report: KindReport = { kind: kind.id, obligation: kind.obligation, storage: kind.storage, inProgress: 0,
      truncated: false, verdicts: { gone: 0, alive: 0, unprovable: 0 }, reasons: {}, settled: 0, watched: 0,
      ...(kind.coverageGap ? { coverageGap: kind.coverageGap } : {}) };
    kindReports.push(report);
    if (!kind.listInProgress) continue;
    // Read the whole kind in one pass, a page at a time, so rule I2 compares
    // the same records on consecutive passes. Past the cap the kind is
    // reported as truncated; that alone schedules no follow-up.
    const records: InProgressRecord[] = [];
    try {
      for (let offset = 0; ; offset += limit) {
        const listed = await kind.listInProgress(db, limit, offset);
        records.push(...listed.records);
        if (!listed.truncated) break;
        if (records.length >= MAX_RECORDS_PER_KIND) { report.truncated = true; break; }
      }
      await resolveFenceHolders(db, records);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      retryNeeded = true;
      continue;
    }
    // Offset pages can repeat a row when a lower id is inserted between pages.
    const unique = [...new Map(records.map(record => [record.recordId, record])).values()];
    report.inProgress = unique.length;
    const runProofs = await classifyRunOwners(db, unique);
    for (const record of unique) {
      const proof = await classify(record.owner, runProofs, options.probe, now);
      report.verdicts[proof.verdict] += 1;
      report.reasons[proof.reason] = (report.reasons[proof.reason] ?? 0) + 1;
      const base = { kind: kind.id, recordId: record.recordId, companyId: record.companyId,
        runId: record.runId, issueId: record.issueId };
      if (kind.invariantChecks.includes(1) && record.owner.kind === "none") {
        violations.push({ ...base, rule: "I1_owned", reason: "no_owner_stamp" });
      }
      if (settleRecords && kind.settle) {
        const outcome = await settleOrSurface(db, kind, record, proof, now);
        if (outcome === "settled") { report.settled += 1; continue; }
        if (outcome === "failed") retryNeeded = true;
        // An unprovable owner changes only by operator action, which signals.
        if (proof.verdict !== "unprovable") report.watched += 1;
      }
      if (kind.invariantChecks.includes(2) && proof.verdict === "gone") {
        const key = `${kind.id}:${record.recordId}`;
        goneThisPass.add(key);
        // Settled means terminal within one reconciler pass of the proof.
        if (state.goneLastPass.has(key)) violations.push({ ...base, rule: "I2_settled", reason: proof.reason });
      }
    }
  }

  let nextDueAt: Date | null = null;
  for (const check of [
    () => checkAdmissionIndependence(db, state, now, limit),
    () => checkExactlyOnceIntents(db, state, now, limit),
    async () => {
      const result = await checkDeferredIntentsPromoted(db, now, limit);
      if (result.nextDueAt && (!nextDueAt || result.nextDueAt < nextDueAt)) nextDueAt = result.nextDueAt;
      return result.violations;
    },
    async () => {
      const result = await checkVisibleNextAction(db, now, limit);
      if (result.nextDueAt && (!nextDueAt || result.nextDueAt < nextDueAt)) nextDueAt = result.nextDueAt;
      return result.violations;
    },
  ]) {
    try {
      violations.push(...await check());
    } catch (error) {
      retryNeeded = true;
      logger.warn({ err: error }, "ownership invariant check failed; the report continues");
    }
  }

  // Only a first proof needs a second pass; a record already reported for I2
  // is not a reason to keep scanning.
  if (state.intentBacklog || state.admissionBacklog) retryNeeded = true;
  const awaitingSecondProof = [...goneThisPass].filter(key => !state.goneLastPass.has(key)).length;
  state.goneLastPass = goneThisPass;
  // Violations whose activity row failed last time are written again, even
  // when a cursor-based check (I4) does not read them a second time.
  const byKey = new Map(violations.map(violation => [violationKey(violation), violation]));
  for (const [key, entry] of state.unwritten) if (!byKey.has(key)) byKey.set(key, entry.violation);
  violations.length = 0;
  violations.push(...byKey.values());
  const newViolations = violations.filter(violation => !state.reported.has(violationKey(violation)));
  if (options.record !== false) {
    for (const violation of newViolations) {
      if (!violation.companyId) continue;
      try {
        await persistActivity(db, {
          companyId: violation.companyId, actorType: "system", actorId: OWNERSHIP_RECONCILER_ACTOR_ID,
          action: OWNERSHIP_INVARIANT_VIOLATION_ACTION, entityType: "ownership_record", entityId: violation.recordId,
          details: { rule: violation.rule, kind: violation.kind, reason: violation.reason,
            runId: violation.runId, issueId: violation.issueId, mode: "report_only" }, // violations are reported, never repaired
        });
      } catch (error) {
        logger.warn({ err: error, rule: violation.rule, kind: violation.kind }, "failed to record ownership invariant violation");
        const key = violationKey(violation);
        const attempts = (state.unwritten.get(key)?.attempts ?? 0) + 1;
        if (attempts >= MAX_WRITE_ATTEMPTS) {
          // A poison row (for example a company that no longer exists) must
          // not keep the report retrying for the life of the process.
          state.unwritten.delete(key);
          state.reported.add(key);
        } else {
          state.unwritten.set(key, { violation, attempts });
          retryNeeded = true;
        }
        continue;
      }
      state.unwritten.delete(violationKey(violation));
      state.reported.add(violationKey(violation));
    }
    for (const violation of newViolations) {
      if (violation.companyId) continue;
      // No company to attach an activity row to (for example an unreadable
      // spool file): the server log is the only record.
      logger.warn({ rule: violation.rule, kind: violation.kind, recordId: violation.recordId, reason: violation.reason },
        "ownership invariant violation without a company");
      state.reported.add(violationKey(violation));
    }
  }

  const inProgress = kindReports.reduce((total, report) => total + report.inProgress, 0);
  const settleWatch = kindReports.reduce((total, report) => total + report.watched, 0);
  const report: OwnershipReport = { at: now.toISOString(), inProgress, kinds: kindReports, violations,
    newViolations, coverageGaps: COVERAGE_GAPS, awaitingSecondProof, nextDueAt, settleWatch, retryNeeded };
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
