// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import type { ResolvedPluginSlot } from "./slots";
import { useAgentEnvironmentSlots } from "./useAgentEnvironmentSlots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const view = { pluginKey: "example.computer", id: "view", agentEnvironmentDriver: "tasks" } as ResolvedPluginSlot;
const ordinary = { pluginKey: "example.insights", id: "stats" } as ResolvedPluginSlot;
const environment = { id: "computer", driver: "plugin", config: {}, pluginDriver: { pluginKey: "example.computer", driverKey: "tasks" } };
let client: QueryClient, root: Root, container: HTMLDivElement;
let result: ReturnType<typeof useAgentEnvironmentSlots>;
let agentId: string | null;
let slots: ResolvedPluginSlot[];
function Harness() { result = useAgentEnvironmentSlots(slots, agentId, "company"); return null; }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); root = createRoot(container);
  agentId = "agent"; slots = [view, ordinary];
  client.setQueryData([...queryKeys.agents.detail("agent"), "company"], { id: "agent", companyId: "company", defaultEnvironmentId: "computer" });
  client.setQueryData(queryKeys.environments.list("company"), [environment]);
  vi.spyOn(agentsApi, "get").mockRejectedValue(new Error("Agent unavailable"));
  vi.spyOn(environmentsApi, "list").mockRejectedValue(new Error("Environments unavailable"));
  vi.spyOn(instanceSettingsApi, "get").mockRejectedValue(new Error("Instance unavailable"));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); vi.restoreAllMocks(); });
it("shows matching environment views and ordinary views without checking desktop readiness", async () => {
  await render(); expect(result.slots).toEqual([view, ordinary]); expect(result.isLoading).toBe(false);
  expect(instanceSettingsApi.get).not.toHaveBeenCalled();
});
it.each(["local", "other-plugin", "other-driver", "missing"])("hides a view for a %s environment", async kind => {
  client.setQueryData(queryKeys.environments.list("company"), kind === "missing" ? [] : [{ ...environment,
    driver: kind === "local" ? "local" : "plugin", pluginDriver: { ...environment.pluginDriver,
      ...(kind === "other-plugin" ? { pluginKey: "example.other" } : {}),
      ...(kind === "other-driver" ? { driverKey: "other" } : {}),
    },
  }]);
  await render(); expect(result.slots).toEqual([ordinary]);
});
it("uses the inherited instance environment", async () => {
  client.setQueryData([...queryKeys.agents.detail("agent"), "company"], { id: "agent", companyId: "company", defaultEnvironmentId: null });
  client.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: "computer" });
  await render(); expect(result.slots).toEqual([view, ordinary]);
});
it.each(["agent", "environments", "instance"])("hides restricted views when %s cannot load", async kind => {
  if (kind === "agent") client.removeQueries({ queryKey: queryKeys.agents.detail("agent") });
  if (kind === "environments") client.removeQueries({ queryKey: queryKeys.environments.list("company") });
  if (kind === "instance") client.setQueryData([...queryKeys.agents.detail("agent"), "company"], { id: "agent", companyId: "company", defaultEnvironmentId: null });
  await render(); expect(result.slots).toEqual([ordinary]); expect(result.isLoading).toBe(false);
});
it("removes the view immediately when the target agent or its environment changes", async () => {
  await render(); expect(result.slots).toContain(view);
  agentId = "other";
  await render(); expect(result.slots).toEqual([ordinary]);
  agentId = "agent";
  client.setQueryData([...queryKeys.agents.detail("agent"), "company"], { id: "agent", companyId: "company", defaultEnvironmentId: "local" });
  await render(); expect(result.slots).toEqual([ordinary]);
});
it("does no environment discovery for ordinary contributions or an absent agent", async () => {
  slots = [ordinary]; agentId = null;
  await render(); expect(result.slots).toEqual([ordinary]);
  expect(agentsApi.get).not.toHaveBeenCalled(); expect(environmentsApi.list).not.toHaveBeenCalled(); expect(instanceSettingsApi.get).not.toHaveBeenCalled();
});

it.each([503, 403])("uses cached eligibility after a transient error and clears it after denial (%s)", async status => {
  await render(); expect(result.slots).toContain(view);
  vi.mocked(environmentsApi.list).mockRejectedValue(new ApiError("Unavailable", status, null));
  await act(async () => { await client.refetchQueries({ queryKey: queryKeys.environments.list("company") }); });
  await render();
  expect(result.slots).toEqual(status === 503 ? [view, ordinary] : [ordinary]);
});
