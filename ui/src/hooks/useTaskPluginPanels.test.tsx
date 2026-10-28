// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { api } from "@/api/client";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import type { ResolvedPluginSlot } from "@/plugins/slots";
import { useTaskPluginPanels, type TaskPluginPanel } from "./useTaskPluginPanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plugin = vi.hoisted(() => ({ connected: true, slots: [] as ResolvedPluginSlot[], errorMessage: null as string | null }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => plugin }));
vi.mock("@/context/LiveUpdatesProvider", () => ({ useHasCompanyLiveConnection: () => plugin.connected }));
const slot = { pluginId: "example-plugin", pluginKey: "example.live-view", id: "screen", pluginVersion: "1.0.0", taskSidePanel: { availabilityPath: "/agents/:entityId/view/availability" } } as ResolvedPluginSlot;
const issue = { id: "task", companyId: "company", executionRunId: "run" } as Issue;
const run = { id: "run", agentId: "agent", status: "running" } as LiveRunForIssue;
let root: Root, container: HTMLDivElement, client: QueryClient;
let current: TaskPluginPanel[];
let task: Issue | null;
let enabled: boolean;
let get: MockInstance<typeof api.get>;
let list: MockInstance<typeof heartbeatsApi.liveRunsForIssue>;
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
  plugin.slots = [slot]; plugin.errorMessage = null; plugin.connected = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  get = vi.spyOn(api, "get").mockResolvedValue({ available: true });
  list = vi.spyOn(heartbeatsApi, "liveRunsForIssue").mockResolvedValue([run]);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});
it("uses the running agent's authorized status and existing plugin slot", async () => {
  await render();
  expect(list).toHaveBeenCalledWith("task");
  expect(get).toHaveBeenCalledWith("/plugins/example-plugin/api/agents/agent/view/availability", { signal: expect.any(AbortSignal), cache: "no-store" });
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
  const second = { ...slot, pluginId: "other-plugin", pluginKey: "example.other-view", taskSidePanel: { availabilityPath: "/views/:entityId/ready" } };
  plugin.slots = [slot, second];
  get.mockImplementation(async path => {
    if (path.includes("other-plugin")) throw new Error("Unavailable");
    return { available: true } as never;
  });
  await render();
  expect(current).toEqual([{ entityId: "agent", runId: "run", slot }]);
  expect(get).toHaveBeenCalledWith("/plugins/other-plugin/api/views/agent/ready", expect.anything());
});
