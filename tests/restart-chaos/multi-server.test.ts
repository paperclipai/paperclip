import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { planTasks } from "./scheduler.js";
import {
  CONTROLLER_LEASE_TTL_MS, MS2_THAW_TAIL_MS, MULTI_SERVER_HOLD_RANGE_MS, checkCrossServer, runMultiServerFault,
  type CrossServerRun, type MultiServerHooks, type MultiServerKind, type MultiServerRecord, type ServerProcessWindow,
} from "./multi-server.js";
import { FAULT_SIGNAL } from "./supervisor.js";

describe("two-server fault options", () => {
  it("accepts MS faults locally and gives each a seeded hold in its range", () => {
    const parsed = parseCommand(["--faults", "MS1,MS2,MS3", "--adapters", "codex", "--workloads", "B5,Q1", "--seed", "3"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(parsed.options.faults).toEqual(["MS1", "MS2", "MS3"]);
    const plan = planTasks({ seed: 3, tasks: 12, workloads: ["B5"], adapters: ["codex"], faults: ["MS1", "MS2", "MS3"] });
    expect(new Set(plan.map(task => task.fault))).toEqual(new Set(["MS1", "MS2", "MS3"]));
    for (const task of plan) {
      const [min, max] = MULTI_SERVER_HOLD_RANGE_MS[task.fault as MultiServerKind];
      expect(task.holdMs).toBeGreaterThanOrEqual(min);
      expect(task.holdMs).toBeLessThanOrEqual(max);
    }
    // MS2 freezes the primary past the controller lease, so a second server may legitimately fence it.
    expect(MULTI_SERVER_HOLD_RANGE_MS.MS2[0]).toBeGreaterThan(CONTROLLER_LEASE_TTL_MS);
    expect(FAULT_SIGNAL).toMatchObject({ MS1: "none", MS2: "SIGSTOP", MS3: "SIGTERM" });
  });

  it("refuses combinations a second local server cannot serve", () => {
    expect(() => parseCommand(["--faults", "MS1", "--env", "daytona", "--daytona-image", `r/i@sha256:${"a".repeat(64)}`])).toThrow(/--env local/);
    expect(() => parseCommand(["--faults", "MS2", "--storm-minutes", "10"])).toThrow(/storm/);
    expect(() => parseCommand(["--faults", "MS3,K14", "--upgrade-from", "/tmp/x"])).toThrow(/K14/);
    expect(() => parseCommand(["--faults", "MS1,TM2", "--workloads", "B5"])).toThrow(/TM2 or TM3/);
  });
});

function fakeHooks(options: { failOn?: "start" | "freeze" | "restart"; exitAt?: number } = {}) {
  let clock = 0;
  const calls: string[] = [];
  const hooks: MultiServerHooks = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    cancelled: () => false,
    secondaryFailure: () => (options.exitAt !== undefined && clock >= options.exitAt ? "code=1 signal=null" : null),
    startSecondary: async () => { calls.push("start"); if (options.failOn === "start") throw new Error("B did not start"); },
    stopSecondary: async () => { calls.push("stop"); },
    freezePrimary: async holdMs => { calls.push(`freeze:${holdMs}`); clock += holdMs; if (options.failOn === "freeze") throw new Error("A could not be shown stopped"); },
    restartPrimary: async () => { calls.push("restart"); clock += 5_000; if (options.failOn === "restart") throw new Error("A' not ready"); },
  };
  return { hooks, calls, clock: () => clock };
}

const record = (kind: MultiServerKind): MultiServerRecord => ({ kind, secondary: null, steps: [] });

describe("runMultiServerFault", () => {
  it("MS1 keeps B beside a live A for the hold, then stops B", async () => {
    const fake = fakeHooks();
    const result = record("MS1");
    await runMultiServerFault("MS1", 90_000, result, fake.hooks);
    expect(fake.calls).toEqual(["start", "stop"]);
    expect(fake.clock()).toBe(90_000);
    expect(result.steps.map(step => step.step)).toEqual(["secondary_starting", "secondary_ready", "secondary_stopping", "secondary_stopped"]);
  });

  it("MS2 freezes A past the lease while B is up, keeps B for the thaw tail, then stops B", async () => {
    const fake = fakeHooks();
    const result = record("MS2");
    await runMultiServerFault("MS2", 120_000, result, fake.hooks);
    expect(fake.calls).toEqual(["start", "freeze:120000", "stop"]);
    expect(fake.clock()).toBe(120_000 + MS2_THAW_TAIL_MS);
    expect(result.steps.map(step => step.step)).toContain("primary_thawed");
  });

  it("MS3 restarts A (K2) while B serves, holds B's tail, then stops B", async () => {
    const fake = fakeHooks();
    await runMultiServerFault("MS3", 30_000, record("MS3"), fake.hooks);
    expect(fake.calls).toEqual(["start", "restart", "stop"]);
    expect(fake.clock()).toBe(35_000);
  });

  it("fails the fault when B exits on its own during the overlap or a freeze, and still stops it", async () => {
    const overlap = fakeHooks({ exitAt: 30_000 });
    await expect(runMultiServerFault("MS1", 90_000, record("MS1"), overlap.hooks)).rejects.toThrow(/exited before its planned stop/);
    expect(overlap.calls).toEqual(["start", "stop"]);
    expect(overlap.clock()).toBeLessThan(90_000);
    const frozen = fakeHooks({ exitAt: 50_000 });
    await expect(runMultiServerFault("MS2", 120_000, record("MS2"), frozen.hooks)).rejects.toThrow(/exited before its planned stop/);
    expect(frozen.calls.at(-1)).toBe("stop");
    const restarted = fakeHooks({ exitAt: 1_000 });
    await expect(runMultiServerFault("MS3", 0, record("MS3"), restarted.hooks)).rejects.toThrow(/exited before its planned stop/);
  });

  it.each(["start", "freeze", "restart"] as const)("stops B and fails the fault when %s fails", async failOn => {
    const fake = fakeHooks({ failOn });
    const kind: MultiServerKind = failOn === "freeze" ? "MS2" : failOn === "restart" ? "MS3" : "MS1";
    await expect(runMultiServerFault(kind, 60_000, record(kind), fake.hooks)).rejects.toThrow();
    expect(fake.calls.at(-1)).toBe("stop");
  });
});

const A: ServerProcessWindow = { pid: 100, role: "primary", spawnedAt: 0, exitedAt: null, frozen: [] };
const B: ServerProcessWindow = { pid: 200, role: "secondary", spawnedAt: 50_000, exitedAt: 300_000, frozen: [] };
const run = (overrides: Partial<CrossServerRun>): CrossServerRun => ({ runId: "r1", issueId: "i1", status: "failed",
  errorCode: "native_execution_ownership_unverified", endedAt: 60_000, ownerBootId: "boot-a", ownerPid: 100, ...overrides });

describe("checkCrossServer", () => {
  it("charges an ownership failure written while the owner was alive and running", () => {
    const check = checkCrossServer({ runs: [run({})], events: [], windows: [A, B] });
    expect(check.violations).toMatchObject([{ rule: "MS_foreign_failure", runId: "r1", issueId: "i1" }]);
  });

  it("allows an ownership failure while the owner was frozen or after it exited", () => {
    const frozen = { ...A, frozen: [{ from: 55_000, to: 200_000 }] };
    expect(checkCrossServer({ runs: [run({})], events: [], windows: [frozen, B] }).violations).toEqual([]);
    const exited = { ...A, exitedAt: 59_000 };
    const check = checkCrossServer({ runs: [run({})], events: [], windows: [exited, B] });
    expect(check.violations).toEqual([]);
    expect(check.unattributed).toHaveLength(1);
  });

  it("charges #20508's shape: a sweep's write after the frozen owner thawed and took its lease back", () => {
    const thawed = { ...A, frozen: [{ from: 10_000, to: 110_000 }] };
    const check = checkCrossServer({ runs: [run({ endedAt: 115_000 })], events: [], windows: [thawed, B] });
    expect(check.violations.map(violation => violation.rule)).toEqual(["MS_foreign_failure"]);
  });

  it("allows the owner's own lease loss after a freeze past the lease, not without one", () => {
    const leaseLost = run({ errorCode: "controller_lease_lost", endedAt: 115_000 });
    const pastLease = { ...A, frozen: [{ from: 10_000, to: 10_000 + CONTROLLER_LEASE_TTL_MS + 1 }] };
    expect(checkCrossServer({ runs: [leaseLost], events: [], windows: [pastLease, B] }).violations).toEqual([]);
    const shortFreeze = { ...A, frozen: [{ from: 10_000, to: 40_000 }] };
    expect(checkCrossServer({ runs: [leaseLost], events: [], windows: [shortFreeze, B] }).violations).toHaveLength(1);
  });

  it("ignores ordinary failures and reports owners it cannot attribute", () => {
    expect(checkCrossServer({ runs: [run({ errorCode: "adapter_failed" })], events: [], windows: [A] })).toMatchObject({ violations: [], unattributed: [] });
    expect(checkCrossServer({ runs: [run({ ownerPid: null })], events: [], windows: [A] }).unattributed).toHaveLength(1);
  });

  it("charges a second runner identity recorded before the first was shown stopped", () => {
    const recorded = (pid: number, at: number) => ({ runId: "r1", kind: "recorded" as const, pid, at });
    const stopped = (pid: number, at: number) => ({ runId: "r1", kind: "stopped" as const, pid, at });
    const runs = [run({ errorCode: null, status: "succeeded" })];
    expect(checkCrossServer({ runs, events: [recorded(1, 1), recorded(2, 5)], windows: [A] }).violations)
      .toMatchObject([{ rule: "MS_double_executor", evidence: { firstPid: 1, secondPid: 2 } }]);
    expect(checkCrossServer({ runs, events: [recorded(1, 1), stopped(1, 4), recorded(2, 5)], windows: [A] }).violations).toEqual([]);
    // The same runner recorded again (a re-attach) is one executor.
    expect(checkCrossServer({ runs, events: [recorded(1, 1), recorded(1, 5)], windows: [A] }).violations).toEqual([]);
  });
});
