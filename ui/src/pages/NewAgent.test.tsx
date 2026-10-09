// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { NewAgent } from "./NewAgent";
import { ApiError } from "@/api/client";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  getAdapterAuthSignal: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));
const envApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
const settings = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));
const secrets = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  listMyUserSecrets: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
}));
const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  adapters: [] as object[],
  navigate: vi.fn(),
  openNewIssue: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", canManageConnections: true, connections: [] })),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
  setDefault: vi.fn(async () => ({})),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/api/environments", () => ({ environmentsApi: envApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: settings }));
vi.mock("@/api/secrets", () => ({ secretsApi: secrets }));
vi.mock("@/api/adapters", () => ({
  adaptersApi: { list: async () => state.adapters },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: state.openNewIssue }),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [state.params],
}));
// Exercise API/persistence contracts with deterministic presentation primitives.
// The actual searchable dropdown and login panel are covered by their tests and browser verification.
vi.mock("@/components/AgentConfigForm", () => ({
  ModelDropdown: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="Model"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  AdapterLoginPanel: ({ onConnected }: { onConnected: (id: string) => void }) => (
    <button onClick={() => onConnected("login-session")}>
      Complete subscription login
    </button>
  ),
}));
vi.mock("@/components/onboarding/PillGuy", () => ({ PillGuy: () => null }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: any) => children,
  MotionConfig: ({ children }: any) => children,
  motion: {
    span: ({ children }: any) => <span>{children}</span>,
    div: ({ children, initial, animate, exit, transition, ...rest }: any) => (
      <div {...rest}>{children}</div>
    ),
  },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `Missing button ${text}`).toBeTruthy();
  await act(async () => button!.click());
  await settle();
}
async function fill(label: string, value: string) {
  const input = container.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(adapter = "pi_local", runnerProvider = "codex") {
  state.params = new URLSearchParams({
    name: "Atlas",
    adapterType: adapter,
    runnerProvider,
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <TooltipProvider><NewAgent /></TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}
async function connect(provider: string) {
  await click(provider + "Subscription");
  await click("Connect");
}
const pass = {
  adapterType: "pi_local",
  status: "pass",
  checks: [
    { code: "hello_probe_passed", level: "info", message: "Model replied" },
  ],
  testedAt: "2026-09-07T00:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  managedApi.setDefault.mockResolvedValue({});
  managedApi.list.mockResolvedValue({ currentUserId: "user-1", canManageConnections: true, connections: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  state.adapters = [
    "claude_local",
    "codex_local",
    "opencode_local",
    "pi_local",
    "paperclip_runner", "cursor_cloud", "cursor", "gemini_local", "kimi_local", "grok_local", "hermes_local", "hermes_gateway",
  ].map((type) => ({ type, loaded: true, disabled: false }));
  api.adapterModels.mockResolvedValue([]);
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.getClaudeOAuthTokenStatus.mockRejectedValue(new ApiError("Not found", 404, null));
  api.testEnvironment.mockResolvedValue(pass);
  api.hire.mockImplementation(async (_company, input) => ({
    agent: { ...input, id: "new-agent", status: "idle", urlKey: "atlas" },
  }));
  envApi.list.mockResolvedValue([
    { id: "local-1", name: "Local", driver: "local", config: {} },
  ]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "local-1" });
  settings.getExperimental.mockResolvedValue({ enableNativeRunner: true });
  settings.getGeneral.mockResolvedValue({ executionMode: "any" });
  secrets.list.mockResolvedValue([]);
  secrets.create.mockResolvedValue({ id: "org-secret-1" });
  secrets.remove.mockResolvedValue({ ok: true });
  secrets.listMyUserSecrets.mockResolvedValue([]);
  secrets.createUserSecretDefinition.mockResolvedValue({ id: "definition-1" });
  secrets.createMyUserSecret.mockResolvedValue({ id: "secret-1" });
  secrets.removeUserSecretDefinition.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});
describe("New agent setup", () => {
  it("refuses an undiscovered Copilot model before hiring with a saved connection", async () => {
    api.adapterModels.mockResolvedValue([{ id: "gpt-5.6-luna", label: "GPT" }]);
    await render("paperclip_runner", "copilot");
    await fill("Model", "unavailable-copilot-model");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("select an available model");
  });
  it("preserves the authenticated Copilot model when hiring with a saved connection", async () => {
    api.adapterModels.mockResolvedValue([{ id: "gpt-5.6-luna", label: "GPT" }]);
    await render("paperclip_runner", "copilot");
    await fill("Model", "gpt-5.6-luna");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterType: "paperclip_runner", adapterConfig: expect.objectContaining({ provider: "acpx", acpxAgent: "copilot", model: "gpt-5.6-luna" }),
      runtimeConfig: expect.objectContaining({ aiConnection: { provider: "github", method: "api_key", mode: "responsible_user" } }),
    }));
  });
  it("discovers models after the first Copilot token becomes the responsible user's default", async () => {
    let defaultSaved = false;
    managedApi.setDefault.mockImplementation(async () => { defaultSaved = true; return {}; });
    api.adapterModels.mockImplementation(async () => {
      if (!defaultSaved) throw new ApiError("Connect Copilot first", 422, null);
      return [{ id: "gpt-5.6-luna", label: "GPT" }];
    });
    await render("paperclip_runner", "copilot");
    const beforeConnection = api.adapterModels.mock.calls.length;
    expect(beforeConnection).toBeGreaterThan(0);
    const trigger = document.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("Connect an account"));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await settle();
    const input = document.querySelector<HTMLInputElement>('[aria-label="API key"]')!;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "github_pat_fixture_first");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.trim() === "Connect")!;
    expect(save).toBeTruthy();
    await act(async () => save.click());
    await settle();
    expect(managedApi.setDefault).toHaveBeenCalledWith("company-1", "managed-grant");
    expect(api.adapterModels).toHaveBeenCalledTimes(beforeConnection + 1);
    expect(api.adapterModels.mock.invocationCallOrder[beforeConnection]).toBeGreaterThan(managedApi.setDefault.mock.invocationCallOrder[0]);
    expect(api.adapterModels).toHaveBeenLastCalledWith("company-1", "paperclip_runner", expect.objectContaining({
      provider: "acpx", acpxAgent: "copilot", aiConnection: { provider: "github", method: "api_key", mode: "responsible_user" },
    }));
  });

  it("creates Dot through its independent choice without CLI or model setup, then routes to pairing", async () => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: true, enablePublicMcp: true });
    await render("paperclip_runner", "openai_dot");
    expect(container.textContent).toContain("OpenAI Dot");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.textContent).not.toContain("Connect a model");
    expect(container.textContent).toContain("Check prerequisites");
    expect(container.textContent).not.toContain("runtime and model can respond");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Acknowledge external provider billing");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "openai_dot", lifecycleMode: "per_turn", allowUnmeteredProvider: true, dotWorkspaceAccess: false, dotAttachmentAccess: false,
    } }));
    expect(container.textContent).toContain("Your Dot agent has been created");
    await click("Pair Dot");
    expect(state.navigate).toHaveBeenLastCalledWith("/agents/atlas/runtime");
    expect(state.openNewIssue).not.toHaveBeenCalled();
  });

  it.each(["claude_local", "codex_local"])("can choose a sign-in environment in Configure before connecting %s", async (adapterType) => {
    settings.get.mockResolvedValue({ defaultEnvironmentId: "no-login" });
    envApi.list.mockResolvedValue([
      { id: "no-login", name: "No browser sign-in", status: "active", driver: "sandbox", config: { provider: "other" } },
      { id: "login-env", name: "Browser sign-in", status: "active", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({ sandboxProviders: { daytona: { supportsLoginPty: true } } });
    api.getAdapterAuthSignal.mockResolvedValue({ status: "missing" });
    await render(adapterType);
    expect(container.textContent).toContain("does not support browser sign-in");
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("2Configure");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect([...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Run test")?.disabled).toBe(true);
    await click("Connect model");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    await click("2Configure");
    const select = container.querySelector('select[aria-label="Environment"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "login-env";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("Complete subscription login");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toMatchObject({ defaultEnvironmentId: "login-env", runtimeConfig: { aiConnection: { method: "subscription" } } });
  });
  it("waits for the resolved environment before allowing a credential-mode selection", async () => {
    let resolveEnvironments!: (value: object[]) => void;
    envApi.list.mockImplementationOnce(() => new Promise<object[]>(resolve => { resolveEnvironments = resolve; }));
    await render("codex_local");
    expect(container.textContent).toContain("Loading connection settings");
    expect(container.querySelector('[role="radiogroup"][aria-label="Connection type"]')).toBeNull();
    await act(async () => resolveEnvironments([{ id: "local-1", name: "Local", driver: "local", config: {} }]));
    await settle();
    await click("OpenAIAPI key");
    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull();
    await settle();
    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull();
  });
  it.each([false, true])("selects the Grok environment in Configure (managed-only=%s)", async (managedOnly) => {
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableManagedSandboxOnly: managedOnly });
    envApi.list.mockResolvedValue([
      { id: "local-1", name: "Local", status: "active", driver: "local", config: {} },
      { id: "grok-sandbox", name: "Grok sandbox", status: "active", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    secrets.listMyUserSecrets.mockResolvedValue([{
      definition: { id: "grok-key", companyId: "company-1", key: "XAI_API_KEY", name: "Grok key", status: "active" },
      secret: { companyId: "company-1", status: "active" },
    }]);
    await render("paperclip_runner", "grok");
    expect(container.querySelector('select[aria-label="Environment"]')).toBeNull();
    await click("GrokAPI key");
    await click("Use saved API key");
    const select = container.querySelector('select[aria-label="Environment"]') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].some((option) => option.value === "local-1")).toBe(!managedOnly);
    await act(async () => {
      select.value = "grok-sandbox";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    if (container.querySelector('[role="radiogroup"][aria-label="Connection type"]')) {
      await click("GrokAPI key");
      await click("Use saved API key");
    }
    expect(api.testEnvironment).toHaveBeenCalledWith("company-1", "paperclip_runner", expect.objectContaining({ environmentId: "grok-sandbox" }));
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].defaultEnvironmentId).toBe("grok-sandbox");
  });
  it.each([false, true])("blocks direct runner setup links when the experiment is disabled (cloud=%s)", async (cloud) => {
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: cloud } });
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    await render("paperclip_runner");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("blocks direct setup links for unsupported Cloud adapters", async () => {
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    await render("pi_local");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it.each([
    ["grok_local", "subscription"], ["grok_local", "api_key"],
    ["paperclip_runner", "subscription"], ["paperclip_runner", "api_key"],
  ])("configures %s Grok on Cloud with an xAI %s connection", async (adapterType, method) => {
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    envApi.list.mockResolvedValue([
      { id: "sandbox-1", name: "Paperclip Cloud", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({
      sandboxProviders: { daytona: { supportsLoginPty: true } },
    });
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    settings.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true, enableNativeRunner: true });
    api.getAdapterAuthSignal.mockResolvedValue({ status: "missing" });
    api.testEnvironment.mockResolvedValue({ ...pass, adapterType });
    await render(adapterType, "grok");
    expect(container.textContent).toContain("Connect a model");
    expect(container.textContent).not.toContain("Connect Atlas to Grok");
    if (method === "subscription") {
      await click("GrokSubscription");
      await click("Complete subscription login");
    } else {
      await click("GrokAPI key");
      await fill("API key", "example-test-secret");
      await click("Connect");
      expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
        provider: "xai", method: "api_key", apiKey: "example-test-secret",
      }));
    }
    const model = adapterType === "paperclip_runner" ? "grok-4.7" : "grok-code-fast-1";
    await fill("Model", model);
    await click("Run test");
    const binding = { provider: "xai", method, mode: "responsible_user" };
    expect(api.testEnvironment).toHaveBeenLastCalledWith("company-1", adapterType, expect.objectContaining({
      environmentId: "sandbox-1",
      adapterConfig: expect.objectContaining({ model, ...(adapterType === "paperclip_runner" ? { provider: "acpx", acpxAgent: "grok", acpxPermissionMode: "approve-all" } : {}) }),
      aiConnection: binding,
      testCredentials: {},
    }));
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
    expect(api.hire.mock.calls[0][1]).toMatchObject({
      adapterType,
      defaultEnvironmentId: "sandbox-1",
      adapterConfig: { model, ...(adapterType === "paperclip_runner" ? { provider: "acpx", acpxAgent: "grok", acpxPermissionMode: "approve-all" } : {}) },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false } },
    });
    expect(JSON.stringify(api.testEnvironment.mock.calls)).not.toContain("example-test-secret");
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("example-test-secret");
    expect(container.textContent).toContain("Your agent is ready");
  });
  it("sends Cursor Cloud repo/ref and transient API key, then saves an organization secret", async () => {
    await render("cursor_cloud");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
    await fill("GitHub repository", "https://github.com/paperclipai/paperclip");
    await fill("Branch", "master");
    await fill("CURSOR_API_KEY", "cursor-test-key");
    await click("Run test");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({
      adapterConfig: { repoUrl: "https://github.com/paperclipai/paperclip", repoStartingRef: "master" },
      testCredentials: { CURSOR_API_KEY: "cursor-test-key" },
    });
    expect(secrets.create).not.toHaveBeenCalled();
    await click("Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).toMatchObject({ repoUrl: "https://github.com/paperclipai/paperclip", repoStartingRef: "master", env: {
      CURSOR_API_KEY: { type: "secret_ref", secretId: "org-secret-1", version: "latest" },
    } });
    expect(config).not.toHaveProperty("repository");
    expect(config).not.toHaveProperty("branch");
    expect(JSON.stringify(config)).not.toContain("cursor-test-key");
    expect(secrets.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ value: "cursor-test-key" }));
  });
  it("requires a new Cursor Cloud key even when organization and personal keys exist", async () => {
    secrets.list.mockResolvedValue([{ id: "existing", key: "CURSOR_API_KEY", name: "Cursor", status: "active" }]);
    secrets.listMyUserSecrets.mockResolvedValue([{ definition: { key: "CURSOR_API_KEY" }, secret: { id: "personal-key" } }]);
    await render("cursor_cloud");
    expect(container.textContent).not.toContain("Or use an organization secret");
    await fill("GitHub repository", "https://github.com/example/repo");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a Cursor API key");
    await fill("CURSOR_API_KEY", "new-cursor-key");
    await click("Finish setup");
    expect(secrets.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ value: "new-cursor-key" }));
    expect(api.hire.mock.calls[0][1].adapterConfig.env.CURSOR_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
  });
  it.each([
    ["cursor", "CURSOR_API_KEY"],
    ["gemini_local", "GEMINI_API_KEY"],
    ["hermes_local", "OPENROUTER_API_KEY"],
  ])("provides %s credentials to tests and stores only a secret reference", async (adapter, key) => {
    await render(adapter);
    await fill(key, "adapter-test-key");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({ [key]: "adapter-test-key" });
    expect(api.hire.mock.calls[0][1].adapterConfig.env[key]).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
  });
  it("defines a Kimi API model without overriding it with a CLI model alias", async () => {
    await render("kimi_local");
    await fill("KIMI_MODEL_API_KEY", "kimi-test-key");
    await click("Run test");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter the Kimi API model name");
    await fill("Kimi API model name", "kimi-for-coding");
    await fill("Kimi API base URL", "https://api.kimi.com/coding/v1");
    await click("Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config).not.toHaveProperty("model");
    expect(config.env).toMatchObject({
      KIMI_MODEL_NAME: { type: "plain", value: "kimi-for-coding" },
      KIMI_MODEL_BASE_URL: { type: "plain", value: "https://api.kimi.com/coding/v1" },
      KIMI_MODEL_API_KEY: { type: "secret_ref", secretId: "org-secret-1" },
    });
  });
  it("configures Hermes Gateway URL and its top-level secret reference", async () => {
    await render("hermes_gateway");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    await fill("Hermes API base URL", "https://hermes.example.com");
    await fill("API_SERVER_KEY", "hermes-test-key");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2]).toMatchObject({
      adapterConfig: { apiBaseUrl: "https://hermes.example.com" },
      testCredentials: { API_SERVER_KEY: "hermes-test-key" },
    });
    expect(api.hire.mock.calls[0][1].adapterConfig.apiKey).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("hermes-test-key");
  });
  it("uses the shared Grok connection flow and hides ignored Kimi and OpenCode effort controls", async () => {
    await render("grok_local");
    expect(container.textContent).toContain("Connect a model");
    expect(container.textContent).not.toContain("Connect Atlas to Grok");
    await render("opencode_local");
    expect(container.querySelector('[aria-label="Thinking effort"]')).toBeNull();
  });
  it("restores confirmation on refresh without hiring again", async () => {
    api.get.mockResolvedValue({
      id: "saved-agent",
      companyId: "company-1",
      name: "Atlas",
      adapterType: "pi_local",
      adapterConfig: { model: "openrouter/anthropic/claude-sonnet-4.6" },
      status: "idle",
    });
    state.params = new URLSearchParams({
      name: "Atlas",
      adapterType: "pi_local",
      createdAgentId: "saved-agent",
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <TooltipProvider><NewAgent /></TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(container.textContent).toContain("Your agent is ready");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    await click("Assign Atlas a Task");
    expect(state.openNewIssue).toHaveBeenCalledWith({
      assigneeAgentId: "saved-agent",
      status: "todo",
    });
  });
  it("does not advance connection after a timed-out provider probe", async () => {
    api.testEnvironment.mockResolvedValue({
      ...pass,
      status: "warn",
      checks: [
        {
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
        },
      ],
    });
    await render("claude_local");
    await connect("Claude");
    expect(container.textContent).toContain("Claude hello probe timed out.");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
  });

  it.each(["claude_local", "codex_local"])(
    "connects %s, creates once, and assigns a task",
    async (adapter) => {
      await render(adapter);
      await connect(adapter === "claude_local" ? "Claude" : "OpenAI");
      expect(api.testEnvironment).toHaveBeenCalledWith(
        "company-1",
        adapter,
        expect.objectContaining({ environmentId: "local-1" }),
      );
      await click("Finish setup");
      expect(api.hire).toHaveBeenCalledTimes(1);
      expect(api.hire.mock.calls[0][1]).toMatchObject({
        name: "Atlas",
        adapterType: adapter,
        reportsTo: "ceo",
        runtimeConfig: { heartbeat: { enabled: false } },
      });
      expect(container.textContent).toContain("Your agent is ready");
      await click("Assign Atlas a Task");
      expect(state.openNewIssue).toHaveBeenCalledWith({
        assigneeAgentId: "new-agent",
        status: "todo",
      });
    },
  );
  it.each([
    ["claude_local", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["codex_local", "codex", "OpenAI", "OPENAI_API_KEY"],
    ["paperclip_runner", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["paperclip_runner", "codex", "OpenAI", "OPENAI_API_KEY"],
  ])("stores %s %s as a reusable connection before hiring", async (adapter, runner, provider, key) => {
    await render(adapter, runner);
    await click(provider + "API key");
    await fill("API key", "connection-key");
    await click("Connect");
    const binding = { provider: key === "ANTHROPIC_API_KEY" ? "anthropic" : "openai", method: "api_key", mode: "responsible_user" };
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ apiKey: "connection-key", provider: binding.provider }));
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    expect(api.testEnvironment.mock.calls[0][2].aiConnection).toEqual(binding);
    expect(container.textContent).toContain("Configure your agent");
    expect(container.querySelector('[role="combobox"][aria-label="Connection"]')).toBeNull();
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual(binding);
    expect(managedApi.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("connection-key");
  });
  it.each([
    ["claude_local", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["codex_local", "codex", "OpenAI", "OPENAI_API_KEY"],
    ["paperclip_runner", "claude", "Claude", "ANTHROPIC_API_KEY"],
    ["paperclip_runner", "codex", "OpenAI", "OPENAI_API_KEY"],
  ])("defaults %s %s to a saved key and preserves its reference through hire", async (adapter, runner, provider, key) => {
    secrets.listMyUserSecrets.mockResolvedValue([{
      definition: { id: "existing-key", companyId: "company-1", key, name: "Existing key", status: "active" },
      secret: { companyId: "company-1", status: "active" },
    }]);
    await render(adapter, runner);
    await click(provider + "API key");
    expect((container.querySelector("select[aria-label='Saved API key']") as HTMLSelectElement).value).toBe("user:existing-key");
    await click("Use saved API key");
    const binding = { type: "user_secret_ref", key, version: "latest" };
    expect(api.testEnvironment.mock.calls[0][2].adapterConfig.env[key]).toEqual(binding);
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env[key]).toEqual(binding);
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    expect(secrets.createMyUserSecret).not.toHaveBeenCalled();
    expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
  });
  it.each(["codex_local", "paperclip_runner"])("keeps a saved connection chosen in Connect when hiring %s", async (adapter) => {
    await render(adapter, "codex");
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [{
        id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022", companyId: "company-1",
        provider: "openrouter", method: "api_key", name: "Company OpenRouter",
        ownership: "shared", isDefault: false, status: "connected",
        routing: { kind: "openrouter", protocol: "responses", auth: "bearer", models: [] },
      }],
    } as any);
    await click("AdvancedCustom Gateway");
    const picker = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("Company OpenRouter")) as HTMLElement;
    expect(option).toBeTruthy();
    await act(async () => option.click());
    await settle();
    await click("Use connection");
    expect(container.textContent).toContain("Configure your agent");
    expect(container.querySelector('[role="combobox"][aria-label="Connection"]')).toBeNull();
    await click("Run test");
    const binding = { provider: "openrouter", method: "api_key", mode: "shared", connectionId: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022" };
    expect(api.testEnvironment.mock.calls[0][2].aiConnection).toEqual(binding);
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual(binding);
  });
  it("requires the current connection choice to connect before Configure can save it", async () => {
    await render("codex_local");
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [{
      id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022", companyId: "company-1",
      provider: "openrouter", method: "api_key", name: "Company OpenRouter", ownership: "shared", isDefault: false, status: "connected",
      routing: { kind: "openrouter", protocol: "responses", auth: "bearer", models: [] },
    }] } as any);
    await click("AdvancedCustom Gateway");
    const picker = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("Company OpenRouter")) as HTMLElement;
    await act(async () => option.click());
    await settle();
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("Connect");
    await click("Connection");
    await click("2Configure");
    expect(container.textContent).not.toContain("Finish setup");
    await click("Connect model");
    await click("OpenAIAPI key");
    await fill("API key", "new-api-credential");
    await click("Connect");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].runtimeConfig.aiConnection).toEqual({ provider: "openai", method: "api_key", mode: "responsible_user" });
  });
  it.each(["pi_local"])(
    "persists %s OpenRouter credentials only as a secret reference",
    async (adapter) => {
      await render(adapter);
      await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
      await fill("OPENROUTER_API_KEY", "example-test-secret");
      await click("Run test");
      expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
      expect(secrets.createMyUserSecret).not.toHaveBeenCalled();
      expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({ OPENROUTER_API_KEY: "example-test-secret" });
      await click("Finish setup");
      expect(api.hire.mock.calls[0][1].adapterConfig.env.OPENROUTER_API_KEY).toEqual({
        type: "secret_ref",
        secretId: "org-secret-1",
        version: "latest",
      });
      expect(secrets.create).toHaveBeenCalledWith(
        "company-1", expect.objectContaining({ value: "example-test-secret" }),
      );
      expect(JSON.stringify(api.hire.mock.calls)).not.toContain(
        "example-test-secret",
      );
      expect(secrets.create).toHaveBeenCalledTimes(1);
    },
  );
  it("connects OpenRouter before testing and hiring OpenCode without copying credentials into the agent", async () => {
    await render("opencode_local");
    const model = "openrouter/anthropic/claude-sonnet-4.6";
    await fill("Model", model);
    const connectionSelect = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => connectionSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    const connectOption = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes("Connect an account"))!;
    expect(connectOption).toBeTruthy();
    await act(async () => (connectOption as HTMLElement).click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    const advanced = [...dialog.querySelectorAll("summary")].find(node => node.textContent?.includes("Advanced providers"))!;
    await act(async () => advanced.click());
    const openrouter = [...dialog.querySelectorAll("button")].find(node => node.textContent?.includes("OpenRouter"))!;
    await act(async () => openrouter.click());
    await settle();
    const input = dialog.querySelector('[aria-label="API key"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "example-test-secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connectButton = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Connect")!;
    expect(connectButton.disabled).toBe(false);
    await act(async () => connectButton.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(managedApi.setDefault).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      provider: "openrouter", method: "api_key", apiKey: "example-test-secret",
    }));
    const binding = { provider: "openrouter", method: "api_key", mode: "shared", connectionId: "managed-connection", grantId: "managed-grant" };

    await click("Run test");
    expect(api.testEnvironment.mock.calls[0][2]).toEqual(expect.objectContaining({
      aiConnection: binding, testCredentials: {},
      adapterConfig: expect.objectContaining({ model }),
    }));
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1]).toEqual(expect.objectContaining({
      adapterType: "opencode_local",
      runtimeConfig: expect.objectContaining({ aiConnection: binding }),
      adapterConfig: expect.objectContaining({ model }),
    }));
    expect(managedApi.create).toHaveBeenCalledTimes(1);
    expect(secrets.create).not.toHaveBeenCalled();
    expect(JSON.stringify(api.testEnvironment.mock.calls)).not.toContain("example-test-secret");
    expect(JSON.stringify(api.hire.mock.calls)).not.toContain("example-test-secret");
  });
  it.each(["codex", "claude", "opencode"])(
    "uses the correct native %s runner",
    async (runner) => {
      await render("paperclip_runner", runner);
      if (runner !== "opencode")
        await connect(runner === "claude" ? "Claude" : "OpenAI");
      else await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
      await click("Finish setup");
      const config = api.hire.mock.calls[0][1].adapterConfig;
      expect(config.provider).toBe(runner === "claude" ? "acpx" : runner);
      if (runner === "claude") {
        expect(config.acpxAgent).toBe("claude");
        expect(config.model).toMatch(/^claude-/);
      }
      if (runner === "codex") expect(config.acpxAgent).toBeUndefined();
    },
  );
  it("does not create when the test fails and permits retry", async () => {
    await render();
    await fill("Model", "openrouter/unknown/model");
    api.testEnvironment.mockResolvedValueOnce({ ...pass, status: "fail" });
    await click("Run test");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't connect");
    await click("Retry test");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledTimes(1);
  });
  it("does not rotate a working provider credential when a new key fails its test", async () => {
    secrets.listMyUserSecrets.mockResolvedValue([{ definition: { id: "existing-definition", key: "OPENROUTER_API_KEY" }, secret: { id: "working-secret" } }]);
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "invalid-replacement");
    api.testEnvironment.mockResolvedValueOnce({ ...pass, status: "fail" });
    await click("Run test");
    expect(secrets.rotateMyUserSecret).not.toHaveBeenCalled();
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
    expect(api.testEnvironment.mock.calls[0][2].testCredentials.OPENROUTER_API_KEY).toBe("invalid-replacement");
    await click("Finish setup");
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("does not store a key when leaving after a successful test", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "abandoned-key");
    await click("Run test");
    await act(async () => root.render(null));
    expect(secrets.createUserSecretDefinition).not.toHaveBeenCalled();
  });
  it("removes the staged credential when hiring fails", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "new-key");
    api.hire.mockRejectedValueOnce(new Error("Creation rejected"));
    await click("Finish setup");
    expect(secrets.remove).toHaveBeenCalledWith("org-secret-1");
    expect(container.textContent).toContain("Creation rejected");
  });
  it("preserves the creation error when credential cleanup also fails", async () => {
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "new-key");
    api.hire.mockRejectedValueOnce(new Error("Agent quota exceeded"));
    secrets.remove.mockRejectedValueOnce(new Error("Cleanup unavailable"));
    await click("Finish setup");
    expect(container.textContent).toContain("Agent quota exceeded");
    expect(container.textContent).toContain("Could not remove an unused setup credential");
  });
  it("requires an explicit provider/model for Pi", async () => {
    await render();
    await click("Run test");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(container.textContent).toContain("provider/model format");
  });
  it("blocks a disabled runner even when opened through a URL", async () => {
    state.adapters = [
      { type: "paperclip_runner", loaded: true, disabled: true },
    ];
    await render("paperclip_runner");
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
  });
  it("keeps pending agents behind approval and disables task assignment", async () => {
    api.hire.mockResolvedValue({
      agent: { id: "new-agent", name: "Atlas", status: "pending_approval" },
    });
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await click("Finish setup");
    expect(container.textContent).toContain("Agent submitted for approval");
    await click("Assign Atlas a Task");
    expect(state.openNewIssue).not.toHaveBeenCalled();
  });
  it("uses the same managed environment for connection testing and creation", async () => {
    envApi.list.mockResolvedValue([
      { id: "sandbox-1", driver: "sandbox", config: { provider: "daytona" } },
    ]);
    envApi.capabilities.mockResolvedValue({
      sandboxProviders: { daytona: { supportsLoginPty: true } },
    });
    settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    settings.getExperimental.mockResolvedValue({
      enableManagedSandboxOnly: true,
    });
    api.getClaudeOAuthTokenStatus.mockResolvedValue({ secretId: "saved-oauth", latestVersion: 1 });
    await render("claude_local");
    await click("ClaudeSubscription");
    await click("Use saved subscription");
    await click("Finish setup");
    expect(api.testEnvironment.mock.calls[0][2].environmentId).toBe(
      "sandbox-1",
    );
    expect(api.hire.mock.calls[0][1]).toMatchObject({
      defaultEnvironmentId: "sandbox-1",
      applyStoredClaudeLogin: true,
    });
  });
});
