// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigureBuiltInAgentModal } from "./ConfigureBuiltInAgentModal";
import type { BuiltInAgentState } from "@/api/builtInAgents";

const provisionMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const adapterModelsMock = vi.hoisted(() => vi.fn());
const capturedMutationFn = vi.hoisted(() => ({ current: null as null | (() => Promise<unknown>) }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useMutation: ((options: { mutationFn?: () => Promise<unknown> }, ...rest: unknown[]) => {
      capturedMutationFn.current = options?.mutationFn ?? null;
      return (actual.useMutation as (o: unknown, ...r: unknown[]) => unknown)(options, ...rest);
    }) as typeof actual.useMutation,
  };
});

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

vi.mock("@/components/agent-config-primitives", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/agent-config-primitives")>();
  return {
    ...actual,
    Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
      <label>
        {label}
        {children}
      </label>
    ),
  };
});

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
          <TooltipProvider>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={state}
            open
            onOpenChange={onOpenChange}
            onConfigured={onConfigured}
          />
          </TooltipProvider>
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
    capturedMutationFn.current = null;
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

const BUILTIN_FUSION_MODELS = [
  {
    id: "fusion-alpha-high-sidekick-beta-low",
    label: "Fusion (Alpha High + Beta Low)",
    fusion: {
      version: 1 as const,
      kind: "fusion" as const,
      components: {
        orchestrator: {
          id: "alpha-high", modelKey: "alpha", modelLabel: "Alpha",
          effortKey: "high", effortLabel: "High", effortSource: "uid" as const,
          label: "Alpha High", modifiers: [] as string[],
        },
        worker: {
          id: "beta-low", modelKey: "beta", modelLabel: "Beta",
          effortKey: "low", effortLabel: "Low", effortSource: "uid" as const,
          label: "Beta Low", modifiers: [] as string[],
        },
      },
      rates: null,
      costSummary: null,
    },
  },
  { id: "devin-family", label: "Devin family" },
];

async function chooseSelect(label: string, value: string) {
  const select = Array.from(document.body.querySelectorAll("select")).find(
    (el) => el.getAttribute("aria-label") === label,
  ) as HTMLSelectElement | undefined;
  expect(select, `Missing select ${label}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(select!, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushReact();
}

describe("ConfigureBuiltInAgentModal Fusion selection", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onOpenChange = vi.fn();
  const onConfigured = vi.fn();

  async function renderModal(state: BuiltInAgentState) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={state}
            open
            onOpenChange={onOpenChange}
            onConfigured={onConfigured}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function devinState(adapterConfig?: Record<string, unknown>): BuiltInAgentState {
    return makeState({
      definition: {
        ...makeState().definition,
        allowedAdapterTypes: ["devin_local"],
        defaultAdapterType: "devin_local",
        ...(adapterConfig ? { defaultAdapterConfig: adapterConfig } : {}),
      },
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    provisionMock.mockReset();
    updateMock.mockReset();
    adapterModelsMock.mockReset().mockResolvedValue(BUILTIN_FUSION_MODELS);
    capturedMutationFn.current = null;
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

  it("provisions the exact Fusion UID chosen through filters and the Combination picker", async () => {
    provisionMock.mockResolvedValue({ ...devinState(), status: "ready", agentId: "a1" });
    await renderModal(devinState());

    await chooseSelect("Strategy", "fusion");
    await chooseSelect("Orchestrator model", "alpha");
    await chooseSelect("Orchestrator effort", "high");
    await chooseSelect("Worker model", "beta");
    await chooseSelect("Worker effort", "low");

    const combo = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Combination",
    )!;
    expect(combo).toBeTruthy();
    flushSync(() => combo.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    const option = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Beta Low"),
    )!;
    expect(option).toBeTruthy();
    flushSync(() => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    const submit = findButton("Configure")!;
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(provisionMock).toHaveBeenCalledWith("c1", "briefs", expect.objectContaining({
      adapterType: "devin_local",
      adapterConfig: expect.objectContaining({ model: "fusion-alpha-high-sidekick-beta-low" }),
    }));
  });

  it("blocks provisioning for a bare fusion value", async () => {
    await renderModal(devinState({ model: "fusion" }));
    await flushReact();
    expect(document.body.textContent).toContain(
      "Choose an explicit Fusion combination; select an orchestrator and worker.",
    );
    const submit = findButton("Configure")!;
    expect(submit.disabled).toBe(true);
    flushSync(() => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("keeps a partial Fusion draft unsubmittable until every filter resolves", async () => {
    await renderModal(devinState());
    await chooseSelect("Strategy", "fusion");
    await chooseSelect("Orchestrator model", "alpha");
    const submit = findButton("Configure")!;
    expect(submit.disabled).toBe(true);
    flushSync(() => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Select model (required)");
  });

  it("starts unselected for Devin without offering a CLI default", async () => {
    await renderModal(devinState());
    const strategy = document.body.querySelector<HTMLSelectElement>(
      'select[aria-label="Strategy"]',
    )!;
    expect(strategy).toBeTruthy();
    const options = Array.from(strategy.options).map((option) => option.value);
    expect(options).not.toContain("default");
    expect(document.body.textContent).not.toContain("Uses the Devin CLI configuration");
    expect(findButton("Configure")!.disabled).toBe(true);
  });

  it("resets a partial draft when the modal closes and reopens", async () => {
    await renderModal(devinState());
    await chooseSelect("Strategy", "fusion");
    await chooseSelect("Orchestrator model", "alpha");
    expect(document.body.textContent).toContain("model selection");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={devinState()}
            open={false}
            onOpenChange={onOpenChange}
            onConfigured={onConfigured}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <ConfigureBuiltInAgentModal
            companyId="c1"
            state={devinState()}
            open
            onOpenChange={onOpenChange}
            onConfigured={onConfigured}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    expect(findButton("Configure")!.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Complete the model selection");
    await chooseSelect("Strategy", "fusion");
    await chooseSelect("Orchestrator model", "alpha");
    expect(document.body.textContent).toContain("model selection");
  });

  it("still blocks a bare manual fusion entry when the catalog fails to load", async () => {
    adapterModelsMock.mockReset().mockRejectedValue(new Error("offline"));
    await renderModal(devinState());
    await flushReact();
    expect(document.body.textContent).toContain("offline");
    const combo = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Combination",
    );
    if (!combo) {
      await chooseSelect("Strategy", "single");
      const modelTrigger = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Model",
      )!;
      flushSync(() => modelTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await flushReact();
      const search = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Search models"]',
      )!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      flushSync(() => {
        setter.call(search, "fusion");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flushReact();
      const manual = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Use manual"),
      )!;
      flushSync(() => manual.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await flushReact();
    }
    expect(document.body.textContent).toContain(
      "Choose an explicit Fusion combination; select an orchestrator and worker.",
    );
    expect(findButton("Configure")!.disabled).toBe(true);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it.each(["fusion", " Fusion ", "FUSION"])("mutationFn rejects a bare fusion value: %j", async (model) => {
    adapterModelsMock.mockResolvedValue([]);
    await renderModal(devinState({ model }));
    expect(capturedMutationFn.current).toBeTruthy();
    await expect(capturedMutationFn.current!()).rejects.toThrow(/Choose an explicit Fusion combination/);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("mutationFn rejects while a Fusion draft is incomplete", async () => {
    await renderModal(devinState({ model: "fusion-alpha-high-sidekick-beta-low" }));
    await chooseSelect("Orchestrator model", "");
    expect(capturedMutationFn.current).toBeTruthy();
    await expect(capturedMutationFn.current!()).rejects.toThrow(/Complete the model selection/);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});
