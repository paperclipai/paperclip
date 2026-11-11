// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LAYOUT_SAVE_DEBOUNCE_MS } from "@/hooks/useUiLayout";
import { queryKeys } from "@/lib/queryKeys";
import { syntheticOrg } from "./lib/synthetic-org";

const AGENT_COUNT = 250;
const RENDER_LIMIT = AGENT_COUNT * 8;

const renders = vi.hoisted(() => ({ total: 0, byAgent: new Map<string, number>(), limit: Number.POSITIVE_INFINITY }));
const heartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn(), list: vi.fn() }));
const uiLayoutsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }));

const flowOverrides = vi.hoisted(() => ({ nodesInitialized: false }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useNodesInitialized: () => {
      const measured = actual.useNodesInitialized();
      return flowOverrides.nodesInitialized || measured;
    },
  };
});
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi }));
vi.mock("@/api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("../../api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/AgentAvatar", () => ({
  AgentAvatar: ({ agent }: { agent: { id: string } }) => {
    renders.total += 1;
    renders.byAgent.set(agent.id, (renders.byAgent.get(agent.id) ?? 0) + 1);
    if (renders.total > renders.limit) throw new Error(`Agent node render limit exceeded: ${renders.total}`);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });

function roster(): Agent[] {
  return syntheticOrg(AGENT_COUNT).map((member, index) => ({
    ...member,
    companyId: "company-1",
    name: `Agent ${index}`,
    urlKey: `agent-${index}`,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    capabilities: "Ships code",
    adapterType: "claude_local",
    adapterConfig: { model: "example-model", env: { API_KEY: "SECRET-VALUE" } },
    runtimeConfig: {},
    budgetMonthlyCents: 10_000,
    spentMonthlyCents: index,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })) as unknown as Agent[];
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let AgentGraph: typeof import("./AgentGraph").AgentGraph;

beforeAll(async () => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixStub {
    m22 = 1;
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 1_200 },
    offsetHeight: { configurable: true, get: () => 800 },
  });
  ({ AgentGraph } = await import("./AgentGraph"));
}, 120_000);

beforeEach(() => {
  flowOverrides.nodesInitialized = false;
  renders.total = 0;
  renders.byAgent.clear();
  renders.limit = RENDER_LIMIT;
  for (const fn of [...Object.values(heartbeatsApi), ...Object.values(uiLayoutsApi)]) {
    fn.mockReset();
  }
  heartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  heartbeatsApi.list.mockResolvedValue([]);
  uiLayoutsApi.get.mockResolvedValue({ surface: "agent_graph", schemaVersion: null, layout: null, updatedAt: null });
  uiLayoutsApi.save.mockImplementation(async (_companyId: string, surface: string, layout: unknown) => ({
    surface, schemaVersion: 1, layout, updatedAt: null,
  }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

async function mount(agents: Agent[], visibleAgentIdsKey?: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentGraph companyId="company-1" agents={agents} visibleAgentIdsKey={visibleAgentIdsKey} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function rerender(agents: Agent[]) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentGraph companyId="company-1" agents={agents} />
      </QueryClientProvider>,
    );
  });
}

describe("AgentGraph with 250 agents", () => {
  it("renders every agent once the default layout is applied", async () => {
    await mount(roster());
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(AGENT_COUNT);
    expect(renders.total).toBeLessThanOrEqual(RENDER_LIMIT);
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
  }, 30_000);

  it("re-renders only the agent whose live status changed", async () => {
    const agents = roster();
    await mount(agents);
    const before = new Map(renders.byAgent);
    const beforeTotal = renders.total;
    renders.limit = beforeTotal + 8;

    const target = agents[123]!;
    await rerender(agents.map((agent, index) => (index === 123 ? { ...agent, status: "running" } : { ...agent })) as Agent[]);

    const rerendered = [...renders.byAgent.entries()].filter(([id, count]) => count !== before.get(id)).map(([id]) => id);
    expect(rerendered).toEqual([target.id]);
    expect(renders.total - beforeTotal).toBeLessThanOrEqual(2);
    const live = host.querySelectorAll(".agent-graph-node-live");
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute("data-status")).toBe("running");
  });

  it("does not re-render any agent node when an unchanged roster is refetched", async () => {
    const agents = roster();
    await mount(agents);
    const beforeTotal = renders.total;
    renders.limit = beforeTotal;
    await rerender(agents.map((agent) => ({ ...agent })) as Agent[]);
    expect(renders.total).toBe(beforeTotal);
  });

  it("does not overwrite the saved layout when it failed to load, and saves again after a successful retry", async () => {
    const agents = roster().slice(0, 12);
    const waitForSave = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, UI_LAYOUT_SAVE_DEBOUNCE_MS + 100));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const switchDirection = async () => {
      const toggle = [...host.querySelectorAll("button")].find((element) => element.getAttribute("aria-label")?.startsWith("Switch to"))!;
      await act(async () => toggle.click());
    };
    uiLayoutsApi.get.mockRejectedValueOnce(new Error("network down"));
    await mount(agents);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(12);
    expect(host.textContent).toContain("Your saved graph layout could not be loaded. Changes are not saved.");

    await switchDirection();
    expect(host.textContent).toContain("Left-right");
    await waitForSave();
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();

    const hiddenAgentIds = [agents[5]!.id];
    uiLayoutsApi.get.mockResolvedValue({
      surface: "agent_graph", schemaVersion: 1, updatedAt: null,
      layout: { schemaVersion: 1, direction: "TB", viewport: null, positions: {}, hiddenAgentIds, stickies: [], drafts: [] },
    });
    const retry = [...host.querySelectorAll("button")].find((element) => element.textContent === "Retry")!;
    await act(async () => retry.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain("could not be loaded");
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(11);
    expect(host.textContent).toContain("Top-down");

    await switchDirection();
    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(uiLayoutsApi.save.mock.calls[0]![2]).toMatchObject({ direction: "LR", hiddenAgentIds });
  }, 30_000);

  it("shows the layout of the new account after the session changes", async () => {
    const agents = roster().slice(0, 12);
    const stored = (hiddenAgentIds: string[]) => ({
      surface: "agent_graph", schemaVersion: 1, updatedAt: null,
      layout: { schemaVersion: 1, direction: "TB", viewport: null, positions: {}, hiddenAgentIds, stickies: [], drafts: [] },
    });
    let deliver!: (value: unknown) => void;
    uiLayoutsApi.get
      .mockResolvedValueOnce(stored([agents[5]!.id, agents[6]!.id]))
      .mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    await mount(agents);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(10);

    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(uiLayoutsApi.get).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(0);
    await act(async () => deliver(stored([])));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(12);
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
  });

  it("applies the saved viewport when a retry recovers the saved layout", async () => {
    const agents = roster().slice(0, 12);
    const viewportTransform = () => host.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    flowOverrides.nodesInitialized = true;
    uiLayoutsApi.get.mockRejectedValueOnce(new Error("network down"));
    await mount(agents);
    expect(host.textContent).toContain("Your saved graph layout could not be loaded. Changes are not saved.");
    expect(viewportTransform()).not.toBe("translate(120px,-48px) scale(0.5)");

    uiLayoutsApi.get.mockResolvedValue({
      surface: "agent_graph", schemaVersion: 1, updatedAt: null,
      layout: {
        schemaVersion: 1, direction: "TB", viewport: { x: 120, y: -48, zoom: 0.5 },
        positions: {}, hiddenAgentIds: [], stickies: [], drafts: [],
      },
    });
    const retry = [...host.querySelectorAll("button")].find((element) => element.textContent === "Retry")!;
    await act(async () => retry.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain("could not be loaded");
    expect(viewportTransform()).toBe("translate(120px,-48px) scale(0.5)");
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
  });

  it("shows a failed save and saves the same layout again from the notice", async () => {
    const agents = roster().slice(0, 12);
    uiLayoutsApi.save.mockRejectedValueOnce(new Error("Layout is not valid"));
    await mount(agents);
    const toggle = [...host.querySelectorAll("button")].find((element) => element.getAttribute("aria-label")?.startsWith("Switch to"))!;
    await act(async () => toggle.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, UI_LAYOUT_SAVE_DEBOUNCE_MS + 100));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Your latest graph layout changes are not saved yet.");
    expect(host.textContent).toContain("Layout not saved");

    const retrySaving = [...host.querySelectorAll("button")].find((element) => element.textContent === "Retry saving")!;
    await act(async () => retrySaving.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]![2]).toEqual(uiLayoutsApi.save.mock.calls[0]![2]);
    expect(host.textContent).not.toContain("are not saved yet");
    expect(host.textContent).toContain("Layout saved");
  }, 30_000);
});
