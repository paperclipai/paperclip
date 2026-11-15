import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createHistogram,
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
  type RecordableHistogram,
} from "node:perf_hooks";
import type { RequestHandler } from "express";
import { databaseStatementCount, type DedicatedDbConnectionStats } from "@paperclipai/db";
import { readBuildCommit } from "../build-commit.js";

export const SERVER_METRICS_ENV = "PAPERCLIP_SERVER_METRICS";
export const SERVER_METRICS_SCHEMA = "paperclip.server-metrics.v1";
export const SERVER_METRICS_BUCKET_MS = 10_000;
export const SERVER_METRICS_BUCKETS = 6;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const LINUX_CLOCK_TICK_MS = 10;

export type ServerMetricsSnapshot = {
  schema: typeof SERVER_METRICS_SCHEMA;
  processId: string;
  buildRevision: string | null;
  uptimeSec: number;
  sampledAt: string;
  windowMs: number;
  mainThreadCpu: number | null;
  processCpu: number;
  eventLoopUtilization: number;
  eventLoopDelayP99Ms: number;
  statementsPerSecond: number;
  runEventLatenessP99Ms: number | null;
  runEventLatenessSamples: number;
  agentApiPreHandlerP99Ms: number | null;
  agentApiPreHandlerSamples: number;
  leaseRenewalsMissed: number;
  dedicatedConnections: DedicatedDbConnectionStats | null;
};

export type ServerMetricsProbes = {
  now: () => number;
  wallNow: () => number;
  eventLoopUtilization: (current?: EventLoopUtilization, previous?: EventLoopUtilization) => EventLoopUtilization;
  processCpuMicros: () => number;
  mainThreadCpuMs: () => number | null;
  statementCount: () => number;
  uptimeSec: () => number;
  dedicatedConnections: () => DedicatedDbConnectionStats | null;
};

type Checkpoint = {
  at: number;
  elu: EventLoopUtilization;
  processCpuMicros: number;
  mainThreadCpuMs: number | null;
  statements: number;
};

function readLinuxMainThreadCpuMs(): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    return Number.isFinite(ticks) ? ticks * LINUX_CLOCK_TICK_MS : null;
  } catch {
    return null;
  }
}

const defaultProbes: ServerMetricsProbes = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  eventLoopUtilization: (current, previous) => performance.eventLoopUtilization(current, previous),
  processCpuMicros: () => {
    const usage = process.cpuUsage();
    return usage.user + usage.system;
  },
  mainThreadCpuMs: readLinuxMainThreadCpuMs,
  statementCount: databaseStatementCount,
  uptimeSec: () => process.uptime(),
  dedicatedConnections: () => null,
};

const round = (value: number, digits: number) => Number(value.toFixed(digits));

export class ServerMetricsCollector {
  readonly processId: string;
  readonly buildRevision: string | null;
  private readonly probes: ServerMetricsProbes;
  private readonly bucketMs: number;
  private readonly starts: Array<Checkpoint | null>;
  private readonly lateness: RecordableHistogram[];
  private readonly preHandler: RecordableHistogram[];
  private readonly delayP99Ns: number[];
  private readonly merged = createHistogram();
  private readonly eventLoopDelay: IntervalHistogram | null;
  private current = 0;
  private missedLeaseRenewals = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: { probes?: Partial<ServerMetricsProbes>; bucketMs?: number; buckets?: number;
    buildRevision?: string | null; monitorEventLoop?: boolean; processId?: string } = {}) {
    this.processId = options.processId ?? randomBytes(8).toString("hex");
    this.probes = { ...defaultProbes, ...options.probes };
    this.bucketMs = options.bucketMs ?? SERVER_METRICS_BUCKET_MS;
    const buckets = options.buckets ?? SERVER_METRICS_BUCKETS;
    this.buildRevision = options.buildRevision === undefined ? readBuildCommit() : options.buildRevision;
    this.starts = Array.from({ length: buckets }, () => null);
    this.lateness = Array.from({ length: buckets }, () => createHistogram());
    this.preHandler = Array.from({ length: buckets }, () => createHistogram());
    this.delayP99Ns = Array.from({ length: buckets }, () => 0);
    this.eventLoopDelay = options.monitorEventLoop === false ? null
      : monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
    this.eventLoopDelay?.enable();
    this.starts[0] = this.checkpoint();
    this.arm();
  }

  private checkpoint(): Checkpoint {
    return {
      at: this.probes.now(),
      elu: this.probes.eventLoopUtilization(),
      processCpuMicros: this.probes.processCpuMicros(),
      mainThreadCpuMs: this.probes.mainThreadCpuMs(),
      statements: this.probes.statementCount(),
    };
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rotate();
      this.arm();
    }, this.bucketMs);
    this.timer.unref();
  }

  rotate(): void {
    const now = this.checkpoint();
    const started = this.starts[this.current]!;
    const steps = Math.min(this.starts.length - 1, Math.max(1, Math.floor((now.at - started.at) / this.bucketMs)));
    if (this.eventLoopDelay) {
      this.delayP99Ns[this.current] = this.eventLoopDelay.percentile(99);
      this.eventLoopDelay.reset();
    }
    for (let step = 0; step < steps; step += 1) {
      this.current = (this.current + 1) % this.starts.length;
      this.lateness[this.current]!.reset();
      this.preHandler[this.current]!.reset();
      this.delayP99Ns[this.current] = 0;
      this.starts[this.current] = null;
    }
    this.starts[this.current] = now;
  }

  recordRunEventLatenessMs(ms: number): void {
    this.lateness[this.current]!.record(Math.max(1, Math.round(ms * 1000)));
  }

  recordAgentApiPreHandlerMs(ms: number): void {
    this.preHandler[this.current]!.record(Math.max(1, Math.round(ms * 1000)));
  }

  recordMissedLeaseRenewal(): void {
    this.missedLeaseRenewals += 1;
  }

  private windowP99Ms(histograms: RecordableHistogram[]): { p99Ms: number | null; samples: number } {
    this.merged.reset();
    for (const histogram of histograms) if (histogram.count > 0) this.merged.add(histogram);
    const samples = this.merged.count;
    return { p99Ms: samples > 0 ? round(this.merged.percentile(99) / 1000, 3) : null, samples };
  }

  snapshot(): ServerMetricsSnapshot {
    const now = this.checkpoint();
    let oldest = this.starts[this.current]!;
    for (let offset = 1; offset < this.starts.length; offset += 1) {
      const start = this.starts[(this.current + offset) % this.starts.length];
      if (start) { oldest = start; break; }
    }
    const windowMs = Math.max(1, now.at - oldest.at);
    let delayP99Ns = this.eventLoopDelay?.percentile(99) ?? 0;
    for (let index = 0; index < this.starts.length; index += 1) {
      if (index !== this.current && this.starts[index]) delayP99Ns = Math.max(delayP99Ns, this.delayP99Ns[index]!);
    }
    const lateness = this.windowP99Ms(this.lateness);
    const preHandler = this.windowP99Ms(this.preHandler);
    return {
      schema: SERVER_METRICS_SCHEMA,
      processId: this.processId,
      buildRevision: this.buildRevision,
      uptimeSec: Math.round(this.probes.uptimeSec()),
      sampledAt: new Date(this.probes.wallNow()).toISOString(),
      windowMs: Math.round(windowMs),
      mainThreadCpu: now.mainThreadCpuMs !== null && oldest.mainThreadCpuMs !== null
        ? round((now.mainThreadCpuMs - oldest.mainThreadCpuMs) / windowMs, 4) : null,
      processCpu: round((now.processCpuMicros - oldest.processCpuMicros) / 1000 / windowMs, 4),
      eventLoopUtilization: round(this.probes.eventLoopUtilization(now.elu, oldest.elu).utilization, 4),
      eventLoopDelayP99Ms: round(delayP99Ns / 1e6, 3),
      statementsPerSecond: round((now.statements - oldest.statements) / (windowMs / 1000), 2),
      runEventLatenessP99Ms: lateness.p99Ms,
      runEventLatenessSamples: lateness.samples,
      agentApiPreHandlerP99Ms: preHandler.p99Ms,
      agentApiPreHandlerSamples: preHandler.samples,
      leaseRenewalsMissed: this.missedLeaseRenewals,
      dedicatedConnections: this.probes.dedicatedConnections(),
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.eventLoopDelay?.disable();
  }
}

let active: ServerMetricsCollector | null = null;

export function serverMetricsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env[SERVER_METRICS_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${SERVER_METRICS_ENV} must be "true" or "false", got: ${env[SERVER_METRICS_ENV]}`);
}

export function startServerMetrics(dedicatedConnections?: () => DedicatedDbConnectionStats | null): ServerMetricsCollector {
  active ??= new ServerMetricsCollector(dedicatedConnections ? { probes: { dedicatedConnections } } : {});
  return active;
}

export function stopServerMetrics(collector: ServerMetricsCollector): void {
  collector.stop();
  if (active === collector) active = null;
}

export function activeServerMetrics(): ServerMetricsCollector | null {
  return active;
}

export function recordRunEventCommitted(emittedAt: string | null | undefined, committedAtMs: number): void {
  if (!active || !emittedAt) return;
  const emitted = Date.parse(emittedAt);
  if (Number.isFinite(emitted)) active.recordRunEventLatenessMs(committedAtMs - emitted);
}

export function recordMissedLeaseRenewal(): void {
  active?.recordMissedLeaseRenewal();
}

const arrivedAt = Symbol("serverMetricsArrivedAt");
type TimedRequest = { [arrivedAt]?: number };

export function serverMetricsArrival(): RequestHandler {
  return (req, _res, next) => {
    (req as TimedRequest)[arrivedAt] = performance.now();
    next();
  };
}

export function serverMetricsAgentPreHandler(collector: ServerMetricsCollector): RequestHandler {
  return (req, _res, next) => {
    const started = (req as TimedRequest)[arrivedAt];
    if (started !== undefined && req.actor?.type === "agent") collector.recordAgentApiPreHandlerMs(performance.now() - started);
    next();
  };
}
