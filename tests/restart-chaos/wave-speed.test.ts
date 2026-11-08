import { describe, expect, it } from "vitest";
import type { BaselineRun } from "./ttft-baseline-stats.js";
import type { FaultReceipt } from "./types.js";
import { breachesOf, budgetFor, faultRuns, gradeWaveSpeed, speedMarkdown } from "./wave-speed.js";

const span = (name: string, startOffsetMs: number, durationMs: number) =>
  ({ eventType: "run.performance.span", createdAt: "2026-11-08T00:00:00.000Z", payload: { span: name, startOffsetMs, durationMs } });

const run = (runId: string, adapter: string, ttftMs: number, extra: BaselineRun["events"] = []): BaselineRun => ({
  runId, adapter, environment: "local", phase: "cold",
  events: [span("task.time_to_first_token", 0, ttftMs), span("heartbeat.queue", 0, 100), span("runner.turn.submit", 100, 900), ...extra],
});

describe("wave speed grade", () => {
  it("judges aggregate TTFT and boot against the local budgets and counts single-run breaches", () => {
    const fast = gradeWaveSpeed("local", [run("a", "codex", 4_000), run("b", "codex", 5_000)], [], 0);
    expect(fast.breaches).toBe(0);
    expect(fast.rows.find(row => row.metric === "ttft")).toMatchObject({ adapter: "codex", start: "cold", breaches: [] });

    const slow = gradeWaveSpeed("local", [run("a", "codex", 40_000), run("b", "codex", 40_000,
      [{ eventType: "run.performance.budget_exceeded", createdAt: "2026-11-08T00:00:00.000Z", payload: {} }])], [], 1);
    expect(slow.rows.find(row => row.metric === "ttft")?.breaches).toEqual(["p50", "p95"]);
    expect(slow.breaches).toBe(3);
    expect(speedMarkdown(slow)).toContain("| codex | ttft | cold | 2 |");
  });

  it("measures restart recovery from ready to the run's next provider event", () => {
    const recovered: BaselineRun = { runId: "r", adapter: "claude", environment: "local", phase: "cold",
      events: [{ eventType: "turn.started", createdAt: new Date(10_000 + 30_000).toISOString() }] };
    const speed = gradeWaveSpeed("local", [recovered], [{ kind: "K1", readyAt: 10_000, runIds: ["r"] }], 0);
    expect(speed.rows.find(row => row.metric === "restart_recovery")).toMatchObject({ adapter: "claude", breaches: ["p50", "p95"] });
  });

  it("has no budget for remote environments or unbudgeted adapters", () => {
    expect(budgetFor("daytona", "codex", "ttft", "cold")).toBeNull();
    expect(budgetFor("local", "unknown", "ttft", "cold")).toBeNull();
    expect(breachesOf({ n: 1, p50: 99_000, p95: 99_000, max: 99_000 }, null)).toEqual([]);
  });

  it("attributes each fault to the runs it crossed", () => {
    const fault = { kind: "K2", startedAt: 1_000, readyAt: 2_000 } as FaultReceipt;
    expect(faultRuns([fault], [{ id: "before", createdAt: 0, finishedAt: 500 }, { id: "live", createdAt: 0, finishedAt: null },
      { id: "after", createdAt: 1_500, finishedAt: null }])).toEqual([{ kind: "K2", readyAt: 2_000, runIds: ["live"] }]);
  });
});
