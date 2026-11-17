import { dedicatedDbConnectionStats, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { readDatabaseSessionReport } from "./database-session-waits.js";

export const RUN_INTAKE_STALL_MS = 30_000;
export const RUN_INTAKE_REPORT_TIMEOUT_MS = 10_000;
const REPORTED_OPERATIONS_MAX = 20;
const REPORTED_RUNS_MAX = 20;

export type RunIntakeStage = "received" | "write" | "process_identity";

type Operation = { runId: string; stage: RunIntakeStage; label: string; startedAtMs: number; stalled: boolean; listed: boolean };

type Watch = {
  db: Db;
  stallMs: number;
  reportTimeoutMs: number;
  now: () => number;
  operations: Map<number, Operation>;
  nextToken: number;
  timer: ReturnType<typeof setTimeout> | null;
  dueAtMs: number;
  lastReportAtMs: number | null;
  report: Promise<void> | null;
};

let watch: Watch | null = null;

const settled = () => undefined;

export function installRunIntakeStallWatch(db: Db,
  options: { stallMs?: number; reportTimeoutMs?: number; now?: () => number } = {}): void {
  if (watch?.timer) clearTimeout(watch.timer);
  watch = { db, stallMs: options.stallMs ?? RUN_INTAKE_STALL_MS, reportTimeoutMs: options.reportTimeoutMs ?? RUN_INTAKE_REPORT_TIMEOUT_MS,
    now: options.now ?? Date.now, operations: new Map(),
    nextToken: 0, timer: null, dueAtMs: 0, lastReportAtMs: null, report: null };
}

export function stopRunIntakeStallWatch(): void {
  const current = watch;
  watch = null;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = null;
}

export function beginRunIntake(runId: string, stage: RunIntakeStage, label: string): () => void {
  const current = watch;
  if (!current) return settled;
  const token = current.nextToken++;
  const operation: Operation = { runId, stage, label, startedAtMs: current.now(), stalled: false, listed: false };
  current.operations.set(token, operation);
  if (!current.timer && !current.report) arm(current, operation.startedAtMs + current.stallMs);
  return () => {
    if (!current.operations.delete(token) || !operation.listed) return;
    logger.info({ runId, stage, label, pendingMs: current.now() - operation.startedAtMs },
      "runner event intake stall cleared");
  };
}

export async function trackRunIntake<T>(runId: string, stage: RunIntakeStage, label: string, work: () => Promise<T>): Promise<T> {
  const done = beginRunIntake(runId, stage, label);
  try { return await work(); }
  finally { done(); }
}

function arm(current: Watch, dueAtMs: number) {
  const now = current.now();
  current.dueAtMs = Math.max(dueAtMs, now);
  current.timer = setTimeout(() => check(current), current.dueAtMs - now);
  current.timer.unref?.();
}

function nextDueAtMs(current: Watch): number | null {
  for (const operation of current.operations.values()) {
    if (!operation.stalled) return operation.startedAtMs + current.stallMs;
  }
  return null;
}

function check(current: Watch) {
  current.timer = null;
  if (watch !== current) return;
  const now = current.now();
  const eventLoopLagMs = Math.max(0, now - current.dueAtMs);
  if (current.lastReportAtMs !== null && now - current.lastReportAtMs < current.stallMs) {
    arm(current, current.lastReportAtMs + current.stallMs);
    return;
  }
  const stalledRuns = new Set<string>();
  for (const operation of current.operations.values()) if (operation.stalled) stalledRuns.add(operation.runId);
  const newlyStalled: Operation[] = [];
  for (const operation of current.operations.values()) {
    if (operation.stalled) continue;
    if (now - operation.startedAtMs < current.stallMs) break;
    if (stalledRuns.has(operation.runId)) { operation.stalled = true; continue; }
    if (newlyStalled.length >= REPORTED_OPERATIONS_MAX) break;
    operation.stalled = true;
    stalledRuns.add(operation.runId);
    newlyStalled.push(operation);
  }
  if (newlyStalled.length === 0) {
    const due = nextDueAtMs(current);
    if (due !== null) arm(current, due);
    return;
  }
  current.lastReportAtMs = now;
  const report: Promise<void> = reportStall(current, newlyStalled, eventLoopLagMs)
    .catch(error => logger.warn({ err: error }, "runner event intake stall report failed"))
    .finally(() => {
      if (current.report === report) current.report = null;
      if (watch !== current || current.timer) return;
      const due = nextDueAtMs(current);
      if (due !== null) arm(current, due);
    });
  current.report = report;
}

function pendingByRun(current: Watch, now: number) {
  const runs = new Map<string, { runId: string; pending: number; oldestPendingMs: number; oldestLabel: string;
    stages: Partial<Record<RunIntakeStage, number>> }>();
  for (const operation of current.operations.values()) {
    let run = runs.get(operation.runId);
    if (!run) {
      run = { runId: operation.runId, pending: 0, oldestPendingMs: now - operation.startedAtMs, oldestLabel: operation.label, stages: {} };
      runs.set(operation.runId, run);
    }
    run.pending += 1;
    run.stages[operation.stage] = (run.stages[operation.stage] ?? 0) + 1;
  }
  return [...runs.values()].sort((left, right) => right.oldestPendingMs - left.oldestPendingMs).slice(0, REPORTED_RUNS_MAX);
}

async function reportStall(current: Watch, stalled: Operation[], eventLoopLagMs: number) {
  const now = current.now();
  for (const operation of stalled) operation.listed = true;
  const operations = stalled.map(operation => ({ runId: operation.runId, stage: operation.stage, label: operation.label,
    pendingMs: now - operation.startedAtMs }));
  const client = current.db.$client as { options?: { max?: unknown } } | undefined;
  const pool = { maxConnections: typeof client?.options?.max === "number" ? client.options.max : null,
    pendingIntake: current.operations.size, dedicated: dedicatedDbConnectionStats(current.db) };
  const runs = pendingByRun(current, now);
  let expire: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = setTimeout(() => reject(new Error(`database session read timed out after ${current.reportTimeoutMs} ms`)),
      current.reportTimeoutMs);
    expire.unref?.();
  });
  const database = await Promise.race([readDatabaseSessionReport(current.db), expired]).then(
    report => ({ ...report, error: null as string | null }),
    error => ({ sessions: [], waits: [], error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }),
  ).finally(() => clearTimeout(expire));
  logger.warn({ stallThresholdMs: current.stallMs, eventLoopLagMs, operations, runs, pool, sessions: database.sessions,
    waits: database.waits, ...(database.error ? { databaseReadError: database.error } : {}) },
  "runner event intake stalled; pending run writes, database sessions and lock waits");
}
