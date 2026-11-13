import { describe, expect, it } from "vitest";
import {
  baselineRows, daytonaBaselineHolders, daytonaRetainsSandboxes, distribution, parseBaselineEnvironment, parseBaselinePhases, openShellExecutions, percentile, rankPreTurnSteps, recoverySamples, runMetrics, runWarmth,
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

  it("leaves post-restart and verification runs out of the baseline rows", () => {
    const rows = baselineRows([coldRun("a"), run("p", "postfault", [span("task.time_to_first_token", 0, 20_000)]),
      run("v", "verify", [span("task.time_to_first_token", 0, 30_000)])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ warmth: "cold", ttft: { n: 1, p50: 6_000 } });
  });

  it("counts held Daytona sandboxes per concurrent task, or per sampled task when they stay warm", () => {
    const phases = new Set(["coldwarm", "midturn", "restart"]);
    expect(daytonaBaselineHolders({ adapters: 3, samples: 5, phases, restarts: 2, retainsSandboxes: false })).toBe(3);
    // 5 samples x (coldwarm + midturn) + K1 and K2 for each of 2 restarts = 14 tasks per adapter.
    expect(daytonaBaselineHolders({ adapters: 3, samples: 5, phases, restarts: 2, retainsSandboxes: true })).toBe(42);
    // Restart tasks do not scale with --samples.
    expect(daytonaBaselineHolders({ adapters: 3, samples: 1, phases: new Set(["restart"]), restarts: 2, retainsSandboxes: true })).toBe(12);
    expect(daytonaBaselineHolders({ adapters: 3, samples: 5, phases: new Set(["restart"]), restarts: 2, retainsSandboxes: true })).toBe(12);
    expect(daytonaBaselineHolders({ adapters: 2, samples: 0, phases: new Set(["postfault"]), restarts: 0, retainsSandboxes: true })).toBe(2);
  });

  it("treats an inheriting environment as warm only when the agent's lifecycle is not pinned per-turn", () => {
    expect(daytonaRetainsSandboxes({ warmEnvironment: true, inheritEnvironment: false, lifecycle: undefined })).toBe(true);
    expect(daytonaRetainsSandboxes({ warmEnvironment: false, inheritEnvironment: true, lifecycle: undefined })).toBe(false);
    expect(daytonaRetainsSandboxes({ warmEnvironment: false, inheritEnvironment: true, lifecycle: "per_turn" })).toBe(false);
    expect(daytonaRetainsSandboxes({ warmEnvironment: false, inheritEnvironment: true, lifecycle: "default" })).toBe(true);
    expect(daytonaRetainsSandboxes({ warmEnvironment: false, inheritEnvironment: true, lifecycle: "warm" })).toBe(true);
    expect(daytonaRetainsSandboxes({ warmEnvironment: false, inheritEnvironment: false, lifecycle: "warm" })).toBe(false);
  });

  it("rejects unknown phases and a postfault phase without the coldwarm tasks it follows up on", () => {
    expect([...parseBaselinePhases("coldwarm, postfault")]).toEqual(["coldwarm", "postfault"]);
    expect([...parseBaselinePhases("verify")]).toEqual(["verify"]);
    expect(() => parseBaselinePhases("postfault")).toThrow(/add coldwarm/);
    expect(() => parseBaselinePhases("restart,postfualt")).toThrow(/got postfualt/);
    expect(() => parseBaselinePhases(" , ")).toThrow(/got nothing/);
  });

  it("rejects contradictory or out-of-range environment options", () => {
    const base = { env: "daytona", image: "img", cpu: "4", warm: false, inherit: false };
    expect(parseBaselineEnvironment(base)).toEqual({ env: "daytona", cpu: 4 });
    expect(parseBaselineEnvironment({ ...base, env: "local", image: undefined })).toMatchObject({ env: "local" });
    expect(() => parseBaselineEnvironment({ ...base, env: "dayton" })).toThrow(/local or daytona/);
    expect(() => parseBaselineEnvironment({ ...base, image: undefined })).toThrow(/needs --daytona-image/);
    for (const cpu of ["0", "5", "abc", "2.5"]) expect(() => parseBaselineEnvironment({ ...base, cpu })).toThrow(/1 to 4/);
    expect(() => parseBaselineEnvironment({ ...base, warm: true, inherit: true })).toThrow(/cannot be combined/);
    expect(() => parseBaselineEnvironment({ ...base, env: "local", image: undefined, warm: true })).toThrow(/only to --env daytona/);
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
      { runId: "r1", adapter: "codex", kind: "K1", disposition: "resume_dead_runner", readyAt, latencyMs: 3_250, controlPlaneMs: 3_250, providerLoadMs: 0 },
      { runId: "r2", adapter: "codex", kind: "K1", disposition: "none", readyAt, latencyMs: null, controlPlaneMs: null, providerLoadMs: null },
    ]);
  });
});

describe("restart recovery split", () => {
  // The trace starts at the epoch; the queue span is written promptly and anchors it.
  const queue = { eventType: "run.performance.span", createdAt: at(100), payload: { span: "heartbeat.queue", startOffsetMs: 0, durationMs: 100 } };
  const load = (writtenAt: number) => ({ eventType: "run.performance.span", createdAt: at(writtenAt),
    payload: { span: "provider.session.load", startOffsetMs: 11_500, durationMs: 4_500 } });

  it("splits a recovery at the start of the provider's session load", () => {
    const readyAt = Date.parse(at(10_000));
    const recovered = run("r1", "restart", [queue, load(16_000), { eventType: "session.resumed", createdAt: at(16_400) }]);
    expect(recoverySamples([recovered], [{ kind: "K2", readyAt, runIds: ["r1"] }])).toEqual([
      { runId: "r1", adapter: "codex", kind: "K2", disposition: "none", readyAt, latencyMs: 6_400, controlPlaneMs: 1_500, providerLoadMs: 4_900 },
    ]);
  });

  it("uses the start the server logged even when every span row was written late", () => {
    const readyAt = Date.parse(at(10_000));
    // All rows deferred by 8 s, so no write time can anchor the trace.
    const late = (span: string, offset: number, duration: number) => ({ eventType: "run.performance.span", createdAt: at(offset + duration + 8_000),
      payload: { span, startOffsetMs: offset, durationMs: duration, wallStartedAtMs: Date.parse(at(offset)) } });
    const recovered = run("r1", "restart", [late("heartbeat.queue", 0, 100), { eventType: "session.resumed", createdAt: at(16_400) },
      late("provider.session.load", 11_500, 4_500)]);
    expect(recoverySamples([recovered], [{ kind: "K2", readyAt, runIds: ["r1"] }])[0]).toMatchObject({ controlPlaneMs: 1_500, providerLoadMs: 4_900 });
  });

  it("takes the load start from the span's offset, not its (possibly deferred) write time", () => {
    const readyAt = Date.parse(at(10_000));
    // The load span's run-log row is written 5 s late, after the provider event.
    const recovered = run("r1", "restart", [queue, { eventType: "session.resumed", createdAt: at(16_400) }, load(21_000)]);
    expect(recoverySamples([recovered], [{ kind: "K2", readyAt, runIds: ["r1"] }])[0]).toMatchObject({ controlPlaneMs: 1_500, providerLoadMs: 4_900 });
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
