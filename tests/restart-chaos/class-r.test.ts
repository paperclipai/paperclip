import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CR1_DEFAULT_HOLD_SECONDS, CR5_FIRE_WINDOW_MS, PROVIDER_KILL_SCRIPT, classRHoldMs, classRRedeploys, findDaytonaPluginWorker, killedPidsFromOutput,
  parseClassROptions, providerKillCommand, runPluginStall, waitForPluginActivation, watchLabels, withReplacementPluginStall, withClassRCheck, type ClassRRecord,
} from "./class-r.js";
import { executeInWaveSandboxes } from "./daytona-runner-logs.js";
import { parseCommand } from "./config.js";
import { redeployWave } from "./redeploy.js";
import { planTasks, taskFaultSchedule } from "./scheduler.js";
import { planMatrixTasks } from "./journey-matrix.js";
import { FAULT_SIGNAL } from "./supervisor.js";
import { withT1CrossingCheck } from "./workloads.js";
import { CLASS_R_PROBE } from "./daytona-runner-logs.js";
import type { WaveOptions } from "./types.js";

const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`;
const RUN = "c4373803-ef67-4dcc-ad20-ea330aac80c1";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

describe("class R options", () => {
  const base = { env: "daytona" as const, stormMinutes: undefined, crashPoint: undefined };
  it("defaults CR1 to a 6-minute hold, CR2 to no outage and CR3 to a 45 s stall", () => {
    expect(parseClassROptions({ ...base, faults: ["CR1", "CR2", "CR3"] }, {})).toEqual({
      cr1HoldMs: [CR1_DEFAULT_HOLD_SECONDS * 1000, CR1_DEFAULT_HOLD_SECONDS * 1000], cr2HoldMs: [0, 0], cr3StallMs: [45_000, 45_000] });
  });
  it("takes a seconds value or a range", () => {
    expect(parseClassROptions({ ...base, faults: ["CR1"] }, { cr1: "300-420" })).toEqual({ cr1HoldMs: [300_000, 420_000] });
    expect(parseClassROptions({ ...base, faults: ["CR2"] }, { cr2: "90" })).toEqual({ cr2HoldMs: [90_000, 90_000] });
  });
  it("refuses a CR3 stall that is not longer than 40 s, and a hold above the outage cap", () => {
    expect(() => parseClassROptions({ ...base, faults: ["CR3"] }, { cr3: "40" })).toThrow(/cr3-stall-seconds must be between 41/);
    expect(() => parseClassROptions({ ...base, faults: ["CR1"] }, { cr1: "601" })).toThrow(/between 0 and 600/);
  });
  it("needs Daytona, its own fault for each option and no storm or crash point", () => {
    expect(() => parseClassROptions({ ...base, env: "local", faults: ["CR1"] }, {})).toThrow(/--env daytona/);
    expect(() => parseClassROptions({ ...base, faults: ["K15"] }, { cr1: "60" })).toThrow(/add CR1 to --faults/);
    expect(() => parseClassROptions({ ...base, faults: ["K15"] }, { cr3: "60" })).toThrow(/add CR3, CR4, CR5 or CR6 to --faults/);
    expect(parseClassROptions({ ...base, faults: ["CR4", "CR5"] }, { cr3: "50" })).toEqual({ cr3StallMs: [50_000, 50_000] });
    expect(() => parseClassROptions({ ...base, stormMinutes: 10, faults: ["CR1"] }, {})).toThrow(/storm/);
    expect(() => parseClassROptions({ ...base, faults: ["CR1", "MS1"] }, {})).toThrow(/MS1-MS3/);
    expect(parseClassROptions({ ...base, faults: ["K1"] }, {})).toEqual({});
  });
  it("parses from the command line", () => {
    const parsed = parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--adapters", "opencode,claude", "--workloads", "T1",
      "--faults", "CR1", "--cr1-hold-seconds", "75", "--tasks", "2", "--seed", "1"]);
    expect("options" in parsed && parsed.options.cr1HoldMs).toEqual([75_000, 75_000]);
  });
});

describe("class R planning", () => {
  const options: WaveOptions = { env: "daytona", adapters: ["opencode", "claude"], workloads: ["T1"], faults: ["CR1", "CR2", "CR3"],
    concurrency: 1, tasks: 6, seed: 7, budgetCents: 3000, pollMs: 2000, cr1HoldMs: [360_000, 360_000], cr2HoldMs: [0, 0], cr3StallMs: [45_000, 45_000] };
  it("gives each cell its own hold", () => {
    const holds = Object.fromEntries(planTasks(options).map(task => [task.fault, task.holdMs]));
    expect(holds).toEqual({ CR1: 360_000, CR2: 0, CR3: 45_000 });
  });
  it("gives CR4 and CR5 the CR3 stall, and fires CR5 inside the launch window", () => {
    const plans = planTasks({ ...options, faults: ["CR3", "CR4", "CR5"], cr3StallMs: [50_000, 50_000] });
    expect(new Set(plans.map(task => task.holdMs))).toEqual(new Set([50_000]));
    const launch = plans.filter(task => task.fault === "CR5");
    expect(launch.length).toBeGreaterThan(0);
    for (const task of launch) {
      expect(task.fireAfterMs).toBeGreaterThanOrEqual(CR5_FIRE_WINDOW_MS[0]);
      expect(task.fireAfterMs).toBeLessThanOrEqual(CR5_FIRE_WINDOW_MS[1]);
    }
    const matrix = planMatrixTasks({ ...options, faults: ["CR5"] }).filter(task => task.fault === "CR5");
    expect(matrix.every(task => task.fireAfterMs >= CR5_FIRE_WINDOW_MS[0] && task.fireAfterMs <= CR5_FIRE_WINDOW_MS[1])).toBe(true);
    expect(FAULT_SIGNAL.CR4).toBe("SIGKILL");
    expect(FAULT_SIGNAL.CR5).toBe("SIGSTOP");
    expect(classRRedeploys("CR4", 45_000)).toBe(false);
  });
  it("schedules every CR5 launch stall on the time trigger, whatever the workload's triggers", () => {
    const launchWindow = (atMs: number) => atMs >= CR5_FIRE_WINDOW_MS[0] && atMs <= CR5_FIRE_WINDOW_MS[1];
    const planned = planTasks({ ...options, workloads: ["T1", "B5"], faults: ["CR5"], triggers: ["tool", "time"], tasks: 8, faultAfterMs: 60_000 })
      .filter(task => task.fault === "CR5");
    expect(planned.length).toBe(8);
    for (const task of planned) {
      expect(task.trigger).toBeUndefined();
      expect(taskFaultSchedule(task)).toEqual([{ kind: "CR5", holdMs: 45_000, atMs: task.fireAfterMs }]);
      expect(launchWindow(task.fireAfterMs)).toBe(true);
    }
    const matrix = planMatrixTasks({ ...options, workloads: ["B5", "C1"], faults: ["CR5"], faultAfterMs: 60_000 }).filter(task => task.fault === "CR5");
    expect(matrix.length).toBe(4);
    for (const task of matrix) {
      expect(taskFaultSchedule(task)).toEqual([{ kind: "CR5", holdMs: 45_000, atMs: task.fireAfterMs }]);
      expect(launchWindow(task.fireAfterMs)).toBe(true);
    }
    expect(() => planTasks({ ...options, workloads: ["B5"], faults: ["CR5"], triggers: ["tool"] })).toThrow(/CR5 stalls the plugin at launch/);
  });
  it("draws a hold only for a range", () => {
    expect(classRHoldMs("CR1", { cr1HoldMs: [300_000, 420_000] }, () => 333_000)).toBe(333_000);
    expect(classRHoldMs("K2", {}, () => { throw new Error("no draw"); })).toBe(0);
  });
  it("redeploys for CR1 and for CR2 with a hold", () => {
    expect(classRRedeploys("CR1", 0)).toBe(true);
    expect(classRRedeploys("CR2", 0)).toBe(false);
    expect(classRRedeploys("CR2", 60_000)).toBe(true);
    expect(classRRedeploys("CR3", 45_000)).toBe(false);
    expect(redeployWave({ options: { ...options, faults: ["CR1"] }, tasks: [] })).toBe(true);
    // A default CR2 keeps the controller up, so it gets no deploy identity; a held CR2 does.
    const cr2 = (holdMs: number) => planTasks({ ...options, faults: ["CR2"], tasks: 1, cr2HoldMs: [holdMs, holdMs] });
    expect(redeployWave({ options: { ...options, faults: ["CR2"] }, tasks: cr2(0) })).toBe(false);
    expect(redeployWave({ options: { ...options, faults: ["CR2"] }, tasks: cr2(60_000) })).toBe(true);
  });
});

describe("CR2 provider kill", () => {
  it("quotes the fixed script and passes only a run id and the adapter's pattern", () => {
    const command = providerKillCommand(RUN, "opencode");
    expect(command.startsWith("sh -c '")).toBe(true);
    expect(command.endsWith(`paperclip-chaos-cr2 '${RUN}' ' serve --hostname 127.0.0.1 --port '`)).toBe(true);
    expect(PROVIDER_KILL_SCRIPT).toContain("kill -KILL $targets");
    // A survivor fails the fault instead of being reported as killed.
    expect(PROVIDER_KILL_SCRIPT.indexOf("exit 5")).toBeLessThan(PROVIDER_KILL_SCRIPT.indexOf("== killed"));
    // Never the Runner itself.
    expect(PROVIDER_KILL_SCRIPT).toContain('test "$p" = "$runner" && continue');
  });
  it("refuses anything but a run id", () => {
    expect(() => providerKillCommand("x'; rm -rf /", "claude")).toThrow(/needs a run id/);
  });
  it("reads the killed PIDs from the script's output", () => {
    expect(killedPidsFromOutput("== runner 484\n== killed 603 741 at 2026-11-11T03:00:29.000Z\n")).toEqual([603, 741]);
    expect(killedPidsFromOutput("== runner 484\n")).toEqual([]);
  });
});

describe("CR3 plugin worker", () => {
  const rows = [
    { pid: 10, ppid: 1, command: "node server/src/index.ts" },
    { pid: 11, ppid: 10, command: "node /x/packages/plugins/sandbox-providers/daytona/dist/worker.js" },
    { pid: 12, ppid: 11, command: "node /x/packages/plugins/sandbox-providers/daytona/dist/child.js" },
    { pid: 13, ppid: 10, command: "node /x/packages/plugins/other/dist/worker.js" },
    { pid: 20, ppid: 1, command: "node /elsewhere/daytona/dist/worker.js" },
  ];
  const descendants = (root: number) => {
    const out: number[] = []; const queue = [root];
    while (queue.length) { const pid = queue.shift()!; for (const row of rows) if (row.ppid === pid) { out.push(row.pid); queue.push(row.pid); } }
    return out;
  };
  it("finds the server's own Daytona worker, not its children or another server's", () => {
    expect(findDaytonaPluginWorker(rows, 10, descendants)).toEqual({ pid: 11, command: rows[1]!.command });
  });
  it("finds nothing when there is no single worker", () => {
    expect(findDaytonaPluginWorker(rows.filter(row => row.pid !== 11 && row.pid !== 12), 10, descendants)).toBeNull();
  });
});

describe("CR3 stall", () => {
  const rows = [{ pid: 10, ppid: 1, command: "node server" }, { pid: 11, ppid: 10, command: "node /x/daytona/dist/worker.js" }];
  const base = { serverPid: 10, holdMs: 30, cancelled: () => false, record: () => {}, table: () => rows, sleep: async () => {} };
  it("starts the stall clock only once the worker itself is stopped", async () => {
    const thawed: string[] = [];
    const stall = await runPluginStall({ ...base, freezer: { freeze: () => [11], thaw: () => { thawed.push("thaw"); } } });
    expect(stall.error).toBeNull();
    expect(stall.frozenAt).not.toBeNull();
    expect(stall.thawedAt! - stall.frozenAt!).toBeGreaterThanOrEqual(30);
    expect(thawed).toEqual(["thaw"]);
  });
  it("waits for a replacement's plugin worker to appear before it stops it", async () => {
    let reads = 0;
    const stall = await runPluginStall({ ...base, findWorkerWithinMs: 60_000, table: () => (++reads < 3 ? rows.slice(0, 1) : rows),
      sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, freezer: { freeze: () => [11], thaw: () => {} } });
    expect(stall.error).toBeNull();
    expect(stall.workerPid).toBe(11);
    expect(reads).toBe(3);
  });
  it.each([
    ["activated", ["starting", "plugin-loader: loadAll complete {\"succeeded\":1}"]],
    ["failed", ["plugin-loader: failed to activate plugin", "plugin-loader: loadAll complete {\"succeeded\":0}"]],
    ["timed_out", ["starting"]],
  ] as const)("waits for the replacement's plugin activation before CR4 stalls it (%s)", async (outcome, lines) => {
    let reads = 0;
    const result = await waitForPluginActivation({ timeoutMs: outcome === "timed_out" ? 0 : 60_000, cancelled: () => false, sleep: async () => {},
      readLog: () => lines.slice(0, ++reads).join("\n") });
    expect(result).toBe(outcome);
  });
  it.each([
    ["CR6", "stops the worker while the plugin activates", ["starting"], 1],
    ["CR4", "waits for the activation before it stops the worker", ["plugin-loader: loadAll complete"], 1],
    ["K1", "leaves the plugin alone", ["plugin-loader: loadAll complete"], 0],
  ] as const)("%s %s", async (kind, _what, log, frozen) => {
    const root = mkdtempSync(path.join(tmpdir(), "class-r-replacement-"));
    try {
      const logPath = path.join(root, "server.log");
      writeFileSync(logPath, ["old boot: plugin-loader: loadAll complete", ...log].join("\n"));
      const freeze = vi.fn(() => [11]);
      const into: { pluginStall?: unknown } = {};
      const healthyAt = await withReplacementPluginStall(kind, { ...base, holdMs: 0, logPath, logOffset: "old boot: plugin-loader: loadAll complete".length,
        activationTimeoutMs: 0, into: into as never, freezer: { freeze, thaw: () => {} } } as never, async () => 1234);
      expect(healthyAt).toBe(1234);
      expect(freeze).toHaveBeenCalledTimes(frozen);
      if (frozen) expect(into.pluginStall).toMatchObject({ workerPid: 11, error: null });
      if (kind === "CR4") await expect(withReplacementPluginStall(kind, { ...base, holdMs: 0, logPath, logOffset: 10_000,
        activationTimeoutMs: 0, into: {}, freezer: { freeze, thaw: () => {} } } as never, async () => 1)).rejects.toThrow(/activation timed_out/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails when the worker could not be stopped or is missing", async () => {
    const missed = await runPluginStall({ ...base, freezer: { freeze: () => [], thaw: () => {} } });
    expect(missed.error).toMatch(/could not stop/);
    expect(missed.frozenAt).toBeNull();
    expect((await runPluginStall({ ...base, table: () => rows.slice(0, 1), freezer: { freeze: () => [], thaw: () => {} } })).error).toMatch(/no single/);
  });
});

describe("CR2 sandbox search", () => {
  const list = async function* () {
    yield { id: "a", state: "started", labels: { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT } };
  };
  it("returns at its deadline when a Daytona lookup never answers", async () => {
    const started = Date.now();
    const result = await executeInWaveSandboxes({ apiKey: "", companyId: COMPANY, environmentId: ENVIRONMENT, command: "true", secrets: [],
      done: () => true, client: { list, get: async () => new Promise<never>(() => {}) } as never, deadlineMs: 1_500 });
    const elapsed = Date.now() - started;
    expect(result.error).toMatch(/deadline 1500 ms/);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
  });
  it("never starts a command once the deadline has passed, even when the lookup answers late", async () => {
    let commands = 0;
    const sandbox = { process: { executeCommand: async () => { commands += 1; return { exitCode: 0, result: "" }; } } };
    const get = () => new Promise(resolve => setTimeout(() => resolve(sandbox), 1_800));
    const result = await executeInWaveSandboxes({ apiKey: "", companyId: COMPANY, environmentId: ENVIRONMENT, command: "true", secrets: [],
      done: () => true, client: { list, get } as never, deadlineMs: 1_500 });
    expect(result.error).toMatch(/deadline/);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(commands).toBe(0);
    expect(result.attempts).toEqual([]);
  });
});

describe("class R evidence", () => {
  it("watches the window staging failed in", () => {
    const labels = watchLabels("f01");
    expect(labels[0]).toEqual({ label: "f01-ready+0s", atMs: 0 });
    expect(labels.some(entry => entry.atMs === 45_000)).toBe(true);
    expect(labels.at(-1)!.atMs).toBe(180_000);
  });
  it("captures start times, sockets and provider files", () => {
    expect(CLASS_R_PROBE).toContain("lstart");
    expect(CLASS_R_PROBE).toContain("ss -tanp");
    expect(CLASS_R_PROBE).toContain("opencode/log");
    expect(CLASS_R_PROBE).not.toContain("'");
  });
});

describe("class_r_fault_applied", () => {
  const oracle: { verdict: "pass" | "fail"; checks: Array<{ name: string; ok: boolean; detail?: string }> } = { verdict: "pass", checks: [{ name: "brief", ok: true }] };
  const classR = (record: Partial<ClassRRecord>): ClassRRecord => ({ kind: "CR2", redeploy: false, captures: [], ...record });
  it("passes a CR2 task only when a provider was killed", () => {
    const killed = { requestedBy: "t01", kind: "CR2", error: null, classR: classR({ providerKill: { runId: RUN, adapter: "claude", at: 1,
      sandboxId: "s", killedPids: [603], attempts: [], error: null } }) };
    expect(withClassRCheck(oracle, { taskId: "t01", fault: "CR2" }, [killed]).verdict).toBe("pass");
    const missed = { ...killed, classR: classR({ providerKill: { ...killed.classR.providerKill!, killedPids: [], error: "no running run for the task" } }) };
    const graded = withClassRCheck(oracle, { taskId: "t01", fault: "CR2" }, [missed]);
    expect(graded.verdict).toBe("fail");
    expect(graded.checks.at(-1)!.detail).toContain("no running run");
  });
  it("passes a CR3 task only when the stall ended", () => {
    const stall = { workerPid: 11, command: "node", frozenPids: [11], frozenAt: 1_000, thawedAt: 46_000, error: null };
    expect(withClassRCheck(oracle, { taskId: "t01", fault: "CR3" }, [{ requestedBy: "t01", kind: "CR3", error: null,
      classR: classR({ kind: "CR3", pluginStall: stall }) }]).checks.at(-1)!.detail).toContain("45000ms");
  });
  it.each(["CR4", "CR5"])("passes a %s task only when its stall ended", fault => {
    const stall = { workerPid: 11, command: "node", frozenPids: [11], frozenAt: 1_000, thawedAt: 46_000, error: null };
    const applied = withClassRCheck(oracle, { taskId: "t01", fault }, [{ requestedBy: "t01", kind: fault, error: null,
      classR: classR({ kind: fault as ClassRRecord["kind"], pluginStall: stall }) }]);
    expect(applied.verdict).toBe("pass");
    expect(applied.checks.at(-1)!.detail).toContain("45000ms");
    const missing = withClassRCheck(oracle, { taskId: "t01", fault }, [{ requestedBy: "t01", kind: fault, error: null,
      classR: classR({ kind: fault as ClassRRecord["kind"], pluginStall: { ...stall, frozenAt: null, thawedAt: null, error: "no worker" } }) }]);
    expect(missing.verdict).toBe("fail");
  });
  it("does not require a CR5 launch stall to cross the T1 tool loop", () => {
    const plan = { taskId: "t01", workload: "T1" as const, nonce: "n", fault: "CR5" };
    expect(withT1CrossingCheck(oracle as never, plan, null, [])).toBe(oracle);
    expect(withT1CrossingCheck(oracle as never, { ...plan, fault: "CR4" }, null, []).verdict).toBe("fail");
  });
  it("fails a CR task whose fault never fired, and leaves other tasks alone", () => {
    expect(withClassRCheck(oracle, { taskId: "t01", fault: "CR1" }, []).verdict).toBe("fail");
    expect(withClassRCheck(oracle, { taskId: "t01", fault: "K2" }, [])).toBe(oracle);
  });
});
