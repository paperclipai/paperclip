import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { NewAgent } from "./NewAgent";
import { ApiError } from "@/api/client";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  retryLifecycle: vi.fn(),
  getAdapterAuthSignal: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));
const envApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn(), probe: vi.fn() }));
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
const adapterApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/adapters", () => ({ adaptersApi: adapterApi }));
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
let setupRecords: Map<string, Record<string, unknown>>;
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
  await renderCurrentParams();
}
async function renderCurrentParams() {
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
  adapterApi.list.mockImplementation(async () => state.adapters);
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
    "paperclip_runner", "cursor_cloud", "cursor", "gemini_local", "kimi_local", "kimchi_local", "grok_local", "hermes_local", "hermes_gateway",
  ].map((type) => ({ type, loaded: true, disabled: false }));
  api.adapterModels.mockResolvedValue([]);
  setupRecords = new Map();
  api.create.mockImplementation(async (_company, input) => {
    const record = { ...input, id: input.setupId, companyId: "company-1", status: "paused", lifecycleState: "paused", pauseReason: "setup" };
    setupRecords.set(record.id, record);
    return record;
  });
  api.get.mockImplementation(async id => {
    const record = setupRecords.get(id);
    if (!record) throw new ApiError("Not found", 404, null);
    return record;
  });
  api.update.mockImplementation(async (id, input) => {
    const record = { ...setupRecords.get(id), ...input, id, companyId: "company-1", status: "paused", lifecycleState: "paused", pauseReason: "setup" };
    setupRecords.set(id, record);
    return record;
  });
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  api.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
  api.getClaudeOAuthTokenStatus.mockRejectedValue(new ApiError("Not found", 404, null));
  api.testEnvironment.mockResolvedValue(pass);
  api.hire.mockImplementation(async (_company, input) => ({
    agent: { ...input, id: input.setupAgentId ?? "new-agent", status: "idle", urlKey: "atlas" },
  }));
  envApi.list.mockResolvedValue([
    { id: "local-1", name: "Local", driver: "local", config: {} },
  ]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  envApi.probe.mockReset().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Measured image",
    details: { platformQualificationRecorded: true, leaseId: "owned-platform-lease" } });
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

export { api, envApi, settings, secrets, state, managedApi, adapterApi, root, container, cache, settle, click, fill, render, connect, pass, renderCurrentParams };
