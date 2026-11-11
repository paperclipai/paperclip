/**
 * DF1: the sandbox disk is full when the run's result is saved (staging census class F,
 * doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md).
 *
 * A genuinely full disk cannot be made on demand, so the server carries a test-only hook
 * (server/src/services/sandbox-disk-full-fault.ts). The harness starts its server with
 * PAPERCLIP_DISK_FULL_FAULT_CONTROL pointing at a file it owns. While a task's issue id is in
 * that file, each final workspace save of that task gets the answer a full sandbox gives: the
 * capture command exits 1 with the product's disk-full message, and the provider download fails
 * with "No space left on device". Everything after that is the product's own handling.
 *
 * The harness arms the task when it launches and clears it when the task first rests offering a
 * Retry, just before the observer clicks Retry, as a person who freed space would. Grading:
 * - the fault applied (the server wrote a receipt for the task);
 * - the task rested with recovery cause `sandbox_disk_full` and a Retry offered;
 * - one Retry, after the fault cleared, finished the task (R3).
 *
 * DF1 restarts nothing. It needs a remote sandbox workspace, so it runs with `--env daytona`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OracleResult, RuleResult, TaskPlan, TaskRecord } from "./types.js";

type Json = Record<string, any>;

export const DISK_FULL_FAULT_KINDS = ["DF1"] as const;
export type DiskFullFaultKind = (typeof DISK_FULL_FAULT_KINDS)[number];
export function isDiskFullFault(value: string): value is DiskFullFaultKind {
  return (DISK_FULL_FAULT_KINDS as readonly string[]).includes(value);
}

/** The recovery cause the product names for a save that found the sandbox disk full. */
export const SANDBOX_DISK_FULL_CAUSE = "sandbox_disk_full";

/** Server-side receipt, one per faulted save (sandbox-disk-full-fault.ts DiskFullFaultReceipt). */
export interface DiskFullReceipt { issueId: string | null; runId: string; boundary: string; pid: number; at: string }

/** What the board showed when a DF1 task first rested. */
export interface DiskFullRest {
  at: number;
  status: string | null;
  canRetry: boolean;
  /** `activeRecoveryAction.evidence.systemRecovery.failure.cause.label`. */
  causeLabel: string | null;
  retryClass: string | null;
  ownerType: string | null;
}

export interface DiskFullRecord {
  kind: DiskFullFaultKind;
  armedAt: number | null;
  clearedAt: number | null;
  rest: DiskFullRest | null;
  /** First rest seen while armed; the harness waits for the disk-full verdict from here (DISK_FULL_REST_SETTLE_MS). */
  firstRestAt?: number;
  /** Faulted saves the server recorded for the task; filled in at grading. */
  appliedSaves?: number;
  armError?: string;
}

export function diskFullRest(issue: Json | null, at: number): DiskFullRest {
  const action = (issue?.activeRecoveryAction ?? null) as Json | null;
  const failure = (action?.evidence?.systemRecovery?.failure ?? null) as Json | null;
  return {
    at, status: typeof issue?.status === "string" ? issue.status : null,
    canRetry: issue?.interruption?.canRetry === true,
    causeLabel: typeof failure?.cause?.label === "string" ? failure.cause.label : null,
    retryClass: typeof failure?.retryClass === "string" ? failure.retryClass : null,
    ownerType: typeof action?.ownerType === "string" ? action.ownerType : null,
  };
}

/**
 * A board-owned recovery can look like a rest while it is still checking the saved source
 * ("Recovering saved files…", wave w-20261111T131941-s9412/t02). Clearing the fault there would
 * let that recovery's own save succeed and hide the disk-full rest. While armed, the harness
 * keeps waiting at an unfinished rest until the board names `sandbox_disk_full`, up to this long.
 */
export const DISK_FULL_REST_SETTLE_MS = 10 * 60_000;

/** True when the harness may record this rest and clear the fault; false keeps watching. */
export function diskFullRestReady(record: DiskFullRecord, rest: DiskFullRest, now: number): boolean {
  if (rest.status === "done" || rest.causeLabel === SANDBOX_DISK_FULL_CAUSE) return true;
  record.firstRestAt ??= now;
  return now - record.firstRestAt >= DISK_FULL_REST_SETTLE_MS;
}

/** The control file the server reads and the receipts it writes. */
export class DiskFullFaultSeam {
  private readonly armed = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  private constructor(readonly controlPath: string, readonly receiptPath: string) {}

  static async install(input: { root: string; receiptPath: string }): Promise<DiskFullFaultSeam> {
    const directory = path.join(input.root, "disk-full-fault");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const seam = new DiskFullFaultSeam(path.join(directory, "control"), input.receiptPath);
    await seam.write();
    return seam;
  }

  get serverEnvironment(): Record<string, string> {
    return { PAPERCLIP_DISK_FULL_FAULT_CONTROL: this.controlPath, PAPERCLIP_DISK_FULL_FAULT_RECEIPT: this.receiptPath };
  }

  arm(issueId: string): Promise<void> { this.armed.add(issueId); return this.write(); }
  clear(issueId: string): Promise<void> { this.armed.delete(issueId); return this.write(); }

  /** Atomic, so a save never reads half a file; serialized, so the last change wins. */
  private write(): Promise<void> {
    const body = [...this.armed].map(id => `${id}\n`).join("");
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const temporary = `${this.controlPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.controlPath);
    });
    return this.writes;
  }

  async receipts(): Promise<DiskFullReceipt[]> {
    const text = await readFile(this.receiptPath, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as DiskFullReceipt]; } catch { return []; } });
  }
}

export function receiptsForIssue(receipts: readonly DiskFullReceipt[], issueId: string | null): DiskFullReceipt[] {
  return issueId ? receipts.filter(receipt => receipt.issueId === issueId) : [];
}

/** Adds the `disk_full_fault` check: the fault applied and the task rested on it with a Retry. */
export function withDiskFullCheck(oracle: OracleResult, plan: TaskPlan, record: TaskRecord): OracleResult {
  if (!isDiskFullFault(plan.fault)) return oracle;
  const disk = record.diskFull;
  const applied = disk?.appliedSaves ?? 0;
  const rest = disk?.rest ?? null;
  const problems = [
    ...(disk?.armError ? [`arm_failed=${disk.armError}`] : []),
    ...(applied === 0 ? ["not_applied (no save reached the hook: an unchanged workspace, a local run or a server without the hook)"] : []),
    ...(applied > 0 && !rest ? ["no_rest_while_armed"] : []),
    ...(rest && rest.causeLabel !== SANDBOX_DISK_FULL_CAUSE ? [`rest_cause=${rest.causeLabel ?? "none"}`] : []),
    ...(rest && !rest.canRetry ? ["retry_not_offered"] : []),
  ];
  const detail = `${plan.fault}: faultedSaves=${applied} rest=${rest ? `${rest.status}/${rest.causeLabel ?? "none"}/${rest.retryClass ?? "none"}/canRetry=${rest.canRetry}` : "none"}`
    + (problems.length ? `; ${problems.join("; ")}` : "");
  const checks = [...oracle.checks, { name: "disk_full_fault", ok: problems.length === 0, detail }];
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

/**
 * R3 for DF1. The product cannot free a sandbox disk, so one Retry is the expected outcome, not a
 * failure: R3 passes when exactly one accepted Retry, after the fault cleared, finished the task.
 * Whether the Retry started a new run is not graded: applying the already-saved result without a
 * new turn is a correct Retry too.
 */
export function gradeDiskFullRetry(record: TaskRecord, expectedStatus: string): RuleResult {
  const retry = record.retry;
  if (!retry) {
    return { verdict: "fail", detail: `disk_full_retry_missing: rested ${record.finalStatus ?? "unknown"}${record.timedOut ? " (timed out)" : ""} without a Retry` };
  }
  if (retry.error || retry.accepted !== true) {
    return { verdict: "fail", detail: `retry_rejected: http=${retry.httpStatus ?? "none"} accepted=${String(retry.accepted)} ${retry.error ?? ""}`.trim() };
  }
  const clicks = 1 + (record.priorRetries?.length ?? 0);
  if (clicks > 1) return { verdict: "fail", detail: `retry_needed_${clicks}_clicks (expected one Retry after the disk-full fault cleared)` };
  if (record.finalStatus !== expectedStatus) {
    return { verdict: "fail", detail: `disk_full_retry_did_not_complete (status ${record.finalStatus ?? "unknown"}${record.timedOut ? ", timed out" : ""})` };
  }
  return { verdict: "pass", detail: `expected Retry after ${SANDBOX_DISK_FULL_CAUSE}; Retry worked (${expectedStatus})` };
}

/** Ledger fields: needed-Retry and Retry-worked for the cell. */
export function diskFullLedger(record: TaskRecord, expectedStatus: string) {
  const disk = record.diskFull;
  if (!disk) return undefined;
  return {
    faultedSaves: disk.appliedSaves ?? 0,
    restedDiskFull: disk.rest?.causeLabel === SANDBOX_DISK_FULL_CAUSE,
    retryOffered: disk.rest?.canRetry === true,
    retryWorked: record.retry?.accepted === true && record.finalStatus === expectedStatus,
  };
}
