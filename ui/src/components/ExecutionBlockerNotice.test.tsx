// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n } from "@/i18n";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    await i18n.changeLanguage("en");
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
  afterEach(async () => {
    await act(async () => { root.unmount(); await i18n.changeLanguage("en"); });
    client.clear(); container.remove();
  });
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
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector("span")?.textContent).toBe("Verify the external action outcome before continuing.");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Восстановление задачи");
    expect(container.querySelector("a")).toBeNull();
  });
  it("retries the exact failed run and refreshes the task", async () => {
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledExactlyOnceWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
    for (const queryKey of [queryKeys.issues.detail("task"), queryKeys.issues.runs("task"),
      queryKeys.issues.liveRuns("task"), queryKeys.issues.activeRun("task")]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(notice.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(notice.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(agentsApi.retryFailedRun).toHaveBeenCalledOnce();
  });
  it("updates the compact recovery label and sentence across EN, RU, and EN without retrying", async () => {
    const notice = container.querySelector('[role="status"]')!;
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(notice.getAttribute("aria-label")).toBe("Восстановление задачи");
    expect(notice.querySelector("span")?.textContent).toBe("Автоматическое восстановление задачи остановлено.");
    expect(notice.querySelector("button")?.textContent).toBe("Повторить");
    expect(notice.querySelector("a")).toBeNull();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(notice.getAttribute("aria-label")).toBe("Task recovery");
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.Retry");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("keeps one pending retry and raw next-action content across EN, RU, and EN", async () => {
    let finishRetry!: () => void;
    vi.mocked(agentsApi.retryFailedRun).mockReturnValue(new Promise(resolve => {
      finishRetry = () => resolve({} as never);
    }));
    const nextAction = "Provider says: inspect /raw/path and keep {{user.content}} unchanged";
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "untrusted-blocker-agent", cause: "action_outcome_unknown", nextAction,
      }} />
    </QueryClientProvider>));
    expect(container.querySelector("span")?.textContent).toBe(nextAction);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector("button")?.textContent).toBe("Retrying…");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector("button")?.textContent).toBe("Повторная попытка…");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    expect(container.querySelector("span")?.textContent).toBe(nextAction);
    expect(container.querySelector("a")).toBeNull();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.querySelector("button")?.textContent).toBe("Retrying…");
    expect(container.querySelector("span")?.textContent).toBe(nextAction);
    expect(agentsApi.retryFailedRun).toHaveBeenCalledExactlyOnceWith("agent", "failed-run", "company");
    await act(async () => { finishRetry(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(onRetried).toHaveBeenCalledOnce();
  });
});
