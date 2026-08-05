// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

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
  create: vi.fn(),
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
    buildAdapterConfig: (values: { model?: string }) => ({
      model: values.model || undefined,
    }),
    parseStdoutLine: () => [],
    credentialSetup:
      type === "claude_local"
        ? {
            options: [
              {
                envKey: "ANTHROPIC_API_KEY",
                kind: "api_key" as const,
                label: "Anthropic API key",
                hint: "Create a key in the Anthropic Console.",
                placeholder: "sk-ant-…",
              },
            ],
          }
        : undefined,
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

async function renderCreateForm(
  environments: Environment[],
  valueOverrides: Partial<typeof defaultCreateValues> = {},
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

  const values = {
    ...defaultCreateValues,
    adapterType: "codex_local",
    ...valueOverrides,
  };
  const onChange = vi.fn();

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="create"
            values={values}
            onChange={onChange}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onChange };
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

  it("tests a Codex agent after clearing the primary model to the adapter default", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const modelButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "gpt-5.4",
    );
    expect(modelButton).toBeTruthy();

    await act(async () => {
      modelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const defaultButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Default",
    );
    expect(defaultButton).toBeTruthy();

    await act(async () => {
      defaultButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: {},
    });
    const adapterConfig = (mockAgentsApi.testEnvironment.mock.calls[0]?.[2] as {
      adapterConfig: Record<string, unknown>;
    }).adapterConfig;
    expect(adapterConfig).not.toHaveProperty("model");
    expect(result.container.textContent).not.toContain("Cannot read properties of undefined");
  });

  it("omits undefined adapter config entries when testing a create form with the default model", async () => {
    const result = await renderCreateForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      model: "",
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
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: {},
    });
    const adapterConfig = (mockAgentsApi.testEnvironment.mock.calls[0]?.[2] as {
      adapterConfig: Record<string, unknown>;
    }).adapterConfig;
    expect(adapterConfig).not.toHaveProperty("model");
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

describe("AgentConfigForm guided credential connect", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
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

  it("shows the guided credential connect card for an adapter with a descriptor and empty env", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "claude_local", adapterConfig: {} },
    );
    roots.push(result.root);

    expect(result.container.textContent).toContain("Anthropic API key");
    expect(
      result.container.querySelector('input[aria-label="Anthropic API key value"]'),
    ).toBeTruthy();
    expect(result.container.textContent).not.toContain("Connected");
  });

  it("shows a connected summary when the env has a secret_ref binding for the descriptor's env key", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
          },
        },
      },
    );
    roots.push(result.root);

    expect(result.container.textContent).toContain("Connected");
    expect(result.container.textContent).toContain("ANTHROPIC_API_KEY");
    expect(
      result.container.querySelector('input[aria-label="Anthropic API key value"]'),
    ).toBeNull();
  });

  it("shows a connected summary when the env has a non-empty plain value for the descriptor's env key", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "claude_local",
        adapterConfig: {
          env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-existing" } },
        },
      },
    );
    roots.push(result.root);

    expect(result.container.textContent).toContain("Connected");
    expect(
      result.container.querySelector('input[aria-label="Anthropic API key value"]'),
    ).toBeNull();
  });

  it("does not show the credential connect card for an adapter type without a credential descriptor", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "codex_local" },
    );
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Anthropic API key");
    expect(
      result.container.querySelector('input[aria-label="Anthropic API key value"]'),
    ).toBeNull();
  });

  it("binds a new credential into the environment-variables editor state", async () => {
    mockSecretsApi.create.mockResolvedValueOnce({
      id: "secret-42",
      companyId: "company-1",
      scope: "company",
      ownerUserId: null,
      userSecretDefinitionId: null,
      key: "claude-local-anthropic-api-key",
      name: "claude-local-anthropic-api-key",
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
      externalRef: null,
      providerConfigId: null,
      providerMetadata: null,
      latestVersion: 1,
      description: null,
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "claude_local", adapterConfig: {} },
    );
    roots.push(result.root);

    const valueInput = result.container.querySelector<HTMLInputElement>(
      'input[aria-label="Anthropic API key value"]',
    );
    expect(valueInput).toBeTruthy();

    await act(async () => {
      setInputValue(valueInput!, "sk-ant-test");
    });
    await flushReact();

    const connectButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    );
    expect(connectButton).toBeTruthy();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    expect(result.container.textContent).toContain("Connected");

    const nameInputs = Array.from(
      result.container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]'),
    );
    expect(nameInputs.some((input) => input.value === "ANTHROPIC_API_KEY")).toBe(true);
  });

  it("invalidates the company secrets list after binding so the picker doesn't show 'Missing secret'", async () => {
    const createdSecret = {
      id: "secret-42",
      companyId: "company-1",
      scope: "company" as const,
      ownerUserId: null,
      userSecretDefinitionId: null,
      key: "claude-local-anthropic-api-key",
      name: "claude-local-anthropic-api-key",
      provider: "local_encrypted" as const,
      status: "active" as const,
      managedMode: "paperclip_managed" as const,
      externalRef: null,
      providerConfigId: null,
      providerMetadata: null,
      latestVersion: 1,
      description: null,
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    mockSecretsApi.create.mockResolvedValueOnce(createdSecret);
    // Before the bind, the list query resolves empty. After the bind fires
    // an invalidation, react-query refetches and this resolves with the
    // freshly created secret — simulating the server now knowing about it.
    mockSecretsApi.list.mockResolvedValueOnce([]).mockResolvedValue([createdSecret]);

    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "claude_local", adapterConfig: {} },
    );
    roots.push(result.root);

    const valueInput = result.container.querySelector<HTMLInputElement>(
      'input[aria-label="Anthropic API key value"]',
    );
    expect(valueInput).toBeTruthy();

    await act(async () => {
      setInputValue(valueInput!, "sk-ant-test");
    });
    await flushReact();

    const connectButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    );
    expect(connectButton).toBeTruthy();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The secrets list query was invalidated (and thus refetched) rather
    // than left stale, so the picker resolves the bound secret instead of
    // rendering the destructive "Missing secret" fallback.
    expect(mockSecretsApi.list.mock.calls.length).toBeGreaterThan(1);
    expect(result.container.textContent).not.toContain("Missing secret");
    expect(result.container.textContent).toContain("claude-local-anthropic-api-key");
  });
});
