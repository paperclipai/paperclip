// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueBlockerStalledWakeContext } from "@paperclipai/shared";
import { StalledDependencyNotice } from "./StalledDependencyNotice";
import { ApiError } from "../api/client";

const getIssue = vi.hoisted(() => vi.fn());
const retryTask = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/issues", () => ({ issuesApi: { get: getIssue, retryTask } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stall = (overrides: Partial<IssueBlockerStalledWakeContext> = {}): IssueBlockerStalledWakeContext => ({
  stalledIssueId: "child-1",
  stalledIssueIdentifier: "CHA-8",
  stalledIssueTitle: "Ship the migration",
  stalledIssueStatus: "blocked",
  relation: "child",
  recoveryAction: { id: "action-1", kind: "active_run_watchdog", cause: "native_session_retry_exhausted",
    status: "resolved", ownerType: "board", nextAction: "Automatic recovery stopped. Recorded work is preserved." },
  ...overrides,
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null; container = null;
  vi.clearAllMocks();
});

async function render(stalled: IssueBlockerStalledWakeContext[] | undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><StalledDependencyNotice stalled={stalled} /></QueryClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

async function waitFor<T>(read: () => T | null): Promise<T | null> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  return read();
}

describe("StalledDependencyNotice", () => {
  it("renders nothing without stalled dependencies", async () => {
    const node = await render([]);
    expect(node.querySelector("[data-testid='stalled-dependency-notice']")).toBeNull();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("names the stalled child, its board action and a link, and offers the child's own Retry", async () => {
    getIssue.mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "blocked", interruption: { canRetry: true, observedRunId: "run-1" } });
    retryTask.mockResolvedValue({ accepted: true, presentation: null });
    const node = await render([stall()]);
    const notice = node.querySelector("[data-testid='stalled-dependency-notice']")!;
    expect(notice.textContent).toContain("A dependency needs the board");
    expect(notice.textContent).toContain("CHA-8");
    expect(notice.textContent).toContain("Ship the migration");
    expect(notice.textContent).toContain("Automatic recovery stopped");
    expect(notice.querySelector("a")?.getAttribute("href")).toContain("CHA-8");
    const button = await waitFor(() => notice.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']"));
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
    expect(retryTask).toHaveBeenCalledWith("child-1", expect.objectContaining({ observedRunId: "run-1" }));
  });

  it("explains a refused Retry and lets the board try again", async () => {
    getIssue.mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "blocked", interruption: { canRetry: true, observedRunId: "run-1" } });
    retryTask.mockRejectedValue(new ApiError("Retry is not allowed while the run is still stopping", 409, {}));
    const node = await render([stall()]);
    const button = await waitFor(() => node.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']"));
    await act(async () => { button!.click(); });
    const alert = await waitFor(() => node.querySelector("[role='alert']"));
    expect(alert?.textContent).toBeTruthy();
    expect(node.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']")?.disabled).toBe(false);
  });

  it("shows a lost response as taking longer, with Retry still available", async () => {
    getIssue.mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "blocked", interruption: { canRetry: true, observedRunId: "run-1" } });
    retryTask.mockRejectedValue(new Error("network down"));
    const node = await render([stall()]);
    const button = await waitFor(() => node.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']"));
    await act(async () => { button!.click(); });
    const status = await waitFor(() => [...node.querySelectorAll("[role='status']")].find(element => element.textContent?.includes("Taking longer")) ?? null);
    expect(status).toBeTruthy();
    expect(node.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']")?.disabled).toBe(false);
  });

  it("says when the child's state cannot be read and offers a reload", async () => {
    getIssue.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "blocked",
      interruption: { canRetry: true, observedRunId: "run-1" } });
    const node = await render([stall()]);
    const alert = await waitFor(() => node.querySelector("[role='alert']"));
    expect(alert?.textContent).toContain("Could not load this task's state");
    const reload = [...node.querySelectorAll("button")].find(button => button.textContent === "Reload")!;
    await act(async () => { reload.click(); });
    expect(await waitFor(() => node.querySelector("button[aria-label='Retry CHA-8']"))).not.toBeNull();
  });

  it("drops a stall once the child's refreshed state has moved on", async () => {
    getIssue.mockResolvedValueOnce({ id: "child-1", identifier: "CHA-8", status: "blocked", interruption: { canRetry: true, observedRunId: "run-1" } })
      .mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "in_progress", interruption: { canRetry: false } });
    retryTask.mockResolvedValue({ accepted: true, presentation: { canRetry: false } });
    const node = await render([stall()]);
    const button = await waitFor(() => node.querySelector<HTMLButtonElement>("button[aria-label='Retry CHA-8']"));
    await act(async () => { button!.click(); });
    expect(await waitFor(() => node.querySelector("[data-testid='stalled-dependency-notice']") ? null : true)).toBe(true);
  });

  it("omits Retry when the child's task state does not offer it", async () => {
    getIssue.mockResolvedValue({ id: "child-1", identifier: "CHA-8", status: "blocked", interruption: { canRetry: false } });
    const node = await render([stall({ relation: "blocker" })]);
    await waitFor(() => (getIssue.mock.calls.length > 0 ? true : null));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(node.textContent).toContain("Blocker");
    expect(node.querySelector("button")).toBeNull();
  });
});
