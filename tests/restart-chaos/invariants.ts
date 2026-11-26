/**
 * Plan invariants I1–I8 for one wave (durable ownership plan, "Invariants").
 *
 * Runs the Phase 1 report-only ownership reconciler against the wave's own
 * database after every task rested. Nothing is written: `record: false`.
 *
 *   I1, I2  two passes at the real clock: a record with no owner stamp (I1),
 *           or whose owner was proven gone on both passes and is still in
 *           progress (I2: "settled within one reconciler pass").
 *   I3, I4, I7  one more pass with the clock moved past every grace window
 *           (accounting closure 10 min, next action 5 min). The tasks are at
 *           rest, so anything still waiting then would wait forever.
 *   I6      run-log proxy: a run that failed on a stale-generation event.
 *           Since #19960 an earlier generation's event is history and never
 *           fails the current turn (runner code `stale_generation_event`).
 *   I8      run-log check: every `run.performance.budget_exceeded` event the
 *           speed budgets wrote (TTFT, agent boot, restart recovery; #19863).
 *   I5      not measured: see I5_GAP. R3 (one Retry at most) bounds it.
 *
 * I6 and I8 are company-wide scans keyed by run or event id, so the per-point
 * baseline diff in main.ts charges each one to the point that produced it.
 */
import { createDb, type Db } from "../../packages/db/src/index.js";
import {
  createOwnershipReportState,
  runOwnershipReconciliationPass,
  type InvariantViolation,
} from "../../server/src/services/recovery/ownership-invariant-report.js";

export type PlanInvariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export type SuiteRule = InvariantViolation["rule"] | "I6_generation_fencing" | "I8_fast_turns";

/** A violation with the state of its record and run, so a failure is diagnosable after the instance is gone. */
export type EvidencedViolation = Omit<InvariantViolation, "rule"> & { rule: SuiteRule; evidence?: Record<string, unknown> };

/**
 * Why I5 (work-based budgets) is not asserted. A charge is decided per restart
 * claim from the attempt's event window (provider-attempt-outcome.ts, #19948)
 * and recorded only indirectly in the finalization's bounded recovery
 * history (progressAttempt, attemptKeptForProgress). Asserting it needs either
 * an explicit per-claim charge record or reading that history per run. The
 * cheap check that exists is R3, and the pre-spawn and pre-accept points
 * (native.process_start.*, runner.process.*, runner.turn_start.*) recover
 * without a Retry today.
 */
export const I5_GAP = "Charge decisions are not recorded per restart claim; needs an explicit charge record (section F follow-up). "
  + "R3 bounds it: no point needed a Retry.";

export interface InvariantCheck {
  violations: EvidencedViolation[];
  byInvariant: Partial<Record<PlanInvariant, number>>;
  inProgress: Record<string, { inProgress: number; gone: number; alive: number; unprovable: number }>;
  notMeasured: Partial<Record<PlanInvariant, string>>;
  errors: string[];
}

/** Grace windows the shifted pass must exceed (ownership-invariant-report.ts). */
export const GRACE_SHIFT_MS = 15 * 60_000;

export const invariantOf = (violation: Pick<EvidencedViolation, "rule">): PlanInvariant => violation.rule.slice(0, 2) as PlanInvariant;

export function summarizeViolations(violations: readonly Pick<EvidencedViolation, "rule">[]): Partial<Record<PlanInvariant, number>> {
  const counts: Partial<Record<PlanInvariant, number>> = {};
  for (const violation of violations) counts[invariantOf(violation)] = (counts[invariantOf(violation)] ?? 0) + 1;
  return counts;
}

/**
 * Local-disk kinds (usage-receipt and orphan-cleanup spools) resolve their
 * directories from the environment when listed. Point them at the wave's
 * instance, not the operator's, for the duration of the check.
 */
async function withWaveInstance<T>(instance: { paperclipHome: string; instanceId: string }, run: () => Promise<T>): Promise<T> {
  const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PAPERCLIP_HOME = instance.paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = instance.instanceId;
  delete process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
  try { return await run(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

const clip = (value: unknown) => typeof value === "string" ? value.slice(0, 300) : value ?? null;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** I6 and I8 from the run log of `companyId` (all companies when null). */
export async function runLogViolations(db: Db, companyId: string | null): Promise<EvidencedViolation[]> {
  const breaches = await db.$client.unsafe(
    `select e.id::text as id, e.company_id::text as "companyId", e.run_id::text as "runId", r.issue_id::text as "issueId", e.payload
       from heartbeat_run_events e join heartbeat_runs r on r.id = e.run_id
      where e.event_type = 'run.performance.budget_exceeded' and ($1::text is null or e.company_id::text = $1)`, [companyId]) as Row[];
  const stale = await db.$client.unsafe(
    `select id::text as id, company_id::text as "companyId", issue_id::text as "issueId", status, error_code as "errorCode", error
       from heartbeat_runs
      where status in ('failed', 'timed_out', 'interrupted')
        and (coalesce(error_code, '') ~* 'generation' or coalesce(error, '') ~* 'stale_generation|earlier generation')
        and ($1::text is null or company_id::text = $1)`, [companyId]) as Row[];
  return [
    ...breaches.map(row => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return { rule: "I8_fast_turns" as const, kind: "speed_budget", recordId: text(row.id), companyId: text(row.companyId) || null,
        runId: text(row.runId) || null, issueId: text(row.issueId) || null, reason: `${text(payload.metric) || "unknown"}_over_p95`,
        evidence: { budget: { metric: payload.metric, measuredMs: payload.measuredMs, budgetP95Ms: payload.budgetP95Ms,
          adapter: payload.adapter, startKind: payload.startKind } } };
    }),
    ...stale.map(row => ({ rule: "I6_generation_fencing" as const, kind: "run", recordId: text(row.id),
      companyId: text(row.companyId) || null, runId: text(row.id), issueId: text(row.issueId) || null,
      reason: "run_failed_on_earlier_generation_event" })),
  ];
}

async function withEvidence(db: Db, violations: EvidencedViolation[]): Promise<EvidencedViolation[]> {
  if (!violations.length) return violations;
  const wakeIds = violations.filter(violation => violation.kind === "wake_request" || violation.kind === "wake_request_claimed")
    .map(violation => violation.recordId);
  const runIds = [...new Set(violations.flatMap(violation => violation.runId ? [violation.runId] : []))];
  const wakes = (wakeIds.length ? await db.$client.unsafe(
    "select id::text, status, reason, error, run_id::text as \"runId\" from agent_wakeup_requests where id::text = any($1)", [wakeIds]) : []) as Row[];
  const runs = (runIds.length ? await db.$client.unsafe(
    "select id::text, status, error_code as \"errorCode\", error from heartbeat_runs where id::text = any($1)", [runIds]) : []) as Row[];
  const wakeById = new Map(wakes.map(wake => [wake.id, wake]));
  const runById = new Map(runs.map(run => [run.id, run]));
  return violations.map(violation => {
    const wake = wakeById.get(violation.recordId);
    const run = violation.runId ? runById.get(violation.runId) : undefined;
    const evidence = {
      ...(wake ? { wake: { status: wake.status, reason: clip(wake.reason), error: clip(wake.error), runId: wake.runId } } : {}),
      ...(run ? { run: { status: run.status, errorCode: run.errorCode, error: clip(run.error) } } : {}),
    };
    return Object.keys(evidence).length ? { ...violation, evidence } : violation;
  });
}

export async function checkPlanInvariants(input: {
  connectionString: string; companyId: string | null; paperclipHome: string; instanceId: string; now?: Date;
}): Promise<InvariantCheck> {
  const db = createDb(input.connectionString);
  const errors: string[] = [];
  try {
    const now = input.now ?? new Date();
    const pass = (state: ReturnType<typeof createOwnershipReportState>, at: Date) =>
      withWaveInstance(input, () => runOwnershipReconciliationPass(db, { state, now: at, record: false }));
    const state = createOwnershipReportState();
    // I2 needs the same record proven gone on both passes: a kind that failed
    // to list on the first pass has only one proof, so report it as incomplete.
    const first = await pass(state, now);
    for (const kind of first.kinds) if (kind.error) errors.push(`${kind.kind} (first I1/I2 pass): ${kind.error}`);
    if (first.retryNeeded) errors.push("the first I1/I2 pass did not finish (retryNeeded)");
    const second = await pass(state, new Date(now.getTime() + 1_000));
    // A failed I3/I4/I7 query is only logged by the pass and sets retryNeeded.
    // Retry once; a pass that still could not finish is an incomplete check.
    let shifted = await pass(createOwnershipReportState(), new Date(now.getTime() + GRACE_SHIFT_MS));
    if (shifted.retryNeeded) shifted = await pass(createOwnershipReportState(), new Date(now.getTime() + GRACE_SHIFT_MS));
    for (const kind of [...second.kinds, ...shifted.kinds]) if (kind.error) errors.push(`${kind.kind}: ${kind.error}`);
    if (second.retryNeeded) errors.push("the I1/I2 pass did not finish (retryNeeded)");
    if (shifted.retryNeeded) errors.push("the I3/I4/I7 pass did not finish after one retry (retryNeeded)");
    const ownCompany = (violation: InvariantViolation) => input.companyId === null || violation.companyId === null
      || violation.companyId === input.companyId;
    const fromClock = second.violations.filter(violation => violation.rule === "I1_owned" || violation.rule === "I2_settled");
    const fromShift = shifted.violations.filter(violation => violation.rule !== "I1_owned" && violation.rule !== "I2_settled");
    let runLog: EvidencedViolation[] = [];
    try { runLog = await runLogViolations(db, input.companyId); } catch (error) {
      errors.push(`I6/I8 run-log check: ${error instanceof Error ? error.message : String(error)}`);
    }
    const violations = await withEvidence(db, [...fromClock, ...fromShift].filter(ownCompany));
    violations.push(...runLog);
    const inProgress = Object.fromEntries(second.kinds.filter(kind => kind.inProgress > 0)
      .map(kind => [kind.kind, { inProgress: kind.inProgress, ...kind.verdicts }]));
    return {
      violations, byInvariant: summarizeViolations(violations), inProgress, errors,
      notMeasured: { I5: I5_GAP },
    };
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * U3 evidence from the wave database (universal.ts): every failed run's error
 * text and every recovery action's cause, so a bare "Error" or an empty
 * message is caught even where the board's run list hides the text. Read once
 * at wave end, before the instance is removed; grouped by issue.
 */
export async function readUniversalDbEvidence(db: Db, companyId: string): Promise<Map<string, import("./universal.js").UniversalDbEvidence>> {
  const runs = await db.$client.unsafe(
    `select id::text as id, coalesce(context_snapshot->>'issueId', '') as "issueId", left(error, 400) as error
       from heartbeat_runs where company_id::text = $1 and status in ('failed', 'timed_out')`, [companyId]) as Row[];
  const actions = await db.$client.unsafe(
    `select id::text as id, source_issue_id::text as "issueId", kind, left(cause, 400) as cause, left(next_action, 400) as "nextAction"
       from issue_recovery_actions where company_id::text = $1`, [companyId]) as Row[];
  const byIssue = new Map<string, { runMessages: Map<string, string | null>; recoveryActions: Array<{ id: string; kind: string; cause: string | null; nextAction: string | null }> }>();
  const entry = (issueId: string) => {
    let value = byIssue.get(issueId);
    if (!value) byIssue.set(issueId, value = { runMessages: new Map(), recoveryActions: [] });
    return value;
  };
  // A run is matched to its task by id in the grader, so runs without an issue id are kept under "".
  for (const run of runs) entry(text(run.issueId)).runMessages.set(text(run.id), typeof run.error === "string" ? run.error : null);
  for (const action of actions) entry(text(action.issueId)).recoveryActions.push({ id: text(action.id), kind: text(action.kind),
    cause: typeof action.cause === "string" ? action.cause : null, nextAction: typeof action.nextAction === "string" ? action.nextAction : null });
  return byIssue;
}
