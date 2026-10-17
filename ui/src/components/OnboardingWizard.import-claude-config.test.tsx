// @vitest-environment jsdom

/**
 * The import credential mode of the connect step: reading the operator's own
 * `~/.claude/settings.json`, confirming it, and hiring against the connection it
 * makes. The shared credential step is covered by `AiConnectionField.test.tsx`
 * and `AgentProviderConnection.test.tsx`; this is the surface that builds the
 * step itself.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const localHealth = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi: localHealth }));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  readLocalClaudeConfig: vi.fn(),
  importLocalClaudeConfig: vi.fn(),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: mockAuthApi.getSession } };
});

const mockDialog = vi.hoisted(() => ({
  onboardingOpen: true,
  onboardingOptions: {} as { initialStep?: number; companyId?: string },
  closeOnboarding: vi.fn(),
  onboardingRouteDismissed: false,
  setOnboardingRouteDismissed: vi.fn(),
}));
const mockCompany = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string; issuePrefix: string }>,
  setSelectedCompanyId: vi.fn(),
  loading: false,
  error: null as Error | null,
}));
const mockCompaniesApi = vi.hoisted(() => ({
  detachInflightList: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(async () => []) }));
const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(async () => [] as Array<{ id: string; label: string }>),
  testEnvironment: vi.fn(),
  hire: vi.fn(),
  list: vi.fn(async () => [] as Array<{ id: string; name: string; adapterType: string }>),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
  getClaudeOAuthTokenStatus: vi.fn(),
  getAdapterAuthSignal: vi.fn(async () => ({ status: "present" })),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
}));
const mockAdapterBuild = vi.hoisted(() => ({
  buildAdapterConfig: vi.fn(() => ({}) as Record<string, unknown>),
}));
const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(async () => [] as Array<Record<string, unknown>>),
  capabilities: vi.fn(async () => ({ sandboxProviders: {} })),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null as string | null })),
  getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  listMyUserSecrets: vi.fn(async () => []),
  removeUserSecretDefinition: vi.fn(async () => ({ ok: true })),
  createUserSecretDefinition: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const mockApprovalsApi = vi.hoisted(() => ({ create: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ create: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(async () => []) }));
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string }>,
  disabled: new Set<string>(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock("../context/DialogContext", () => ({ useDialog: () => mockDialog }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => mockCompany }));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../adapters", () => ({
  listUIAdapters: () => mockAdapterRegistry.list,
  getUIAdapter: () => ({ buildAdapterConfig: mockAdapterBuild.buildAdapterConfig }),
}));
vi.mock("../adapters/metadata", () => ({ isVisualAdapterChoice: () => true }));
vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (type: string) => ({
    type,
    recommended: type === "claude_local" || type === "codex_local",
    label: type,
    description: "",
    icon: () => null,
  }),
  getAdapterLabel: (type: string) => type,
  getAdapterLabels: () => ({}) as Record<string, string>,
  isKnownAdapterType: () => true,
}));
vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => mockAdapterRegistry.disabled,
  useAdapterRegistryLoaded: () => true,
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (type: string) => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
    login: type === "claude_local" ? { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" as const } : undefined,
  }),
}));
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { ApiError } from "../api/client";
import { UNREACHABLE_ENVIRONMENT_422 } from "./ai-connections/import-claude-config-fixtures";
import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_USER_ID = "user-b";

/** What a locally trusted instance's health answers (PRODUCT #4). */
const LOCAL_TRUSTED_HEALTH = {
  status: "ok" as const,
  deploymentMode: "local_trusted" as const,
  localAiLoginSupported: true,
};

/** The one gateway this suite reads out of the operator's settings file. */
const GATEWAY = "https://gateway.example.test/v1";
const MASKED_KEY = "sk-ant-…3f9a";

function readResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    baseUrl: GATEWAY,
    keyVariable: "ANTHROPIC_API_KEY",
    maskedKey: MASKED_KEY,
    models: {
      default: "claude-opus-4-6",
      alternatives: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    },
    suggestedName: "Imported from Claude config",
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await flushReact();
}

function buttons() {
  return [...document.body.querySelectorAll("button")];
}

/**
 * The tiles' credential tag — "ClaudeSubscription", "ClaudeAPI", "ClaudeImport".
 *
 * Read rather than the mode link's sentence: the tag is the steady state, while
 * the link's label cross-fades and holds both sentences for the length of the
 * swap.
 */
function credentialTag() {
  return document.body.querySelector('[role="radio"]')?.textContent ?? "";
}

async function press(text: string | RegExp) {
  const button = buttons().find((b) =>
    typeof text === "string" ? (b.textContent ?? "").trim() === text : text.test(b.textContent ?? ""),
  );
  expect(button, `no button reading ${String(text)}`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function renderWizard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["auth", "session"], {
    session: { id: "session-b", userId: SESSION_USER_ID },
    user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
  });
  return { root, queryClient };
}

/** Land on the connect step, with a company and an adapter already in hand. */
async function openStep4(overrides: Record<string, unknown> = {}) {
  mockCompany.companies = [{ id: "company-new", name: "Initech", issuePrefix: "INI" }];
  mockCompany.loading = false;
  mockCompaniesApi.list.mockResolvedValue(mockCompany.companies);
  window.localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      step: 4,
      companyName: "Initech",
      agentName: "Ada",
      createdCompanyId: "company-new",
      adapterType: "claude_local",
      ...overrides,
    }),
  );
  mockDialog.onboardingOptions = {};
  const { root, queryClient } = renderWizard();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OnboardingWizard />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(document.body.textContent).toContain("Connect a model");
  return { root, queryClient };
}

/** Pick the Claude tile, which is what opens the card under the row. */
async function pickClaudeSource() {
  await press(/Claude/);
  await settle();
}

/** Walk the mode link until the tiles' tags read Import. */
async function switchToImportMode() {
  expect(credentialTag()).toContain("Subscription");
  // The link names its destination, so the walk is read off what it says rather
  // than counted — it is the same two presses however the ring is built.
  await press(/Use API key instead/);
  expect(credentialTag()).toContain("API");
  await press(/Use import from Claude config instead/);
  expect(credentialTag()).toContain("Import");
}

/**
 * Choose one of the card's listed models.
 *
 * The list is Radix's, and in this environment it opens on the trigger's arrow key
 * and closes on a press of the option.
 */
function pickModel(label: string) {
  const trigger = document.body.querySelector('[aria-label="Model"]') as HTMLElement | null;
  expect(trigger, "the card's model row").toBeTruthy();
  act(() => {
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const option = [...document.body.querySelectorAll('[role="option"]')].find(
    (node) => node.textContent === label,
  );
  expect(option, `no model option reading ${label}`).toBeTruthy();
  act(() => {
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("onboarding: importing the local Claude config", () => {
  beforeEach(() => {
    localHealth.get.mockResolvedValue(LOCAL_TRUSTED_HEALTH);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-b", userId: SESSION_USER_ID },
      user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
    });
    managedApi.readLocalClaudeConfig.mockReset();
    managedApi.readLocalClaudeConfig.mockResolvedValue(readResult());
    managedApi.importLocalClaudeConfig.mockReset();
    managedApi.importLocalClaudeConfig.mockResolvedValue({
      connectionId: "imported-connection",
      grantId: "imported-grant",
    });
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [] });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
    mockSecretsApi.removeUserSecretDefinition.mockResolvedValue({ ok: true });
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockDialog.onboardingRouteDismissed = false;
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockCompany.error = null;
    mockCompaniesApi.list.mockResolvedValue([]);
    mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdapterBuild.buildAdapterConfig.mockReset();
    mockAdapterBuild.buildAdapterConfig.mockReturnValue({});
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockAgentsApi.getClaudeOAuthTokenStatus.mockRejectedValue(new ApiError("Not found", 404, null));
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockRejectedValue(new ApiError("Not found", 404, null));
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(new ApiError("Not found", 404, null));
    mockAgentsApi.testEnvironment.mockReset();
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    mockAgentsApi.hire.mockReset();
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
    mockAgentsApi.list.mockResolvedValue([]);
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("offers the import mode for a Claude adapter on a locally trusted instance, and reads on entering it", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    // The read goes out on entering the mode, before anything is confirmed
    // (PRODUCT #9) — not on page load, and not on the Import press.
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledTimes(1);
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("company-new");
    await pickClaudeSource();
    expect(document.body.textContent).toContain(GATEWAY);
    await act(async () => { root.unmount(); });
  });

  it("keeps the two-mode switch on an instance that cannot read local credentials", async () => {
    localHealth.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      localAiLoginSupported: false,
    });
    const { root } = await openStep4();
    // The link says the same two things it always did, so a customer who cannot
    // use the import mode is never offered it (PRODUCT #4, #49).
    expect(credentialTag()).toContain("Subscription");
    await press(/Use API key instead/);
    expect(credentialTag()).toContain("API");
    await press(/Use API key instead/);
    expect(credentialTag()).toContain("Subscription");
    expect(credentialTag()).not.toContain("Import");
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("does not offer the import mode for a non-Claude adapter", async () => {
    const { root } = await openStep4({ adapterType: "codex_local" });
    expect(credentialTag()).toContain("Subscription");
    await press(/Use API key instead/);
    expect(credentialTag()).toContain("API");
    await press(/Use API key instead/);
    expect(credentialTag()).toContain("Subscription");
    expect(credentialTag()).not.toContain("Import");
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("shows the gateway in plain and the key only masked, with the variable it came from", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    const card = document.body.textContent ?? "";
    // The address is the thing being confirmed, so it is shown as it is
    // (PRODUCT #17). The key never is (PRODUCT #41) — not here, not in a
    // request, and the read did not even return it.
    expect(card).toContain(GATEWAY);
    expect(card).toContain(`ANTHROPIC_API_KEY · ${MASKED_KEY}`);
    expect(card).not.toContain("sk-ant-api-1234567890");
    // The folded default leads the model list, and the rest of the ladder is
    // offered beside it (PRODUCT #12, #19).
    const model = document.body.querySelector('[aria-label="Model"]') as HTMLElement | null;
    expect(model?.textContent).toContain("claude-opus-4-6");
    // The name is editable and starts from the suggested one.
    const name = document.body.querySelector('[aria-label="Connection name"]') as HTMLInputElement | null;
    expect(name?.value).toBe("Imported from Claude config");
    await act(async () => { root.unmount(); });
  });

  it("names the missing variable and the file when the gateway is not configured", async () => {
    managedApi.readLocalClaudeConfig.mockResolvedValue({
      status: "unavailable",
      reason: "base_url_missing",
      message: "No gateway is configured on this machine.",
    });
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    const card = document.body.textContent ?? "";
    expect(card).toContain("No gateway is configured on this machine.");
    // The hint is the actionable half: which variable, in which file (PRODUCT #14).
    expect(card).toContain("ANTHROPIC_BASE_URL");
    expect(card).toContain("~/.claude/settings.json");
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    // The failure is announced, not just drawn.
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("No gateway");
    await act(async () => { root.unmount(); });
  });

  it("shows only the server's answer when it refuses the read", async () => {
    // The operator gate is enforced server-side (PRODUCT #49); when it answers,
    // its message is the whole story and a hint about the settings file would be
    // inventing a cause.
    managedApi.readLocalClaudeConfig.mockRejectedValue(
      new ApiError("Only the local operator can read this machine's config.", 403, null),
    );
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    const card = document.body.textContent ?? "";
    expect(card).toContain("Only the local operator can read this machine's config.");
    expect(card).not.toContain("ANTHROPIC_BASE_URL");
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("imports the confirmed snapshot and hires against the connection it made", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    const name = document.body.querySelector('[aria-label="Connection name"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Northwind gateway");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Import");
    // The import carries the summary the customer confirmed and nothing else —
    // no key, no endpoint of the client's invention (PRODUCT #8, #41).
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1);
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledWith("company-new", {
      provider: "anthropic",
      method: "api_key",
      name: "Northwind gateway",
      ownership: "personal",
      agentIds: [],
      allAgents: true,
      baseUrl: GATEWAY,
      keyVariable: "ANTHROPIC_API_KEY",
      // The model the card holds, which is the one the agent is about to run on.
      model: "claude-opus-4-6",
      confirm: {
        keyVariable: "ANTHROPIC_API_KEY",
        maskedKey: MASKED_KEY,
        defaultModel: "claude-opus-4-6",
        alternativeModels: ["claude-sonnet-4-6", "claude-haiku-4-5"],
      },
    });
    // The step now advances the way the API-key mode does: the probe and the hire
    // both name the connection (PRODUCT #24, #27).
    await press("Connect");
    await settle();
    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledWith(
      "company-new",
      "claude_local",
      expect.objectContaining({
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
      }),
    );
    expect(mockAgentsApi.hire).toHaveBeenCalledWith(
      "company-new",
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        }),
      }),
    );
    // The folded default is the model the agent runs on. The adapter builds its
    // own configuration, so this is where the model has to land.
    expect(mockAdapterBuild.buildAdapterConfig).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "claude_local", model: "claude-opus-4-6" }),
    );
    await act(async () => { root.unmount(); });
  });

  it("runs the model the card was changed to, not the tier the read folded", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    pickModel("claude-sonnet-4-6");
    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("claude-sonnet-4-6");
    await press("Import");
    // The choice travels with the import, and it is the one this agent is hired on:
    // the connection keeps the whole ladder for later.
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledWith(
      "company-new",
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
    await press("Connect");
    await settle();
    expect(mockAdapterBuild.buildAdapterConfig).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "claude_local", model: "claude-sonnet-4-6" }),
    );
    await act(async () => { root.unmount(); });
  });

  it("keeps Cancel live on the card while the probe runs", async () => {
    managedApi.importLocalClaudeConfig.mockReturnValue(new Promise(() => {}));
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    await act(async () => {
      buttons().find((b) => (b.textContent ?? "").trim() === "Import")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    // The button reports the wait and refuses a second press (PRODUCT #22)...
    expect(buttons().find((b) => (b.textContent ?? "").trim() === "Importing…")?.disabled).toBe(true);
    // ...while Cancel stays live: the probe writes nothing when it fails, so a
    // customer who has changed their mind only ever abandons their own state.
    const cancel = buttons().find((b) => (b.textContent ?? "").trim() === "Cancel")!;
    expect(cancel.disabled).toBe(false);
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).toContain("Connect a model");
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("keeps the card and says which variable to re-check when the gateway rejects the key", async () => {
    managedApi.importLocalClaudeConfig.mockRejectedValue(new ApiError("Gateway rejected the key", 401, null));
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    await press("Import");
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("rejected this key");
    // Both variables authenticate differently, so the wrong one reads as a
    // rejected key — and the fix is in the file the import read (PRODUCT #25).
    expect(alert?.textContent).toContain("ANTHROPIC_API_KEY");
    expect(alert?.textContent).toContain("ANTHROPIC_AUTH_TOKEN");
    // Nothing was built, and the snapshot is still on screen to retry with.
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(GATEWAY);
    await act(async () => { root.unmount(); });
  });

  it("keeps the card and repeats the server's own answer when the import is refused", async () => {
    // A 422 is the server refusing for a reason of its own — here an execution
    // environment that cannot reach the gateway — so its sentence is the copy
    // rather than the gateway's (PRODUCT #25, #51).
    const { root } = await openStep4();
    managedApi.importLocalClaudeConfig.mockRejectedValue(
      new ApiError(UNREACHABLE_ENVIRONMENT_422.message, UNREACHABLE_ENVIRONMENT_422.status, null),
    );
    await switchToImportMode();
    await pickClaudeSource();
    await press("Import");
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(UNREACHABLE_ENVIRONMENT_422.message);
    // Nothing was built, and the snapshot is still on screen to retry with.
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(GATEWAY);
    await press("Import");
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("abandons a read that is still running and builds nothing", async () => {
    let finish!: (result: Record<string, unknown>) => void;
    const { root } = await openStep4();
    managedApi.readLocalClaudeConfig.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await switchToImportMode();
    // The read went out on entering the mode; the tile press is what opens the
    // card that will hold its answer.
    await pickClaudeSource();
    // The card reports the wait (PRODUCT #13, #47) and the step's own button has
    // nothing to press until the read has answered.
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="status"]')?.textContent).toContain("Reading this machine"),
    );
    expect(buttons().find((b) => (b.textContent ?? "").trim() === "Connect")?.disabled).toBe(true);
    // Back is the way out while the read is out: it unwinds the step back to the
    // mode question it came from, whose button is the chooser's. Still this step,
    // not the one before it.
    await press("Back");
    await settle();
    expect(document.body.textContent).toContain("Connect a model");
    expect(buttons().some((b) => (b.textContent ?? "").trim() === "Next")).toBe(true);
    // The read that answers after the reader has gone produces no card, no
    // connection and no second wait.
    finish(readResult());
    await settle();
    expect(document.body.textContent).not.toContain(GATEWAY);
    expect(document.body.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Reading this machine");
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("hires nothing while the import is still unconfirmed", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    // The footer's Connect is the same control it is in the API-key mode, and it
    // has nothing to do until the card has produced a connection.
    expect(buttons().find((b) => (b.textContent ?? "").trim() === "Connect")?.disabled).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it("closes the card on Escape, and closing it is cancelling it", async () => {
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    // Back on the chooser, with nothing read into a card and nothing created
    // (PRODUCT #48, #13).
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    const link = buttons().find((b) => /Use (API key|subscription|import)/.test(b.textContent ?? ""));
    expect(link).toBeTruthy();
    // Focus goes back to the switch that opened the card, and only once the row has
    // reopened to hold it — earlier than that the link is clipped out of the
    // document (PRODUCT #48).
    await vi.waitFor(() => expect(document.activeElement).toBe(link));
    // Entering the mode again reads again: the file is the only source and it may
    // have been edited since the last look (PRODUCT #9).
    await pickClaudeSource();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); });
  });

  it("takes one press at a time while the probe is running", async () => {
    let finish!: (result: { connectionId: string; grantId: string }) => void;
    managedApi.importLocalClaudeConfig.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { root } = await openStep4();
    await switchToImportMode();
    await pickClaudeSource();
    await act(async () => {
      const importButton = buttons().find((b) => (b.textContent ?? "").trim() === "Import")!;
      importButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    // The button reports the wait and refuses a second press, because two
    // submissions would either race the probe or build the connection twice
    // (PRODUCT #22).
    const pending = buttons().find((b) => (b.textContent ?? "").trim() === "Importing…");
    expect(pending?.disabled).toBe(true);
    await act(async () => {
      pending?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    await act(async () => {
      finish({ connectionId: "imported-connection", grantId: "imported-grant" });
    });
    await settle();
    // Nothing was hired by the import itself: the step's own button still owns
    // the hire, the way it does for a typed key (PRODUCT #24).
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
