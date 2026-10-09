// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskBrowser } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { browserUseApi } from "@/api/browser-use";
import { useBrowserArrivals, useTaskBrowsers } from "./useTaskBrowsers";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups = new Set<() => void>();
function cleanup() { for (const unmount of cleanups) unmount(); }
function renderHook<R, P = undefined>(callback: (props: P) => R, options?: { initialProps: P; client?: QueryClient }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let props = options?.initialProps as P;
  const result = {} as { current: R };
  function Harness() { result.current = callback(props); return null; }
  function rerender(next = props) {
    props = next;
    act(() => root.render(options?.client
      ? createElement(QueryClientProvider, { client: options.client }, createElement(Harness))
      : createElement(Harness)));
  }
  function unmount() { act(() => root.unmount()); host.remove(); cleanups.delete(unmount); }
  cleanups.add(unmount);
  rerender();
  return { result, rerender, unmount };
}
const browser = (id: string): TaskBrowser => ({
  id, sessionId: id, issueId: "task", status: "idle", runStatus: "completed",
  progress: null, costCents: 0, idleDeadline: null, expiresAt: null,
  error: null, createdAt: "2026-09-29T10:00:00Z",
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("starts browser polling when a chat draft becomes a saved task and stops on the next draft", async () => {
  vi.useFakeTimers();
  const list = vi.spyOn(browserUseApi, "list").mockResolvedValue([]);
  const client = new QueryClient();
  const taskId = "12345678-1234-4234-8234-123456789abc";
  const { rerender, unmount } = renderHook(useTaskBrowsers, {
    initialProps: undefined as string | undefined,
    client,
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(list).not.toHaveBeenCalled();
  rerender(`chat:${taskId}`);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(list).not.toHaveBeenCalled();
  rerender(taskId);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(list).toHaveBeenCalledExactlyOnceWith(taskId);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(list).toHaveBeenCalledTimes(2);
  rerender(`chat:${taskId}`);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(list).toHaveBeenCalledTimes(2);
  unmount();
  client.clear();
});
it("queues simultaneous arrivals and claims only after the panel acknowledges", () => {
  const browsers = [browser("first"), browser("next")];
  const { result, rerender } = renderHook(() => useBrowserArrivals("user", "task", browsers));
  expect(result.current.openBrowserId).toBe("first");
  expect(sessionStorage.length).toBe(0);
  rerender();
  expect(result.current.openBrowserId).toBe("first");
  act(() => result.current.acknowledgeBrowserOpened());
  expect(result.current.openBrowserId).toBe("next");
  act(() => result.current.acknowledgeBrowserOpened());
  expect(result.current.openBrowserId).toBe(null);
  rerender();
  expect(result.current.openBrowserId).toBe(null);
});
it("retries an unacknowledged arrival after remount and remembers successful openings", () => {
  const browsers = [browser("first")];
  const first = renderHook(() => useBrowserArrivals("user", "task", browsers));
  first.unmount();
  const second = renderHook(() => useBrowserArrivals("user", "task", browsers));
  expect(second.result.current.openBrowserId).toBe("first");
  act(() => second.result.current.acknowledgeBrowserOpened());
  second.unmount();
  const third = renderHook(() => useBrowserArrivals("user", "task", browsers));
  expect(third.result.current.openBrowserId).toBe(null);
});
it("keeps acknowledgements scoped to the user and task", () => {
  const browsers = [browser("first")];
  const { result, rerender } = renderHook(({ user, task }) => useBrowserArrivals(user, task, browsers), {
    initialProps: { user: "alice", task: "task" },
  });
  act(() => result.current.acknowledgeBrowserOpened());
  rerender({ user: "bob", task: "task" });
  expect(result.current.openBrowserId).toBe("first");
  act(() => result.current.acknowledgeBrowserOpened());
  rerender({ user: "alice", task: "another-task" });
  expect(result.current.openBrowserId).toBe("first");
});
it("does not steal focus when browser-tab storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  const browsers = [browser("first")];
  const { result, rerender } = renderHook(() => useBrowserArrivals("user", "task", browsers));
  act(() => result.current.acknowledgeBrowserOpened());
  rerender();
  expect(result.current.openBrowserId).toBe(null);
});
