import { describe, expect, it } from "vitest";
import {
  baselineRows, distribution, openShellExecutions, percentile, rankPreTurnSteps, recoverySamples, runMetrics, runWarmth,
  type BaselineEvent, type BaselineRun,
} from "./ttft-baseline-stats.js";

const at = (ms: number) => new Date(1_800_000_000_000 + ms).toISOString();
const span = (name: string, startOffsetMs: number, durationMs: number, extra: Record<string, unknown> = {}): BaselineEvent => ({
  eventType: "run.performance.span", createdAt: at(startOffsetMs + durationMs),
  payload: { span: name, parentSpan: "task.provider_session", startOffsetMs, durationMs, ...extra },
});
const reuse = (state: string): BaselineEvent => ({ eventType: "run.startup.reuse", createdAt: at(0),
  payload: { layer: "provider_session", state } });

function run(id: string, phase: BaselineRun["phase"], events: BaselineEvent[], adapter = "codex"): BaselineRun {
  return { runId: id, adapter, environment: "local", phase, events };
}

const coldRun = (id: string, scale = 1) => run(id, "cold", [
  reuse("fresh"),
  span("heartbeat.queue", 0, 100 * scale),
  span("heartbeat.prepare_before_environment", 100 * scale, 200 * scale),
  span("task.prepare", 100 * scale, 900 * scale),
  span("runner.process.launch", 400 * scale, 1_500 * scale),
  span("runner.turn.submit", 2_000 * scale, 500 * scale),
  span("provider.time_to_first_agent_event", 2_600 * scale, 3_000 * scale),
  span("task.time_to_first_token", 0, 6_000 * scale, { anchor: "wake_request" }),
]);

describe("ttft baseline statistics", () => {
  it("uses nearest-rank percentiles and ignores non-finite values", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(distribution([1, Number.NaN, 3])).toEqual({ n: 2, p50: 1, p95: 3, max: 3 });
  });

  it("measures boot from claim to the durable turn.submitted and keeps only pre-turn steps", () => {
    const metrics = runMetrics(coldRun("a"));
    expect(metrics).toMatchObject({ ttftMs: 6_000, ttftAnchor: "wake_request", bootMs: 2_400 });
    expect(Object.keys(metrics.preTurnSteps).sort()).toEqual([
      "heartbeat.prepare_before_environment", "heartbeat.queue", "runner.process.launch", "runner.turn.submit",
    ]);
  });

  it("reports the wait behind a live turn as its own step and the TTFT the budget judges", () => {
    // A follow-up comment posted during the previous turn waits 40 s for its run.
    const followUp = run("f", "warm", [
      reuse("reused"),
      span("comment.to_run_created", 0, 40_000),
      span("heartbeat.queue", 40_000, 100),
      span("runner.session.resume", 40_100, 2_000),
      span("task.time_to_first_token", 0, 45_000, { anchor: "comment" }),
    ]);
    expect(runMetrics(followUp)).toMatchObject({ ttftMs: 45_000, inputWaitMs: 40_000, ttftAfterRunCreatedMs: 5_000 });
    expect(runMetrics(coldRun("c"))).toMatchObject({ inputWaitMs: null, ttftAfterRunCreatedMs: 6_000 });
    const [row] = baselineRows([followUp]);
    expect(row).toMatchObject({ ttft: { p50: 45_000 }, inputWait: { n: 1, p50: 40_000 }, ttftAfterRunCreated: { p50: 5_000 } });
  });

  it("uses runner.session.resume as the turn boundary for a resumed session", () => {
    const resumed = run("r", "warm", [reuse("reused"), span("heartbeat.queue", 0, 50), span("runner.session.resume", 60, 940)]);
    expect(runWarmth(resumed)).toBe("warm");
    expect(runMetrics(resumed).bootMs).toBe(950);
  });

  it("classifies warmth from the run log before the driver phase", () => {
    expect(runWarmth(run("x", "warm", [reuse("fresh")]))).toBe("cold");
    expect(runWarmth(run("y", "cold", []))).toBe("cold");
    expect(runWarmth(run("z", "warm", []))).toBe("warm");
  });

  it("groups rows by adapter and warmth and leaves restart runs out", () => {
    const rows = baselineRows([coldRun("a"), coldRun("b", 2), run("c", "restart", [span("task.time_to_first_token", 0, 99_000)])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adapter: "codex", warmth: "cold", anchors: { wake_request: 2 },
      ttft: { n: 2, p50: 6_000, p95: 12_000 } });
  });

  it("reports first visible activity from run creation next to first text", () => {
    const toolFirst = run("t", "warm", [
      reuse("reused"),
      span("comment.to_run_created", 0, 30_000),
      span("heartbeat.queue", 30_000, 100),
      span("task.time_to_first_agent_activity", 0, 35_000, { anchor: "comment" }),
      span("task.time_to_first_token", 0, 48_000, { anchor: "comment" }),
    ], "claude");
    expect(runMetrics(toolFirst)).toMatchObject({ inputWaitMs: 30_000, firstActivityAfterRunCreatedMs: 5_000,
      ttftAfterRunCreatedMs: 18_000 });
    expect(baselineRows([toolFirst])[0]).toMatchObject({ firstActivityAfterRunCreated: { p50: 5_000 },
      ttftAfterRunCreated: { p50: 18_000 } });
  });

  it("measures first activity from run creation even when it is anchored at an earlier wake request", () => {
    // A deferred wake accepted 30 s before the run existed; activity 5 s after run creation.
    const deferred = run("d", "cold", [
      reuse("fresh"),
      span("heartbeat.queue", 0, 100),
      span("task.time_to_first_agent_activity", -30_000, 35_000, { anchor: "wake_request" }),
    ], "claude");
    expect(runMetrics(deferred).firstActivityAfterRunCreatedMs).toBe(5_000);
    const deferredText = run("e", "cold", [reuse("fresh"), span("heartbeat.queue", 0, 100),
      span("task.time_to_first_token", -30_000, 35_000, { anchor: "wake_request" })], "claude");
    expect(runMetrics(deferredText).ttftAfterRunCreatedMs).toBe(5_000);
  });

  it("ranks pre-turn steps by p95 without cumulative wrappers", () => {
    const ranked = rankPreTurnSteps([coldRun("a"), coldRun("b", 2)]);
    expect(ranked[0]).toMatchObject({ step: "runner.process.launch", n: 2, p95: 3_000 });
    expect(ranked.map(step => step.step)).not.toContain("task.prepare");
  });

  it("measures restart recovery from ready to the next provider event, by disposition", () => {
    const readyAt = Date.parse(at(10_000));
    const recovered = run("r1", "restart", [
      { eventType: "item.delta", createdAt: at(9_000) },
      { eventType: "native.recovery.transition", createdAt: at(9_500), payload: { runnerDisposition: "resume_dead_runner" } },
      { eventType: "tool.execution.completed", createdAt: at(13_250) },
    ]);
    const silent = run("r2", "restart", []);
    expect(recoverySamples([recovered, silent], [{ kind: "K1", readyAt, runIds: ["r1", "r2", "missing"] }])).toEqual([
      { runId: "r1", adapter: "codex", kind: "K1", disposition: "resume_dead_runner", readyAt, latencyMs: 3_250 },
      { runId: "r2", adapter: "codex", kind: "K1", disposition: "none", readyAt, latencyMs: null },
    ]);
  });
});

describe("restart sample guard", () => {
  const tool = (eventType: string, executionId: string, extra: Record<string, unknown> = {}): BaselineEvent => ({
    eventType, createdAt: at(0), payload: { prpEvent: { payload: { executionId, ...extra } } },
  });
  const ids = (events: BaselineEvent[], marker?: string) => openShellExecutions(events, marker);

  it("keeps a shell call open until it ends, and ignores other tools", () => {
    expect(ids([
      tool("tool.execution.started", "mcp-1", { name: "paperclip.issue.comment", operation: "unknown" }),
      tool("tool.execution.started", "sh-1", { name: "Bash", operation: "execute" }),
      tool("tool.execution.progressed", "sh-1"),
    ]).map(call => call.executionId)).toEqual(["sh-1"]);
  });

  it("closes a shell call on completion or failure", () => {
    expect(ids([
      tool("tool.execution.started", "sh-1", { name: "/bin/zsh -lc 'python3 -c ...'" }),
      tool("tool.execution.completed", "sh-1"),
      tool("tool.execution.started", "sh-2", { name: "bash" }),
      tool("tool.execution.failed", "sh-2"),
    ])).toEqual([]);
  });

  it("matches the intended command from the name, subject or a later progress update", () => {
    const marker = "time.sleep(75)";
    expect(ids([
      tool("tool.execution.started", "codex", { name: "/bin/zsh -lc 'python3 -c \"import time; time.sleep(75)\"'", operation: "execute" }),
      tool("tool.execution.started", "claude", { name: "Bash", operation: "execute" }),
      tool("tool.execution.progressed", "claude", { subject: "python3 -c \"import time; time.sleep(75)\"" }),
      tool("tool.execution.started", "other", { name: "Bash", operation: "execute", subject: "ls -la" }),
    ], marker)).toEqual([
      { executionId: "codex", matched: true, unlabelled: false },
      { executionId: "claude", matched: true, unlabelled: false },
      { executionId: "other", matched: false, unlabelled: false },
    ]);
  });

  it("marks a shell tool that exposes no command text as unlabelled", () => {
    expect(ids([tool("tool.execution.started", "oc", { name: "bash", operation: "unknown" })], "time.sleep(75)"))
      .toEqual([{ executionId: "oc", matched: false, unlabelled: true }]);
  });
});
