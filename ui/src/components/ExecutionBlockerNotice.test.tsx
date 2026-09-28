// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({
  issuesApi: { recoveryActions: vi.fn(), resolveRecoveryAction: vi.fn() },
}));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [],
      referencedByExecutionBlocker: null,
      referencedByExecutionBlockerResolvable: false,
    } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("shows only the requested sentence and Retry, inside a distinct recovery container", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.Retry");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
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
    expect(container.textContent).toContain("Recovery needed.");
    expect(container.textContent).not.toContain("Retry");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Inspect run");
    expect(link.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });
  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
  // A hold is offered a resolution control only when this notice has nothing
  // else to offer; a failed run keeps the retry path authoritative.
  const stoppedRun = { runId: "stopped-run", agentId: "agent", status: "interrupted" };
  const settledHoldResponse = (resolvable: boolean) => ({
    active: null,
    actions: [{ id: "recovery", status: "resolved", cause: "native_event_replay_conflict" }],
    referencedByExecutionBlocker: "recovery",
    referencedByExecutionBlockerResolvable: resolvable,
  } as never);
  const renderNotice = async (blocker: Record<string, unknown>) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={blocker as never} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submitSettledResolution = async (evidence = "Provider receipts confirm the stopped run performed no action.") => {
    const resolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve recovery")!;
    expect(resolve.disabled).toBe(true);
    const stopped = container.querySelector<HTMLInputElement>('[aria-label="The stopped run has no live provider process"]')!;
    const evidenceInput = container.querySelector<HTMLInputElement>('[aria-label="Verified reconciliation evidence"]')!;
    await act(async () => { stopped.click(); });
    await act(async () => { setInputValue(evidenceInput, evidence); });
    await act(async () => { resolve.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };

  it("surfaces the settled recovery action the blocker references and resolves it with reconciling evidence", async () => {
    client.clear();
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([stoppedRun] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue(settledHoldResponse(true));
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({} as never);
    await renderNotice({
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent", cause: "native_event_replay_conflict",
      nextAction: "Verify the external action outcome before continuing.",
    });
    expect(container.textContent).toContain("Settled recovery action (native_event_replay_conflict) still holds this task. Reconcile the stopped run to resume it.");
    expect(issuesApi.recoveryActions).toHaveBeenCalledWith("task");
    await submitSettledResolution();
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", {
      actionId: "recovery", outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: "stopped-run", providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the stopped run performed no action.",
      },
    });
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("reports a refused resolution instead of dropping the settled action", async () => {
    client.clear();
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([stoppedRun] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue(settledHoldResponse(true));
    vi.mocked(issuesApi.resolveRecoveryAction).mockRejectedValue(new Error("Board access required"));
    await renderNotice({
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent", cause: "native_event_replay_conflict",
      nextAction: "Verify the external action outcome before continuing.",
    });
    await submitSettledResolution();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Board access required");
    expect(container.textContent).toContain("Settled recovery action (native_event_replay_conflict) still holds this task.");
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("keeps the retry notice unchanged and reports the settled hold beside it", async () => {
    client.clear();
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue(settledHoldResponse(true));
    await renderNotice({
      recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    });
    // The notice that reports the recorded run keeps its exact text and control.
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.Retry");
    expect([...notice.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Retry"]);
    // The hold that parks every wake is reported separately, with its own
    // decision, because a retry of the recorded run is deferred by that hold.
    const hold = container.querySelector('[role="status"][aria-label="Settled execution hold"]')!;
    expect(hold.textContent).toContain("Settled recovery action (native_event_replay_conflict) still holds this task.");
    expect([...hold.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Resolve recovery"]);
    expect(hold.querySelector('[aria-label="Recorded action outcome"]')).not.toBeNull();
  });
  it("does not offer a resolution for a hold the server reports as not resolvable", async () => {
    client.clear();
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([stoppedRun] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue(settledHoldResponse(false));
    await renderNotice({
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent", cause: "native_event_replay_conflict",
      nextAction: "Verify the external action outcome before continuing.",
    });
    expect(container.textContent).not.toContain("Settled recovery action");
    expect([...container.querySelectorAll("button")]).toHaveLength(0);
  });
  it("shows no settled action when the blocker does not reference one", async () => {
    client.clear();
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([stoppedRun] as never);
    vi.mocked(issuesApi.recoveryActions).mockResolvedValue({
      active: null,
      actions: [{ id: "recovery", status: "resolved", cause: "native_event_replay_conflict" }],
      referencedByExecutionBlocker: null,
      referencedByExecutionBlockerResolvable: false,
    } as never);
    await renderNotice({
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent", cause: "native_event_replay_conflict",
      nextAction: "Verify the external action outcome before continuing.",
    });
    expect(container.textContent).not.toContain("Settled recovery action");
    expect([...container.querySelectorAll("button")]).toHaveLength(0);
  });
});
