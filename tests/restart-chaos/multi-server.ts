/**
 * MS1–MS3: two control planes on one database (README "Two servers, one database").
 *
 * Hosted Cloud deploys by rolling overlap: a new server B starts on the same database while the old
 * server A still serves, then A drains (doc/plans/2026-10-31-zero-downtime-web-deploys.md: 5 s overlap,
 * up to 90 s drain). B's startup recovery and periodic sweeps therefore run beside A's live runs. A wave
 * otherwise runs one server, so it cannot reach a cross-server race such as #20508 (B's orphan sweep
 * failing a run whose owner had taken its lease back).
 *
 *   MS1  B boots and stays up beside a live A for the hold, then stops (SIGTERM). A is not touched.
 *   MS2  B boots; A and its process tree are frozen (SIGSTOP) past the 90 s controller lease, then
 *        thawed. B stays up for a short tail so it sees A take its leases back, then stops.
 *   MS3  Rolling-upgrade shape: B boots, then A gets K2 (SIGTERM, restart on its own port). B is the
 *        only live server between A's stop and its replacement's readiness, then stops after a tail.
 *
 * B shares A's database, instance directory, local storage and secrets, and listens on its own
 * loopback port. The harness and agents keep talking to A's port. B runs on the same host and PID
 * namespace as A, so it can check A's PIDs directly; a Railway replica cannot. That makes these
 * faults a lower bound on cross-server exposure, not a model of separate hosts.
 *
 * The cross-server invariant (`checkCrossServer`) is graded once per wave over the database:
 *   MS_foreign_failure   a run failed with an ownership code while its owning server was alive and running
 *   MS_double_executor   a run recorded a second local runner identity before the first was shown stopped
 */
import type { Db } from "../../packages/db/src/index.js";
import type { TimeFaultRecord } from "./time-faults.js";

export const MULTI_SERVER_FAULT_KINDS = ["MS1", "MS2", "MS3"] as const;
export type MultiServerKind = (typeof MULTI_SERVER_FAULT_KINDS)[number];

export function isMultiServerFault(kind: string): kind is MultiServerKind {
  return (MULTI_SERVER_FAULT_KINDS as readonly string[]).includes(kind);
}

/** `CONTROLLER_LEASE_TTL_MS` in server/src/services/controller-instance-lease.ts. */
export const CONTROLLER_LEASE_TTL_MS = 90_000;

/**
 * Seeded hold per kind. MS1: B's overlap, long enough for its boot recovery and a periodic sweep.
 * MS2: A's freeze, past the controller lease. MS3: B's tail after A's replacement is ready.
 */
export const MULTI_SERVER_HOLD_RANGE_MS: Record<MultiServerKind, readonly [number, number]> = {
  MS1: [60_000, 150_000],
  MS2: [CONTROLLER_LEASE_TTL_MS + 10_000, 150_000],
  MS3: [20_000, 45_000],
};

/** MS2: B stays up this long after A is thawed, the window in which #20508's foreign write landed. */
export const MS2_THAW_TAIL_MS = 30_000;

export function multiServerHoldMs(kind: MultiServerKind, int: (min: number, max: number) => number): number {
  return int(...MULTI_SERVER_HOLD_RANGE_MS[kind]);
}

/** `--faults MS*` validation; the planner itself is the ordinary per-task planner. */
export function validateMultiServerOptions(options: { env: string; faults: readonly string[]; stormMinutes?: number;
  crashPoint?: string; providerFaults?: readonly string[] }): void {
  const kinds = options.faults.filter(isMultiServerFault);
  if (!kinds.length) return;
  // B shares A's instance directory and local runners; a remote runner is not under either server.
  if (options.env !== "local") throw new Error("Two-server faults (MS*) start a second local server; run them with --env local");
  if (options.stormMinutes) throw new Error("Two-server faults (MS*) are planned per task; do not combine them with --storm-minutes");
  if (options.crashPoint) throw new Error("Two-server faults (MS*) do not combine with --crash-point");
  if (options.faults.includes("K14")) throw new Error("Two-server faults (MS*) do not combine with K14; both servers run the current build");
  // Aging moves database times; the cross-server invariant compares them with real process windows.
  if (options.faults.some(kind => kind === "TM2" || kind === "TM3")) throw new Error("Two-server faults (MS*) do not combine with TM2 or TM3; age the database in its own wave");
}

/** One server process the wave started, for attributing a run's owner at a moment in time. */
export interface ServerProcessWindow {
  pid: number;
  role: "primary" | "secondary";
  spawnedAt: number;
  exitedAt: number | null;
  /** SIGSTOP windows; an open end means still frozen. */
  frozen: Array<{ from: number; to: number | null }>;
}

export interface MultiServerRecord {
  kind: MultiServerKind;
  secondary: { pid: number | null; port: number; spawnedAt: number | null; readyAt: number | null; stoppedAt: number | null } | null;
  /** MS2: A's freeze (tree SIGSTOP, no aging). */
  primaryFreeze?: TimeFaultRecord;
  /** MS3: A's K2 and its replacement. */
  primaryRestart?: { stoppedAt: number | null; restartedAt: number | null; readyAt: number | null; replacementPid: number | null };
  steps: Array<{ step: string; at: number }>;
}

export interface MultiServerHooks {
  now(): number;
  sleep(ms: number): Promise<void>;
  cancelled(): boolean;
  /** Why B stopped on its own (its exit code or signal), or null while it runs as planned. */
  secondaryFailure(): string | null;
  /** Spawns B on its own port and waits until it reports ready. */
  startSecondary(record: MultiServerRecord): Promise<void>;
  /** SIGTERM B and wait for it to exit; always called once B was spawned. */
  stopSecondary(record: MultiServerRecord): Promise<void>;
  /** MS2: freeze A's tree for `holdMs`, thaw it, and replace A if it exited after the thaw. */
  freezePrimary(holdMs: number, record: MultiServerRecord): Promise<void>;
  /** MS3: K2 on A, start its replacement on A's port, and wait until it is ready. */
  restartPrimary(record: MultiServerRecord): Promise<void>;
}

async function hold(hooks: MultiServerHooks, ms: number): Promise<void> {
  const until = hooks.now() + ms;
  while (hooks.now() < until) {
    if (hooks.cancelled()) throw new Error("Harness shutdown interrupted the two-server fault");
    const exited = hooks.secondaryFailure();
    if (exited) throw new Error(`The second server exited before its planned stop: ${exited}`);
    await hooks.sleep(Math.min(1_000, until - hooks.now()));
  }
}

/** Runs one MS fault. B is stopped on every path once it was started, so it never outlives its fault. */
export async function runMultiServerFault(kind: MultiServerKind, holdMs: number, record: MultiServerRecord, hooks: MultiServerHooks): Promise<void> {
  const step = (name: string) => record.steps.push({ step: name, at: hooks.now() });
  let started = false;
  let failure: unknown = null;
  try {
    started = true;
    step("secondary_starting");
    await hooks.startSecondary(record);
    step("secondary_ready");
    if (kind === "MS1") {
      await hold(hooks, holdMs);
    } else if (kind === "MS2") {
      step("primary_freezing");
      await hooks.freezePrimary(holdMs, record);
      step("primary_thawed");
      await hold(hooks, MS2_THAW_TAIL_MS);
    } else {
      step("primary_restarting");
      await hooks.restartPrimary(record);
      step("primary_ready");
      await hold(hooks, holdMs);
    }
    // B must have lived through the whole window, including a freeze or restart without a hold check.
    const exited = hooks.secondaryFailure();
    if (exited) throw new Error(`The second server exited before its planned stop: ${exited}`);
  } catch (error) {
    failure = error;
  }
  if (started) {
    step("secondary_stopping");
    try { await hooks.stopSecondary(record); step("secondary_stopped"); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

// ---------- cross-server invariant ----------

/** A sweep's verdict on another server's run. */
export const FOREIGN_FAILURE_CODES: ReadonlySet<string> = new Set(["process_lost", "native_execution_ownership_unverified"]);
/**
 * The owner's own lease loss: expected after a freeze past the lease, a violation otherwise. Only the legacy
 * 60 s run lease persists a run code; a native session lease loss is recorded as `native_session_interrupted`.
 */
export const LEASE_LOSS_CODES: ReadonlySet<string> = new Set(["controller_lease_lost"]);

export interface CrossServerRun {
  runId: string;
  issueId: string | null;
  status: string;
  errorCode: string | null;
  /**
   * When the run reached its final status (finished_at), else when it was last written (updated_at), ms.
   * #20508's marker leaves the run `running` with the ownership code, so its write time is updated_at.
   */
  endedAt: number | null;
  ownerBootId: string | null;
  ownerPid: number | null;
}

export interface RunIdentityEvent { runId: string; kind: "recorded" | "stopped"; pid: number; at: number }

export interface CrossServerViolation {
  rule: "MS_foreign_failure" | "MS_double_executor";
  runId: string;
  issueId: string | null;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface CrossServerCheck {
  violations: CrossServerViolation[];
  /** Ownership failures the harness could not attribute (owner boot or pid unknown, or not a wave server). */
  unattributed: Array<{ runId: string; errorCode: string | null; ownerBootId: string | null; ownerPid: number | null }>;
  windows: ServerProcessWindow[];
}

const aliveAt = (window: ServerProcessWindow, at: number) => window.spawnedAt <= at && (window.exitedAt === null || at < window.exitedAt);
const frozenAt = (window: ServerProcessWindow, at: number) => window.frozen.some(span => span.from <= at && (span.to === null || at < span.to));
const frozenPastLeaseBefore = (window: ServerProcessWindow, at: number, leaseTtlMs: number) =>
  window.frozen.some(span => span.from < at && ((span.to ?? at) - span.from) >= leaseTtlMs);

/**
 * Pure: grade the wave's runs against the server process windows the harness recorded.
 * A failure is charged only when the owner is a wave server, alive and running (not frozen) at that moment.
 */
export function checkCrossServer(input: { runs: readonly CrossServerRun[]; events: readonly RunIdentityEvent[];
  windows: readonly ServerProcessWindow[]; leaseTtlMs?: number }): CrossServerCheck {
  const leaseTtlMs = input.leaseTtlMs ?? CONTROLLER_LEASE_TTL_MS;
  const violations: CrossServerViolation[] = [];
  const unattributed: CrossServerCheck["unattributed"] = [];
  const issueOf = new Map(input.runs.map(run => [run.runId, run.issueId]));
  for (const run of input.runs) {
    const code = run.errorCode ?? "";
    const foreign = FOREIGN_FAILURE_CODES.has(code);
    const leaseLoss = LEASE_LOSS_CODES.has(code);
    if (!foreign && !leaseLoss) continue;
    // Several boots can reuse a pid only after the first exited: pick the window alive at the end time.
    const at = run.endedAt;
    const owner = at === null || run.ownerPid === null ? undefined
      : input.windows.find(window => window.pid === run.ownerPid && aliveAt(window, at));
    if (!owner || at === null) {
      unattributed.push({ runId: run.runId, errorCode: run.errorCode, ownerBootId: run.ownerBootId, ownerPid: run.ownerPid });
      continue;
    }
    if (frozenAt(owner, at)) continue;
    // After a freeze past the lease the owner may lose its own lease; a sweep's write on a thawed owner is still foreign.
    if (leaseLoss && frozenPastLeaseBefore(owner, at, leaseTtlMs)) continue;
    violations.push({ rule: "MS_foreign_failure", runId: run.runId, issueId: run.issueId,
      detail: `${code} at ${new Date(at).toISOString()} while owner pid ${owner.pid} (${owner.role}) was alive and running`,
      evidence: { errorCode: code, endedAt: at, ownerBootId: run.ownerBootId, ownerPid: owner.pid, ownerRole: owner.role,
        ownerFrozen: owner.frozen } });
  }
  const byRun = new Map<string, RunIdentityEvent[]>();
  for (const event of input.events) {
    const list = byRun.get(event.runId) ?? [];
    list.push(event);
    byRun.set(event.runId, list);
  }
  for (const [runId, events] of byRun) {
    const live = new Set<number>();
    for (const event of [...events].sort((left, right) => left.at - right.at || (left.kind === "stopped" ? -1 : 1))) {
      if (event.kind === "stopped") { live.delete(event.pid); continue; }
      const other = [...live].find(pid => pid !== event.pid);
      if (other !== undefined) {
        violations.push({ rule: "MS_double_executor", runId, issueId: issueOf.get(runId) ?? null,
          detail: `runner pid ${event.pid} recorded at ${new Date(event.at).toISOString()} while pid ${other} was never shown stopped`,
          evidence: { firstPid: other, secondPid: event.pid, at: event.at } });
        live.delete(other);
      }
      live.add(event.pid);
    }
  }
  return { violations, unattributed, windows: [...input.windows] };
}

type Row = Record<string, unknown>;
const num = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);

/** Reads the runs and runner identity events `checkCrossServer` needs from the wave database. */
export async function readCrossServerEvidence(db: Db, companyId: string): Promise<{ runs: CrossServerRun[]; events: RunIdentityEvent[] }> {
  const client = db.$client;
  const runs = await client.unsafe(
    `select r.id::text as "runId", r.issue_id::text as "issueId", r.status, r.error_code as "errorCode",
            floor(extract(epoch from coalesce(r.finished_at, r.updated_at)) * 1000) as "endedAt",
            coalesce(r.controller_boot_id::text, f.controller_boot_id, f.lease_holder->>'bootId') as "ownerBootId",
            ci.pid as "ownerPid"
       from heartbeat_runs r
       left join native_run_finalizations f on f.run_id = r.id
       left join controller_instances ci on ci.boot_id = coalesce(r.controller_boot_id::text, f.controller_boot_id, f.lease_holder->>'bootId')
      where r.company_id::text = $1
        and (r.status in ('failed', 'timed_out', 'cancelled') or r.error_code in ('process_lost', 'native_execution_ownership_unverified'))`,
    [companyId]) as Row[];
  const events = await client.unsafe(
    `select e.run_id::text as "runId", e.event_type as "eventType", e.payload->>'processPid' as pid,
            floor(extract(epoch from e.created_at) * 1000) as at
       from heartbeat_run_events e join heartbeat_runs r on r.id = e.run_id
      where r.company_id::text = $1 and e.event_type in ('native.process_identity_recorded', 'native.local_process_stopped')`, [companyId]) as Row[];
  return {
    runs: runs.map(row => ({ runId: String(row.runId), issueId: row.issueId === null ? null : String(row.issueId), status: String(row.status),
      errorCode: row.errorCode === null ? null : String(row.errorCode), endedAt: num(row.endedAt),
      ownerBootId: row.ownerBootId === null ? null : String(row.ownerBootId), ownerPid: num(row.ownerPid) })),
    events: events.flatMap(row => {
      const pid = num(row.pid);
      const at = num(row.at);
      if (pid === null || at === null || !Number.isSafeInteger(pid)) return [];
      return [{ runId: String(row.runId), kind: row.eventType === "native.local_process_stopped" ? "stopped" as const : "recorded" as const, pid, at }];
    }),
  };
}
