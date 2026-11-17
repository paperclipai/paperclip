import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EventLoopUtilization } from "node:perf_hooks";
import {
  activeServerMetrics,
  recordMissedLeaseRenewal,
  recordRunEventCommitted,
  ServerMetricsCollector,
  serverMetricsEnabledFromEnv,
  startServerMetrics,
  stopServerMetrics,
  type ServerMetricsProbes,
} from "../services/server-metrics.js";

const FIXTURE = fileURLToPath(new URL("../../../scripts/scale-ramp/server-metrics.fixture.json", import.meta.url));

function fakeProbes() {
  const state = { now: 0, wall: Date.parse("2026-11-14T12:00:00.000Z"), idle: 0, active: 0, cpuMicros: 0, mainMs: 0, statements: 0, uptime: 100 };
  const elu = (): EventLoopUtilization => ({ idle: state.idle, active: state.active, utilization: 0 });
  const probes: ServerMetricsProbes = {
    now: () => state.now,
    wallNow: () => state.wall,
    eventLoopUtilization: (current?: EventLoopUtilization, previous?: EventLoopUtilization) => {
      if (!current) return elu();
      const idle = current.idle - (previous?.idle ?? 0);
      const active = current.active - (previous?.active ?? 0);
      return { idle, active, utilization: idle + active > 0 ? active / (idle + active) : 0 };
    },
    processCpuMicros: () => state.cpuMicros,
    mainThreadCpuMs: () => state.mainMs,
    statementCount: () => state.statements,
    uptimeSec: () => state.uptime,
    dedicatedConnections: () => ({ limit: 24, inUse: 3, peakInUse: 9, waiting: 1, queued: 12, overLimit: 0, nestedOverLimit: 0 }),
  };
  const advance = (ms: number, load: { busy: number; cpu?: number; statementsPerSecond?: number }) => {
    state.now += ms;
    state.wall += ms;
    state.uptime += ms / 1000;
    state.active += ms * load.busy;
    state.idle += ms * (1 - load.busy);
    state.mainMs += ms * load.busy;
    state.cpuMicros += ms * (load.cpu ?? load.busy) * 1000;
    state.statements += (ms / 1000) * (load.statementsPerSecond ?? 0);
  };
  return { probes, advance };
}

const collectors: ServerMetricsCollector[] = [];
function collector(probes: ServerMetricsProbes) {
  const created = new ServerMetricsCollector({ probes, bucketMs: 10_000, buckets: 6, buildRevision: "0123456789abcdef0123456789abcdef01234567",
    monitorEventLoop: false, processId: "a1b2c3d4e5f60718" });
  collectors.push(created);
  return created;
}

afterEach(() => {
  for (const created of collectors.splice(0)) created.stop();
  const active = activeServerMetrics();
  if (active) stopServerMetrics(active);
});

describe("server metrics collector", () => {
  it("reports rates and utilization over the sliding window, dropping buckets older than the window", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0.9, statementsPerSecond: 500 });
      metrics.rotate();
    }
    const busy = metrics.snapshot();
    expect(busy.windowMs).toBe(50_000);
    expect(busy.eventLoopUtilization).toBeCloseTo(0.9, 4);
    expect(busy.mainThreadCpu).toBeCloseTo(0.9, 4);
    expect(busy.statementsPerSecond).toBeCloseTo(500, 2);

    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0.1, statementsPerSecond: 20 });
      metrics.rotate();
    }
    const quiet = metrics.snapshot();
    expect(quiet.eventLoopUtilization).toBeCloseTo(0.1, 4);
    expect(quiet.statementsPerSecond).toBeCloseTo(20, 2);
  });

  it("expires buckets by elapsed time when the rotation timer fires late", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0.1, statementsPerSecond: 10 });
      metrics.rotate();
    }
    metrics.recordRunEventLatenessMs(5_000);
    advance(35_000, { busy: 0.5, statementsPerSecond: 100 });
    metrics.rotate();
    const late = metrics.snapshot();
    expect(late.windowMs).toBe(55_000);
    expect(late.statementsPerSecond).toBeCloseTo((20 * 10 + 35 * 100) / 55, 2);
    expect(late.runEventLatenessSamples).toBe(1);
  });

  it("reports the real window after a block longer than the window, and the block shows in it", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0.1 });
      metrics.rotate();
    }
    metrics.recordRunEventLatenessMs(20);
    advance(300_000, { busy: 1 });
    metrics.rotate();
    const blocked = metrics.snapshot();
    expect(blocked.windowMs).toBe(300_000);
    expect(blocked.eventLoopUtilization).toBeCloseTo(1, 4);
    expect(blocked.runEventLatenessSamples).toBe(1);
    advance(10_000, { busy: 0.2 });
    metrics.rotate();
    expect(metrics.snapshot()).toMatchObject({ windowMs: 10_000, runEventLatenessSamples: 0 });
    for (let bucket = 0; bucket < 5; bucket += 1) {
      advance(10_000, { busy: 0.2 });
      metrics.rotate();
    }
    const recovered = metrics.snapshot();
    expect(recovered.windowMs).toBe(50_000);
    expect(recovered.eventLoopUtilization).toBeCloseTo(0.2, 4);
  });

  it("reports latency percentiles only for the window and absent when nothing was recorded", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    expect(metrics.snapshot()).toMatchObject({ runEventLatenessP99Ms: null, runEventLatenessSamples: 0,
      agentApiPreHandlerP99Ms: null, agentApiPreHandlerSamples: 0 });
    for (let index = 0; index < 100; index += 1) metrics.recordRunEventLatenessMs(index < 98 ? 20 : 2_000);
    metrics.recordAgentApiPreHandlerMs(3.5);
    const recorded = metrics.snapshot();
    expect(recorded.runEventLatenessSamples).toBe(100);
    expect(recorded.runEventLatenessP99Ms).toBeGreaterThan(1_900);
    expect(recorded.agentApiPreHandlerP99Ms).toBeCloseTo(3.5, 1);
    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0 });
      metrics.rotate();
    }
    expect(metrics.snapshot()).toMatchObject({ runEventLatenessP99Ms: null, runEventLatenessSamples: 0, agentApiPreHandlerSamples: 0 });
  });

  it("counts missed lease renewals since start and never resets them with the window", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    metrics.recordMissedLeaseRenewal();
    metrics.recordMissedLeaseRenewal();
    for (let bucket = 0; bucket < 8; bucket += 1) {
      advance(10_000, { busy: 0 });
      metrics.rotate();
    }
    expect(metrics.snapshot().leaseRenewalsMissed).toBe(2);
  });

  it("records into the process collector only while it runs", () => {
    recordRunEventCommitted(new Date(Date.now() - 500).toISOString(), Date.now());
    recordMissedLeaseRenewal();
    expect(activeServerMetrics()).toBeNull();
    const started = startServerMetrics();
    expect(startServerMetrics()).toBe(started);
    recordRunEventCommitted(new Date(Date.now() - 500).toISOString(), Date.now());
    recordRunEventCommitted("not a time", Date.now());
    recordMissedLeaseRenewal();
    const snapshot = started.snapshot();
    expect(snapshot.runEventLatenessSamples).toBe(1);
    expect(snapshot.runEventLatenessP99Ms).toBeGreaterThanOrEqual(450);
    expect(snapshot.leaseRenewalsMissed).toBe(1);
    stopServerMetrics(started);
    expect(activeServerMetrics()).toBeNull();
  });

  it("reads the kill switch strictly and defaults it off", () => {
    expect(serverMetricsEnabledFromEnv({})).toBe(false);
    expect(serverMetricsEnabledFromEnv({ PAPERCLIP_SERVER_METRICS: "true" })).toBe(true);
    expect(serverMetricsEnabledFromEnv({ PAPERCLIP_SERVER_METRICS: "0" })).toBe(false);
    expect(() => serverMetricsEnabledFromEnv({ PAPERCLIP_SERVER_METRICS: "yes" })).toThrow(/PAPERCLIP_SERVER_METRICS/);
  });

  it("serializes exactly the fixture the scale-ramp harness parses", () => {
    const { probes, advance } = fakeProbes();
    const metrics = collector(probes);
    for (let bucket = 0; bucket < 6; bucket += 1) {
      advance(10_000, { busy: 0.42, cpu: 0.55, statementsPerSecond: 180 });
      metrics.rotate();
    }
    for (let index = 0; index < 50; index += 1) metrics.recordRunEventLatenessMs(120);
    for (let index = 0; index < 50; index += 1) metrics.recordAgentApiPreHandlerMs(15);
    metrics.recordMissedLeaseRenewal();
    const snapshot = JSON.parse(JSON.stringify(metrics.snapshot()));
    if (process.env.UPDATE_SERVER_METRICS_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`);
    expect(snapshot).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});
