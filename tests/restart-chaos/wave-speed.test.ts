import { describe, expect, it } from "vitest";
import type { BaselineRun } from "./ttft-baseline-stats.js";
import type { ChaosApi } from "./api.js";
import type { FaultReceipt } from "./types.js";
import { bootWithoutProvisionMs, breachesOf, budgetFor, collectWaveSpeed, faultBeforeFirstActivity, faultRuns, firstActivityMs, gradeWaveSpeed, outageWindows, speedMarkdown, traceStartMs, withoutOutage } from "./wave-speed.js";
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
    expect(slow.rows.find(row => row.metric === "time_to_first_activity")?.breaches).toEqual(["p50", "p95"]);
    expect(slow.rows.find(row => row.metric === "ttft")).toMatchObject({ budget: null, breaches: [] });
    expect(slow).toMatchObject({ breaches: 4, singleRunBreaches: 2, runBudgetExceeded: 1 });
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
    expect(firstActivityMs(run("b", "codex", 7_000))).toBe(7_000);
    const speed = gradeWaveSpeed("local", [withActivity], [], 0);
    expect(speed.rows.find(row => row.metric === "time_to_first_activity")).toMatchObject({ breaches: [], measured: { p50: 5_000 } });
    expect(speed.rows.find(row => row.metric === "ttft")).toMatchObject({ budget: null, measured: { p50: 36_000 } });
  });

  it("measures restart recovery from ready to the run's next provider event", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "turn.started", createdAt: new Date(10_000 + 30_000).toISOString() }] };
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K1", readyAt: 10_000, runIds: ["r"] }], 0);
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ adapter: "claude", breaches: ["p50", "p95"] });
  });

  it("removes a later outage from restart recovery", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "turn.started", createdAt: new Date(10_000 + 302_000).toISOString() }] };
    const windows = outageWindows([{ startedAt: 12_000, readyAt: 312_000 } as FaultReceipt]);
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K1", readyAt: 10_000, runIds: ["r"] }], 0, [],
      { adjusted: 0, removedMs: 0, windows });
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ measured: { p50: 2_000 }, breaches: [] });
  });

  it("has no budget for remote environments or unbudgeted adapters", () => {
    expect(budgetFor("daytona", "codex", "ttft", "cold")).toBeNull();
    expect(budgetFor("local", "unknown", "ttft", "cold")).toBeNull();
    expect(breachesOf({ n: 1, p50: 99_000, p95: 99_000, max: 99_000 }, null)).toEqual([]);
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
      .toEqual([{ kind: "K2", readyAt: 2_000, runIds: ["live", "during"] }]);
  });
});
