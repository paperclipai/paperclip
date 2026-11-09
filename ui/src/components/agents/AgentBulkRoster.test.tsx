// @vitest-environment jsdom

import { act } from "react";
import { queryKeys } from "@/lib/queryKeys";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBulkRoster } from "./AgentBulkRoster";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("./AgentBulkSettingsSheet", () => ({ AgentBulkSettingsSheet: ({ agents }: { agents: Agent[] }) => <div data-testid="bulk-editor">{JSON.stringify(agents.map(a => a.runtimeConfig))}</div> }));

vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: {
  list: vi.fn(async () => ({ currentUserId: "board", connections: [] })),
} }));

describe("pending agent roster display", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "alice" } });
    api.get.mockReset();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  function render(metadata: Record<string, unknown>) {
    const agent = { id: "draft", name: "Atlas", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      pauseReason: "setup", status: "paused", metadata } as unknown as Agent;
    flushSync(() => root.render(<QueryClientProvider client={client}>
      <AgentBulkRoster companyId="company" agents={[agent]} visibleAgents={[agent]} renderAgent={item => <span>{item.name}</span>} />
    </QueryClientProvider>));
    return [...container.querySelectorAll("tbody tr")][0] as HTMLTableRowElement;
  }

  function renderEditable() {
    const agent = { id: "agent-one", companyId: "company", name: "Atlas", adapterType: "codex_local", adapterConfig: { model: "old-model" }, runtimeConfig: {}, status: "idle" } as unknown as Agent;
    flushSync(() => root.render(<QueryClientProvider client={client}>
      <AgentBulkRoster companyId="company" agents={[agent]} visibleAgents={[agent]} renderAgent={item => <span>{item.name}</span>} />
    </QueryClientProvider>));
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Select Atlas"]')!.click());
    return agent;
  }

  const editButton = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Bulk actions"] button')].find(b => b.textContent?.includes("Edit connection & model"))!;

  it("loads complete current agents before opening bulk edits from a restored roster", async () => {
    const display = renderEditable();
    let finish!: (value: Agent) => void;
    api.get.mockImplementation(() => new Promise<Agent>(resolve => { finish = resolve; }));
    await act(async () => editButton().click());
    expect(api.get).toHaveBeenCalledWith("agent-one", "company", { cache: "no-store", fresh: true });
    expect(container.querySelector('[data-testid="bulk-editor"]')).toBeNull();
    expect(container.textContent).toContain("Loading current agent settings");
    const runtimeConfig: Agent["runtimeConfig"] = { aiConnection: { provider: "openai", method: "api_key", mode: "shared", connectionId: "connection-one", grantId: "grant-one" } };
    await act(async () => { finish({ ...display, runtimeConfig }); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="bulk-editor"]')?.textContent).toContain("connection-one"));
    expect(container.textContent).not.toContain("Loading current agent settings");
  });

  it("keeps the editor closed after a failed complete-agent read and supports retry", async () => {
    const display = renderEditable();
    api.get.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(display);
    await act(async () => editButton().click());
    expect(container.querySelector('[data-testid="bulk-editor"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    await act(async () => editButton().click());
    await vi.waitFor(() => expect(container.querySelector('[data-testid="bulk-editor"]')).not.toBeNull());
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("rejects a complete-agent response delivered after the account switches", async () => {
    const display = renderEditable();
    let finish!: (value: Agent) => void;
    api.get.mockImplementation(() => new Promise<Agent>(resolve => { finish = resolve; }));
    await act(async () => editButton().click());
    await act(async () => {
      client.setQueryData(queryKeys.auth.session, { user: { id: "bob" } });
      finish(display);
    });
    expect(container.querySelector('[data-testid="bulk-editor"]')).toBeNull();
  });

  describe.each(["success", "failure"] as const)("selection changes during a %s read", outcome => {
    it.each(["Clear selection", "Select Atlas", "Select all visible editable agents"])("discards a pending edit after %s", async label => {
      const display = renderEditable();
      let finish!: (value: Agent) => void, reject!: (error: Error) => void;
      api.get.mockReturnValue(new Promise<Agent>((resolve, fail) => { finish = resolve; reject = fail; }));
      await act(async () => editButton().click());
      expect(api.get).toHaveBeenCalledTimes(1);
      await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
      await act(async () => {
        if (outcome === "success") finish(display);
        else reject(new TypeError("Failed to fetch"));
      });
      expect(container.querySelector('[data-testid="bulk-editor"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).not.toContain("Loading current agent settings");
    });
  });

  it("retires a pending edit even when the same agent is selected again before the read finishes", async () => {
    const display = renderEditable();
    let finish!: (value: Agent) => void;
    api.get.mockReturnValueOnce(new Promise<Agent>(resolve => { finish = resolve; })).mockResolvedValue(display);
    await act(async () => editButton().click());
    const checkbox = container.querySelector<HTMLButtonElement>('[aria-label="Select Atlas"]')!;
    await act(async () => checkbox.click());
    await act(async () => checkbox.click());
    await act(async () => finish(display));
    expect(container.querySelector('[data-testid="bulk-editor"]')).toBeNull();
    await act(async () => editButton().click());
    await vi.waitFor(() => expect(container.querySelector('[data-testid="bulk-editor"]')).not.toBeNull());
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("retains the pending harness label while keeping the placeholder unavailable for bulk editing", () => {
    const row = render({ setupAdapterPending: true,
      setupAdapterChoice: { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" } });
    expect([...row.querySelectorAll("td")].slice(3).map(cell => cell.textContent)).toEqual([
      "Google Antigravity", "Not configured", "Not available yet",
    ]);
    const checkbox = row.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
    expect(container.textContent).not.toContain("Edit connection & model");
  });

  it("preserves ordinary process display without a saved setup choice", () => {
    const row = render({ setupAdapterPending: true });
    expect([...row.querySelectorAll("td")].slice(3).map(cell => cell.textContent)).toEqual([
      "Process", "Managed externally", "Harness default",
    ]);
    const checkbox = row.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
  });
});
