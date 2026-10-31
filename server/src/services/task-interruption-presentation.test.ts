import { describe, expect, it } from "vitest";
import { projectTaskInterruption } from "./task-interruption-presentation.js";

const issue = { id: "task", companyId: "11111111-1111-4111-8111-111111111111", status: "blocked", assigneeAgentId: "agent", projectId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run", agentId: "agent", status: "failed", scheduledRetryAt: null,
  errorCode: "project_access_denied", error: null, livenessState: null,
  resultJson: { projectAccessDenied: { projectId: "22222222-2222-4222-8222-222222222222" } } };
const agent = { status: "idle", pauseReason: null };

function operatorStoppedRun() {
  return { ...run, status: "cancelled", runtimeMode: "native" as const, companyId: issue.companyId,
    nativeIssueId: issue.id, errorCode: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board",
      executionCancellation: { state: "requested" },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: run.id,
        companyId: issue.companyId, issueId: issue.id, scope: "run",
        reasonCode: "cancellation_run_only", dispatched: true, dispatchState: "acknowledged",
        intentAuditId: "intent", acknowledgementAuditId: "ack" },
    } };
}

describe("intentional native Stop presentation", () => {
  const workingIssue = { ...issue, status: "in_progress" };
  it("does not offer a failed-attempt Retry for an audited operator Stop that keeps its task in progress", () => {
    expect(projectTaskInterruption(workingIssue, { run: operatorStoppedRun(), agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false, userAction: null });
    expect(workingIssue.status).toBe("in_progress");
  });

  it.each([{ runId: "foreign" }, { companyId: "foreign" }, { issueId: "foreign" },
    { dispatchState: "pending" }, { dispatched: false }, { acknowledgementAuditId: undefined },
    { intentAuditId: 123 }, { acknowledgementAuditId: {} },
    { scope: "subtree" }])("retains failure presentation without the matching operator receipt %j", change => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: { ...stopped.resultJson,
      nativeCancellation: { ...stopped.resultJson.nativeCancellation, ...change } } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps pause, approval, non-user cancellation and new input authoritative", () => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: {
      ...stopped.resultJson, cancelledByActorType: "system" } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: false,
      wait: { id: "new-input", requestedAt: new Date() } }))
      .toMatchObject({ state: "working", canRetry: false });
  });
});

describe("task project-access interruption", () => {
  it("explains a project denial without offering a futile retry", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: false })).toMatchObject({
      state: "waiting_for_user", responsibility: "user", userAction: "project_access", canRetry: false,
      projectAccess: { agentId: "agent", projectId: "22222222-2222-4222-8222-222222222222", ready: false },
    });
  });

  it("projects the historical setup denial without requiring another failed run", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "setup_failed",
      error: "Project is outside this low-trust boundary.", resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ userAction: "project_access", canRetry: false });
  });

  it("offers an explicit retry after the project is added, without changing the failed run", () => {
    expect(projectTaskInterruption(issue, { run, agent, projectAccessAllowed: true, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true, projectAccess: { ready: true } });
    expect(run.status).toBe("failed");
  });

  it("shows an accepted retry as working after access is repaired", () => {
    const input = { run, agent, paused: false, approval: false, wait: { id: "request", requestedAt: new Date() } };
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true }))
      .toMatchObject({ state: "working", canRetry: false });
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true })).not.toHaveProperty("projectAccess");
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "project_access", canRetry: false });
  });

  it("does not reinterpret unrelated failures or an old assignee's denial", () => {
    for (const otherRun of [{ ...run, errorCode: "setup_failed", error: "Disk full", resultJson: null },
      { ...run, agentId: "previous-agent" }]) {
      expect(projectTaskInterruption(issue, { run: otherRun, agent, paused: false, approval: false }))
        .not.toHaveProperty("projectAccess");
    }
  });

  it("keeps approval, pause, running and completed states authoritative", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: true })).toMatchObject({ userAction: "approval" });
    expect(projectTaskInterruption(issue, { run, agent, paused: true, approval: false })).toMatchObject({ userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: { ...run, status: "running" }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "working" });
    expect(projectTaskInterruption({ ...issue, status: "done" }, { run, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved" });
  });
});
