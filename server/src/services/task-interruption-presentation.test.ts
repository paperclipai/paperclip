import { describe, expect, it } from "vitest";
import { projectTaskInterruption } from "./task-interruption-presentation.js";

const issue = { id: "task", companyId: "11111111-1111-4111-8111-111111111111", status: "blocked", assigneeAgentId: "agent", projectId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run", agentId: "agent", status: "failed", scheduledRetryAt: null,
  errorCode: "project_access_denied", error: null, livenessState: null,
  resultJson: { projectAccessDenied: { projectId: "22222222-2222-4222-8222-222222222222" } } };
const agent = { status: "idle", pauseReason: null };

describe("unadmitted chat Retry presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: run.id,
    preparationStatus: "issued", preparationRetryAt: now + 250 };
  const input = { run: failed, agent, wait, paused: false, approval: false };

  it.each(["issued", "processing"])("uses the persisted %s outbox deadline without implying provider work", status => {
    for (const offset of [0, 20_000]) expect(projectTaskInterruption(issue, {
      ...input, wait: { ...wait, preparationStatus: status },
    }, now + offset)).toMatchObject({ state: "retry_scheduled", canRetry: false,
      nextRetryAt: new Date(wait.preparationRetryAt).toISOString() });
  });

  it.each(["failed", "cancelled"])("keeps terminal %s preparation out of the working state", status => {
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, preparationStatus: status,
      preparationRetryAt: null } }, now)).toMatchObject({ state: "failed", nextRetryAt: null });
  });

  it("keeps current gates and admitted execution authoritative", () => {
    expect(projectTaskInterruption(issue, { ...input, paused: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { ...input, approval: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    for (const status of ["queued", "running"]) expect(projectTaskInterruption(issue, {
      ...input, run: { ...failed, id: "successor", status },
    }, now)).toMatchObject({ state: "working", nextRetryAt: null });
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, sourceRunId: "old-run" } }, now))
      .toMatchObject({ state: "working", nextRetryAt: null });
  });
});

it("explains a persisted Retry wait without exposing the saved payload", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(), sourceRunId: failed.id,
    executionWaitReason: "workspace_repair_required" };
  const presentation = projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true,
    retryWait: { reason: "workspace_repair_required", message: "Retry is waiting for Paperclip to recover the saved files. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, sourceRunId: "another-run" }, paused: false, approval: false }))
    .not.toHaveProperty("retryWait");
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, executionWaitReason: "secret-payload" }, paused: false, approval: false }))
    .toMatchObject({ retryWait: { reason: "execution_recovery", message: "Retry is waiting for execution checks. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: true, approval: false }))
    .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
});

it.each(["cleanup_quarantined", "cancelled_by_operator"])("does not offer Retry for terminal Retry waits: %s", reason => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: reason } }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason } });
});

it("preserves the actual workspace preparation error without changing retry authority", () => {
  const failedRun = { ...run, errorCode: "workspace_validation_failed",
    error: "The selected project has no repository source for a remote workspace.", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false }))
    .toMatchObject({ state: "failed", canRetry: true, workspaceFailure: { message: failedRun.error } });
  for (const status of ["done", "cancelled"]) expect(projectTaskInterruption({ ...issue, status },
    { run: failedRun, agent, paused: false, approval: false })).not.toHaveProperty("workspaceFailure");
  expect(projectTaskInterruption(issue, { run: { ...failedRun, errorCode: "unrelated_failure" }, agent, paused: false, approval: false }))
    .not.toHaveProperty("workspaceFailure");
});

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

it("preserves a provider explanation on a failed task without changing retry authority", () => {
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "rate_limit", message: "API error: 429 This request would exceed your account's rate limit.",
    httpStatus: 429, retryability: "unknown" };
  const failedRun = { ...run, errorCode: "native_session_interrupted", resultJson: { providerFailure } };
  const presentation = projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true, providerFailure });
  expect(projectTaskInterruption({ ...issue, status: "done" }, { run: failedRun, agent, paused: false, approval: false }))
    .not.toHaveProperty("providerFailure");
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
