import { credentialFaultRules } from "./storage-credentials.js";
import type { StorageFaultRule } from "./storage-proxy.js";
import { bandwidthDraw } from "./storage-bandwidth.js";
import { lagFaultRules } from "./storage-lag.js";
import { multipartFaultRules } from "./storage-multipart.js";

export const STORAGE_FAULT_KINDS = ["ST1", "ST2", "ST3", "ST4", "ST5", "ST5R", "ST7", "ST8"] as const;
export type StorageFaultKind = typeof STORAGE_FAULT_KINDS[number];

export interface StorageFaultWindow { kind: StorageFaultKind; startMs: number; durationMs: number; rules: StorageFaultRule[] }

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function storageFaultRules(kind: StorageFaultKind, random: () => number): StorageFaultRule[] {
  switch (kind) {
    case "ST1": return [{ fault: { kind: "outage", status: 503 } }];
    case "ST2": {
      const ms = 1_000 + Math.round(random() * 9_000);
      return [{ fault: { kind: "latency", ms, jitterMs: Math.round(ms / 4), bytesPerSecond: bandwidthDraw(random) } }];
    }
    case "ST3": return [{ fault: { kind: "errors", rate: 0.3, status: 503, slowDown: random() < 0.5 } }];
    case "ST4": return multipartFaultRules(random);
    case "ST5": case "ST5R": return credentialFaultRules(kind, random);
    case "ST7": return lagFaultRules(random);
    case "ST8": return [{ fault: { kind: "throttle" }, methods: ["PUT"], pathIncludes: "native-harness-backups",
      firstObjectOnly: true, remaining: 9 + Math.floor(random() * 4) }];
  }
}

export function planStorageFaults(input: { kinds: readonly StorageFaultKind[]; seed: number; spanMs: number;
  firstAtMs?: number; gapMs?: readonly [number, number]; durationMs?: readonly [number, number] }): StorageFaultWindow[] {
  if (!input.kinds.length) return [];
  const random = rng(input.seed ^ 0x5f3759df);
  const [gapMin, gapMax] = input.gapMs ?? [60_000, 120_000];
  const [durationMin, durationMax] = input.durationMs ?? [60_000, 180_000];
  const windows: StorageFaultWindow[] = [];
  let at = input.firstAtMs ?? 45_000;
  while (at < input.spanMs) {
    const kind = input.kinds[Math.floor(random() * input.kinds.length)]!;
    const durationMs = durationMin + Math.round(random() * (durationMax - durationMin));
    windows.push({ kind, startMs: at, durationMs, rules: storageFaultRules(kind, random) });
    at += durationMs + gapMin + Math.round(random() * (gapMax - gapMin));
  }
  return windows;
}

export function activeStorageWindow(windows: readonly StorageFaultWindow[], elapsedMs: number): StorageFaultWindow | null {
  return windows.find(window => elapsedMs >= window.startMs && elapsedMs < window.startMs + window.durationMs) ?? null;
}

export interface StorageFaultReceipt { kind: StorageFaultKind; startedAt: number; endedAt: number | null; rules: StorageFaultRule[] }

export function replayStorageWindows(receipts: readonly StorageFaultReceipt[], taskCreatedAt: number, endedAt: number): StorageFaultWindow[] {
  return receipts.flatMap(receipt => {
    const start = Math.max(receipt.startedAt, taskCreatedAt);
    const end = receipt.endedAt ?? endedAt;
    return end > start ? [{ kind: receipt.kind, startMs: start - taskCreatedAt, durationMs: end - start, rules: receipt.rules }] : [];
  });
}

export class StorageChaos {
  private applied: StorageFaultWindow | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly receipts: StorageFaultReceipt[] = [];

  constructor(readonly windows: readonly StorageFaultWindow[], private startedAt: number,
    private readonly proxy: { setRules(rules: readonly StorageFaultRule[]): void; clear(): void },
    private readonly record: (kind: string, data: Record<string, unknown>) => void) {}

  tick(now = Date.now()): void {
    const active = activeStorageWindow(this.windows, now - this.startedAt);
    if (active === this.applied) return;
    if (this.applied) {
      this.proxy.clear();
      const receipt = this.receipts.at(-1);
      if (receipt) receipt.endedAt = now;
      this.record("storage_fault_ended", { kind: this.applied.kind });
    }
    this.applied = active;
    if (active) {
      this.proxy.setRules(active.rules);
      this.receipts.push({ kind: active.kind, startedAt: now, endedAt: null, rules: active.rules });
      this.record("storage_fault_started", { kind: active.kind, durationMs: active.durationMs, rules: active.rules });
    }
  }

  start(intervalMs = 1_000, at = Date.now()): void {
    if (this.timer) return;
    this.startedAt = at;
    this.timer = setInterval(() => this.tick(Date.now()), intervalMs);
    this.timer.unref?.();
    this.tick(Date.now());
  }

  stop(now = Date.now()): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.applied) return;
    this.proxy.clear();
    const receipt = this.receipts.at(-1);
    if (receipt) receipt.endedAt = now;
    this.record("storage_fault_ended", { kind: this.applied.kind, atStop: true });
    this.applied = null;
  }
}
