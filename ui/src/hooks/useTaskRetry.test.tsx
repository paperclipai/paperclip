// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { useTaskRetry } from "./useTaskRetry";
import { issuesApi } from "../api/issues";
vi.mock("../api/issues", () => ({ issuesApi: { retryTask: vi.fn() } }));
const issue = { id: "task", interruption: { observedRunId: "failed-run" } } as Issue;
function View({ task = issue }: { task?: Issue }) {
  const retry = useTaskRetry(task);
  return <><button onClick={retry.retry}>Retry</button>{retry.optimistic && <span>Thinking</span>}{retry.takingLonger && <span>Taking longer than usual…</span>}</>;
}
describe("optimistic task Retry", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });
  async function render(task = issue) { await act(async () => root.render(<QueryClientProvider client={client}><View task={task} /></QueryClientProvider>)); }
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
});
