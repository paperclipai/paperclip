import { describe, expect, it } from "vitest";
import { parseCommand, parseReplayRef, waveIdFor } from "./config.js";
import { K4_HOLD_RANGE_MS, createRng, observedFaultSchedule, planTasks, planWave, replayWave, taskFaultSchedule } from "./scheduler.js";
import type { WaveOptions } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const options: WaveOptions = { env: "local", adapters: ["codex", "claude", "opencode"], workloads: ["A1", "B1", "B5", "C1"],
  faults: ["K1", "K2", "K4"], concurrency: 4, tasks: 8, seed: 42, budgetCents: 3_000, pollMs: 3_000 };

describe("scheduler determinism", () => {
  it("produces the same plan for the same seed", () => {
    expect(planTasks(options)).toEqual(planTasks(options));
  });

  it("produces a different plan for a different seed", () => {
    expect(planTasks({ ...options, seed: 43 })).not.toEqual(planTasks(options));
  });

  it("keeps fire times, holds and follow-ups inside each workload's window", () => {
    for (const task of planTasks({ ...options, tasks: 60 })) {
      const definition = workloadDefinitions[task.workload];
      expect(task.fireAfterMs).toBeGreaterThanOrEqual(definition.fireWindowMs[0]);
      expect(task.fireAfterMs).toBeLessThanOrEqual(definition.fireWindowMs[1]);
      if (task.fault === "K4") {
        expect(task.holdMs).toBeGreaterThanOrEqual(K4_HOLD_RANGE_MS[0]);
        expect(task.holdMs).toBeLessThanOrEqual(K4_HOLD_RANGE_MS[1]);
      } else expect(task.holdMs).toBe(0);
      expect(task.followUpAfterMs === null).toBe(task.workload !== "C1");
      expect(task.nonce).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("covers every workload × adapter × fault cell once per cycle", () => {
    const cells = options.workloads.length * options.adapters.length * options.faults.length;
    const tasks = planTasks({ ...options, tasks: cells });
    expect(new Set(tasks.map(task => `${task.workload}/${task.adapter}/${task.fault}`)).size).toBe(cells);
    expect(tasks.map(task => task.taskId).slice(0, 3)).toEqual(["t01", "t02", "t03"]);
  });

  it("respects narrowed selections", () => {
    const tasks = planTasks({ ...options, adapters: ["codex"], workloads: ["A1"], faults: ["K1"], tasks: 3 });
    expect(tasks.every(task => task.adapter === "codex" && task.workload === "A1" && task.fault === "K1")).toBe(true);
  });

  it("has a stable RNG sequence", () => {
    const first = createRng(7);
    const second = createRng(7);
    expect(Array.from({ length: 5 }, () => first.next())).toEqual(Array.from({ length: 5 }, () => second.next()));
  });
});

describe("replay", () => {
  const plan = planWave(waveIdFor(42, new Date("2026-11-06T10:11:12Z")), options, new Date("2026-11-06T10:11:12Z"));

  it("names waves with the timestamp and seed", () => {
    expect(plan.waveId).toBe("w-20261106T101112-s42");
  });

  it("reproduces exactly one saved task", () => {
    const replay = replayWave(plan, { waveId: plan.waveId, taskId: "t03" }, 1_700_000_000_000);
    expect(replay.tasks).toEqual([plan.tasks[2]]);
    expect(replay.options.concurrency).toBe(1);
    expect(replay.replayOf).toEqual({ waveId: plan.waveId, taskId: "t03" });
    expect(replay.waveId).toBe(`${plan.waveId}-replay-t03-1700000000000`);
    // A replay of a replay names the original wave, and its id parses again.
    const again = replayWave(replay, parseReplayRef(`${replay.waveId}/t03`), 1_700_000_000_001);
    expect(again.waveId).toBe(`${plan.waveId}-replay-t03-1700000000001`);
  });

  it("replays the recorded fault sequence that crossed the task, other tasks' faults included", () => {
    const createdAt = 1_000_000;
    const faults = [
      { faultId: "f01", kind: "K1" as const, holdMs: 0, startedAt: createdAt + 42_000 },
      { faultId: "f02", kind: "K4" as const, holdMs: 150_000, startedAt: createdAt + 60_000 },
      { faultId: "f03", kind: "K2" as const, holdMs: 0, startedAt: createdAt + 900_000 },
    ];
    const observed = observedFaultSchedule(createdAt, ["f02", "f01"], faults);
    expect(observed).toEqual([{ kind: "K1", holdMs: 0, atMs: 42_000 }, { kind: "K4", holdMs: 150_000, atMs: 60_000 }]);
    const replay = replayWave(plan, { waveId: plan.waveId, taskId: "t02" }, 1, {}, observed);
    expect(taskFaultSchedule(replay.tasks[0]!)).toEqual(observed);
    // Without a recorded sequence the replay falls back to the planned fault.
    const planned = replayWave(plan, { waveId: plan.waveId, taskId: "t02" }, 1);
    expect(taskFaultSchedule(planned.tasks[0]!)).toEqual([{ kind: plan.tasks[1]!.fault, holdMs: plan.tasks[1]!.holdMs, atMs: plan.tasks[1]!.fireAfterMs }]);
  });

  it("rejects unknown tasks and mismatched waves", () => {
    expect(() => replayWave(plan, { waveId: plan.waveId, taskId: "t99" })).toThrow(/no task t99/);
    expect(() => replayWave(plan, { waveId: "w-20261106T101112-s1", taskId: "t01" })).toThrow(/not w-/);
  });
});

describe("CLI parsing", () => {
  it("parses a wave command including pnpm's forwarded --", () => {
    const parsed = parseCommand(["--", "--env", "local", "--adapters", "codex,claude,opencode", "--concurrency", "4", "--tasks", "8", "--faults", "K1,K2,K4", "--seed", "17"]);
    expect(parsed).toMatchObject({ mode: "wave", options: { env: "local", adapters: ["codex", "claude", "opencode"], concurrency: 4, tasks: 8, faults: ["K1", "K2", "K4"], seed: 17 } });
  });

  it("parses --replay", () => {
    expect(parseCommand(["--replay", "w-20261106T101112-s42/t03"])).toMatchObject({ mode: "replay", ref: { waveId: "w-20261106T101112-s42", taskId: "t03" } });
  });

  it("rejects replay mixed with plan options and malformed refs", () => {
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--seed", "1"])).toThrow(/reproduces the saved plan/);
    expect(() => parseReplayRef("w-20261106T101112-s42")).toThrow(/<wave>\/<task>/);
    expect(() => parseReplayRef("..%2Fetc/t01")).toThrow(/Invalid wave id/);
    expect(() => parseReplayRef("../etc/t01")).toThrow(/<wave>\/<task>/);
    expect(() => parseReplayRef("w-20261106T101112-s42/t1")).toThrow(/Invalid task id/);
  });

  it("rejects unknown faults, adapters and out-of-range numbers", () => {
    expect(() => parseCommand(["--faults", "K9"])).toThrow(/Unknown faults/);
    expect(() => parseCommand(["--adapters", "gemini"])).toThrow(/Unknown adapters/);
    expect(() => parseCommand(["--concurrency", "0"])).toThrow(/between 1 and 20/);
    expect(() => parseCommand(["--poll-ms", "500"])).toThrow(/between 2000 and 5000/);
  });
});
