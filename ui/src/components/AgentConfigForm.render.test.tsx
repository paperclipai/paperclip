// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: type === "hermes_gateway" ? "Hermes Gateway" : "Codex",
    ConfigFields: ({ adapterType }: { adapterType: string }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : null,
    buildAdapterConfig: () => ({}),
    parseStdoutLine: () => [],
  }),
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) =>
    adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: false,
          supportsAcp: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: true,
          supportsAcp: true,
        },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: { showAdapterTestEnvironmentButton?: boolean } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={makeAgent(agentOverrides)}
            onSave={vi.fn()}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root };
}

describe("AgentConfigForm environment selector", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides the environment override when Local is the only configured environment", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Environment override");
    expect(result.container.querySelector("select")).toBeNull();
  });

  it("shows concise Environment copy when one runnable non-local environment exists", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment");
    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("E2B · sandbox");
    expect(text).not.toContain("Execution");
    expect(text).not.toContain("Leave this unset to inherit the instance default");
    expect(text).not.toContain("Inherit instance default");
  });

  it("shows the environment override for Grok local agents", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "sandbox-1",
          name: "E2B",
          driver: "sandbox",
          config: { provider: "e2b" },
        }),
      ],
      { adapterType: "grok_local" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("E2B · sandbox");
  });

  it("keeps an existing non-runnable override visible so it can be cleared", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "fake-sandbox-1",
          name: "Fake Sandbox",
          driver: "sandbox",
          config: { provider: "fake" },
        }),
      ],
      { defaultEnvironmentId: "fake-sandbox-1" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("Fake Sandbox · sandbox");
  });

  it("renders non-local adapter config fields in the Adapter card", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl: "http://127.0.0.1:8642",
          apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    );
    roots.push(result.root);

    expect(result.container.querySelector('[data-testid="hermes-gateway-config-fields"]')).toBeTruthy();
    expect(result.container.textContent).toContain("Hermes Gateway fields");
  });

  it("tests both the primary and cheap models when a cheap profile is configured", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: {
              model: "gpt-5.4-mini",
              baseUrl: "https://cheap-models.example.test",
              provider: "budget-provider",
            },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({ model: "gpt-5.4" }),
    });
    expect(mockAgentsApi.testEnvironment.mock.calls[1]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({
        model: "gpt-5.4-mini",
        baseUrl: "https://cheap-models.example.test",
        provider: "budget-provider",
      }),
    });
  });

  it("flushes pending environment variable edits before testing adapter config", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: {
        model: "gpt-5.4",
        env: { API_TOKEN: { type: "plain", value: "old-token" } },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const valueInput = result.container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]');
    expect(valueInput).toBeTruthy();

    await act(async () => {
      setInputValue(valueInput!, "draft-token");
    });
    await flushReact();

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
    for (const call of mockAgentsApi.testEnvironment.mock.calls) {
      expect(call).toEqual([
        "company-1",
        "codex_local",
        expect.objectContaining({
          adapterConfig: expect.objectContaining({
            env: { API_TOKEN: { type: "plain", value: "draft-token" } },
          }),
        }),
      ]);
    }
  });

  it("surfaces request failures instead of converting them into model test checks", async () => {
    mockAgentsApi.testEnvironment.mockRejectedValueOnce(new Error("Network unavailable"));

    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "gpt-5.4-mini" },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(result.container.textContent).toContain("Network unavailable");
  });
});
