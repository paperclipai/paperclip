import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKER_TIMING_PHASES = ["setup", "execution", "feedback", "cleanup", "finalization"] as const;
export type WorkerTimingPhase = typeof WORKER_TIMING_PHASES[number];
type TimingContext = { executionId: string; attempt: number; startedAt: string; finishedAt: string };
export type WorkerTiming = {
  version: 1;
  scope: "worker";
  status: "complete" | "partial";
  executionId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  segments: Array<{ phase: WorkerTimingPhase; startedAt: string; finishedAt: string | null }>;
} | {
  version: 1;
  scope: "worker";
  status: "unavailable";
  reason: "write_failed" | "invalid_evidence" | "clock_regression";
};

function invalid(): never { throw new Error("Invalid worker timing receipt"); }
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function timestamp(value: unknown) {
  if (typeof value !== "string") invalid();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) invalid();
  return ms;
}

export function validateWorkerTiming(value: unknown, context: TimingContext): asserts value is WorkerTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const status = (value as Record<string, unknown>).status;
  const record = shape(value, status === "unavailable"
    ? ["version", "scope", "status", "reason"]
    : ["version", "scope", "status", "executionId", "attempt", "startedAt", "finishedAt", "segments"]);
  if (record.version !== 1 || record.scope !== "worker") invalid();
  if (status === "unavailable") {
    if (typeof record.reason !== "string" || !["write_failed", "invalid_evidence", "clock_regression"].includes(record.reason)) invalid();
    return;
  }
  if (status !== "complete" && status !== "partial" || record.executionId !== context.executionId || record.attempt !== context.attempt
      || typeof record.executionId !== "string" || record.executionId.length < 1 || record.executionId.length > 512
      || !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1) invalid();
  const start = timestamp(record.startedAt), lower = Date.parse(context.startedAt), upper = Date.parse(context.finishedAt);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || start < lower || start > upper) invalid();
  if (!Array.isArray(record.segments) || record.segments.length < 1 || record.segments.length > 16) invalid();
  let cursor = start;
  record.segments.forEach((raw, index) => {
    const segment = shape(raw, ["phase", "startedAt", "finishedAt"]);
    if (!WORKER_TIMING_PHASES.includes(segment.phase as WorkerTimingPhase) || index === 0 && segment.phase !== "setup") invalid();
    if (timestamp(segment.startedAt) !== cursor || cursor > upper) invalid();
    if (segment.finishedAt === null) {
      if (status !== "partial" || index !== (record.segments as unknown[]).length - 1) invalid();
    } else {
      const end = timestamp(segment.finishedAt);
      if (end < cursor || end > upper || status === "partial" && index === (record.segments as unknown[]).length - 1) invalid();
      cursor = end;
    }
  });
  if (status === "partial" ? record.finishedAt !== null : timestamp(record.finishedAt) !== cursor) invalid();
}

function unavailable(reason: Extract<WorkerTiming, { status: "unavailable" }>["reason"]): WorkerTiming {
  return { version: 1, scope: "worker", status: "unavailable", reason };
}

export async function createWorkerTiming(
  file: string,
  identity: Pick<TimingContext, "executionId" | "attempt">,
  startedAtMs: number,
) {
  let receipt: WorkerTiming = {
    version: 1, scope: "worker", status: "partial", executionId: identity.executionId, attempt: identity.attempt,
    startedAt: new Date(startedAtMs).toISOString(), finishedAt: null,
    segments: [{ phase: "setup", startedAt: new Date(startedAtMs).toISOString(), finishedAt: null }],
  };
  async function persist(initial = false) {
    if (receipt.status === "unavailable") return;
    const temporary = `${file}.${randomUUID()}.pending`;
    try {
      const data = JSON.stringify(receipt);
      if (initial) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data, { mode: 0o600, flag: "wx" });
      }
      else {
        await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      }
    } catch { receipt = unavailable("write_failed"); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  function closeCurrent(at: number) {
    if (receipt.status === "unavailable" || receipt.status === "complete") return false;
    const active = receipt.segments.at(-1)!;
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()) || at < Date.parse(active.startedAt)) {
      receipt = unavailable("clock_regression");
      return false;
    }
    active.finishedAt = new Date(at).toISOString();
    return true;
  }
  await persist(true);
  return {
    async enter(phase: WorkerTimingPhase, at = Date.now()) {
      if (!closeCurrent(at) || receipt.status === "unavailable") return;
      if (receipt.segments.length >= 16) { receipt = unavailable("invalid_evidence"); return; }
      receipt.segments.push({ phase, startedAt: new Date(at).toISOString(), finishedAt: null });
      await persist();
    },
    async finish(at = Date.now()): Promise<WorkerTiming> {
      if (closeCurrent(at) && receipt.status !== "unavailable") {
        receipt.status = "complete";
        receipt.finishedAt = new Date(at).toISOString();
        await persist();
      }
      return structuredClone(receipt);
    },
  };
}

export async function recoverWorkerTiming(file: string, context: TimingContext): Promise<WorkerTiming | undefined> {
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return unavailable("invalid_evidence");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192) return unavailable("invalid_evidence");
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) return unavailable("invalid_evidence");
      const receipt: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      validateWorkerTiming(receipt, context);
      return receipt;
    } finally { await handle.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unavailable("invalid_evidence");
  }
}
