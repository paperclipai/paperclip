// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));

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
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
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
});
