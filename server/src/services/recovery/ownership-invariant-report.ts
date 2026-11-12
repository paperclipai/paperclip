import { and, asc, eq, inArray, isNotNull, isNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  statusDecisions,
  type Db,
} from "@paperclipai/db";
import { NATIVE_RESPONSE_WAKE_WAITING_REASON } from "../native-runtime/status-arbiter.js";
import { taskClosedByAgentSql, TEMPORARY_REFUSAL_TRIGGERS } from "../work-intent-outbox.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { logger } from "../../middleware/logger.js";
import { getServerProcessStartedAt } from "../../server-info.js";
import { persistActivity } from "../activity-log.js";
import { QUEUED_RUN_NOT_DISPATCHED, readQueuedRunExecutionWindow, readUndispatchedQueuedRuns,
  type UndispatchedQueuedRunCursor } from "../queued-run-dispatch-liveness.js";
import { currentProcessProbe, proveOwnerGone, type OwnerProof, type ProcessProbe } from "../owner-proof.js";
import { LEGACY_OWNER_REASONS, recordVersionAttestations } from "./owner-gone-attestation.js";
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
 * (rules/data-paths.mdc).
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
    + "The I3 and I4 scans read ten pages per pass and continue from a cursor on the next pass. The I7 queued-run "
    + "check reads at most 2,000 undispatched queued runs per pass and continues from a cursor on the next pass.",
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
  /** Keyset cursor of the I7 queued-run check (created_at, id); null starts over. */
  queuedRunCursor: UndispatchedQueuedRunCursor | null;
  /** Earliest grace deadline seen in the earlier slices of the current queued-run scan. */
  queuedRunDueAt: Date | null;
};

export function createOwnershipReportState(): OwnershipReportState {
  return { goneLastPass: new Set(), reported: new Set(), intentCursor: null, unwritten: new Map(), intentBacklog: false,
    admissionWakeCursor: null, admissionRunCursor: null, admissionBacklog: false, queuedRunCursor: null,
    queuedRunDueAt: null };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
/** An in-progress issue must show a next action within this time. */
const NEXT_ACTION_GRACE_MS = 5 * 60_000;
/** A queued run whose ready agent runs nothing should start within this time. */
const QUEUED_RUN_DISPATCH_GRACE_MS = 5 * 60_000;
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
  // Issue owners share the map under an `issue:` key (run ids are bare UUIDs).
  const issueIds = [...new Set(records.flatMap(record => record.owner.kind === "issue" ? [record.owner.issueId] : []))];
  for (let index = 0; index < issueIds.length; index += 500) {
    const batch = issueIds.slice(index, index + 500);
    const rows = await db.select({ id: issues.id, status: issues.status, hiddenAt: issues.hiddenAt }).from(issues)
      .where(inArray(issues.id, batch));
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const issueId of batch) {
      const row = byId.get(issueId);
      proofs.set(`issue:${issueId}`, !row ? { verdict: "gone", reason: "owner_issue_missing" }
        : row.hiddenAt ? { verdict: "gone", reason: "owner_issue_hidden" }
        : TERMINAL_ISSUE_STATUSES.includes(row.status) ? { verdict: "gone", reason: "owner_issue_terminal" }
        : { verdict: "alive", reason: "owner_issue_active" });
    }
  }
  return proofs;
}

async function classify(owner: RecordOwner, runProofs: Map<string, Classification>, probe: ProcessProbe | undefined,
  now: Date, touchedAt: Date | null = null): Promise<Classification> {
  switch (owner.kind) {
    // The record's last write time lets a replaced server boot be fenced only for work it touched under a valid lease.
    case "process": return proveOwnerGone(touchedAt ? { ...owner.stamp, touchedAt: touchedAt.toISOString() } : owner.stamp, probe);
    case "fence": return proveOwnerGone(owner.stamp, owner.fence, now);
    case "run": return runProofs.get(owner.runId) ?? { verdict: "unprovable", reason: "owner_run_unread" };
    case "issue": return runProofs.get(`issue:${owner.issueId}`) ?? { verdict: "unprovable", reason: "owner_issue_unread" };
    case "operator": return { verdict: "alive", reason: "operator_owned" };
    // A queue is not a process: it is never proven gone. A deadline long past
    // means the queue is not acting, which is a gap to report, not a release.
    case "queue": return now.getTime() - owner.dueAt.getTime() > owner.graceMs
      ? { verdict: "unprovable", reason: "queue_overdue" } : { verdict: "alive", reason: "queue_scheduled" };
    case "none": return { verdict: "unprovable", reason: "no_owner_stamp" };
  }
}

/**
 * A board confirmation that a record's unrecorded owner stopped proves that owner gone
 * (`operator_attested`), but only while the prover still finds the owner unprovable for a legacy
 * reason and the record is unchanged since recovery asked. A live or provable owner always wins.
 */
async function applyOwnerGoneAttestations(db: Db, kind: OwnableKind, records: readonly InProgressRecord[],
  proofs: Classification[]): Promise<Classification[]> {
  if (kind.ownerGoneAttestation !== "record_version") return proofs;
  const legacy = (record: InProgressRecord, proof: Classification) => record.owner.kind === "process"
    && proof.verdict === "unprovable" && LEGACY_OWNER_REASONS.has(proof.reason);
  const candidates = records.filter((record, index) => legacy(record, proofs[index]!));
  if (!candidates.length) return proofs;
  const attested = await recordVersionAttestations(db, kind.id, candidates);
  return proofs.map((proof, index) => legacy(records[index]!, proof) && attested.has(records[index]!.recordId)
    ? { verdict: "gone", reason: "operator_attested" } : proof);
}

/** Settles a proven-gone record, or surfaces the operator action for an
 * unprovable one. A failure is logged and retried on a later pass. */
async function settleOrSurface(db: Db, kind: OwnableKind, record: InProgressRecord, proof: Classification,
  now: Date): Promise<"settled" | "kept" | "unwatched" | "failed"> {
  try {
    if (proof.verdict === "gone" && kind.settle) {
      const outcome = await kind.settle(db, record, { now, proof: proof as OwnerProof });
      return outcome.settled ? "settled" : outcome.watch === false ? "unwatched" : "kept";
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
  const proofs: Classification[] = [];
  for (const record of unique) proofs.push(await classify(record.owner, runProofs, options.probe, now, record.updatedAt));
  const attestedProofs = await applyOwnerGoneAttestations(db, kind, unique, proofs);
  for (const [index, record] of unique.entries()) {
    let proof = attestedProofs[index]!;
    if (options.currentProcessIdle && record.runId && proof.verdict === "alive" && proof.reason === "current_process") {
      proof = { verdict: "gone", reason: "current_process_idle" };
    }
    if (options.currentProcessIdle) proof = { ...proof, localExecutionsKnown: true };
    const outcome = await settleOrSurface(db, kind, record, proof, now);
    if (outcome === "settled") {
      settled.push({ kind: kind.id, recordId: record.recordId, runId: record.runId, reason: proof.reason });
    } else if (outcome !== "unwatched" && proof.verdict !== "unprovable") {
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
  // Only messages the pause path saved, whose hold this check can read
  // exactly. Each read is capped like every other check in this report.
  const pauseRefusal = sql`${agentWakeupRequests.payload}->'executionWait'->>'trigger' = 'pause_lifted'
    and ${agentWakeupRequests.payload}->'executionWait'->>'reason' in ('company.inactive', 'agent.not_invokable')`;
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
  const pending = await db.select({ at: agentWakeupRequests.updatedAt }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), pauseRefusal,
      sql`${agentWakeupRequests.updatedAt} >= ${graceStart.toISOString()}::timestamptz`, holdCleared))
    .limit(MAX_RECORDS_PER_KIND);
  const due = pending.length ? { at: new Date(Math.min(...pending.map(row => new Date(row.at).getTime()))) } : null;
  return {
    violations: rows.map(row => ({ rule: "I4_exactly_once_intent" as const, kind: "wake_request_deferred", recordId: row.id,
      companyId: row.companyId, runId: null, issueId: row.issueId, reason: DEFERRED_INTENT_NOT_PROMOTED })),
    nextDueAt: due?.at ? new Date(new Date(due.at).getTime() + DEFERRED_PROMOTION_GRACE_MS) : null,
  };
}

export const DEFERRED_INTENT_NOT_PROMOTED = "deferred_after_hold_cleared";
export const USER_COMMENT_WITHOUT_WAKE = "user_comment_without_wake";
/** A user comment younger than this may still be getting its normal wake. */
const COMMENT_WAKE_GRACE_MS = 30_000;

export const USER_COMMENT_DROPPED_BY_STALE_RUN = "user_comment_dropped_by_stale_continuation";

/** Whether a run of comment `c`'s task matches `condition`. A run belongs to
 * the task by its legacy context or its native column. Each binding is a
 * separate indexed probe per comment: one OR across both lets PostgreSQL hash
 * every run of the company and read each run's context. `offset 0` keeps each
 * probe a per-row index lookup; without it PostgreSQL can also build a hashed
 * subplan or a hash join over all runs of the company. */
function taskRuns(alias: string, condition: SQL) {
  const run = sql.raw(alias);
  return sql`(exists (select 1 from heartbeat_runs ${run} where ${run}.company_id = c.company_id
      and ${run}.context_snapshot->>'issueId' = c.issue_id::text and ${condition} offset 0)
    or exists (select 1 from heartbeat_runs ${run} where ${run}.company_id = c.company_id
      and ${run}.native_issue_id = c.issue_id and ${condition} offset 0))`;
}

/** Invariant 4, the durable half of the stale-continuation rule (chaos
 * s9401/t72). A user comment on a done task whose only carrying wakes were
 * cancelled as stale continuations, that a settled agent run which started
 * before it never read (it finished after the comment), and that no later
 * run received (the shared per-comment delivery check). The decision waits for the closing run to settle, so it
 * also covers a stale check that ran before that run reached succeeded, or a
 * save that failed. The worker saves it so the release drain reopens the
 * task and delivers it once. */
export async function checkStaleDroppedComments(db: Db, now: Date, limit: number): Promise<InvariantViolation[]> {
  const since = new Date(now.getTime() - INTENT_LOOKBACK_MS).toISOString();
  // Two stages. The first keeps the comments that a stale-continuation
  // cancellation dropped and that no open wake carries. These are rare, so the
  // run probes (taskRuns) read only these few comments. `offset 0` keeps the
  // stale-wake lookup a per-comment index probe; without it PostgreSQL can
  // hash every wake request of the company and read each payload.
  const rows = await db.execute<{ id: string; company_id: string; issue_id: string; agent_id: string }>(sql`
    with dropped as materialized (
      select c.id, c.company_id, c.issue_id, c.created_at, i.assignee_agent_id as agent_id from issue_comments c
      join issues i on i.id = c.issue_id and i.company_id = c.company_id
      where c.author_user_id is not null and c.deleted_at is null
        and c.author_agent_id is null and c.created_by_run_id is null and c.created_at >= ${since}::timestamptz
        and i.status = 'done' and i.assignee_agent_id is not null and i.conversation_agent_id is null
        and ${taskClosedByAgentSql(sql`c.company_id`, sql`c.issue_id`)}
        and exists (select 1 from agent_wakeup_requests stale where stale.company_id = c.company_id
          and stale.payload->>'issueId' = c.issue_id::text and stale.status = 'cancelled'
          and stale.error = 'continuation_task_ownership_changed'
          and (stale.payload->>'commentId' = c.id::text
            or coalesce(stale.payload#>'{_paperclipWakeContext,wakeCommentIds}', '[]'::jsonb) ? c.id::text) offset 0)
        and not exists (select 1 from agent_wakeup_requests open_wake where open_wake.company_id = c.company_id
          and open_wake.payload->>'issueId' = c.issue_id::text
          and open_wake.status not in ('cancelled', 'skipped', 'failed', 'coalesced')
          and (open_wake.payload->>'commentId' = c.id::text
            or coalesce(open_wake.payload#>'{_paperclipWakeContext,wakeCommentIds}', '[]'::jsonb) ? c.id::text))
    )
    select c.id, c.company_id, c.issue_id, c.agent_id from dropped c
    where ${taskRuns("closing", sql`closing.agent_id = c.agent_id and closing.status = 'succeeded'
        and closing.started_at < c.created_at and closing.finished_at >= c.created_at`)}
      and not ${taskRuns("r", sql`r.status in ('queued', 'running', 'scheduled_retry')`)}
    order by c.created_at limit ${Math.min(limit, MAX_RECORDS_PER_KIND)}`);
  // Consumption is per comment: a later run counts only if it received this
  // comment (its own wake input, or a retry's task history), never ordinary
  // task history of another message's turn.
  const owed: typeof rows[number][] = [];
  for (const row of rows) {
    const delivered = await deliveredQueuedCommentIds(db, { companyId: row.company_id, issueId: row.issue_id,
      agentId: row.agent_id, commentIds: [row.id] });
    if (!delivered.has(row.id)) owed.push(row);
  }
  return owed.map(row => ({ rule: "I4_exactly_once_intent" as const, kind: "issue_comment", recordId: row.id,
    companyId: row.company_id, runId: null, issueId: row.issue_id, reason: USER_COMMENT_DROPPED_BY_STALE_RUN }));
}

/** Invariant 4, reconciler-owned rule: an undelivered user comment newer than
 * the task's last run gets a wake. A comment commits before its wake is
 * written, so a restart in between loses the wake (chaos s9401/t69). This
 * finds a user comment on an assigned, non-conversation task with no live run
 * or lock, newer than every run of the task, that no wake request carries.
 * The reconciliation worker saves it as a deferred receipt and promotes it. */
export async function checkUserCommentsWithoutWake(db: Db, now: Date, limit: number, processStartedAt: Date): Promise<{ violations: InvariantViolation[]; nextDueAt: Date | null }> {
  const since = new Date(now.getTime() - INTENT_LOOKBACK_MS).toISOString();
  // Run lookups are taskRuns probes. `offset 0` also keeps the steer check's
  // event lookup a per-row index lookup; without it PostgreSQL can build a
  // hash join over all events of the company.
  // Three stages, cheapest first. Most user comments have a wake (stage one)
  // or a later run (stage two). Only the few comments left reach the steer
  // check, which reads run event payloads.
  const rows = await db.execute<{ id: string; company_id: string; issue_id: string; created_at: string }>(sql`
    with unwoken as materialized (
      select c.id, c.company_id, c.issue_id, c.created_at from issue_comments c
      join issues i on i.id = c.issue_id and i.company_id = c.company_id
      where c.author_user_id is not null and c.deleted_at is null
        and c.author_agent_id is null and c.created_by_run_id is null
        and c.created_at >= ${since}::timestamptz
        and i.assignee_agent_id is not null and i.conversation_agent_id is null
        and (i.status in ('todo', 'in_progress')
          or (i.status = 'done' and ${taskClosedByAgentSql(sql`c.company_id`, sql`c.issue_id`)}))
        and i.execution_run_id is null
        and not exists (select 1 from agent_wakeup_requests w where w.company_id = c.company_id
          and w.payload->>'issueId' = c.issue_id::text
          and (w.payload->>'commentId' = c.id::text
            or coalesce(w.payload#>'{_paperclipWakeContext,wakeCommentIds}', '[]'::jsonb) ? c.id::text))
    ), candidate as materialized (
      select c.id, c.company_id, c.issue_id, c.created_at from unwoken c
      where not ${taskRuns("r", sql`(r.status in ('queued', 'running', 'scheduled_retry')
          or coalesce(r.started_at, r.created_at) >= c.created_at)`)}
        and ${taskRuns("prior", sql`true`)}
    )
    select c.id, c.company_id, c.issue_id, c.created_at::text as created_at from candidate c
    where not ${taskRuns("steered", sql`coalesce(steered.started_at, steered.created_at) <= c.created_at
      and (steered.finished_at is null or steered.finished_at >= c.created_at)
      and exists (select 1 from heartbeat_run_events steer_event
        where steer_event.company_id = steered.company_id and steer_event.run_id = steered.id
          and steer_event.event_type in ('item.started', 'item.completed')
          and steer_event.created_at >= c.created_at
          and strpos(steer_event.payload::text, c.id::text) > 0 offset 0)`)}
    order by c.created_at limit ${Math.min(limit, MAX_RECORDS_PER_KIND)}`);
  // A comment inside the grace may still get its normal wake: check it again
  // when the grace ends (a saved deadline), and report only older ones. This
  // process writes that wake after the comment commits, so a comment from
  // before it started has no writer left and is owed now.
  const graceEnd = Math.max(now.getTime() - COMMENT_WAKE_GRACE_MS, processStartedAt.getTime());
  const young = [...rows].map(row => new Date(row.created_at).getTime()).filter(at => at >= graceEnd);
  return {
    violations: [...rows].filter(row => new Date(row.created_at).getTime() < graceEnd)
      .map(row => ({ rule: "I4_exactly_once_intent" as const, kind: "issue_comment", recordId: row.id,
        companyId: row.company_id, runId: null, issueId: row.issue_id, reason: USER_COMMENT_WITHOUT_WAKE })),
    nextDueAt: young.length ? new Date(Math.min(...young) + COMMENT_WAKE_GRACE_MS) : null,
  };
}

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

function parkedResponseWakeWait(db: Db) {
  return db.select({ one: sql`1` }).from(statusDecisions)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, statusDecisions.runId),
      eq(nativeRunFinalizations.companyId, statusDecisions.companyId), eq(nativeRunFinalizations.issueId, statusDecisions.issueId),
      eq(nativeRunFinalizations.decisionId, statusDecisions.id), eq(nativeRunFinalizations.phase, "committed")))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, statusDecisions.runId), eq(heartbeatRuns.companyId, statusDecisions.companyId),
      eq(heartbeatRuns.nativeIssueId, statusDecisions.issueId), eq(heartbeatRuns.agentId, issues.assigneeAgentId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "succeeded"), isNotNull(heartbeatRuns.startedAt)))
    .where(and(eq(statusDecisions.id, issues.lastStatusDecisionId), eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id), eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.reasonCode, NATIVE_RESPONSE_WAKE_WAITING_REASON), isNull(issues.assigneeUserId), isNull(issues.hiddenAt),
      notExists(db.select({ one: sql`1` }).from(issueComments).where(and(
        eq(issueComments.companyId, issues.companyId), eq(issueComments.issueId, issues.id),
        eq(issueComments.authorType, "user"), isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
        sql`${issueComments.createdAt} > ${heartbeatRuns.startedAt}`)))));
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
      // A saved monitor deadline is a first-class wait path (doc/execution-semantics.md §8).
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
      notExists(parkedResponseWakeWait(db)),
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

/** A queued run counts as an issue's next action only while dispatch can still
 * start it. One that stays queued past the grace window while its ready agent
 * runs nothing has lost its dispatch signal (invariant 7). */
async function checkQueuedRunsDispatched(db: Db, state: OwnershipReportState, now: Date, limit: number):
  Promise<{ violations: InvariantViolation[]; nextDueAt: Date | null }> {
  const window = await readQueuedRunExecutionWindow(db);
  if (!window.dispatches) {
    state.queuedRunCursor = null; state.queuedRunDueAt = null;
    return { violations: [], nextDueAt: null };
  }
  if (state.queuedRunDueAt && state.queuedRunDueAt <= now) { state.queuedRunCursor = null; state.queuedRunDueAt = null; }
  const { runs, next } = await readUndispatchedQueuedRuns(db, { pageSize: limit, createdAfter: window.createdAfter,
    after: state.queuedRunCursor, maxRuns: MAX_RECORDS_PER_KIND });
  state.queuedRunCursor = next;
  const carried = state.queuedRunDueAt;
  const cutoff = now.getTime() - QUEUED_RUN_DISPATCH_GRACE_MS;
  const violations: InvariantViolation[] = [];
  let nextDueAt: Date | null = null;
  for (const run of runs) {
    if (run.createdAt.getTime() < cutoff) {
      violations.push({ rule: "I7_visible_next_action", kind: "queued_run", recordId: run.runId, companyId: run.companyId,
        runId: run.runId, issueId: run.issueId, reason: QUEUED_RUN_NOT_DISPATCHED });
    } else {
      nextDueAt ??= new Date(run.createdAt.getTime() + QUEUED_RUN_DISPATCH_GRACE_MS);
    }
  }
  if (carried && (!nextDueAt || carried < nextDueAt)) nextDueAt = carried;
  state.queuedRunDueAt = next ? nextDueAt : null;
  return { violations, nextDueAt };
}

export async function runOwnershipReconciliationPass(db: Db, options: {
  state: OwnershipReportState;
  kinds?: readonly OwnableKind[];
  limitPerKind?: number;
  probe?: ProcessProbe;
  now?: Date;
  processStartedAt?: Date;
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
  let queueDueAt: Date | null = null;
  const settleRecords = options.settle ?? options.record !== false;
  // A pass that settles nothing must not fence another boot's lease either.
  const passProbe = settleRecords ? options.probe : { ...(options.probe ?? currentProcessProbe()), readOnly: true };
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
    const classified: Classification[] = [];
    for (const record of unique) classified.push(await classify(record.owner, runProofs, passProbe, now, record.updatedAt));
    const proofs = await applyOwnerGoneAttestations(db, kind, unique, classified);
    for (const [index, record] of unique.entries()) {
      const proof = proofs[index]!;
      report.verdicts[proof.verdict] += 1;
      report.reasons[proof.reason] = (report.reasons[proof.reason] ?? 0) + 1;
      const base = { kind: kind.id, recordId: record.recordId, companyId: record.companyId,
        runId: record.runId, issueId: record.issueId };
      if (kind.invariantChecks.includes(1) && record.owner.kind === "none") {
        violations.push({ ...base, rule: "I1_owned", reason: "no_owner_stamp" });
      }
      if (kind.invariantChecks.includes(7) && record.owner.kind === "queue") {
        if (proof.reason === "queue_overdue") {
          violations.push({ ...base, rule: "I7_visible_next_action", reason: "queue_overdue" });
        } else {
          // Re-check when this item would become overdue, so a queue that stops
          // acting without another write is still reported.
          const overdueAt = new Date(record.owner.dueAt.getTime() + record.owner.graceMs + 1);
          if (!queueDueAt || overdueAt < queueDueAt) queueDueAt = overdueAt;
        }
      }
      if (settleRecords && kind.settle) {
        const outcome = await settleOrSurface(db, kind, record, proof, now);
        if (outcome === "settled") { report.settled += 1; continue; }
        if (outcome === "failed") retryNeeded = true;
        // An unprovable owner changes only by operator action, which signals;
        // so does a record whose settle has nothing left to do.
        if (outcome !== "unwatched" && proof.verdict !== "unprovable") report.watched += 1;
      }
      if (kind.invariantChecks.includes(2) && proof.verdict === "gone") {
        const key = `${kind.id}:${record.recordId}`;
        goneThisPass.add(key);
        // Settled means terminal within one reconciler pass of the proof.
        if (state.goneLastPass.has(key)) violations.push({ ...base, rule: "I2_settled", reason: proof.reason });
      }
    }
  }

  let nextDueAt: Date | null = queueDueAt;
  for (const check of [
    () => checkAdmissionIndependence(db, state, now, limit),
    () => checkExactlyOnceIntents(db, state, now, limit),
    () => checkStaleDroppedComments(db, now, limit),
    async () => {
      const result = await checkUserCommentsWithoutWake(db, now, limit,
        options.processStartedAt ?? new Date(getServerProcessStartedAt()));
      if (result.nextDueAt && (!nextDueAt || result.nextDueAt < nextDueAt)) nextDueAt = result.nextDueAt;
      return result.violations;
    },
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
    async () => {
      const result = await checkQueuedRunsDispatched(db, state, now, limit);
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
  // A settling kind can become settleable at a known time without a signal
  // (a retention window ending); wake then.
  for (const kind of kinds) {
    if (!settleRecords || !kind.settle || !kind.nextDueAt) continue;
    try {
      const due = await kind.nextDueAt(db, now);
      const current = nextDueAt as Date | null;
      if (due && (!current || due < current)) nextDueAt = due;
    } catch (error) {
      retryNeeded = true;
      logger.warn({ err: error, kind: kind.id }, "ownership due-time read failed; a later pass retries");
    }
  }

  // Only a first proof needs a second pass; a record already reported for I2
  // is not a reason to keep scanning.
  if (state.intentBacklog || state.admissionBacklog || state.queuedRunCursor) retryNeeded = true;
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
