/**
 * Database contention: L1 (high-output, high-accounting) and the harness-side
 * run-row pressure knob (`--db-pressure <writers>`).
 *
 * Usage receipts and streamed run-log appends update the same `heartbeat_runs`
 * row. Before #20385 a receipt's repeatable-read snapshot went stale when a
 * run-log append committed between its company check and its run-row lock;
 * four retries ran out with SQLSTATE 40001, the event stayed in the runner's
 * retained outbox, and every later terminal event was blocked behind it
 * (`native_event_replay_conflict: runner_event_commit_stalled ... last cause: Error`).
 *
 * L1 makes each task stream several hundred kilobytes of tool output across
 * several tool calls, so a run emits many log events and many usage reports.
 * `--db-pressure` adds harness-owned writers that touch the wave's running run
 * rows back to back, the way a fast stream does against a hosted database
 * whose round trip widens the race window. The writers change no value
 * (`updated_at = updated_at`) and only touch the wave's own isolated database.
 */
import { setTimeout as delay } from "node:timers/promises";
import { createDb, type Db } from "../../packages/db/src/index.js";
import type { OracleArtifacts, OracleResult } from "./types.js";
import type { WorkloadDefinition } from "./workloads.js";

export const L1_CHUNKS = 5;
export const L1_LINES = 3_000;
/** Proof that the task actually streamed and accounted: minimum log events and usage receipts across its runs. */
export const L1_MIN_LOG_EVENTS = 40;
export const L1_MIN_RECEIPTS = 6;

const chunkEnd = (nonce: string, chunk: number) => `L1-${nonce}-c${chunk}-END`;
const doneMarker = (nonce: string) => `L1-${nonce}-DONE`;
const chunkCommand = (nonce: string, chunk: number) =>
  `seq -f "L1-${nonce}-c${chunk} row %05g ${"x".repeat(72)}" 1 ${L1_LINES}; echo "${chunkEnd(nonce, chunk)}"`;

const TERMINAL_EVENTS = ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"];
const COMMIT_STALL = /runner_event_commit_stalled|native_event_replay_conflict/;

export interface ContentionRun {
  id: string; status: string; errorCode: string | null; error: string | null;
  logEvents: number; logBytes: number | null;
  receipts: number;
  /** Producer events journaled more than once for the same receipt source (must be none). */
  duplicateReceipts: string[];
  terminalReceipt: boolean;
  nativeProducer: boolean;
  costAccounted: boolean;
  /** Cost the run's accounting recorded (usage_json), and what its cost events add up to, in cents. */
  recordedCostCents: number | null;
  costEventCents: number;
}

export interface ContentionEvidence {
  runs: ContentionRun[];
  /** Sum of the wave company's cost events in cents, and the board's all-time cost summary. */
  companyCostEventCents: number;
  summary: CostSummary | null;
  error: string | null;
}

/** The fields of `GET /api/companies/:id/costs/summary?period=all` the oracle compares. */
export interface CostSummary { spendCents: number; pendingRunCount: number }

const num = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));

/** Accounting and run-log evidence for one task's runs (the ids the observer saw), read from the wave database at rest. */
export async function collectContentionEvidence(db: Db, companyId: string, runIds: readonly string[], summary: CostSummary | null): Promise<ContentionEvidence> {
  try {
    const rows = await db.$client.unsafe(`
      select r.id::text as id, r.status, r.error_code as "errorCode", left(r.error, 400) as error, r.log_bytes as "logBytes",
             r.cost_accounted_at is not null as "costAccounted",
             coalesce(r.usage_json->>'accountingReceiptOwner', '') = 'native_producer' as "nativeProducer",
             coalesce(r.usage_json->>'cacheAdjustedCostUsd', r.usage_json->>'costUsdExact', r.usage_json->>'costUsd') as "recordedCostUsd",
             (select count(*) from heartbeat_run_events e where e.run_id = r.id)::int as "logEvents",
             (select count(*) from run_usage_receipts u where u.run_id = r.id)::int as receipts,
             (select coalesce(array_agg(dup.k), '{}') from (
                select u.source_id::text || ':' || (u.receipt_json->'producerEvent'->>'sourceEventId') as k
                  from run_usage_receipts u where u.run_id = r.id and u.receipt_json->'producerEvent' ? 'sourceEventId'
                 group by 1 having count(*) > 1) dup) as "duplicateReceipts",
             exists (select 1 from run_usage_receipts u where u.run_id = r.id
                      and u.receipt_json->'producerEvent'->>'eventType' = any($3::text[])) as "terminalReceipt",
             (select coalesce(sum(c.cost_cents), 0) from cost_events c where c.heartbeat_run_id = r.id)::float8 as "costEventCents"
        from heartbeat_runs r
       where r.company_id::text = $1 and r.id::text = any($2::text[])
       order by r.created_at`, [companyId, [...runIds], TERMINAL_EVENTS]) as Array<Record<string, unknown>>;
    const [company] = await db.$client.unsafe(
      "select coalesce(sum(cost_cents), 0)::float8 as cents from cost_events where company_id::text = $1", [companyId]) as Array<{ cents: number }>;
    return {
      runs: rows.map(row => ({
        id: String(row.id), status: String(row.status), errorCode: (row.errorCode as string | null) ?? null, error: (row.error as string | null) ?? null,
        logEvents: Number(row.logEvents), logBytes: num(row.logBytes), receipts: Number(row.receipts),
        duplicateReceipts: (row.duplicateReceipts as string[] | null) ?? [], terminalReceipt: row.terminalReceipt === true,
        nativeProducer: row.nativeProducer === true, costAccounted: row.costAccounted === true,
        recordedCostCents: row.recordedCostUsd === null || row.recordedCostUsd === undefined ? null : Number(row.recordedCostUsd) * 100,
        costEventCents: Number(row.costEventCents),
      })),
      companyCostEventCents: Number(company?.cents ?? 0), summary, error: null,
    };
  } catch (error) {
    return { runs: [], companyCostEventCents: 0, summary, error: error instanceof Error ? error.message : String(error) };
  }
}

const FINISHED = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);
const centsMatch = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);

/** The accounting oracle shared by L1 and any wave with contention evidence. */
export function contentionChecks(evidence: ContentionEvidence | undefined): OracleResult["checks"] {
  if (!evidence) return [{ name: "contention_evidence_collected", ok: false, detail: "no database evidence" }];
  if (evidence.error) return [{ name: "contention_evidence_collected", ok: false, detail: evidence.error }];
  const runs = evidence.runs;
  const stalled = runs.filter(run => COMMIT_STALL.test(`${run.errorCode ?? ""} ${run.error ?? ""}`));
  const duplicates = runs.filter(run => run.duplicateReceipts.length);
  const native = runs.filter(run => run.nativeProducer);
  // A succeeded run proves its terminal event was delivered; its receipt must be journaled.
  const missingTerminal = native.filter(run => run.status === "succeeded" && !run.terminalReceipt);
  const unaccounted = native.filter(run => FINISHED.has(run.status) && !run.costAccounted);
  const mismatched = runs.filter(run => run.costAccounted && run.recordedCostCents !== null && !centsMatch(run.costEventCents, run.recordedCostCents));
  const logEvents = runs.reduce((sum, run) => sum + run.logEvents, 0);
  const receipts = runs.reduce((sum, run) => sum + run.receipts, 0);
  const list = (items: ContentionRun[], show: (run: ContentionRun) => string) => items.map(show).join("; ") || "none";
  return [
    { name: "no_event_commit_stall", ok: !stalled.length,
      detail: list(stalled, run => `${run.id} ${run.errorCode}: ${(run.error ?? "").slice(0, 200)}`) },
    { name: "usage_receipts_committed_once", ok: !duplicates.length, detail: list(duplicates, run => `${run.id}: ${run.duplicateReceipts.join(",")}`) },
    { name: "terminal_receipts_committed", ok: !missingTerminal.length, detail: list(missingTerminal, run => run.id) },
    { name: "finished_runs_accounted", ok: !unaccounted.length, detail: list(unaccounted, run => `${run.id}(${run.status})`) },
    { name: "run_spend_matches_cost_events", ok: !mismatched.length,
      detail: list(mismatched, run => `${run.id} recorded=${run.recordedCostCents} events=${run.costEventCents}`) },
    // The board's spend is the cost-event sum; at rest no finished run may still wait for accounting.
    { name: "company_spend_settled",
      ok: evidence.summary !== null && centsMatch(evidence.summary.spendCents, evidence.companyCostEventCents) && evidence.summary.pendingRunCount === 0,
      detail: evidence.summary ? `summary=${evidence.summary.spendCents} events=${evidence.companyCostEventCents} pending_runs=${evidence.summary.pendingRunCount}` : "summary unread" },
    // Not a product property: proof that this task produced the contention it is meant to test.
    { name: "contention_produced", ok: logEvents >= L1_MIN_LOG_EVENTS && receipts >= L1_MIN_RECEIPTS,
      detail: `log_events=${logEvents} receipts=${receipts} log_bytes=${runs.reduce((sum, run) => sum + (run.logBytes ?? 0), 0)}` },
  ];
}

export const l1Workload: WorkloadDefinition = {
  id: "L1",
  label: "High-output, high-accounting run (database contention)",
  usesRepository: false,
  fireWindowMs: [30_000, 120_000],
  budgetMs: 15 * 60_000,
  title: nonce => `Chaos L1 loud run ${nonce}`,
  description: nonce => [
    `Run each of these ${L1_CHUNKS} shell commands, one at a time, as ${L1_CHUNKS} separate tool calls, in order.`,
    "Let each print its full output to the terminal: do not pipe, redirect, truncate or combine them.",
    ...Array.from({ length: L1_CHUNKS }, (_, index) => `${index + 1}. \`${chunkCommand(nonce, index + 1)}\``),
    "Each command ends with one line of the form `L1-...-END`.",
    "Then save this issue's document with key `brief` (title \"Brief\"), in markdown, containing each of those END lines exactly,",
    `each on its own line, and the line \`${doneMarker(nonce)}\` on its own line. Do not create files or other tasks.`,
    "When the document is saved, mark this task done.",
  ].join("\n"),
  collect: { documents: ["brief"], files: () => [], commands: [] },
  grade(nonce: string, artifacts: OracleArtifacts): OracleResult {
    const brief = artifacts.documents.brief ?? "";
    const lines = new Set(brief.split(/\r?\n/).map(line => line.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, "")));
    const missing = Array.from({ length: L1_CHUNKS }, (_, index) => chunkEnd(nonce, index + 1)).filter(marker => !lines.has(marker));
    const checks = [
      { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
      { name: "brief_has_every_chunk_end", ok: !missing.length, detail: missing.length ? `missing ${missing.join(",")}` : `${L1_CHUNKS} chunks` },
      { name: "brief_has_done_marker", ok: lines.has(doneMarker(nonce)) },
      ...contentionChecks(artifacts.contention),
    ];
    return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
  },
};

export interface PressureStats { writers: number; updates: number; rowsTouched: number; errors: number; lastError: string | null; startedAt: number; stoppedAt: number | null }

/**
 * Harness-owned writers that touch the wave company's running run rows back
 * to back. Each statement keeps every value (`updated_at = updated_at`) but
 * still writes a new row version, which is exactly what invalidates a
 * repeatable-read snapshot that later locks the row.
 *
 * Each statement updates one row, like a run-log append. A statement over
 * every running row locked several rows at once and deadlocked with product
 * transactions (40P01 in the first live L1 wave), which the stream never does.
 */
export class RunRowPressure {
  readonly stats: PressureStats;
  #stopped = false;
  #workers: Promise<void>[] = [];
  #db: Db;

  constructor(connectionString: string, private readonly companyId: string, writers: number) {
    this.#db = createDb(connectionString);
    this.stats = { writers, updates: 0, rowsTouched: 0, errors: 0, lastError: null, startedAt: Date.now(), stoppedAt: null };
  }

  start() {
    for (let index = 0; index < this.stats.writers; index += 1) this.#workers.push(this.#loop());
    return this;
  }

  async #loop() {
    while (!this.#stopped) {
      try {
        const running = await this.#db.$client.unsafe(
          "select id::text as id from heartbeat_runs where company_id::text = $1 and status = 'running'", [this.companyId]) as Array<{ id: string }>;
        // Nothing running: idle briefly instead of spinning on an empty read.
        if (!running.length) { await delay(50); continue; }
        for (const { id } of running) {
          if (this.#stopped) break;
          const rows = await this.#db.$client.unsafe(
            "update heartbeat_runs set updated_at = updated_at where id::text = $1 and status = 'running' returning id", [id]);
          this.stats.updates += 1;
          this.stats.rowsTouched += rows.length;
        }
      } catch (error) {
        // The server (and its database) restart during faults; keep going once it is back.
        this.stats.errors += 1;
        this.stats.lastError = error instanceof Error ? error.message.slice(0, 200) : String(error);
        await delay(500);
      }
    }
  }

  async stop(): Promise<PressureStats> {
    this.#stopped = true;
    await Promise.all(this.#workers);
    this.stats.stoppedAt = Date.now();
    await this.#db.$client.end({ timeout: 5 }).catch(() => undefined);
    return this.stats;
  }
}
