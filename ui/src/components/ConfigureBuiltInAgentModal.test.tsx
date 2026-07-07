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

function makeState(): BuiltInAgentState {
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

  async function renderModal() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={makeState()}
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

  it("patches the budget after provisioning when set", async () => {
    provisionMock.mockResolvedValue({
      ...makeState(),
      status: "ready",
      agentId: "a1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: { id: "a1", budgetMonthlyCents: 0 } as any,
    });
    updateMock.mockResolvedValue({});
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
    expect(updateMock).toHaveBeenCalledWith("a1", { budgetMonthlyCents: 5000 }, "c1");
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
