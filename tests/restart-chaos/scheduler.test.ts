import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCommand, parseReplayRef, waveIdFor, publicGitHubUrl } from "./config.js";
import { chaosLifecycleOverrides } from "./seed.js";
import { K4_HOLD_RANGE_MS, STORM_GAP_RANGE_MS, createRng, observedFaultSchedule, planStorm, planTasks, planWave, replayWave,
  StormRun, stormActive, stormFaultDue, taskFaultSchedule, type StormState } from "./scheduler.js";
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

  it("fires every planned fault at --fault-after-seconds without changing the rest of the seeded plan", () => {
    const base = parseCommand(["--faults", "K1,K2", "--tasks", "6", "--seed", "77"]);
    const pinned = parseCommand(["--faults", "K1,K2", "--tasks", "6", "--seed", "77", "--fault-after-seconds", "150"]);
    if (base.mode !== "wave" || pinned.mode !== "wave") throw new Error("expected a wave");
    expect(pinned.options.faultAfterMs).toBe(150_000);
    const planned = planTasks(pinned.options);
    expect(planned.map(task => task.fireAfterMs)).toEqual(Array(6).fill(150_000));
    expect(planned.map(({ fireAfterMs: _fire, ...rest }) => rest)).toEqual(planTasks(base.options).map(({ fireAfterMs: _fire, ...rest }) => rest));
    expect(() => parseCommand(["--fault-after-seconds", "2"])).toThrow(/fault-after-seconds/);
    expect(() => parseCommand(["--storm-minutes", "10", "--fault-after-seconds", "60"])).toThrow(/storm/);
    expect(() => parseCommand(["--triggers", "time,comment", "--fault-after-seconds", "60"])).toThrow(/--triggers time/);
  });

  it("keeps the plans existing seeds produce for triggered and storm waves", () => {
    const triggered = planTasks({ seed: 4242, tasks: 4, workloads: ["A1", "C1"], adapters: ["codex", "claude"], faults: ["K1", "K2"],
      triggers: ["time", "comment", "result"] } as never);
    expect(triggered.map(task => [task.trigger ?? "time", task.triggerDelayMs ?? null, task.fireAfterMs, task.nonce])).toEqual([
      ["time", null, 36292, "d3a12313"], ["time", null, 14380, "37697e51"], ["comment", 4272, 23204, "a5d0f179"], ["time", null, 51015, "b9f3ef15"]]);
    const storm = planTasks({ seed: 4242, tasks: 3, workloads: ["A1"], adapters: ["codex"], faults: ["K1"], triggers: ["time"], stormMinutes: 10 } as never);
    expect(storm.map(task => [task.fault, task.fireAfterMs, task.nonce])).toEqual([["K13", 0, "84e8a446"], ["K13", 0, "59bc9f5c"], ["K13", 0, "d3a12313"]]);
  });

  it("raises the K4 hold upper end with --k4-hold-max-seconds, up to the 600 s outage cap", () => {
    const command = parseCommand(["--faults", "K4", "--k4-hold-max-seconds", "600", "--seed", "5"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.k4HoldMaxMs).toBe(600_000);
    const holds = planTasks({ ...command.options, tasks: 40 }).map(task => task.holdMs);
    expect(Math.min(...holds)).toBeGreaterThanOrEqual(K4_HOLD_RANGE_MS[0]);
    expect(Math.max(...holds)).toBeLessThanOrEqual(600_000);
    expect(Math.max(...holds)).toBeGreaterThan(K4_HOLD_RANGE_MS[1]);
    const storm = planStorm(5, 120, ["K4"], 600_000);
    expect(Math.max(...storm.faults.map(fault => fault.holdMs))).toBeGreaterThan(K4_HOLD_RANGE_MS[1]);
    const single = parseCommand(["--adapters", "codex", "--seed", "5"]), both = parseCommand(["--seed", "5"]);
    if (single.mode !== "wave" || both.mode !== "wave") throw new Error("expected a wave");
    expect(single.options.workloads).not.toContain("M1");
    expect(both.options.workloads).toContain("M1");
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "M1"])).toThrow(/two agents/);
    const stored = parseCommand(["--storage", "s3", "--seed", "5"]);
    if (stored.mode !== "wave") throw new Error("expected a wave");
    expect(stored.options.storage).toBe("s3");
    expect(both.options.storage).toBeUndefined();
    expect(() => parseCommand(["--storage", "gcs"])).toThrow(/local or s3/);
    const faulted = parseCommand(["--storage", "s3", "--storage-faults", "ST1,ST3", "--seed", "5"]);
    if (faulted.mode !== "wave") throw new Error("expected a wave");
    expect(faulted.options.storageFaults).toEqual(["ST1", "ST3"]);
    expect(() => parseCommand(["--storage-faults", "ST1"])).toThrow(/needs --storage s3/);
    const short = parseCommand(["--storage", "s3", "--storage-faults", "ST1", "--storage-fault-seconds", "15-45", "--seed", "5"]);
    if (short.mode !== "wave") throw new Error("expected a wave");
    expect(short.options.storageFaultMs).toEqual([15_000, 45_000]);
    expect(() => parseCommand(["--storage", "s3", "--storage-faults", "ST1", "--storage-fault-seconds", "45-15"])).toThrow(/storage-fault-seconds/);
    expect(() => parseCommand(["--storage", "s3", "--storage-fault-seconds", "15-45"])).toThrow(/needs --storage-faults/);
    const repo = mkdtempSync(path.join(os.tmpdir(), "restart-chaos-origin-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
    git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    git("remote", "add", "origin", "git@github.com:acme/widget.git");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    const masterCommit = git("rev-parse", "HEAD");
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", "ghcr.io/x/y@sha256:" + "a".repeat(64), "--workloads", "R1", "--workspace-repo", repo]))
      .toThrow(/needs --storage s3/);
    const daytonaR1 = parseCommand(["--env", "daytona", "--daytona-image", "ghcr.io/x/y@sha256:" + "a".repeat(64), "--workloads", "R1",
      "--workspace-repo", repo, "--storage", "s3", "--seed", "5"]);
    if (daytonaR1.mode !== "wave") throw new Error("expected a wave");
    expect(daytonaR1.options).toMatchObject({ env: "daytona", storage: "s3", workloads: ["R1"] });
    expect(daytonaR1.options).toMatchObject({ workspaceGitUrl: "https://github.com/acme/widget.git", workspaceCommit: masterCommit });
    rmSync(repo, { recursive: true, force: true });
    expect(publicGitHubUrl("git@github.com:paperclipai/paperclip.git")).toBe("https://github.com/paperclipai/paperclip.git");
    expect(publicGitHubUrl("https://github.com/paperclipai/paperclip")).toBe("https://github.com/paperclipai/paperclip.git");
    expect(() => publicGitHubUrl("/Users/me/repo")).toThrow(/GitHub origin/);
    expect(() => parseCommand(["--k4-hold-max-seconds", "601"])).toThrow(/between 120 and 600/);
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--k4-hold-max-seconds", "400"])).toThrow(/do not combine/);
  });

  it("pairs R1 with --workspace-repo, locally, without the chaoscli fixture workloads", () => {
    const command = parseCommand(["--workloads", "R1,C1", "--workspace-repo", "."]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workspaceRepo).toBe(process.cwd());
    expect(command.options.workspaceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(() => parseCommand(["--workloads", "R1"])).toThrow(/go together/);
    expect(() => parseCommand(["--workloads", "A1", "--workspace-repo", "x"])).toThrow(/go together/);
    expect(() => parseCommand(["--workloads", "R1,B1", "--workspace-repo", "x"])).toThrow(/chaoscli fixture/);
    const defaults = parseCommand([]);
    if (defaults.mode !== "wave") throw new Error("expected a wave");
    expect(defaults.options.workloads).not.toContain("R1");
  });

  it("pairs K14 (upgrade mid-run) with --upgrade-from, locally, with no hold and outside storm defaults", () => {
    const command = parseCommand(["--faults", "K14", "--upgrade-from", "../older-checkout", "--seed", "5"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.upgradeFrom).toMatch(/older-checkout$/);
    expect(command.options.upgradeFrom!.startsWith("/")).toBe(true);
    expect(planTasks(command.options).every(task => task.fault === "K14" && task.holdMs === 0)).toBe(true);
    expect(() => parseCommand(["--faults", "K14"])).toThrow(/go together/);
    expect(() => parseCommand(["--faults", "K1", "--upgrade-from", "../older-checkout"])).toThrow(/go together/);
    expect(() => parseCommand(["--faults", "K14", "--upgrade-from", "x", "--env", "daytona",
      "--daytona-image", `ghcr.io/x/y@sha256:${"a".repeat(64)}`])).toThrow(/only with --env local/);
    const storm = parseCommand(["--storm-minutes", "30"]);
    if (storm.mode !== "wave") throw new Error("expected a wave");
    expect(storm.options.faults).not.toContain("K14");
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--upgrade-from", "x"])).toThrow(/do not combine/);
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

  it("keeps the source wave's masks on replay and lets --rc06-masked add the RC-06 mask", () => {
    const masked = planWave("w-20261106T101112-s42", { ...plan.options, masks: ["rc06"] });
    expect(replayWave(masked, { waveId: masked.waveId, taskId: "t01" }, 1).options.masks).toEqual(["rc06"]);
    expect(replayWave(plan, { waveId: plan.waveId, taskId: "t01" }, 1).options.masks).toBeUndefined();
    const command = parseCommand(["--replay", `${plan.waveId}/t01`, "--rc06-masked"]);
    if (command.mode !== "replay") throw new Error("expected replay");
    expect(command.overrides.masks).toEqual(["rc06"]);
    expect(replayWave(plan, { waveId: plan.waveId, taskId: "t01" }, 1, command.overrides).options.masks).toEqual(["rc06"]);
    expect(replayWave(masked, { waveId: masked.waveId, taskId: "t01" }, 1, command.overrides).options.masks).toEqual(["rc06"]);
    const wave = parseCommand(["--rc06-masked", "--seed", "3"]);
    if (wave.mode !== "wave") throw new Error("expected wave");
    expect(wave.options.masks).toEqual(["rc06"]);
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

  it("carries a forced runner lifecycle in the plan options", () => {
    expect(parseCommand(["--lifecycle", "warm", "--seed", "1"])).toMatchObject({ mode: "wave", options: { lifecycle: "warm" } });
    expect(parseCommand(["--seed", "1"])).not.toHaveProperty("options.lifecycle");
    expect(() => parseCommand(["--lifecycle", "sometimes"])).toThrow(/per_turn, warm or default/);
    expect(parseCommand(["--lifecycle", "default", "--seed", "1"])).toMatchObject({ mode: "wave", options: { lifecycle: "default" } });
    // default drops the catalog's pinned lifecycle from the created agent.
    expect(JSON.parse(JSON.stringify({ lifecycleMode: "per_turn", model: "m", ...chaosLifecycleOverrides("default") }))).toEqual({ model: "m" });
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--lifecycle", "warm"])).toThrow(/reproduces the saved plan/);
    expect(chaosLifecycleOverrides("warm")).toEqual({ lifecycleMode: "warm", idleTimeoutMs: 300_000 });
    expect(chaosLifecycleOverrides(undefined)).toBeUndefined();
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

describe("Daytona options", () => {
  const image = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`;
  it("defaults to 4 vCPU sandboxes, excludes B5, and keeps the image in the plan", () => {
    const parsed = parseCommand(["--env", "daytona", "--daytona-image", image, "--concurrency", "10"]);
    expect(parsed).toMatchObject({ mode: "wave", options: { daytonaImage: image, daytonaCpu: 4, concurrency: 10 } });
    if (parsed.mode === "wave") expect(parsed.options.workloads).not.toContain("B5");
  });
  it("refuses waves over the 40 vCPU chaos budget, mutable images, and Daytona flags without Daytona", () => {
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", image, "--concurrency", "11"])).toThrow(/exceeds the Daytona vCPU budget of 40/);
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", "ghcr.io/x/y:latest"])).toThrow(/immutable runner image/);
    expect(() => parseCommand(["--env", "local", "--daytona-cpu", "2"])).toThrow(/only to --env daytona/);
    expect(() => parseCommand(["--env", "local", "--daytona-reuse-lease"])).toThrow(/only to --env daytona/);
  });
  it("starts sandboxes from a pack-mismatched image while the controller keeps the matched pack", () => {
    const older = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"b".repeat(64)}`;
    expect(parseCommand(["--env", "daytona", "--daytona-image", image, "--daytona-pack-mismatch", older]))
      .toMatchObject({ mode: "wave", options: { daytonaImage: image, daytonaSandboxImage: older } });
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", image, "--daytona-pack-mismatch", image])).toThrow(/different image/);
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", image, "--daytona-pack-mismatch", "ghcr.io/x/y:old"])).toThrow(/immutable image/);
    expect(() => parseCommand(["--env", "local", "--daytona-pack-mismatch", older])).toThrow(/only to --env daytona/);
  });
  it("counts every task's sandbox against the budget when warm sandboxes outlive their task", () => {
    const wave = (...extra: string[]) => parseCommand(["--env", "daytona", "--daytona-image", image, "--tasks", "20", "--concurrency", "4", ...extra]);
    expect(() => wave("--daytona-warm")).toThrow(/--daytona-warm keeps each task's sandbox.*20 tasks/);
    expect(() => wave("--daytona-inherit", "--lifecycle", "warm")).toThrow(/--daytona-inherit with --lifecycle warm keeps each task's sandbox/);
    // --lifecycle default leaves the lifecycle unset everywhere; Daytona keeps reusable leases, so the run defaults to warm.
    expect(() => wave("--daytona-inherit", "--lifecycle", "default")).toThrow(/--daytona-inherit with --lifecycle default keeps each task's sandbox/);
    // The catalog agents pin per-turn, so an inheriting environment alone releases each sandbox after its turn.
    expect(wave("--daytona-inherit")).toMatchObject({ mode: "wave", options: { daytonaInherit: true, tasks: 20 } });
    expect(wave("--daytona-inherit", "--lifecycle", "per_turn")).toMatchObject({ mode: "wave" });
    expect(() => wave("--daytona-warm", "--daytona-inherit")).toThrow(/cannot be combined/);
    expect(() => parseCommand(["--env", "local", "--daytona-warm"])).toThrow(/only to --env daytona/);
    expect(() => parseCommand(["--env", "local", "--daytona-inherit"])).toThrow(/only to --env daytona/);
  });
  it("keeps reusable Daytona leases only when asked", () => {
    const reuse = parseCommand(["--env", "daytona", "--daytona-image", image, "--daytona-reuse-lease"]);
    expect(reuse).toMatchObject({ mode: "wave", options: { daytonaReuseLease: true } });
    const plain = parseCommand(["--env", "daytona", "--daytona-image", image]);
    if (plain.mode === "wave") expect(plain.options.daytonaReuseLease).toBeUndefined();
  });
});

describe("K13 restart storm", () => {
  const stormOptions: WaveOptions = { ...options, faults: ["K1", "K2", "K4", "K6"], tasks: 40, concurrency: 6, stormMinutes: 60 };

  it("plans a seeded storm of 2–4 minute gaps drawn from the chosen faults that fills the duration", () => {
    const storm = planStorm(42, 60, stormOptions.faults);
    expect(planStorm(42, 60, stormOptions.faults)).toEqual(storm);
    expect(storm.durationMs).toBe(3_600_000);
    const gaps = storm.faults.map(fault => fault.gapMs);
    expect(gaps.every(gap => gap >= STORM_GAP_RANGE_MS[0] && gap <= STORM_GAP_RANGE_MS[1])).toBe(true);
    expect(gaps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThanOrEqual(storm.durationMs);
    expect(gaps.slice(0, -1).reduce((sum, gap) => sum + gap, 0)).toBeLessThan(storm.durationMs);
    for (const fault of storm.faults) {
      expect(stormOptions.faults).toContain(fault.kind);
      if (fault.kind === "K4") expect(fault.holdMs).toBeGreaterThanOrEqual(K4_HOLD_RANGE_MS[0]);
      else expect(fault.holdMs).toBe(0);
    }
    expect(new Set(storm.faults.map(fault => fault.kind)).size).toBeGreaterThan(1);
  });

  it("lets result-trigger tasks join a storm with their own K1 or K2, while time cells stay K13", () => {
    const tasks = planTasks({ ...stormOptions, tasks: 36, triggers: ["time", "result"] });
    const result = tasks.filter(task => task.trigger === "result");
    expect(result.length).toBeGreaterThan(0);
    for (const task of result) {
      expect(task.workload).toBe("C1");
      expect(["K1", "K2"]).toContain(task.fault);
      expect(taskFaultSchedule(task)).toEqual([{ kind: task.fault, holdMs: 0, atMs: task.fireAfterMs, trigger: "result", delayMs: task.triggerDelayMs }]);
    }
    for (const task of tasks.filter(candidate => candidate.trigger === undefined)) expect(task.fault).toBe("K13");
    expect(() => planTasks({ ...stormOptions, faults: ["K4", "K6"], triggers: ["result"], workloads: ["C1"] })).toThrow(/needs K1 or K2/);
    // A plain wave keeps its plan for a seed.
    expect(planTasks({ ...options, triggers: ["time"] })).toEqual(planTasks({ ...options, triggers: undefined }));
  });

  it("gives storm tasks no fault of their own", () => {
    const plan = planWave("w-20261106T101112-s42", stormOptions);
    expect(plan.storm?.faults.length).toBeGreaterThan(10);
    expect(plan.tasks).toHaveLength(40);
    for (const task of plan.tasks) {
      expect(task.fault).toBe("K13");
      expect(taskFaultSchedule(task)).toEqual([]);
    }
    expect(planWave("w-20261106T101112-s42", options).storm).toBeUndefined();
    expect(() => planTasks({ ...stormOptions, triggers: ["comment"], workloads: ["C1"] })).toThrow(/own clock/);
  });

  it("fires each fault after its gap from the previous fault settling, and stops when the storm ends", () => {
    const storm = { durationMs: 600_000, faults: [{ kind: "K1" as const, holdMs: 0, gapMs: 120_000 },
      { kind: "K4" as const, holdMs: 200_000, gapMs: 180_000 }, { kind: "K2" as const, holdMs: 0, gapMs: 120_000 }] };
    const state: StormState = { startedAt: 0, fired: 0, lastSettledAt: null };
    expect(stormFaultDue(storm, state, 119_999)).toBeNull();
    expect(stormFaultDue(storm, state, 120_000)).toEqual(storm.faults[0]);
    state.fired = 1; state.lastSettledAt = 150_000;
    expect(stormFaultDue(storm, state, 329_999)).toBeNull();
    expect(stormFaultDue(storm, state, 330_000)).toEqual(storm.faults[1]);
    // The K4 hold settles late; the next gap runs from then, not from when it fired.
    state.fired = 2; state.lastSettledAt = 560_000;
    expect(stormActive(storm, state, 599_999)).toBe(true);
    expect(stormFaultDue(storm, state, 599_999)).toBeNull();
    expect(stormActive(storm, state, 600_000)).toBe(false);
    expect(stormFaultDue(storm, state, 700_000)).toBeNull();
    state.fired = 3;
    expect(stormFaultDue({ ...storm, durationMs: 10_000_000 }, state, 9_000_000)).toBeNull();
  });

  it("rechecks the storm clock after slow work: no launch and no fault once the storm has ended", () => {
    const storm = { durationMs: 300_000, faults: [{ kind: "K1" as const, holdMs: 0, gapMs: 120_000 }, { kind: "K2" as const, holdMs: 0, gapMs: 120_000 }] };
    const state: StormState = { startedAt: 0, fired: 1, lastSettledAt: 170_000 };
    expect(stormActive(storm, state, 299_999)).toBe(true);
    expect(stormActive(storm, state, 300_000)).toBe(false);
    // A fault selected before the end, with pre-fault snapshots finishing after it, no longer fires.
    const due = stormFaultDue(storm, state, 295_000);
    expect(due).toEqual(storm.faults[1]);
    expect(stormFaultDue(storm, state, 295_500)).toBe(due);
    expect(stormFaultDue(storm, state, 301_000)).toBeNull();
  });

  it("drives the wave loop's storm decisions with a fresh clock across slow awaits", () => {
    const plan = { durationMs: 300_000, faults: [{ kind: "K1" as const, holdMs: 0, gapMs: 120_000 }, { kind: "K2" as const, holdMs: 0, gapMs: 120_000 }] };
    const run = new StormRun(plan, 0);
    // Iteration at 120 s: launch allowed, fault chosen, snapshots finish in time, fault committed.
    expect(run.endIfDue(120_000)).toBe(false);
    expect(run.mayLaunch(120_000)).toBe(true);
    const first = run.due(120_000)!;
    expect(run.commit(first, 121_000)).toBe(true);
    expect(run.state.fired).toBe(1);
    expect(run.due(150_000)).toBeNull(); // the next gap waits for the fault to settle
    run.settled(170_000);
    // Iteration at 295 s chooses the second fault, but the snapshots end after the storm: nothing fires.
    const second = run.due(295_000)!;
    expect(second).toEqual(plan.faults[1]);
    expect(run.commit(second, 301_000)).toBe(false);
    expect(run.state.fired).toBe(1);
    // A launch decided at 299 s but taken after ensureServing crossed the end is refused.
    expect(run.mayLaunch(299_000)).toBe(true);
    expect(run.mayLaunch(300_500)).toBe(false);
    expect(run.endIfDue(300_500)).toBe(true);
    expect(run.endIfDue(301_000)).toBe(false);
    expect(run.exhaustedEarly(301_000)).toBe(false);
  });

  it("flags a task pool that runs dry before the storm ends", () => {
    const run = new StormRun({ durationMs: 3_600_000, faults: [{ kind: "K1", holdMs: 0, gapMs: 120_000 }] }, 0);
    expect(run.exhaustedEarly(600_000)).toBe(true);
    expect(run.exhaustedEarly(3_600_000)).toBe(false);
  });

  it("parses --storm-minutes with storm defaults and keeps replays storm-free", () => {
    const parsed = parseCommand(["--storm-minutes", "60", "--concurrency", "6", "--adapters", "codex,claude,opencode", "--seed", "5"]);
    if (parsed.mode !== "wave") throw new Error("expected wave");
    expect(parsed.options).toMatchObject({ stormMinutes: 60, faults: ["K1", "K2", "K4", "K6"], tasks: 200, concurrency: 6 });
    const plain = parseCommand(["--seed", "5"]);
    if (plain.mode !== "wave") throw new Error("expected wave");
    expect(plain.options).toMatchObject({ faults: ["K1", "K2", "K4"], tasks: 8 });
    expect(plain.options.stormMinutes).toBeUndefined();
    expect(() => parseCommand(["--storm-minutes", "0"])).toThrow(/between 1 and 240/);
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--storm-minutes", "5"])).toThrow(/reproduces the saved plan/);
    const plan = planWave("w-20261106T101112-s42", stormOptions);
    const replay = replayWave(plan, { waveId: plan.waveId, taskId: "t02" }, 1, {}, [{ kind: "K6", holdMs: 0, atMs: 90_000 }]);
    expect(replay.options.stormMinutes).toBeUndefined();
    expect(replay.storm).toBeUndefined();
    expect(taskFaultSchedule(replay.tasks[0]!)).toEqual([{ kind: "K6", holdMs: 0, atMs: 90_000 }]);
  });
});
