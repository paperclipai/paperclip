import { afterEach, describe, expect, it, vi } from "vitest";
import { storyLifecycleChecks, type StoryRun } from "./everyday-observations.js";
import { gradeRemoteRestart, observeRemoteRestartBoundary, projectRemoteRestartEvents, projectRemoteRestartRun, waitForRemoteRestartBoundary } from "./everyday-remote-restart.js";

const run: StoryRun = {
  id: "run", companyId: "company", agentId: "lead", nativeIssueId: "task",
  status: "succeeded", runtimeMode: "native", runnerInstanceId: "runner", nativeSessionId: "session",
};

function fixture() {
  const active = { ...run, status: "running", processPid: 42, processStartedAt: "2026-10-14T00:00:00.000Z" };
  const scope = { companyId: "company", agentId: "lead", issueId: "task", environmentId: "environment" };
  const leases = [{ id: "lease", ...scope, heartbeatRunId: "run", provider: "daytona", providerLeaseId: "private-sandbox",
    status: "active", releasedAt: null, executionWorkspaceId: "workspace" }];
  const event = (seq: number, eventType: string, payload: Record<string, unknown> = {}, sourceKind = "runner", sourceSeq = seq) => {
    const sourceInstanceId = sourceKind === "runner" ? "runner" : "runner:control";
    return { seq, runId: "run", companyId: "company", eventType, protocolSchemaVersion: 1, payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", normalizedSessionId: "session", sourceKind,
      sourceInstanceId, sourceSeq, sourceEventId: `${sourceInstanceId}:run:${sourceSeq}`, eventType,
      turnId: eventType === "turn.submitted" ? null : "turn", payload,
    } } };
  };
  const rows = [event(1, "turn.submitted"), event(2, "turn.started"),
    event(3, "tool.execution.started", { executionId: "tool", status: "running" }),
    event(4, "tool.execution.completed", { executionId: "tool", status: "completed", output: "private tool output" })];
  const before = observeRemoteRestartBoundary(active, rows, leases, scope);
  const afterRows = [...rows, event(5, "item.delta", { text: "private provider text" })];
  const after = observeRemoteRestartBoundary(active, afterRows, leases, scope);
  const finished: StoryRun = { ...run, nativePhase: "committed", resultJson: {
    finalizationPhase: "committed", workspaceFinalizeStatus: "succeeded", nextAttemptAt: null, failureCode: null,
  } };
  const finalRows = [...afterRows, event(6, "run.result.proposed"), event(7, "turn.completed"),
    event(8, "run.result.accepted", {}, "control_plane", 1), event(9, "run.terminal", {}, "control_plane", 2)];
  const final = { run: finished, events: projectRemoteRestartEvents(finished, finalRows),
    operations: [{ companyId: "company", heartbeatRunId: "run", issueId: "task", executionWorkspaceId: "workspace",
      phase: "workspace_finalize", status: "succeeded" }], scheduledRetry: null as unknown, recoveryActions: [] as Record<string, unknown>[] };
  return { active, scope, leases, event, rows, afterRows, finalRows, evidence: { before, after, final } };
}

describe("remote restart boundary polling", () => {
  afterEach(() => vi.useRealTimers());

  it.each([undefined, "succeeded", "failed", "cancelled", "timed_out"] as const)("stops immediately when the original run is %s", async status => {
    vi.useFakeTimers();
    const now = Date.now();
    const load = vi.fn(async () => ({ run: status === undefined ? undefined : { ...run, status } }));
    const outcome = waitForRemoteRestartBoundary({ deadlineAt: now + 60_000, load }).then(
      () => undefined, error => error as Error,
    );
    await vi.runAllTimersAsync();
    expect((await outcome)?.message).toBe("Stopped waiting for active remote native turn with completed tool receipt: Remote restart boundary unexercised: original run ended before fault injection");
    expect(load).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(now);
  });

  it("waits for useful work while the original run remains active", async () => {
    vi.useFakeTimers();
    const { active, evidence } = fixture();
    const load = vi.fn().mockResolvedValueOnce({ run: active })
      .mockResolvedValueOnce({ run: active, boundary: evidence.before });
    const waiting = waitForRemoteRestartBoundary({ deadlineAt: Date.now() + 60_000, load });
    await vi.runAllTimersAsync();
    expect(await waiting).toEqual(evidence.before);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("remote restart lifecycle evidence", () => {
  it("does not accept a successful replacement as proof that the original remote runner recovered", () => {
    const { evidence } = fixture();
    const replacement = { ...evidence.final.run, id: "replacement", runnerInstanceId: "replacement-runner" };
    evidence.final.run = replacement;
    const checks = storyLifecycleChecks({ issues: [{ id: "task", companyId: "company", title: "task", status: "done" }],
      runs: [replacement], parentId: "task", leadId: "lead", requireRemoteRestart: true, remoteRestart: evidence,
    } as Parameters<typeof storyLifecycleChecks>[0]);
    expect(checks.every(check => check.passed)).toBe(false);
  });

  it("does not accept a terminal native result without its workspace finalization receipt", () => {
    const { evidence } = fixture();
    evidence.final.operations = [];
    const checks = storyLifecycleChecks({ issues: [{ id: "task", companyId: "company", title: "task", status: "done" }],
      runs: [evidence.final.run], parentId: "task", leadId: "lead", requireRemoteRestart: true, remoteRestart: evidence,
    } as Parameters<typeof storyLifecycleChecks>[0]);
    expect(checks.every(check => check.passed)).toBe(false);
  });

  it("accepts the original live process and lease followed by committed native and workspace receipts", () => {
    const { evidence } = fixture();
    expect(storyLifecycleChecks({ issues: [{ id: "task", companyId: "company", title: "task", status: "done" }],
      runs: [evidence.final.run], parentId: "task", leadId: "lead", requireRemoteRestart: true, remoteRestart: evidence,
    }).every(check => check.passed)).toBe(true);
  });

  it.each(["runId", "runnerInstanceId", "nativeSessionId", "processPid", "processStartedAt"] as const)("rejects a changed %s after restart", field => {
    const { evidence } = fixture();
    const identity = evidence.after.identity as Record<string, unknown>;
    identity[field] = field === "processPid" ? 43 : "different";
    expect(gradeRemoteRestart(evidence)[0]!.passed).toBe(false);
  });

  it("rejects a replacement sandbox and changed or missing receipt prefixes", () => {
    const changedLease = fixture().evidence;
    changedLease.after.lease.providerLeaseSha256 = "0".repeat(64);
    expect(gradeRemoteRestart(changedLease)[0]!.passed).toBe(false);
    const changedPrefix = fixture().evidence;
    changedPrefix.after.events[0]!.sha256 = "0".repeat(64);
    expect(gradeRemoteRestart(changedPrefix)[0]!.passed).toBe(false);
    const missingPrefix = fixture().evidence;
    missingPrefix.final.events.shift();
    expect(gradeRemoteRestart(missingPrefix)[1]!.passed).toBe(false);
  });

  it("rejects failed native tool calls even when the original turn eventually succeeds", () => {
    const { evidence, event } = fixture();
    const rows = [...fixture().afterRows, event(6, "tool.execution.completed", { executionId: "failed-write", status: "failed", output: "private timeout" }),
      event(7, "turn.completed"), event(8, "run.result.accepted", {}, "control_plane", 1), event(9, "run.terminal", {}, "control_plane", 2)];
    evidence.final.events = projectRemoteRestartEvents(evidence.final.run, rows);
    expect(gradeRemoteRestart(evidence).every(check => check.passed)).toBe(false);
  });

  it("accepts identical activity receipt redelivery without treating it as another submission", () => {
    const { evidence } = fixture();
    evidence.final.events.push({ ...evidence.final.events[1]!, seq: 10, sourceSeq: 10, sourceEventId: "runner:run:10" },
      { ...evidence.final.events[3]!, seq: 11, sourceSeq: 11, sourceEventId: "runner:run:11" });
    expect(gradeRemoteRestart(evidence).every(check => check.passed)).toBe(true);
  });

  it.each(["replacement", "second submission", "changed tool receipt", "changed start receipt", "missing terminal"])("rejects %s at completion", fault => {
    const { evidence } = fixture();
    if (fault === "replacement") evidence.final.run.id = "replacement";
    if (fault === "second submission") evidence.final.events.push({ ...evidence.final.events[0]!, seq: 10, sourceSeq: 10, sourceEventId: "runner:run:10" });
    if (fault === "changed tool receipt") evidence.final.events.push({ ...evidence.final.events[3]!, seq: 10, sourceSeq: 10, sourceEventId: "runner:run:10", payloadSha256: "0".repeat(64) });
    if (fault === "changed start receipt") evidence.final.events.push({ ...evidence.final.events[1]!, seq: 10, sourceSeq: 10, sourceEventId: "runner:run:10", payloadSha256: "0".repeat(64) });
    if (fault === "missing terminal") evidence.final.events.pop();
    expect(gradeRemoteRestart(evidence)[1]!.passed).toBe(false);
  });

  it.each(["no receipt", "foreign receipt", "wrong phase", "pending operation", "failed copyback", "retry", "recovery"])("rejects %s after useful work", fault => {
    const { evidence } = fixture();
    if (fault === "no receipt") evidence.final.operations = [];
    if (fault === "foreign receipt") evidence.final.operations[0]!.heartbeatRunId = "other";
    if (fault === "wrong phase") evidence.final.operations[0]!.phase = "workspace_prepare";
    if (fault === "pending operation") evidence.final.operations.push({ ...evidence.final.operations[0]!, status: "running" });
    if (fault === "failed copyback") evidence.final.run.resultJson!.workspaceFinalizeStatus = "failed";
    if (fault === "retry") evidence.final.scheduledRetry = { runId: "run" };
    if (fault === "recovery") evidence.final.recoveryActions.push({ status: "active" });
    expect(gradeRemoteRestart(evidence)[2]!.passed).toBe(false);
  });

  it("rejects unexercised or foreign boundaries before any restart", () => {
    const f = fixture();
    expect(() => observeRemoteRestartBoundary({ ...f.active, status: "succeeded" }, f.rows, f.leases, f.scope)).toThrow("live native process");
    expect(() => observeRemoteRestartBoundary(f.active, f.rows.slice(0, 3), f.leases, f.scope)).toThrow("completed tool");
    expect(() => observeRemoteRestartBoundary(f.active, f.rows, [{ ...f.leases[0]!, companyId: "foreign" }], f.scope)).toThrow("exact active sandbox");
    const foreign = structuredClone(f.rows);
    foreign[0]!.payload.prpEvent.normalizedSessionId = "foreign";
    expect(() => observeRemoteRestartBoundary(f.active, foreign, f.leases, f.scope)).toThrow("foreign, duplicate or invalid");
  });

  it("exports hashes instead of provider text, tool output or sandbox IDs", () => {
    const { evidence } = fixture();
    const privateRun = { ...evidence.final.run, error: "private provider failure", runnerProfileJson: { provider: "private-provider" },
      resultJson: { ...evidence.final.run.resultJson, nextAttemptAt: "private-time", failureCode: "private-failure", summary: "private summary" } };
    expect(JSON.stringify(projectRemoteRestartRun(privateRun))).not.toContain("private");
    expect(JSON.stringify(evidence)).not.toContain("private");
  });
});
