import { describe, expect, it } from "vitest";
import type { BaselineRun } from "./ttft-baseline-stats.js";
import type { ChaosApi } from "./api.js";
import type { FaultReceipt } from "./types.js";
import { bootWithoutProvisionMs, breachesOf, budgetFor, collectWaveSpeed, faultBeforeFirstActivity, faultRuns, firstActivityMs, gradeWaveSpeed, outageFreeClock, outageWindows, speedMarkdown, storageFaultWindows, traceStartMs, withoutOutage } from "./wave-speed.js";
import { runMetrics } from "./ttft-baseline-stats.js";

const span = (name: string, startOffsetMs: number, durationMs: number, extra: Record<string, unknown> = {}) =>
  ({ eventType: "run.performance.span", createdAt: "2026-11-08T00:00:00.000Z", payload: { span: name, startOffsetMs, durationMs, ...extra } });

const run = (runId: string, adapter: string, ttftMs: number, extra: BaselineRun["events"] = []): BaselineRun => ({
  runId, adapter, environment: "local", phase: "cold",
  events: [span("task.time_to_first_token", 0, ttftMs), span("heartbeat.queue", 0, 100), span("runner.turn.submit", 100, 900), ...extra],
});

describe("wave speed grade", () => {
  it("judges aggregate TTFT and boot against the local budgets and counts single-run breaches", () => {
    const fast = gradeWaveSpeed("local", [run("a", "codex", 4_000), run("b", "codex", 5_000)], [], 0);
    expect(fast.breaches).toBe(0);
    expect(fast.rows.find(row => row.metric === "time_to_first_activity")).toMatchObject({ adapter: "codex", start: "cold", breaches: [] });

    const slow = gradeWaveSpeed("local", [run("a", "codex", 40_000), run("b", "codex", 40_000,
      [{ eventType: "run.performance.budget_exceeded", createdAt: "2026-11-08T00:00:00.000Z", payload: {} }])], [], 1);
    expect(slow.rows.find(row => row.metric === "time_to_first_activity")?.breaches).toEqual([]);
    expect(slow.rows.find(row => row.metric === "ttft")).toMatchObject({ budget: null, breaches: [] });
    expect(slow).toMatchObject({ breaches: 2, singleRunBreaches: 2, runBudgetExceeded: 1 });
    const slowFive = gradeWaveSpeed("local", ["a", "b", "c", "d", "e"].map(id => run(id, "codex", 40_000)), [], 0);
    expect(slowFive.rows.find(row => row.metric === "time_to_first_activity")?.breaches).toEqual(["p50", "p95"]);
    expect(slowFive).toMatchObject({ breaches: 7, singleRunBreaches: 5 });
    const heldButFast = gradeWaveSpeed("local", [run("c", "codex", 4_000,
      [{ eventType: "run.performance.budget_exceeded", createdAt: "2026-11-08T00:00:00.000Z", payload: {} }])], [], 1);
    expect(heldButFast).toMatchObject({ breaches: 0, singleRunBreaches: 0, runBudgetExceeded: 1 });
    expect(speedMarkdown(slow)).toContain("| codex | time_to_first_activity | cold | 2 |");
  });

  it("judges time to first agent activity when the run logs it, net of the wait behind a live turn", () => {
    const withActivity: BaselineRun = { runId: "a", adapter: "codex", environment: "local", phase: "cold",
      events: [span("comment.to_run_created", 0, 4_000), span("heartbeat.queue", 4_000, 100), span("runner.turn.submit", 4_100, 900),
        span("task.time_to_first_agent_activity", 0, 9_000, { anchor: "comment" }), span("task.time_to_first_token", 0, 40_000, { anchor: "comment" })] };
    expect(firstActivityMs(withActivity)).toBe(5_000);
    // Per-run detail splits Paperclip's boot from the provider's wait for first activity.
    expect(gradeWaveSpeed("local", [withActivity], [], 0).runs).toEqual([{ runId: "a", adapter: "codex", start: "cold",
      firstActivityMs: 5_000, bootMs: 900, queueMs: 100, providerFirstActivityMs: 4_000,
      preTurnSteps: { "heartbeat.queue": 100, "runner.turn.submit": 900 }, breach: false }]);
    expect(firstActivityMs(run("b", "codex", 7_000))).toBe(7_000);
    const speed = gradeWaveSpeed("local", [withActivity], [], 0);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity")).toMatchObject({ breaches: [], measured: { p50: 5_000 } });
    expect(speed.rows.find(row => row.metric === "ttft")).toMatchObject({ budget: null, measured: { p50: 36_000 } });
  });

  it("measures restart recovery from ready to the run's next provider event", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "turn.started", createdAt: new Date(10_000 + 30_000).toISOString() }] };
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K1", readyAt: 10_000, runIds: ["r"] }], 0);
    // Nothing reloaded, so the whole latency is Paperclip's share and is judged.
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ adapter: "claude", breaches: [] });
    expect(speed).toMatchObject({ singleRunBreaches: 1, breaches: 1 });
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ budget: null, breaches: [], measured: { p50: 30_000 } });
  });

  it("judges Paperclip's share of a recovery and only reports the provider's session load", () => {
    const loadEnd = 10_000 + 1_500 + 9_000;
    const recovered: BaselineRun = { runId: "r", adapter: "codex", environment: "local", phase: "cold", events: [
      { eventType: "run.performance.span", createdAt: new Date(100).toISOString(), payload: { span: "heartbeat.queue", startOffsetMs: 0, durationMs: 100 } },
      { eventType: "run.performance.span", createdAt: new Date(loadEnd).toISOString(),
        payload: { span: "provider.session.load", startOffsetMs: 11_500, durationMs: 9_000 } },
      { eventType: "session.resumed", createdAt: new Date(loadEnd + 300).toISOString() }] };
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K2", readyAt: 10_000, runIds: ["r"] }], 0);
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ measured: { p50: 1_500 }, breaches: [] });
    expect(speed.rows.find(row => row.metric === "restart_provider_load")).toMatchObject({ measured: { p50: 9_300 }, budget: null, breaches: [] });
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ measured: { p50: 10_800 }, budget: null });
    expect(speed.breaches).toBe(0);
  });

  it("does not grade a recovery that a back-to-back fault interrupted before its next provider event", () => {
    // f1 is ready at 10 s; f2 hits 0.4 s later and is ready at 30 s; the run resumes 1.5 s after f2.
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "session.resumed", createdAt: new Date(31_500).toISOString() }] };
    const faults = [{ kind: "K4", startedAt: 1_000, readyAt: 10_000, runIds: ["r"] },
      { kind: "K6", startedAt: 10_400, readyAt: 30_000, runIds: ["r"] }];
    const windows = outageWindows(faults.map(fault => ({ startedAt: fault.startedAt, readyAt: fault.readyAt }) as FaultReceipt));
    const speed = gradeWaveSpeed("local", [recovered], faults, 0, [], { adjusted: 0, removedMs: 0, windows });
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ measured: { n: 1, p50: 1_500 }, breaches: [] });
    expect(speed.recoveryInterruptedByFault).toBe(1);
    expect(speed.recoveryWithoutProviderEvent).toBe(0);
  });

  it("removes a later outage from restart recovery", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "turn.started", createdAt: new Date(10_000 + 302_000).toISOString() }] };
    const windows = outageWindows([{ startedAt: 12_000, readyAt: 312_000 } as FaultReceipt]);
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K1", readyAt: 10_000, runIds: ["r"] }], 0, [],
      { adjusted: 0, removedMs: 0, windows });
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ measured: { p50: 2_000 }, breaches: [] });
  });

  it("removes storage fault window time from restart recovery and reports it apart from restart outage", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "session.resumed", createdAt: new Date(10_000 + 62_000).toISOString() }] };
    const restart = outageWindows([{ startedAt: 1_000, readyAt: 10_000 } as FaultReceipt]);
    const storage = storageFaultWindows([{ kind: "ST5R", startedAt: 5_000, endedAt: 70_000, rules: [] },
      { kind: "ST1", startedAt: 90_000, endedAt: null, rules: [] }], 95_000);
    expect(storage).toEqual([{ startedAt: 5_000, readyAt: 70_000 }, { startedAt: 90_000, readyAt: 95_000 }]);
    const faults = [{ kind: "K1", startedAt: 1_000, readyAt: 10_000, runIds: ["r"] }];
    const unadjusted = gradeWaveSpeed("local", [recovered], faults, 0, [], { adjusted: 0, removedMs: 0, windows: restart });
    expect(unadjusted).toMatchObject({ singleRunBreaches: 1, breaches: 1 });
    const speed = gradeWaveSpeed("local", [recovered], faults, 0, [], { adjusted: 0, removedMs: 0, windows: restart, storageWindows: storage });
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ measured: { p50: 2_000 }, breaches: [] });
    expect(speed).toMatchObject({ breaches: 0, storageFaultWindows: 2, storageFaultRemovedMs: 60_000 });
    expect(speedMarkdown(speed)).toContain("Storage fault time removed: 60.0 s across 2 windows");
  });

  it("removes overlapping restart and storage fault time once", () => {
    const clock = outageFreeClock([{ startedAt: 10_000, readyAt: 50_000 }, { startedAt: 30_000, readyAt: 70_000 }]);
    expect(clock(100_000)).toBe(40_000);
    expect(clock(40_000)).toBe(10_000);
  });

  it("removes storage fault time from spans in a collected wave and counts it apart", async () => {
    const run = traced(1_000_000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 70_000]]);
    const api = { get: async (route: string) => route.includes("workspace-operations") ? []
      : run.events.map((event, seq) => ({ ...event, seq })) } as unknown as ChaosApi;
    const sample = { runs: [{ id: "t", status: "succeeded", createdAt: new Date(1_000_000).toISOString(),
      finishedAt: new Date(1_080_000).toISOString() }] } as never;
    const speed = await collectWaveSpeed(api, "local", [{ issueId: "i", adapter: "claude", samples: [sample] }], [],
      [{ kind: "ST1", startedAt: 1_005_000, endedAt: 1_065_000, rules: [] }]);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity")).toMatchObject({ measured: { p50: 10_000 } });
    expect(speed).toMatchObject({ storageFaultWindows: 1, storageFaultRemovedMs: 60_000, outageRemovedMs: 0, outageAdjustedSpans: 0 });
  });

  it("has no budget for remote environments or unbudgeted adapters", () => {
    expect(budgetFor("daytona", "codex", "ttft", "cold")).toBeNull();
    expect(budgetFor("local", "unknown", "ttft", "cold")).toBeNull();
    expect(breachesOf({ n: 1, p50: 99_000, p95: 99_000, max: 99_000 }, null)).toEqual([]);
  });

  it("judges aggregate p50 and p95 only from five samples and reports smaller rows as an insufficient sample", () => {
    const budget = { p50Ms: 1_000, p95Ms: 2_000 };
    expect(breachesOf({ n: 4, p50: 9_000, p95: 9_000, max: 9_000 }, budget)).toEqual([]);
    expect(breachesOf({ n: 5, p50: 9_000, p95: 9_000, max: 9_000 }, budget)).toEqual(["p50", "p95"]);
    const speed = gradeWaveSpeed("local", [], [], 0);
    speed.rows.push({ adapter: "codex", metric: "agent_boot", start: "cold", measured: { n: 2, p50: 9_000, p95: 9_000, max: 9_000 },
      budget, breaches: [] });
    expect(speedMarkdown(speed)).toContain("| insufficient sample (n < 5) |");
  });

  it("fails a run's speed read instead of paging forever when a full page has no seq", async () => {
    let reads = 0;
    const api = { get: async () => { reads += 1; return Array.from({ length: 500 }, () => ({ eventType: "x", createdAt: new Date(0).toISOString() })); } } as unknown as ChaosApi;
    const speed = await collectWaveSpeed(api, "local", [{ issueId: "i", adapter: "codex", samples: [{ runs: [{ id: "r", status: "succeeded",
      createdAt: new Date(0).toISOString(), finishedAt: null }] }] as never }], []);
    expect(speed.errors).toEqual([expect.stringMatching(/^r: .*seq/)]);
    expect(reads).toBe(3);
  });

  const traced = (trace: number, spans: Array<[string, number, number]>): BaselineRun => ({
    runId: "t", adapter: "claude", environment: "local", phase: "cold",
    events: spans.map(([name, offset, duration]) => ({ eventType: "run.performance.span",
      createdAt: new Date(trace + offset + duration).toISOString(), payload: { span: name, startOffsetMs: offset, durationMs: duration } })),
  });

  it("treats a run that a fault hit before its first activity as a restart, not a cold start", async () => {
    const hit = traced(1_000_000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 30_000]]);
    expect(faultBeforeFirstActivity(hit, [{ startedAt: 1_010_000, readyAt: 1_012_000 }], 1_000_000)).toBe(true);
    expect(faultBeforeFirstActivity(hit, [{ startedAt: 1_040_000, readyAt: 1_041_000 }, { startedAt: 980_000, readyAt: 990_000 }], 1_000_000)).toBe(false);
    expect(faultBeforeFirstActivity(hit, [{ startedAt: 1_005_000, readyAt: 1_006_000 }], 1_008_000)).toBe(false);
    expect(faultBeforeFirstActivity(hit, [{ startedAt: 996_000, readyAt: 1_025_000 }], 1_000_000)).toBe(true);
    const clean = traced(2_000_000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 4_000]]);
    const events: Record<string, object[]> = { hit: [...hit.events, { eventType: "turn.started", createdAt: new Date(1_013_000).toISOString() }],
      clean: clean.events };
    const api = { get: async (route: string) => (route.includes("/hit/") ? events.hit : events.clean)
      .map((event: object, seq: number) => ({ ...event, seq })) } as unknown as ChaosApi;
    const sample = (id: string, createdAt: number) => ({ runs: [{ id, status: "succeeded", createdAt: new Date(createdAt).toISOString(),
      finishedAt: new Date(createdAt + 60_000).toISOString() }] }) as never;
    const fault = { kind: "K1", startedAt: 1_010_000, readyAt: 1_012_000 } as FaultReceipt;
    const speed = await collectWaveSpeed(api, "local", [{ issueId: "i1", adapter: "claude", samples: [sample("hit", 1_000_000)] },
      { issueId: "i2", adapter: "claude", samples: [sample("clean", 2_000_000)] }], [fault]);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity" && row.start === "cold")).toMatchObject({ measured: { n: 1, p50: 4_000 } });
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ adapter: "claude", measured: { n: 1 } });
  });

  it("reports first-time workspace provisioning on its own row and keeps it out of agent boot", () => {
    const provisioned: BaselineRun = { runId: "p", adapter: "claude", environment: "local", phase: "cold", workspaceCreated: true,
      events: [span("heartbeat.queue", 0, 100), span("heartbeat.prepare.workspace_provision", 200, 22_000),
        span("runner.turn.submit", 22_500, 3_000), span("task.time_to_first_agent_activity", 0, 27_000)] };
    expect(bootWithoutProvisionMs(provisioned)).toBe(25_400 - 22_000);
    expect(bootWithoutProvisionMs({ ...provisioned, workspaceCreated: false })).toBe(25_400);
    const speed = gradeWaveSpeed("local", [provisioned], [], 0);
    expect(speed.rows.find(row => row.metric === "agent_boot")).toMatchObject({ measured: { p50: 3_400 }, breaches: [] });
    expect(speed.rows.find(row => row.metric === "workspace_provision")).toMatchObject({ budget: null, measured: { n: 1, p50: 22_000 } });
    expect(gradeWaveSpeed("local", [run("q", "claude", 4_000)], [], 0).rows.some(row => row.metric === "workspace_provision")).toBe(false);
  });

  it("grades a retry successor as restart and reads provisioning creation from workspace operations", async () => {
    const created = traced(3_000_000, [["heartbeat.queue", 0, 100], ["heartbeat.prepare.workspace_provision", 200, 20_000],
      ["runner.turn.submit", 20_300, 2_000], ["task.time_to_first_agent_activity", 0, 23_000]]);
    const successor = traced(4_000_000, [["heartbeat.queue", 0, 30_000], ["task.time_to_first_agent_activity", 0, 35_000]]);
    const overload = traced(6_000_000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 5_000]]);
    const interrupted = traced(3_500_000, [["heartbeat.queue", 0, 100]]);
    const events: Record<string, object[]> = { created: created.events, successor: successor.events, overload: overload.events, interrupted: interrupted.events };
    const idOf = (route: string) => route.split("/")[3]!;
    const api = { get: async (route: string) => route.endsWith("/workspace-operations")
      ? [{ phase: "workspace_provision", metadata: { created: idOf(route) === "created" } }]
      : events[idOf(route)]!.map((event: object, seq: number) => ({ ...event, seq })) } as unknown as ChaosApi;
    const sampleRun = (id: string, createdAt: number, finishedAt: number, retryOfRunId: string | null) => ({ id, status: "succeeded", retryOfRunId,
      createdAt: new Date(createdAt).toISOString(), finishedAt: new Date(finishedAt).toISOString() });
    const fault = { kind: "K1", startedAt: 3_550_000, readyAt: 3_560_000 } as FaultReceipt;
    const speed = await collectWaveSpeed(api, "local", [
      { issueId: "i1", adapter: "claude", samples: [{ runs: [sampleRun("created", 3_000_000, 3_060_000, null), sampleRun("overload", 6_000_000, 6_060_000, "provider-overloaded")] }] },
      { issueId: "i2", adapter: "claude", samples: [{ runs: [sampleRun("interrupted", 3_500_000, 3_555_000, null), sampleRun("successor", 4_000_000, 4_060_000, "interrupted")] }] },
    ] as never, [fault]);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity" && row.start === "cold")).toMatchObject({ measured: { n: 1, p50: 23_000 } });
    expect(speed.rows.find(row => row.metric === "time_to_first_activity" && row.start === "warm")).toMatchObject({ measured: { n: 1, p50: 5_000 } });
    expect(speed.recoveryWithoutProviderEvent).toBe(1);
    expect(speed.rows.find(row => row.metric === "workspace_provision")).toMatchObject({ measured: { n: 1, p50: 20_000 } });
    expect(speed.rows.find(row => row.metric === "agent_boot" && row.start === "cold")).toMatchObject({ measured: { p50: 2_200 } });
  });

  it("records an unread workspace-operations list as a speed collection error", async () => {
    const run = traced(7_000_000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 4_000]]);
    const api = { get: async (route: string) => {
      if (route.endsWith("/workspace-operations")) throw new Error("timeout");
      return run.events.map((event, seq) => ({ ...event, seq }));
    } } as unknown as ChaosApi;
    const speed = await collectWaveSpeed(api, "local", [{ issueId: "i", adapter: "claude", samples: [{ runs: [{ id: "r", status: "succeeded",
      retryOfRunId: null, createdAt: new Date(7_000_000).toISOString(), finishedAt: new Date(7_060_000).toISOString() }] }] }] as never, []);
    expect(speed.errors.join(" ")).toMatch(/workspace operations unread: timeout/);
  }, 15_000);

  it("finds the trace start from when its spans were written, never later than it", () => {
    expect(traceStartMs(traced(1_000_000, [["a", 0, 5_000], ["b", 2_000, 1_000]]))).toBe(1_000_000);
    const late = traced(1_000_000, [["a", 0, 5_000]]);
    late.events.push({ ...late.events[0]!, createdAt: new Date(1_090_000).toISOString() });
    expect(traceStartMs(late)).toBe(1_000_000);
  });

  it("removes outage time from a held TTFT span", () => {
    const trace = 1_000_000;
    const windows = outageWindows([{ startedAt: trace + 10_000, readyAt: trace + 260_000 } as FaultReceipt,
      { startedAt: 0, readyAt: null } as unknown as FaultReceipt]);
    const trimmed = withoutOutage(traced(trace, [["task.time_to_first_token", 0, 300_000]]), windows);
    expect(trimmed).toMatchObject({ adjusted: 1, removedMs: 250_000, anchored: true });
    const speed = gradeWaveSpeed("local", [trimmed.run], [], 0, [], trimmed);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity")?.measured.p50).toBe(50_000);
    expect(speedMarkdown(speed)).toContain("Outage time removed from 1 spans: 250.0 s");
  });

  it("never moves a hold inside the queue into agent boot", () => {
    const trace = 1_000_000;
    const windows = [{ startedAt: trace + 10_000, readyAt: trace + 160_000 }];
    const run = traced(trace, [["heartbeat.queue", 0, 200_000], ["runner.turn.submit", 200_000, 1_000]]);
    expect(runMetrics(run).bootMs).toBe(1_000);
    expect(runMetrics(withoutOutage(run, windows).run).bootMs).toBe(1_000);
  });

  it("attributes each fault to the runs it crossed and the runs created during its outage", () => {
    const fault = { kind: "K2", startedAt: 1_000, readyAt: 2_000 } as FaultReceipt;
    expect(faultRuns([fault], [{ id: "before", createdAt: 0, finishedAt: 500 }, { id: "live", createdAt: 0, finishedAt: null },
      { id: "during", createdAt: 1_500, finishedAt: null }, { id: "after", createdAt: 2_500, finishedAt: null }]))
      .toEqual([{ kind: "K2", readyAt: 2_000, startedAt: 1_000, runIds: ["live", "during"] }]);
  });
});

// Receipts from wave w-20261110T115048-s302 (faults.json), trimmed to what the speed grade reads.
const msReceipt = (kind: "MS1" | "MS2" | "MS3", times: { startedAt: number; readyAt: number; healthyAt?: number },
  multi: Partial<NonNullable<FaultReceipt["multiServer"]>>): FaultReceipt => ({
  faultId: "f", kind, requestedBy: "t", signal: "none", holdMs: 0, requestedAt: times.startedAt, startedAt: times.startedAt,
  stoppedAt: null, restartedAt: null, healthyAt: times.healthyAt ?? null, readyAt: times.readyAt, phases: [],
  serverLogOffsetAtStart: 0, serverLogOffsetAtReady: null, error: null,
  multiServer: { kind, secondary: null, steps: [], ...multi },
});
const S302_MS2 = msReceipt("MS2", { startedAt: 1794311530823, readyAt: 1794311678390, healthyAt: 1794311647900 },
  { primaryFreeze: { kind: "TM2", frozenAt: 1794311537833, thawedAt: 1794311647835 } });
const S302_MS3 = msReceipt("MS3", { startedAt: 1794311934901, readyAt: 1794311992580 },
  { secondary: { pid: 79488, port: 54688, spawnedAt: 1794311934902, readyAt: 1794311943511, stoppedAt: 1794311992577 }, primaryRestart: { stoppedAt: 1794311943796, restartedAt: 1794311943796, readyAt: 1794311949160, replacementPid: 80430 } });
const MS1 = msReceipt("MS1", { startedAt: 1_000, readyAt: 120_000 }, {});

describe("two-server faults in the speed grade", () => {
  const live = [{ id: "r", createdAt: 0, finishedAt: null }];

  it("takes no restart-recovery sample from MS1 or MS2: the primary never restarted", () => {
    expect(faultRuns([MS1, S302_MS2], live)).toEqual([]);
    // An MS2 primary that exited after the thaw and was replaced did restart: its replacement's health anchors it.
    const replaced = { ...S302_MS2, multiServer: { ...S302_MS2.multiServer!, primaryFreeze: { kind: "TM2" as const,
      frozenAt: 1794311537833, thawedAt: 1794311647835, serverExitedAfterThaw: { code: 1, signal: null } } } };
    expect(faultRuns([replaced], live)).toEqual([{ kind: "MS2", readyAt: 1794311647900, startedAt: 1794311530823, runIds: ["r"] }]);
  });

  it("anchors an MS3 sample when the primary's replacement is ready, not when the second server stops", () => {
    expect(faultRuns([S302_MS3], live)).toEqual([{ kind: "MS3", readyAt: 1794311949160, startedAt: 1794311934901, runIds: ["r"] }]);
  });

  it("removes only the time the primary could not serve", () => {
    expect(outageWindows([MS1, S302_MS2, S302_MS3])).toEqual([
      { startedAt: 1794311537833, readyAt: 1794311647835 },
      // From the second server's readiness, when the primary was told to stop; it served until then.
      { startedAt: 1794311943511, readyAt: 1794311949160 },
    ]);
  });

  const traced = (runId: string, trace: number, spans: Array<[string, number, number]>, extra: Record<string, unknown> = {}) => ({
    events: spans.map(([name, offset, duration], seq) => ({ seq, eventType: "run.performance.span",
      createdAt: new Date(trace + offset + duration).toISOString(), payload: { span: name, startOffsetMs: offset, durationMs: duration } })),
    sample: { id: runId, status: "succeeded", createdAt: new Date(trace).toISOString(), finishedAt: new Date(trace + 200_000).toISOString(), ...extra },
  });
  const collect = (runs: Array<ReturnType<typeof traced>>, faults: FaultReceipt[]) => {
    const byId = new Map(runs.map(entry => [entry.sample.id, entry.events]));
    const api = { get: async (route: string) => route.includes("workspace-operations") ? []
      : byId.get(route.split("/")[3]!.split("?")[0]!) ?? [] } as unknown as ChaosApi;
    return collectWaveSpeed(api, "local", [{ issueId: "i", adapter: "codex", samples: [{ runs: runs.map(entry => entry.sample) }] as never }], faults);
  };

  it("keeps a run an MS2 freeze hit before its first activity in its cold budget, with the freeze removed", async () => {
    // Created 1 s before the freeze; first activity 115 s later, 110.002 s of it frozen: 4.998 s of real start.
    const hit = traced("r1", 1794311536833, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 115_000]]);
    const speed = await collect([hit], [S302_MS2]);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity" && row.start === "cold")).toMatchObject({ measured: { n: 1, p50: 4_998 } });
    expect(speed.rows.filter(row => row.start === "restart").every(row => row.measured.n === 0)).toBe(true);
    expect(speed.singleRunBreaches).toBe(0);
  });

  it("grades a retry of a run that failed after an MS2 freeze as an ordinary warm run", async () => {
    // The primary never restarted, so the retry starts on a serving server and keeps its warm budget.
    const failed = traced("r1", 1794311500000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 4_000]],
      { status: "failed" });
    const retry = traced("r2", 1794311700000, [["heartbeat.queue", 0, 100], ["task.time_to_first_agent_activity", 0, 30_000]],
      { retryOfRunId: "r1" });
    const speed = await collect([failed, retry], [S302_MS2]);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity" && row.start === "warm")).toMatchObject({ measured: { n: 1, p50: 30_000 } });
  });

  it("grades s302's MS3 shape as a fast recovery, and MS2 not at all", () => {
    // The run resumes 1.5 s after the replacement is ready; its next provider event after the second server
    // stopped (s302: about 11 s later, while bench.sh ran quietly) is not a recovery.
    const resumedAt = 1794311949160 + 1_500;
    const recovered: BaselineRun = { runId: "r", adapter: "codex", environment: "local", phase: "cold", events: [
      { eventType: "session.resumed", createdAt: new Date(resumedAt).toISOString() },
      { eventType: "tool.execution.progressed", createdAt: new Date(1794311992580 + 11_000).toISOString() }] };
    const faults = [S302_MS2, S302_MS3];
    const speed = gradeWaveSpeed("local", [recovered], faultRuns(faults, live), 0, [],
      { adjusted: 0, removedMs: 0, windows: outageWindows(faults) });
    expect(speed.rows.find(row => row.metric === "restart_recovery_control_plane")).toMatchObject({ measured: { n: 1, p50: 1_500 }, breaches: [] });
    expect(speed).toMatchObject({ singleRunBreaches: 0, breaches: 0 });
  });
});
