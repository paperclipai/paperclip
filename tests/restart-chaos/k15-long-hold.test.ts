import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCommand } from "./config.js";
import { RUNNER_LOG_PROBE, captureDirectoryName, captureWaveRunnerLogs, probeableSandbox } from "./daytona-runner-logs.js";
import { WORKLOAD_TRIGGERS } from "./journeys.js";
import { K15_MAX_HOLD_SECONDS } from "./redeploy.js";
import { planStorm, planTasks } from "./scheduler.js";
import type { OracleArtifacts } from "./types.js";
import { T1_TICKS, t1Command, t1Marker, workloadDefinitions } from "./workloads.js";

const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"c".repeat(64)}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

describe("--k15-hold-seconds", () => {
  it("seeds a K15 outage inside the range, like a staging deploy's 4-7 minutes down", () => {
    const parsed = parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--faults", "K15", "--k15-hold-seconds", "240-480",
      "--adapters", "opencode", "--workloads", "T1", "--tasks", "6", "--seed", "11"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(parsed.options.k15HoldMs).toEqual([240_000, 480_000]);
    const holds = planTasks(parsed.options).map(task => task.holdMs);
    expect(holds.every(hold => hold >= 240_000 && hold <= 480_000)).toBe(true);
    const fixed = parseCommand(["--faults", "K15", "--k15-hold-seconds", "300", "--workloads", "A1", "--tasks", "2", "--seed", "11"]);
    expect(fixed.mode === "wave" && planTasks(fixed.options).map(task => task.holdMs)).toEqual([300_000, 300_000]);
  });

  it("keeps K15 immediate without the option, and leaves other faults' holds alone", () => {
    const parsed = parseCommand(["--faults", "K2,K15", "--workloads", "A1", "--tasks", "4", "--seed", "11"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(planTasks(parsed.options).every(task => task.holdMs === 0)).toBe(true);
    const storm = planStorm(5, 20, ["K2", "K15"], undefined, [60_000, 60_000]);
    expect(storm.faults.every(fault => fault.holdMs === (fault.kind === "K15" ? 60_000 : 0))).toBe(true);
  });

  it("refuses a range without K15, out of bounds or reversed", () => {
    expect(() => parseCommand(["--faults", "K2", "--k15-hold-seconds", "300", "--workloads", "A1"])).toThrow(/add K15/);
    expect(() => parseCommand(["--faults", "K15", "--k15-hold-seconds", `${K15_MAX_HOLD_SECONDS + 1}`, "--workloads", "A1"])).toThrow(/between 0 and 600/);
    expect(() => parseCommand(["--faults", "K15", "--k15-hold-seconds", "400-300", "--workloads", "A1"])).toThrow(/min not above max/);
    expect(() => parseCommand(["--faults", "K15", "--k15-hold-seconds", "5m", "--workloads", "A1"])).toThrow(/<seconds> or <min>-<max>/);
    expect(() => parseCommand(["--replay", "w-1/t01", "--k15-hold-seconds", "300"])).toThrow(/--replay reproduces the saved plan/);
  });
});

describe("T1: long shell tool in the agent's workspace", () => {
  const t1 = workloadDefinitions.T1;
  const NONCE = "0badc0de";
  const done = (brief: string): OracleArtifacts => ({ issueStatus: "done", documents: { brief }, agentComments: [], files: {}, commands: {},
    workspacePath: null }) as OracleArtifacts;

  it("runs about 100 s in the foreground and fires its fault while the tool runs", () => {
    expect(T1_TICKS * 2).toBe(100);
    expect(t1.description(NONCE)).toContain(t1Command(NONCE));
    expect(t1.description(NONCE)).toContain("in the foreground");
    expect(t1.fireWindowMs[0]).toBeGreaterThanOrEqual(30_000);
    expect(t1.fireWindowMs[1]).toBeLessThanOrEqual(90_000);
    expect(WORKLOAD_TRIGGERS.T1).toEqual(["time"]);
    const defaults = parseCommand(["--seed", "1"]);
    expect(defaults.mode === "wave" && defaults.options.workloads).not.toContain("T1");
  });

  it("passes only when the finished tool's count is reported and the task is done", () => {
    expect(t1.grade(NONCE, done(`${t1Marker(NONCE)}=${T1_TICKS}\nmore`)).verdict).toBe("pass");
    expect(t1.grade(NONCE, done(`${t1Marker(NONCE)}=49`)).verdict).toBe("fail");
    expect(t1.grade(NONCE, done("")).verdict).toBe("fail");
    expect(t1.grade(NONCE, { ...done(`${t1Marker(NONCE)}=${T1_TICKS}`), issueStatus: "blocked" }).verdict).toBe("fail");
  });
});

describe("Daytona Runner log capture", () => {
  it("probes only by reading", () => {
    expect(RUNNER_LOG_PROBE).toContain("runnerd.stderr.log");
    expect(RUNNER_LOG_PROBE).toContain("runner-process.identity");
    expect(RUNNER_LOG_PROBE).toContain("runner-state.json");
    expect(RUNNER_LOG_PROBE).not.toMatch(/\b(rm|kill|mv|cp|chmod|chown|truncate|tee|mkdir|touch)\b/);
    // The only redirections are stderr to /dev/null.
    expect(RUNNER_LOG_PROBE.replace(/2>\/dev\/null/g, "")).not.toMatch(/>/);
    expect(captureDirectoryName("f01 before_start")).toBe("f01-before_start");
    expect(() => captureDirectoryName("///")).toThrow(/non-empty/);
    expect(probeableSandbox({ id: "a", state: "started" })).toBe(true);
    expect(probeableSandbox({ id: "a", state: "stopped" })).toBe(false);
  });

  it("captures this wave's started sandboxes only, redacts secrets, and records failures instead of throwing", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "runner-logs-"));
    const labels = { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT };
    const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "== runnerd.stderr.log\nruntime token sk-live-secret exited signal=9\n" }));
    const get = vi.fn(async (id: string) => {
      if (id === "broken") throw new Error("toolbox unavailable");
      return { process: { executeCommand } };
    });
    const client = {
      async *list() {
        yield { id: "live", state: "started", labels };
        yield { id: "stopped", state: "stopped", labels };
        yield { id: "broken", state: "started", labels };
        yield { id: "other-wave", state: "started", labels: { ...labels, "paperclip-environment-id": "33333333-3333-4333-8333-333333333333" } };
      },
      get,
    };
    const capture = await captureWaveRunnerLogs({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, outDir,
      label: "f01-stopped", secrets: ["sk-live-secret"], client });
    expect(capture.error).toBeNull();
    expect(capture.sandboxes.map(sandbox => [sandbox.id, sandbox.file, sandbox.error])).toEqual([
      ["live", "live.txt", null], ["stopped", null, null], ["broken", null, "toolbox unavailable"]]);
    expect(get).not.toHaveBeenCalledWith("other-wave");
    expect(get).not.toHaveBeenCalledWith("stopped");
    const text = await readFile(path.join(outDir, "f01-stopped", "live.txt"), "utf8");
    expect(text).toContain("exited signal=9");
    expect(text).not.toContain("sk-live-secret");
    expect((await readdir(path.join(outDir, "f01-stopped"))).sort()).toEqual(["index.json", "live.txt"]);
    const failed = await captureWaveRunnerLogs({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, outDir, label: "f02-stopped",
      secrets: [], client: { async *list() { throw new Error("list failed"); }, get } });
    expect(failed.error).toBe("list failed");
  });
});
