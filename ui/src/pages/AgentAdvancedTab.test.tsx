// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette, agentConfigurationSpec, type Agent } from "@paperclipai/shared";
import { ConfigurationSaveInterrupted } from "../lib/agent-configuration/save";
import { AgentAdvancedTab } from "./AgentAdvancedTab";

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("../lib/agent-configuration/load", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/agent-configuration/load")>(), loadAgentConfiguration: api.load,
}));
vi.mock("../lib/agent-configuration/save", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/agent-configuration/save")>(), saveAgentConfiguration: api.save,
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

const agent = {
  id: "11111111-1111-4111-8111-111111111111", companyId: "company", urlKey: "codie", name: "Codie",
  role: "engineer", title: null, icon: null, appearance: appearanceForPalette("bubblegum-sky"), reportsTo: null,
  capabilities: null, adapterType: "process", adapterConfig: { command: "echo" }, runtimeConfig: {},
  defaultEnvironmentId: null, budgetMonthlyCents: 0, metadata: null, configurationRevision: "a".repeat(64),
  status: "idle", spentMonthlyCents: 0, pauseReason: null, pausedAt: null,
  permissions: { canCreateAgents: false }, lastHeartbeatAt: null, createdAt: new Date(), updatedAt: new Date(),
} satisfies Agent & { configurationRevision: string };

function snapshot(value = agent) {
  return { agent: value, core: value, document: { apiVersion: "paperclip/v1", kind: "Agent", spec: agentConfigurationSpec(value) } };
}

describe("Advanced agent configuration", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  const dirty = vi.fn(), onSaved = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    api.load.mockResolvedValue(snapshot());
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
  async function settle(assertion: () => void) {
    for (let i = 0; i < 30; i++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      try { assertion(); return; } catch (error) { if (i === 29) throw error; }
    }
  }
  async function render() {
    await act(() => root.render(<QueryClientProvider client={client}>
      <AgentAdvancedTab agent={agent} onDirtyChange={dirty} onSaved={onSaved} />
    </QueryClientProvider>));
  }
  function editor() { return EditorView.findFromDOM(container.querySelector(".cm-content")!)!; }
  async function edit(transform: (source: string) => string) {
    await act(() => { const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: transform(view.state.doc.toString()) } }); });
  }
  function button(label: string) { return [...container.querySelectorAll("button")].find(button => button.textContent === label)!; }

  it("retains an invalid or rejected draft and reloads the saved configuration explicitly", async () => {
    api.save.mockRejectedValue(new Error("Agent configuration changed while you were editing."));
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => source.replace("budgetMonthlyCents: 0", "budgetMonthlyCents: -1"));
    expect(button("Save changes").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("spec.budgetMonthlyCents");
    await edit(source => source.replace("budgetMonthlyCents: -1", "budgetMonthlyCents: 500"));
    await act(() => button("Save changes").click());
    await settle(() => expect(container.textContent).toContain("configuration changed while you were editing"));
    expect(editor().state.doc.toString()).toContain("budgetMonthlyCents: 500");
    expect(api.save.mock.calls[0][1].spec.budgetMonthlyCents).toBe(500);
    await act(() => button("Reload saved").click());
    await settle(() => expect(editor().state.doc.toString()).toContain("budgetMonthlyCents: 0"));
    expect(button("Save changes").disabled).toBe(true);
  });

  it("keeps the saved server result and uses its revision for the next edit", async () => {
    api.save.mockResolvedValue(snapshot({ ...agent, name: "Codie Two", urlKey: "codie-two", configurationRevision: "b".repeat(64) }));
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => source.replace("name: Codie", "name: Codie Two"));
    await act(() => button("Save changes").click());
    await settle(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(button("Save changes").disabled).toBe(true);
    expect(editor().state.doc.toString()).toContain("name: Codie Two");
    await edit(source => source.replace("title: null", "title: Engineer"));
    await act(() => button("Save changes").click());
    await settle(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(api.save.mock.calls[1][0].core.configurationRevision).toBe("b".repeat(64));
    expect(api.save.mock.calls[1][1].spec.title).toBe("Engineer");
  });

  it("blocks retries after partial saves and keeps one-time credentials outside YAML", async () => {
    api.save.mockImplementation(async (_snapshot, _document, onReceipt) => {
      onReceipt({ id: "key", label: "Automation", token: "one-time-key" });
      throw new ConfigurationSaveInterrupted("second key", ["first key"], new Error("Network lost"));
    });
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => source.replace("title: null", "title: Engineer"));
    await act(() => button("Save changes").click());
    await settle(() => expect(container.textContent).toContain("Reload saved before saving again"));
    expect(button("Save changes").disabled).toBe(true);
    expect((container.querySelector('input[aria-label="Automation token"]') as HTMLInputElement).value).toBe("one-time-key");
    expect(editor().state.doc.toString()).not.toContain("one-time-key");
    await edit(source => source.replace("title: Engineer", "title: Lead"));
    expect(button("Save changes").disabled).toBe(true);
    await act(() => button("Reload saved").click());
    await settle(() => expect(editor().state.doc.toString()).toContain("title: null"));
    await edit(source => source.replace("title: null", "title: Lead"));
    expect(button("Save changes").disabled).toBe(false);
  });

  it("previews changes and sends only one save for a double click", async () => {
    let complete!: (value: ReturnType<typeof snapshot>) => void;
    api.save.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => source.replace("title: null", "title: Engineer"));
    expect(container.querySelector("summary")?.textContent).toBe("1 change to apply");
    expect(container.querySelector("details")?.textContent).toContain("Agent configuration");
    const view = editor();
    await act(() => { button("Save changes").click(); button("Save changes").click(); });
    await settle(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(button("Reload saved").disabled).toBe(true);
    await act(async () => complete(snapshot()));
    await settle(() => expect(button("Save changes").disabled).toBe(true));
    expect(editor()).toBe(view);
  });

  it("validates read-only sections before enabling Save", async () => {
    api.load.mockResolvedValue({ ...snapshot(), document: { ...snapshot().document, observed: { apiKeys: [] } } });
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => source.replace("apiKeys: []", "apiKeys: [changed]"));
    expect(button("Save changes").disabled).toBe(true);
    expect(container.textContent).toContain("observed is read-only");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("keeps Save disabled for formatting-only changes", async () => {
    await render(); await settle(() => expect(editor()).toBeTruthy());
    await edit(source => `${source}\n# A local note\n`);
    expect(button("Save changes").disabled).toBe(true);
    expect(container.textContent).toContain("No configuration changes");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("shows a configuration read denial without rendering an empty editable document", async () => {
    api.load.mockRejectedValue(new Error("Configuration access denied"));
    await render(); await settle(() => expect(container.textContent).toContain("Configuration access denied"));
    expect(container.querySelector(".cm-content")).toBeNull();
    expect(api.save).not.toHaveBeenCalled();
  });
});
