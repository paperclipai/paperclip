// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AdapterTypeDropdown, AgentConfigForm } from "./AgentConfigForm";
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

  it("offers Google Antigravity in the Harness dropdown, displays its logo, exposes Daytona and Unikraft environments, and saves native ACPX config", async () => {
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({ id: "daytona-sbx", name: "Paperclip Sandbox", driver: "sandbox", config: { provider: "daytona" } }),
      makeEnvironment({ id: "daytona-plugin", name: "Paperclip Sandbox (Daytona)", driver: "plugin", config: { pluginKey: "paperclip-cloud.plugin-agent-computer", driverKey: "daytona-tasks" } }),
      makeEnvironment({ id: "unikraft-computer", name: "Paperclip Computer", driver: "plugin", config: { pluginKey: "paperclip-cloud.plugin-agent-computer", driverKey: "tasks" } }),
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
      enableNativeRunner: false,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
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
                agent={makeAgent({ adapterType: "process", adapterConfig: {} })}
                onSave={onSave}
                hidePromptTemplate
                showAdapterTypeField
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const harnessTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Harness"]');
    expect(harnessTrigger).not.toBeNull();
    await act(async () => {
      harnessTrigger!.click();
    });
    await flushReact();

    const antigravityOption = Array.from(document.body.querySelectorAll<HTMLElement>('[data-value="antigravity_runtime"]'))[0];
    expect(antigravityOption).toBeDefined();
    expect(antigravityOption!.textContent).toContain("Google Antigravity");
    expect(antigravityOption!.querySelector('img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();

    await act(async () => {
      antigravityOption!.click();
    });
    await flushReact();

    // Top Harness trigger displays Google Antigravity with its logo, and redundant inner ACP agent dropdown is hidden.
    expect(container.querySelector('button[aria-label="Harness"]')?.textContent).toContain("Google Antigravity");
    expect(container.querySelector('button[aria-label="Harness"] img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="ACP agent"]')).toBeNull();

    // Both Daytona sandbox/plugin and Unikraft Paperclip Computer environments are selectable.
    const envTrigger = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Default: Local"),
    );
    expect(envTrigger).toBeDefined();
    await act(async () => {
      envTrigger!.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("Paperclip Sandbox");
    expect(document.body.textContent).toContain("Paperclip Sandbox (Daytona)");
    expect(document.body.textContent).toContain("Paperclip Computer");

    await clickByText(container, "Save");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      adapterType: "paperclip_runner",
      replaceAdapterConfig: true,
      adapterConfig: expect.objectContaining({
        provider: "acpx",
        acpxAgent: "antigravity",
        lifecycleMode: "per_turn",
      }),
    }));
  });

  it("displays an existing Antigravity paperclip_runner agent as Google Antigravity without exposing internal runner harness pickers", async () => {
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
                  adapterType: "paperclip_runner",
                  adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-low", lifecycleMode: "per_turn" },
                })}
                onSave={vi.fn()}
                hidePromptTemplate
                showAdapterTypeField
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('button[aria-label="Harness"]')?.textContent).toContain("Google Antigravity");
    expect(container.querySelector('button[aria-label="Harness"] img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="ACP agent"]')).toBeNull();
  });

  it("displays an existing Copilot paperclip_runner agent as GitHub Copilot and keeps its saved model on re-selection", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
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
                  adapterType: "paperclip_runner",
                  adapterConfig: { provider: "acpx", acpxAgent: "copilot", model: "gpt-5.4", lifecycleMode: "per_turn" },
                })}
                onSave={onSave}
                hidePromptTemplate
                showAdapterTypeField
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const harnessTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Harness"]');
    expect(harnessTrigger?.textContent).toContain("GitHub Copilot");
    expect(harnessTrigger?.querySelector('img[src="/brands/apps/github-copilot.svg"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="ACP agent"]')).toBeNull();
    expect(container.textContent).toContain("gpt-5.4");

    await act(async () => {
      harnessTrigger!.click();
    });
    await flushReact();
    const copilotOption = document.body.querySelector<HTMLElement>('[data-value="copilot_runtime"]');
    expect(copilotOption).not.toBeNull();
    await act(async () => {
      copilotOption!.click();
    });
    await flushReact();

    // Re-selecting the active Copilot harness is a no-op and preserves the saved model.
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).not.toContain("Unsaved changes");
  });

  it("keeps native ACPX harnesses opt-in on AdapterTypeDropdown so raw adapter callers never offer them", async () => {
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
          <AdapterTypeDropdown value="codex_local" onChange={vi.fn()} disabledTypes={new Set()} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Harness"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.click();
    });
    await flushReact();

    expect(document.body.querySelector('[data-value="antigravity_runtime"]')).toBeNull();
    expect(document.body.querySelector('[data-value="copilot_runtime"]')).toBeNull();
  });
});

describe("AgentConfigForm timer active hours", () => {
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
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noActiveSession);
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

  it("hides the active-hours control when interval heartbeats are off", async () => {
    const created = await renderCreateForm([]);
    roots.push(created.root);
    expect(created.container.textContent).not.toContain("Limit timer heartbeats to active hours");
    expect(created.container.querySelector('[aria-label="Timezone"]')).toBeNull();

    const edited = await renderForm([], {
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 300 } },
    });
    roots.push(edited.root);
    expect(edited.container.textContent).not.toContain("Limit timer heartbeats to active hours");
    expect(edited.container.querySelector('[aria-label="Timezone"]')).toBeNull();
  });

  it("shows the active-hours control when interval heartbeats are on", async () => {
    const created = await renderCreateForm([], { heartbeatEnabled: true });
    roots.push(created.root);
    expect(created.container.textContent).toContain("Limit timer heartbeats to active hours");
    expect(created.container.querySelector('[aria-label="Timezone"]')).toBeNull();

    const edited = await renderForm([], {
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
    });
    roots.push(edited.root);
    expect(edited.container.textContent).toContain("Limit timer heartbeats to active hours");
    expect(edited.container.querySelector('[aria-label="Timezone"]')).toBeNull();
  });

  it("labels the timezone field when a window is set", async () => {
    const window = { start: "09:00", end: "18:00", timezone: "America/New_York" };
    const created = await renderCreateForm([], {
      heartbeatEnabled: true,
      activeHours: window,
    });
    roots.push(created.root);
    const createTimezone = created.container.querySelector('[aria-label="Timezone"]');
    expect(createTimezone).not.toBeNull();
    expect(created.container.textContent).toContain("Timezone");

    const edited = await renderForm([], {
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, activeHours: window } },
    });
    roots.push(edited.root);
    const editTimezone = edited.container.querySelector('[aria-label="Timezone"]');
    expect(editTimezone).not.toBeNull();
    expect(edited.container.textContent).toContain("Timezone");
    expect((editTimezone as HTMLInputElement).value).toBe("America/New_York");
  });
});
