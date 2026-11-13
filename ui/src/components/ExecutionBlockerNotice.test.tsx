// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import type { AnchorHTMLAttributes } from "react";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error } = {}) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...options} />));
  };
  it("offers one Retry without delegating infrastructure chores", async () => {
    await render();
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    // A stable handle for the task's own Retry, the supported path after
    // automatic recovery stops.
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector("a, details, input, textarea")).toBeNull();
    expect(container.textContent).not.toMatch(/service attention|process|receipt|workspace/i);
  });
  it("keeps the failure visible and names the gate while a saved Retry waits on the budget", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false });
    const notice = container.querySelector('[data-testid="task-execution-waiting"]');
    expect(notice?.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(notice?.textContent).toContain("waiting for the budget to allow new work");
    // The saved Retry starts by itself; a second Retry would only duplicate it.
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not report a failed attempt for a task the budget held before its first run", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false,
      sourceRunIds: [], observedRunId: null });
    const notice = container.querySelector('[data-testid="task-execution-waiting"]');
    expect(notice?.textContent).toContain("This task has not started.");
    expect(notice?.textContent).not.toContain("Couldn’t finish this attempt");
  });

  it("shows persisted backoff with a usable Retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z" });
    expect(container.textContent).toContain("Trying again in 30s");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(container.textContent).toContain("Trying again in 25s");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it.each(["working", "resolved"] as const)("does not duplicate the thread indicator for %s", async state => {
    await render({ ...failed, state }); expect(container.textContent).toBe("");
  });
  it("names the admission hold a task that has not started waits for", async () => {
    await render({ ...failed, state: "working", canRetry: false, sourceRunIds: [], observedRunId: null,
      retryWait: { reason: "budget.blocked", message: "Waiting for the budget to allow new work. The task starts automatically when it does." } });
    expect(container.textContent).toBe("Waiting for the budget to allow new work. The task starts automatically when it does.");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names and links the readable blockers a saved Retry waits on, with no second Retry (restart chaos t05)", async () => {
    const message = "Retry is waiting on a blocked task this one depends on. Retry or unblock it; this task continues when it is done. Your Retry is saved.";
    const summary = (id: string, identifier: string, title: string, status: string) =>
      ({ id, identifier, title, status, priority: "medium", assigneeAgentId: null, assigneeUserId: null }) as never;
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[summary("child", "CHA-10", "Part 2", "blocked"), summary("gone", "CHA-11", "Part 3", "cancelled"),
        summary("done", "CHA-9", "Part 1", "done")]} />));
    expect(container.textContent).toContain(message);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("[data-testid='retry-waiting-on'] a")].map(link => link.getAttribute("href"));
    expect(links).toHaveLength(2);
    expect(links[0]).toContain("CHA-10");
    expect(container.textContent).toContain("Blocked: open it to Retry");
    expect(container.textContent).toContain("Cancelled: remove or replace it");
    expect(container.textContent).not.toContain("Part 1");
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows a locked blocker without reading its status, and a finished blocker still saving files", async () => {
    const message = "Retry is waiting for a finished task this one depends on to save its files. Your Retry is saved.";
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[{ id: "secret", identifier: "CHA-12", locked: true } as never]} />));
    expect(container.querySelector("[data-testid='locked-issue-chip']")?.textContent).toContain("CHA-12");
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[{ id: "done", identifier: "CHA-9", title: "Part 1", status: "done", priority: "medium",
        assigneeAgentId: null, assigneeUserId: null } as never]} />));
    expect(container.querySelector("[data-testid='retry-waiting-on'] a")?.getAttribute("href")).toContain("CHA-9");
    expect(container.textContent).toContain("Saving its files");
  });
  it("names the saved-work recovery step instead of a bare queue", async () => {
    await render({ ...failed, state: "working", canRetry: false, recoveryStep: "saving_previous_files" });
    expect(container.textContent).toBe("Saving files from the previous attempt…");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the step a scheduled recovery will retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run" });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it("names the recovery step inside a provider failure notice", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run",
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "startup", category: "overloaded",
        retryability: "unknown", message: "Try later." } });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.textContent).not.toContain("Paperclip will retry automatically.");
  });
  it("leaves genuine user decisions to their specific action surface", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "approval", canRetry: false });
    expect(container.textContent).toBe("");
  });
  it("does not give read-only users a mutation", async () => {
    await render(failed, { canRetry: false }); expect(container.querySelector("button")).toBeNull();
  });
  it("removes the stale failure immediately while admission is pending", async () => {
    await render(failed, { optimistic: true }); expect(container.textContent).toBe("");
    await render(failed, { optimistic: true, takingLonger: true });
    expect(container.textContent).toContain("Taking longer than usual…");
  });
  it("shows a definitive admission rejection instead of silently dropping Retry", async () => {
    await render(failed, { error: new Error("Your task access changed. Refresh the task.") });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your task access changed.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
  it("shows workspace preparation failures as plain text while keeping retry permissions", async () => {
    const workspaceFailure = { message: 'Could not prepare the project folder <img src=x onerror=alert(1)>.' };
    await render({ ...failed, workspaceFailure }, { canRetry: false });
    expect(container.textContent).toContain("Couldn’t prepare the task folders.");
    expect(container.textContent).toContain(workspaceFailure.message);
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, workspaceFailure });
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, workspaceFailure, state: "working" });
    expect(container.textContent).toBe("");
  });
  it("names a failed workspace setup command and what to change, keeping Retry", async () => {
    const setupFailure = { step: "workspace_provision" as const, command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
      output: "bash: ./scripts/provision-worktree.sh: No such file or directory",
      message: "The project's workspace provision command \"bash ./scripts/provision-worktree.sh\" failed with exit code 127: bash: ./scripts/provision-worktree.sh: No such file or directory" };
    await render({ ...failed, setupFailure });
    expect(container.textContent).toContain("Couldn’t set up the task workspace.");
    expect(container.textContent).toContain(setupFailure.message);
    expect(container.textContent).toContain("Fix the command in the project’s workspace settings");
    expect(container.textContent).not.toContain("Couldn’t finish this attempt.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("shows why an accepted Retry is waiting and keeps another attempt available", async () => {
    const retryWait = { reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved." };
    await render({ ...failed, retryWait });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, retryWait }, { canRetry: false });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the budget wait alongside a provider failure while a saved Retry is held", async () => {
    const providerFailure = { schema: "paperclip.provider-failure.v1" as const, provider: "openai", phase: "startup" as const,
      category: "overloaded" as const, retryability: "transient" as const, message: "Provider overloaded" };
    await render({ ...failed, providerFailure, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false });
    expect(container.textContent).toContain("Provider overloaded");
    expect(container.querySelector('[data-testid="task-execution-waiting"]')?.textContent).toContain("waiting for the budget to allow new work");
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows an unknown provider's original explanation as text and preserves read-only access", async () => {
    const providerFailure = { schema: "paperclip.provider-failure.v1" as const, provider: "new-provider", phase: "startup" as const,
      category: "unknown" as const, retryability: "unknown" as const, httpStatus: 429,
      message: "Upstream failure <img src=x onerror=alert(1)>" };
    await render({ ...failed, providerFailure }, { canRetry: false });
    expect(container.textContent).toContain(providerFailure.message);
    expect(container.textContent).toContain("Failed before work started");
    expect(container.textContent).toContain("HTTP 429");
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, providerFailure, state: "resolved" });
    expect(container.textContent).toBe("");
  });
});
