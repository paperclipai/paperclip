import { eq, sql } from "drizzle-orm";
import { automaticRunBrakes, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { PERSON_WAKE_REASONS, RECOVERY_WAKE_REASONS } from "../heartbeat/queued-run-dispatch-order.js";
import { listPersonOriginSourceRunIds } from "../heartbeat/queued-run-line.js";
import { isTransientWorkspacePreparationCode } from "../heartbeat/retries.js";
import { BACKLOG_CONTINUATION_SOURCE_CODES, isPersonOwnedFailureCode } from "../fresh-continuation-fallback.js";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "../environment-provider-unavailable-error.js";

export const AUTOMATIC_RUN_BRAKE = {
  windowMs: 10 * 60_000,
  lookbackMs: 2 * 60 * 60_000,
  minCounted: 12,
  failureShare: 0.8,
  consecutiveProviderRefusals: 5,
  minOpenMs: 2 * 60_000,
  quietCloseMs: 15 * 60_000,
  probeIntervalMs: 60_000,
  probeRunningBoundMs: 10 * 60_000,
  probeSuccessesToRelease: 2,
  releaseIntervalMs: 60_000,
  releaseInitialRate: 2,
  releaseSteps: 6,
  creationIntervalMs: 60_000,
  cacheTtlMs: 5_000,
  maxCompanies: 256,
  maxRuns: 1_024,
  rowLimit: 500,
} as const;

export type AutomaticRunBrakeState = "closed" | "open" | "half_open";

export type AutomaticRunFacts = {
  id: string;
  companyId: string;
  retryOfRunId?: string | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

const EXTRA_AUTOMATIC_WAKE_REASONS: ReadonlySet<string> = new Set(["issue_assignment_recovery", "transient_failure_retry"]);

export function isAutomaticRun(run: AutomaticRunFacts): boolean {
  const context = run.contextSnapshot ?? {};
  const reason = typeof context.wakeReason === "string" ? context.wakeReason : null;
  if (context.explicitUserContinuation || context.taskRetryRequestId || (reason && PERSON_WAKE_REASONS.has(reason))) return false;
  return Boolean(run.retryOfRunId || run.scheduledRetryReason || context.previousRunId || context.retryReason
    || context.freshContinuationIsolation
    || (reason && (RECOVERY_WAKE_REASONS.has(reason) || EXTRA_AUTOMATIC_WAKE_REASONS.has(reason))));
}

export type AutomaticRunOutcome = "failed_before_starting" | "healthy" | "neutral";

export type AutomaticRunOutcomeFacts = {
  status: string;
  errorCode: string | null;
  runtimeMode: string | null;
  executionStage: string | null;
  startedAt: Date | null;
  hasOutput: boolean;
  providerWorkStarted: string | null;
};

export function classifyAutomaticRunOutcome(run: AutomaticRunOutcomeFacts): AutomaticRunOutcome {
  if (run.status === "running") return run.executionStage === "dispatching" || run.hasOutput ? "healthy" : "neutral";
  if (!run.startedAt || run.status === "cancelled" || !["succeeded", "failed", "timed_out", "interrupted"].includes(run.status)) return "neutral";
  if (run.status === "succeeded" || isPersonOwnedFailureCode(run.errorCode)) return "healthy";
  if (run.errorCode && (BACKLOG_CONTINUATION_SOURCE_CODES as readonly string[]).includes(run.errorCode)) return "neutral";
  const startPhase = run.providerWorkStarted === "false" || isTransientWorkspacePreparationCode(run.errorCode)
    || (run.runtimeMode === "legacy" && run.executionStage === "preparing");
  return startPhase ? "failed_before_starting" : "healthy";
}

type BrakeRow = typeof automaticRunBrakes.$inferSelect;

type SignalRow = {
  db_now: string | Date;
  id: string;
  status: string;
  error_code: string | null;
  runtime_mode: string | null;
  execution_stage: string | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  created_at: string | Date;
  has_output: boolean;
  provider_work_started: string | null;
  retry_of_run_id: string | null;
  scheduled_retry_reason: string | null;
  context: Record<string, unknown> | null;
};

type Evidence = {
  counted: number;
  failedBeforeStarting: number;
  healthy: number;
  providerRefusalStreak: boolean;
  recoveredSince: boolean;
  liveAutomatic: number;
  lastActivityAt: number | null;
};

export type AutomaticRunBrakeSnapshot = {
  companyId: string;
  state: AutomaticRunBrakeState;
  pausedSince: Date | null;
  stateChangedAt: Date | null;
  reason: Record<string, unknown>;
  nextProbeAt: Date | null;
  nextCreationAt: Date | null;
  probeRunId: string | null;
  probeSuccesses: number;
  dbNow: Date;
  evidence: Evidence;
};

const toDate = (value: string | Date | null | undefined) => value == null ? null : value instanceof Date ? value : new Date(value);

function boundedMap<K, V>(max: number) {
  const map = new Map<K, V>();
  return {
    get(key: K) {
      const value = map.get(key);
      if (value !== undefined) { map.delete(key); map.set(key, value); }
      return value;
    },
    set(key: K, value: V) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value as K);
    },
    delete(key: K) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

function rampStep(stateChangedAt: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - stateChangedAt.getTime()) / AUTOMATIC_RUN_BRAKE.releaseIntervalMs));
}

function evaluate(rows: SignalRow[], state: AutomaticRunBrakeState, lower: number, now: Date): Evidence {
  const automatic = rows.filter(row => isAutomaticRun({ id: row.id, companyId: "", retryOfRunId: row.retry_of_run_id,
    scheduledRetryReason: row.scheduled_retry_reason, contextSnapshot: row.context }));
  const liveAutomatic = automatic.filter(row => row.status === "queued" || row.status === "scheduled_retry").length;
  const outcomes = automatic.flatMap(row => {
    const finishedAt = toDate(row.finished_at);
    if (row.status !== "running" && (!finishedAt || finishedAt.getTime() < lower)) return [];
    const startedAt = toDate(row.started_at);
    if (row.status === "running" && (!startedAt || startedAt.getTime() < lower)) return [];
    const outcome = classifyAutomaticRunOutcome({ status: row.status, errorCode: row.error_code, runtimeMode: row.runtime_mode,
      executionStage: row.execution_stage, startedAt, hasOutput: row.has_output, providerWorkStarted: row.provider_work_started });
    return outcome === "neutral" ? [] : [{ outcome, row, at: (finishedAt ?? now).getTime() }];
  }).sort((left, right) => right.at - left.at);
  const failedBeforeStarting = outcomes.filter(entry => entry.outcome === "failed_before_starting").length;
  const streak = outcomes.slice(0, AUTOMATIC_RUN_BRAKE.consecutiveProviderRefusals);
  const lastActivityAt = Math.max(...automatic.map(row => Math.max(toDate(row.created_at)!.getTime(),
    toDate(row.finished_at)?.getTime() ?? 0, row.status === "running" ? now.getTime() : 0)));
  return {
    counted: outcomes.length,
    failedBeforeStarting,
    healthy: outcomes.length - failedBeforeStarting,
    providerRefusalStreak: streak.length === AUTOMATIC_RUN_BRAKE.consecutiveProviderRefusals
      && streak.every(entry => entry.row.error_code === ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE),
    recoveredSince: state === "open" && outcomes.length > 0 && (outcomes[0]!.row.status === "succeeded"
      || (outcomes.length >= AUTOMATIC_RUN_BRAKE.probeSuccessesToRelease
        && outcomes.slice(0, AUTOMATIC_RUN_BRAKE.probeSuccessesToRelease).every(entry => entry.outcome === "healthy"))),
    liveAutomatic,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : null,
  };
}

function trips(evidence: Evidence) {
  return evidence.providerRefusalStreak || (evidence.counted >= AUTOMATIC_RUN_BRAKE.minCounted
    && evidence.failedBeforeStarting / evidence.counted >= AUTOMATIC_RUN_BRAKE.failureShare);
}

type CacheEntry = { snapshot: AutomaticRunBrakeSnapshot; readAt: number; skewMs: number; heldUntil: number };

export function createAutomaticRunBrake() {
  const companies = boundedMap<string, CacheEntry>(AUTOMATIC_RUN_BRAKE.maxCompanies);
  const personOrigin = boundedMap<string, boolean>(AUTOMATIC_RUN_BRAKE.maxRuns);

  async function readRow(db: Db, companyId: string): Promise<BrakeRow | null> {
    const [row] = await db.select().from(automaticRunBrakes).where(eq(automaticRunBrakes.companyId, companyId));
    return row ?? null;
  }

  async function readSignal(db: Db, companyId: string, row: BrakeRow | null) {
    const state = row?.state ?? "closed";
    const changedAt = row?.stateChangedAt ?? null;
    const lower = state === "open"
      ? sql`coalesce(${changedAt?.toISOString() ?? null}::timestamptz, now() - ${`${AUTOMATIC_RUN_BRAKE.windowMs} milliseconds`}::interval)`
      : sql`greatest(now() - ${`${AUTOMATIC_RUN_BRAKE.windowMs} milliseconds`}::interval, ${changedAt?.toISOString() ?? null}::timestamptz)`;
    const rows = [...await db.execute<SignalRow & { lower_at: string | Date }>(sql`
      select now() as db_now, ${lower} as lower_at, r.id, r.status, r.error_code, r.runtime_mode, r.execution_stage,
        r.started_at, r.finished_at, r.created_at, r.last_output_at is not null as has_output,
        r.result_json #>> '{executionRecovery,providerWorkStarted}' as provider_work_started,
        r.retry_of_run_id, r.scheduled_retry_reason,
        jsonb_build_object('wakeReason', r.context_snapshot->'wakeReason', 'previousRunId', r.context_snapshot->'previousRunId',
          'retryReason', r.context_snapshot->'retryReason', 'freshContinuationIsolation', r.context_snapshot->'freshContinuationIsolation',
          'explicitUserContinuation', r.context_snapshot->'explicitUserContinuation',
          'taskRetryRequestId', r.context_snapshot->'taskRetryRequestId') as context
      from heartbeat_runs r
      where r.company_id = ${companyId}
        and r.created_at >= now() - ${`${AUTOMATIC_RUN_BRAKE.lookbackMs} milliseconds`}::interval
        and (r.finished_at >= ${lower} or r.status in ('queued', 'scheduled_retry', 'running')
          or r.created_at >= now() - ${`${AUTOMATIC_RUN_BRAKE.quietCloseMs} milliseconds`}::interval)
      order by r.created_at desc
      limit ${AUTOMATIC_RUN_BRAKE.rowLimit}`)];
    if (rows.length) return { rows, now: toDate(rows[0]!.db_now)!, lower: toDate(rows[0]!.lower_at)!.getTime() };
    const [clock] = [...await db.execute<{ db_now: string | Date }>(sql`select now() as db_now`)];
    return { rows, now: toDate(clock!.db_now)!, lower: 0 };
  }

  async function transition(db: Db, companyId: string, row: BrakeRow | null, to: AutomaticRunBrakeState,
    reason: Record<string, unknown>): Promise<BrakeRow | null> {
    const from = row?.state ?? "closed";
    const values = {
      state: to,
      reason,
      stateChangedAt: sql`date_trunc('milliseconds', now())`,
      openedAt: to === "open" ? (from === "half_open" && row?.openedAt ? row.openedAt : sql`date_trunc('milliseconds', now())`) : to === "closed" ? null : row?.openedAt ?? null,
      nextProbeAt: null,
      probeRunId: null,
      probeSuccesses: 0,
      releaseWindowStartedAt: null,
      releaseWindowStarts: 0,
      nextCreationAt: null,
      updatedAt: sql`now()`,
    };
    const expectedChangedAt = row?.stateChangedAt?.toISOString() ?? null;
    const [updated] = await db.insert(automaticRunBrakes).values({ companyId, ...values })
      .onConflictDoUpdate({
        target: automaticRunBrakes.companyId,
        set: values,
        setWhere: sql`${automaticRunBrakes.state} = ${from}
          and date_trunc('milliseconds', ${automaticRunBrakes.stateChangedAt}) is not distinct from ${expectedChangedAt}::timestamptz`,
      }).returning();
    if (!updated) return readRow(db, companyId);
    const event = to === "open" ? (from === "half_open" ? "reopened" : "opened") : to;
    logger[to === "open" ? "warn" : "info"]({ event: `automatic_run_brake.${event}`, companyId, from, to, ...reason },
      to === "open" ? "Automatic work paused for a company while its runs fail before starting"
        : to === "half_open" ? "Automatic work for a company is resuming gradually" : "Automatic work for a company is running normally again");
    return updated;
  }

  async function settleProbe(db: Db, row: BrakeRow, rows: SignalRow[]): Promise<BrakeRow> {
    if (row.state !== "open" || !row.probeRunId) return row;
    const known = rows.find(candidate => candidate.id === row.probeRunId);
    const [probe] = known ? [known] : [...await db.execute<SignalRow>(sql`
      select r.id, r.status, r.error_code, r.runtime_mode, r.execution_stage, r.started_at, r.finished_at, r.created_at,
        r.last_output_at is not null as has_output, r.result_json #>> '{executionRecovery,providerWorkStarted}' as provider_work_started
      from heartbeat_runs r where r.company_id = ${row.companyId} and r.id = ${row.probeRunId}`)];
    if (probe && (probe.status === "queued" || probe.status === "scheduled_retry")) return row;
    const outcome = probe ? classifyAutomaticRunOutcome({ status: probe.status, errorCode: probe.error_code, runtimeMode: probe.runtime_mode,
      executionStage: probe.execution_stage, startedAt: toDate(probe.started_at), hasOutput: probe.has_output,
      providerWorkStarted: probe.provider_work_started }) : "neutral";
    if (probe?.status === "running" && outcome === "neutral") return row;
    const completed = probe?.status === "succeeded";
    const successes = outcome === "healthy" ? row.probeSuccesses + (completed ? AUTOMATIC_RUN_BRAKE.probeSuccessesToRelease : 1)
      : outcome === "failed_before_starting" ? 0 : row.probeSuccesses;
    const [updated] = await db.update(automaticRunBrakes).set({
      probeRunId: null, probeSuccesses: successes, updatedAt: sql`now()`,
      ...(outcome === "healthy" ? { nextProbeAt: sql`now()` } : {}),
    }).where(sql`${automaticRunBrakes.companyId} = ${row.companyId} and ${automaticRunBrakes.state} = 'open'
      and ${automaticRunBrakes.probeRunId} = ${row.probeRunId}`).returning();
    return updated ?? (await readRow(db, row.companyId)) ?? row;
  }

  async function refresh(db: Db, companyId: string): Promise<CacheEntry> {
    let row = await readRow(db, companyId);
    let signal = await readSignal(db, companyId, row);
    if (row) row = await settleProbe(db, row, signal.rows);
    let state: AutomaticRunBrakeState = row?.state ?? "closed";
    let evidence = evaluate(signal.rows, state, signal.lower, signal.now);
    const numbers = { windowMinutes: AUTOMATIC_RUN_BRAKE.windowMs / 60_000, recentAutomaticRuns: evidence.counted,
      failedBeforeStarting: evidence.failedBeforeStarting, healthy: evidence.healthy };
    const changedAt = row?.stateChangedAt?.getTime() ?? 0;
    const elapsed = signal.now.getTime() - changedAt;
    let target: { to: AutomaticRunBrakeState; reason: Record<string, unknown> } | null = null;
    if (state === "closed" && trips(evidence)) {
      target = { to: "open", reason: { ...numbers, trigger: evidence.providerRefusalStreak ? "sandbox_refusals" : "failed_before_starting" } };
    } else if (state === "half_open" && trips(evidence)) {
      target = { to: "open", reason: { ...numbers, trigger: evidence.providerRefusalStreak ? "sandbox_refusals" : "failed_before_starting" } };
    } else if (state === "half_open" && rampStep(row!.stateChangedAt, signal.now) >= AUTOMATIC_RUN_BRAKE.releaseSteps) {
      target = { to: "closed", reason: { ...numbers, trigger: "released" } };
    } else if (state === "open" && elapsed >= AUTOMATIC_RUN_BRAKE.minOpenMs
      && (evidence.recoveredSince || (row?.probeSuccesses ?? 0) >= AUTOMATIC_RUN_BRAKE.probeSuccessesToRelease)) {
      target = { to: "half_open", reason: { ...numbers, trigger: "runs_starting_again" } };
    } else if (state === "open" && elapsed >= AUTOMATIC_RUN_BRAKE.quietCloseMs && evidence.liveAutomatic === 0
      && (evidence.lastActivityAt ?? 0) < signal.now.getTime() - AUTOMATIC_RUN_BRAKE.quietCloseMs) {
      target = { to: "closed", reason: { ...numbers, trigger: "no_automatic_work" } };
    }
    if (target) {
      row = await transition(db, companyId, row, target.to, target.reason);
      state = row?.state ?? "closed";
      if (state !== "closed") {
        signal = await readSignal(db, companyId, row);
        evidence = evaluate(signal.rows, state, signal.lower, signal.now);
      }
    }
    const snapshot: AutomaticRunBrakeSnapshot = {
      companyId, state, pausedSince: row?.openedAt ?? null, stateChangedAt: row?.stateChangedAt ?? null,
      reason: row?.reason ?? {}, nextProbeAt: row?.nextProbeAt ?? null, nextCreationAt: row?.nextCreationAt ?? null,
      probeRunId: row?.probeRunId ?? null, probeSuccesses: row?.probeSuccesses ?? 0, dbNow: signal.now, evidence,
    };
    const readAt = Date.now();
    const entry = { snapshot, readAt, skewMs: signal.now.getTime() - readAt, heldUntil: companies.get(companyId)?.heldUntil ?? 0 };
    companies.set(companyId, entry);
    return entry;
  }

  async function current(db: Db, companyId: string): Promise<CacheEntry> {
    const entry = companies.get(companyId);
    if (entry && Date.now() - entry.readAt < AUTOMATIC_RUN_BRAKE.cacheTtlMs) return entry;
    return refresh(db, companyId);
  }

  async function read(db: Db, companyId: string): Promise<AutomaticRunBrakeSnapshot> {
    return (await current(db, companyId)).snapshot;
  }

  async function creationHeldUntil(db: Db, companyId: string): Promise<Date | null> {
    const entry = await current(db, companyId);
    if (entry.snapshot.state !== "open") return null;
    const recheck = new Date(Date.now() + AUTOMATIC_RUN_BRAKE.creationIntervalMs);
    if (entry.snapshot.evidence.liveAutomatic > 0) return recheck;
    const [seeded] = await db.update(automaticRunBrakes).set({
      nextCreationAt: sql`now() + ${`${AUTOMATIC_RUN_BRAKE.creationIntervalMs} milliseconds`}::interval`, updatedAt: sql`now()`,
    }).where(sql`${automaticRunBrakes.companyId} = ${companyId} and ${automaticRunBrakes.state} = 'open'
      and (${automaticRunBrakes.nextCreationAt} is null or ${automaticRunBrakes.nextCreationAt} <= now())`)
      .returning({ nextCreationAt: automaticRunBrakes.nextCreationAt });
    if (seeded) {
      entry.snapshot = { ...entry.snapshot, nextCreationAt: seeded.nextCreationAt,
        evidence: { ...entry.snapshot.evidence, liveAutomatic: 1 } };
      return null;
    }
    const row = await readRow(db, companyId);
    if (row?.state !== "open") { companies.delete(companyId); return null; }
    const at = row.nextCreationAt ? row.nextCreationAt.getTime() - entry.skewMs : recheck.getTime();
    return new Date(Math.max(Date.now(), at));
  }

  async function isPersonOrigin(db: Db, run: AutomaticRunFacts) {
    const known = personOrigin.get(run.id);
    if (known !== undefined) return known;
    const origin = (await listPersonOriginSourceRunIds(db, run.companyId, [run.id])).includes(run.id);
    personOrigin.set(run.id, origin);
    return origin;
  }

  async function grantProbe(db: Db, entry: CacheEntry, run: AutomaticRunFacts) {
    const [granted] = await db.update(automaticRunBrakes).set({
      probeRunId: run.id, updatedAt: sql`now()`,
      nextProbeAt: sql`now() + ${`${AUTOMATIC_RUN_BRAKE.probeIntervalMs} milliseconds`}::interval`,
    }).where(sql`${automaticRunBrakes.companyId} = ${run.companyId} and ${automaticRunBrakes.state} = 'open'
      and (${automaticRunBrakes.nextProbeAt} is null or ${automaticRunBrakes.nextProbeAt} <= now())
      and (${automaticRunBrakes.probeRunId} is null or not exists (select 1 from heartbeat_runs p
        where p.company_id = ${automaticRunBrakes.companyId} and p.id = ${automaticRunBrakes.probeRunId} and p.status = 'running'
          and p.started_at > now() - ${`${AUTOMATIC_RUN_BRAKE.probeRunningBoundMs} milliseconds`}::interval))`)
      .returning({ nextProbeAt: automaticRunBrakes.nextProbeAt });
    const now = Date.now();
    if (granted) {
      entry.heldUntil = now + AUTOMATIC_RUN_BRAKE.probeIntervalMs;
      entry.snapshot = { ...entry.snapshot, probeRunId: run.id, nextProbeAt: granted.nextProbeAt };
      return true;
    }
    const nextProbeAt = entry.snapshot.nextProbeAt ? entry.snapshot.nextProbeAt.getTime() - entry.skewMs : 0;
    entry.heldUntil = Math.max(now + AUTOMATIC_RUN_BRAKE.cacheTtlMs, nextProbeAt);
    return false;
  }

  async function grantRelease(db: Db, entry: CacheEntry, companyId: string) {
    const [granted] = [...await db.execute<{ starts: number; window_ends_at: string | Date }>(sql`
      with ramp as (
        select b.company_id, b.state_changed_at + floor(extract(epoch from now() - b.state_changed_at) * 1000
            / ${AUTOMATIC_RUN_BRAKE.releaseIntervalMs}) * ${`${AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval as window_start,
          ${AUTOMATIC_RUN_BRAKE.releaseInitialRate} * power(2, floor(extract(epoch from now() - b.state_changed_at) * 1000
            / ${AUTOMATIC_RUN_BRAKE.releaseIntervalMs}))::int as rate
        from automatic_run_brakes b where b.company_id = ${companyId} and b.state = 'half_open'
      )
      update automatic_run_brakes b set
        release_window_starts = case when b.release_window_started_at = ramp.window_start then b.release_window_starts + 1 else 1 end,
        release_window_started_at = ramp.window_start, updated_at = now()
      from ramp
      where b.company_id = ramp.company_id and b.state = 'half_open'
        and (b.release_window_started_at is distinct from ramp.window_start or b.release_window_starts < ramp.rate)
      returning b.release_window_starts as starts, ramp.window_start + ${`${AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval as window_ends_at`)];
    if (granted) return true;
    const step = rampStep(entry.snapshot.stateChangedAt ?? entry.snapshot.dbNow, new Date(Date.now() + entry.skewMs));
    const windowEnds = (entry.snapshot.stateChangedAt?.getTime() ?? 0) + (step + 1) * AUTOMATIC_RUN_BRAKE.releaseIntervalMs;
    entry.heldUntil = Math.max(Date.now() + 1_000, windowEnds - entry.skewMs);
    return false;
  }

  async function holdAutomaticRunStart(db: Db, run: AutomaticRunFacts, options: { personOrigin?: boolean } = {}): Promise<boolean> {
    if (!isAutomaticRun(run)) return false;
    const cached = companies.get(run.companyId);
    if (cached && cached.snapshot.state === "closed" && Date.now() - cached.readAt < AUTOMATIC_RUN_BRAKE.cacheTtlMs) return false;
    if (options.personOrigin ?? await isPersonOrigin(db, run)) return false;
    if (cached && cached.heldUntil > Date.now()) return true;
    const entry = await current(db, run.companyId);
    if (entry.snapshot.state === "closed") return false;
    if (entry.heldUntil > Date.now()) return true;
    const allowed = entry.snapshot.state === "open" ? await grantProbe(db, entry, run) : await grantRelease(db, entry, run.companyId);
    return !allowed;
  }

  return {
    read,
    refresh: async (db: Db, companyId: string) => (await refresh(db, companyId)).snapshot,
    creationHeldUntil,
    holdAutomaticRunStart,
    cacheSizes: () => ({ companies: companies.size, runs: personOrigin.size }),
    reset: () => { companies.clear(); personOrigin.clear(); },
  };
}

export const automaticRunBrake = createAutomaticRunBrake();

export function automaticRunCreationHeldUntil(db: Db, companyId: string) {
  return automaticRunBrake.creationHeldUntil(db, companyId);
}

export function automaticWorkStatusText(snapshot: AutomaticRunBrakeSnapshot) {
  if (snapshot.state === "closed") return "Automatic work is running normally.";
  const since = (snapshot.pausedSince ?? snapshot.stateChangedAt)?.toISOString() ?? "recently";
  if (snapshot.state === "half_open") return `Automatic work is resuming gradually since ${snapshot.stateChangedAt?.toISOString() ?? since} because recent runs started normally again.`;
  const reason = snapshot.reason as { trigger?: string; recentAutomaticRuns?: number; failedBeforeStarting?: number };
  const because = reason.trigger === "sandbox_refusals"
    ? `the last ${AUTOMATIC_RUN_BRAKE.consecutiveProviderRefusals} automatic runs could not get a sandbox`
    : `${reason.failedBeforeStarting ?? 0} of ${reason.recentAutomaticRuns ?? 0} recent automatic runs failed before starting`;
  const next = snapshot.nextProbeAt ?? snapshot.nextCreationAt;
  return `Automatic work is paused for this company since ${since} because ${because}${next ? `; next try at ${next.toISOString()}` : ""}.`;
}

export async function readAutomaticWorkStatus(db: Db, companyId: string) {
  const snapshot = await automaticRunBrake.read(db, companyId);
  return {
    state: snapshot.state,
    pausedSince: snapshot.pausedSince,
    nextTryAt: snapshot.state === "open" ? snapshot.nextProbeAt ?? snapshot.nextCreationAt : null,
    recentAutomaticRuns: snapshot.evidence.counted,
    failedBeforeStarting: snapshot.evidence.failedBeforeStarting,
    summary: automaticWorkStatusText(snapshot),
  };
}
