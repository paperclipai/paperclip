// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

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
}));

// The real adapter registry eagerly imports every adapter package. The
// model/harness picker internals are out of scope here, so stub the adapter
// layer entirely and drive the grid through these two knobs.
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string }>,
  disabled: new Set<string>(),
  loaded: true,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialog,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompany,
}));
// The restore gate fetches the company list itself to verify draft ownership,
// rather than trusting the shared cache, so this module now needs stubbing
// here. An empty list is fine: the drafts in this file carry no
// `createdCompanyId`, so there is no ownership question — but the fetch has to
// succeed for the gate to treat the draft as decidable at all.
// The company list is keyed by account, so it holds until the session query
// *succeeds*. A seeded entry is stale under the test client and refetches, so
// the refetch has to answer too — otherwise the identity errors and the list
// never runs.
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: mockAuthApi.getSession } };
});

const mockCompaniesApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  detachInflightList: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(async () => []),
  getAdapterAuthSignal: vi.fn(async () => ({ status: "present" })),
  hire: vi.fn(async () => ({ agent: { id: "agent-1" }, approval: null })),
  list: vi.fn(async () => []),
  testEnvironment: vi.fn(async () => ({
    adapterType: "agy_local",
    status: "pass",
    checks: [],
    testedAt: new Date().toISOString(),
  })),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  listMyUserSecrets: vi.fn().mockResolvedValue([]),
  createUserSecretDefinition: vi.fn().mockResolvedValue({ id: "def-1" }),
  createMyUserSecret: vi.fn().mockResolvedValue({ id: "secret-1" }),
  removeUserSecretDefinition: vi.fn().mockResolvedValue(undefined),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(async () => [] as Array<Record<string, unknown>>),
  capabilities: vi.fn(
    async (): Promise<import("@paperclipai/shared").EnvironmentCapabilities> =>
      (await import("@paperclipai/shared")).getEnvironmentCapabilities([]),
  ),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null as string | null })),
  getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));
vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));
vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));
vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));
vi.mock("../adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters")>();
  return {
    ...actual,
    listUIAdapters: () => mockAdapterRegistry.list,
    getUIAdapter: (type: string) => {
      if (type === "hermes_local") {
        return actual.getUIAdapter("hermes_local");
      }
      return { buildAdapterConfig: () => ({}) };
    },
  };
});
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
  useAdapterRegistryLoaded: () => mockAdapterRegistry.loaded,
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
  }),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { queryKeys } from "../lib/queryKeys";
import { OnboardingWizard } from "./OnboardingWizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setControlledValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The company list is keyed by account, so it holds until the session is
  // known. Seeding it is how this test says "signed in".
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-1", userId: "user-1" },
    user: { id: "user-1", name: "Example", email: "user-1@example.com", image: null },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OnboardingWizard />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root };
}

describe("OnboardingWizard adapter selection", () => {
  beforeEach(() => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Example", email: "user-1@example.com", image: null },
    });
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [];
    mockAdapterRegistry.list = [];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdapterRegistry.loaded = true;
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("snaps a disabled default adapterType to the first enabled adapter", async () => {
    // A deployment whose adapter registry omits claude_local disables it, so
    // the wizard's claude_local default must not survive as an invisible
    // selection (the created agent could never acquire a lease).
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "opencode_local" },
    ];
    mockAdapterRegistry.disabled = new Set(["claude_local"]);

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("codex_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps an enabled saved adapterType untouched", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
    ];
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 0, adapterType: "claude_local" }),
    );

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("claude_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps onboarding on legacy adapters even when Paperclip Runner is enabled", async () => {
    mockAdapterRegistry.list = [
      { type: "paperclip_runner" },
      { type: "codex_local" },
    ];
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 0,
        adapterType: "paperclip_runner",
        model: "gpt-runner-only",
        command: "runnerd",
        args: "--native",
        url: "ws://runner",
      }),
    );

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("codex_local");
    expect(saved.model).toBe("");
    expect(saved.command).toBe("");
    expect(saved.args).toBe("");
    expect(saved.url).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("normalizes a saved Paperclip Runner draft before adapter discovery resolves", async () => {
    mockAdapterRegistry.loaded = false;
    mockAdapterRegistry.list = [{ type: "codex_local" }];
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 0,
        adapterType: "paperclip_runner",
        model: "gpt-runner-only",
        command: "runnerd",
        args: "--native",
        url: "ws://runner",
      }),
    );

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("claude_local");
    expect(saved.model).toBe("");
    expect(saved.command).toBe("");
    expect(saved.args).toBe("");
    expect(saved.url).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("normalizes a saved cursor_cloud draft to claude_local", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "cursor_cloud" },
    ];
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 0,
        adapterType: "cursor_cloud",
      }),
    );

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("claude_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("excludes cursor_cloud from more harnesses even when registered", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "cursor" },
      { type: "cursor_cloud" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
      }),
    );

    const { root } = await mount();

    const toggleButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("More harnesses"),
    );
    expect(toggleButton).toBeTruthy();
    expect(toggleButton?.textContent).toContain("More harnesses (1)");

    await act(async () => {
      toggleButton?.click();
    });
    await flushReact();

    const cursorButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => /cursor/i.test(btn.textContent ?? "") && !/cloud/i.test(btn.textContent ?? ""),
    );
    expect(cursorButton).toBeTruthy();

    const cursorCloudButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => /cursor.*cloud/i.test(btn.textContent ?? ""),
    );
    expect(cursorCloudButton).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not replace a saved adapter before the registry has loaded", async () => {
    // External adapter types are only registered once the adapters query
    // resolves. Until then `listUIAdapters()` returns the built-ins alone, so
    // a saved external adapter looks exactly like a disabled one — and
    // snapping would swap the customer's choice for a built-in and persist it.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 0, adapterType: "acme_external" }),
    );
    mockAdapterRegistry.loaded = false;
    mockAdapterRegistry.list = [{ type: "codex_local" }];

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("acme_external");

    await act(async () => {
      root.unmount();
    });
  });

  it("allows selecting a non-recommended adapter on step 4 via more harnesses", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "agy_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
      }),
    );

    const { root } = await mount();

    // The more harnesses toggle button should be present
    const toggleButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("More harnesses"),
    );
    expect(toggleButton).toBeTruthy();

    // Click to expand more harnesses
    await act(async () => {
      toggleButton?.click();
    });
    await flushReact();

    // agy_local tile should now be visible
    const agyButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Antigravity") || btn.textContent?.includes("agy_local"),
    );
    expect(agyButton).toBeTruthy();

    // Click to select agy_local
    await act(async () => {
      agyButton?.click();
    });
    await flushReact();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("agy_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("skips asking for an API key when Antigravity local credentials are present", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "agy_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
        adapterType: "agy_local",
      }),
    );

    const { root } = await mount();

    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    expect(mockAgentsApi.getAdapterAuthSignal).toHaveBeenCalledWith(
      "comp-1",
      "agy_local",
      undefined,
    );

    // Should indicate that an existing provider connection is available
    expect(document.body.textContent).toContain("An existing provider connection is available.");

    // Should NOT render the API key input field
    const apiKeyInput = document.querySelector('input[placeholder="Enter API key here"]');
    expect(apiKeyInput).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows sign-in instructions when Antigravity local credentials are absent", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "agy_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
        adapterType: "agy_local",
      }),
    );

    const { root } = await mount();

    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    // Expand more harnesses if needed and click Antigravity tile
    const agyButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Antigravity") || btn.textContent?.includes("agy_local"),
    );
    expect(agyButton).toBeTruthy();

    await act(async () => {
      agyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i++) {
      await flushReact();
    }

    expect(document.body.textContent).toContain(
      "Antigravity is not signed in on this machine. Run agy in your terminal to sign in, or connect with an API key.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("defaults to saved API key for Antigravity when saved key exists even if host credentials are present", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "agy_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([
      {
        definition: { id: "saved-key-1", companyId: "comp-1", key: "GEMINI_API_KEY", name: "My Gemini Key", status: "active" },
        secret: { companyId: "comp-1", status: "active" },
      },
    ]);
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
        adapterType: "agy_local",
      }),
    );

    const { root } = await mount();

    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    // Should indicate that saved API key is available
    expect(document.body.textContent).toContain("1 saved API key available.");

    // Should not have auto-connected or hired
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();

    // Click Antigravity tile to open the card
    const agyButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Antigravity") || btn.textContent?.includes("agy_local"),
    );
    expect(agyButton).toBeTruthy();

    await act(async () => {
      agyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i++) {
      await flushReact();
    }

    // The saved API key select dropdown should be rendered in the card
    const keySelect = document.querySelector('select[aria-label="Saved API key"]');
    expect(keySelect).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("carries entered API key as OPENROUTER_API_KEY when hiring hermes_local", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "hermes_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
    mockSecretsApi.createUserSecretDefinition.mockResolvedValue({ id: "def-1" });
    mockSecretsApi.createMyUserSecret.mockResolvedValue({ id: "secret-1" });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
        adapterType: "hermes_local",
      }),
    );

    const { root } = await mount();

    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const hermesButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => /hermes/i.test(btn.textContent ?? ""),
    );
    expect(hermesButton).toBeTruthy();

    await act(async () => {
      hermesButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const apiKeyInput = document.querySelector('input[placeholder="Enter API key here"]') as HTMLInputElement;
    expect(apiKeyInput).toBeTruthy();

    await act(async () => {
      setControlledValue(apiKeyInput, "sk-or-test-key-123");
    });
    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const hireButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Hire") || btn.textContent?.includes("Connect"),
    );
    expect(hireButton).toBeTruthy();

    await act(async () => {
      hireButton!.click();
    });
    for (let i = 0; i < 10; i++) {
      await flushReact();
    }

    expect(mockAgentsApi.hire).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({
        adapterType: "hermes_local",
        adapterConfig: expect.objectContaining({
          env: expect.objectContaining({
            OPENROUTER_API_KEY: expect.objectContaining({
              type: "user_secret_ref",
            }),
          }),
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("carries entered API key and model name when hiring kimi_local", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "kimi_local" },
    ];
    const company = { id: "comp-1", name: "Acme", issuePrefix: "ACM" };
    mockCompany.companies = [company];
    mockCompaniesApi.list.mockResolvedValue([company]);
    mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
    mockSecretsApi.createUserSecretDefinition.mockResolvedValue({ id: "def-1" });
    mockSecretsApi.createMyUserSecret.mockResolvedValue({ id: "secret-1" });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Acme",
        agentName: "Chief of Staff",
        createdCompanyId: "comp-1",
        adapterType: "kimi_local",
        credentialModeChoice: "api",
      }),
    );

    const { root } = await mount();

    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const kimiButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => /kimi/i.test(btn.textContent ?? ""),
    );
    expect(kimiButton).toBeTruthy();

    await act(async () => {
      kimiButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const apiKeyInput = document.querySelector('input[placeholder="Enter API key here"]') as HTMLInputElement;
    expect(apiKeyInput).toBeTruthy();

    await act(async () => {
      setControlledValue(apiKeyInput, "kimi-test-key-123");
    });
    for (let i = 0; i < 5; i++) {
      await flushReact();
    }

    const hireButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Hire") || btn.textContent?.includes("Connect"),
    );
    expect(hireButton).toBeTruthy();

    await act(async () => {
      hireButton!.click();
    });
    for (let i = 0; i < 10; i++) {
      await flushReact();
    }

    expect(mockAgentsApi.hire).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({
        adapterType: "kimi_local",
        adapterConfig: expect.objectContaining({
          env: expect.objectContaining({
            KIMI_MODEL_API_KEY: expect.objectContaining({
              type: "user_secret_ref",
            }),
            KIMI_MODEL_NAME: expect.objectContaining({
              type: "plain",
              value: "kimi-code/kimi-for-coding",
            }),
          }),
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
