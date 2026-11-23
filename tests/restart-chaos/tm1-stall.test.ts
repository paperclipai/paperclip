import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { planTasks } from "./scheduler.js";
import { TIME_FREEZE_HOLD_RANGE_MS, timeFaultHoldMs } from "./time-faults-config.js";

const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"d".repeat(64)}`;

describe("TM1 control-plane stall on Daytona (--tm1-hold-seconds)", () => {
  it("stalls a Daytona wave's server without a restart, for the seeded range", () => {
    const parsed = parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--faults", "TM1", "--tm1-hold-seconds", "70-120",
      "--adapters", "codex,claude,opencode", "--workloads", "A1,T1", "--tasks", "6", "--seed", "21"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(parsed.options.tm1HoldMs).toEqual([70_000, 120_000]);
    const holds = planTasks(parsed.options).map(task => task.holdMs);
    expect(holds.every(hold => hold >= 70_000 && hold <= 120_000)).toBe(true);
  });

  it("keeps the default TM1 range and every existing seed's cells without the option", () => {
    const draws: Array<[number, number]> = [];
    const int = (min: number, max: number) => { draws.push([min, max]); return min; };
    expect(timeFaultHoldMs("TM1", int)).toBe(TIME_FREEZE_HOLD_RANGE_MS.TM1[0]);
    expect(timeFaultHoldMs("TM1", int, [70_000, 120_000])).toBe(70_000);
    expect(timeFaultHoldMs("TM3", int, [70_000, 120_000])).toBe(0);
    expect(draws).toEqual([[...TIME_FREEZE_HOLD_RANGE_MS.TM1], [70_000, 120_000]]);
    const a = parseCommand(["--faults", "TM1", "--workloads", "A1", "--tasks", "3", "--seed", "4"]);
    const b = parseCommand(["--faults", "TM1", "--workloads", "A1", "--tasks", "3", "--seed", "4", "--tm1-hold-seconds", "100"]);
    if (a.mode !== "wave" || b.mode !== "wave") throw new Error("expected waves");
    const strip = (tasks: ReturnType<typeof planTasks>) => tasks.map(({ holdMs: _hold, ...rest }) => rest);
    expect(strip(planTasks(b.options))).toEqual(strip(planTasks(a.options)));
    expect(planTasks(b.options).every(task => task.holdMs === 100_000)).toBe(true);
  });

  it("keeps TM2 and TM3 local, and refuses a TM1 range without TM1 or out of bounds", () => {
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--faults", "TM1,TM3", "--workloads", "A1"])).toThrow(/TM2 and TM3 .*--env local/);
    expect(() => parseCommand(["--faults", "K2", "--tm1-hold-seconds", "90", "--workloads", "A1"])).toThrow(/add TM1/);
    expect(() => parseCommand(["--faults", "TM1", "--tm1-hold-seconds", "5", "--workloads", "A1"])).toThrow(/between 10 and 600/);
    expect(() => parseCommand(["--faults", "TM1", "--tm1-hold-seconds", "120-70", "--workloads", "A1"])).toThrow(/min not above max/);
    expect(() => parseCommand(["--replay", "w-1/t01", "--tm1-hold-seconds", "90"])).toThrow(/--replay reproduces the saved plan/);
  });
});
