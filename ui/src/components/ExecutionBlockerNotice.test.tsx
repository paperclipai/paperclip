// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { recoveryActions: vi.fn(), listAttachments: vi.fn(), reconstructWorkspace: vi.fn() } }));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: null, actions: [] });
    vi.mocked(issuesApi.listAttachments).mockResolvedValue([]);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("keeps the recovery guidance and an inspection link alongside Retry", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toContain("Recorded work is preserved");
    expect(notice.textContent).toContain("Retry");
    expect(notice.classList.contains("task-context-notice")).toBe(true);
    expect(notice.querySelector("a")?.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
  });
  it.each([false, true])("explains cancelled runs and saved input; continue eligibility %s", async canContinue => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent",
        cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled",
        runError: "Provider cancelled execution", savedMessageCount: 2, canContinue,
        nextAction: canContinue ? "Verify provider shutdown before continuing."
          : "Inspect the run before sending a new message to request continuation.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Provider cancelled execution");
    expect(container.textContent).toContain("2 saved messages are waiting");
    expect(container.querySelector("a")?.getAttribute("href")).toContain("cancelled-run");
    expect(container.querySelector("button")?.textContent ?? null).toBe(canContinue ? "Continue" : null);
    if (!canContinue) expect(container.textContent).toContain("sending a new message to request continuation");
    if (canContinue) {
      vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "cancelled-run", "company");
    }
  });
  it("keeps removed-chat guidance without suggesting a message to an unavailable destination", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent",
        cause: "legacy_execution_requires_reconciliation", runStatus: "cancelled", canContinue: false,
        nextAction: "This chat connection was removed. Inspect the stopped run and create a new task to continue the work.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("create a new task");
    expect(container.textContent).not.toContain("sending a new message");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("Inspect run");
  });
  it("keeps the required next action for other reconciliation causes", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "action_outcome_unknown",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
  });
  it.each(["native_continuation_requires_reconciliation", "native_session_cleanup_quarantined"])("links to the source run instead of offering a retry rejected by %s", async (cause) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
        cause,
        nextAction: "Inspect the original failure and reconcile the previous execution before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Work paused.");
    expect(container.textContent).not.toContain("Retry");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Inspect run");
    expect(link.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });
  it("keeps workspace repair guidance and inspection without offering the legacy Retry fallback", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" issueStatus="blocked" canManage onRetried={onRetried} blocker={{
        recoveryActionId: "repair", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        workspaceRepairRequired: true, canRecordWorkspaceRepair: true, canRetry: false, canContinue: false,
        nextAction: "The original sandbox is retained. Recover the missing files and record workspace repair evidence.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("The workspace needs operator attention");
    // The hold also covers unsafe archives and local runs, so the notice must not promise retries or a kept sandbox.
    expect(container.textContent).not.toContain("retrying");
    expect(container.textContent).not.toContain("no work is lost");
    expect(container.querySelector("details")?.textContent).toContain("Recover the missing files");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("textarea, input")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("Inspect run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves source reconstruction and its queued state: %s", async pending => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" canManage issueStatus="blocked" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "native_workspace_sync_out_unrecoverable",
        workspaceRepairRequired: true, canReconstructWorkspace: !pending, workspaceReconstructionPending: pending,
        workspaceRecoveryStatusVersion: 1, nextAction: pending ? "Continuation from saved sources is queued and waiting for execution checks." : "Inspect surviving source attachments.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain(pending ? "Continuation queued." : "Continue from saved sources");
    expect(container.textContent).not.toContain(pending ? "Work paused." : "recovered workspace files");
    expect(container.querySelector("summary")?.closest("details")?.open).toBe(false);
    expect(issuesApi.reconstructWorkspace).not.toHaveBeenCalled();
    if (pending) {
      expect(container.querySelector("textarea")).toBeNull();
      expect(issuesApi.listAttachments).not.toHaveBeenCalled();
    }
  });

  it.each(["running", "missed", "wrong-run", "replay-blocked", "delegated"])("uses observed recovery liveness, including for readers: %s", async state => {
    const action = { id: "recovery", kind: "active_run_watchdog", status: "active", ownerType: "agent",
      evidence: { runId: state === "wrong-run" ? "other-run" : "failed-run",
        automaticRecovery: { replay: state === "replay-blocked" ? "blocked" : "held" } },
      attemptCount: 1, maxAttempts: 3, outcome: state === "delegated" ? "delegated" : null,
      wakePolicy: state === "delegated" ? null : { kind: "resume_native_run", runId: "failed-run", attempt: 1, maxAttempts: 3, notBefore: "2020-01-01T00:00:00Z" },
      nativeRunActivity: state === "missed" ? null : { runId: "failed-run", status: "running" },
    };
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: action, actions: [action] } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="live-task" issueStatus="blocked" canManage={false} onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", workspaceRepairRequired: true,
        cause: "native_continuation_requires_reconciliation", nextAction: "Operator inspection is required.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(Boolean(container.querySelector('[aria-label="Task recovery"]'))).toBe(state !== "running");
  });

  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });

  it("reveals a missed retry when every recovery poll returns identical data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
    try {
      const action = { id: "recovery", kind: "active_run_watchdog", status: "active", ownerType: "agent", outcome: null,
        evidence: { runId: "failed-run" }, attemptCount: 1, maxAttempts: 3,
        wakePolicy: { kind: "resume_native_run", runId: "failed-run", attempt: 1, maxAttempts: 3,
          notBefore: "2026-10-18T00:00:10Z" }, nativeRunActivity: null };
      const response = { active: action, actions: [action] };
      vi.mocked(issuesApi.recoveryActions).mockResolvedValue(response as never);
      await act(async () => root.render(<QueryClientProvider client={client}>
        <ExecutionBlockerNotice companyId="company" issueId="expiry-task" issueStatus="blocked" onRetried={onRetried} blocker={{
          recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
          cause: "native_continuation_requires_reconciliation", nextAction: "Inspect the missed recovery.",
        }} />
      </QueryClientProvider>));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(container.querySelector('[aria-label="Task recovery"]')).toBeNull();
      const before = vi.mocked(issuesApi.recoveryActions).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(41_000); });
      expect(vi.mocked(issuesApi.recoveryActions).mock.calls.length).toBeGreaterThan(before);
      expect(container.querySelector('[aria-label="Task recovery"]')).not.toBeNull();
      expect(container.textContent).toContain("Inspect the missed recovery.");
    } finally { vi.useRealTimers(); }
  });

  it("shows a recovery refresh error instead of trusting cached activity", async () => {
    const action = { id: "recovery", kind: "active_run_watchdog", status: "active", ownerType: "agent", outcome: null,
      evidence: { runId: "failed-run" }, attemptCount: 1, maxAttempts: 3,
      wakePolicy: { kind: "resume_native_run", runId: "failed-run" },
      nativeRunActivity: { runId: "failed-run", status: "running", workspaceOperationId: null } };
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: action, actions: [action] } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="read-error-task" issueStatus="blocked" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
        cause: "native_continuation_requires_reconciliation", nextAction: "Inspect the current run.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[aria-label="Task recovery"]')).toBeNull();
    vi.mocked(issuesApi.recoveryActions).mockRejectedValue(new Error("Recovery service unavailable"));
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.issues.recoveryActions("read-error-task", "recovery", "failed-run") }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Recovery service unavailable");
    expect(container.textContent).toContain("Inspect the current run.");
  });

  it.each([
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    "The selected model is not supported by the current ChatGPT connection. Choose a supported model or a compatible AI connection.",
  ])("shows the model rejection and repair action without expanding run logs: %s", async (runError) => {
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "model-run", agentId: "agent",
      status: "failed", errorCode: "native_provider_model_rejected" }] as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="model-task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "model-run", agentId: "agent",
        cause: "native_continuation_requires_reconciliation", canRetry: true,
        runError,
        nextAction: "Inspect the original failure before continuing.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Model unavailable.");
    expect(container.textContent).toContain(runError);
    expect(container.textContent).toContain("clear the task's model override, then retry");
    expect(container.textContent).toContain("Inspect the original failure before continuing.");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });

  it.each(["native_continuation_requires_reconciliation", "uncertain_external_action"])("offers Retry for a server-admitted native failure: %s", async cause => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause,
        canRetry: true,
        nextAction: "Automatic recovery stopped. Try again or send a new message to continue.",
      }} />
    </QueryClientProvider>));
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Retry");
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => button!.click());
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("shows a settled hold's decision even when there is no active recovery action", async () => {
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: null, actions: [{
      id: "recovery", status: "resolved", resolutionNote: "The last tool outcome could not be verified.",
      evidence: { runId: "cancelled-run", automaticRecovery: { replay: "blocked" } },
    }] as never });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" issueStatus="blocked" canManage onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent", runStatus: "cancelled",
        cause: "legacy_execution_requires_reconciliation", nextAction: "Send a new message after inspecting the run.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(issuesApi.recoveryActions).toHaveBeenCalledWith("task");
    expect(container.querySelector("details")?.textContent).toContain("The last tool outcome could not be verified.");
    expect(container.querySelector("details")?.textContent).toContain("stopped automatic retries");
    expect(container.querySelector("button")).toBeNull();
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });
  it("does not show a different run's historical recovery decision", async () => {
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: null, actions: [{
      id: "recovery", status: "resolved", resolutionNote: "Old decision",
      evidence: { runId: "another-run", automaticRecovery: { replay: "blocked" } },
    }] as never });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" issueStatus="blocked" canManage onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent",
        cause: "legacy_execution_requires_reconciliation", nextAction: "Inspect the current run.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Old decision");
  });
  it("reports a recovery history read failure without hiding the current guidance", async () => {
    vi.mocked(issuesApi.recoveryActions).mockRejectedValue(new Error("History unavailable"));
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" issueStatus="blocked" canManage onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent",
        cause: "legacy_execution_requires_reconciliation", nextAction: "Inspect the current run.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("History unavailable");
    expect(container.textContent).toContain("Inspect the current run.");
  });
  it("refreshes a decision while the same stopped run remains open", async () => {
    vi.mocked(issuesApi.recoveryActions).mockClear();
    vi.useFakeTimers();
    try {
      const action = { id: "recovery", status: "active", resolutionNote: "Inspection pending", evidence: { runId: "cancelled-run" } };
      vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: null, actions: [action] } as never);
      await act(async () => root.render(<QueryClientProvider client={client}>
        <ExecutionBlockerNotice companyId="company" issueId="task" issueStatus="blocked" canManage onRetried={onRetried} blocker={{
          recoveryActionId: "recovery", runId: "cancelled-run", agentId: "agent",
          cause: "legacy_execution_requires_reconciliation", nextAction: "Inspect the current run.",
        }} />
      </QueryClientProvider>));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(container.textContent).toContain("Inspection pending");
      vi.mocked(issuesApi.recoveryActions).mockResolvedValue({ active: null, actions: [{ ...action,
        status: "resolved", resolutionNote: "Preserved work; automatic replay stopped", evidence: {
          runId: "cancelled-run", automaticRecovery: { replay: "blocked" },
        },
      }] } as never);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
      expect(issuesApi.recoveryActions).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Preserved work; automatic replay stopped");
      expect(container.textContent).not.toContain("Inspection pending");
    } finally {
      vi.useRealTimers();
    }
  });
});
