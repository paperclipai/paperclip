import { describe, expect, it } from "vitest";
import {
  CONFIG_REFERENCE_IDS, gradeConfigTask, parkState, planConfigWave, referencesFor, taskLevelTexts, validateConfigPlan,
  type ConfigSnapshot, type ConfigTaskPlan, type ConfigTaskRecord, type ConfigWaveOptions,
} from "./config-faults.js";
import { parseConfigWaveArgs } from "./config-wave.js";

const base: ConfigWaveOptions = { seed: 7, faults: ["CF1", "CF3"], adapters: ["codex"], tasks: 4, concurrency: 1, restarts: ["K1", "K2"],
  parkBoundMs: 420_000, repairBudgetMs: 900_000 };

function snapshot(at: number, patch: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return { at, reachable: true, issueStatus: "in_progress", runs: [], interruption: null, execution: null, cards: [], agent: null, notices: [], ...patch };
}

function record(plan: Partial<ConfigTaskPlan>, patch: Partial<ConfigTaskRecord> = {}): ConfigTaskRecord {
  return {
    plan: { taskId: "t01", index: 0, fault: "CF1", reference: "provision_command", adapter: "codex", restart: "K1", nonce: "abcd1234", ...plan },
    issueId: "issue", agentId: "agent", projectId: "project", launchedAt: 0, refusedOnWrite: null, breakError: null, harnessError: null,
    brokenSnapshots: [], parkedAt: null, parkReason: null, restart: null, afterRestart: null, afterRestartParked: null, repair: null,
    doneAt: null, finalStatus: null, brief: { ok: true, detail: "brief ok" }, ...patch,
  };
}

const failedRun = (id: string, createdAt: number, error: string) => ({ id, status: "failed", createdAt, startedAt: createdAt, errorCode: "setup_failed", error });

describe("planConfigWave", () => {
  it("is seeded, walks distinct CF3 references and pins CF2 to opencode", () => {
    const tasks = planConfigWave({ ...base, faults: ["CF3"], tasks: 4 });
    expect(planConfigWave({ ...base, faults: ["CF3"], tasks: 4 })).toEqual(tasks);
    expect(new Set(tasks.map(task => task.reference)).size).toBe(4);
    expect(tasks.every(task => referencesFor("CF3", "codex").includes(task.reference))).toBe(true);
    expect(planConfigWave({ ...base, faults: ["CF2"], tasks: 1 })[0]).toMatchObject({ adapter: "opencode", reference: "ai_default" });
  });

  it("crosses each fault kind with both restart kinds", () => {
    const tasks = planConfigWave({ ...base, faults: ["CF1", "CF2"], tasks: 3 });
    expect(tasks.map(task => `${task.fault}/${task.restart}`)).toEqual(["CF1/K1", "CF2/K1", "CF1/K2"]);
  });

  it("offers the account default only to adapters that carry the binding", () => {
    expect(referencesFor("CF3", "codex")).not.toContain("ai_default");
    expect(referencesFor("CF3", "opencode")).toEqual([...CONFIG_REFERENCE_IDS]);
  });

  it("refuses a second account-default task in one wave", () => {
    expect(() => validateConfigPlan(planConfigWave({ ...base, faults: ["CF2"], tasks: 2 }))).toThrow(/Only one ai_default/);
  });
});

describe("parseConfigWaveArgs", () => {
  it("keeps waves small", () => {
    expect(() => parseConfigWaveArgs(["--tasks", "5"])).toThrow(/tasks/);
    expect(() => parseConfigWaveArgs(["--concurrency", "3"])).toThrow(/concurrency/);
    expect(parseConfigWaveArgs(["--faults", "CF2", "--seed", "3"]).options).toMatchObject({ faults: ["CF2"], seed: 3, concurrency: 1 });
  });
});

describe("parkState", () => {
  it("does not treat an unstarted queued run without a named wait as a rest", () => {
    const queued = snapshot(100_000, { runs: [{ id: "r1", status: "queued", createdAt: 0, startedAt: null, errorCode: null, error: null }] });
    expect(parkState(queued, 100_000, 30_000)).toEqual({ kind: "active", reason: "queued_unstarted" });
    const withCard = { ...queued, cards: [{ id: "c1", kind: "connection_intent", status: "pending", serviceSlug: "openrouter", agentSetup: true }] };
    expect(parkState(withCard, 100_000, 30_000)).toEqual({ kind: "parked", reason: "queued_with_card" });
  });

  it("waits for runs to settle before calling an interruption a rest", () => {
    const failed = snapshot(40_000, { runs: [failedRun("r1", 20_000, "x")], interruption: { state: "failed", canRetry: true, userAction: null, workspaceFailure: null, observedRunId: "r1" } });
    expect(parkState(failed, 40_000, 30_000).kind).toBe("active");
    expect(parkState(failed, 60_000, 30_000)).toEqual({ kind: "parked", reason: "interruption" });
  });
});

describe("gradeConfigTask", () => {
  const options = { parkBoundMs: 420_000 };
  const generic = { state: "failed", canRetry: true, userAction: null, workspaceFailure: null, observedRunId: "r1" };

  it("fails CF1 when the command is named only on the run page (master today)", () => {
    const parked = snapshot(90_000, { runs: [failedRun("r1", 10_000, 'Execution workspace provision command "bash ./scripts/provision-worktree.sh" failed')], interruption: generic });
    const grade = gradeConfigTask(record({}, { brokenSnapshots: [parked], parkedAt: 90_000, parkReason: "interruption",
      restart: { kind: "K1", faultId: "f00", firedAt: 95_000, readyAt: 120_000, error: null }, afterRestart: parked, afterRestartParked: true,
      repair: { at: 200_000, action: "clicked Retry", detail: "", error: null }, finalStatus: "done", doneAt: 400_000 }), options);
    expect(grade.pass).toBe(false);
    expect(grade.checks.find(check => check.name === "actionable_message")?.detail).toMatch(/^message_only_in_run_detail/);
    expect(grade.signature).toBe("CF1/provision_command:message_only_in_run_detail");
  });

  it("passes when the task names the setting, survives the restart and completes after repair", () => {
    const parked = snapshot(90_000, { runs: [failedRun("r1", 10_000, "x")],
      interruption: { ...generic, workspaceFailure: "The project workspace path is not available" } });
    const grade = gradeConfigTask(record({ fault: "CF3", reference: "workspace_cwd" }, { brokenSnapshots: [parked], parkedAt: 90_000, parkReason: "interruption",
      restart: { kind: "K2", faultId: "f00", firedAt: 95_000, readyAt: 120_000, error: null }, afterRestart: parked, afterRestartParked: true,
      repair: { at: 200_000, action: "clicked Retry", detail: "", error: null }, finalStatus: "done", doneAt: 400_000 }), options);
    expect(grade).toMatchObject({ pass: true, outcome: "parked", signature: null });
  });

  it("fails CF2 on a queued run with automatic setup retries and no card (the #20361 bug)", () => {
    const stuck = snapshot(400_000, { issueStatus: "todo", runs: [{ id: "r1", status: "queued", createdAt: 5_000, startedAt: null, errorCode: null, error: null }],
      execution: { label: "Queued", cause: null, nextAction: null },
      agent: { lifecycleState: "verifying", retryRequired: false,
        lifecycleError: "Execution configuration check failed. Paperclip could not complete this step. It will retry automatically." } });
    const grade = gradeConfigTask(record({ fault: "CF2", reference: "ai_default", adapter: "opencode" }, { brokenSnapshots: [stuck],
      restart: { kind: "K1", faultId: "f00", firedAt: 420_000, readyAt: 450_000, error: null }, afterRestart: stuck, afterRestartParked: false,
      repair: { at: 600_000, action: "agent setup Retry", detail: "", error: null }, finalStatus: "done", doneAt: 700_000 }), options);
    expect(grade.pass).toBe(false);
    expect(grade.outcome).toBe("never_rested");
    expect(grade.signature).toBe("CF2/ai_default:bounded_rest+actionable_message+lifecycle_retrying_unchanged_config+queued_without_live_owner");
  });

  it("passes CF2 when the task shows the connection card and parked setup", () => {
    const parked = snapshot(60_000, { issueStatus: "todo", runs: [{ id: "r1", status: "queued", createdAt: 5_000, startedAt: null, errorCode: null, error: null }],
      cards: [{ id: "c1", kind: "connection_intent", status: "pending", serviceSlug: "openrouter", agentSetup: true }],
      agent: { lifecycleState: "verifying", retryRequired: true,
        lifecycleError: "Connect an AI account and choose the responsible user's personal default for this provider. Automatic verification is paused." } });
    expect(taskLevelTexts(parked)).toContain("Connect openrouter (agent setup)");
    const grade = gradeConfigTask(record({ fault: "CF2", reference: "ai_default", adapter: "opencode" }, { brokenSnapshots: [parked], parkedAt: 60_000,
      parkReason: "queued_with_card", restart: { kind: "K1", faultId: "f00", firedAt: 70_000, readyAt: 90_000, error: null }, afterRestart: parked,
      afterRestartParked: true, repair: { at: 100_000, action: "completed connection card c1", detail: "", error: null }, finalStatus: "done", doneAt: 200_000 }), options);
    expect(grade.pass).toBe(true);
  });

  it("fails a retry loop over unchanged configuration", () => {
    const runs = [1, 2, 3, 4].map(index => failedRun(`r${index}`, index * 10_000, "x"));
    const grade = gradeConfigTask(record({}, { brokenSnapshots: [snapshot(400_000, { runs, interruption: { ...generic, workspaceFailure: "provision command failed" } })],
      parkedAt: 400_000, repair: { at: 500_000, action: "clicked Retry", detail: "", error: null }, finalStatus: "done", doneAt: 600_000 }), options);
    expect(grade.checks.find(check => check.name === "no_retry_loop")?.verdict).toBe("fail");
  });

  it("counts a write-time refusal as a pass", () => {
    expect(gradeConfigTask(record({}, { refusedOnWrite: "422 Secret not found" }), options)).toMatchObject({ pass: true, outcome: "refused_on_write" });
  });
});
