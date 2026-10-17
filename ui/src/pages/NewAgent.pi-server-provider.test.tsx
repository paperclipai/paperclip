// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NewAgent } from "./NewAgent";

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
  navigate: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  setDefault: vi.fn(),
}));
const adapterApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/api/environments", () => ({ environmentsApi: envApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: settings }));
vi.mock("@/api/secrets", () => ({ secretsApi: secrets }));
vi.mock("@/api/adapters", () => ({ adaptersApi: adapterApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [state.params],
}));
// Exercise API/persistence contracts with a deterministic model input instead of the searchable dropdown.
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
  AdapterLoginPanel: () => null,
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
const declaredModel = { id: "gateway/llama-3.3-70b", label: "Llama 3.3 70B" };
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
function providerSelect() {
  return container.querySelector('[aria-label="API key provider"]') as HTMLSelectElement;
}
async function chooseProvider(value: string) {
  const provider = providerSelect();
  await act(async () => {
    provider.value = value;
    provider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
function deferModels() {
  let resolveModels!: (value: object[]) => void;
  api.adapterModels.mockImplementationOnce(() => new Promise<object[]>(resolve => { resolveModels = resolve; }));
  return async (models: object[]) => {
    await act(async () => resolveModels(models));
    await settle();
  };
}
async function render() {
  state.params = new URLSearchParams({ name: "Atlas", adapterType: "pi_local" });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <TooltipProvider><NewAgent /></TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  adapterApi.list.mockResolvedValue([{ type: "pi_local", loaded: true, disabled: false, declaredModels: true }]);
  managedApi.list.mockResolvedValue({ currentUserId: "user-1", canManageConnections: true, connections: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.adapterModels.mockResolvedValue([declaredModel]);
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.testEnvironment.mockResolvedValue({
    adapterType: "pi_local",
    status: "pass",
    checks: [{ code: "hello_probe_passed", level: "info", message: "Model replied" }],
    testedAt: "2026-09-07T00:00:00Z",
  });
  api.hire.mockImplementation(async (_company, input) => ({
    agent: { ...input, id: "new-agent", status: "idle", urlKey: "atlas" },
  }));
  envApi.list.mockResolvedValue([{ id: "local-1", name: "Local", driver: "local", config: {} }]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "local-1" });
  settings.getExperimental.mockResolvedValue({});
  settings.getGeneral.mockResolvedValue({ executionMode: "any" });
  secrets.list.mockResolvedValue([]);
  secrets.create.mockResolvedValue({ id: "org-secret-1" });
  secrets.listMyUserSecrets.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});

describe("New agent setup with server-configured Pi models", () => {
  it("defaults Pi to the server-configured provider when the server declares Pi models", async () => {
    await render();
    expect(providerSelect().value).toBe("server");
    expect(providerSelect().selectedOptions[0]?.textContent).toBe("Configured by server");
    expect(container.querySelector('[aria-label="OPENROUTER_API_KEY"]')).toBeNull();
    expect(container.textContent).not.toContain("Or use an organization secret");
    expect(container.textContent).not.toContain("Use a openrouter/model ID");
  });
  it("hires a server-configured Pi agent with the declared model and no credential env", async () => {
    secrets.list.mockResolvedValue([
      { id: "org-openrouter", key: "OPENROUTER_API_KEY", name: "OpenRouter", status: "active" },
      { id: "org-generic", key: "API_KEY", name: "Generic", status: "active" },
    ]);
    await render();
    await fill("Model", declaredModel.id);
    await click("Run test");
    expect(api.testEnvironment.mock.calls[0][2].testCredentials).toEqual({});
    expect(api.testEnvironment.mock.calls[0][2].adapterConfig).not.toHaveProperty("env");
    await click("Finish setup");
    const config = api.hire.mock.calls[0][1].adapterConfig;
    expect(config.model).toBe(declaredModel.id);
    expect(config).not.toHaveProperty("env");
    expect(secrets.create).not.toHaveBeenCalled();
  });
  it("restores the API key field when switching Pi from the server provider to OpenRouter", async () => {
    await render();
    await chooseProvider("openrouter");
    expect(container.querySelector('[aria-label="OPENROUTER_API_KEY"]')).toBeTruthy();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "example-test-secret");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
  });
  it("selects the server-configured provider again when a declared Pi model is chosen", async () => {
    await render();
    await chooseProvider("openrouter");
    await fill("Model", declaredModel.id);
    expect(providerSelect().value).toBe("server");
    expect(container.querySelector('[aria-label="OPENROUTER_API_KEY"]')).toBeNull();
  });
  it("keeps the OpenRouter key for declared Pi models of a key-based provider", async () => {
    api.adapterModels.mockResolvedValue([{ id: "openrouter/anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" }]);
    secrets.list.mockResolvedValue([
      { id: "org-openrouter", key: "OPENROUTER_API_KEY", name: "OpenRouter", status: "active" },
    ]);
    await render();
    expect(providerSelect().value).toBe("openrouter");
    expect([...providerSelect().options].map((option) => option.value)).not.toContain("server");
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-openrouter" });
  });
  it("drops a key entered before the server-configured Pi provider is selected", async () => {
    const loadModels = deferModels();
    await render();
    await fill("OPENROUTER_API_KEY", "example-test-secret");
    await loadModels([declaredModel]);
    expect(providerSelect().value).toBe("server");
    await fill("Model", declaredModel.id);
    await click("Finish setup");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(secrets.create).not.toHaveBeenCalled();
    expect(api.hire.mock.calls[0][1].adapterConfig).not.toHaveProperty("env");
  });
  it("keeps OpenRouter when its model is chosen before the declared Pi models load", async () => {
    const loadModels = deferModels();
    await render();
    await fill("Model", "openrouter/anthropic/claude-sonnet-4.6");
    await fill("OPENROUTER_API_KEY", "example-test-secret");
    await loadModels([declaredModel]);
    expect(providerSelect().value).toBe("openrouter");
    await click("Finish setup");
    expect(api.hire.mock.calls[0][1].adapterConfig.env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: "org-secret-1" });
  });
});
