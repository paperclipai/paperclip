// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, LiveEvent } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { api, ApiError } from "@/api/client";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { useTaskRunLiveUpdates } from "@/context/LiveUpdatesProvider";
import { createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";
import type { ResolvedPluginSlot } from "@/plugins/slots";
import { useTaskPluginPanels, type TaskPluginPanel } from "./useTaskPluginPanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plugin = vi.hoisted(() => ({ connected: true, slots: [] as ResolvedPluginSlot[], healthy: true, epoch: 0, handler: null as ((event: LiveEvent) => void) | null, errorMessage: null as string | null }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => plugin }));
vi.mock("@/context/LiveUpdatesProvider", () => ({ useTaskRunLiveUpdates: vi.fn(() => plugin.connected), useTranscriptLiveStream: (_ids: string[], _options: unknown, handler: (event: LiveEvent) => void) => { plugin.handler = handler; return { healthy: plugin.healthy, epoch: plugin.epoch }; } }));
const slot = { pluginId: "example-plugin", pluginKey: "example.live-view", id: "screen", pluginVersion: "1.0.0", taskSidePanel: { availabilityPath: "/agents/:entityId/view/availability", activation: { namespace: "example.runtime", activityKey: "desktop.used" } } } as ResolvedPluginSlot;
const issue = { id: "task", companyId: "company", executionRunId: "run", assigneeAgentId: "agent" } as Issue;
const run = { id: "run", agentId: "agent", status: "running" } as LiveRunForIssue;
let root: Root, container: HTMLDivElement, client: QueryClient;
let current: TaskPluginPanel[];
let task: Issue | null;
let enabled: boolean;
let get: MockInstance<typeof api.get>;
let list: MockInstance<typeof heartbeatsApi.liveRunsForIssue>;
let history: MockInstance<typeof heartbeatsApi.taskPanelActivations>;
function Harness() { current = useTaskPluginPanels(task, enabled); return null; }
async function render(next: Issue | null = issue, active = true) {
  task = next; enabled = active;
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30); else await new Promise(resolve => setTimeout(resolve, 30)); });
}
async function refresh() {
  await act(async () => { await client.refetchQueries(); });
  await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30); else await new Promise(resolve => setTimeout(resolve, 30)); });
}
beforeEach(() => {
  plugin.slots = [slot]; plugin.errorMessage = null; plugin.connected = true; plugin.healthy = false; plugin.epoch = 0; plugin.handler = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  get = vi.spyOn(api, "get").mockResolvedValue({ available: true });
  list = vi.spyOn(heartbeatsApi, "liveRunsForIssue").mockResolvedValue([run]);
  history = vi.spyOn(heartbeatsApi, "taskPanelActivations").mockImplementation(async () => plugin.slots.map(slot => ({ pluginKey: slot.pluginKey, slotId: slot.id })));
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});
it("uses the running agent's authorized status and existing plugin slot", async () => {
  await render();
  expect(list).toHaveBeenCalledWith("task");
  expect(get).toHaveBeenCalledWith("/plugins/example-plugin/api/agents/agent/view/availability?runId=run&issueId=task", { signal: expect.any(AbortSignal), cache: "no-store" });
  expect(current).toEqual([{ entityId: "agent", runId: "run", slot }]);
});
it("keeps unavailable panels hidden", async () => {
  get.mockResolvedValue({ available: false }); await render(); expect(current).toEqual([]);
});
it.each(["absent", "disabled", "draft", "no-task", "plugin-error"])("does no panel polling when %s", async kind => {
  if (kind === "absent") plugin.slots = [];
  if (kind === "plugin-error") plugin.errorMessage = "Unavailable";
  await render(kind === "no-task" ? null : kind === "draft" ? { ...issue, id: "chat:draft" } : issue, kind !== "disabled");
  expect(current).toEqual([]); expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
});
it.each(["queued", "succeeded", "another-run"])("ignores a %s run", async kind => {
  list.mockResolvedValue([{ ...run, status: kind === "another-run" ? "running" : kind, id: kind === "another-run" ? "other" : "run" }]);
  await render(); expect(current).toEqual([]); expect(get).not.toHaveBeenCalled();
});
it("discovers a panel started after the task is already open, then hides it on stop or access failure", async () => {
  get.mockResolvedValue({ available: false }); await render(); expect(current).toEqual([]);
  get.mockResolvedValue({ available: true }); await refresh(); expect(current[0]?.entityId).toBe("agent");
  get.mockRejectedValue(new Error("Access denied")); await refresh(); expect(current).toEqual([]);
});
it("removes the panel when the run ends even if its view is still ready", async () => {
  await render(); expect(current).not.toEqual([]);
  await act(async () => { client.setQueryData(queryKeys.issues.liveRuns("task"), []); });
  await render(); expect(current).toEqual([]);
});
it("does not carry an old task's ready panel to a new task or disabled plugin", async () => {
  await render(); expect(current).not.toEqual([]);
  list.mockResolvedValue([]); await render({ ...issue, id: "next-task" }); expect(current).toEqual([]);
  plugin.slots = []; await render(); expect(current).toEqual([]);
});

it("stops idle polling with live updates and resumes fallback polling on disconnect", async () => {
  vi.useFakeTimers(); list.mockResolvedValue([]);
  await render(); expect(list).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(list).toHaveBeenCalledTimes(1);
  plugin.connected = false; await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(list).toHaveBeenCalledTimes(3);
});
it("uses each plugin's own availability path and excludes only the failing contribution", async () => {
  const second = { ...slot, pluginId: "other-plugin", pluginKey: "example.other-view", taskSidePanel: { availabilityPath: "/views/:entityId/ready", activation: { namespace: "example.other-runtime", activityKey: "desktop.used" } } };
  plugin.slots = [slot, second];
  get.mockImplementation(async path => {
    if (path.includes("other-plugin")) throw new Error("Unavailable");
    return { available: true } as never;
  });
  await render();
  expect(current).toEqual([{ entityId: "agent", runId: "run", slot }]);
  expect(get).toHaveBeenCalledWith("/plugins/other-plugin/api/views/agent/ready?runId=run&issueId=task", expect.anything());
});


function event(overrides: Record<string, unknown> = {}): LiveEvent {
  return { id: 1, companyId: "company", type: "heartbeat.run.event", createdAt: "2099-01-01T00:00:00.000Z",
    payload: { runId: "run", agentId: "agent", issueId: "task", eventType: "runtime.activity.recorded",
      payload: { prpEvent: { eventType: "runtime.activity.recorded", sourceKind: "runner", payload: { ...slot.taskSidePanel!.activation } } }, ...overrides } } as LiveEvent;
}
async function emit(value: LiveEvent) {
  await act(async () => { plugin.handler?.(value); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
}
it("does no availability polling or Launcher discovery until this run activates the panel", async () => {
  vi.useFakeTimers(); history.mockResolvedValue([]);
  await render(); expect(get).not.toHaveBeenCalled(); expect(history).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).not.toHaveBeenCalled(); expect(history).toHaveBeenCalledTimes(1);
  for (const overrides of [{ runId: "other" }, { agentId: "other" }, { issueId: "other" }, { eventType: "item.completed" }]) await emit(event(overrides));
  await emit({ ...event(), companyId: "other" });
  await emit(event({ payload: { pluginKey: "example.other", slotId: "screen" } }));
  for (const native of [
    { eventType: "runtime.activity.recorded", sourceKind: "control_plane", payload: { ...slot.taskSidePanel!.activation } },
    { eventType: "runtime.activity.recorded", sourceKind: "runner", payload: { namespace: "example.other-runtime", activityKey: "desktop.used" } },
    { eventType: "runtime.activity.recorded", sourceKind: "runner", payload: { namespace: "example.runtime", activityKey: "other.used" } },
  ]) await emit(event({ payload: { prpEvent: native } }));
  expect(get).not.toHaveBeenCalled();
  await emit(event());
  expect(get).toHaveBeenCalledTimes(1); expect(current[0]?.runId).toBe("run");
  await emit(event());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(1);
});
it("restores an activation from durable run history after reload", async () => {
  await render(); expect(current).toHaveLength(1);
  expect(history).toHaveBeenCalledWith("run", { signal: expect.any(AbortSignal), cache: "no-store" });
});
it("reconciles activation history and availability after reconnect", async () => {
  vi.useFakeTimers(); history.mockResolvedValue([]); await render(); expect(current).toEqual([]);
  plugin.healthy = false; await render();
  history.mockResolvedValue([{ pluginKey: slot.pluginKey, slotId: slot.id }]);
  plugin.healthy = true; plugin.epoch++;
  await render(); expect(current).toHaveLength(1);
});
it("does not lose an activation to an older in-flight history read", async () => {
  vi.useFakeTimers(); let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  await render(); expect(get).not.toHaveBeenCalled();
  await emit(event()); expect(current).toHaveLength(1);
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(current).toHaveLength(1);
});
it("merges earlier panel history with a different panel activated during the read", async () => {
  vi.useFakeTimers();
  const second = { ...slot, id: "second-screen", taskSidePanel: { ...slot.taskSidePanel!, activation: { namespace: "example.runtime", activityKey: "other.used" } } };
  plugin.slots = [slot, second];
  let resolve!: (value: Array<{ pluginKey: string; slotId: string }>) => void;
  history.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render();
  expect(get).not.toHaveBeenCalled();
  await emit(event({ payload: { prpEvent: {
    eventType: "runtime.activity.recorded", sourceKind: "runner",
    payload: { ...second.taskSidePanel.activation },
  } } }));
  expect(current.map(panel => panel.slot.id)).toEqual([second.id]);
  await act(async () => {
    resolve([{ pluginKey: slot.pluginKey, slotId: slot.id }]);
    await vi.advanceTimersByTimeAsync(30);
  });
  expect(current.map(panel => panel.slot.id)).toEqual([slot.id, second.id]);
  expect(history).toHaveBeenCalledTimes(1);
});
it("fails closed when activation history cannot be read", async () => {
  history.mockRejectedValue(new Error("Access denied")); await render();
  expect(get).not.toHaveBeenCalled(); expect(current).toEqual([]);
});

it("bounds readiness retries to three attempts after an activation", async () => {
  vi.useFakeTimers(); get.mockResolvedValue({ available: false });
  await render(); expect(get).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(3); expect(current).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(3);
});

it.each(["not-ready", "server-error"])("restarts bounded readiness on fresh activity after %s", async failure => {
  vi.useFakeTimers();
  if (failure === "not-ready") get.mockResolvedValue({ available: false });
  else get.mockRejectedValue(new ApiError("Unavailable", 500, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(3);
  await emit(event());
  await emit(event());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(6);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(6);
  get.mockResolvedValue({ available: true });
  await emit(event());
  expect(get).toHaveBeenCalledTimes(7); expect(current).toHaveLength(1);
});
it("does not retry denied readiness on fresh activity", async () => {
  vi.useFakeTimers(); get.mockRejectedValue(new ApiError("Denied", 403, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(1);
  get.mockResolvedValue({ available: true });
  await emit(event());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(1); expect(current).toEqual([]);
});

it.each(["runs", "history"])("recovers from a transient %s read without recurring polling", async source => {
  vi.useFakeTimers();
  const error = new ApiError("Unavailable", 500, {});
  if (source === "runs") list.mockRejectedValueOnce(error);
  else history.mockRejectedValueOnce(error);
  await render();
  expect(current).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(current).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(source === "runs" ? list : history).toHaveBeenCalledTimes(2);
});
it.each([500, 403])("bounds failed discovery reads for HTTP %s", async status => {
  vi.useFakeTimers();
  list.mockRejectedValue(new ApiError("Unavailable", status, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(list).toHaveBeenCalledTimes(status === 500 ? 3 : 1);
  expect(history).not.toHaveBeenCalled();
  expect(current).toEqual([]);
});

it("does not discover a task view without a declared activity mapping", async () => {
  plugin.slots = [{ ...slot, taskSidePanel: { availabilityPath: slot.taskSidePanel!.availabilityPath } }];
  await render();
  expect(list).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled(); expect(current).toEqual([]);
});


it("observes run lifecycle updates using the same UUID key as panel discovery", async () => {
  await render({ ...issue, identifier: "DEMO-1" });
  expect(useTaskRunLiveUpdates).toHaveBeenLastCalledWith({ companyId: "company", issueId: "task", issueQueryRef: "task", assigneeAgentId: "agent" });
});

it.each(["initial", "reconnect"])("reads again after pending history settles across %s subscription", async phase => {
  vi.useFakeTimers();
  let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  if (phase === "initial") plugin.healthy = true;
  await render();
  if (phase === "reconnect") { plugin.healthy = true; plugin.epoch++; await render(); }
  expect(history).toHaveBeenCalledTimes(1);
  // The first snapshot predates activity that arrived before subscription.
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(history).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledTimes(1);
  expect(current).toHaveLength(1);
});

it("discards pending subscription recovery after the task changes", async () => {
  vi.useFakeTimers(); plugin.healthy = true;
  let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  await render();
  await render({ ...issue, id: "next-task" });
  const reads = history.mock.calls.length;
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(history).toHaveBeenCalledTimes(reads);
});

it.each(["not-ready", "server-error"])("reports unexpected failures only after bounded %s readiness checks", async failure => {
  vi.useFakeTimers();
  const reportError = vi.fn();
  client = createAppQueryClient({ connectivity: { reportError: vi.fn(), getSnapshot: () => ({ status: "online" } as never) }, reportError });
  if (failure === "not-ready") get.mockResolvedValue({ available: false });
  else get.mockRejectedValue(new ApiError("Unexpected failure", 500, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(3);
  expect(current).toEqual([]);
  expect(reportError).toHaveBeenCalledTimes(failure === "not-ready" ? 0 : 1);
});


it.each(["1.0.0", "2.0.0"])("requires current activity after a mapping change at version %s", async pluginVersion => {
  vi.useFakeTimers();
  await render(); expect(current).toHaveLength(1);
  const changed = { ...slot, pluginVersion, taskSidePanel: { ...slot.taskSidePanel!,
    activation: { namespace: "example.runtime", activityKey: "new-view.used" } } };
  history.mockResolvedValue([]); plugin.slots = [changed];
  await render(); expect(current).toEqual([]); expect(get).toHaveBeenCalledTimes(1);
  await emit(event()); expect(current).toEqual([]); expect(get).toHaveBeenCalledTimes(1);
  plugin.healthy = true; plugin.epoch++; await render();
  expect(current).toEqual([]);
  await emit(event({ payload: { prpEvent: { eventType: "runtime.activity.recorded", sourceKind: "runner",
    payload: changed.taskSidePanel.activation } } }));
  expect(current).toEqual([{ entityId: "agent", runId: "run", slot: changed }]);
  expect(get).toHaveBeenCalledTimes(2);
});

it("does not carry an old in-flight activation read into a changed declaration", async () => {
  vi.useFakeTimers();
  let resolve!: (value: Array<{ pluginKey: string; slotId: string }>) => void;
  history.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render(); await emit(event()); expect(current).toHaveLength(1);
  history.mockResolvedValue([]);
  plugin.slots = [{ ...slot, pluginVersion: "2.0.0", taskSidePanel: { ...slot.taskSidePanel!,
    activation: { namespace: "example.runtime", activityKey: "new-view.used" } } }];
  await render(); expect(current).toEqual([]);
  await act(async () => { resolve([{ pluginKey: slot.pluginKey, slotId: slot.id }]); await vi.advanceTimersByTimeAsync(30); });
  expect(current).toEqual([]); expect(get).toHaveBeenCalledTimes(1);
});


it("keeps an unchanged panel active while another declaration changes and history is pending", async () => {
  vi.useFakeTimers(); client.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
  const second = { ...slot, id: "other-screen", pluginKey: "example.other", pluginId: "other-plugin" };
  plugin.slots = [slot, second];
  await render(); expect(current).toHaveLength(2);
  let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  const changed = { ...second, pluginVersion: "2.0.0", taskSidePanel: { ...second.taskSidePanel!,
    activation: { namespace: "example.runtime", activityKey: "new-view.used" } } };
  plugin.slots = [slot, changed];
  await render();
  expect(history).toHaveBeenCalledTimes(2);
  expect(current).toEqual([{ entityId: "agent", runId: "run", slot }]);
  await emit(event({ payload: { prpEvent: { eventType: "runtime.activity.recorded", sourceKind: "runner",
    payload: changed.taskSidePanel.activation } } }));
  expect(current.map(panel => panel.slot)).toEqual([slot, changed]);
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(current.map(panel => panel.slot)).toEqual([slot, changed]);
});

it("does not seed another task's activation from cached declarations", async () => {
  await render(); expect(current).toHaveLength(1);
  history.mockResolvedValue([]);
  await render({ ...issue, id: "other-task" });
  expect(current).toEqual([]); expect(get).toHaveBeenCalledTimes(1);
});


it("does not seed activations from a history read that lost access", async () => {
  vi.useFakeTimers();
  await render(); expect(current).toHaveLength(1);
  history.mockRejectedValue(new ApiError("Denied", 403, {}));
  await refresh(); expect(current).toEqual([]);
  let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  plugin.slots = [slot, { ...slot, id: "other-screen", pluginKey: "example.other" }];
  await render(); expect(current).toEqual([]);
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(current).toEqual([]);
});


it("preserves activity when returning to an earlier cached declaration set", async () => {
  vi.useFakeTimers();
  const second = { ...slot, id: "other-screen", pluginKey: "example.other" };
  plugin.slots = [slot, second]; history.mockResolvedValue([]);
  await render(); expect(current).toEqual([]);
  plugin.slots = [slot, { ...second, pluginVersion: "2.0.0" }];
  await render(); await emit(event()); expect(current.map(panel => panel.slot.id)).toEqual([slot.id, second.id]);
  let resolve!: (value: []) => void;
  history.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; }));
  plugin.slots = [slot, second]; await render();
  expect(current.map(panel => panel.slot.id)).toEqual([slot.id]);
  await act(async () => { resolve([]); await vi.advanceTimersByTimeAsync(30); });
  expect(current.map(panel => panel.slot.id)).toEqual([slot.id]);
  await act(async () => client.removeQueries({ predicate: query => String(query.queryKey[5]).includes("2.0.0") }));
  await render(); expect(current.map(panel => panel.slot.id)).toEqual([slot.id]);
});


it.each(["route", "installation"])("rechecks readiness after a same-version %s change", async change => {
  vi.useFakeTimers(); await render(); expect(current).toHaveLength(1);
  get.mockResolvedValue({ available: false });
  const changed = change === "route"
    ? { ...slot, taskSidePanel: { ...slot.taskSidePanel!, availabilityPath: "/views/:entityId/ready" } }
    : { ...slot, pluginId: "replacement-plugin" };
  plugin.slots = [changed]; await render();
  expect(current).toEqual([]);
  expect(get).toHaveBeenLastCalledWith(`/plugins/${changed.pluginId}/api${changed.taskSidePanel!.availabilityPath.replace(":entityId", "agent")}?runId=run&issueId=task`, expect.anything());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(get).toHaveBeenCalledTimes(4); expect(current).toEqual([]);
  get.mockResolvedValue({ available: true }); await emit(event());
  expect(get).toHaveBeenCalledTimes(5); expect(current).toHaveLength(1);
});
