import type { AuditEntryLite } from "./audit-tail.js";

export type AlertFn = (message: string) => void;
export type ClassifierStatus = "reachable" | "unreachable";

export interface MonitorOptions {
  alertFn: AlertFn;
  dedupMs?: number;
  errorRateThreshold?: number;
  errorRateWindowMs?: number;
  classifierFailThreshold?: number;
  now?: () => number;
}

type TriggerKey = "art_9" | "classifier_down" | "error_rate";

export class Monitor {
  private readonly alertFn: AlertFn;
  private readonly dedupMs: number;
  private readonly errorRateThreshold: number;
  private readonly errorRateWindowMs: number;
  private readonly classifierFailThreshold: number;
  private readonly now: () => number;

  private lastFiredAt: Partial<Record<TriggerKey, number>> = {};
  private errorTimestamps: number[] = [];
  private classifierFailStreak = 0;

  constructor(opts: MonitorOptions) {
    this.alertFn = opts.alertFn;
    this.dedupMs = opts.dedupMs ?? 600_000;
    this.errorRateThreshold = opts.errorRateThreshold ?? 10;
    this.errorRateWindowMs = opts.errorRateWindowMs ?? 3_600_000;
    this.classifierFailThreshold = opts.classifierFailThreshold ?? 3;
    this.now = opts.now ?? Date.now;
  }

  evaluate(entries: AuditEntryLite[]): void {
    for (const e of entries) {
      if (e.blocked && e.blockedReason === "art_9_data_detected") {
        this.tryFire("art_9", `DPO art_9 block\nagent: ${e.agent ?? "?"}\ntargetLlm: ${e.targetLlm ?? "?"}\nts: ${e.ts}`);
      }
      if (e.blocked) {
        this.errorTimestamps.push(this.now());
      }
    }
    const cutoff = this.now() - this.errorRateWindowMs;
    this.errorTimestamps = this.errorTimestamps.filter((t) => t >= cutoff);
    if (this.errorTimestamps.length > this.errorRateThreshold) {
      this.tryFire("error_rate", `DPO error rate: ${this.errorTimestamps.length} blocks in last hour`);
    }
  }

  recordClassifierStatus(status: ClassifierStatus): void {
    if (status === "reachable") {
      this.classifierFailStreak = 0;
      return;
    }
    this.classifierFailStreak++;
    if (this.classifierFailStreak >= this.classifierFailThreshold) {
      this.tryFire("classifier_down", `DPO classifier unreachable (${this.classifierFailStreak} consecutive fails)`);
    }
  }

  private tryFire(key: TriggerKey, msg: string): void {
    const last = this.lastFiredAt[key] ?? -Infinity;
    if (this.now() - last < this.dedupMs) return;
    this.lastFiredAt[key] = this.now();
    this.alertFn(msg);
  }
}
