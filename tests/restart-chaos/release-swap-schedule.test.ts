import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { planWave } from "./scheduler.js";
import { OVERLAP_LAUNCH_READY_MARGIN_MS, ReleaseSwapRun, RELEASE_SWAP_DEFAULTS, RELEASE_SWAP_SHORT, expandReleaseSwapArgs, overlapLaunchExtensionMs, planReleaseSwaps, swapDueAt } from "./release-swap-schedule.js";

describe("release swap options", () => {
  it("expands the defaults into a storm of overlapping K15 swaps", () => {
    const { args, releaseSwap } = expandReleaseSwapArgs(["--env", "local", "--release-swap"]);
    expect(releaseSwap).toEqual(RELEASE_SWAP_DEFAULTS);
    expect(releaseSwap).toMatchObject({ swaps: 6, spacingMs: 40 * 60_000, overlapMs: 510_000, settleMs: 15 * 60_000 });
    expect(args).toEqual(["--env", "local", "--storm-minutes", "240", "--faults", "K15", "--k15-overlap-seconds", "510"]);
  });

  it("takes the smoke shape and the staging volume-free shape on Daytona", () => {
    const { args, releaseSwap } = expandReleaseSwapArgs(["--env=daytona", "--release-swap", "--release-swap-count", "2",
      "--release-swap-spacing-minutes=5", "--release-swap-overlap-seconds", "90", "--release-swap-settle-minutes", "2"]);
    expect(releaseSwap).toEqual({ swaps: 2, spacingMs: 300_000, overlapMs: 90_000, settleMs: 120_000 });
    expect(args).toEqual(["--env=daytona", "--storm-minutes", "10", "--faults", "K15", "--k15-overlap-seconds", "90", "--k15-fresh-home", "--ephemeral-server"]);
  });

  it("takes the short hourly preset: 3 swaps 12 minutes apart with the full two-server overlap, and lets flags override it", () => {
    const { args, releaseSwap } = expandReleaseSwapArgs(["--env", "local", "--release-swap-short"]);
    expect(releaseSwap).toEqual({ swaps: 3, spacingMs: 720_000, overlapMs: 510_000, settleMs: 900_000 });
    expect(args).toEqual(["--env", "local", "--storm-minutes", "36", "--faults", "K15", "--k15-overlap-seconds", "510"]);
    expect(expandReleaseSwapArgs(["--release-swap-short", "--release-swap-settle-minutes", "5"]).releaseSwap).toMatchObject({ swaps: 3, settleMs: 300_000 });
    expect(() => expandReleaseSwapArgs(["--release-swap-short", "--release-swap-overlap-seconds", "601"])).toThrow(/between 30 and 600/);
    expect(() => expandReleaseSwapArgs(["--release-swap-short", "--release-swap-spacing-minutes", "10"])).toThrow(/spacing/);
    const run = new ReleaseSwapRun(planReleaseSwaps(releaseSwap!), 0);
    expect(run.commit(run.due(720_000)!, 720_000)).toBe(true);
    expect(run.due(1_440_000)).toBeNull();
    run.settled(1_500_000);
    expect(run.due(1_500_000)).toBe(run.plan.faults[1]);
  });

  it("drives a staging-mix workload's slots on the swap clock instead of a storm", () => {
    const { args, releaseSwap } = expandReleaseSwapArgs(["--env", "daytona", "--workload", "staging-mix", "--release-swap", "--release-swap-count", "2",
      "--release-swap-spacing-minutes", "5", "--release-swap-overlap-seconds", "120", "--release-swap-settle-minutes", "2"]);
    expect(releaseSwap).toEqual({ swaps: 2, spacingMs: 300_000, overlapMs: 120_000, settleMs: 120_000 });
    expect(args).toEqual(["--env", "daytona", "--workload", "staging-mix", "--mix-fault-spacing-minutes", "5", "--mix-minutes", "11",
      "--faults", "K15", "--k15-overlap-seconds", "120", "--k15-fresh-home", "--ephemeral-server"]);
    expect(() => expandReleaseSwapArgs(["--workload", "staging-mix", "--release-swap", "--mix-minutes", "30"])).toThrow(/--mix-minutes/);
    const longest = ["--workload", "staging-mix", "--release-swap", "--release-swap-count", "6", "--release-swap-spacing-minutes"];
    expect(() => expandReleaseSwapArgs([...longest, "100"])).toThrow(/--release-swap-count 6 × --release-swap-spacing-minutes 100 needs a 601-minute staging-mix wave; the longest is 600/);
    expect(expandReleaseSwapArgs([...longest, "99"]).args).toEqual(expect.arrayContaining(["--mix-minutes", "595"]));
    const command = parseCommand(["--env", "local", "--storage", "s3", "--workload", "staging-mix", "--mix-tasks", "6", "--mix-runs", "4", "--mix-queue", "2",
      "--mix-turn-minutes", "5", "--seed", "7", "--release-swap", "--release-swap-count", "2", "--release-swap-spacing-minutes", "5",
      "--release-swap-overlap-seconds", "120", "--release-swap-settle-minutes", "2"], 0);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ faults: ["K15"], k15HoldMs: [120_000, 120_000], releaseSwap: { swaps: 2 },
      stagingMix: { faultSpacingMinutes: 5, minutes: 11, runs: 4, queue: 2, tasks: 6 } });
    expect(command.options.stormMinutes).toBeUndefined();
  });

  it("refuses flags the cell plans itself, stray shape flags, and an overlap the spacing cannot hold", () => {
    expect(() => expandReleaseSwapArgs(["--release-swap", "--faults", "K1"])).toThrow(/--faults/);
    expect(() => expandReleaseSwapArgs(["--release-swap-count", "2"])).toThrow(/add --release-swap/);
    expect(() => expandReleaseSwapArgs(["--release-swap", "--release-swap-overlap-seconds", "601"])).toThrow(/between 30 and 600/);
    expect(() => expandReleaseSwapArgs(["--release-swap", "--release-swap-spacing-minutes", "9", "--release-swap-overlap-seconds", "510"])).toThrow(/spacing/);
    expect(expandReleaseSwapArgs(["--env", "local"])).toEqual({ args: ["--env", "local"] });
  });

  it("parses into a storm wave whose tasks the swaps cross", () => {
    const command = parseCommand(["--env", "local", "--adapters", "codex", "--workloads", "A1", "--seed", "7", "--release-swap",
      "--release-swap-count", "2", "--release-swap-spacing-minutes", "5", "--release-swap-overlap-seconds", "90", "--tasks", "4"], 0);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ faults: ["K15"], k15Overlap: true, k15HoldMs: [90_000, 90_000], stormMinutes: 10,
      releaseSwap: { swaps: 2, spacingMs: 300_000, overlapMs: 90_000, settleMs: 15 * 60_000 } });
    const plan = planWave("w-20261112T000000-s7", command.options);
    expect(plan.storm).toEqual(planReleaseSwaps(command.options.releaseSwap!));
    expect(plan.tasks.every(task => task.fault === "K13")).toBe(true);
  });
});

describe("release swap scheduler", () => {
  const plan = planReleaseSwaps({ swaps: 3, spacingMs: 600_000, overlapMs: 90_000, settleMs: 60_000 });

  it("fires each swap on the spacing clock from the wave start, never while one is unsettled", () => {
    const run = new ReleaseSwapRun(plan, 0);
    expect(run.due(599_999)).toBeNull();
    const first = run.due(600_000)!;
    expect(first).toMatchObject({ kind: "K15", holdMs: 90_000 });
    expect(run.commit(first, 600_000)).toBe(true);
    expect(run.due(1_300_000)).toBeNull();
    run.settled(800_000);
    expect(run.due(1_199_999)).toBeNull();
    expect(run.due(1_200_000)).toBe(plan.faults[1]);
    expect(swapDueAt(0, 600_000, 2)).toBe(1_800_000);
  });

  it("keeps launching until the last swap settled, then drains", () => {
    const run = new ReleaseSwapRun(plan, 0);
    for (let index = 0; index < 3; index += 1) {
      const at = swapDueAt(0, 600_000, index);
      expect(run.mayLaunch(at)).toBe(true);
      expect(run.endIfDue(at)).toBe(false);
      expect(run.commit(run.due(at)!, at)).toBe(true);
      if (index < 2) run.settled(at + 200_000);
    }
    expect(run.endIfDue(5_000_000)).toBe(false);
    expect(run.exhaustedEarly(5_000_000)).toBe(true);
    run.settled(2_000_000);
    expect(run.due(9_000_000)).toBeNull();
    expect(run.endIfDue(2_000_001)).toBe(true);
    expect(run.mayLaunch(2_000_001)).toBe(false);
    expect(run.exhaustedEarly(2_000_001)).toBe(false);
    expect(run.endIfDue(2_000_002)).toBe(false);
  });

  it("reports no task-pool shortfall once every swap settled, even before the drain is noticed", () => {
    const run = new ReleaseSwapRun(plan, 0);
    for (let index = 0; index < 3; index += 1) {
      const at = swapDueAt(0, 600_000, index);
      run.commit(run.due(at)!, at);
      run.settled(at + 100_000);
    }
    expect(run.ended).toBe(false);
    expect(run.exhaustedEarly(2_000_000)).toBe(false);
  });

  it("extends a task launched during the overlap by the time it overlapped the swap, for the full and short presets", () => {
    for (const preset of [RELEASE_SWAP_DEFAULTS, RELEASE_SWAP_SHORT]) {
      const switchedAt = 1_000_000;
      const stoppedAt = switchedAt + preset.overlapMs + 2_000;
      expect(overlapLaunchExtensionMs(switchedAt, stoppedAt)).toBe(preset.overlapMs + 2_000 + OVERLAP_LAUNCH_READY_MARGIN_MS);
      expect(overlapLaunchExtensionMs(stoppedAt - 20_000, stoppedAt)).toBe(20_000 + OVERLAP_LAUNCH_READY_MARGIN_MS);
      expect(preset.overlapMs).toBeGreaterThanOrEqual(510_000);
    }
  });

  it("does not commit a swap that is not due", () => {
    const run = new ReleaseSwapRun(plan, 0);
    expect(run.commit(plan.faults[0]!, 10)).toBe(false);
    expect(run.state.fired).toBe(0);
  });
});
