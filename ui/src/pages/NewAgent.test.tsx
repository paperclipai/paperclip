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
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
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
  AdapterLoginPanel: ({ onStored }: { onStored: (id: string) => void }) => (
    <button onClick={() => onStored("stored-claim")}>
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
  it("blocks direct runner setup links when the experiment is disabled", async () => {
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
    expect(container.textContent).toContain("Connect Atlas to Grok");
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
    await click("Use API key insteadUse subscription insteadUse API key instead");
    await click(provider + "API");
    await fill("API key", "connection-key");
    await click("Connect");
    const binding = { provider: key === "ANTHROPIC_API_KEY" ? "anthropic" : "openai", method: "api_key", mode: "responsible_user" };
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ apiKey: "connection-key", provider: binding.provider }));
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    expect(api.testEnvironment.mock.calls[0][2].aiConnection).toEqual(binding);
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
    await click(provider + "API");
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
    await click("Connect another account");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(api.hire).not.toHaveBeenCalled();
    expect(api.testEnvironment).not.toHaveBeenCalled();
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
    expect(managedApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      provider: "openrouter", method: "api_key", apiKey: "example-test-secret",
    }));
    const binding = { provider: "openrouter", method: "api_key", mode: "responsible_user" };
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
    await connect("OpenAI");
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
