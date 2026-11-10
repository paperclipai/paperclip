import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { planTasks } from "./scheduler.js";
import { planMatrixWave } from "./journey-matrix.js";
import { TIME_FREEZE_HOLD_RANGE_MS, isTimeFault } from "./time-faults-config.js";
import { ProcessFreezer, agingStatements, descendantPids, parseProcessTable, runFreezeFault, unshiftJson, unshiftMs, type AgingResult, type TimeFaultRecord } from "./time-faults.js";

const HOUR = 3_600_000;

describe("time fault options", () => {
  it("accepts TM faults locally with a default 26 h age", () => {
    const parsed = parseCommand(["--faults", "TM1,TM2,TM3", "--adapters", "codex", "--workloads", "A1", "--seed", "1"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(parsed.options.faults).toEqual(["TM1", "TM2", "TM3"]);
    expect(parsed.options.timeAgeMs).toBe(26 * HOUR);
  });

  it("takes --time-age-hours only with an aging fault", () => {
    const parsed = parseCommand(["--faults", "TM3", "--time-age-hours", "6", "--workloads", "A1", "--seed", "1"]);
    expect(parsed.mode === "wave" && parsed.options.timeAgeMs).toBe(6 * HOUR);
    expect(() => parseCommand(["--faults", "TM1", "--time-age-hours", "6", "--workloads", "A1"])).toThrow(/add TM2 or TM3/);
    expect(() => parseCommand(["--faults", "K1", "--time-age-hours", "6", "--workloads", "A1"])).toThrow(/add TM2 or TM3/);
    expect(() => parseCommand(["--faults", "TM3", "--time-age-hours", "0", "--workloads", "A1"])).toThrow(/between 1 and 72/);
    expect(() => parseCommand(["--faults", "TM3", "--time-age-hours", "100", "--workloads", "A1"])).toThrow(/between 1 and 72/);
  });

  it("refuses combinations a freeze or an age cannot serve", () => {
    expect(() => parseCommand(["--faults", "TM1", "--storm-minutes", "10"])).toThrow(/storm/);
    expect(() => parseCommand(["--faults", "TM2", "--env", "daytona", "--daytona-image", `r/i@sha256:${"a".repeat(64)}`])).toThrow(/--env local/);
    expect(() => parseCommand(["--faults", "TM3,K14", "--upgrade-from", "/tmp/x"])).toThrow(/K14/);
  });

  it("gives TM1 and TM2 a seeded freeze and TM3 none", () => {
    const plan = planTasks({ seed: 7, tasks: 9, workloads: ["A1"], adapters: ["codex"], faults: ["TM1", "TM2", "TM3"] });
    for (const task of plan) {
      if (task.fault === "TM3") expect(task.holdMs).toBe(0);
      else {
        const [min, max] = TIME_FREEZE_HOLD_RANGE_MS[task.fault as "TM1" | "TM2"];
        expect(task.holdMs).toBeGreaterThanOrEqual(min);
        expect(task.holdMs).toBeLessThanOrEqual(max);
      }
    }
    // TM1 outlasts the 90 s controller-instance lease.
    expect(TIME_FREEZE_HOLD_RANGE_MS.TM1[0]).toBeGreaterThan(90_000);
  });

  it("gives matrix TM cells the same seeded freeze", () => {
    const parsed = parseCommand(["--matrix", "--faults", "TM1,TM2,TM3", "--adapters", "codex", "--workloads", "A1", "--seed", "9"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    const tasks = planMatrixWave("w-20261110T000000-s9", parsed.options).tasks.filter(task => isTimeFault(task.fault));
    expect(tasks.map(task => task.fault).sort()).toEqual(["TM1", "TM2", "TM3"]);
    for (const task of tasks) {
      if (task.fault === "TM3") expect(task.holdMs).toBe(0);
      else expect(task.holdMs).toBeGreaterThanOrEqual(TIME_FREEZE_HOLD_RANGE_MS[task.fault as "TM1" | "TM2"][0]);
    }
  });
});

describe("process freezing", () => {
  const table = parseProcessTable([
    "  100     1 node server-entry.ts",
    "  200   100 paperclip-runnerd --serve",
    "  300   200 codex app-server",
    "  400   100 /opt/pg/bin/postgres -D data",
    "  500   400 postgres: checkpointer",
    "  600     1 node other-session main.ts",
  ].join("\n"));

  it("walks the server's tree, parents first, and never freezes Postgres", () => {
    expect(descendantPids(100, table)).toEqual([200, 300]);
    expect(descendantPids(600, table)).toEqual([]);
  });

  it("freezes the root first and continues everything it froze", () => {
    const signals: string[] = [];
    const freezer = new ProcessFreezer((pid, signal) => { signals.push(`${signal}:${pid}`); }, () => table);
    expect(freezer.freeze(100, true)).toEqual([100, 200, 300]);
    freezer.thaw();
    expect(signals).toEqual(["SIGSTOP:100", "SIGSTOP:200", "SIGSTOP:300", "SIGCONT:100", "SIGCONT:200", "SIGCONT:300"]);
    expect(freezer.pids).toEqual([]);
  });

  it("TM1 freezes only the server", () => {
    const signals: string[] = [];
    const freezer = new ProcessFreezer((pid, signal) => { signals.push(`${signal}:${pid}`); }, () => table);
    expect(freezer.freeze(100, false)).toEqual([100]);
    freezer.thaw();
    expect(signals).toEqual(["SIGSTOP:100", "SIGCONT:100"]);
  });

  it("skips a process that exited before it could be frozen", () => {
    const freezer = new ProcessFreezer(pid => { if (pid === 200) throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, () => table);
    expect(freezer.freeze(100, true)).toEqual([100, 300]);
  });
});

describe("aging", () => {
  const window = { lo: 1_000, hi: 2_000 };

  it("shifts every timestamp and JSON column of a table in one statement", () => {
    const statements = agingStatements([
      { table: "heartbeat_runs", column: "created_at", kind: "timestamp" },
      { table: "heartbeat_runs", column: "context_snapshot", kind: "json" },
      { table: "agents", column: "updated_at", kind: "timestamp" },
    ], 2 * HOUR, window);
    expect(statements.map(statement => statement.table)).toEqual(["agents", "heartbeat_runs"]);
    expect(statements[1]!.sql).toBe("update public.\"heartbeat_runs\" set \"created_at\" = \"created_at\" - interval '7200000 milliseconds', "
      + "\"context_snapshot\" = pg_temp.paperclip_shift_json(\"context_snapshot\", 7200000, 1000, 2000) "
      + "where \"created_at\" is not null or \"context_snapshot\" is not null");
  });

  it("takes whole seconds only, so fractional digits never change", () => {
    expect(() => agingStatements([], 0, window)).toThrow(/positive/);
    expect(() => agingStatements([], 1_500, window)).toThrow(/whole number of seconds/);
  });

  it("quotes identifiers", () => {
    expect(agingStatements([{ table: "we\"ird", column: "at", kind: "timestamp" }], 1_000, window)[0]!.sql).toContain("public.\"we\"\"ird\"");
  });
});

describe("reading aged times at their real time", () => {
  const applied = Date.parse("2026-11-09T12:00:00.000Z");
  const waveStartedAt = applied - 20 * 60_000;
  const shift = { faultId: "f01", ageMs: 26 * HOUR, appliedAt: applied, waveStartedAt };

  it("restores values the shift moved and leaves later writes alone", () => {
    const writtenBefore = Date.parse("2026-11-09T11:55:00.000Z");
    expect(unshiftMs(writtenBefore - shift.ageMs, [shift])).toBe(writtenBefore);
    const writtenAfter = applied + 30_000;
    expect(unshiftMs(writtenAfter, [shift])).toBe(writtenAfter);
    // A value written after the thaw from a time the frozen server kept in memory.
    expect(unshiftMs(waveStartedAt + 60_000, [shift])).toBe(waveStartedAt + 60_000);
  });

  it("restores a moved deadline that was still in the future", () => {
    const leaseExpiresAt = applied + 20 * 60_000;
    expect(unshiftMs(leaseExpiresAt - shift.ageMs, [shift])).toBe(leaseExpiresAt);
  });

  it("undoes two shifts in order", () => {
    const second = { faultId: "f02", ageMs: 26 * HOUR, appliedAt: applied + 10 * 60_000, waveStartedAt };
    const beforeBoth = applied - 60_000;
    const between = applied + 5 * 60_000;
    expect(unshiftMs(beforeBoth - shift.ageMs - second.ageMs, [shift, second])).toBe(beforeBoth);
    expect(unshiftMs(between - second.ageMs, [shift, second])).toBe(between);
  });

  it("rewrites ISO strings and epoch milliseconds anywhere in a response and nothing else", () => {
    const run = { id: "r1", status: "running", startedAt: new Date(applied - 60_000 - shift.ageMs).toISOString(),
      wallStartedAtMs: applied - 60_000 - shift.ageMs, durationMs: 93_600_000, attempt: 2,
      finishedAt: null, note: "2026-11-08", events: [{ createdAt: new Date(applied + 1_000).toISOString(), at: applied + 1_000 }] };
    expect(unshiftJson(run, [shift])).toEqual({ ...run, startedAt: new Date(applied - 60_000).toISOString(), wallStartedAtMs: applied - 60_000 });
    expect(unshiftJson(run, [])).toBe(run);
  });
});

describe("freeze sequence", () => {
  const healthy = 5_000;
  function harness(overrides: Partial<Parameters<typeof runFreezeFault>[0]> = {}) {
    const calls: string[] = [];
    let clock = 1_000;
    const record: TimeFaultRecord = { kind: "TM2" };
    const input: Parameters<typeof runFreezeFault>[0] = {
      kind: "TM2", rootPid: 100, holdMs: 3_000, record,
      freezer: { freeze: (pid, tree) => { calls.push(`freeze:${pid}:${tree}`); return [100, 200]; }, thaw: () => { calls.push("thaw"); } },
      cancelled: () => false,
      waitHealthy: async () => { calls.push("wait"); return healthy; },
      exitStatus: () => null,
      replaceExited: async () => { calls.push("cleanup"); },
      startReplacement: async () => { calls.push("replace"); return healthy + 1; },
      now: () => clock, sleep: async ms => { clock += ms; },
      ...overrides,
    };
    return { input, calls, record };
  }

  it("freezes, holds, always thaws, then waits for the same server", async () => {
    const { input, calls, record } = harness();
    await expect(runFreezeFault(input)).resolves.toEqual({ stoppedAt: 1_000, restartedAt: 4_000, healthyAt: healthy });
    expect(calls).toEqual(["freeze:100:true", "thaw", "wait"]);
    expect(record).toMatchObject({ frozenPids: [100, 200], frozenAt: 1_000, thawedAt: 4_000 });
  });

  it("ages while frozen and lets a lock holder run briefly before retrying", async () => {
    const { input, calls, record } = harness({ age: async onLockTimeout => { calls.push("age"); await onLockTimeout(); calls.push("aged");
      return { faultId: "f01" } as AgingResult; } });
    await runFreezeFault(input);
    expect(calls).toEqual(["freeze:100:true", "age", "thaw", "freeze:100:true", "aged", "thaw", "wait"]);
    expect(record.aging).toEqual({ faultId: "f01" });
  });

  it("thaws when aging fails", async () => {
    const { input, calls } = harness({ age: async () => { throw new Error("shift failed"); } });
    await expect(runFreezeFault(input)).rejects.toThrow("shift failed");
    expect(calls).toEqual(["freeze:100:true", "thaw"]);
  });

  it("replaces a server that exited after the thaw and records it", async () => {
    const { input, calls, record } = harness({ waitHealthy: async () => { throw new Error("exited"); },
      exitStatus: () => ({ code: 1, signal: null }) });
    await expect(runFreezeFault(input)).resolves.toMatchObject({ healthyAt: healthy + 1 });
    expect(calls).toEqual(["freeze:100:true", "thaw", "cleanup", "replace"]);
    expect(record.serverExitedAfterThaw).toEqual({ code: 1, signal: null });
    expect(record.cleanupError).toBeUndefined();
  });

  it("fails on a cleanup failure without starting a second server", async () => {
    const { input, calls, record } = harness({ waitHealthy: async () => { throw new Error("exited"); },
      exitStatus: () => ({ code: null, signal: "SIGKILL" }), replaceExited: async () => { throw new Error("runner 300 still alive"); } });
    await expect(runFreezeFault(input)).rejects.toThrow(/could not be shown stopped: runner 300 still alive/);
    expect(record.cleanupError).toBe("runner 300 still alive");
    expect(calls).not.toContain("replace");
  });

  it("fails without a replacement when a live server never answers", async () => {
    const { input, calls } = harness({ waitHealthy: async () => { throw new Error("not healthy"); } });
    await expect(runFreezeFault(input)).rejects.toThrow("not healthy");
    expect(calls).not.toContain("replace");
  });
});
