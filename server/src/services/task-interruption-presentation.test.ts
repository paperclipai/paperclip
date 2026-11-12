import { describe, expect, it } from "vitest";
import { projectTaskInterruption } from "./task-interruption-presentation.js";

const issue = { id: "task", companyId: "11111111-1111-4111-8111-111111111111", status: "blocked", assigneeAgentId: "agent", projectId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run", agentId: "agent", status: "failed", scheduledRetryAt: null,
  errorCode: "project_access_denied", error: null, livenessState: null,
  resultJson: { projectAccessDenied: { projectId: "22222222-2222-4222-8222-222222222222" } } };
const agent = { status: "idle", pauseReason: null };

describe("saved governed wait shutdown", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const pending = { ...run, runtimeMode: "native", errorCode: "native_governed_wait_settlement_pending", resultJson: null };
  it("names automatic shutdown settlement without offering a duplicate Retry", () => {
    expect(projectTaskInterruption(issue, { run: { ...pending, nativeResumeAt: new Date(now + 30_000) }, agent,
      paused: false, approval: false }, now)).toMatchObject({ state: "working", canRetry: false,
        retryWait: { reason: "governed_wait_settlement", message: "Your work is saved. Paperclip is finishing shutdown." } });
  });
  it("explains exhausted shutdown recovery while preserving the saved work", () => {
    expect(projectTaskInterruption(issue, { run: pending, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "governed_wait_settlement",
        message: "Paperclip couldn’t confirm shutdown. Your work is saved; continuation is paused." } });
  });
  it("keeps genuine approvals authoritative", () => {
    expect(projectTaskInterruption(issue, { run: pending, agent, paused: false, approval: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
  });
});

describe("queued dependency wait presentation", () => {
  const waitingRun = { ...run, status: "cancelled", runtimeMode: "legacy" as const, startedAt: null,
    errorCode: "issue_dependencies_blocked", resultJson: {
      stopReason: "issue_dependencies_blocked", timeoutSource: "dependency_gate",
      cancellation: { source: "unknown", expected: false },
    } };

  it("keeps a dependency-gated wake out of the failed-attempt UI, including retained input", () => {
    for (const wait of [undefined, { id: "saved-input", requestedAt: new Date(0) }]) {
      expect(projectTaskInterruption(issue, { run: waitingRun, agent, wait, paused: false, approval: false }))
        .toMatchObject({ state: "resolved", canRetry: false });
    }
  });

  it.each(["legacy", "native"])("keeps an unstarted %s dispatcher dependency wait neutral", runtimeMode => {
    const dispatchedWait = { ...waitingRun, runtimeMode,
      resultJson: { ...waitingRun.resultJson, timeoutSource: "stale_queued_run_gate" } };
    expect(projectTaskInterruption(issue, { run: dispatchedWait, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(issue, { run: { ...dispatchedWait, startedAt: new Date() }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps genuine failures and current user gates visible", () => {
    for (const changed of [{ status: "failed" }, { runtimeMode: "native" }, { startedAt: new Date() },
      { errorCode: "setup_failed" }, { resultJson: {} }, { resultJson: { ...waitingRun.resultJson, timeoutFired: true } }]) {
      expect(projectTaskInterruption(issue, { run: { ...waitingRun, ...changed }, agent, paused: false, approval: false }))
        .toMatchObject({ state: "failed", canRetry: true });
    }
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      action: { evidence: {}, status: "active" } as never })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: waitingRun.id, requestedAt: new Date(), preparationStatus: "failed" } }))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("never-started task refused by admission", () => {
  const todo = { ...issue, status: "todo" };
  const admissionWait = { id: "wake", status: "skipped", reason: "budget.blocked", agentId: "agent" };
  it("names an accounting hold as an automatic wait without a Retry", () => {
    expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false })).toMatchObject({
      responsibility: "system", state: "working", canRetry: false,
      retryWait: { reason: "budget.blocked", message: expect.stringContaining("starts automatically") } });
  });
  it("keeps pauses and budget stops as user actions instead of promising an automatic start", () => {
    for (const [state, action] of [
      [{ project: { pausedAt: new Date(), pauseReason: null } }, "resume"],
      [{ company: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ paused: true }, "resume"],
      [{ agent: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ company: { status: "paused", pauseReason: "budget" } }, "budget"],
      [{ approval: true }, "approval"],
    ] as const) {
      expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false, ...state }))
        .toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: action });
    }
  });
  it("shows nothing for other refusals, started tasks or another assignee", () => {
    for (const changed of [{ reason: "agent.not_invokable" }, { status: "queued" }, { agentId: "other" }]) {
      expect(projectTaskInterruption(todo, { agent, admissionWait: { ...admissionWait, ...changed }, paused: false, approval: false }))
        .toBeNull();
    }
    expect(projectTaskInterruption({ ...todo, status: "cancelled" }, { agent, admissionWait, paused: false, approval: false })).toBeNull();
  });
});

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

// The native coordinator resumes the same run itself after an attach failure.
// A manual Retry offered meanwhile would race that automatic resume.
it("shows a pending native same-run resume instead of a competing Retry", () => {
  const now = Date.parse("2026-11-06T15:25:50.000Z");
  const failed = { ...run, runtimeMode: "native" as const, errorCode: "native_session_interrupted", resultJson: null };
  const resumeAt = new Date("2026-11-06T15:26:18.687Z");
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: resumeAt }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: resumeAt.toISOString() });
  // A due resume is being dispatched; it is still not the user's turn.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 30_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "working", canRetry: false });
  // A resume that never ran, or no resume at all, leaves exactly one Retry.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 10 * 60_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
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

it("names a budget gate instead of generic execution checks for a refused Retry", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "budget.blocked" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "budget.blocked",
      message: "Retry is waiting for the budget to allow new work. Check Costs for unrecorded or unpriced usage." } });
});

it.each(["cancelled_by_operator", "retry_source_changed"])("does not offer Retry for terminal Retry waits: %s", reason => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: reason } }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason } });
});

it("holds a Retry on a cleanup gate only while an owner settles it", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "cleanup_quarantined" };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, wait, cleanupSettling: true }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "cleanup_quarantined" } });
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, wait }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "cleanup_quarantined" } });
});

it("keeps Retry for a Retry declined for its requester's access, since a new click replaces it", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "retry_authority_denied" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "retry_authority_denied" } });
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

describe("setup command failure presentation (CF1)", () => {
  const setupError = "Execution workspace provision command \"bash ./scripts/provision-worktree.sh\" failed: bash: ./scripts/provision-worktree.sh: No such file or directory";
  const setupRun = { ...run, errorCode: "setup_failed", error: setupError, resultJson: { setupCommandFailure: {
    step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
    output: "bash: ./scripts/provision-worktree.sh: No such file or directory" } } };

  it("names the broken setup command on the task without changing retry authority", () => {
    const withCause = projectTaskInterruption(issue, { run: setupRun, agent, paused: false, approval: false });
    const withoutCause = projectTaskInterruption(issue, { run: { ...setupRun, error: "x", resultJson: null }, agent, paused: false, approval: false });
    expect(withCause).toMatchObject({ state: "failed", canRetry: true, userAction: null, setupFailure: {
      step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
      message: "The project's workspace provision command \"bash ./scripts/provision-worktree.sh\" failed with exit code 127: bash: ./scripts/provision-worktree.sh: No such file or directory" } });
    const { setupFailure: _named, ...rest } = withCause!;
    expect(rest).toEqual(withoutCause);
    expect(withCause).not.toHaveProperty("workspaceFailure");
  });

  it("recognizes a setup failure recorded before the structured cause existed", () => {
    expect(projectTaskInterruption(issue, { run: { ...setupRun, resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", setupFailure: { step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh",
        exitCode: null, output: "bash: ./scripts/provision-worktree.sh: No such file or directory" } });
  });

  it("keeps a transient setup retry scheduled and only adds the name", () => {
    const retrying = { ...setupRun, status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60_000), scheduledRetryReason: "transient_failure" };
    const named = projectTaskInterruption(issue, { run: retrying, agent, paused: false, approval: false });
    const unnamed = projectTaskInterruption(issue, { run: { ...retrying, error: "x", resultJson: null }, agent, paused: false, approval: false });
    expect(named?.setupFailure?.command).toBe("bash ./scripts/provision-worktree.sh");
    const { setupFailure: _named, ...rest } = named!;
    expect(rest).toEqual(unnamed);
  });

  it("bounds the output tail and strips credentials from the command", () => {
    const noisy = { ...setupRun, resultJson: { setupCommandFailure: { step: "workspace_provision",
      command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ./setup.sh --password hunter22", exitCode: 1,
      output: `${"x".repeat(5_000)}\nfinal line` } } };
    const failure = projectTaskInterruption(issue, { run: noisy, agent, paused: false, approval: false })?.setupFailure;
    expect(failure?.command).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(failure?.command).not.toContain("hunter22");
    expect(failure?.output?.length).toBeLessThanOrEqual(300);
    expect(failure?.output).toMatch(/final line$/);
  });

  it("recognizes older quoted and multiline commands", () => {
    for (const command of ['bash "./scripts/provision-worktree.sh"', "set -e\n./setup.sh"]) {
      expect(projectTaskInterruption(issue, { run: { ...setupRun, resultJson: null,
        error: `Execution workspace provision command "${command}" failed with exit code 2` }, agent, paused: false, approval: false })?.setupFailure)
        .toMatchObject({ command, exitCode: 2 });
    }
  });

  it("does not name setup for other failures or settled tasks", () => {
    expect(projectTaskInterruption(issue, { run: { ...setupRun, errorCode: "adapter_failed" }, agent, paused: false, approval: false }))
      .not.toHaveProperty("setupFailure");
    expect(projectTaskInterruption({ ...issue, status: "done" }, { run: setupRun, agent, paused: false, approval: false }))
      .not.toHaveProperty("setupFailure");
  });
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

describe("saved-work recovery step", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "setup_failed", resultJson: null };
  const system = (phase: string, state: string, nextAttemptAt: number | null) => ({
    schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: "33333333-3333-4333-8333-333333333333", revision: 3,
    generationId: "44444444-4444-4444-8444-444444444444", intentId: null, phase, state, attemptId: null, attempts: 2,
    retriesUsed: 1, firstFailureAt: now - 60_000, nextAttemptAt, deadlineAt: now + 600_000, providerCooldownAt: null,
    failure: null, preservationOperationIds: [], freshAttemptRunId: null });
  const action = (evidence: Record<string, unknown>) => ({ evidence }) as never;

  it("names the step a scheduled recovery will retry", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) }) }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run" });
  });

  it("names the step a running recovery is on", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 }) }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
  });

  it("names recovery over a pending chat preparation and keeps failed preparation authoritative", () => {
    const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: failed.id, preparationStatus: "issued", preparationRetryAt: now + 250 };
    const running = action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: running }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
    const scheduled = action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run", canRetry: false });
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", canRetry: true });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, preparationStatus: "failed" },
      paused: false, approval: false, action: running }, now)).toMatchObject({ state: "failed" });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false }, now))
      .toMatchObject({ state: "retry_scheduled", nextRetryAt: new Date(now + 250).toISOString() });
  });

  it("does not name a step for an ordinary scheduled retry", () => {
    expect(projectTaskInterruption(issue, { run: { ...failed, scheduledRetryAt: new Date(now + 30_000) }, agent,
      paused: false, approval: false }, now)).not.toHaveProperty("recoveryStep");
  });
});

describe("scheduled resource wait presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const waiting = { ...run, status: "scheduled_retry", errorCode: null, resultJson: null,
    scheduledRetryReason: "workspace_busy", scheduledRetryAt: new Date(now - 60_000) };

  it("keeps an overdue workspace wait out of the failed-attempt UI", () => {
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "working", canRetry: false });
  });

  it("keeps failure retries, user gates and failed Retry preparation authoritative", () => {
    expect(projectTaskInterruption(issue, { run: { ...waiting, scheduledRetryReason: "transient_failure" },
      agent, paused: false, approval: false }, now)).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: true, approval: false }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: run.id, requestedAt: new Date(now), preparationStatus: "failed" } }, now))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("saved Retry held by dependencies", () => {
  const failedRun = { ...run, status: "failed", errorCode: "native_session_interrupted", resultJson: {} };
  const retryWait = { id: "retry", requestedAt: new Date(0), sourceRunId: "run" };
  const project = (retryDependencies: { count: number; blocked: boolean; cancelled: boolean; savingFilesOnly: boolean }) =>
    projectTaskInterruption(issue, { run: failedRun, agent, retryWait, paused: false, approval: false, retryDependencies });

  it.each([
    [{ count: 1, blocked: true, cancelled: false, savingFilesOnly: false }, "Retry or unblock it"],
    [{ count: 1, blocked: false, cancelled: true, savingFilesOnly: false }, "Remove or replace that dependency"],
    [{ count: 1, blocked: false, cancelled: false, savingFilesOnly: true }, "to save its files"],
    [{ count: 2, blocked: false, cancelled: false, savingFilesOnly: false }, "to finish"],
  ])("names what the saved Retry waits on (%o)", (dependencies, text) => {
    const presentation = project(dependencies);
    expect(presentation).toMatchObject({ state: "working", canRetry: false, intentId: "retry",
      retryWait: { reason: "dependency_blocked" } });
    expect(presentation?.retryWait?.message).toContain(text);
  });
});

describe("setup command failure evidence", () => {
  it("removes a registered secret that crosses the output cut before shortening", async () => {
    const { setupCommandFailureResultJson } = await import("./workspace-setup-command-failure.js");
    const secret = "registered-private-value-0123456789";
    const failure = Object.assign(new Error("setup failed"), { step: "workspace_provision", command: "./setup.sh", exitCode: 1,
      // The cut keeps the last 299 characters; it lands inside the secret.
      output: `${secret}${"y".repeat(299 - 10)}` });
    const recorded = setupCommandFailureResultJson(failure, [secret]);
    expect(recorded).toMatchObject({ setupCommandFailure: { step: "workspace_provision", exitCode: 1 } });
    const text = JSON.stringify(recorded);
    for (let index = 0; index + 8 <= secret.length; index += 1) expect(text).not.toContain(secret.slice(index, index + 8));
  });
});

describe("saved result that ran out of finalization retries", () => {
  const review = { ...issue, status: "in_review" };
  const succeeded = { ...run, status: "succeeded", runtimeMode: "native" as const, errorCode: null, resultJson: null };

  it("offers Retry for a succeeded run whose accepted result could not be finalized", () => {
    expect(projectTaskInterruption(review, { run: { ...succeeded, nativeFinalizationRetry: true }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true, observedRunId: "run" });
  });

  it("shows the saved result being applied after Retry", () => {
    expect(projectTaskInterruption(review, { run: { ...succeeded, nativeFinalizationRetryPending: true }, agent,
      paused: false, approval: false })).toMatchObject({ state: "working", canRetry: false, recoveryStep: "finishing_recovery" });
  });

  it("keeps ordinary succeeded and failed runs unchanged", () => {
    expect(projectTaskInterruption(review, { run: succeeded, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(review, { run: { ...succeeded, status: "failed", errorCode: "adapter_failed" }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption({ ...review, status: "done" }, { run: { ...succeeded, nativeFinalizationRetry: true },
      agent, paused: false, approval: false })).toMatchObject({ state: "resolved", canRetry: false });
  });
});

// Remote native run shape: the provider turn completed and its work was
// saved, then a same-run recovery was refused by the cleanup gate. The task
// showed "Couldn't finish this attempt" with a Retry the server refuses (409).
describe("native cleanup quarantine presentation", () => {
  const quarantined = { ...run, runtimeMode: "native" as const, errorCode: "native_session_cleanup_quarantined",
    error: "native_session_cleanup_quarantined: prior session cleanup requires operator recovery; verify its retained process ownership and checkpoint before a controlled restart. Clearing a task session does not resolve this quarantine.",
    resultJson: null, finishedAt: new Date("2026-11-10T14:39:31.873Z") };

  it("shows the task's blocker wait, not a failed attempt, after a completed turn", () => {
    expect(projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup: true }, agent,
      waitingOnBlockers: true, paused: false, approval: false })).toMatchObject({ state: "resolved", canRetry: false });
  });

  it("waits without Retry while an owner settles the gate", () => {
    for (const completedTurnCleanup of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        cleanupSettling: true, paused: false, approval: false });
      expect(presentation).toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "cleanup_quarantined" } });
      expect(presentation?.retryWait?.message).not.toMatch(/operator|admin/i);
    }
    const preparation = { id: "retry", requestedAt: new Date(0), sourceRunId: quarantined.id, preparationStatus: "failed" };
    expect(projectTaskInterruption(issue, { run: quarantined, agent, retryWait: preparation, cleanupSettling: true,
      paused: false, approval: false })).toMatchObject({ canRetry: false });
  });

  it("offers Retry when nothing settles the gate by itself (s9107 t04/t05)", () => {
    // An operator-required gate, or one lost with a restarted process, has no
    // owner. Waiting would never end, so Retry is the way forward.
    for (const completedTurnCleanup of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        paused: false, approval: false });
      expect(presentation).toMatchObject({ state: "failed", canRetry: true });
      expect(presentation).not.toHaveProperty("retryWait");
    }
  });

  it("never leaves a failed task without Retry, a scheduled retry or a settling owner", () => {
    // Invariant: a failed presentation without Retry must name a wait that an
    // owner is settling. Enumerate the quarantine-related inputs.
    const waits = [undefined, ...["cleanup_quarantined", "local_cleanup", "execution_settling"].map(reason =>
      ({ id: "retry", requestedAt: new Date(0), sourceRunId: quarantined.id, executionWaitReason: reason }))];
    for (const completedTurnCleanup of [true, false]) for (const wait of waits) for (const settling of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        retryWait: wait, cleanupSettling: settling, paused: false, approval: false });
      if (presentation?.state !== "failed" || presentation.canRetry) continue;
      expect(presentation.retryWait, JSON.stringify({ completedTurnCleanup, wait: wait?.executionWaitReason, settling }))
        .toBeDefined();
      if (presentation.retryWait?.reason === "cleanup_quarantined") expect(settling).toBe(true);
    }
  });

  it("keeps Retry for ordinary failed native attempts", () => {
    expect(projectTaskInterruption(issue, { run: { ...quarantined, errorCode: "native_session_interrupted" }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true });
  });
});
