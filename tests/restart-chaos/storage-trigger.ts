import type { IncomingMessage, ServerResponse } from "node:http";
import type { FaultKind, FaultReceipt, WaveOptions, WorkloadId } from "./types.js";
import type { StorageRequestListener } from "./storage-proxy.js";
import type { RestartStep } from "./repeated-restarts.js";

export const STORAGE_TRIGGER_TARGETS = ["snapshot-upload", "snapshot-part", "snapshot-download", "run-log"] as const;
export type StorageTriggerTarget = typeof STORAGE_TRIGGER_TARGETS[number];
export const STORAGE_TRIGGER_HOLD_MS = 60_000;

export const STORAGE_TRIGGER_BOARD_WORKLOADS: readonly WorkloadId[] = ["G1", "H1", "Q1"];

export function storageTriggerMatches(target: StorageTriggerTarget, method: string, url: string, declaredBytes: number | null = null): boolean {
  const [route = "", query = ""] = url.split("?", 2);
  switch (target) {
    case "snapshot-upload": return method === "PUT" && route.includes("/workspace-snapshots/") && (declaredBytes ?? 0) > 0;
    case "snapshot-part": return method === "PUT" && route.includes("/workspace-snapshots/") && /(^|&)partNumber=/.test(query);
    case "snapshot-download": return method === "GET" && route.includes("/workspace-snapshots/");
    case "run-log": return (method === "PUT" || method === "POST") && route.includes("/run-logs/");
  }
}

export function parseStorageTrigger(value: string, options: Pick<WaveOptions, "storage" | "stormMinutes" | "crashPoint" | "triggers" | "workloads" | "matrix">): StorageTriggerTarget {
  if (options.storage !== "s3") throw new Error("--storage-trigger needs --storage s3");
  if (options.stormMinutes || options.crashPoint) throw new Error("--storage-trigger arms each task's planned fault; a storm or crash-point wave has none");
  if (options.matrix) throw new Error("--storage-trigger arms faults by time; --matrix plans trigger cells whose windows it would skip");
  if ((options.triggers ?? []).some(trigger => trigger !== "time")) throw new Error("--storage-trigger replaces the fault's trigger; use it with --triggers time");
  const board = options.workloads.filter(workload => STORAGE_TRIGGER_BOARD_WORKLOADS.includes(workload));
  if (board.length) throw new Error(`--storage-trigger keeps a fault armed after its planned time; board-acting workloads (${board.join(", ")}) would act before the restart`);
  if (!(STORAGE_TRIGGER_TARGETS as readonly string[]).includes(value)) {
    throw new Error(`--storage-trigger takes one of ${STORAGE_TRIGGER_TARGETS.join(", ")}`);
  }
  return value as StorageTriggerTarget;
}

export function redactStorageUrl(url: string): string {
  const [route = "", query] = url.split("?", 2);
  if (query === undefined) return route;
  const kept = query.split("&").filter(part => part && !/^x-amz-/i.test(part)).map(part => {
    const [name = "", raw] = part.split("=", 2);
    return name === "partNumber" || name === "x-id" || raw === undefined ? part : `${name}=…`;
  });
  return kept.length ? `${route}?${kept.join("&")}` : route;
}

export type StorageRequestOutcome = "in_flight" | "completed" | "aborted";

export interface StorageRequestRecord {
  id: number; method: string; path: string; startedAt: number; declaredBytes: number | null;
  held: boolean; outcome: StorageRequestOutcome; status: number | null; settledAt: number | null;
}

export interface ArmedStorageFault { taskId: string; kind: FaultKind; holdMs: number; armedAt: number; restartSteps?: RestartStep[] }

export interface StorageTriggerReceipt {
  target: StorageTriggerTarget; taskId: string; kind: FaultKind; armedAt: number;
  firedAt: number | null; missedAt: number | null; missedReason?: string;
  request: StorageRequestRecord | null; inFlight: StorageRequestRecord[]; faultId?: string;
}

export interface StorageTriggerHooks {
  canFire(): boolean;
  isOpen(taskId: string): boolean;
  fire(armed: ArmedStorageFault, request: StorageRequestRecord): Promise<void>;
  record(kind: string, data: Record<string, unknown>): void;
}

export class StorageTrigger {
  readonly receipts: StorageTriggerReceipt[] = [];
  private readonly armed: Array<{ fault: ArmedStorageFault; receipt: StorageTriggerReceipt }> = [];
  private readonly open = new Map<number, StorageRequestRecord>();
  private nextId = 1;
  private firing = false;

  constructor(readonly target: StorageTriggerTarget, private readonly hooks: StorageTriggerHooks, private readonly holdMs = STORAGE_TRIGGER_HOLD_MS) {}

  get busy(): boolean { return this.firing; }

  arm(fault: ArmedStorageFault): void {
    const receipt: StorageTriggerReceipt = { target: this.target, taskId: fault.taskId, kind: fault.kind, armedAt: fault.armedAt,
      firedAt: null, missedAt: null, request: null, inFlight: [] };
    this.receipts.push(receipt);
    this.armed.push({ fault, receipt });
    this.hooks.record("storage_trigger_armed", { taskId: fault.taskId, fault: fault.kind, target: this.target });
  }

  readonly listener: StorageRequestListener = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const method = incoming.method ?? "GET";
    const url = incoming.url ?? "/";
    const length = Number(incoming.headers["content-length"]);
    const request: StorageRequestRecord = { id: this.nextId++, method, path: redactStorageUrl(url), startedAt: Date.now(),
      declaredBytes: Number.isFinite(length) ? length : null, held: false, outcome: "in_flight", status: null, settledAt: null };
    this.open.set(request.id, request);
    outgoing.on("close", () => {
      this.open.delete(request.id);
      request.outcome = outgoing.writableFinished ? "completed" : "aborted";
      request.status = outgoing.headersSent ? outgoing.statusCode : null;
      request.settledAt = Date.now();
    });
    if (!storageTriggerMatches(this.target, method, url, request.declaredBytes)) return;
    const next = this.take(request.startedAt);
    if (!next) return;
    request.held = true;
    this.firing = true;
    next.receipt.firedAt = request.startedAt;
    next.receipt.request = request;
    next.receipt.inFlight = [...this.open.values()];
    this.hooks.record("storage_trigger_fired", { taskId: next.fault.taskId, fault: next.fault.kind, target: this.target,
      request: `${method} ${request.path}`, inFlight: next.receipt.inFlight.length });
    void this.hooks.fire(next.fault, request).catch(error => {
      this.hooks.record("storage_trigger_fire_failed", { taskId: next.fault.taskId, error: String(error) });
    }).finally(() => { this.firing = false; });
    return this.holdMs;
  };

  private take(now: number) {
    if (this.firing || !this.armed.length || !this.hooks.canFire()) return null;
    while (this.armed.length) {
      const next = this.armed.shift()!;
      if (this.hooks.isOpen(next.fault.taskId)) return next;
      this.miss(next.receipt, now, "task_rested");
    }
    return null;
  }

  private miss(receipt: StorageTriggerReceipt, at: number, reason: string) {
    receipt.missedAt = at;
    receipt.missedReason = reason;
    this.hooks.record("storage_trigger_missed", { taskId: receipt.taskId, fault: receipt.kind, target: this.target, reason });
  }

  finish(faults: readonly FaultReceipt[], now = Date.now()): StorageTriggerReceipt[] {
    for (const { receipt } of this.armed.splice(0)) this.miss(receipt, now, this.hooks.isOpen(receipt.taskId) ? "no_matching_request" : "task_rested");
    for (const receipt of this.receipts) {
      if (receipt.firedAt === null) continue;
      const fault = faults.filter(candidate => candidate.requestedBy === receipt.taskId && candidate.requestedAt >= receipt.firedAt!)
        .sort((left, right) => left.requestedAt - right.requestedAt)[0];
      if (fault) receipt.faultId = fault.faultId;
    }
    return this.receipts;
  }
}

export function storageTriggerShortfall(receipts: readonly StorageTriggerReceipt[]): string | null {
  const fired = receipts.filter(receipt => receipt.firedAt !== null);
  if (!fired.length) return `--storage-trigger: no restart interrupted a matching transfer (${receipts.length} armed, none fired)`;
  const unproven = fired.filter(receipt => !receipt.faultId || receipt.request?.outcome !== "aborted");
  if (!unproven.length) return null;
  return `--storage-trigger: ${unproven.length} fired restart(s) did not provably interrupt the held request: ${unproven
    .map(receipt => `${receipt.taskId} fault=${receipt.faultId ?? "none"} outcome=${receipt.request?.outcome ?? "none"}`).join(", ")}`;
}

export function storageTriggerMarkdown(receipts: readonly StorageTriggerReceipt[]): string {
  const fired = receipts.filter(receipt => receipt.firedAt !== null);
  const proven = fired.filter(receipt => receipt.faultId && receipt.request?.outcome === "aborted");
  const lines = [`## Storage trigger (${receipts[0]?.target ?? "none"})`, "",
    `${proven.length} of ${receipts.length} armed faults interrupted a transfer; ${receipts.length - fired.length} not reached.`, "",
    "| Task | Fault | Fault id | Result | Request |", "| --- | --- | --- | --- | --- |",
    ...receipts.map(receipt => `| ${receipt.taskId} | ${receipt.kind} | ${receipt.faultId ?? "-"} | ${receipt.firedAt === null
      ? `not reached (${receipt.missedReason ?? "unknown"})` : receipt.request?.outcome ?? "unknown"} | ${receipt.request
      ? `\`${receipt.request.method} ${receipt.request.path.split("/").slice(-3).join("/")}\`` : "-"} |`)];
  return `${lines.join("\n")}\n`;
}

export async function exposedAfterLaunch<T extends { done: boolean }>(launching: Promise<unknown> | null, launched: readonly T[]): Promise<T[]> {
  await launching;
  return launched.filter(candidate => !candidate.done);
}
