import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { crossingFaults } from "./grader.js";
import { planMatrixWave } from "./journey-matrix.js";
import { createRng, observedFaultSchedule, planTasks, taskFaultSchedule } from "./scheduler.js";
import {
  RR3_KILL_RANGE, RR_GAP_RANGE_MS, newRepeatedRestartRecord, planRestartSteps, recordFirstRestart, runRepeatedRestarts, stopPhaseWatcher, type RepeatedRestartRecord, type RestartStep,
} from "./repeated-restarts.js";
import type { FaultReceipt, TaskRecord } from "./types.js";

describe("repeated restart options", () => {
  it("accepts RR faults with each kind's default gaps", () => {
    const parsed = parseCommand(["--faults", "RR1,RR2,RR3", "--adapters", "codex", "--workloads", "A1", "--seed", "1"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(parsed.options.faults).toEqual(["RR1", "RR2", "RR3"]);
    expect(parsed.options.rrGapMs).toBeUndefined();
  });

  it("takes --rr-gap-seconds as one value or a range, only with an RR fault", () => {
    const one = parseCommand(["--faults", "RR1", "--rr-gap-seconds", "5", "--workloads", "A1", "--seed", "1"]);
    expect(one.mode === "wave" && one.options.rrGapMs).toEqual([5_000, 5_000]);
    const range = parseCommand(["--faults", "RR3", "--rr-gap-seconds", "10-40", "--workloads", "A1", "--seed", "1"]);
    expect(range.mode === "wave" && range.options.rrGapMs).toEqual([10_000, 40_000]);
    expect(() => parseCommand(["--faults", "K1", "--rr-gap-seconds", "5", "--workloads", "A1"])).toThrow(/add RR1, RR2 or RR3/);
    expect(() => parseCommand(["--faults", "RR1", "--rr-gap-seconds", "0", "--workloads", "A1"])).toThrow(/between 1 and 300/);
    expect(() => parseCommand(["--faults", "RR1", "--rr-gap-seconds", "20-10", "--workloads", "A1"])).toThrow(/min not above max/);
    expect(() => parseCommand(["--faults", "RR1", "--rr-gap-seconds", "5s", "--workloads", "A1"])).toThrow(/<seconds> or <min>-<max>/);
  });

  it("takes --rr-stop-on recovering instead of a gap, only with an RR fault", () => {
    const parsed = parseCommand(["--faults", "RR1,RR3", "--rr-stop-on", "recovering", "--workloads", "A1", "--seed", "1"]);
    expect(parsed.mode === "wave" && parsed.options.rrStopOn).toBe("recovering");
    expect(parsed.mode === "wave" && parsed.options.rrGapMs).toBeUndefined();
    expect(() => parseCommand(["--faults", "K1", "--rr-stop-on", "recovering", "--workloads", "A1"])).toThrow(/add RR1, RR2 or RR3/);
    expect(() => parseCommand(["--faults", "RR1", "--rr-stop-on", "ready", "--workloads", "A1"])).toThrow(/must be recovering/);
    expect(() => parseCommand(["--faults", "RR1", "--rr-stop-on", "recovering", "--rr-gap-seconds", "1", "--workloads", "A1"]))
      .toThrow(/do not combine it with --rr-gap-seconds/);
    expect(() => parseCommand(["--replay", "w-20261110T000000-s1/t01", "--rr-stop-on", "recovering"])).toThrow(/--rr-stop-on/);
  });

  it("refuses a storm, whose faults carry no planned restarts", () => {
    expect(() => parseCommand(["--faults", "RR1", "--storm-minutes", "10"])).toThrow(/storm/);
  });

  it("refuses --rr-gap-seconds with --replay", () => {
    expect(() => parseCommand(["--replay", "w-20261110T000000-s1/t01", "--rr-gap-seconds", "5"])).toThrow(/--rr-gap-seconds/);
  });
});

describe("repeated restart planning", () => {
  const within = (value: number, [min, max]: readonly [number, number]) => value >= min && value <= max;

  it("plans one SIGKILL (RR1), one SIGTERM (RR2) or 2-3 more SIGKILLs (RR3) after the first kill", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rng = createRng(seed);
      const rr1 = planRestartSteps("RR1", rng.int);
      expect(rr1).toHaveLength(1);
      expect(rr1[0]!.signal).toBe("SIGKILL");
      expect(within(rr1[0]!.gapMs, RR_GAP_RANGE_MS.RR1)).toBe(true);
      const rr2 = planRestartSteps("RR2", rng.int);
      expect(rr2.map(step => step.signal)).toEqual(["SIGTERM"]);
      expect(within(rr2[0]!.gapMs, RR_GAP_RANGE_MS.RR2)).toBe(true);
      const rr3 = planRestartSteps("RR3", rng.int);
      expect(within(rr3.length + 1, RR3_KILL_RANGE)).toBe(true);
      expect(rr3.every(step => step.signal === "SIGKILL" && within(step.gapMs, RR_GAP_RANGE_MS.RR3))).toBe(true);
    }
  });

  it("draws both RR3 lengths over seeds", () => {
    const lengths = new Set(Array.from({ length: 40 }, (_, seed) => planRestartSteps("RR3", createRng(seed).int).length));
    expect([...lengths].sort()).toEqual([2, 3]);
  });

  it("uses the --rr-gap-seconds range for every kind", () => {
    const steps = planRestartSteps("RR3", createRng(3).int, [7_000, 7_000]);
    expect(steps.every(step => step.gapMs === 7_000)).toBe(true);
  });

  it("gives RR tasks seeded restart steps and leaves the plans of other faults unchanged", () => {
    const options = { seed: 11, tasks: 9, workloads: ["A1" as const], adapters: ["codex" as const] };
    const plain = planTasks({ ...options, faults: ["K1", "K2"] });
    expect(plain.every(task => task.restartSteps === undefined)).toBe(true);
    expect(planTasks({ ...options, faults: ["K1", "K2"], rrGapMs: [5_000, 5_000] })).toEqual(plain);
    const repeated = planTasks({ ...options, faults: ["RR1", "RR2", "RR3"] });
    expect(repeated.every(task => (task.restartSteps?.length ?? 0) >= 1 && task.holdMs === 0)).toBe(true);
    expect(planTasks({ ...options, faults: ["RR1", "RR2", "RR3"] })).toEqual(repeated);
  });

  it("carries the steps into the task's fault schedule and the matrix plan", () => {
    const [task] = planTasks({ seed: 5, tasks: 1, workloads: ["A1"], adapters: ["codex"], faults: ["RR3"] });
    expect(taskFaultSchedule(task!)).toEqual([{ kind: "RR3", holdMs: 0, atMs: task!.fireAfterMs, restartSteps: task!.restartSteps }]);
    const parsed = parseCommand(["--matrix", "--workloads", "Q2", "--adapters", "codex", "--faults", "RR1", "--seed", "4"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    const matrix = planMatrixWave("w-matrix", parsed.options);
    const faulted = matrix.tasks.filter(cell => cell.fault === "RR1");
    expect(faulted.length).toBeGreaterThan(0);
    expect(faulted.every(cell => cell.restartSteps?.length === 1)).toBe(true);
  });

  it("replays the recorded steps of a fault that crossed the task", () => {
    const planned: RestartStep[] = [{ signal: "SIGKILL", gapMs: 12_000 }, { signal: "SIGKILL", gapMs: 25_000 }];
    const schedule = observedFaultSchedule(1_000, ["f01"], [{ faultId: "f01", kind: "RR3", holdMs: 0, startedAt: 31_000,
      repeatedRestart: { planned } }]);
    expect(schedule).toEqual([{ kind: "RR3", holdMs: 0, atMs: 30_000, restartSteps: planned }]);
  });
});

/** A fake server tree on a fake clock: each start takes `bootMs` to be healthy. */
function fakeHooks(options: { bootMs?: number; stopMs?: number; exitDuringGap?: number; cancelAfterStops?: number } = {}) {
  let clock = 100_000;
  let nextPid = 200;
  const log: string[] = [];
  const exited = new Set<number>();
  let stops = 0;
  const hooks = {
    now: () => clock,
    sleep: async (ms: number) => { log.push(`sleep ${ms}`); clock += ms; },
    cancelled: () => options.cancelAfterStops !== undefined && stops >= options.cancelAfterStops,
    pidOf: (server: { pid: number }) => server.pid,
    exitStatus: (server: { pid: number }) => exited.has(server.pid) ? { code: 1, signal: null } : null,
    readPhase: async () => "recovering",
    stop: async (server: { pid: number }, signal: "SIGKILL" | "SIGTERM") => {
      stops += 1;
      log.push(`stop ${server.pid} ${signal}`);
      clock += options.stopMs ?? 500;
      exited.add(server.pid);
    },
    start: async () => {
      const server = { pid: nextPid++ };
      log.push(`start ${server.pid}`);
      if (options.exitDuringGap === server.pid) exited.add(server.pid);
      return server;
    },
    waitHealthy: async () => { clock += options.bootMs ?? 8_000; return clock; },
  };
  return { hooks, log, now: () => clock };
}

function record(kind: "RR1" | "RR2" | "RR3", planned: RestartStep[]): RepeatedRestartRecord {
  return { kind, planned, restarts: [] };
}

describe("the record built before the first kill", () => {
  const planned: RestartStep[] = [{ signal: "SIGKILL", gapMs: 12_000 }, { signal: "SIGKILL", gapMs: 25_000 }];
  const build = (steps: RestartStep[] | undefined) => newRepeatedRestartRecord({ kind: "RR3", planned: steps, firstPid: 41, startedAt: 5_000,
    evidencePath: "/wave/repeated-restarts/f01.json", int: createRng(9).int });

  it("keeps the planned steps when the first replacement never becomes healthy", () => {
    const rr = build(planned);
    // The first restart failed: the server stopped and a replacement was spawned, but it never reported healthy.
    recordFirstRestart(rr, { stoppedAt: 5_400, restartedAt: 5_400, healthyAt: null }, null);
    expect(rr.planned).toEqual(planned);
    expect(rr.planned).not.toBe(planned);
    expect(rr.restarts).toEqual([{ index: 0, signal: "SIGKILL", gapMs: null, pid: 41, phaseAtStop: "ready", stopAt: 5_000,
      stoppedAt: 5_400, restartedAt: 5_400, replacementPid: null, healthyAt: null }]);
    // A replay of the failed fault fires the same gaps.
    expect(observedFaultSchedule(1_000, ["f01"], [{ faultId: "f01", kind: "RR3", holdMs: 0, startedAt: 5_000, repeatedRestart: rr }])[0]!.restartSteps)
      .toEqual(planned);
  });

  it("draws a sequence of its kind when no steps were planned", () => {
    expect(build(undefined).planned).toEqual(planRestartSteps("RR3", createRng(9).int));
  });

  it("never gives the first replacement the last one's health time", () => {
    const watched = { ...build(planned), stopOn: "recovering" as const };
    recordFirstRestart(watched, { stoppedAt: 5_400, restartedAt: 5_400, healthyAt: null }, 77);
    watched.restarts.push({ ...watched.restarts[0]!, index: 1, healthyAt: 40_000 });
    // The evidence write after the sequence sees the receipt's health: the last replacement's.
    recordFirstRestart(watched, { stoppedAt: 5_400, restartedAt: 5_400, healthyAt: 40_000 }, null);
    expect(watched.restarts[0]!.healthyAt).toBeNull();
    const gapped = build(planned);
    gapped.restarts.push({ ...gapped.restarts[0]!, index: 1, healthyAt: 40_000 });
    recordFirstRestart(gapped, { stoppedAt: 5_400, restartedAt: 5_400, healthyAt: 40_000 }, null);
    expect(gapped.restarts[0]!.healthyAt).toBeNull();
  });

  it("does not overwrite first-kill times already recorded", () => {
    const rr = build(planned);
    recordFirstRestart(rr, { stoppedAt: 5_400, restartedAt: 5_400, healthyAt: 13_000 }, 77);
    recordFirstRestart(rr, { stoppedAt: 9_999, restartedAt: 9_999, healthyAt: 99_999 }, null);
    expect(rr.restarts[0]).toMatchObject({ stoppedAt: 5_400, restartedAt: 5_400, healthyAt: 13_000, replacementPid: 77 });
  });
});

describe("runRepeatedRestarts", () => {
  it("stops each replacement its gap after it reported healthy, then starts the next", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 10_000 }, { signal: "SIGKILL", gapMs: 20_000 }, { signal: "SIGKILL", gapMs: 15_000 }];
    const fake = fakeHooks({ bootMs: 6_000, stopMs: 400 });
    const rr = record("RR3", steps);
    const result = await runRepeatedRestarts({ record: rr, steps, server: { pid: 100 }, healthyAt: fake.now(), hooks: fake.hooks });
    expect(fake.log).toEqual([
      "sleep 10000", "stop 100 SIGKILL", "start 200",
      "sleep 20000", "stop 200 SIGKILL", "start 201",
      "sleep 15000", "stop 201 SIGKILL", "start 202",
    ]);
    expect(result.server).toEqual({ pid: 202 });
    expect(rr.restarts.map(entry => [entry.index, entry.pid, entry.replacementPid, entry.phaseAtStop])).toEqual([
      [0, 100, 200, "recovering"], [1, 200, 201, "recovering"], [2, 201, 202, "recovering"]]);
    for (const [index, entry] of rr.restarts.entries()) {
      const previousHealthy = index === 0 ? 100_000 : rr.restarts[index - 1]!.healthyAt!;
      expect(entry.stopAt - previousHealthy).toBe(steps[index]!.gapMs);
      expect(entry.stoppedAt! - entry.stopAt).toBe(400);
      expect(entry.healthyAt! - entry.restartedAt!).toBe(6_000);
    }
    expect(result.healthyAt).toBe(rr.restarts[2]!.healthyAt);
  });

  it("sends SIGTERM for a graceful step (RR2)", async () => {
    const steps: RestartStep[] = [{ signal: "SIGTERM", gapMs: 3_000 }];
    const fake = fakeHooks();
    const rr = record("RR2", steps);
    await runRepeatedRestarts({ record: rr, steps, server: { pid: 100 }, healthyAt: fake.now(), hooks: fake.hooks });
    expect(fake.log).toEqual(["sleep 3000", "stop 100 SIGTERM", "start 200"]);
    expect(rr.restarts[0]!.signal).toBe("SIGTERM");
  });

  it("does not wait when the gap already passed (the health check returned late)", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 3_000 }];
    const fake = fakeHooks();
    await runRepeatedRestarts({ record: record("RR1", steps), steps, server: { pid: 100 }, healthyAt: fake.now() - 5_000, hooks: fake.hooks });
    expect(fake.log).toEqual(["stop 100 SIGKILL", "start 200"]);
  });

  it("fails, with what fired recorded, when a replacement exits on its own during a gap", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 10_000 }, { signal: "SIGKILL", gapMs: 10_000 }];
    const fake = fakeHooks({ exitDuringGap: 200 });
    const rr = record("RR3", steps);
    await expect(runRepeatedRestarts({ record: rr, steps, server: { pid: 100 }, healthyAt: fake.now(), hooks: fake.hooks }))
      .rejects.toThrow(/exited on its own before repeated restart 1/);
    expect(rr.restarts).toHaveLength(1);
    expect(fake.log).not.toContain("stop 200 SIGKILL");
  });

  it("stops at harness shutdown without starting another replacement", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 1_000 }, { signal: "SIGKILL", gapMs: 1_000 }];
    const fake = fakeHooks({ cancelAfterStops: 1 });
    await expect(runRepeatedRestarts({ record: record("RR3", steps), steps, server: { pid: 100 }, healthyAt: fake.now(), hooks: fake.hooks }))
      .rejects.toThrow(/shutdown/);
    expect(fake.log).toEqual(["sleep 1000", "stop 100 SIGKILL"]);
  });
});

describe("runRepeatedRestarts with --rr-stop-on recovering", () => {
  it("stops each replacement on its first recovering status, with no gap, and waits for health only on the last", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 12_000 }, { signal: "SIGKILL", gapMs: 25_000 }];
    const fake = fakeHooks();
    const watched: number[] = [];
    let healthChecks = 0;
    const hooks = { ...fake.hooks,
      waitForStopPhase: async (server: { pid: number }, target: "recovering") => { watched.push(server.pid); await fake.hooks.sleep(150); return target; },
      waitHealthy: async () => { healthChecks += 1; return fake.hooks.waitHealthy(); } };
    const rr = record("RR3", steps);
    const result = await runRepeatedRestarts({ record: rr, steps, server: { pid: 100 }, healthyAt: fake.now(), hooks, stopOn: "recovering" });
    expect(watched).toEqual([100, 200]);
    expect(fake.log).toEqual(["sleep 150", "stop 100 SIGKILL", "start 200", "sleep 150", "stop 200 SIGKILL", "start 201"]);
    expect(healthChecks).toBe(1);
    expect(rr.restarts.map(entry => [entry.phaseAtStop, entry.gapMs, entry.replacementPid])).toEqual([["recovering", null, 200], ["recovering", null, 201]]);
    expect(rr.restarts[0]!.healthyAt).toBeNull();
    expect(rr.restarts[1]!.healthyAt).toBe(result.healthyAt);
  });

  it("uses the status the first replacement fired on from spawn, without waiting for its health", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 12_000 }, { signal: "SIGKILL", gapMs: 25_000 }];
    const fake = fakeHooks();
    const first = { pid: 100 };
    const watched: number[] = [];
    const watch = async (server: { pid: number }) => { watched.push(server.pid); return "recovering"; };
    const rr = record("RR3", steps);
    // The first kill's restart watched pid 100 from spawn and saw `recovering`; health was never awaited.
    await runRepeatedRestarts({ record: rr, steps, server: first, healthyAt: fake.now(), stopOn: "recovering",
      hooks: { ...fake.hooks, waitForStopPhase: stopPhaseWatcher(first, "recovering", watch) } });
    expect(watched).toEqual([200]);
    expect(rr.restarts.map(entry => entry.phaseAtStop)).toEqual(["recovering", "recovering"]);
    expect(fake.log).toEqual(["stop 100 SIGKILL", "start 200", "stop 200 SIGKILL", "start 201"]);
  });

  it("uses the first status once, and watches the first server when none was recorded", async () => {
    const first = { pid: 100 };
    const watch = async () => "ready";
    const cached = stopPhaseWatcher(first, "recovering", watch);
    expect(await cached(first, "recovering")).toBe("recovering");
    expect(await cached(first, "recovering")).toBe("ready");
    expect(await stopPhaseWatcher(first, undefined, watch)(first, "recovering")).toBe("ready");
  });

  it("records `ready` when recovery was too short to see", async () => {
    const steps: RestartStep[] = [{ signal: "SIGTERM", gapMs: 5_000 }];
    const fake = fakeHooks();
    const rr = record("RR2", steps);
    await runRepeatedRestarts({ record: rr, steps, server: { pid: 100 }, healthyAt: fake.now(), stopOn: "recovering",
      hooks: { ...fake.hooks, waitForStopPhase: async () => "ready" } });
    expect(rr.restarts[0]!.phaseAtStop).toBe("ready");
    expect(fake.log).toEqual(["stop 100 SIGTERM", "start 200"]);
  });

  it("fails when the replacement exits before it reports a status", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 1_000 }];
    const fake = fakeHooks();
    await expect(runRepeatedRestarts({ record: record("RR1", steps), steps, server: { pid: 100 }, healthyAt: fake.now(), stopOn: "recovering",
      hooks: { ...fake.hooks, waitForStopPhase: async () => { throw new Error("Paperclip server exited during the crash loop"); } } }))
      .rejects.toThrow(/exited/);
    expect(fake.log).toEqual([]);
  });

  it("refuses to run without a phase watcher", async () => {
    const steps: RestartStep[] = [{ signal: "SIGKILL", gapMs: 1_000 }];
    const fake = fakeHooks();
    await expect(runRepeatedRestarts({ record: record("RR1", steps), steps, server: { pid: 100 }, healthyAt: fake.now(), stopOn: "recovering",
      hooks: fake.hooks })).rejects.toThrow(/phase watcher/);
  });
});

describe("grading a repeated restart as one fault", () => {
  it("crosses a task with one fault window from the first kill to the last replacement's ready", () => {
    const receipt = {
      faultId: "f01", kind: "RR3", requestedBy: "t01", signal: "SIGKILL", holdMs: 0, requestedAt: 10_000, startedAt: 10_000,
      stoppedAt: 10_500, restartedAt: 10_500, healthyAt: 90_000, readyAt: 95_000, phases: [], serverLogOffsetAtStart: 0,
      serverLogOffsetAtReady: 0, error: null,
    } satisfies FaultReceipt;
    // A run that started between the first and the last kill overlaps the one window.
    const task = { plan: { taskId: "t02" }, createdAt: 50_000, restAt: 200_000, samples: [{ at: 60_000, reachable: true, serverReady: false,
      runs: [{ id: "r1", status: "succeeded", createdAt: new Date(50_000).toISOString(), startedAt: null,
        finishedAt: new Date(70_000).toISOString(), errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null }] }] } as unknown as TaskRecord;
    expect(crossingFaults(task, [receipt])).toEqual(["f01"]);
  });
});
