// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LAYOUT_SAVE_DEBOUNCE_MS } from "@/hooks/useUiLayout";
import { buildClipboard, serializeClipboard } from "./lib/clipboard";
import { syntheticOrg } from "./lib/synthetic-org";

const AGENT_COUNT = 250;
const RENDER_LIMIT = AGENT_COUNT * 8;

const renders = vi.hoisted(() => ({ total: 0, byAgent: new Map<string, number>(), limit: Number.POSITIVE_INFINITY }));
const agentsApi = vi.hoisted(() => ({ update: vi.fn(), hire: vi.fn(), create: vi.fn() }));
const heartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn(), list: vi.fn() }));
const uiLayoutsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());

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
vi.mock("@/api/agents", () => ({ agentsApi }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi }));
vi.mock("@/api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("../../api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
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
  for (const fn of [...Object.values(agentsApi), ...Object.values(heartbeatsApi), ...Object.values(uiLayoutsApi), pushToast]) {
    fn.mockReset();
  }
  heartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  heartbeatsApi.list.mockResolvedValue([]);
  uiLayoutsApi.get.mockResolvedValue({ surface: "agent_graph", schemaVersion: null, layout: null, updatedAt: null });
  uiLayoutsApi.save.mockImplementation(async (_companyId: string, surface: string, layout: unknown) => ({
    surface, schemaVersion: 1, layout, updatedAt: null,
  }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

function pasteInto(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  host.querySelector('[data-testid="agent-graph"]')!.dispatchEvent(event);
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

  it("pastes agents as hire drafts and only hires through the governed endpoint after confirmation", async () => {
    const agents = roster();
    await mount(agents);
    const source = agents[3]!;
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: source, position: { x: 0, y: 0 } }], stickies: [] }));
    expect(text).not.toContain("SECRET-VALUE");

    await act(async () => pasteInto(text));
    const drafts = host.querySelectorAll('[data-testid="agent-graph-draft"]');
    expect(drafts).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(AGENT_COUNT);
    expect(agentsApi.hire).not.toHaveBeenCalled();
    expect(agentsApi.create).not.toHaveBeenCalled();

    agentsApi.hire.mockResolvedValue({ agent: { name: "Agent 3 (copy)" }, approval: { id: "approval-1" } });
    const requestButton = [...drafts[0]!.querySelectorAll("button")].find((button) => button.textContent?.includes("Request hire"))!;
    await act(async () => requestButton.click());
    expect(agentsApi.hire).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Request hire") as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentsApi.hire).toHaveBeenCalledTimes(1);
    expect(agentsApi.hire).toHaveBeenCalledWith("company-1", {
      name: "Agent 3 (copy)",
      role: "engineer",
      title: null,
      capabilities: "Ships code",
      adapterType: "claude_local",
      adapterConfig: { model: "example-model" },
      reportsTo: source.reportsTo,
    });
    expect(host.querySelectorAll('[data-testid="agent-graph-draft"]')).toHaveLength(0);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Hire request sent for board approval" }));

    const graph = host.querySelector('[data-testid="agent-graph"]')!;
    for (const shiftKey of [false, true, true, false]) {
      await act(async () => {
        graph.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey, bubbles: true }));
      });
      expect(host.querySelectorAll('[data-testid="agent-graph-draft"]')).toHaveLength(0);
    }
  });

  it("ignores clipboard text that is not agent graph data", async () => {
    await mount(roster());
    await act(async () => pasteInto("just some text"));
    await act(async () => pasteInto(JSON.stringify({ kind: "paperclip.agent-graph", version: 1, agents: [{ adapterConfig: {} }], stickies: [] })));
    expect(host.querySelectorAll('[data-testid="agent-graph-draft"]')).toHaveLength(0);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing pasted" }));
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
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: agents[3]!, position: { x: 0, y: 0 } }], stickies: [] }));
    uiLayoutsApi.get.mockRejectedValueOnce(new Error("network down"));
    await mount(agents);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(12);
    expect(host.textContent).toContain("Your saved graph layout could not be loaded. Changes are not saved.");

    await act(async () => pasteInto(text));
    expect(host.querySelectorAll('[data-testid="agent-graph-draft"]')).toHaveLength(1);
    await waitForSave();
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();

    const sticky = { id: "saved-note", x: 0, y: 0, width: 200, height: 120, text: "kept", color: "yellow" };
    uiLayoutsApi.get.mockResolvedValue({
      surface: "agent_graph", schemaVersion: 1, updatedAt: null,
      layout: { schemaVersion: 1, direction: "TB", viewport: null, positions: {}, hiddenAgentIds: [], stickies: [sticky], drafts: [] },
    });
    const retry = [...host.querySelectorAll("button")].find((element) => element.textContent === "Retry")!;
    await act(async () => retry.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain("could not be loaded");
    expect(host.querySelectorAll('[data-testid="agent-graph-sticky"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="agent-graph-draft"]')).toHaveLength(0);

    await act(async () => pasteInto(text));
    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(uiLayoutsApi.save.mock.calls[0]![2]).toMatchObject({ stickies: [sticky], drafts: [{ name: "Agent 3 (copy)" }] });
  }, 30_000);

  async function pasteAndOpenHireDialog(source: Agent) {
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: source, position: { x: 0, y: 0 } }], stickies: [] }));
    await act(async () => pasteInto(text));
    const draft = host.querySelector('[data-testid="agent-graph-draft"]')!;
    const request = [...draft.querySelectorAll("button")].find((element) => element.textContent?.includes("Request hire"))!;
    await act(async () => request.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    const shown = [...dialog.querySelectorAll("dd")].at(-1)!.textContent;
    agentsApi.hire.mockResolvedValue({ agent: { name: "copy" }, approval: null });
    const confirm = [...dialog.querySelectorAll("button")].find((element) => element.textContent === "Request hire") as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { shown, sent: agentsApi.hire.mock.calls[0]![1].reportsTo as string | null, draftText: draft.textContent ?? "" };
  }

  it("shows the manager that the hire request sends when a filter hides that manager", async () => {
    const agents = roster().slice(0, 12);
    const manager = agents[1]!;
    const report = agents.find((agent) => agent.reportsTo === manager.id)!;
    const visibleKey = agents.filter((agent) => agent.id !== manager.id).map((agent) => agent.id).join(",");
    await mount(agents, visibleKey);
    expect(host.querySelectorAll('[data-testid="agent-graph-node"]')).toHaveLength(11);

    const result = await pasteAndOpenHireDialog(report);
    expect(result.draftText).toContain(`reports to ${manager.name}`);
    expect(result.shown).toBe(manager.name);
    expect(result.sent).toBe(manager.id);
  });

  it("clears the manager and warns when the copied agent reports to a terminated agent", async () => {
    const agents = roster().slice(0, 12);
    const managerId = agents[1]!.id;
    const withTerminated = agents.map((agent) => (agent.id === managerId ? { ...agent, status: "terminated" } : agent)) as Agent[];
    const report = withTerminated.find((agent) => agent.reportsTo === managerId)!;
    await mount(withTerminated);

    const result = await pasteAndOpenHireDialog(report);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Reporting line not copied" }));
    expect(result.shown).toBe("No manager");
    expect(result.sent).toBeNull();
  });

  it("does not send a manager that was terminated after the draft was saved", async () => {
    const agents = roster().slice(0, 12);
    const managerId = agents[1]!.id;
    const withTerminated = agents.map((agent) => (agent.id === managerId ? { ...agent, status: "terminated" } : agent)) as Agent[];
    uiLayoutsApi.get.mockResolvedValue({
      surface: "agent_graph", schemaVersion: 1, updatedAt: null,
      layout: {
        schemaVersion: 1, direction: "TB", viewport: null, positions: {}, hiddenAgentIds: [], stickies: [],
        drafts: [{
          id: "d1", x: 0, y: 0, name: "Saved draft", role: "engineer", title: null, capabilities: null,
          adapterType: "claude_local", model: null, reportsTo: managerId, sourceAgentId: null,
        }],
      },
    });
    await mount(withTerminated);
    const draft = host.querySelector('[data-testid="agent-graph-draft"]')!;
    await act(async () => [...draft.querySelectorAll("button")].find((element) => element.textContent?.includes("Request hire"))!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect([...dialog.querySelectorAll("dd")].at(-1)!.textContent).toBe("No manager");
    agentsApi.hire.mockResolvedValue({ agent: { name: "Saved draft" }, approval: null });
    await act(async () => ([...dialog.querySelectorAll("button")].find((element) => element.textContent === "Request hire") as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentsApi.hire.mock.calls[0]![1].reportsTo).toBeNull();
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
