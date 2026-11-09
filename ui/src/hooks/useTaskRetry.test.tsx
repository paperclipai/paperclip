// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { useTaskRetry } from "./useTaskRetry";
import { ExecutionBlockerNotice } from "../components/ExecutionBlockerNotice";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
vi.mock("../api/issues", () => ({ issuesApi: { retryTask: vi.fn() } }));
const issue = { id: "task", interruption: { observedRunId: "failed-run" } } as Issue;
function View({ task = issue }: { task?: Issue }) {
  const retry = useTaskRetry(task);
  return <><button onClick={retry.retry}>Retry</button>{retry.optimistic && <span>Thinking</span>}{retry.takingLonger && <span>Taking longer than usual…</span>}{retry.error && <ExecutionBlockerNotice
    presentation={{ intentId: "intent", responsibility: "system", state: "failed", canRetry: true,
      nextRetryAt: null, userAction: null, sourceRunIds: ["failed-run"], observedRunId: "failed-run" }}
    canRetry onRetry={retry.retry} error={retry.error} />}</>;
}
describe("optimistic task Retry", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });
  async function render(task = issue) { await act(async () => root.render(<QueryClientProvider client={client}><View task={task} /></QueryClientProvider>)); }
  it("shows the saved-work continuation path after normal Retry is definitively denied", async () => {
    const message = "This attempt already recorded a result. Send a new message on the task to continue from the saved work.";
    vi.mocked(issuesApi.retryTask).mockRejectedValue(new ApiError(message, 409,
      { error: message, details: { code: "chat_failed_run_retry_not_authorized", reason: "accepted_result_without_new_input" } }));
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(issuesApi.retryTask).toHaveBeenCalledExactlyOnceWith("task", {
      observedRunId: "failed-run", idempotencyKey: expect.any(String),
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.textContent).not.toContain("Thinking");
    expect(container.textContent).not.toContain("Taking longer");
  });
  it.each([
    ["a replaced attempt", { requestId: null, accepted: false, stale: true }, "already replaced, so Retry did not start new work"],
    ["a scheduled retry held by a gate", { requestId: "retry", accepted: true, stale: false,
      scheduledRetry: { outcome: "gate_suppressed" as const, message: "The company budget is paused." } }, "The company budget is paused."],
    ["a scheduled retry still waiting", { requestId: "retry", accepted: true, stale: false,
      scheduledRetry: { outcome: "waiting" as const, message: "The retry is waiting for the workspace." } }, "waiting for the workspace"],
  ])("shows why Retry did not start work for %s", async (_label, result, reason) => {
    const presentation = { intentId: "intent", responsibility: "system" as const, state: "retry_scheduled" as const,
      canRetry: true, nextRetryAt: null, userAction: null, sourceRunIds: ["failed-run"], observedRunId: "failed-run" };
    vi.mocked(issuesApi.retryTask).mockResolvedValue({ ...result, presentation } as Awaited<ReturnType<typeof issuesApi.retryTask>>);
    const waiting = { ...issue, interruption: presentation } as Issue;
    await render(waiting);
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(reason);
    expect(container.textContent).not.toContain("Thinking");
    await render({ ...waiting, interruption: { ...presentation, state: "working", canRetry: false } } as Issue);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("shows nothing extra when Retry promoted the scheduled run", async () => {
    vi.mocked(issuesApi.retryTask).mockResolvedValue({ requestId: "retry", accepted: true, stale: false,
      scheduledRetry: { outcome: "promoted", message: "Retry promoted" }, presentation: null });
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("refreshes the inspected file recovery after an accepted Retry", async () => {
    vi.mocked(issuesApi.retryTask).mockResolvedValue({ requestId: "retry", accepted: true, stale: false,
      observedRunId: "failed-run", presentation: null } as Awaited<ReturnType<typeof issuesApi.retryTask>>);
    const key = queryKeys.issues.recoveryActions("task", "hold", "failed-run");
    client.setQueryData(key, { active: null, actions: [] });
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("paints Thinking before admission resolves and shares the same request across double clicks", async () => {
    let settle!: (value: Awaited<ReturnType<typeof issuesApi.retryTask>>) => void;
    vi.mocked(issuesApi.retryTask).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Thinking");
    const request = vi.mocked(issuesApi.retryTask).mock.calls[0][1];
    await act(async () => container.querySelector("button")!.click());
    expect(vi.mocked(issuesApi.retryTask).mock.calls[1][1]).toEqual(request);
    await act(async () => { settle({ requestId: "intent", accepted: true, stale: false, presentation: null }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).not.toContain("Thinking");
  });
  it("reconciles an unknown admission with the original idempotency key after ten seconds", async () => {
    vi.useFakeTimers(); vi.mocked(issuesApi.retryTask).mockImplementation(() => new Promise(() => {}));
    await render(); await act(async () => container.querySelector("button")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.textContent).toContain("Taking longer than usual…");
    expect(issuesApi.retryTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(issuesApi.retryTask).mock.calls[1]).toEqual(vi.mocked(issuesApi.retryTask).mock.calls[0]);
  });
  it("does not let an old task response settle a newer task's optimistic request", async () => {
    const settlements: Array<(value: Awaited<ReturnType<typeof issuesApi.retryTask>>) => void> = [];
    vi.mocked(issuesApi.retryTask).mockImplementation(() => new Promise(resolve => settlements.push(resolve)));
    await render(); await act(async () => container.querySelector("button")!.click());
    await render({ ...issue, id: "other-task" }); await act(async () => container.querySelector("button")!.click());
    await act(async () => settlements[0]({ requestId: "old", accepted: true, stale: false, presentation: null }));
    expect(container.textContent).toContain("Thinking");
  });
  it.each(["id", "identifier"])("reads a deferred Retry reason on the %s route and stops checking once explained", async route => {
    vi.useFakeTimers();
    const presentation = { intentId: "intent", responsibility: "system" as const, state: "failed" as const,
      canRetry: true, nextRetryAt: null, userAction: null, sourceRunIds: ["failed-run"], observedRunId: "failed-run" };
    let saved = { ...issue, identifier: "RTA-1", interruption: presentation } as Issue;
    const queryFn = vi.fn(async () => saved);
    const detailKey = queryKeys.issues.detail(route === "identifier" ? saved.identifier! : issue.id);
    client.setQueryData(detailKey, saved);
    function Observed() {
      const { data } = useQuery({ queryKey: detailKey, queryFn, staleTime: Infinity });
      const retry = useTaskRetry(data);
      return <ExecutionBlockerNotice presentation={data?.interruption} canRetry onRetry={retry.retry}
        optimistic={retry.optimistic} takingLonger={retry.takingLonger} error={retry.error} />;
    }
    vi.mocked(issuesApi.retryTask).mockResolvedValue({ requestId: "intent", accepted: true, stale: false, presentation });
    await act(async () => root.render(<QueryClientProvider client={client}><Observed /></QueryClientProvider>));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    saved = { ...saved, interruption: { ...presentation, retryWait: {
      reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved.",
    } } };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(container.textContent).toContain(saved.interruption!.retryWait!.message);
    const reads = queryFn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(queryFn).toHaveBeenCalledTimes(reads);
    expect(issuesApi.retryTask).toHaveBeenCalledTimes(1);
  });
});
