// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sibling of OnboardingWizard.adapters.test.tsx, covering the connect step's
 * explicit-model surface: adapters with no safe default model (see
 * EXPLICIT_MODEL_VALIDATORS in OnboardingWizard.tsx — currently pi_local)
 * get a model input on step 4, and the hire blocks client-side until the
 * typed value passes the adapter's own shape check (isValidPiModelId), so a
 * bad model never reaches the server's assertAdapterConfigConstraints 422.
 */

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
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
const mockGoalsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(async () => []),
}));
const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(async () => [] as Array<{ id: string; label: string }>),
  testEnvironment: vi.fn(
    async (): Promise<import("@paperclipai/shared").AdapterEnvironmentTestResult> => ({
      adapterType: "pi_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  ),
  hire: vi.fn(async () => ({ agent: { id: "agent-1" }, approval: null })),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
  getClaudeOAuthTokenStatus: vi.fn(),
  getAdapterAuthSignal: vi.fn(
    async (): Promise<import("@paperclipai/shared").AdapterAuthSignalResponse> => ({
      status: "present",
    }),
  ),
}));
const mockApprovalsApi = vi.hoisted(() => ({
  create: vi.fn(),
  approve: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  listMyUserSecrets: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(async () => []),
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

// The real adapter registry eagerly imports every adapter package. Stub it and
// drive the tile row through this knob. The build mock defaults to echoing the
// model it was handed so tests can assert what the hire would have carried.
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string }>,
  disabled: new Set<string>(),
  loaded: true,
}));
const mockAdapterBuild = vi.hoisted(() => ({
  buildAdapterConfig: vi.fn(
    (values: { model?: string }) => ({ model: values.model } as Record<string, unknown>),
  ),
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
  // Mirrors the real registry, where pi_local is `recommended` alongside
  // claude_local and codex_local — that flag is what puts a tile in the
  // connect step's source row.
  getAdapterDisplay: (type: string) => ({
    type,
    recommended: type === "claude_local" || type === "codex_local" || type === "pi_local",
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
// pi_local declares no login capability (mirroring the real registry's
// fallback for an unlisted type), so Connect goes straight to the probe and
// the hire — which is the path under test.
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
  }),
}));
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./FrontDoor", () => ({ FrontDoor: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { ONBOARDING_STORAGE_KEY as EXPORTED_KEY, OnboardingWizard } from "./OnboardingWizard";

// The wizard exports the exact key it reads; pin the local copy against drift.
void ONBOARDING_STORAGE_KEY;
const STORAGE_KEY = EXPORTED_KEY;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** React tracks input value on the DOM node; set it the way React will see. */
function setControlledValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const SESSION_USER_ID = "user-b";

/**
 * Walk to the connect step with the Pi tile picked, the way a customer gets
 * there: create the company, name the lead, advance, answer the source row.
 *
 * By `aria-checked` and the mocked label (the display registry mock labels a
 * tile with its type id), so the test asserts the mechanism rather than the
 * mock's cosmetics.
 */
async function openConnectStepWithPi() {
  mockAdapterRegistry.list = [
    { type: "claude_local" },
    { type: "codex_local" },
    { type: "pi_local" },
  ];
  mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ step: 1, onboardingPath: "create", companyName: "Initech" }),
  );
  mockDialog.onboardingOptions = {};
  mockCompany.companies = [];
  mockCompany.loading = false;
  mockCompaniesApi.list.mockResolvedValue([]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-b", userId: SESSION_USER_ID },
    user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OnboardingWizard />
      </QueryClientProvider>,
    );
  });
  await flushReact();

  const clickByText = async (match: (text: string) => boolean) => {
    const el = [...document.body.querySelectorAll("button")].find((b) =>
      match(b.textContent?.trim() ?? ""),
    )!;
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  };

  await clickByText((t) => t.startsWith("Continue"));
  const agentField = document.body.querySelector(
    "#onboarding-agent-name",
  ) as HTMLInputElement;
  await act(async () => {
    setControlledValue(agentField, "Ada");
  });
  await flushReact();
  await clickByText((t) => t.startsWith("Next"));
  expect(document.body.textContent).toContain("Connect a model");

  // Pick the Pi tile from the source row. The tile is labelled by
  // CONNECT_SOURCE_NAMES ("Pi"), not by the type id, and the credential tag
  // trails it in the same text node — match on the leading label.
  const piTile = [...document.body.querySelectorAll("button[aria-checked]")].find(
    (b) => b.textContent?.startsWith("Pi"),
  )!;
  await act(async () => {
    piTile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();

  return { root, clickByText };
}

/** The arc footer's primary button, whatever this step calls it. */
function isArcPrimary(text: string): boolean {
  return text.startsWith("Next") || text.startsWith("Connect");
}

describe("OnboardingWizard explicit model input (pi_local)", () => {
  beforeEach(() => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-b", userId: SESSION_USER_ID },
      user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
    });
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockDialog.onboardingRouteDismissed = false;
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockCompany.error = null;
    mockCompaniesApi.list.mockResolvedValue([]);
    mockAdapterRegistry.list = [];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdapterBuild.buildAdapterConfig.mockReset();
    mockAdapterBuild.buildAdapterConfig.mockImplementation(
      (values: { model?: string }) => ({ model: values.model } as Record<string, unknown>),
    );
    mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
    mockAgentsApi.getClaudeOAuthTokenStatus.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    mockAgentsApi.testEnvironment.mockReset();
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "pi_local",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    mockAgentsApi.hire.mockReset();
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a model input when pi_local is the chosen source", async () => {
    const { root } = await openConnectStepWithPi();

    const modelInput = document.body.querySelector("#onboarding-model") as HTMLInputElement;
    expect(modelInput).toBeTruthy();
    // No value is pre-filled: pi has no safe default (see STU-27), and a
    // seeded suggestion is exactly the bogus default the step must not pick.
    expect(modelInput.value).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks the hire on an empty model with a clear client-side error, before any hire request", async () => {
    const { root, clickByText } = await openConnectStepWithPi();

    await clickByText((t) => isArcPrimary(t));

    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Pi requires an explicit model in provider/model format.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks the hire on a malformed model id, not just an empty one", async () => {
    const { root, clickByText } = await openConnectStepWithPi();

    const modelInput = document.body.querySelector("#onboarding-model") as HTMLInputElement;
    await act(async () => {
      // A bare model name with no provider half: the adapter's own shape
      // check (isValidPiModelId) rejects it, so the step must too.
      setControlledValue(modelInput, "grok-4");
    });
    await flushReact();
    await clickByText((t) => isArcPrimary(t));

    expect(mockAgentsApi.hire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Pi requires an explicit model in provider/model format.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("carries the typed model verbatim into the hire's adapter config", async () => {
    const { root, clickByText } = await openConnectStepWithPi();

    const modelInput = document.body.querySelector("#onboarding-model") as HTMLInputElement;
    await act(async () => {
      setControlledValue(modelInput, "xai/grok-4");
    });
    await flushReact();
    await clickByText((t) => isArcPrimary(t));

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hireBody = (mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1] as {
      adapterType: string;
      adapterConfig: { model?: string };
    };
    expect(hireBody.adapterType).toBe("pi_local");
    // Verbatim: whatever was typed is what the built config carries — no
    // default is substituted on the way through buildAdapterConfig.
    expect(hireBody.adapterConfig.model).toBe("xai/grok-4");

    await act(async () => {
      root.unmount();
    });
  });

  it("recovers after the blocked attempt once a valid model is typed", async () => {
    const { root, clickByText } = await openConnectStepWithPi();

    // First press blocks: empty model.
    await clickByText((t) => isArcPrimary(t));
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();

    // Type a valid id and press again: the same press now hires.
    const modelInput = document.body.querySelector("#onboarding-model") as HTMLInputElement;
    await act(async () => {
      setControlledValue(modelInput, "anthropic/claude-sonnet-5");
    });
    await flushReact();
    await clickByText((t) => isArcPrimary(t));

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hireBody = (mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1] as {
      adapterConfig: { model?: string };
    };
    expect(hireBody.adapterConfig.model).toBe("anthropic/claude-sonnet-5");

    await act(async () => {
      root.unmount();
    });
  });
});
