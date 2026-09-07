// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  getAdapterAuthSignal: vi.fn(),
}));
const envApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
const settings = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));
const secrets = vi.hoisted(() => ({
  list: vi.fn(),
  listMyUserSecrets: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  adapters: [] as object[],
  navigate: vi.fn(),
  openNewIssue: vi.fn(),
}));
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
        <NewAgent />
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
    "paperclip_runner",
  ].map((type) => ({ type, loaded: true, disabled: false }));
  api.adapterModels.mockResolvedValue([]);
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.testEnvironment.mockResolvedValue(pass);
  api.hire.mockImplementation(async (_company, input) => ({
    agent: { ...input, id: "new-agent", status: "idle", urlKey: "atlas" },
  }));
  envApi.list.mockResolvedValue([
    { id: "local-1", name: "Local", driver: "local", config: {} },
  ]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "local-1" });
  settings.getExperimental.mockResolvedValue({});
  settings.getGeneral.mockResolvedValue({ executionMode: "any" });
  secrets.list.mockResolvedValue([]);
  secrets.listMyUserSecrets.mockResolvedValue([]);
  secrets.createUserSecretDefinition.mockResolvedValue({ id: "definition-1" });
  secrets.createMyUserSecret.mockResolvedValue({ id: "secret-1" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});
describe("New agent setup", () => {
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
          <NewAgent />
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
  it.each(["opencode_local", "pi_local"])(
    "persists %s OpenRouter credentials only as a secret reference",
    async (adapter) => {
      await render(adapter);
      await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
      await fill("OPENROUTER_API_KEY", "example-test-secret");
      await click("Run test");
      expect(secrets.createMyUserSecret).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ value: "example-test-secret" }),
      );
      const testedConfig = api.testEnvironment.mock.calls[0][2].adapterConfig;
      expect(testedConfig.env.OPENROUTER_API_KEY).toEqual({
        type: "user_secret_ref",
        key: "OPENROUTER_API_KEY",
        version: "latest",
      });
      await click("Finish setup");
      expect(api.hire.mock.calls[0][1].adapterConfig).toEqual(testedConfig);
      expect(JSON.stringify(api.hire.mock.calls)).not.toContain(
        "example-test-secret",
      );
      expect(secrets.createMyUserSecret).toHaveBeenCalledTimes(1);
    },
  );
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
    await render("claude_local");
    await connect("Claude");
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
