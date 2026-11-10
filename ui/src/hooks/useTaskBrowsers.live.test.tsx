// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveEvent, TaskBrowser } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { browserUseApi } from "@/api/browser-use";
import { useTaskBrowsers } from "./useTaskBrowsers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const live = vi.hoisted(() => ({ connected: true, handler: null as ((event: LiveEvent) => void) | null }));
vi.mock("@/context/LiveUpdatesProvider", () => ({
  useHasCompanyLiveConnection: () => live.connected,
  useCompanyLiveEvent: (handler: (event: LiveEvent) => void) => { live.handler = handler; },
}));

const TASK = "12345678-1234-4234-8234-123456789abc";
const started: TaskBrowser = {
  id: "browser-1", sessionId: "session-1", issueId: TASK, status: "running", runStatus: "running",
  progress: null, costCents: 0, idleDeadline: null, expiresAt: null, error: null, createdAt: "2026-11-09T10:00:00Z",
};
let root: Root, host: HTMLDivElement, client: QueryClient;
let result: ReturnType<typeof useTaskBrowsers>;

function Harness() { result = useTaskBrowsers(TASK, "company-1"); return null; }
async function render() {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Harness))));
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function browserActivity(entityId = TASK, action = "browser.started") {
  return { id: 1, companyId: "company-1", type: "activity.logged", createdAt: "2026-11-09T10:00:00Z",
    payload: { entityType: "issue", entityId, action } } as LiveEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  live.connected = true;
  live.handler = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("stops polling an empty list while connected and reads again on this task's browser activity", async () => {
  const list = vi.spyOn(browserUseApi, "list").mockResolvedValue([]);
  await render();
  await advance(10_000);
  expect(list).toHaveBeenCalledTimes(1);
  list.mockResolvedValue([started]);
  await act(async () => live.handler?.(browserActivity()));
  await advance(1);
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.data).toEqual([started]);
  // A running browser keeps the poll so its state changes appear.
  await advance(3000);
  expect(list).toHaveBeenCalledTimes(3);
});

it("ignores other tasks' browsers and other task activity", async () => {
  const list = vi.spyOn(browserUseApi, "list").mockResolvedValue([]);
  await render();
  await advance(1);
  await act(async () => live.handler?.(browserActivity("other-task")));
  await act(async () => live.handler?.(browserActivity(TASK, "issue.comment_added")));
  await advance(10_000);
  expect(list).toHaveBeenCalledTimes(1);
});

it("reads again after a delayed empty read when the browser starts during that read", async () => {
  let release!: (value: TaskBrowser[]) => void;
  const list = vi.spyOn(browserUseApi, "list")
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue([started]);
  await render();
  await advance(1);
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => live.handler?.(browserActivity()));
  await advance(1);
  // The refresh waits for the older read instead of joining it.
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => release([]));
  await advance(1);
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.data).toEqual([started]);
});

it("reconciles once when the live connection opens and keeps polling while it is closed", async () => {
  live.connected = false;
  const list = vi.spyOn(browserUseApi, "list").mockResolvedValue([]);
  await render();
  await advance(1);
  await advance(6000);
  expect(list).toHaveBeenCalledTimes(3);
  live.connected = true;
  await render();
  await advance(1);
  expect(list).toHaveBeenCalledTimes(4);
  await advance(10_000);
  expect(list).toHaveBeenCalledTimes(4);
});
