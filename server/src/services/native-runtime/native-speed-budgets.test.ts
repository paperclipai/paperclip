import { describe, expect, it } from "vitest";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import { createNativeRunTrace } from "./native-run-trace.js";
import {
  evaluateSpeedBudget,
  LOCAL_SPEED_BUDGETS,
  RESTART_RECOVERY_PROVIDER_EVENT_TYPES,
  restartRecoveryMeasurementFor,
  SPEED_BUDGET_EXCEEDED_EVENT_TYPE,
  speedBudgetAdapter,
  speedBudgetFor,
} from "./native-speed-budgets.js";

describe("speed budgets", () => {
  it("defines p50 below p95 for every adapter, metric and start", () => {
    for (const budgets of Object.values(LOCAL_SPEED_BUDGETS)) {
      for (const budget of [budgets.time_to_first_activity.cold, budgets.time_to_first_activity.warm, budgets.agent_boot.cold, budgets.agent_boot.warm,
        budgets.restart_recovery]) {
        expect(budget.p50Ms).toBeGreaterThan(0);
        expect(budget.p50Ms).toBeLessThanOrEqual(budget.p95Ms);
      }
    }
  });

  it("maps native providers to budgeted adapters", () => {
    expect(speedBudgetAdapter({ kind: "codex" })).toBe("codex");
    expect(speedBudgetAdapter({ kind: "opencode" })).toBe("opencode");
    expect(speedBudgetAdapter({ kind: "acpx", agent: "claude" })).toBe("claude");
    expect(speedBudgetAdapter({ kind: "acpx", agent: "cursor" })).toBeNull();
    expect(speedBudgetAdapter({ kind: "claude_managed" })).toBeNull();
  });

  it("judges one run against p95 and uses the looser budget when the start kind is unknown", () => {
    const codexCold = LOCAL_SPEED_BUDGETS.codex.time_to_first_activity.cold.p95Ms;
    expect(evaluateSpeedBudget({ adapter: "codex", environment: "local", metric: "time_to_first_activity", start: "cold", measuredMs: codexCold }))
      .toBeNull();
    expect(evaluateSpeedBudget({ adapter: "codex", environment: "local", metric: "time_to_first_activity", start: "cold", measuredMs: codexCold + 1 }))
      .toMatchObject({ metric: "time_to_first_activity", adapter: "codex", startKind: "cold", budgetP95Ms: codexCold, percentile: "p95" });
    const loose = speedBudgetFor("codex", "time_to_first_activity", null);
    expect(loose.p95Ms).toBe(Math.max(codexCold, LOCAL_SPEED_BUDGETS.codex.time_to_first_activity.warm.p95Ms));
    expect(evaluateSpeedBudget({ adapter: "codex", environment: "local", metric: "time_to_first_activity", start: null, measuredMs: codexCold + 1 }))
      .toBeNull();
  });

  it("does not judge remote runs or adapters without a baseline", () => {
    expect(evaluateSpeedBudget({ adapter: "codex", environment: "remote", metric: "time_to_first_activity", start: "cold", measuredMs: 1e9 })).toBeNull();
    expect(evaluateSpeedBudget({ adapter: null, environment: "local", metric: "time_to_first_activity", start: "cold", measuredMs: 1e9 })).toBeNull();
  });
});

describe("speed budget checks in the native run trace", () => {
  function traced(budget?: Parameters<typeof createNativeRunTrace>[0]["budget"]) {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({ runId: "run-1", startedAtMs: 0, budget,
      onEvent: async event => { events.push(event); } });
    const breaches = () => events.filter(event => event.eventType === SPEED_BUDGET_EXCEEDED_EVENT_TYPE)
      .map(event => event.payload as Record<string, unknown>);
    return { trace, breaches };
  }

  it("writes one run-log breach for a slow agent boot and none for a fast TTFT", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local" });
    trace.setBudgetStart("cold");
    await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: 100 });
    const boot = LOCAL_SPEED_BUDGETS.codex.agent_boot.cold.p95Ms + 500;
    await trace.record({ name: "runner.turn.submit", startedAtMs: 100, endedAtMs: 100 + boot });
    // A second submit in the same run is not a second boot.
    await trace.record({ name: "runner.turn.submit", startedAtMs: 100, endedAtMs: 100 + boot * 2 });
    await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: 1_000 });
    await trace.finish("ok");

    expect(breaches()).toEqual([expect.objectContaining({
      schema: "paperclip.run-performance-budget.v1", metric: "agent_boot", adapter: "codex", startKind: "cold",
      measuredMs: boot, budgetP95Ms: LOCAL_SPEED_BUDGETS.codex.agent_boot.cold.p95Ms,
    })]);
  });

  it("writes a breach for a slow TTFT recorded by deferred diagnostics before the trace closes", async () => {
    const { trace, breaches } = traced({ adapter: "claude", environment: "local" });
    trace.setBudgetStart("warm");
    const ttft = LOCAL_SPEED_BUDGETS.claude.time_to_first_activity.warm.p95Ms + 1;
    trace.defer(async () => {
      await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: ttft });
    });
    await trace.finish("ok");

    expect(breaches()).toEqual([expect.objectContaining({ metric: "time_to_first_activity", adapter: "claude", startKind: "warm", measuredMs: ttft })]);
  });

  it("judges a follow-up's TTFT from run creation and reports the wait behind the live turn", async () => {
    // A comment posted while the previous turn runs waits for a run to exist;
    // the budget (idle follow-up baseline) judges the time after that.
    const budget = LOCAL_SPEED_BUDGETS.claude.time_to_first_activity.warm.p95Ms;
    const wait = 60_000;
    const quiet = traced({ adapter: "claude", environment: "local" });
    quiet.trace.setBudgetStart("warm");
    await quiet.trace.record({ name: "comment.to_run_created", startedAtMs: 0, endedAtMs: wait });
    await quiet.trace.record({ name: "heartbeat.queue", startedAtMs: wait, endedAtMs: wait + 100 });
    await quiet.trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: wait + budget - 1 });
    await quiet.trace.finish("ok");
    expect(quiet.breaches()).toEqual([]);

    const slow = traced({ adapter: "claude", environment: "local" });
    slow.trace.setBudgetStart("warm");
    await slow.trace.record({ name: "comment.to_run_created", startedAtMs: 0, endedAtMs: wait });
    await slow.trace.record({ name: "heartbeat.queue", startedAtMs: wait, endedAtMs: wait + 100 });
    await slow.trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: wait + budget + 1 });
    await slow.trace.finish("ok");
    expect(slow.breaches()).toEqual([expect.objectContaining({ metric: "time_to_first_activity", measuredMs: budget + 1, inputWaitMs: wait })]);
  });

  it("still judges queueing after run creation (admission, dispatch) inside the TTFT budget", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local" });
    trace.setBudgetStart("cold");
    const budget = LOCAL_SPEED_BUDGETS.codex.time_to_first_activity.cold.p95Ms;
    await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: budget });
    await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: budget + 1 });
    await trace.finish("ok");
    expect(breaches()).toEqual([expect.objectContaining({ metric: "time_to_first_activity", measuredMs: budget + 1 })]);
    expect(breaches()[0]).not.toHaveProperty("inputWaitMs");
  });

  it("judges first visible activity, not first text, so a tool-first turn is within budget", async () => {
    const { trace, breaches } = traced({ adapter: "claude", environment: "local" });
    trace.setBudgetStart("cold");
    const budget = LOCAL_SPEED_BUDGETS.claude.time_to_first_activity.cold.p95Ms;
    await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: 50 });
    // The agent calls a tool at once and writes its first text much later.
    await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: 5_000 });
    await trace.record({ name: "task.time_to_first_token", startedAtMs: 0, endedAtMs: budget * 2 });
    await trace.finish("ok");
    expect(breaches()).toEqual([]);
  });

  it("checks restart recovery latency once, from ready to the first provider event", async () => {
    const { trace, breaches } = traced({ adapter: "opencode", environment: "local" });
    const late = LOCAL_SPEED_BUDGETS.opencode.restart_recovery_control_plane.p95Ms + 1_000;
    trace.checkRestartRecovery({ readyAtMs: 10_000, emittedAtMs: 10_000 + late, committedAtMs: 10_000 + late, disposition: "resume_dead_runner" });
    trace.checkRestartRecovery({ readyAtMs: 10_000, emittedAtMs: 10_000 + late * 2, committedAtMs: 10_000 + late * 2, disposition: "resume_dead_runner" });
    await trace.finish("ok");

    expect(breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: late,
      disposition: "resume_dead_runner", startKind: "unknown" })]);
  });

  it("judges a restart-recovery dispatch only on recovery latency, not on TTFT or boot spanning the outage", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: 1 });
    await trace.record({ name: "runner.session.resume", startedAtMs: 1, endedAtMs: 120_000 });
    await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: 120_000 });
    const at = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms + 1;
    trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: at, committedAtMs: at, disposition: "resume_dead_runner" });
    await trace.finish("ok");
    expect(breaches().map(breach => breach.metric)).toEqual(["restart_recovery_control_plane"]);
  });

  it("judges only Paperclip's share of a recovery, not the provider's session load", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    const total = LOCAL_SPEED_BUDGETS.codex.restart_recovery.p95Ms + 3_000;
    // Ready → claim, prepare and launch in 1.5 s; the provider reloads its long session.
    await trace.record({ name: "provider.session.load", startedAtMs: 1_500, endedAtMs: total - 500 });
    trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: total, committedAtMs: total, disposition: "resume_dead_runner" });
    await trace.finish("ok");
    expect(breaches()).toEqual([]);
  });

  it("reports a slow control-plane share with the full latency and the provider's share", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    const control = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms + 2_000;
    trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: control + 3_000, committedAtMs: control + 3_000, disposition: "resume_dead_runner" });
    // The provider span is committed after the provider event that ended the recovery.
    await trace.record({ name: "provider.session.load", startedAtMs: control, endedAtMs: control + 2_800 });
    await trace.finish("ok");
    expect(breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: control,
      restartTotalMs: control + 3_000, providerLoadMs: 3_000 })]);
  });

  it("flushes a pending recovery check when the controller detaches the run", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    const late = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms + 1_000;
    // A launched runner whose load span has not been written yet.
    trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: late, committedAtMs: late, disposition: "resume_dead_runner" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(breaches()).toEqual([]);
    trace.flushRestartRecovery();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: late })]);
  });

  it("logs each span's own start time in its run-log row", async () => {
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({ runId: "run-1", startedAtMs: 1_000, onEvent: async event => { events.push(event); } });
    await trace.record({ name: "provider.session.load", startedAtMs: 4_000, endedAtMs: 9_000 });
    await trace.finish("ok");
    expect(events.find(event => (event.payload as Record<string, unknown>)?.span === "provider.session.load")?.payload)
      .toMatchObject({ startOffsetMs: 3_000, durationMs: 5_000, wallStartedAtMs: 4_000 });
  });

  it("judges a recovery before the run finishes, so a later detach for restart keeps the warning", async () => {
    const control = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms + 1_000;
    // The load span arrives after the provider event: judged when it is recorded.
    const resumed = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    resumed.trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: control + 2_000, committedAtMs: control + 2_000, disposition: "resume_dead_runner" });
    await resumed.trace.record({ name: "provider.session.load", startedAtMs: control, endedAtMs: control + 1_900 });
    // A reattached runner reloads nothing: judged at the check.
    const reattached = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    reattached.trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: control, committedAtMs: control, disposition: "reattach_existing_runner" });
    // Neither trace finishes (the controller detached for another restart).
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resumed.breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: control })]);
    expect(reattached.breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: control, providerLoadMs: 0 })]);
  });

  it("does not spend the restart-recovery check on an event emitted before ready", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    const late = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms + 1_000;
    // Buffered during the outage, committed after ready.
    trace.checkRestartRecovery(restartRecoveryMeasurementFor({ event: { eventType: "item.delta", emittedAt: new Date(9_000).toISOString() },
      startup: { phase: "ready", updatedAt: new Date(10_000).toISOString() }, committedAtMs: 10_500, disposition: "reattach_existing_runner" })!);
    trace.checkRestartRecovery(restartRecoveryMeasurementFor({ event: { eventType: "item.delta", emittedAt: new Date(10_000 + late - 200).toISOString() },
      startup: { phase: "ready", updatedAt: new Date(10_000).toISOString() }, committedAtMs: 10_000 + late, disposition: "reattach_existing_runner" })!);
    await trace.finish("ok");
    expect(breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: late })]);
  });

  it("measures a resumed attempt's boot from its own claim, not the run's first queue span", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local" });
    trace.setBudgetStart("warm");
    await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: 100 });
    // The attempt resumed ten minutes later and booted in one second.
    await trace.record({ name: "heartbeat.prepare_before_environment", startedAtMs: 600_000, endedAtMs: 600_200 });
    await trace.record({ name: "runner.session.resume", startedAtMs: 600_200, endedAtMs: 601_000 });
    await trace.finish("ok");
    expect(breaches()).toEqual([]);
  });

  it("counts only the baseline's provider events as a recovered run's next event", () => {
    const startup = { phase: "ready", updatedAt: new Date(10_000).toISOString() };
    const measure = (eventType: string) => restartRecoveryMeasurementFor({ event: { eventType, emittedAt: new Date(11_000).toISOString() },
      startup, committedAtMs: 12_000, disposition: "resume_dead_runner" });
    expect(measure("item.delta")).toEqual({ readyAtMs: 10_000, emittedAtMs: 11_000, committedAtMs: 12_000, disposition: "resume_dead_runner" });
    expect(measure("harness.diagnostic")).toBeNull();
    expect(measure("run.performance.span")).toBeNull();
    expect(RESTART_RECOVERY_PROVIDER_EVENT_TYPES.has("session.resumed")).toBe(true);
  });

  it("measures to the commit time, so delivery delays after emission count", async () => {
    const { trace, breaches } = traced({ adapter: "codex", environment: "local", restartRecovery: true });
    const budget = LOCAL_SPEED_BUDGETS.codex.restart_recovery_control_plane.p95Ms;
    // Emitted 1 s after ready, committed 20 s after ready.
    trace.checkRestartRecovery({ readyAtMs: 0, emittedAtMs: 1_000, committedAtMs: budget + 12_000, disposition: "resume_dead_runner" });
    await trace.finish("ok");
    expect(breaches()).toEqual([expect.objectContaining({ metric: "restart_recovery_control_plane", measuredMs: budget + 12_000 })]);
  });

  it("writes nothing for remote runs or without a budget subject", async () => {
    for (const budget of [{ adapter: "codex" as const, environment: "remote" as const }, undefined]) {
      const { trace, breaches } = traced(budget);
      await trace.record({ name: "heartbeat.queue", startedAtMs: 0, endedAtMs: 1 });
      await trace.record({ name: "runner.turn.submit", startedAtMs: 1, endedAtMs: 10_000_000 });
      await trace.record({ name: "task.time_to_first_agent_activity", startedAtMs: 0, endedAtMs: 10_000_000 });
      await trace.finish("ok");
      expect(breaches()).toEqual([]);
    }
  });
});
