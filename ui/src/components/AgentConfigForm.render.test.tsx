// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { isBlockedFromReplay } from "@/lib/analytics/replay-recording.test-utils";
import { ApiError } from "../api/client";
import { CodexLocalConfigFields } from "../adapters/codex-local/config-fields";
import type { AdapterConfigFieldsProps } from "../adapters/types";

const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  qualifyRunner: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  probe: vi.fn(),
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

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(async () => [{ type: "codex_local", supportedRunners: ["legacy", "paperclip"], defaultRunner: "legacy" }]),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/grokBot", () => ({
  grokBotApi: { connection: async () => ({ enabled: true, canConfigureConnection: true, binding: null }) },
}));
vi.mock("../api/adapters", () => ({ adaptersApi: mockAdaptersApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "CO" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "CO" },
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
    label: "Codex",
    ConfigFields: (props: AdapterConfigFieldsProps) =>
      type === "paperclip_runner" ? <CodexLocalConfigFields {...props} /> : <div data-testid="adapter-config-fields" />,
    buildAdapterConfig: (values: { model?: string }) => ({ model: values.model || undefined }),
    parseStdoutLine: () => [],
  }),
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
    supportsAcp: true,
    login: { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" },
  }),
}));
vi.mock("../adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => [] }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <textarea aria-label={placeholder ?? "Markdown"} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

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

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: {
    hideInlineSave?: boolean;
    onSaveActionChange?: (save: (() => void) | null) => void;
    hiddenSections?: readonly string[];
    sectionLayout?: "cards" | "panels";
    sectionOrder?: readonly string[];
    sectionTitles?: Record<string, string>;
  } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
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
              agent={makeAgent(agentOverrides)}
              onSave={onSave}
              hidePromptTemplate
              hideInlineSave={options.hideInlineSave}
              onSaveActionChange={options.onSaveActionChange}
              hiddenSections={options.hiddenSections}
              sectionLayout={options.sectionLayout}
              sectionOrder={options.sectionOrder}
              sectionTitles={options.sectionTitles}
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={false}
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onSave };
}

const AUTH_MISSING_RESULT = {
  adapterType: "codex_local",
  status: "fail",
  checks: [{ code: "adapter_auth_missing", level: "error", message: "The sandbox has no ready authentication." }],
  testedAt: new Date(0).toISOString(),
};

const SANDBOX_CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: { daytona: { supportsLoginPty: true, displayName: "Daytona" } },
});

function noActiveSession() {
  return Promise.reject(
    new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }),
  );
}

async function clickByText(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("AgentConfigForm session replay masking", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({ id: "sandbox-1", name: "Daytona", driver: "sandbox", config: { provider: "daytona" } }),
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noActiveSession);
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
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("blocks the displayed login code from session replay", async () => {
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
                agent={makeAgent({ defaultEnvironmentId: "sandbox-1" })}
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
    await flushReact();

    await clickByText(container, "Test");
    await clickByText(container, "Sign in");
    await flushReact();

    expect(isBlockedFromReplay("WXYZ-1234", document.body)).toBe(true);
  });
});

describe("AgentConfigForm Role field", () => {
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
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lets an existing agent's role be changed after creation", async () => {
    let saveAction: (() => void) | null = null;
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      { role: "cfo" },
      {
        hideInlineSave: true,
        hiddenSections: ["identity", "run-policy"],
        sectionLayout: "panels",
        sectionOrder: ["adapter", "configuration", "environment", "environment-variables"],
        sectionTitles: { adapter: "", configuration: "", environment: "" },
        onSaveActionChange: (save) => { saveAction = save; },
      },
    );
    roots.push(result.root);

    expect(result.container.textContent).toContain("CFO");
    const roleButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "CFO",
    );
    expect(roleButton).toBeTruthy();

    await act(async () => {
      roleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const engineerOption = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Engineer",
    );
    expect(engineerOption).toBeTruthy();
    await act(async () => {
      engineerOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(saveAction).toBeTypeOf("function");
    await act(async () => {
      saveAction?.();
    });
    await flushReact();

    expect(result.onSave).toHaveBeenCalledTimes(1);
    expect(result.onSave.mock.calls[0]?.[0]).toMatchObject({ role: "engineer" });
  });
});
