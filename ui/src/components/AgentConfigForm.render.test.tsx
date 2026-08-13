// @vitest-environment jsdom

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm, AdapterLoginPanel, type AdapterLoginDescriptor } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
}));

const mockClipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
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
  listProposals: vi.fn(),
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

vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: mockClipboard.copyTextToClipboard,
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
        <ToastProvider>
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
        </ToastProvider>
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
        <ToastProvider>
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
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onChange };
}

const AUTH_MISSING_RESULT = {
  adapterType: "codex_local",
  status: "fail",
  checks: [
    {
      code: "adapter_auth_missing",
      level: "error",
      message: "The sandbox has no ready authentication.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

function findByAriaLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

async function renderCodexSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ],
    { defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

async function clickByText(container: HTMLElement, label: string) {
  const button = findButton(container, label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function clickElement(element: Element | null | undefined) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function runTest(container: HTMLElement) {
  await clickByText(container, "Test");
}

async function startLogin(container: HTMLElement) {
  await clickByText(container, "Log in");
  await flushReact();
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
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.startAdapterAuthLogin.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
      prompt: { url: "https://auth.example.test/device", code: "WXYZ-1234" },
    });
    mockAgentsApi.cancelAdapterAuthLogin.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "cancelled",
      expiresAt: null,
      failure: null,
      prompt: null,
    });
    mockClipboard.copyTextToClipboard.mockResolvedValue(undefined);
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

  it("hides the Login button before Test and shows it after the adapter_auth_missing check for a Codex sandbox", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    expect(findButton(result.container, "Log in")).toBeFalsy();

    await runTest(result.container);

    expect(findButton(result.container, "Log in")).toBeTruthy();
  });

  it("shows the Login button when a parent lifts the test feedback and renders the panel from the descriptor", async () => {
    // The create page hides the inline feedback branch and renders the test
    // result and the login panel itself. This harness mirrors that parent: it
    // lifts the feedback and renders `AdapterLoginPanel` from the lifted login
    // descriptor. Without the descriptor the Login button never appears.
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    function LiftedFeedbackHarness() {
      const [login, setLogin] = useState<AdapterLoginDescriptor | null>(null);
      return (
        <>
          <AgentConfigForm
            mode="create"
            values={{
              ...defaultCreateValues,
              adapterType: "codex_local",
              defaultEnvironmentId: "sandbox-1",
            }}
            onChange={() => {}}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton
            onTestFeedbackChange={(feedback) => setLogin(feedback.login)}
          />
          {login && (
            <AdapterLoginPanel
              companyId={login.companyId}
              adapterType={login.adapterType}
              environmentId={login.environmentId}
            />
          )}
        </>
      );
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <LiftedFeedbackHarness />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(findButton(container, "Log in")).toBeFalsy();

    await runTest(container);

    expect(findButton(container, "Log in")).toBeTruthy();
  });

  it("does not show the Login button when the Test result has no adapter_auth_missing check", async () => {
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Log in")).toBeFalsy();
  });

  it("does not show the Login button when the effective environment is Local", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {},
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Log in")).toBeFalsy();
  });

  it("starts a login session for the effective sandbox and shows the code and the authentication URL", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", {
      environmentId: "sandbox-1",
    });
    expect(result.container.textContent).toContain("WXYZ-1234");
    expect(result.container.textContent).toContain("https://auth.example.test/device");
  });

  it("shows the loading state while the session starts and the prompt is not ready", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
      prompt: null,
    });
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    expect(result.container.textContent).toContain("Preparing the login");
    expect(result.container.textContent).not.toContain("https://");
  });

  it("copies the login code and the authentication URL", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    await clickElement(findByAriaLabel(result.container, "Copy code"));
    await clickElement(findByAriaLabel(result.container, "Copy URL"));

    expect(mockClipboard.copyTextToClipboard).toHaveBeenCalledWith("WXYZ-1234");
    expect(mockClipboard.copyTextToClipboard).toHaveBeenCalledWith("https://auth.example.test/device");
  });

  it("keeps the code and URL visible after a later poll returns no prompt", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    // The server delivers the one-time prompt on the first owner read only. The
    // first status poll carries the prompt; every later poll carries a null one.
    mockAgentsApi.getAdapterAuthLoginStatus
      .mockResolvedValueOnce({
        sessionId: "session-1",
        environmentId: "sandbox-1",
        status: "waiting_for_user",
        expiresAt: null,
        failure: null,
        prompt: { url: "https://auth.example.test/device", code: "WXYZ-1234" },
      })
      .mockResolvedValue({
        sessionId: "session-1",
        environmentId: "sandbox-1",
        status: "waiting_for_user",
        expiresAt: null,
        failure: null,
        prompt: null,
      });
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    expect(result.container.textContent).toContain("WXYZ-1234");

    // Wait for the next status poll, which returns no prompt.
    const start = Date.now();
    while (mockAgentsApi.getAdapterAuthLoginStatus.mock.calls.length < 2) {
      if (Date.now() - start > 6000) throw new Error("the status poll did not run a second time");
      await flushReact();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await flushReact();

    // The panel latched the prompt, so the code and the URL stay visible.
    expect(result.container.textContent).toContain("WXYZ-1234");
    expect(result.container.textContent).toContain("https://auth.example.test/device");
  });

  it("shows a Cancel affordance while a login is active and cancels the session", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    // The Cancel button appears while the session is active.
    expect(findButton(result.container, "Cancel")).toBeTruthy();

    await clickByText(result.container, "Cancel");
    await flushReact();

    expect(mockAgentsApi.cancelAdapterAuthLogin).toHaveBeenCalledWith(
      "company-1",
      "codex_local",
      "session-1",
    );
    // The panel resets: the Log in button is available again and the code is gone.
    const login = findButton(result.container, "Log in");
    expect(login?.disabled).toBe(false);
    expect(findButton(result.container, "Cancel")).toBeFalsy();
    expect(result.container.textContent).not.toContain("WXYZ-1234");
  });

  it("announces the login state through a polite live region", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    const live = result.container.querySelector('[role="status"][aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toContain("WXYZ-1234");
  });

  it("opens the authentication URL in a new tab with a safe rel", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    const link = result.container.querySelector('a[href="https://auth.example.test/device"]');
    expect(link).toBeTruthy();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("disables a second login start while a session is active", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    const startButton = findButton(result.container, "Log in");
    expect(startButton).toBeTruthy();
    expect(startButton?.disabled).toBe(true);
    expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
  });

  it("renders the authenticated terminal state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
      prompt: null,
    });
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    expect(result.container.textContent).toContain("Authenticated");
  });

  it("renders the failed terminal state with the non-secret message", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "failed",
      expiresAt: null,
      failure: { reason: "device_rejected", message: "The device rejected the code." },
      prompt: null,
    });
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    expect(result.container.textContent).toContain("Login failed");
    expect(result.container.textContent).toContain("The device rejected the code.");
  });

  it("renders the timed-out terminal state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "timed_out",
      expiresAt: null,
      failure: null,
      prompt: null,
    });
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);

    expect(result.container.textContent).toContain("Login timed out");
  });

  it("hides the Login button when the effective environment changes after a Test", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);
    expect(findButton(result.container, "Log in")).toBeTruthy();

    const select = result.container.querySelector("select");
    await act(async () => {
      if (select) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(select, "");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await flushReact();

    expect(findButton(result.container, "Log in")).toBeFalsy();
  });
});
