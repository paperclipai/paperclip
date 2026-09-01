// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { NewAgent } from "./NewAgent";

// The real adapter registry stays in place so the create request runs the real
// Claude config builder. That builder turns the fixed binding into the adapter
// `env` map, which is the contract this page test verifies.

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listProposals: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
}));
const mockCompanySkillsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockClipboard = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
const navigateMock = vi.hoisted(() => vi.fn());
const mockAdapterAvailability = vi.hoisted(() => ({
  disabled: new Set<string>(),
  loaded: true,
}));
const mockSearchParams = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [mockSearchParams.value, vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/companySkills", () => ({ companySkillsApi: mockCompanySkillsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: mockClipboard.copyTextToClipboard,
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => mockAdapterAvailability.disabled,
  useAdapterRegistryLoaded: () => mockAdapterAvailability.loaded,
}));

// The form reads the projected adapter login capability to pick the login flow
// and to gate the login panel. The server projects these safe scalar fields.
// `claude_local` runs on a real pseudo-terminal, so the panel gate requires the
// provider pty capability. Provide the projection so the login panel renders.
const mockLoginProjections = vi.hoisted(
  () =>
    new Map<string, { panelMode: string; timeoutPolicy: string }>([
      ["claude_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
      ["codex_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
    ]),
);

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) => {
    const login = mockLoginProjections.get(adapterType);
    return {
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      supportsModelProfiles: true,
      supportsAcp: true,
      ...(login ? { login } : {}),
    };
  },
}));

vi.mock("../components/MarkdownEditor", () => ({
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

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function clickByText(container: HTMLElement, label: string) {
  const button = findButton(container, label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

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
// for a provider with the capability, so the sandbox environment uses Daytona.
const SANDBOX_CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: {
    daytona: { supportsLoginPty: true, displayName: "Daytona" },
    e2b: { supportsLoginPty: false, displayName: "E2B" },
  },
});

async function renderNewAgent() {
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
            <NewAgent />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root };
}

// Complete the Claude subscription login on the page: run the environment test,
// start the login, and let the panel reach the server `stored` state.
async function completeClaudeLogin(container: HTMLElement) {
  await clickByText(container, "Test Agent");
  await flushUntil(() => Boolean(findButton(container, "Log in")));
  await clickByText(container, "Log in");
  await flushUntil(() => (container.textContent ?? "").includes("Authenticated"));
}

describe("NewAgent Claude subscription login", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAdapterAvailability.disabled = new Set<string>();
    mockAdapterAvailability.loaded = true;
    mockSearchParams.value = new URLSearchParams();
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    // No existing agents: the page treats the new agent as the first (CEO) and
    // seeds the name, so the Create button is enabled without a typed name.
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1", name: "CEO" } });
    mockAgentsApi.testEnvironment.mockResolvedValue(CLAUDE_AUTH_MISSING_RESULT);
    // The default owner has no stored Claude token, so the login is a first
    // write. A test overrides this to prove the panel applies a stored token
    // first and passes the captured version as a version-checked overwrite.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
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

    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "local-1", name: "Local", driver: "local", config: {} },
      {
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    // The instance default is the sandbox, so the effective login environment
    // resolves to it without the user touching the override selector.
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-1" });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
    mockCompanySkillsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/asset" });
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

  it("shows Log in for a Claude sandbox before Create agent", async () => {
    const result = await renderNewAgent();
    roots.push(result.root);

    // Before the test the page shows no login affordance.
    expect(findButton(result.container, "Log in")).toBeFalsy();

    await clickByText(result.container, "Test Agent");
    await flushUntil(() => Boolean(findButton(result.container, "Log in")));

    const loginButton = findButton(result.container, "Log in");
    const createButton = findButton(result.container, "Create agent");
    expect(loginButton).toBeTruthy();
    expect(createButton).toBeTruthy();

    // The login panel renders before the Create agent button in the document, so
    // the user completes the subscription login before an agent exists.
    const order = loginButton!.compareDocumentPosition(createButton!);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stores the secret and adds the fixed binding through the create request, with no token in the DOM", async () => {
    const result = await renderNewAgent();
    roots.push(result.root);

    await completeClaudeLogin(result.container);

    expect(mockAgentsApi.completeClaudeSetupTokenLogin).toHaveBeenCalledWith(
      "company-1",
      "claude-session-1",
    );

    await clickByText(result.container, "Create agent");
    await flushUntil(() => mockAgentsApi.hire.mock.calls.length > 0);

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const [companyId, payload] = mockAgentsApi.hire.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(companyId).toBe("company-1");

    // The create request carries the non-secret stored-session claim, and the
    // adapter config carries the fixed reference binding.
    expect(payload.storedSessionId).toBe("stored-session-1");
    const adapterConfig = payload.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, Record<string, unknown>>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toEqual({
      type: "user_secret_ref",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      version: "latest",
      required: true,
    });
    // The binding is a reference. It carries no token value.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).not.toHaveProperty("value");

    // The token never enters the Document Object Model, and no request payload
    // carries a token value.
    expect(result.container.textContent ?? "").not.toContain("sk-ant");
    expect(JSON.stringify(payload)).not.toContain("sk-ant");
  });

  it("applies a stored token first and starts a replacement login with the captured version", async () => {
    // The owner already has a stored Claude token. The panel reads the status,
    // applies the stored token first, and shows a replace action. A replacement
    // login carries the captured secret id and version, so the server rotates the
    // stored value under a version-checked overwrite instead of a first write.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
      secretId: "44444444-4444-4444-8444-444444444444",
      latestVersion: 3,
    });

    const result = await renderNewAgent();
    roots.push(result.root);

    await clickByText(result.container, "Test Agent");
    // The panel shows the replace action only after it reads the stored-token
    // status, so the button label proves the panel captured the version.
    await flushUntil(() => Boolean(findButton(result.container, "Log in to replace")));
    await clickByText(result.container, "Log in to replace");
    await flushUntil(() => mockAgentsApi.startClaudeSetupTokenLogin.mock.calls.length > 0);

    expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledWith("company-1", {
      environmentId: "sandbox-1",
      overwrite: {
        expectedSecretId: "44444444-4444-4444-8444-444444444444",
        expectedLatestVersion: 3,
      },
    });
  });

  it("ignores a native-runner URL preset while the experimental adapter is disabled", async () => {
    mockSearchParams.value = new URLSearchParams("adapterType=paperclip_runner");
    mockAdapterAvailability.disabled = new Set(["paperclip_runner"]);

    const result = await renderNewAgent();
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Paperclip Runner");
    expect(result.container.textContent).toContain("Claude Code");
  });

  it("accepts a native-runner URL preset after the experimental adapter is enabled", async () => {
    mockSearchParams.value = new URLSearchParams("adapterType=paperclip_runner");

    const result = await renderNewAgent();
    roots.push(result.root);

    expect(result.container.textContent).toContain("Paperclip Runner");
  });
});
