// @vitest-environment jsdom

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment, UserSecretDefinition } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm, AdapterLoginPanel, type AdapterLoginDescriptor } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import { buildNewAgentHirePayload } from "../lib/new-agent-hire-payload";
import { ApiError } from "../api/client";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

const mockClipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listProposals: vi.fn(),
  listUserSecretDefinitions: vi.fn(async () => [] as unknown[]),
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
    // The stand-in also records the two gates the form resolves for every
    // adapter, so a test can assert the plumbing without rendering a real
    // adapter's fields.
    ConfigFields: ({ adapterType, hideInstructionsFile, managedSandboxOnly }: {
      adapterType: string;
      hideInstructionsFile?: boolean;
      managedSandboxOnly?: boolean;
    }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : (
          <div
            data-testid="adapter-config-fields"
            data-hide-instructions-file={String(hideInstructionsFile === true)}
            data-managed-sandbox-only={String(managedSandboxOnly === true)}
          />
        ),
    buildAdapterConfig: (values: { model?: string }) => ({
      model: values.model || undefined,
    }),
    parseStdoutLine: () => [],
  }),
}));

// The projected login capability per adapter type. The server projects these
// safe scalar fields. `codex_local` drives the displayed-code panel; `claude_local`
// drives the submitted-browser-code panel. A test overrides this map to add a
// third adapter with a projected login capability.
const mockLoginProjections = vi.hoisted(
  () =>
    new Map<string, { panelMode: string; timeoutPolicy: string }>([
      ["codex_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["grok_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["claude_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
      // A third adapter, not a built-in, with a projected displayed-code login.
      ["vendor_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      // A non-built-in adapter with a submitted-browser-code login. Every login
      // runs on a real pseudo-terminal, so the gate requires the provider pty
      // capability from the login capability, not the adapter name.
      ["pty_vendor_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
    ]),
);

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) => {
    const login = mockLoginProjections.get(adapterType);
    return adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: true,
          ...(login ? { login } : {}),
        };
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
  options: {
    showAdapterTestEnvironmentButton?: boolean;
    content?: "configuration" | "secrets";
  } = {},
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
              content={options.content}
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

const VENDOR_AUTH_MISSING_RESULT = {
  adapterType: "vendor_local",
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

const GROK_AUTH_MISSING_RESULT = {
  adapterType: "grok_local",
  status: "warn",
  checks: [
    {
      code: "grok_hello_probe_auth_required",
      level: "warn",
      message: "Grok CLI could not answer the hello probe because authentication is missing.",
    },
    {
      code: "adapter_auth_missing",
      level: "warn",
      message: "This environment has no ready authentication for this adapter.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

const PTY_VENDOR_AUTH_MISSING_RESULT = {
  adapterType: "pty_vendor_local",
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

const CLAUDE_AUTH_MISSING_RESULT = {
  adapterType: "claude_local",
  status: "warn",
  checks: [
    {
      code: "claude_hello_probe_auth_required",
      level: "warn",
      message: "Claude CLI is installed, but login is required.",
    },
    {
      code: "adapter_auth_missing",
      level: "warn",
      message: "The sandbox has no ready authentication for this adapter.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

// The provider capabilities the form fetches. Daytona advertises the
// setup-token login capability; E2B does not. The Claude login panel shows only
// for a provider with the capability.
const SANDBOX_CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: {
    daytona: { supportsLoginPty: true, displayName: "Daytona" },
    e2b: { supportsLoginPty: false, displayName: "E2B" },
  },
});

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
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A third adapter, not a built-in, in a sandbox environment. Its projected login
// capability drives the login affordance and the displayed-code panel. The
// provider advertises the login pseudo-terminal capability the login needs.
async function renderVendorSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "vendor_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A Grok agent in a sandbox environment. Its projected login capability
// drives the login affordance and the displayed-code panel, the same as
// Codex. The provider advertises the login pseudo-terminal capability the
// login needs.
async function renderGrokSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "grok_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

async function renderClaudeSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

async function renderCreateClaudeSandbox(
  valueOverrides: Partial<typeof defaultCreateValues> = {},
) {
  return renderCreateForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1", ...valueOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A create-mode harness that holds the form values in React state. A value
// patch from the form (a login claim, an environment change) updates the props,
// so the form re-runs its effects against the new state. The fixed-values
// `renderCreateForm` harness cannot show the environment-change reset, because
// its `values` prop never changes. `valuesRef` exposes the current merged
// values to the test.
async function renderStatefulCreateClaudeSandbox(environments: Environment[]) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const valuesRef: { current: typeof defaultCreateValues } = {
    current: {
      ...defaultCreateValues,
      adapterType: "claude_local",
      defaultEnvironmentId: "sandbox-1",
    },
  };

  function Harness() {
    const [values, setValues] = useState(valuesRef.current);
    valuesRef.current = values;
    return (
      <AgentConfigForm
        mode="create"
        values={values}
        onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
        hidePromptTemplate
        showAdapterTypeField={false}
        showAdapterTestEnvironmentButton
      />
    );
  }

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, valuesRef };
}

async function selectEnvironment(container: HTMLElement, environmentId: string) {
  const select = container.querySelector("select");
  await act(async () => {
    if (select) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, environmentId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await flushReact();
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
  await clickByText(container, "Sign in");
  await flushReact();
}

// Flush React effects and pending promises until a condition holds. The Claude
// login chains a start, a status poll, and a completion read, so a single flush
// does not settle every state transition.
async function flushUntil(check: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) break;
    await flushReact();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await flushReact();
}

describe("AgentConfigForm environment selector", () => {
  let roots: Root[] = [];

  beforeEach(() => {
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
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
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
    mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
      panelMode: "submitted_browser_code",
      prompt: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({
      authorizationUrl: "https://claude.example.test/authorize",
    });
    mockAgentsApi.submitClaudeSetupTokenBrowserCode.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.completeClaudeSetupTokenLogin.mockResolvedValue({
      storedSessionId: "stored-session-1",
    });
    mockAgentsApi.cancelClaudeSetupTokenLogin.mockResolvedValue(undefined);
    // Default: the owner has no stored Claude login. A test that needs a stored
    // value overrides this with a status body.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
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

  it("keeps secret access out of the main Configuration content", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Secret access");
  });

  it("renders secret access as dedicated form content", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {},
      { content: "secrets" },
    );
    roots.push(result.root);

    expect(result.container.textContent).toContain("Secret access");
    expect(result.container.textContent).toContain("No secrets are bound to this agent yet.");
    expect(result.container.textContent).not.toContain("Environment variables");
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

  it("shows the environment override for Kimi local agents", async () => {
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
      { adapterType: "kimi_local" },
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

  it("labels the platform-managed instance default by name, without the driver key", async () => {
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: "managed-1" });
    const result = await renderForm([
      makeEnvironment({
        id: "managed-1",
        name: "Paperclip Computer",
        driver: "sandbox",
        config: { provider: "daytona" },
        metadata: { managedByPaperclip: true },
      }),
    ]);
    roots.push(result.root);

    const selector = result.container.querySelector("select");

    expect(selector?.textContent).toContain("Default: Paperclip Computer");
    expect(selector?.textContent).toContain("Paperclip Computer");
    expect(selector?.textContent).not.toContain("(sandbox)");
    expect(selector?.textContent).not.toContain("· sandbox");
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

    expect(findButton(result.container, "Sign in")).toBeFalsy();

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeTruthy();
  });

  it("hides the Codex login for a provider without the login pseudo-terminal capability", async () => {
    // The Codex device login runs on a real pseudo-terminal, so it needs a
    // provider that advertises the login pseudo-terminal capability. E2B reports
    // no capability, so the panel stays hidden even after the auth-missing check.
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
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
      { adapterType: "codex_local", defaultEnvironmentId: "sandbox-1" },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("shows the login affordance and the displayed-code panel for a third adapter with a projected login capability", async () => {
    // The adapter is not a built-in. Its projected login capability drives the
    // login affordance and the panel, so the form reads the capability, not the
    // adapter name. The displayed-code panel shows the server code.
    mockAgentsApi.testEnvironment.mockResolvedValue(VENDOR_AUTH_MISSING_RESULT);
    const result = await renderVendorSandbox();
    roots.push(result.root);

    expect(findButton(result.container, "Sign in")).toBeFalsy();

    await runTest(result.container);

    // The projected capability gates the login affordance on for the third
    // adapter.
    expect(findButton(result.container, "Sign in")).toBeTruthy();

    await startLogin(result.container);

    // The displayed-code panel shows the one-time code and the authentication
    // URL. It shows no browser-code input, so the dispatcher picked the panel
    // from the projected `displayed_code` mode.
    expect(result.container.textContent).toContain("WXYZ-1234");
    expect(result.container.querySelector('input[aria-label="Browser code"]')).toBeFalsy();
  });

  it("shows the login affordance and the displayed-code panel for a Grok sandbox with a projected login capability", async () => {
    // The panel dispatcher reads the projected `displayed_code` mode from the
    // capability, the same way it does for Codex. It shows the Grok code and
    // URL.
    mockAgentsApi.testEnvironment.mockResolvedValue(GROK_AUTH_MISSING_RESULT);
    const result = await renderGrokSandbox();
    roots.push(result.root);

    expect(findButton(result.container, "Sign in")).toBeFalsy();

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeTruthy();

    await startLogin(result.container);

    expect(result.container.textContent).toContain("WXYZ-1234");
    expect(result.container.querySelector('input[aria-label="Browser code"]')).toBeFalsy();
  });

  it("hides the Login button before Test and shows it after the adapter_auth_missing check for a Claude sandbox", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    expect(findButton(result.container, "Sign in")).toBeFalsy();

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeTruthy();
  });

  it("hides the Login button for a Claude sandbox whose provider lacks the setup-token login capability", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
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
      { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1" },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    // E2B does not advertise the setup-token login capability, so the panel
    // stays hidden even after the auth-missing check.
    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("hides the Login button for a Daytona sandbox while the capabilities report no setup-token support", async () => {
    // Reproduces the reported defect: the Test carries the auth-missing check,
    // but the capabilities endpoint reports `supportsLoginPty: false`
    // for Daytona (a stale persisted plugin manifest). The gate hides the
    // panel. The server-side fix refreshes the persisted manifest so the
    // capability reports true and the panel shows (see the companion positive
    // test above).
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(["claude_local", "codex_local"], {
        sandboxProviders: {
          daytona: { supportsLoginPty: false, displayName: "Daytona" },
        },
      }),
    );
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "sandbox-1",
          name: "Daytona",
          driver: "sandbox",
          config: { provider: "daytona" },
        }),
      ],
      { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1" },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("gates a pseudo-terminal login on the provider pty capability for a non-Claude adapter", async () => {
    // The gate reads the adapter login transport, not the adapter name. This
    // adapter is not `claude_local`, but its login runs on a pseudo-terminal.
    // The E2B provider reports no pty capability, so the panel stays hidden even
    // after the auth-missing check.
    mockAgentsApi.testEnvironment.mockResolvedValue(PTY_VENDOR_AUTH_MISSING_RESULT);
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
      { adapterType: "pty_vendor_local", defaultEnvironmentId: "sandbox-1" },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("shows a pseudo-terminal login for a non-Claude adapter when the provider advertises pty support", async () => {
    // The same non-Claude pseudo-terminal adapter on Daytona. Daytona advertises
    // the pty capability, so the panel shows. This confirms the gate follows the
    // provider capability, not the adapter name.
    mockAgentsApi.testEnvironment.mockResolvedValue(PTY_VENDOR_AUTH_MISSING_RESULT);
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "sandbox-1",
          name: "Daytona",
          driver: "sandbox",
          config: { provider: "daytona" },
        }),
      ],
      { adapterType: "pty_vendor_local", defaultEnvironmentId: "sandbox-1" },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeTruthy();
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
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
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

    expect(findButton(container, "Sign in")).toBeFalsy();

    await runTest(container);

    expect(findButton(container, "Sign in")).toBeTruthy();
  });

  it("does not show the Login button when the Test result has no adapter_auth_missing check", async () => {
    const result = await renderCodexSandbox();
    roots.push(result.root);

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeFalsy();
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

    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("shows the Login button for an agent with no own environment under the managed-sandbox-only policy", async () => {
    // The agent has no own environment, so the login target resolves the same
    // way as the adapter Test target. The managed-sandbox-only policy redirects
    // that resolution from the hidden local environment to the managed sandbox.
    // The login affordance must read the managed sandbox, so it shows after the
    // auth-missing check. A login target that stayed local would hide the panel
    // for the target the real run uses.
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
      enableManagedSandboxOnly: true,
    });
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderForm(
      [
        makeEnvironment({
          id: "local-1",
          name: "Local",
          driver: "local",
          metadata: { defaultForInstance: true },
        }),
        makeEnvironment({
          id: "managed-1",
          name: "Managed",
          driver: "sandbox",
          config: { provider: "daytona" },
          metadata: { managedByPaperclip: true },
        }),
      ],
      { adapterType: "claude_local", defaultEnvironmentId: null },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    expect(findButton(result.container, "Sign in")).toBeFalsy();

    await runTest(result.container);

    expect(findButton(result.container, "Sign in")).toBeTruthy();
  });

  it("keeps the Login button hidden under the managed-sandbox-only policy when no managed sandbox is available", async () => {
    // The policy is on, but no managed sandbox environment exists, so the login
    // target resolution fails closed. The render catches that failure and
    // resolves no login environment, so the affordance stays hidden. The Test
    // surfaces the same case as a fail-closed error.
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
      enableManagedSandboxOnly: true,
    });
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderForm(
      [
        makeEnvironment({
          id: "local-1",
          name: "Local",
          driver: "local",
          metadata: { defaultForInstance: true },
        }),
      ],
      { adapterType: "claude_local", defaultEnvironmentId: null },
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    expect(findButton(result.container, "Sign in")).toBeFalsy();
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

    expect(result.container.textContent).toContain("Preparing...");
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
    // The panel resets: the Sign in button is available again and the code is gone.
    const login = findButton(result.container, "Sign in");
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

    const startButton = findButton(result.container, "Sign in");
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
    expect(findButton(result.container, "Sign in")).toBeTruthy();

    const select = result.container.querySelector("select");
    await act(async () => {
      if (select) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(select, "");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await flushReact();

    expect(findButton(result.container, "Sign in")).toBeFalsy();
  });

  it("shows the authorization URL and a browser-code input for a Claude sandbox", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("https://claude.example.test/authorize"),
    );

    expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledWith("company-1", {
      environmentId: "sandbox-1",
    });
    // The panel shows the authorization URL and a browser-code input. It never
    // shows a server-displayed code.
    expect(result.container.textContent).toContain("https://claude.example.test/authorize");
    expect(
      result.container.querySelector('input[aria-label="Browser code"]'),
    ).toBeTruthy();
    // The default prompt carries no advisory: a confidential transport. So the
    // panel shows no disclaimer.
    expect(result.container.textContent).not.toContain("not encrypted");
  });

  it("shows a non-blocking disclaimer when the transport advisory is present", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    // The guarded prompt read reports a non-confidential transport. The server
    // does not block the login; it attaches the advisory. The panel shows a
    // disclaimer and the login still proceeds.
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({
      authorizationUrl: "https://claude.example.test/authorize",
      transportAdvisory: { code: "insecure_transport" },
    });
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => (result.container.textContent ?? "").includes("not encrypted"));

    // The disclaimer states the transport risk in plain language.
    expect(result.container.textContent).toContain("not encrypted");
    expect(result.container.textContent).toContain("clear text");
    // The login still proceeds: the panel shows the URL and the browser-code
    // input, so the disclaimer never blocks the flow.
    expect(result.container.textContent).toContain("https://claude.example.test/authorize");
    expect(
      result.container.querySelector('input[aria-label="Browser code"]'),
    ).toBeTruthy();
  });

  it("submits one browser code and clears the input after submit", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      Boolean(result.container.querySelector('input[aria-label="Browser code"]')),
    );

    const input = result.container.querySelector<HTMLInputElement>(
      'input[aria-label="Browser code"]',
    );
    setInputValue(input!, "BROWSERCODE-9");
    await flushReact();
    await clickByText(result.container, "Submit");
    await flushReact();

    expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
      "BROWSERCODE-9",
    );
    // The panel clears the browser code after submit, so the secret does not
    // linger in the input.
    const clearedInput = result.container.querySelector<HTMLInputElement>(
      'input[aria-label="Browser code"]',
    );
    expect(clearedInput?.value).toBe("");
  });

  it("treats the server stored state as success and captures the stored-session claim", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => (result.container.textContent ?? "").includes("Authenticated"));

    expect(mockAgentsApi.completeClaudeSetupTokenLogin).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
    );
    expect(result.container.textContent).toContain("Authenticated");
  });

  it("clears the stored-session claim and the fixed binding when the effective environment changes", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    const result = await renderStatefulCreateClaudeSandbox([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona One",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
      makeEnvironment({
        id: "sandbox-2",
        name: "Daytona Two",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ]);
    roots.push(result.root);

    // Sign in on the first sandbox. The stored state adds the fixed
    // `CLAUDE_CODE_OAUTH_TOKEN` binding and the non-secret claim to the form.
    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => result.valuesRef.current.claudeStoredSessionId != null);

    expect(result.valuesRef.current.claudeStoredSessionId).toBe("stored-session-1");
    expect("CLAUDE_CODE_OAUTH_TOKEN" in (result.valuesRef.current.envBindings ?? {})).toBe(true);

    // Change the effective environment. The reset drops the claim and the
    // binding, so the create request cannot send a claim for the old target.
    await selectEnvironment(result.container, "sandbox-2");

    const values = result.valuesRef.current;
    expect(values.claudeStoredSessionId ?? null).toBeNull();
    expect(values.claudeApplyStoredLogin ?? false).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in (values.envBindings ?? {})).toBe(false);

    // The create request body carries no stale claim.
    const payload = buildNewAgentHirePayload({
      name: "Cody",
      effectiveRole: "Engineer",
      configValues: values,
      adapterConfig: {},
    });
    expect("storedSessionId" in payload).toBe(false);
  });

  it("clears the false missing-definition error on the bound row after a login stores the token", async () => {
    // Regression: the user-secret-definitions list read at page load does not
    // yet contain the Claude token key, but it is not empty. A stale non-empty
    // list makes the bound row show a false "no longer exists" error. The login
    // must invalidate the list so the refetch clears the error.
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    const makeDefinition = (key: string): UserSecretDefinition => ({
      id: `def-${key}`,
      companyId: "company-1",
      key,
      name: key.toUpperCase(),
      description: null,
      status: "active",
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
      providerConfigId: null,
      providerMetadata: null,
      usageGuidance: null,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const staleList = [makeDefinition("OTHER_SECRET")];
    const freshList = [makeDefinition("OTHER_SECRET"), makeDefinition("CLAUDE_CODE_OAUTH_TOKEN")];
    mockSecretsApi.listUserSecretDefinitions.mockReset();
    mockSecretsApi.listUserSecretDefinitions
      .mockResolvedValueOnce(staleList)
      .mockResolvedValue(freshList);

    const result = await renderStatefulCreateClaudeSandbox([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ]);
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => result.valuesRef.current.claudeStoredSessionId != null);

    // The login bound the fixed Claude token row.
    expect("CLAUDE_CODE_OAUTH_TOKEN" in (result.valuesRef.current.envBindings ?? {})).toBe(true);

    // The invalidation refetched the definitions, so the stale list no longer
    // drives the row.
    await flushUntil(() => mockSecretsApi.listUserSecretDefinitions.mock.calls.length >= 2);
    await flushUntil(() => {
      const inputs = Array.from(result.container.querySelectorAll("input"));
      return inputs.some((input) => (input as HTMLInputElement).value === "CLAUDE_CODE_OAUTH_TOKEN");
    });

    // Vacuous-pass guard: the bound row rendered.
    const inputs = Array.from(result.container.querySelectorAll("input"));
    expect(inputs.some((input) => (input as HTMLInputElement).value === "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    // The row shows no false missing-definition error.
    expect(result.container.textContent ?? "").not.toContain("no longer exists");
  });

  it("reports the non-secret stored-session claim to the parent on success", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    const onStored = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <AdapterLoginPanel
                companyId="company-1"
                adapterType="claude_local"
                environmentId="sandbox-1"
                onStored={onStored}
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await startLogin(container);
    await flushUntil(() => onStored.mock.calls.length > 0);

    expect(onStored).toHaveBeenCalledWith("stored-session-1");
  });

  it("offers an apply-existing affordance when the status route reports a stored value", async () => {
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
      secretId: "secret-1",
      latestVersion: 3,
    });
    const onApplyStored = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <AdapterLoginPanel
                companyId="company-1"
                adapterType="claude_local"
                environmentId="sandbox-1"
                onApplyStored={onApplyStored}
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushUntil(() => Boolean(findButton(container, "Use saved login")));

    await clickByText(container, "Use saved login");

    expect(onApplyStored).toHaveBeenCalledTimes(1);
    // The panel shows the applied confirmation and hides the apply affordance.
    await flushUntil(() =>
      (container.textContent ?? "").includes("The saved Claude login is bound to this agent now."),
    );
    expect(findButton(container, "Use saved login")).toBeUndefined();
    // The apply-existing path never starts a login round trip.
    expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
  });

  it("does not offer the apply-existing affordance when there is no stored value", async () => {
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
    const onApplyStored = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <AdapterLoginPanel
                companyId="company-1"
                adapterType="claude_local"
                environmentId="sandbox-1"
                onApplyStored={onApplyStored}
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushUntil(() => Boolean(findButton(container, "Sign in")));

    expect(findButton(container, "Use saved login")).toBeUndefined();
    expect(onApplyStored).not.toHaveBeenCalled();
  });

  it("returns to its start state with a fixed message on a server failed state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "failed",
      failure: { reason: "rejected", message: "the provider rejected the browser code" },
      expiresAt: null,
    });
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("The login did not finish"),
    );

    // The panel shows a fixed message and returns to its start state. The Log in
    // button is available again.
    expect(result.container.textContent).toContain("The login did not finish");
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);
    // The panel never shows the provider failure message, which could carry a
    // secret.
    expect(result.container.textContent).not.toContain("the provider rejected the browser code");
  });

  it("returns to its start state on a server timed_out state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "timed_out",
      failure: null,
      expiresAt: null,
    });
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("The login did not finish"),
    );

    expect(result.container.textContent).toContain("The login did not finish");
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);
  });

  it("shows a terminal failure and stops polling on a status 404 from server cleanup", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    // The server removes the row and the in-memory session at once on a
    // non-stored terminal state, so the status route returns 404 when the login
    // fails and the cleanup wins the race against the next poll. The panel must
    // fail loudly instead of holding stale data.
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockRejectedValue(
      new ApiError("Setup-token login session not found.", 404, {
        error: "Setup-token login session not found.",
      }),
    );
    // The prompt route also returns 404, so no authorization URL ever surfaces.
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockRejectedValue(
      new ApiError("Setup-token login session not found.", 404, {
        error: "Setup-token login session not found.",
      }),
    );
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("The login did not finish"),
    );

    // The panel shows the fixed failure message and returns to its start state.
    expect(result.container.textContent).toContain("The login did not finish");
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);

    // The panel shows no credential material: no authorization URL and no
    // browser-code input.
    expect(result.container.textContent).not.toContain("https://claude.example.test/authorize");
    expect(result.container.querySelector('input[aria-label="Browser code"]')).toBeFalsy();

    // The stale polling stopped. The status call count stays fixed after the
    // failure, so the panel does not poll a session the server removed.
    const statusCallsAtFailure = mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await flushReact();
    expect(mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length).toBe(
      statusCallsAtFailure,
    );
  });

  it("cancels an active Claude login and returns to its start state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("https://claude.example.test/authorize"),
    );

    expect(findButton(result.container, "Cancel")).toBeTruthy();

    await clickByText(result.container, "Cancel");
    await flushReact();

    expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
    );
    // The panel resets: the Sign in button is available again, and the URL and the
    // browser-code input are gone.
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);
    expect(findButton(result.container, "Cancel")).toBeFalsy();
    expect(result.container.textContent).not.toContain("https://claude.example.test/authorize");
    expect(result.container.querySelector('input[aria-label="Browser code"]')).toBeFalsy();
  });

  it("treats a 404 cancel the same as success and returns to its start state", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    // The server removes a terminal session, so a cancel of an already-terminal
    // or unknown session can return a 404. The panel must treat that 404 the
    // same as a successful cancel: clear the session and stop the polls.
    mockAgentsApi.cancelClaudeSetupTokenLogin.mockRejectedValue(
      new ApiError("Setup-token login session not found.", 404, {
        error: "Setup-token login session not found.",
      }),
    );
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("https://claude.example.test/authorize"),
    );

    await clickByText(result.container, "Cancel");
    await flushReact();

    expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
    );
    // The panel reset even though the cancel returned a 404: the Sign in button is
    // available again, and the URL and the browser-code input are gone. No error
    // message remains.
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);
    expect(findButton(result.container, "Cancel")).toBeFalsy();
    expect(result.container.textContent).not.toContain("https://claude.example.test/authorize");
    expect(result.container.querySelector('input[aria-label="Browser code"]')).toBeFalsy();
    expect(result.container.textContent).not.toContain("Could not cancel the login.");
  });

  it("cancels the active server session when the panel unmounts", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("https://claude.example.test/authorize"),
    );
    // The login is active before the unmount.
    expect(findButton(result.container, "Cancel")).toBeTruthy();

    await act(async () => {
      result.root.unmount();
    });

    // The unmount released the active server session, so the abandoned session
    // does not hold the per-owner reservation until the server deadline.
    expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
    );
  });

  it("does not cancel on unmount when no login is active", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();

    await runTest(result.container);
    // The panel shows the Sign in button but no session started, so no active
    // session exists to cancel.
    expect(findButton(result.container, "Sign in")).toBeTruthy();

    await act(async () => {
      result.root.unmount();
    });

    expect(mockAgentsApi.cancelClaudeSetupTokenLogin).not.toHaveBeenCalled();
  });

  it("stops both polls and shows the timed-out state at the server deadline", async () => {
    vi.useFakeTimers();
    // Pin the clock to a known base. The panel arms the timed-out timer from the
    // status `expiresAt`, so the test clock and the server deadline share one
    // base time.
    const baseNowMs = 1_700_000_000_000;
    vi.setSystemTime(baseNowMs);
    // The server deadline for this session. It is far longer than the old fixed
    // 60-second cutoff, so the test proves the panel now tracks `expiresAt`.
    const serverDeadlineMs = 5 * 60_000;
    const expiresAtIso = new Date(baseNowMs + serverDeadlineMs).toISOString();
    try {
      mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
      // The status never reaches a terminal state, and the prompt route returns
      // 404 forever, so the authorization URL never surfaces. The status route
      // carries `expiresAt`, which drives the client cutoff. Without the client
      // cap the panel would poll both routes forever.
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        environmentId: "sandbox-1",
        status: "waiting_for_user",
        expiresAt: expiresAtIso,
        failure: null,
      });
      mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockRejectedValue(
        new ApiError("Setup-token login session not found.", 404, {
          error: "Setup-token login session not found.",
        }),
      );

      // Flush React effects and pending promises while the fake clock advances by
      // zero, so the mocked queries settle without real time.
      const flushFake = async () => {
        await act(async () => {
          for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      };
      const clickFake = async (container: HTMLElement, label: string) => {
        const button = findButton(container, label);
        await act(async () => {
          button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushFake();
      };
      const advanceFake = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
        await flushFake();
      };

      mockEnvironmentsApi.list.mockResolvedValue([
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "sandbox-1",
          name: "Daytona",
          driver: "sandbox",
          config: { provider: "daytona" },
        }),
      ]);

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <TooltipProvider>
                <AgentConfigForm
                  mode="edit"
                  agent={makeAgent({
                    adapterType: "claude_local",
                    defaultEnvironmentId: "sandbox-1",
                  })}
                  onSave={vi.fn()}
                  hidePromptTemplate
                  showAdapterTypeField={false}
                  showAdapterTestEnvironmentButton
                />
              </TooltipProvider>
            </ToastProvider>
          </QueryClientProvider>,
        );
      });
      await flushFake();

      await clickFake(container, "Test");
      await clickFake(container, "Sign in");

      // The login is active: both polls have run at least once.
      const statusCallsAtStart = mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length;
      const promptCallsAtStart = mockAgentsApi.getClaudeSetupTokenLoginPrompt.mock.calls.length;
      expect(statusCallsAtStart).toBeGreaterThanOrEqual(1);
      expect(promptCallsAtStart).toBeGreaterThanOrEqual(1);

      // Advance six seconds: both polls run again, so polling is active. The panel
      // has not timed out yet.
      await advanceFake(6_000);
      expect(mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length).toBeGreaterThan(
        statusCallsAtStart,
      );
      expect(mockAgentsApi.getClaudeSetupTokenLoginPrompt.mock.calls.length).toBeGreaterThan(
        promptCallsAtStart,
      );
      expect(container.textContent).not.toContain("The login timed out");

      // Advance past the old fixed sixty-second cutoff. The panel does NOT time
      // out now, because the cutoff comes from the server `expiresAt`, which is
      // far longer than sixty seconds. This proves the fixed 60-second cap is
      // gone.
      await advanceFake(60_000);
      expect(container.textContent).not.toContain("The login timed out");

      // Advance past the server deadline. The panel enters the timed-out state.
      // Total elapsed after this step is 1 second past `serverDeadlineMs`.
      await advanceFake(serverDeadlineMs - 66_000 + 1_000);
      expect(container.textContent).toContain("The login timed out");
      // The panel released the server session when the cutoff fired. The cancel
      // frees the per-owner reservation now, so an immediate retry by the same
      // owner starts a new session and does not hit the "too many active
      // sessions" cap.
      expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledWith(
        "company-1",
        "claude-session-1",
      );
      // The Log in button is available again, and the Cancel button is gone.
      expect(findButton(container, "Sign in")?.disabled).toBe(false);
      expect(findButton(container, "Cancel")).toBeFalsy();

      // Both polls stopped. A further ten seconds adds no new poll call.
      const statusCallsAtTimeout = mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length;
      const promptCallsAtTimeout = mockAgentsApi.getClaudeSetupTokenLoginPrompt.mock.calls.length;
      await advanceFake(10_000);
      expect(mockAgentsApi.getClaudeSetupTokenLoginStatus.mock.calls.length).toBe(
        statusCallsAtTimeout,
      );
      expect(mockAgentsApi.getClaudeSetupTokenLoginPrompt.mock.calls.length).toBe(
        promptCallsAtTimeout,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the authorization URL in a new tab with a safe rel", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      Boolean(
        result.container.querySelector('a[href="https://claude.example.test/authorize"]'),
      ),
    );

    const link = result.container.querySelector(
      'a[href="https://claude.example.test/authorize"]',
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("never renders the OAuth token in the Document Object Model", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    // The mocks add a token field that the real response never carries. The
    // panel must render neither the token nor any other unknown response field.
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
      oauthToken: "sk-ant-SECRET-TOKEN",
    });
    mockAgentsApi.completeClaudeSetupTokenLogin.mockResolvedValue({
      storedSessionId: "stored-session-1",
      oauthToken: "sk-ant-SECRET-TOKEN",
    });
    const result = await renderClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => (result.container.textContent ?? "").includes("Authenticated"));

    expect(result.container.textContent).toContain("Authenticated");
    expect(result.container.textContent).not.toContain("sk-ant-SECRET-TOKEN");
  });
});

const FIXED_CLAUDE_OAUTH_BINDING = {
  type: "user_secret_ref",
  key: "CLAUDE_CODE_OAUTH_TOKEN",
  version: "latest",
  required: true,
};

// Read the merged create-mode values after one or more onChange patches. The
// create form emits a partial patch, so later assertions merge every patch onto
// the seed values, the same way the parent page keeps the controlled state.
function mergedCreateValues(
  seed: Record<string, unknown>,
  onChange: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  return onChange.mock.calls.reduce(
    (acc, [patch]) => ({ ...acc, ...(patch as Record<string, unknown>) }),
    { ...seed },
  );
}

describe("AgentConfigForm create-mode Claude OAuth binding", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
      panelMode: "submitted_browser_code",
      prompt: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({
      authorizationUrl: "https://claude.example.test/authorize",
    });
    mockAgentsApi.completeClaudeSetupTokenLogin.mockResolvedValue({
      storedSessionId: "stored-session-1",
    });
    mockAgentsApi.cancelClaudeSetupTokenLogin.mockResolvedValue(undefined);
    // Default: the owner has no stored Claude login. A test that needs a stored
    // value overrides this with a status body.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
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

  it("adds the fixed CLAUDE_CODE_OAUTH_TOKEN binding after the server stored state", async () => {
    const result = await renderCreateClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      result.onChange.mock.calls.some(
        ([patch]) => (patch as Record<string, unknown>).claudeStoredSessionId,
      ),
    );

    const values = mergedCreateValues(
      { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1", envBindings: {} },
      result.onChange,
    );
    expect(values.claudeStoredSessionId).toBe("stored-session-1");
    const bindings = values.envBindings as Record<string, unknown>;
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN).toEqual(FIXED_CLAUDE_OAUTH_BINDING);
  });

  it("preserves unrelated environment bindings when it adds the fixed binding", async () => {
    const seedBindings = { EXISTING_VAR: { type: "plain", value: "keep-me" } };
    const result = await renderCreateClaudeSandbox({ envBindings: seedBindings });
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      result.onChange.mock.calls.some(
        ([patch]) => (patch as Record<string, unknown>).claudeStoredSessionId,
      ),
    );

    const values = mergedCreateValues(
      { adapterType: "claude_local", envBindings: seedBindings },
      result.onChange,
    );
    const bindings = values.envBindings as Record<string, unknown>;
    expect(bindings.EXISTING_VAR).toEqual({ type: "plain", value: "keep-me" });
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN).toEqual(FIXED_CLAUDE_OAUTH_BINDING);
  });

  it("never puts a token value in the fixed binding", async () => {
    const result = await renderCreateClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      result.onChange.mock.calls.some(
        ([patch]) => (patch as Record<string, unknown>).claudeStoredSessionId,
      ),
    );

    const values = mergedCreateValues(
      { adapterType: "claude_local", envBindings: {} },
      result.onChange,
    );
    const bindings = values.envBindings as Record<string, Record<string, unknown>>;
    // The fixed binding is a reference. It carries no `value` field, so the
    // adapter config never holds the token value.
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN.type).toBe("user_secret_ref");
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN).not.toHaveProperty("value");
    expect(JSON.stringify(values.envBindings)).not.toContain("sk-ant");
  });

  it("returns to the login start state when the server claim write fails", async () => {
    mockAgentsApi.completeClaudeSetupTokenLogin.mockRejectedValue(
      new Error("the provider rejected the stored-session claim"),
    );
    const result = await renderCreateClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() =>
      (result.container.textContent ?? "").includes("The login did not finish"),
    );

    // The panel shows a fixed, non-secret message and returns to its start state.
    expect(result.container.textContent).toContain("The login did not finish");
    expect(findButton(result.container, "Sign in")?.disabled).toBe(false);
    expect(result.container.textContent).not.toContain(
      "the provider rejected the stored-session claim",
    );
    // A failed claim adds no binding and holds no claim.
    expect(
      result.onChange.mock.calls.some(
        ([patch]) => (patch as Record<string, unknown>).claudeStoredSessionId,
      ),
    ).toBe(false);
  });

});

// Render the edit-mode form for an existing Claude agent in a sandbox
// environment. The helper returns the `onSave` spy so a test can read the patch
// that a stored login sends to the agent-update path.
async function renderEditClaudeSandbox(agentOverrides: Partial<Agent> = {}) {
  mockEnvironmentsApi.list.mockResolvedValue([
    makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    makeEnvironment({
      id: "sandbox-1",
      name: "Daytona",
      driver: "sandbox",
      config: { provider: "daytona" },
    }),
  ]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onSave = vi.fn().mockResolvedValue(undefined);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <AgentConfigForm
              mode="edit"
              agent={makeAgent({
                adapterType: "claude_local",
                defaultEnvironmentId: "sandbox-1",
                ...agentOverrides,
              })}
              onSave={onSave}
              hidePromptTemplate
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onSave };
}

describe("AgentConfigForm edit-mode Claude OAuth binding", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
      panelMode: "submitted_browser_code",
      prompt: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({
      authorizationUrl: "https://claude.example.test/authorize",
    });
    mockAgentsApi.completeClaudeSetupTokenLogin.mockResolvedValue({
      storedSessionId: "stored-session-1",
    });
    mockAgentsApi.cancelClaudeSetupTokenLogin.mockResolvedValue(undefined);
    // Default: the owner has no stored Claude login. A test that needs a stored
    // value overrides this with a status body.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
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

  it("adds the fixed CLAUDE_CODE_OAUTH_TOKEN binding to the agent and persists it", async () => {
    const result = await renderEditClaudeSandbox();
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => result.onSave.mock.calls.length > 0);

    // A stored login sends one agent-update patch. The patch replaces the adapter
    // config, and its env holds the fixed binding, so the agent keeps the binding
    // without a manual step.
    const patch = result.onSave.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(patch.replaceAdapterConfig).toBe(true);
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const bindings = adapterConfig.env as Record<string, unknown>;
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN).toEqual(FIXED_CLAUDE_OAUTH_BINDING);
    // The persisted patch never carries a token value.
    expect(JSON.stringify(adapterConfig.env)).not.toContain("sk-ant");
    // An update can never consume the fresh login's stored-session claim -- only
    // create and hire can, per `enforceClaudeOAuthBindingClaim`. So a save that
    // introduces the binding through an update must set `applyStoredClaudeLogin`,
    // or the server rejects the patch with the fixed claim error even though the
    // login already stored the token. Regression coverage for that gap.
    expect(patch.applyStoredClaudeLogin).toBe(true);
  });

  it("keeps every unrelated existing binding when it adds the fixed binding", async () => {
    const result = await renderEditClaudeSandbox({
      adapterConfig: { env: { EXISTING_VAR: { type: "plain", value: "keep-me" } } },
    });
    roots.push(result.root);

    await runTest(result.container);
    await startLogin(result.container);
    await flushUntil(() => result.onSave.mock.calls.length > 0);

    const patch = result.onSave.mock.calls.at(-1)![0] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const bindings = adapterConfig.env as Record<string, unknown>;
    expect(bindings.EXISTING_VAR).toEqual({ type: "plain", value: "keep-me" });
    expect(bindings.CLAUDE_CODE_OAUTH_TOKEN).toEqual(FIXED_CLAUDE_OAUTH_BINDING);
  });

});

describe("AgentConfigForm managed-sandbox-only host surfaces", () => {
  let roots: Root[] = [];

  const MANAGED_AGENT_CONFIG = {
    cwd: "/srv/agents/cody",
    command: "claude",
    engine: "acp",
    agentCommand: "claude-agent-acp",
    stateDir: "/srv/agents/cody/acp-state",
  };

  function setManagedSandboxOnly(enabled: boolean) {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
      enableManagedSandboxOnly: enabled,
    });
  }

  /** Every `Field` renders its label in a `<label>`, so this reads the form. */
  function fieldLabels(container: HTMLElement) {
    return Array.from(container.querySelectorAll("label")).map((label) => label.textContent?.trim() ?? "");
  }

  function choosePathButtons(container: HTMLElement) {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Choose",
    );
  }

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
    setManagedSandboxOnly(false);
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

  it("shows the host path and execution-engine fields when the policy is off", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "claude_local", adapterConfig: MANAGED_AGENT_CONFIG },
    );
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).toContain("Working directory (deprecated)");
    expect(labels).toContain("Command");
    expect(labels).toContain("Execution engine");
    expect(labels).toContain("ACP server command");
    expect(labels).toContain("ACP state directory");
    expect(choosePathButtons(result.container).length).toBeGreaterThan(0);

    const adapterFields = result.container.querySelector('[data-testid="adapter-config-fields"]');
    expect(adapterFields?.getAttribute("data-managed-sandbox-only")).toBe("false");
    expect(adapterFields?.getAttribute("data-hide-instructions-file")).toBe("false");
  });

  it("hides the host path and execution-engine fields for claude_local when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const result = await renderForm(
      [makeEnvironment({ id: "managed-1", name: "Managed", driver: "sandbox", config: { provider: "daytona" } })],
      { adapterType: "claude_local", adapterConfig: MANAGED_AGENT_CONFIG },
    );
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Working directory (deprecated)");
    expect(labels).not.toContain("Command");
    expect(labels).not.toContain("Execution engine");
    expect(labels).not.toContain("ACP server command");
    expect(labels).not.toContain("ACP state directory");
    expect(choosePathButtons(result.container)).toHaveLength(0);
    // The stored values stay untouched: hiding is presentation, and an import
    // that carries adapter configuration from another instance must still save.
    expect(result.container.textContent).not.toContain("/srv/agents/cody");
  });

  it("keeps the non-path ACP controls visible when the policy hides the engine choice", async () => {
    setManagedSandboxOnly(true);
    const result = await renderForm(
      [makeEnvironment({ id: "managed-1", name: "Managed", driver: "sandbox", config: { provider: "daytona" } })],
      { adapterType: "claude_local", adapterConfig: MANAGED_AGENT_CONFIG },
    );
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).toContain("ACP session mode");
    expect(labels).toContain("ACP non-interactive permissions");
  });

  it("keeps the host-path fields hidden while the policy is still loading", async () => {
    // A cold cache resolves the policy to false on the first render. The gate
    // fails closed so a managed instance never flashes a stored host path.
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { adapterType: "claude_local", adapterConfig: MANAGED_AGENT_CONFIG },
    );
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Working directory (deprecated)");
    expect(labels).not.toContain("Command");
    expect(labels).not.toContain("Execution engine");
    expect(choosePathButtons(result.container)).toHaveLength(0);
    expect(result.container.textContent).not.toContain("/srv/agents/cody");
  });

  it("hides the command field and forces the instructions-file gate for codex_local when the policy is on", async () => {
    setManagedSandboxOnly(true);
    const result = await renderForm(
      [makeEnvironment({ id: "managed-1", name: "Managed", driver: "sandbox", config: { provider: "daytona" } })],
      { adapterType: "codex_local", adapterConfig: MANAGED_AGENT_CONFIG },
    );
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Working directory (deprecated)");
    expect(labels).not.toContain("Command");
    expect(choosePathButtons(result.container)).toHaveLength(0);

    const adapterFields = result.container.querySelector('[data-testid="adapter-config-fields"]');
    expect(adapterFields?.getAttribute("data-managed-sandbox-only")).toBe("true");
    expect(adapterFields?.getAttribute("data-hide-instructions-file")).toBe("true");
  });
});
