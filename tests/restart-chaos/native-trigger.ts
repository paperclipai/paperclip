import type { FaultKind, FaultReceipt, WaveOptions, WorkloadId } from "./types.js";
import type { RestartStep } from "./repeated-restarts.js";
import { storageFaultRules, type StorageFaultWindow } from "./storage-chaos.js";

export const NATIVE_TRIGGER_TARGETS = ["native-start", "provider-event"] as const;
export type NativeTriggerTarget = typeof NATIVE_TRIGGER_TARGETS[number];
export interface NativeTriggerSpec { target: NativeTriggerTarget; delayMs: number; outageMs?: number }

export const NATIVE_TRIGGER_BOARD_WORKLOADS: readonly WorkloadId[] = ["G1", "H1", "Q1"];
export const NATIVE_START_EVENT = "native.process_start_requested";
const PROVIDER_EVENT_TYPES = new Set(["session.started", "turn.submitted", "turn.started", "turn.accepted"]);
const EVENT_PAGE = 200;
const EVENT_PAGES_PER_LOOK = 3;

export function nativeTriggerMatches(target: NativeTriggerTarget, eventType: string): boolean {
  return target === "native-start" ? eventType === NATIVE_START_EVENT : PROVIDER_EVENT_TYPES.has(eventType);
}

export function parseNativeTrigger(value: string, options: Pick<WaveOptions, "storageTrigger" | "stormMinutes" | "crashPoint" | "triggers" | "workloads" | "matrix">): NativeTriggerSpec {
  if (options.storageTrigger) throw new Error("--native-trigger and --storage-trigger both arm the planned fault; pick one");
  if (options.stormMinutes || options.crashPoint) throw new Error("--native-trigger arms each task's planned fault; a storm or crash-point wave has none");
  if (options.matrix) throw new Error("--native-trigger arms faults by time; --matrix plans trigger cells whose windows it would skip");
  if ((options.triggers ?? []).some(trigger => trigger !== "time")) throw new Error("--native-trigger replaces the fault's trigger; use it with --triggers time");
  const board = options.workloads.filter(workload => NATIVE_TRIGGER_BOARD_WORKLOADS.includes(workload));
  if (board.length) throw new Error(`--native-trigger keeps a fault armed after its planned time; board-acting workloads (${board.join(", ")}) would act before the restart`);
  const match = /^([a-z-]+)(?:\+(\d+))?$/.exec(value);
  const target = match?.[1];
  const seconds = match?.[2] === undefined ? 0 : Number(match[2]);
  if (!target || !(NATIVE_TRIGGER_TARGETS as readonly string[]).includes(target) || seconds > 600) {
    throw new Error(`--native-trigger takes ${NATIVE_TRIGGER_TARGETS.join(" or ")}, optionally +<seconds> (0-600), for example native-start+5`);
  }
  return { target: target as NativeTriggerTarget, delayMs: seconds * 1000 };
}

export function parseNativeTriggerOutage(value: string, options: Pick<WaveOptions, "nativeTrigger" | "storage" | "storageFaults">): number {
  if (!options.nativeTrigger) throw new Error("--native-trigger-outage needs --native-trigger");
  if (options.storage !== "s3") throw new Error("--native-trigger-outage needs --storage s3");
  if (options.storageFaults?.length) throw new Error("--native-trigger-outage starts its own ST1 window; drop --storage-faults");
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(seconds >= 10 && seconds <= 900)) throw new Error("--native-trigger-outage takes 10 to 900 seconds");
  return seconds * 1000;
}

export function triggeredOutageWindow(startMs: number, durationMs: number): StorageFaultWindow {
  return { kind: "ST1", startMs, durationMs, rules: storageFaultRules("ST1", () => 0) };
}

export interface ArmedNativeFault { taskId: string; kind: FaultKind; holdMs: number; armedAt: number; restartSteps?: RestartStep[] }

export interface NativeTriggerReceipt {
  target: NativeTriggerTarget; delayMs: number; taskId: string; kind: FaultKind; armedAt: number;
  seenAt: number | null; runId: string | null; eventType: string | null;
  firedAt: number | null; missedAt: number | null; missedReason?: string; faultId?: string;
}

export function runningRunIds(rows: readonly unknown[] | null): string[] {
  return (rows ?? []).flatMap(row => {
    const run = row as { runId?: unknown; id?: unknown; status?: unknown } | null;
    const id = run?.runId ?? run?.id;
    return typeof id === "string" && run?.status === "running" ? [id] : [];
  });
}

export interface NativeTriggerEvent { seq: number; eventType: string; createdAt: string }

export interface NativeTriggerHooks {
  canFire(): boolean;
  isOpen(taskId: string): boolean;
  issueId(taskId: string): string | null;
  runs(issueId: string): Promise<unknown[] | null>;
  events(runId: string, afterSeq: number, limit: number): Promise<NativeTriggerEvent[] | null>;
  fire(armed: ArmedNativeFault): Promise<void>;
  record(kind: string, data: Record<string, unknown>): void;
}

export class NativeTrigger {
  readonly receipts: NativeTriggerReceipt[] = [];
  private readonly armed: Array<{ fault: ArmedNativeFault; receipt: NativeTriggerReceipt }> = [];
  private readonly cursors = new Map<string, number>();
  private firing = false;

  constructor(readonly spec: NativeTriggerSpec, private readonly hooks: NativeTriggerHooks) {}

  get busy(): boolean { return this.firing || this.armed.some(entry => entry.receipt.seenAt !== null); }

  arm(fault: ArmedNativeFault): void {
    const receipt: NativeTriggerReceipt = { target: this.spec.target, delayMs: this.spec.delayMs, taskId: fault.taskId,
      kind: fault.kind, armedAt: fault.armedAt, seenAt: null, runId: null, eventType: null, firedAt: null, missedAt: null };
    this.receipts.push(receipt);
    this.armed.push({ fault, receipt });
    this.hooks.record("native_trigger_armed", { taskId: fault.taskId, fault: fault.kind, target: this.spec.target, delayMs: this.spec.delayMs });
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.firing) return;
    for (const entry of [...this.armed]) {
      if (!this.hooks.isOpen(entry.fault.taskId)) {
        this.armed.splice(this.armed.indexOf(entry), 1);
        this.miss(entry.receipt, now, entry.receipt.seenAt === null ? "task_rested" : "task_rested_after_event");
        continue;
      }
      if (entry.receipt.seenAt === null) await this.look(entry.receipt);
      const { seenAt } = entry.receipt;
      if (seenAt === null || now < seenAt + this.spec.delayMs || !this.hooks.canFire()) continue;
      this.armed.splice(this.armed.indexOf(entry), 1);
      entry.receipt.firedAt = now;
      this.firing = true;
      this.hooks.record("native_trigger_fired", { taskId: entry.fault.taskId, fault: entry.fault.kind, target: this.spec.target,
        runId: entry.receipt.runId, eventType: entry.receipt.eventType, afterEventMs: now - seenAt });
      void this.hooks.fire(entry.fault).catch(error => {
        this.hooks.record("native_trigger_fire_failed", { taskId: entry.fault.taskId, error: String(error) });
      }).finally(() => { this.firing = false; });
      return;
    }
  }

  private async look(receipt: NativeTriggerReceipt): Promise<void> {
    const issueId = this.hooks.issueId(receipt.taskId);
    if (!issueId) return;
    const runs = await this.hooks.runs(issueId).catch(() => null);
    for (const runId of runningRunIds(runs)) {
      let afterSeq = this.cursors.get(runId) ?? 0;
      for (let page = 0; page < EVENT_PAGES_PER_LOOK; page += 1) {
        const events = await this.hooks.events(runId, afterSeq, EVENT_PAGE).catch(() => null);
        if (!events?.length) break;
        for (const event of events) {
          afterSeq = Math.max(afterSeq, event.seq);
          const at = Date.parse(event.createdAt);
          if (receipt.seenAt === null && Number.isFinite(at) && at >= receipt.armedAt && nativeTriggerMatches(this.spec.target, event.eventType)) {
            receipt.seenAt = at;
            receipt.runId = runId;
            receipt.eventType = event.eventType;
          }
        }
        if (events.length < EVENT_PAGE) break;
      }
      this.cursors.set(runId, afterSeq);
      if (receipt.seenAt !== null) return;
    }
  }

  private miss(receipt: NativeTriggerReceipt, at: number, reason: string) {
    receipt.missedAt = at;
    receipt.missedReason = reason;
    this.hooks.record("native_trigger_missed", { taskId: receipt.taskId, fault: receipt.kind, target: this.spec.target, reason });
  }

  finish(faults: readonly FaultReceipt[], now = Date.now()): NativeTriggerReceipt[] {
    for (const { receipt } of this.armed.splice(0)) {
      this.miss(receipt, now, receipt.seenAt !== null ? "task_rested_after_event"
        : this.hooks.isOpen(receipt.taskId) ? "no_matching_event" : "task_rested");
    }
    for (const receipt of this.receipts) {
      if (receipt.firedAt === null) continue;
      const fault = faults.filter(candidate => candidate.requestedBy === receipt.taskId && candidate.requestedAt >= receipt.firedAt!)
        .sort((left, right) => left.requestedAt - right.requestedAt)[0];
      if (fault) receipt.faultId = fault.faultId;
    }
    return this.receipts;
  }
}

export function nativeTriggerShortfall(receipts: readonly NativeTriggerReceipt[]): string | null {
  const fired = receipts.filter(receipt => receipt.firedAt !== null);
  if (!fired.length) {
    const seen = receipts.filter(receipt => receipt.seenAt !== null).length;
    return `--native-trigger: no restart followed a matching run event (${receipts.length} armed, ${seen} saw the event, none fired)`;
  }
  const unproven = fired.filter(receipt => !receipt.faultId);
  return unproven.length ? `--native-trigger: ${unproven.length} fired trigger(s) produced no fault: ${unproven.map(receipt => receipt.taskId).join(", ")}` : null;
}

export function nativeTriggerMarkdown(receipts: readonly NativeTriggerReceipt[]): string {
  const first = receipts[0];
  const lines = [`## Native trigger (${first ? `${first.target}+${first.delayMs / 1000}s` : "none"})`, "",
    `${receipts.filter(receipt => receipt.faultId).length} of ${receipts.length} armed faults fired after a matching run event.`, "",
    "| Task | Fault | Fault id | Run | Event | Fired after event |", "| --- | --- | --- | --- | --- | --- |",
    ...receipts.map(receipt => `| ${receipt.taskId} | ${receipt.kind} | ${receipt.faultId ?? "-"} | ${receipt.runId?.slice(0, 8) ?? "-"} | ${
      receipt.eventType ?? `not reached (${receipt.missedReason ?? "unknown"})`} | ${receipt.firedAt !== null && receipt.seenAt !== null
      ? `${((receipt.firedAt - receipt.seenAt) / 1000).toFixed(1)} s` : "-"} |`)];
  return `${lines.join("\n")}\n`;
}
