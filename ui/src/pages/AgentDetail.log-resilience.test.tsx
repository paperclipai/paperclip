// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { ConnectivityProvider, createConnectivityStore, type ConnectivityStore } from "../lib/connectivity";
import { LogViewer } from "./AgentDetail";
import { LogViewer as ProductionLogViewer } from "./AgentDetail.production";

const { log, events, empty } = vi.hoisted(() => ({ log: vi.fn(), events: vi.fn(async () => []), empty: [] }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { log, events } }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: empty }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
  buildTranscript: (lines: unknown[]) => lines,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ entries }: { entries: Array<{ chunk: string }> }) => <div>{entries.map(line => line.chunk).join(" ")}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unavailable = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });
const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: `2026-09-10T12:00:0${seq}Z`, stream: "stdout", chunk }) + "\n";
const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", logRef: "log" } as HeartbeatRun;

let container: HTMLDivElement;
let root: Root;
let store: ConnectivityStore;
let probe: ReturnType<typeof vi.fn<() => Promise<{ reachable: boolean; retryAfterMs: number | null }>>>;

beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  probe = vi.fn(async () => ({ reachable: true, retryAfterMs: null }));
  store = createConnectivityStore({ probe: probe as never, browserOnline: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  store.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  log.mockReset();
  events.mockClear();
});

async function render(Viewer: typeof LogViewer, value: HeartbeatRun = run) {
  await act(async () => root.render(<ConnectivityProvider store={store}><Viewer run={value} adapterType="codex_local" /></ConnectivityProvider>));
}
const outage = async () => {
  probe.mockResolvedValue({ reachable: false, retryAfterMs: null });
  await act(async () => { store.reportError(unavailable()); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(store.getSnapshot().status).toBe("reconnecting");
};
const recover = async () => {
  probe.mockResolvedValue({ reachable: true, retryAfterMs: null });
  await act(async () => { store.probeNow(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(store.getSnapshot().status).toBe("online");
};

it.each([LogViewer, ProductionLogViewer])("keeps loaded log lines when the next page fails transiently and recovers by itself (%#)", async (Viewer) => {
  const first = row(1, "retained history");
  log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
  await render(Viewer);
  expect(container.textContent).toContain("retained history");
  expect(container.textContent).toContain("Load more log");

  log.mockRejectedValue(unavailable());
  await outage();
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Load more log")!.click(); });
  // Paused, not failed: the lines stay, with no error copy and no raw code.
  expect(container.textContent).toContain("retained history");
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  expect(container.textContent).not.toContain("tenant_app_unavailable");

  const second = row(2, "new output");
  log.mockResolvedValue({ content: second });
  await recover();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(log).toHaveBeenLastCalledWith("run-1", first.length, expect.any(Number), expect.anything());
  expect(container.textContent).toContain("retained history new output");
  expect(container.textContent).not.toContain("Load more log");
});

it.each([LogViewer, ProductionLogViewer])("waits quietly when the first page fails during an outage, then fills in (%#)", async (Viewer) => {
  await outage();
  await render(Viewer);
  expect(log).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Loading run logs...");
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();

  const first = row(1, "first page");
  log.mockResolvedValue({ content: first });
  await recover();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(log).toHaveBeenCalledWith("run-1", 0, expect.any(Number), expect.anything());
  expect(container.textContent).toContain("first page");
  expect(container.textContent).not.toContain("Loading run logs...");
});

it.each([LogViewer, ProductionLogViewer])("shows readable copy for a real failure, leaving out Retry when it cannot help (%#)", async (Viewer) => {
  log.mockRejectedValueOnce(new ApiError("Forbidden", 403, { error: "Forbidden" }));
  await render(Viewer);
  const alert = container.querySelector('[data-query-view="error"]');
  expect(alert?.textContent).toContain("Couldn't load the run log");
  expect(alert?.textContent).toContain("Forbidden");
  expect(alert?.querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("No log events.");

  const first = row(1, "after retry");
  log.mockResolvedValue({ content: first });
  await render(Viewer, { ...run, id: "run-2" });
  expect(container.textContent).toContain("after retry");
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();
});

it.each([LogViewer, ProductionLogViewer])("retries a real failure on request without losing the offset (%#)", async (Viewer) => {
  const first = row(1, "page one");
  log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
  await render(Viewer);
  expect(container.textContent).toContain("page one");
  log.mockRejectedValueOnce(new ApiError("stale_revision", 409, { error: "stale_revision" }));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Load more log")!.click(); });
  const alert = container.querySelector('[data-query-view="error"]');
  expect(alert?.textContent).toContain("Couldn't load the run log");
  expect(alert?.textContent).not.toContain("stale_revision");
  expect(container.textContent).toContain("page one");
  const second = row(2, "page two");
  log.mockResolvedValueOnce({ content: second });
  await act(async () => { alert!.querySelector("button")!.click(); });
  expect(log).toHaveBeenLastCalledWith("run-1", first.length, expect.any(Number), expect.anything());
  expect(container.textContent).toContain("page one page two");
  expect(container.querySelector('[data-query-view="error"]')).toBeNull();
});

it.each([LogViewer, ProductionLogViewer])("drops a page that arrives after the run changed (%#)", async (Viewer) => {
  let completeFirst!: (value: { content: string; nextOffset?: number }) => void;
  log.mockImplementationOnce(() => new Promise(resolve => { completeFirst = resolve; }));
  await render(Viewer);
  expect(container.textContent).toContain("Loading run logs...");
  const second = row(1, "second run");
  log.mockResolvedValue({ content: second });
  await render(Viewer, { ...run, id: "run-2" });
  expect(container.textContent).toContain("second run");
  await act(async () => { completeFirst({ content: row(1, "first run"), nextOffset: 40 }); });
  expect(container.textContent).toContain("second run");
  expect(container.textContent).not.toContain("first run");
  expect(container.textContent).not.toContain("Load more log");
});
