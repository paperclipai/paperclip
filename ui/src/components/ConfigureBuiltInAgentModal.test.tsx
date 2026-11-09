// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigureBuiltInAgentModal } from "./ConfigureBuiltInAgentModal";
import type { BuiltInAgentState } from "@/api/builtInAgents";

const provisionMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const adapterModelsMock = vi.hoisted(() => vi.fn());
const adapterDiscoveryMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/adapters", () => ({ adaptersApi: { list: adapterDiscoveryMock } }));

vi.mock("@/api/builtInAgents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/builtInAgents")>();
  return { ...actual, builtInAgentsApi: { list: vi.fn(), provision: provisionMock, reset: vi.fn() } };
});

vi.mock("@/api/agents", () => ({
  agentsApi: { update: updateMock, adapterModels: adapterModelsMock },
}));

vi.mock("@/adapters/metadata", () => ({
  listAdapterOptions: () => [
    { value: "codex_local", label: "Codex" },
    { value: "claude_local", label: "Claude" },
    { value: "process", label: "Process" },
  ],
}));

// Stub the shared pickers so the test can drive them without the full form.
vi.mock("@/components/AgentConfigForm", () => ({
  AdapterTypeDropdown: ({ value }: { value: string }) => (
    <div data-testid="adapter-dropdown" data-value={value} />
  ),
  ModelDropdown: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="model-input"
      value={value}
      onChange={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  ),
}));

vi.mock("@/components/agent-config-primitives", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
}));

function makeState(overrides: Partial<BuiltInAgentState> = {}): BuiltInAgentState {
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares briefs.",
      defaultInstructions: "…",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local", "claude_local"],
      defaultBudgetMonthlyCents: 0,
    },
    status: "not_provisioned",
    agentId: null,
    agent: null,
    pauseReason: null,
    ...overrides,
  };
}

function makeSavedAgent(adapterType: "codex_local" | "paperclip_runner", adapterConfig: Record<string, unknown>): NonNullable<BuiltInAgentState["agent"]> {
  return {
    id: "a1", companyId: "c1", name: "Briefs Agent", urlKey: "briefs-agent", role: "general", title: null, icon: null,
    status: "idle", reportsTo: null, capabilities: null, adapterType, adapterConfig, runtimeConfig: {}, defaultEnvironmentId: null,
    budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null, pausedAt: null, permissions: { canCreateAgents: false },
    lastHeartbeatAt: null, metadata: null, createdAt: new Date(0), updatedAt: new Date(0),
  };
}

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

describe("ConfigureBuiltInAgentModal (PAP-12978)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onOpenChange = vi.fn();
  const onConfigured = vi.fn();

  async function renderModal(state: BuiltInAgentState = makeState()) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={state}
            open
            onOpenChange={onOpenChange}
            onConfigured={onConfigured}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    provisionMock.mockReset();
    updateMock.mockReset();
    adapterModelsMock.mockReset().mockResolvedValue([]);
    adapterDiscoveryMock.mockReset().mockResolvedValue([{ type: "codex_local", supportedRunners: ["paperclip", "legacy"], defaultRunner: "legacy" }]);
    onOpenChange.mockReset();
    onConfigured.mockReset();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("disables submit until a model is chosen, then provisions with adapter + model", async () => {
    provisionMock.mockResolvedValue({ ...makeState(), status: "ready", agentId: "a1" });
    await renderModal();

    const submit = findButton("Configure");
    expect(submit).toBeTruthy();
    expect(submit!.disabled).toBe(true);

    const modelInput = document.body.querySelector('[data-testid="model-input"]') as HTMLInputElement;
    expect(modelInput).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(modelInput, "gpt-5");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const submitReady = findButton("Configure")!;
    expect(submitReady.disabled).toBe(false);
    flushSync(() => {
      submitReady.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
    });
    expect(onConfigured).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prefills a built-in's default adapter and model", async () => {
    provisionMock.mockResolvedValue({ ...makeState(), status: "ready", agentId: "a1" });
    await renderModal(makeState({
      definition: {
        ...makeState().definition,
        defaultAdapterType: "claude_local",
        defaultAdapterConfig: { model: "claude-haiku-4-5" },
      },
    }));

    expect(document.body.querySelector('[data-testid="adapter-dropdown"]')?.getAttribute("data-value"))
      .toBe("claude_local");
    expect(document.body.querySelector<HTMLInputElement>('[data-testid="model-input"]')?.value)
      .toBe("claude-haiku-4-5");

    const submit = findButton("Configure")!;
    expect(submit.disabled).toBe(false);
    flushSync(() => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-haiku-4-5" },
    });
  });

  it.each([
    ["codex_local", "ready"],
    ["paperclip_runner", "ready"],
    ["codex_local", "paused"],
    ["paperclip_runner", "paused"],
  ] as const)("lets the server translate saved %s settings for a runner-only change while %s", async (adapterType, status) => {
    const savedConfig = { model: "gpt-5", timeoutSec: 45, modelReasoningEffort: "high", env: { CODEX_HOME: { type: "secret_ref", secretId: "account-1" } }, ...(adapterType === "paperclip_runner" ? { provider: "codex", codexPermissionMode: "never", lifecycleMode: "per_turn" } : {}) };
    const state = makeState({ status, agentId: "a1", agent: makeSavedAgent(adapterType, savedConfig) });
    provisionMock.mockResolvedValue(state);
    await renderModal(state);
    const summary = document.querySelector("summary")!;
    flushSync(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    flushSync(() => document.querySelector('[aria-label="Runner"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    const runner = adapterType === "paperclip_runner" ? "legacy" : "paperclip";
    flushSync(() => document.querySelector(`[role="option"][data-value="${runner}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    flushSync(() => findButton("Configure")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", { runner });
    expect(state.agent?.adapterConfig).toEqual(savedConfig);
  });

  it.each([
    ["codex_local", "saved"],
    ["paperclip_runner", "saved"],
    ["codex_local", "definition"],
    ["paperclip_runner", "definition"],
  ] as const)("submits the displayed %s configuration to finish setup with its %s model", async (adapterType, modelSource) => {
    const savedConfig = {
      ...(modelSource === "saved" ? { model: "gpt-5" } : {}),
      timeoutSec: 45,
      modelReasoningEffort: "high",
      env: { CODEX_HOME: { type: "secret_ref", secretId: "account-1" } },
      ...(adapterType === "paperclip_runner" ? { provider: "codex", codexPermissionMode: "never", lifecycleMode: "per_turn" } : {}),
    };
    const agent = makeSavedAgent(adapterType, savedConfig);
    agent.metadata = { paperclipBuiltInSetupRequired: true };
    const state = makeState({
      status: "needs_setup",
      agentId: agent.id,
      agent,
      definition: { ...makeState().definition, defaultAdapterConfig: { model: "gpt-5" } },
    });
    const configured = { ...state, status: "ready" as const, agent: { ...agent, metadata: { paperclipBuiltInSetupRequired: false } } };
    provisionMock.mockResolvedValue(configured);
    await renderModal(state);

    expect(document.querySelector<HTMLInputElement>('[data-testid="model-input"]')?.value).toBe("gpt-5");
    expect(findButton("Configure")?.disabled).toBe(false);
    flushSync(() => findButton("Configure")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", {
      adapterType,
      adapterConfig: { ...savedConfig, model: "gpt-5" },
    });
    expect(onConfigured).toHaveBeenCalledWith(configured);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(state.agent?.metadata?.paperclipBuiltInSetupRequired).toBe(true);
    expect(state.agent?.adapterConfig).toEqual(savedConfig);
  });

  it("merges a built-in model edit into the saved native configuration", async () => {
    const savedConfig = { provider: "codex", model: "gpt-5", timeoutSec: 45, modelReasoningEffort: "high", env: { CODEX_HOME: { type: "secret_ref", secretId: "account-1" } } };
    const state = makeState({ status: "ready", agentId: "a1", agent: makeSavedAgent("paperclip_runner", savedConfig) });
    provisionMock.mockResolvedValue(state);
    await renderModal(state);
    const modelInput = document.querySelector('[data-testid="model-input"]') as HTMLInputElement;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(modelInput, "gpt-6-sol");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
    flushSync(() => findButton("Configure")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", { adapterType: "paperclip_runner", adapterConfig: { ...savedConfig, model: "gpt-6-sol" } });
  });

  it("shows a visible error and blocks provisioning for an unknown model", async () => {
    adapterModelsMock.mockResolvedValue([
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ]);
    await renderModal(makeState({
      definition: {
        ...makeState().definition,
        defaultAdapterType: "claude_local",
        defaultAdapterConfig: { model: "claude-haiku-4-6" },
      },
    }));
    await flushReact();

    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("claude-haiku-4-6");
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("not available");
    expect(findButton("Configure")?.disabled).toBe(true);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("sends the budget with provisioning so approval-gated setup preserves it", async () => {
    provisionMock.mockResolvedValue({
      ...makeState(),
      status: "pending_approval",
      agentId: "a1",
      approval: { id: "approval-1", status: "pending" },
    });
    await renderModal();

    const modelInput = document.body.querySelector('[data-testid="model-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(modelInput, "gpt-5");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const budgetInput = document.body.querySelector('input[type="number"]') as HTMLInputElement;
    flushSync(() => {
      setter.call(budgetInput, "50");
      budgetInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    flushSync(() => {
      findButton("Configure")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(provisionMock).toHaveBeenCalled();
    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
      budgetMonthlyCents: 5000,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("provisions non-model adapters so command fields can be completed later", async () => {
    provisionMock.mockResolvedValue({ ...makeState(), status: "needs_setup", agentId: "a1" });
    await renderModal(makeState({
      definition: {
        ...makeState().definition,
        allowedAdapterTypes: ["process"],
      },
    }));

    expect(document.body.textContent).toContain("needs command or endpoint fields");
    expect(document.body.querySelector('[data-testid="model-input"]')).toBeNull();
    const submit = findButton("Provision");
    expect(submit).toBeTruthy();
    expect(submit!.disabled).toBe(false);
    flushSync(() => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", {
      adapterType: "process",
      adapterConfig: {},
    });
    expect(onConfigured).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces provision errors inline instead of closing", async () => {
    const { ApiError } = await import("@/api/client");
    provisionMock.mockRejectedValue(new ApiError("Adapter not allowed", 422, null));
    await renderModal();

    const modelInput = document.body.querySelector('[data-testid="model-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(modelInput, "gpt-5");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    flushSync(() => {
      findButton("Configure")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Adapter not allowed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
