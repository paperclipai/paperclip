// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

// The company list is keyed by account, so it holds until the session query
// *succeeds*. A seeded entry is stale under the test client and refetches, so
// the refetch has to answer too — otherwise the identity errors and the list
// never runs.
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
  // The gate fetches the list itself now, rather than reading the shared
  // cache, so ownership cases are driven from here. `mockCompany.companies`
  // below still feeds the *inner* wizard, which is a different question.
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
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  ),
  hire: vi.fn(async () => ({ agent: { id: "agent-1" }, approval: null })),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
  // No default implementation: the top-level `beforeEach` sets the "no
  // stored value" 404 rejection, using the real `ApiError` class the code
  // under test checks with `instanceof`.
  getClaudeOAuthTokenStatus: vi.fn(),
  getAdapterAuthSignal: vi.fn(
    async (): Promise<import("@paperclipai/shared").AdapterAuthSignalResponse> => ({
      status: "present",
    }),
  ),
  // The sign-in routes. The connect step's Connect button starts a login rather
  // than hiring when the signal says the source has no credential, so the two
  // login shapes need enough of a server to reach the state the step is about:
  // a session that is running, and a prompt to show for it.
  startClaudeSetupTokenLogin: vi.fn(async () => ({
    sessionId: "claude-session-1",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })),
  getClaudeSetupTokenLoginStatus: vi.fn(async () => ({
    sessionId: "claude-session-1",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })),
  getClaudeSetupTokenLoginPrompt: vi.fn(async () => ({
    authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
    transportAdvisory: null,
  })),
  cancelClaudeSetupTokenLogin: vi.fn(async () => ({})),
  submitClaudeSetupTokenBrowserCode: vi.fn(async () => ({})),
  completeClaudeSetupTokenLogin: vi.fn(async () => ({ storedSessionId: "stored-1" })),
  startAdapterAuthLogin: vi.fn(async () => ({
    sessionId: "codex-session-1",
    status: "pending",
  })),
  getAdapterAuthLoginStatus: vi.fn(async () => ({
    sessionId: "codex-session-1",
    status: "pending",
    prompt: { url: "https://auth.openai.com/codex/device", code: "Q2RJ-E1YIF" },
  })),
  cancelAdapterAuthLogin: vi.fn(async () => ({})),
  // No default implementation: the top-level `beforeEach` sets the "no active
  // session" 404 rejection, matching the real route.
  getActiveAdapterAuthLoginSession: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
}));
// The adapter registry mock below always returns this function, so a test
// can shape the built adapter config (e.g. a configured ANTHROPIC_API_KEY)
// without a real adapter package.
const mockAdapterBuild = vi.hoisted(() => ({
  buildAdapterConfig: vi.fn(() => ({}) as Record<string, unknown>),
}));
// The Connect path loads environment settings before probing; without these
// the probe dies on "Could not load environment settings" and the hire never
// runs — which reads as a mysterious 0-call assertion, not an error.
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
const mockApprovalsApi = vi.hoisted(() => ({
  create: vi.fn(),
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

// The real adapter registry eagerly imports every adapter package. The
// model/harness picker internals are out of scope here, so stub the adapter
// layer entirely and drive it through this knob.
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string }>,
  disabled: new Set<string>(),
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
  getAdapterDisplay: (type: string) => ({
    type,
    // Mirrors the real registry, where these two and only these two are
    // `recommended`. A blanket `false` used to be harmless because every adapter
    // then sat in the "Advanced settings" disclosure and was reachable anyway;
    // with the step down to a tile row built from this flag, it made that row
    // empty in every test and hid the surface under it.
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
  // Added by #11371's adapter snap. A module mock replaces the whole module,
  // so every export the component reaches for has to be here — omitting one
  // makes it undefined and the call throws.
  useAdapterRegistryLoaded: () => true,
}));
// Adapters with a declared login capability, mirroring the real registry:
// `claude_local` and `codex_local` both support a sandbox login, and every
// other type has none, matching the real `useAdapterCapabilities` fallback for
// an unlisted type.
//
// The panel modes are the real ones rather than one mode for both. They used to
// be, back when nothing outside the panel dispatcher read them. The connect
// step reads them now — the two logins end in different places, so its button
// waits differently for each — and a mock that called Claude's login
// `displayed_code` would have the step testing the wrong half of that.
// Reconcile with KNOWN_DEFAULTS in `adapters/use-adapter-capabilities.ts`.
const ADAPTER_LOGIN_MODES: Record<string, "displayed_code" | "submitted_browser_code"> = {
  claude_local: "submitted_browser_code",
  codex_local: "displayed_code",
};
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (type: string) => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
    login: ADAPTER_LOGIN_MODES[type]
      ? { panelMode: ADAPTER_LOGIN_MODES[type]!, timeoutPolicy: "fixed" as const }
      : undefined,
  }),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./FrontDoor", () => ({ FrontDoor: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, getEnvironmentCapabilities } from "@paperclipai/shared";
import { CLAUDE_OAUTH_TOKEN_ENV_KEY } from "./environment-variables-editor/model";
import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";
import { CONNECTED_HOLD_MS } from "./onboarding/onboarding-motion";

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

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The company list is keyed by account, so it stays disabled until the
  // session is known. Seeding it is how these tests say "signed in as B".
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-b", userId: SESSION_USER_ID },
    user: { id: SESSION_USER_ID, name: "B", email: "b@example.com", image: null },
  });
  return { container, root, queryClient };
}

/**
 * Press the first model-source tile.
 *
 * By `aria-checked` rather than by label: the display registry is mocked in this
 * suite, so a tile reads "claude_localSubscription" rather than "Claude Code",
 * and a test that selected on the visible name would be asserting the mock.
 *
 * The connect step arrives with nothing chosen, so this is what opens the input
 * surface and lets the step advance.
 */
async function pickFirstSource(
  click: (match: (text: string) => boolean) => Promise<void>,
): Promise<void> {
  const tile = [...document.body.querySelectorAll("button[aria-checked]")][0];
  const label = tile?.textContent?.trim() ?? "";
  await click((text) => text === label);
}

/**
 * The arc footer's primary button, whatever this step calls it.
 *
 * Step 4 calls it "Connect", because there it starts a sign-in rather than
 * simply advancing; every other arc step calls it "Next". These tests are about
 * what the press does, not what it reads, so they match either — restating the
 * label at twenty call sites would make a copy change look like a behaviour
 * regression. The label itself is pinned once, in the step test that is about
 * the label.
 */
function isArcPrimary(text: string): boolean {
  return text.startsWith("Next") || text.startsWith("Connect");
}

describe("OnboardingWizard restore-gate (stale localStorage across accounts)", () => {
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
    mockAdapterBuild.buildAdapterConfig.mockReturnValue({});
    // Default: no stored Claude login for the owner. The route returns a
    // fixed 404 for a missing value, so the client treats a real `ApiError`
    // with that status as "no stored value" rather than a hard failure.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
    mockAgentsApi.getClaudeOAuthTokenStatus.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    // Default: no active login session for the caller. A resume test
    // overrides this with a resolved session body.
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    // Reset to each mock's original default. `mockResolvedValue` /
    // `mockReturnValue` overrides a mock's implementation permanently — it
    // is not undone by `afterEach`'s `vi.clearAllMocks()`, which only clears
    // call history — so a test that customizes one of these must not leak
    // its override into the next test.
    mockAgentsApi.testEnvironment.mockReset();
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    mockAgentsApi.hire.mockReset();
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
    mockCompaniesApi.create.mockResolvedValue({
      id: "created",
      name: "Created Co",
      issuePrefix: "CRE",
    });
    mockCompaniesApi.update.mockResolvedValue({
      id: "c1",
      name: "Acme Rockets",
      issuePrefix: "PAP",
    });
    mockGoalsApi.create.mockResolvedValue({ id: "goal-1" });
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  describe("step 2, which is two screens wearing one number", () => {
    // The create path's step 2 was the mission question and is skipped now. The
    // grow path's step 2 is "tell us about your team", whose answers seed the
    // lead agent — a different screen that happens to share the number, and one
    // nothing covered until skipping the first nearly took it along.

    async function openStepOne(path: "create" | "grow") {
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, onboardingPath: path, companyName: "Initech" }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);

      // The model step needs tiles to pick from, and this suite's default
      // registry is empty.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root, queryClient } = render();
      const renderTree = () =>
        act(async () => {
          root.render(
            <QueryClientProvider client={queryClient}>
              <OnboardingWizard />
            </QueryClientProvider>,
          );
        });
      await renderTree();
      await flushReact();
      return { root, renderTree };
    }

    async function clickByText(match: (text: string) => boolean) {
      const el = [...document.body.querySelectorAll("button")].find((b) =>
        match(b.textContent?.trim() ?? ""),
      )!;
      await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    }

    it("keeps the grow path's questionnaire", async () => {
      const { root } = await openStepOne("grow");
      await clickByText((t) => t.startsWith("Continue"));

      expect(document.body.textContent).toContain("Tell us about your team");
      expect(mockCompaniesApi.create).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("skips it on the create path, creating the company on the way", async () => {
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne("create");
      await clickByText((t) => t.startsWith("Continue"));

      expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Initech" });
      expect(document.body.textContent).toContain("Create your first agent");
      expect(document.body.textContent).not.toContain("Define your mission");

      await act(async () => root.unmount());
    });

    it("shows no environment-check card on the model step, and no Mission row on review", async () => {
      // Round-3 walk feedback: the adapter environment check still runs —
      // Connect probes before hiring and blocks on a fail — but its idle card
      // (explainer plus "Test now") is gone. And the review checklist lost its
      // "Mission" row: onboarding stopped asking, so the row could only ever
      // render unchecked. Both asserted against positive anchors so an
      // unrendered step cannot pass as an absence.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne("create");
      await clickByText((t) => t.startsWith("Continue"));
      expect(document.body.textContent).toContain("Create your first agent");

      // Step 3 → 4 needs an agent name — the one field the step has now.
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));

      expect(document.body.textContent).toContain("Connect a model");
      await pickFirstSource(clickByText);
      expect(document.body.textContent).not.toContain("Adapter environment check");
      expect(document.body.textContent).not.toContain("Test now");

      // Through Connect to Review, so the Mission-row assertion runs against
      // the checklist that actually renders it — stopping at the model step
      // would let a Mission regression pass unseen.
      await clickByText((t) => isArcPrimary(t));
      // The review step is the heading and the woken agent, nothing else: the
      // checklist that restated the walk in three rows is gone, and with it
      // the Mission row that could only render unchecked.
      expect(document.body.textContent).toContain("Let's get started...");
      expect(document.body.textContent).toContain("Ada is ready to work!");
      expect(document.body.textContent).not.toContain("Organization name");
      expect(document.body.textContent).not.toContain("Model connected");
      expect(document.body.textContent).not.toContain("Mission");

      await act(async () => root.unmount());
    });

    it("hires from a legacy draft that saved an empty role", async () => {
      // `agentRole: ""` was this field's default before the arc stopped asking
      // for a role, so every draft saved by an earlier build carries it. `??`
      // would pass the empty string straight through to the hire's silent
      // return — the same no-op the default exists to prevent, arriving
      // through a restored draft instead of a fresh one.
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, onboardingPath: "create", companyName: "Initech", agentRole: "" }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });

      // The model step needs tiles to pick from, and this suite's default
      // registry is empty.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root, queryClient } = render();
      const renderTree = () =>
        act(async () => {
          root.render(
            <QueryClientProvider client={queryClient}>
              <OnboardingWizard />
            </QueryClientProvider>,
          );
        });
      await renderTree();
      await flushReact();

      const clickText = async (match: (t: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

      await clickText((t) => t.startsWith("Continue"));
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickText((t) => isArcPrimary(t));
      await pickFirstSource(clickText);
      await clickText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      // The mock is declared with no parameters, so index the call rather than
      // destructuring a zero-length tuple type.
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      expect((hireArgs[1] as { role: string }).role).toBe("general");

      await act(async () => root.unmount());
    });

    it("hires one agent when Connect fires twice in one breath", async () => {
      // The Connect handler re-runs a cached failed probe now that "Test now"
      // is gone — so two overlapping submissions could both pass the fresh
      // probe and both hire. `loading` cannot stop the second caller: it is
      // state, unwritten while the first call is still awaiting. The ref
      // guard must make the second submission a no-op.
      let resolveHire: (v: { agent: { id: string }; approval: null }) => void = () => {};
      mockAgentsApi.hire.mockReturnValue(
        new Promise((resolve) => {
          resolveHire = resolve;
        }),
      );
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne("create");
      await clickByText((t) => t.startsWith("Continue"));
      const agentField = document.body.querySelector(
        "#onboarding-agent-name",
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(agentField, "Ada");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));
      expect(document.body.textContent).toContain("Connect a model");
      await pickFirstSource(clickByText);

      const connect = [...document.body.querySelectorAll("button")].find((b) =>
        isArcPrimary(b.textContent?.trim() ?? ""),
      )!;
      await act(async () => {
        connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await act(async () => resolveHire({ agent: { id: "agent-1" }, approval: null }));
      await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);

      await act(async () => root.unmount());
    });

    it("creates one company for one keystroke, modifier or not", async () => {
      // The name field handles Enter itself and does not check for a modifier,
      // so Cmd+Enter in that field reaches the field's handler *and* the
      // wizard's step-level one. Both would start creating. The step-level
      // `loading` guard cannot stop it — `setLoading(true)` has not landed
      // while the same event is still bubbling — so the second caller reads a
      // value the first has not written. Two companies, one keystroke.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne("create");

      const nameInput = document.body.querySelector(
        'input[placeholder="e.g. Northwind Labs"]',
      ) as HTMLInputElement;
      await act(async () => {
        nameInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
        );
      });
      await flushReact();

      expect(mockCompaniesApi.create).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Create your first agent");

      await act(async () => root.unmount());
    });

    it("creates one company however many times Enter repeats", async () => {
      // Holding Enter down fires keydown repeatedly. Each one is a separate
      // event, so `defaultPrevented` says nothing about the others, and neither
      // `loading` nor `createdCompanyId` has been written by the time the next
      // arrives — the first is state, the second is not set until the request
      // it guards resolves. Only a ref written before the request goes out is
      // visible to the caller behind it.
      let resolveCreate: (c: { id: string; issuePrefix: string }) => void = () => {};
      mockCompaniesApi.create.mockReturnValue(
        new Promise<{ id: string; issuePrefix: string }>((resolve) => {
          resolveCreate = resolve;
        }),
      );
      const { root } = await openStepOne("create");

      const nameInput = document.body.querySelector(
        'input[placeholder="e.g. Northwind Labs"]',
      ) as HTMLInputElement;
      await act(async () => {
        for (let i = 0; i < 4; i++) {
          nameInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        }
      });

      expect(mockCompaniesApi.create).toHaveBeenCalledTimes(1);

      await act(async () => resolveCreate({ id: "company-new", issuePrefix: "INI" }));
      await flushReact();
      expect(document.body.textContent).toContain("Create your first agent");

      await act(async () => root.unmount());
    });

    it("sends Back to the screen the run actually came from", async () => {
      // A create run reached the agent step from step 1, so Back owes it step 1 —
      // not the mission screen it never saw.
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      const { root } = await openStepOne("create");
      await clickByText((t) => t.startsWith("Continue"));
      expect(document.body.textContent).toContain("Create your first agent");

      await clickByText((t) => t.includes("Back"));

      expect(document.body.textContent).toContain("What is the name of your organization?");
      expect(document.body.textContent).not.toContain("Define your mission");

      await act(async () => root.unmount());
    });
  });

  describe("hire gate: adapter authentication (claude_local, the default onboarding adapter)", () => {
    /** Drives the wizard to the Connect step, agent name already filled in. */
    async function openConnectStep({ useApiKeys = false } = {}) {
      // The tile row is built from this registry, and the suite's default is
      // empty. That was survivable while the step preselected a source; now that
      // nothing is chosen until a tile is pressed, a step with no tiles is a step
      // that can never advance.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      mockCompaniesApi.create.mockResolvedValue({ id: "company-new", issuePrefix: "INI" });
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ step: 1, onboardingPath: "create", companyName: "Initech" }),
      );
      mockDialog.onboardingOptions = {};
      mockCompany.companies = [];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue([]);

      const { root, queryClient } = render();
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
      await clickByText((t) => isArcPrimary(t));
      expect(document.body.textContent).toContain("Connect a model");

      // The credential mode is chosen *before* a source, because picking a
      // source starts the sequence and the mode link fades out with the row —
      // after that it is inert, and switching would mean changing the card out
      // from under a running sign-in.
      if (useApiKeys) {
        await clickByText((t) => t.startsWith("Use API key"));
      }

      // Pick a source. The step arrives with nothing chosen — `adapterType`
      // carries a value for the hire, but that is not the same as the customer
      // having answered — so the input surface stays closed and the step will
      // not advance until a tile is pressed. Every case below is about what
      // happens *after* that choice, so the helper makes it.
      await pickFirstSource(clickByText);

      return { root, clickByText };
    }

    it("blocks the hire on a warn result that holds adapter_auth_missing, and shows the returned checks", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn" as const,
            message: "No stored Claude login was found for this agent.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "No stored Claude login was found for this agent.",
      );

      await act(async () => root.unmount());
    });

    it("still hires on a warn result that carries no adapter_auth_missing check", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: "claude_anthropic_api_key_overrides_subscription",
            level: "warn" as const,
            message: "ANTHROPIC_API_KEY overrides the subscription login.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    // The Connect handler reuses a passing probe instead of re-running it, so the
    // effect that clears the cache has to name every input to the configuration
    // the probe tested. `credentialMode` and `apiKey` were missing from it, and
    // the gap is reachable: the probe and the hire share one try/catch, so a hire
    // that throws leaves the pass in state. Switching to a key and pressing
    // Connect again then hired against a key nothing had tested.
    /**
     * Typing a key into this step must not put the key into the agent's stored
     * configuration. That configuration is persisted and revisioned, so a plain
     * value there is a live credential at rest in every copy of it — which is
     * what this step did before, and what the Claude token path has always
     * avoided by holding a `user_secret_ref` instead.
     */
    describe("an API key typed on the step", () => {
      const KEY = "sk-ant-typed-by-the-customer";

      // The canvas holding the key field only opens once a source is selected,
      // and the tile row that selects one is built from this registry. The
      // suite's default is empty, which leaves the step with no tiles, no
      // canvas, and no field to type into.
      beforeEach(() => {
        mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
        // No definition and no stored value yet: the first customer to type a key.
        mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);
        mockSecretsApi.createUserSecretDefinition.mockResolvedValue({ id: "def-1" });
        mockSecretsApi.createMyUserSecret.mockResolvedValue({ id: "secret-abc" });
        mockSecretsApi.rotateMyUserSecret.mockResolvedValue({ id: "secret-existing" });
      });

      async function connectWithApiKey() {
        const handles = await openConnectStep({ useApiKeys: true });
        const field = document.body.querySelector(
          'input[type="password"]',
        ) as HTMLInputElement;
        await act(async () => {
          setControlledValue(field, KEY);
        });
        await flushReact();
        await handles.clickByText((t) => isArcPrimary(t));
        return handles;
      }

      it("is stored as the user's own secret and referenced, never carried in the hire", async () => {
        const { root } = await connectWithApiKey();

        expect(mockSecretsApi.createMyUserSecret).toHaveBeenCalledTimes(1);
        const [, createBody] = mockSecretsApi.createMyUserSecret.mock.calls.at(-1) as [
          string,
          { definitionKey: string; value: string },
        ];
        expect(createBody.definitionKey).toBe("ANTHROPIC_API_KEY");
        expect(createBody.value).toBe(KEY);

        const hireBody = (mockAgentsApi.hire.mock.calls.at(-1) as unknown[])[1] as {
          adapterConfig: { env?: Record<string, unknown> };
        };
        // The same binding kind the subscription half of this step produces.
        expect(hireBody.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
          type: "user_secret_ref",
          key: "ANTHROPIC_API_KEY",
          version: "latest",
        });
        // The whole payload, not just that one field: the point is that the key
        // is nowhere in what gets persisted, however it might be nested.
        expect(JSON.stringify(hireBody)).not.toContain(KEY);

        await act(async () => root.unmount());
      });

      // Onboarding is the first thing to need this definition, so it creates it.
      it("creates the definition once, then reuses it", async () => {
        await connectWithApiKey();
        expect(mockSecretsApi.createUserSecretDefinition).toHaveBeenCalledTimes(1);

        mockSecretsApi.listMyUserSecrets.mockResolvedValue([
          { definition: { id: "def-1", key: "ANTHROPIC_API_KEY" }, secret: null },
        ]);
        const { root } = await connectWithApiKey();

        expect(mockSecretsApi.createUserSecretDefinition).toHaveBeenCalledTimes(1);

        await act(async () => root.unmount());
      });

      // A second value against one definition is what the server refuses, so a
      // customer who already has a key stored must rotate rather than add.
      it("rotates an existing value instead of storing a second one", async () => {
        mockSecretsApi.listMyUserSecrets.mockResolvedValue([
          {
            definition: { id: "def-1", key: "ANTHROPIC_API_KEY" },
            secret: { id: "secret-existing" },
          },
        ]);
        const { root } = await connectWithApiKey();

        expect(mockSecretsApi.rotateMyUserSecret).toHaveBeenCalledWith(
          expect.any(String),
          "secret-existing",
          { value: KEY },
        );
        expect(mockSecretsApi.createMyUserSecret).not.toHaveBeenCalled();

        await act(async () => root.unmount());
      });

      // The one outcome that must never happen is a hire that falls back to
      // embedding the key because storing it failed.
      it("blocks the hire when the key cannot be stored", async () => {
        mockSecretsApi.createMyUserSecret.mockRejectedValue(new Error("vault unreachable"));
        const { root } = await connectWithApiKey();

        expect(mockAgentsApi.hire).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Could not store the API key");

        await act(async () => root.unmount());
      });

      it("stores one secret when Connect is pressed twice with the same key", async () => {
        mockAgentsApi.hire.mockRejectedValueOnce(new Error("network went away"));
        const { root, clickByText } = await connectWithApiKey();

        await clickByText((t) => isArcPrimary(t));

        expect(mockSecretsApi.createMyUserSecret).toHaveBeenCalledTimes(1);

        await act(async () => root.unmount());
      });
    });

    it("re-probes rather than reusing a pass when the credential mode changes", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      });
      // The hire fails, which is what leaves the passing probe behind.
      mockAgentsApi.hire.mockRejectedValueOnce(new Error("network went away"));

      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);

      // Switching the credential mode means backing out first: the mode link
      // fades away with the row once a source is chosen, and is inert after
      // that, so it cannot be used to change the card out from under a running
      // sign-in. Back unwinds to the question, and the answer is given again.
      await clickByText((t) => t.startsWith("Back"));
      await clickByText((t) => t.startsWith("Use API key"));
      await pickFirstSource(clickByText);

      const field = document.body.querySelector(
        'input[type="password"]',
      ) as HTMLInputElement;
      await act(async () => {
        setControlledValue(field, "sk-ant-rekey");
      });
      await flushReact();
      await clickByText((t) => isArcPrimary(t));

      // A different configuration, so the passing probe from before it cannot
      // stand in for one against this one.
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);

      await act(async () => root.unmount());
    });

    it("does not open the create path on a cached warn result that holds adapter_auth_missing", async () => {
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn" as const,
            message: "No stored Claude login was found for this agent.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();

      // A second Connect must not treat the first (cached) blocking result as
      // reusable — it re-probes, and the create path stays closed.
      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("sends the fixed Claude binding and applyStoredClaudeLogin when a stored login exists", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };
      expect(hireBody.applyStoredClaudeLogin).toBe(true);
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual({
        type: "user_secret_ref",
        key: CLAUDE_OAUTH_TOKEN_ENV_KEY,
        version: "latest",
        required: true,
      });

      await act(async () => root.unmount());
    });

    it("sends no binding and no flag when the Claude status route returns 404", async () => {
      // The default `beforeEach` mock already rejects with a 404 `ApiError`,
      // matching "no stored value" — asserted explicitly here to pin the
      // scenario this test is named for.
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };
      expect(hireBody.applyStoredClaudeLogin).toBeUndefined();
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      await act(async () => root.unmount());
    });

    it("sends no binding when the adapter configuration holds a non-empty ANTHROPIC_API_KEY", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      mockAdapterBuild.buildAdapterConfig.mockReturnValue({
        env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-configured" } },
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      // The status route must not even be asked — the conflict is decided
      // from the adapter configuration alone, before any network round trip.
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).not.toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as {
        adapterConfig: { env?: Record<string, unknown> };
        applyStoredClaudeLogin?: boolean;
      };
      expect(hireBody.applyStoredClaudeLogin).toBeUndefined();
      expect(hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      await act(async () => root.unmount());
    });

    it("carries no token value in the hire payload", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const hireArgs = mockAgentsApi.hire.mock.calls.at(-1) as unknown[];
      const hireBody = hireArgs[1] as { adapterConfig: { env?: Record<string, unknown> } };
      const binding = hireBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY] as
        | { type: string }
        | undefined;
      // A reference, never a value: no `value` field, no `secretId` field
      // either — the fixed binding names the env var, not the status
      // response's secret id.
      expect(binding?.type).toBe("user_secret_ref");
      expect(JSON.stringify(hireBody)).not.toContain("secretId");

      await act(async () => root.unmount());
    });

    it("sends the fixed binding in the environment test request when the status route returns 200", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
      const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];
      const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };
      expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toEqual({
        type: "user_secret_ref",
        key: CLAUDE_OAUTH_TOKEN_ENV_KEY,
        version: "latest",
        required: true,
      });

      await act(async () => root.unmount());
    });

    it("sends no binding in the environment test request when the status route returns 404", async () => {
      // The default `beforeEach` mock already rejects with a 404 `ApiError`.
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
      const testArgs = mockAgentsApi.testEnvironment.mock.calls.at(-1) as unknown[];
      const testBody = testArgs[2] as { adapterConfig: { env?: Record<string, unknown> } };
      expect(testBody.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();

      await act(async () => root.unmount());
    });

    it("hires when a stored login exists, even though a probe without the binding would warn adapter_auth_missing", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      // Answers like the real sandbox probe: `warn` with `adapter_auth_missing`
      // for a configuration with no binding, `pass` once the binding is
      // present. This proves the wizard sends the probe the SAME configuration
      // it hires with — a probe still sent without the binding would warn and
      // block the hire below.
      mockAgentsApi.testEnvironment.mockImplementation(
        (async (...args: unknown[]) => {
          const request = args[2] as {
            adapterConfig: { env?: Record<string, unknown> };
          };
          const hasBinding = Boolean(
            request.adapterConfig.env?.[CLAUDE_OAUTH_TOKEN_ENV_KEY],
          );
          return hasBinding
            ? {
                adapterType: "claude_local" as const,
                status: "pass" as const,
                checks: [],
                testedAt: new Date().toISOString(),
              }
            : {
                adapterType: "claude_local" as const,
                status: "warn" as const,
                checks: [
                  {
                    code: ADAPTER_AUTH_MISSING_CHECK_CODE,
                    level: "warn" as const,
                    message: "No stored Claude login was found for this agent.",
                  },
                ],
                testedAt: new Date().toISOString(),
              };
        }) as unknown as () => Promise<
          import("@paperclipai/shared").AdapterEnvironmentTestResult
        >,
      );
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("blocks the hire when the probe reports warn with adapter_auth_missing and no stored login exists", async () => {
      // The default `beforeEach` mock already rejects with a 404 `ApiError`.
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn" as const,
        checks: [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn" as const,
            message: "No stored Claude login was found for this agent.",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "No working authentication was found",
      );

      await act(async () => root.unmount());
    });

    it("reads the stored-login status once for each create attempt", async () => {
      mockAgentsApi.getClaudeOAuthTokenStatus.mockReset();
      mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue({
        secretId: "11111111-1111-1111-1111-111111111111",
        latestVersion: 1,
      });
      // Fails after the gate opens, so the button stays clickable for a
      // second attempt instead of advancing past step 4.
      mockAgentsApi.hire.mockRejectedValue(new Error("hire failed"));
      const { root, clickByText } = await openConnectStep();

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).toHaveBeenCalledTimes(1);

      await clickByText((t) => isArcPrimary(t));
      expect(mockAgentsApi.getClaudeOAuthTokenStatus).toHaveBeenCalledTimes(2);

      await act(async () => root.unmount());
    });
  });

  it("re-syncs a restored draft once companies resolve asynchronously (companies start empty/loading)", async () => {
    // Regression for the initializer-only restore bug: the inner wizard's
    // ~20 useState(saved?.x ?? default) initializers only read `saved` on
    // their very first render. useCompany() starts with companies=[] and
    // loading=true and resolves later; if the inner component mounted before
    // that resolution, restoreOnboardingState would see an empty companies
    // list and the whole draft would lock to defaults forever, even after
    // companies arrive. The fix defers mounting the inner wizard until
    // companies settle.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [];
    mockCompany.loading = true;
    // Deferred rather than swapped later: the gate's fetch fires on the first
    // render, so replacing the mock afterwards would never reach it.
    let resolveList: (companies: Array<{ id: string; name: string; issuePrefix: string }>) => void =
      () => {};
    mockCompaniesApi.list.mockReturnValue(
      new Promise<Array<{ id: string; name: string; issuePrefix: string }>>((resolve) => {
        resolveList = resolve;
      }),
    );

    const { container, root, queryClient } = render();
    const renderTree = () =>
      act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <OnboardingWizard />
          </QueryClientProvider>,
        );
      });

    await renderTree();
    await flushReact();

    // Nothing mounts yet: no premature guess, and the draft is not touched.
    expect(container.textContent).toBe("");
    expect(document.body.textContent).toBe("");
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    // Companies resolve asynchronously, owning the saved company.
    mockCompany.companies = [{ id: "c1", name: "Saved Co", issuePrefix: "SC" }];
    mockCompany.loading = false;
    await act(async () => {
      resolveList([{ id: "c1", name: "Saved Co", issuePrefix: "SC" }]);
    });

    await renderTree();
    await flushReact();

    // The draft is restored once companies settle: step 3 (Create your first
    // agent) with the saved agent name in the input, not the defaults
    // (step 0, "Chief of staff").
    expect(document.body.textContent).toContain("Create your first agent");
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Ops Lead");
    // The run entered on the agent arc, so the arc strip is the progress
    // indicator and counts 1-3 over the wizard's steps 3-5. Segments are
    // labelled by destination: the wizard has its own numbering, and two
    // controls both announcing "Step 1" would mean different things.
    const currentStep = document.body.querySelector('[aria-current="step"]');
    expect(currentStep?.getAttribute("aria-label")).toBe("Create your first agent");
    expect(document.body.textContent).toContain("Step 1 of 3");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the live wizard mounted while a post-create company-list refetch runs", async () => {
    // The authorization fetch needs to delay the first mount when a draft
    // exists. Once the customer has typed, though, invalidating that query is
    // normal background work. Unmounting for the refetch remounted the wizard
    // from this page-load draft and made a successful create look like a reset.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 1, companyName: "", createdCompanyId: null }),
    );
    let resolveRefetch: (companies: Array<{ id: string; name: string; issuePrefix: string }>) => void =
      () => {};
    mockCompaniesApi.list
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; name: string; issuePrefix: string }>>((resolve) => {
            resolveRefetch = resolve;
          }),
      );
    mockCompaniesApi.create.mockResolvedValue({
      id: "created",
      name: "Created Co",
      issuePrefix: "CRE",
    });

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const companyNameInput = document.querySelector("input") as HTMLInputElement;
    setControlledValue(companyNameInput, "Created Co");
    await act(async () => {
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Continue")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Created Co" });
    expect(mockCompaniesApi.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#onboarding-agent-name")).not.toBeNull();

    await act(async () => {
      resolveRefetch([{ id: "created", name: "Created Co", issuePrefix: "CRE" }]);
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("restores a draft after its initial ownership check fails and a retry succeeds", async () => {
    // A failed first request cannot authorize the draft, so the wizard opens
    // with safe defaults. The original gate remounted on a later successful
    // retry so the now-verified draft could be restored; keep that recovery
    // while preserving the post-create refetch fix above.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    const company = { id: "c1", name: "Saved Co", issuePrefix: "SC" };
    let resolveRetry: (companies: Array<{ id: string; name: string; issuePrefix: string }>) => void =
      () => {};
    mockCompaniesApi.list
      .mockRejectedValueOnce(new Error("company list unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; name: string; issuePrefix: string }>>((resolve) => {
            resolveRetry = resolve;
          }),
      );

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.querySelector("#onboarding-agent-name")).toBeNull();

    mockCompany.companies = [company];
    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.companies.list(SESSION_USER_ID),
      });
    });
    await flushReact();

    // The retry is intentionally still in flight. The wrapper removes the
    // safe-default wizard so a completed validation can mount the saved draft.
    expect(document.body.textContent).toBe("");

    await act(async () => {
      resolveRetry([company]);
    });
    await flushReact();

    expect(mockCompaniesApi.list).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKeys.companies.list(SESSION_USER_ID))).toEqual({
      companies: [company],
      unauthorized: false,
    });
    const agentNameInput = document.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(agentNameInput?.value).toBe("Ops Lead");

    await act(async () => {
      root.unmount();
    });
  });

  it("discards a saved draft for a company the signed-in account does not own, and wipes the stale blob", async () => {
    // The actual vulnerability this fix closes: localStorage is per-origin,
    // not per-account, so a browser that already onboarded "company-old" for
    // a different account hands its id straight to a brand-new session.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        companyName: "Someone Else's Co",
        createdCompanyId: "company-old",
      }),
    );
    mockCompany.companies = [{ id: "company-new", name: "My Co", issuePrefix: "MC" }];
    mockCompany.loading = false;
    mockCompaniesApi.list.mockResolvedValue([
      { id: "company-new", name: "My Co", issuePrefix: "MC" },
    ]);

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Falls back to the wizard's default first step, not the stale step 4
    // draft for a company this account does not own.
    expect(document.body.textContent).not.toContain("Someone Else's Co");
    // The stale blob must not linger to confuse the next onboarding attempt.
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
  it("opens, and keeps the draft, when the initial company query fails", async () => {
    // React Query reports a failed list as `isLoading === false` with `data`
    // defaulted to `[]`, which is indistinguishable from "settled, and this
    // account owns nothing" — the verdict that wipes the blob. Deleting a
    // customer's onboarding because their company request timed out is the one
    // outcome here that cannot be undone.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockCompany.error = new Error("company list unavailable");
    mockCompaniesApi.list.mockRejectedValue(new Error("company list unavailable"));

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // It mounts: the companies query sets `retry: false`, and with no
    // companies the dashboard's "Get Started" button opens onboarding — a gate
    // that rendered nothing here would make that button dead.
    expect(document.querySelector('[data-testid="onboarding-wizard"]')).not.toBeNull();
    // The draft is not restored, because ownership cannot be verified...
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("Ops Lead");
    // ...and not deleted either. The wizard is open in this harness, so the
    // persist effect does supersede it - the point is that the ownership check
    // did not *discard* it. The closed case below is where it survives intact.
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders instead of throwing when the browser denies storage access", async () => {
    // Safari's private mode and blocked third-party contexts make getItem
    // throw outright. This runs during render, so an escaping exception takes
    // the whole app down rather than just losing a draft.
    // A browser that refuses the read refuses the write too, so deny both —
    // otherwise the cleanup effect's removeItem is never exercised.
    const deny = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    // Deny the browser boundary itself. Spying on a Storage object or
    // prototype is not portable: DOM implementations may return a fresh
    // wrapper and Node exposes a separate experimental Storage global.
    const localStorage = vi.spyOn(window, "localStorage", "get").mockImplementation(deny);
    mockCompany.companies = [{ id: "c1", name: "My Co", issuePrefix: "MC" }];
    mockCompany.loading = false;

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(localStorage).toHaveBeenCalled();
    // It mounted: the wizard is open with no draft, rather than the render
    // throwing on the way in.
    expect(document.querySelector('[data-testid="onboarding-wizard"]')).not.toBeNull();

    localStorage.mockRestore();
    await act(async () => {
      root.unmount();
    });
  });

  it("opens but does not restore when a refetch fails over a cached list", async () => {
    // The companies cache is not account-scoped and survives sign-out, so a
    // failed refetch after an account switch can leave the *previous*
    // account's companies in hand. Trusting a non-empty list there would find
    // the old company id in it and hand that draft to the new account — the
    // leak this whole change closes, through a different door.
    //
    // So: mount (no dead end), do not restore, do not delete.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    mockCompany.companies = [{ id: "c1", name: "Saved Co", issuePrefix: "SC" }];
    mockCompany.loading = false;
    mockCompany.error = new Error("refetch failed");
    mockCompaniesApi.list.mockRejectedValue(new Error("refetch failed"));

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Mounted rather than blank...
    expect(document.querySelector('[data-testid="onboarding-wizard"]')).not.toBeNull();
    // ...but the draft was not restored, because the list cannot be trusted.
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("Ops Lead");

    await act(async () => {
      root.unmount();
    });
  });
  // The close-on-storage-denial case is gone with the control that reached it.
  // Onboarding is a gate now, not a dialog: there is no X, Escape does not
  // dismiss it, and nothing in the wizard calls `handleClose`. A test that
  // clicked Close was asserting a path a customer no longer has.
  //
  // The open side of the same hazard is still covered by "renders instead of
  // throwing when the browser denies storage access" directly above, which is
  // the half that can still happen.
  it("leaves the draft untouched when the company query fails and onboarding is closed", async () => {
    // Mounting is safe for the draft precisely because the persist effect is
    // gated on the wizard being open. A closed wizard writes nothing, so the
    // blob survives for a later load that can actually verify ownership.
    const draft = JSON.stringify({
      step: 3,
      companyName: "Saved Co",
      agentName: "Ops Lead",
      createdCompanyId: "c1",
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, draft);
    mockDialog.onboardingOpen = false;
    mockDialog.onboardingRouteDismissed = true;
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockCompany.error = new Error("company list unavailable");
    mockCompaniesApi.list.mockRejectedValue(new Error("company list unavailable"));

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(draft);

    await act(async () => {
      root.unmount();
    });
  });
  it("does not hand one account's draft to the next when a refetch fails after a switch", async () => {
    // The attack path in full. Account A onboards and leaves a draft naming
    // its company. The account then changes without this component's company
    // cache being cleared, and the refetch fails, so A's list is still in
    // hand. A list that still contains A's company must not be read as proof
    // that B owns it.
    //
    // `useSignOut` now resets account-scoped caches, which closes the
    // sign-out-button route into this state (see its own regression test). The
    // gate is asserted here independently of that: it must hold for any route
    // that leaves a stale list behind, not only the one that has been fixed.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        // Step 3 so the agent-name input renders and can be asserted on —
        // step 4 has no such field, which would make this pass for the wrong
        // reason whether or not the draft was restored.
        step: 3,
        companyName: "Account A Co",
        agentName: "A's Lead",
        createdCompanyId: "company-a",
      }),
    );
    mockCompany.companies = [{ id: "company-a", name: "Account A Co", issuePrefix: "AAC" }];
    mockCompany.loading = false;
    mockCompany.error = new Error("refetch failed for the new account");
    mockCompaniesApi.list.mockRejectedValue(new Error("refetch failed for the new account"));

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Account A's agent name must not appear in account B's wizard.
    expect(document.body.textContent).not.toContain("A's Lead");
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("A's Lead");

    await act(async () => {
      root.unmount();
    });
  });
  it("does not judge ownership against a warm cache that never refetched", async () => {
    // The door this whole change exists to shut, and the one the previous
    // version missed. `main.tsx` sets `staleTime: 30_000`, so for thirty
    // seconds after a sign-in the company list is served straight from cache
    // with no request — and `Auth.tsx` invalidates on sign-in but invalidation
    // keeps serving the old data while refetching. Either way account A's
    // companies arrive with *no loading state and no error*, so a gate keyed
    // on "not loading, no error" reads them as authoritative.
    //
    // Here the context reports exactly that healthy-looking stale state, and
    // the fetch for this session has not answered. A's draft must not be
    // restored on the strength of A's cached list.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Account A Co",
        agentName: "A's Lead",
        createdCompanyId: "company-a",
      }),
    );
    // The shared cache still holds A's list, and looks entirely healthy.
    mockCompany.companies = [{ id: "company-a", name: "Account A Co", issuePrefix: "AAC" }];
    mockCompany.loading = false;
    mockCompany.error = null;
    // The list fetched for *this* session answers with B's companies, which
    // do not include A's. Note the fetch must actually complete: leaving it
    // pending would keep the wizard unmounted and the assertion below would
    // hold for the wrong reason.
    mockCompaniesApi.list.mockResolvedValue([
      { id: "company-b", name: "Account B Co", issuePrefix: "BBC" },
    ]);

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Mounted — so this is a real observation, not an unmounted false pass.
    expect(document.querySelector('[data-testid="onboarding-wizard"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("A's Lead");
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("A's Lead");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not delete a draft when the company list comes back unauthorized", async () => {
    // `companiesListQueryOptions` folds 401/403 into
    // `{ companies: [], unauthorized: true }` rather than throwing, so an auth
    // blip arrives as a successful fetch of an empty list — which reads as
    // "this account owns nothing" and would delete the draft.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 3, companyName: "Saved Co", createdCompanyId: "c1" }),
    );
    mockCompaniesApi.list.mockRejectedValue(
      new ApiError("forbidden", 403, null),
    );

    const { root, queryClient } = render();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
  it("does not restore against data retained from a failed post-mount refetch", async () => {
    // The gate's weak point if it only asks "was there a fetch after mount,
    // and is there data". React Query keeps the last successful `data` when a
    // refetch fails — so after an account switch the retained value is the
    // *previous* account's list, and accepting it restores their draft.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Account A Co",
        agentName: "A's Lead",
        createdCompanyId: "company-a",
      }),
    );
    const { root, queryClient } = render();
    // A's list, already in the cache from their session.
    queryClient.setQueryData(queryKeys.companies.list(SESSION_USER_ID), {
      companies: [{ id: "company-a", name: "Account A Co", issuePrefix: "AAC" }],
      unauthorized: false,
    });
    // B's session: the refetch fails, so A's data is retained.
    mockCompaniesApi.list.mockRejectedValue(new Error("refetch failed"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Mounted, so this observes the real thing rather than an empty document.
    expect(document.querySelector('[data-testid="onboarding-wizard"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("A's Lead");
    const nameInput = document.body.querySelector(
      "#onboarding-agent-name",
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("A's Lead");

    await act(async () => {
      root.unmount();
    });
  });
  it("does not mount undecided over a warm cache, which would overwrite the draft", async () => {
    // The customer's own draft, their own companies already cached, and a
    // refetch in flight. `isLoading` is false whenever retained data exists,
    // so a gate keyed on it would mount the wizard while ownership was still
    // undecidable — and with the wizard open, the persist effect writes the
    // wizard's state back on every change, overwriting their draft with
    // defaults before the answer arrives.
    const draft = JSON.stringify({
      step: 3,
      companyName: "Saved Co",
      agentName: "Ops Lead",
      createdCompanyId: "c1",
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, draft);
    const { root, queryClient } = render();
    queryClient.setQueryData(queryKeys.companies.list(SESSION_USER_ID), {
      companies: [{ id: "c1", name: "Saved Co", issuePrefix: "SC" }],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Nothing mounted, so nothing could have written over the draft.
    expect(document.body.textContent).toBe("");
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(draft);

    await act(async () => {
      root.unmount();
    });
  });
  it("clears an unreadable draft without waiting on the company endpoint", async () => {
    // Junk is junk whoever owns what, so judging it must not queue behind a
    // request that cannot change the answer — nor issue one at all.
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{not json");
    const { root, queryClient } = render();
    mockCompaniesApi.list.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(mockCompaniesApi.list).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  describe("the adapter step login panel (cheap auth signal, no adapter test)", () => {
    const SANDBOX_ENVIRONMENT = {
      id: "env-sandbox-1",
      driver: "sandbox" as const,
      status: "active" as const,
      config: { provider: "daytona" },
      metadata: {},
    };
    const LOCAL_ENVIRONMENT = {
      id: "env-local-1",
      driver: "local" as const,
      status: "active" as const,
      config: { provider: "daytona" },
      metadata: { defaultForInstance: true },
    };

    beforeEach(() => {
      mockEnvironmentsApi.list.mockReset();
      mockEnvironmentsApi.list.mockResolvedValue([SANDBOX_ENVIRONMENT]);
      mockEnvironmentsApi.capabilities.mockReset();
      mockEnvironmentsApi.capabilities.mockResolvedValue(
        getEnvironmentCapabilities([], {
          sandboxProviders: { daytona: { supportsLoginPty: true } },
        }),
      );
      mockInstanceSettingsApi.get.mockReset();
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: "env-sandbox-1" });
      mockInstanceSettingsApi.getExperimental.mockReset();
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
      mockAgentsApi.getAdapterAuthSignal.mockReset();
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
      // The row has to actually offer the adapter these drafts name. The login
      // panel lives inside the input canvas, and the canvas opens for a chosen
      // source — a saved adapter the row cannot show is not a chosen one, so
      // without this the panel is absent for a reason that has nothing to do
      // with the auth signal these tests are about.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
    });

    /** Drives the wizard to the Connect step with a company already created. */
    async function openStep4(overrides: Record<string, unknown> = {}) {
      mockCompany.companies = [{ id: "company-new", name: "Initech", issuePrefix: "INI" }];
      mockCompany.loading = false;
      mockCompaniesApi.list.mockResolvedValue(mockCompany.companies);
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          step: 4,
          onboardingPath: "create",
          companyName: "Initech",
          agentName: "Ada",
          createdCompanyId: "company-new",
          adapterType: "claude_local",
          ...overrides,
        }),
      );
      mockDialog.onboardingOptions = {};

      const { root, queryClient } = render();
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <OnboardingWizard />
          </QueryClientProvider>,
        );
      });
      // The login-panel gate chains several dependent queries (environments,
      // instance settings, environment capabilities, then the auth signal
      // itself), each settling on its own render. One flush is not always
      // enough to reach the end of that chain.
      for (let i = 0; i < 5; i++) await flushReact();
      expect(document.body.textContent).toContain("Connect a model");
      // No pick needed here: the draft this helper restores already names an
      // adapter, which is what a run returning to this step actually carries.
      return { root, queryClient };
    }

    it("names the tiles for the provider, not the adapter type", async () => {
      // `MODEL_SOURCE_NAMES` exists so this row says "Claude" and "OpenAI" —
      // which provider you are signing in to, the question the step's heading
      // asks — rather than the display registry's tool names, which the agent
      // config screens want. It was added with a long comment justifying it and
      // then never read, so the row went on rendering whatever the registry
      // supplied: "Claude Code" and "Codex" in the app, and the bare type here,
      // since this suite's registry mock returns `label: type`.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "claude_local" });

      const labels = [...document.body.querySelectorAll("button[aria-checked]")].map(
        (tile) => tile.textContent ?? "",
      );
      expect(labels.length, "both recommended sources should render").toBe(2);
      expect(labels.some((l) => l.includes("Claude"))).toBe(true);
      expect(labels.some((l) => l.includes("OpenAI"))).toBe(true);
      // The negative half is the one that fails on the unwired version: the
      // registry label is the adapter type, and it must not reach the tile.
      expect(labels.join(" ")).not.toContain("claude_local");
      expect(labels.join(" ")).not.toContain("codex_local");

      await act(async () => root.unmount());
    });

    it("will not advance on a saved adapter the step no longer offers", async () => {
      // A draft can name an adapter this registry does not carry — a cloud
      // sandbox without claude_local, an adapter since disabled. The row hides
      // it, so the step shows an unanswered question: no tile filled, no input
      // canvas. The CTA has to agree with that.
      //
      // It did not. The gate asked `sourcePicked`, which only means "a draft
      // named something", so Next stayed live on a step that had visibly asked
      // nothing and would hire against the hidden name. Reported by Greptile on
      // #12726.
      mockAdapterRegistry.list = [{ type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "some_retired_adapter" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(tiles.length, "the row should still offer what it has").toBeGreaterThan(0);
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "no tile should read as chosen",
      ).toBe(false);

      const cta = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(cta, "the step should render its forward button").toBeTruthy();
      expect(
        cta!.hasAttribute("disabled"),
        "Connect must not advance a question the step has not visibly asked",
      ).toBe(true);

      // And it opens again the moment the customer answers it themselves.
      await act(async () => {
        tiles[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 5; i++) await flushReact();
      const ctaAfter = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(ctaAfter!.hasAttribute("disabled")).toBe(false);

      await act(async () => root.unmount());
    });

    it("will not advance on a saved adapter the row does not show", async () => {
      // The other shape of the same defect, and the one the snap cannot cover.
      //
      // The tile row is `recommendedAdapters`; the snap's idea of "visible" is
      // recommended *plus* the advanced list. An adapter in the second but not
      // the first — a saved `opencode_local`, say — therefore satisfies the
      // snap, which leaves it alone, while the row it is supposed to be chosen
      // in never shows it. Nothing is highlighted, the canvas is shut, and with
      // the gate on `sourcePicked` the CTA was live: one press hires against an
      // adapter the customer has not seen on this screen.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "opencode_local" }];
      const { root } = await openStep4({ adapterType: "opencode_local" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "the saved adapter is not in this row, so nothing should read as chosen",
      ).toBe(false);

      const cta = [...document.body.querySelectorAll("button")].find(
        (b) => isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(
        cta!.hasAttribute("disabled"),
        "Connect must not hire an adapter the row never offered",
      ).toBe(true);

      await act(async () => root.unmount());
    });

    it("will not hire from the keyboard on a source nobody selected", async () => {
      // The step has two ways forward, and gating only the visible one leaves
      // the defect intact behind a keystroke. Cmd+Enter called
      // `handleGiveHeartbeat` directly with its own, older list of conditions,
      // so with the button correctly disabled the same screen still hired on
      // Cmd+Enter. Reported by Greptile on #12726 after the button was fixed.
      //
      // The saved adapter is one the registry no longer carries, so the snap
      // replaces it with `claude_local` and clears the pick: the row shows two
      // tiles, neither chosen. A keystroke that gets through hires claude_local
      // — a real, offerable adapter that nobody on this screen selected, which
      // is what makes the bypass worth a test rather than a comment.
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      const { root } = await openStep4({ adapterType: "some_retired_adapter" });

      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(
        tiles.some((t) => t.getAttribute("aria-checked") === "true"),
        "the snap must not leave a tile reading as chosen",
      ).toBe(false);

      const wizard = document.querySelector('[data-testid="onboarding-wizard"]');
      expect(wizard, "the wizard should be mounted").not.toBeNull();
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        await act(async () => {
          wizard!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...modifier }),
          );
        });
        for (let i = 0; i < 6; i++) await flushReact();
      }

      expect(
        mockAgentsApi.hire,
        "no keystroke may hire a source nobody selected",
      ).not.toHaveBeenCalled();

      // And it works once the question is answered, so this is a gate rather
      // than a dead shortcut.
      await act(async () => {
        tiles[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 6; i++) await flushReact();
      await act(async () => {
        wizard!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true }),
        );
      });
      for (let i = 0; i < 6; i++) await flushReact();
      expect(mockAgentsApi.hire).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("starts no call to the test-environment route on adapter selection", async () => {
      const { root } = await openStep4();
      expect(mockAgentsApi.testEnvironment).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    /**
     * Press a source tile. This is what starts the sign-in — the row is the
     * question, and answering it is the whole of the trigger. Nothing is
     * selected on arrival, including from a draft that names an adapter.
     */
    async function pickSource(match: RegExp) {
      const tile = [...document.body.querySelectorAll('[role="radio"]')].find((t) =>
        match.test(t.textContent ?? ""),
      );
      expect(tile, "the row should offer that source").toBeTruthy();
      await act(async () => {
        tile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();
    }

    /** Press the step's forward button and let the sign-in queries settle. */
    async function pressArcPrimary() {
      const cta = [...document.body.querySelectorAll("button")].find((b) =>
        isArcPrimary(b.textContent?.trim() ?? ""),
      );
      expect(cta, "the step should render its forward button").toBeTruthy();
      await act(async () => {
        cta!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 8; i++) await flushReact();
    }

    it("starts the claude_local sign-in on Connect when the signal reports no ready credential", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Nothing before the press. The card *is* the sign-in now, so it does not
      // exist until the step has been asked to start one — which is the whole
      // difference between this step and the one it replaced.
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      await pickSource(/Claude/);

      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalled();
      // Connect started a sign-in rather than hiring. The ordering is the point:
      // a hire here would create an agent with no credential to run on.
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Sign in to Claude then come back and enter authorization code",
      );

      await act(async () => root.unmount());
    });

    it("collapses the row to the chosen source and walks the button through the sign-in", async () => {
      // The sequence, end to end, as the step actually runs it: the row is the
      // question, answering it starts the sign-in, and the button reports where
      // that has got to rather than offering an action it cannot perform.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Collapse is read off the row's own layout, not off how many tiles are
      // in the DOM: the leaving tile exits through AnimatePresence, and in
      // jsdom an exit never completes, so it stays mounted either way.
      const rowCentred = () =>
        document.body
          .querySelector('[role="radiogroup"]')!
          .className.includes("justify-center");
      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();

      // Nothing chosen yet on a fresh arrival: the row is a question.
      expect(rowCentred()).toBe(false);

      await pickSource(/Claude/);

      // The row has been answered, so it now shows only the answer — leaving
      // the alternative up would invite a press that has to cancel a live
      // session to honour.
      expect(rowCentred()).toBe(true);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalled();

      // And the button has become the sign-in rather than a step advance.
      expect(cta()).toBe("Sign in to Claude");

      // Back unwinds rather than leaving the step: the row is a question again.
      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();

      expect(rowCentred()).toBe(false);
      expect(cta()).toBe("Next");
      expect(document.body.textContent).toContain("Connect a model");

      await act(async () => root.unmount());
    });

    it("submits the browser code on the paste, not on the first keystroke", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);

      const field = document.body.querySelector(
        'input[aria-label="Authorization code"]',
      ) as HTMLInputElement | null;
      expect(field, "the Claude card should offer a code field").toBeTruthy();

      // The trap this pins. `isValidBrowserCode` reads like a completeness
      // check and is not one — it accepts any printable ASCII from a single
      // character up — so an auto-submit keyed off the value fires here, on the
      // first character of anyone typing the code rather than pasting it, and
      // clears the field they are typing into.
      await act(async () => {
        setControlledValue(field!, "Q");
      });
      for (let i = 0; i < 4; i++) await flushReact();
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).not.toHaveBeenCalled();

      // The paste is the answer, so it goes without a press. Order matches a
      // real paste: the event lands before the value changes.
      await act(async () => {
        field!.dispatchEvent(new Event("paste", { bubbles: true }));
        setControlledValue(field!, "Q2RJ-E1YIF-authorization-code");
      });
      for (let i = 0; i < 4; i++) await flushReact();
      expect(mockAgentsApi.submitClaudeSetupTokenBrowserCode).toHaveBeenCalledWith(
        "company-new",
        "claude-session-1",
        "Q2RJ-E1YIF-authorization-code",
      );
      // And it stays on screen. Clearing the field on submit emptied it in the
      // same frame the paste landed, so the only feedback for the seconds that
      // followed was an input that had just gone blank — reported from staging
      // as the paste looking dropped, or the step looking stuck.
      expect(field!.value).toBe("Q2RJ-E1YIF-authorization-code");

      await act(async () => root.unmount());
    });

    it("starts the sign-in on the first press, even when it changes the adapter", async () => {
      // The regression this is here for. Picking a source sets the phase *and*
      // the adapter, and a reset keyed on the adapter then put the phase
      // straight back — so the first press did nothing and only a second one,
      // which changed no adapter and so woke no effect, was allowed to stand.
      //
      // It only showed when the chosen source differed from the one the draft
      // carried: picking the adapter already in state is a no-op React bails
      // out of, so every existing case here happened to miss it.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      expect(
        document.body
          .querySelector('[role="radiogroup"]')!
          .className.includes("justify-center"),
        "one press should have answered the row",
      ).toBe(true);

      await act(async () => root.unmount());
    });

    it("opens the OpenAI card's sign-in once the prompt lands", async () => {
      // The panel that shows a code owns its session and the wizard learns the
      // prompt's URL only by being told. When it was not told, the step waited
      // on a card that had already opened: the code sat on screen under a
      // button still reading "Next", disabled, with nothing left to wait for.
      //
      // The sibling test above stops at the login having started, which is why
      // this went unseen — and the harness could not see it either, since it
      // supplies the prompt itself rather than going through the panel.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);
      for (let i = 0; i < 6; i++) await flushReact();

      // The displayed-code panel is the one under test: if the row picked a
      // source the other panel serves, the rest of this proves nothing.
      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalled();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      const cta = [...document.body.querySelectorAll("button")].pop()!;
      expect(cta.textContent?.trim()).toBe("Sign in to OpenAI");
      // The code is the card's own content, and it arrives with the URL.
      expect(document.body.textContent).toContain("Q2RJ-E1YIF");
      // The button is the whole point: its destination is the URL the panel
      // reports, so an unreported prompt leaves it reading like an offer and
      // refusing the press. The label alone does not catch that — the phase can
      // reach `ready` before the signal resolves, which names the button
      // without enabling it.
      expect(cta.hasAttribute("disabled"), "the sign-in should be pressable").toBe(
        false,
      );

      await act(async () => root.unmount());
    });

    it("does not hire after Back interrupts the hold before step 5", async () => {
      // "Connecting" is held for two seconds so it reads as a state rather than
      // a flicker, and Back stays live throughout. The hire behind that hold
      // knows nothing about the phase, so a timer left running took a customer
      // who had just backed out to Review with an agent hired anyway.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      // A session the server has already authenticated, so the panel completes
      // and reports success on its own. The paste that normally gets it there
      // is the sibling test's subject; this one is about what the success does.
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        status: "authenticated",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      for (let i = 0; i < 8; i++) await flushReact();

      const cta = () =>
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim();
      expect(cta(), "success should have taken the button to the hold").toBe(
        "Connecting",
      );

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 10; i++) await flushReact();

      // Past the hold: whatever it was going to do, it has had its chance.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CONNECTED_HOLD_MS + 400));
      });
      for (let i = 0; i < 6; i++) await flushReact();

      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Connect a model");

      await act(async () => root.unmount());
    });

    it("shows no probe diagnostics between the sign-in succeeding and the step advancing", async () => {
      // Reported from staging: a block of amber diagnostics flashed up right
      // after a successful sign-in. They are the identity and target INFO
      // checks every run reports, which make the result a `warn` without
      // blocking anything — so they rendered for the window between the probe
      // returning and the step advancing, reading as an error thrown by the
      // sign-in that had just succeeded.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
        sessionId: "claude-session-1",
        status: "authenticated",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      mockAgentsApi.testEnvironment.mockResolvedValue({
        adapterType: "claude_local",
        status: "warn",
        checks: [
          {
            code: "environment_identity",
            level: "info",
            message: 'Environment test identity for "Paperclip Computer".',
            detail: "paperclipLeaseId=ff9e58e9; provider=daytona",
          },
        ],
        testedAt: new Date().toISOString(),
      });
      // Hold the hire open, which is the window the diagnostics appeared in:
      // the probe has returned but `loading` is not cleared until the `finally`
      // that runs after the step advances.
      let finishHire: (v: { agent: { id: string }; approval: null }) => void = () => {};
      mockAgentsApi.hire.mockReturnValue(
        new Promise((resolve) => {
          finishHire = resolve;
        }),
      );

      const { root } = await openStep4({ adapterType: "claude_local" });
      await pickSource(/Claude/);
      for (let i = 0; i < 8; i++) await flushReact();

      // Past the deliberate hold, so the hire is running and its probe is done.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CONNECTED_HOLD_MS + 400));
      });
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Environment test identity");
      expect(document.body.textContent).not.toContain("Warnings");
      // And the button goes on saying what is happening rather than going quiet.
      expect(
        [...document.body.querySelectorAll("button")].pop()?.textContent?.trim(),
      ).toBe("Connecting");

      await act(async () => finishHire({ agent: { id: "agent-1" }, approval: null }));
      for (let i = 0; i < 6; i++) await flushReact();

      await act(async () => root.unmount());
    });

    it("starts no login when Back interrupts the collapse", async () => {
      // Backing out before the card has opened has nothing to close. Unwinding
      // through the card beat regardless mounted the panel — which starts a
      // server login on mount — only for the unmount to cancel it, and a cancel
      // that fails holds the per-owner reservation until the server deadline,
      // so the retry the customer is about to make cannot start.
      //
      // The beats collapse to zero without a `matchMedia` to ask, which is why
      // this stubs one: the collapse has to still be running when Back lands.
      const realMatchMedia = window.matchMedia;
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
      try {
        mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
        const { root } = await openStep4({ adapterType: "claude_local" });

        await pickSource(/Claude/);
        // Still collapsing: the flushes above are microtasks and 0ms timers,
        // far inside the collapse's own duration.
        expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

        const back = [...document.body.querySelectorAll("button")].find((b) =>
          b.textContent?.trim().startsWith("Back"),
        );
        await act(async () => {
          back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        for (let i = 0; i < 10; i++) await flushReact();
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        });
        for (let i = 0; i < 6; i++) await flushReact();

        expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Connect a model");

        await act(async () => root.unmount());
      } finally {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: realMatchMedia,
        });
      }
    });

    it("starts the codex_local sign-in on Connect when the signal cannot decide", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "codex_local" });

      expect(mockAgentsApi.startAdapterAuthLogin).not.toHaveBeenCalled();

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalled();
      expect(mockAgentsApi.hire).not.toHaveBeenCalled();
      // The displayed-code login hands a code over rather than taking one back,
      // so both halves of it have to reach the screen.
      expect(document.body.textContent).toContain(
        "Sign in to OpenAI by providing the authorization code below",
      );
      expect(document.body.textContent).toContain("Q2RJ-E1YIF");

      // The link lives inside the sentence now rather than in a row of its own,
      // and points at the same address the step's button opens — it is the
      // path for anyone finishing the sign-in in another browser.
      const link = document.body.querySelector('a[href*="auth.openai.com"]');
      expect(link, "the sign-in link should be in the instruction").toBeTruthy();
      expect(link!.textContent).toBe("Sign in to OpenAI");

      // And the code sits below the sentence carrying it.
      const code = [...document.body.querySelectorAll("span")].find(
        (el) => el.textContent?.trim() === "Q2RJ-E1YIF",
      );
      expect(code, "the code row should render").toBeTruthy();
      expect(
        link!.compareDocumentPosition(code!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the code should follow the sentence that links to the sign-in",
      ).toBeTruthy();

      await act(async () => root.unmount());
    });

    it("shows the failure instead of starting a codex_local login when the active-session read fails", async () => {
      // A transient active-session lookup failure is not proof that no
      // session exists — only a successful lookup that resolves to null is.
      // The step must not start a second login the server would reject
      // against the per-owner cap; it shows the failure instead.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockRejectedValue(
        new ApiError("Service unavailable", 503, null),
      );
      const { root } = await openStep4({ adapterType: "codex_local" });

      await pickSource(/OpenAI/);

      expect(mockAgentsApi.startAdapterAuthLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Service unavailable");

      await act(async () => root.unmount());
    });

    it("shows the failure instead of starting a claude_local login when the active-session read fails", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(
        new ApiError("Service unavailable", 503, null),
      );
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);

      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Service unavailable");

      await act(async () => root.unmount());
    });

    it("resumes the same claude_local session after Back, rather than starting a second", async () => {
      // This is the behaviour that makes the card's Cancel removable. Back only
      // hides the card — it deliberately does not release the session — so
      // coming back has to adopt the one already running. If it started a
      // fresh one instead, the removed Cancel would have been the only way out
      // of a login the customer could no longer reach, and the per-owner cap
      // would reject the second start.
      const session = {
        sessionId: "claude-session-1",
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      let started = false;
      mockAgentsApi.startClaudeSetupTokenLogin.mockImplementation(async () => {
        started = true;
        return session;
      });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockReset();
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(async () =>
        started ? session : null,
      );
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);
      // The login is genuinely running: without this the assertion below holds
      // for the wrong reason.
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      await pickSource(/Claude/);
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.getActiveClaudeSetupTokenLoginSession).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("resumes the same codex_local session after Back, rather than starting a second", async () => {
      const session = { sessionId: "codex-session-1", status: "pending" };
      let started = false;
      mockAgentsApi.startAdapterAuthLogin.mockImplementation(async () => {
        started = true;
        return session;
      });
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockReset();
      mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(async () =>
        started ? session : null,
      );
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "unknown" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/OpenAI/);
      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      await pickSource(/OpenAI/);
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.getActiveAdapterAuthLoginSession).toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("starts the other source's login after backing out of the first", async () => {
      // The abandonment case, raised in review against removing the card's
      // Cancel: with no explicit release, does a source switch still get a
      // login? It does. The server's lease is keyed on the adapter type as
      // well as the company and environment, so the abandoned Claude session
      // does not stand in the way of a Codex one — and it is collected on its
      // own five-minute timer regardless (DEVICE_LOGIN_TIMEOUT_MS), with the
      // reaper as the restart-safe backstop.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      await pickSource(/Claude/);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().startsWith("Back"),
      );
      await act(async () => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      for (let i = 0; i < 12; i++) await flushReact();

      await pickSource(/OpenAI/);
      for (let i = 0; i < 8; i++) await flushReact();

      expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(1);

      await act(async () => root.unmount());
    });

    it("hires on Connect, with no sign-in, when the signal reports a ready credential", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "present" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      // Answer the row, then press: with a credential already in place there is
      // no sign-in to run, so the button goes straight to the hire.
      await pickSource(/Claude/);
      await pressArcPrimary();

      // The positive half is what makes this a test: a source that is already
      // signed in goes straight to the hire, so Connect keeps its old meaning
      // wherever there is no sign-in to do. Asserting only the absence of a
      // card would pass just as well if the button had stopped working.
      expect(mockAgentsApi.hire).toHaveBeenCalled();
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it("renders no 'Use saved login' control", async () => {
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      expect(document.body.textContent).not.toContain("Use saved login");
      await act(async () => root.unmount());
    });

    it("reads the signal again after an adapter change", async () => {
      mockAdapterRegistry.list = [{ type: "claude_local" }, { type: "codex_local" }];
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });

      expect(mockAgentsApi.getAdapterAuthSignal).toHaveBeenCalledWith(
        "company-new",
        "claude_local",
        "env-sandbox-1",
      );

      const clickByText = async (match: (text: string) => boolean) => {
        const el = [...document.body.querySelectorAll("button")].find((b) =>
          match(b.textContent?.trim() ?? ""),
        )!;
        await act(async () => {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flushReact();
      };

      // Straight to the tile. The adapter change used to be reached through an
      // "Advanced settings" disclosure listing every non-recommended adapter;
      // the step now offers Claude and Codex as tiles and spends that line on
      // the credential switch instead. What is asserted below is unchanged —
      // changing the source re-reads the signal — only the route there is.
      // The tile's text is the label plus its credential tag, hence the prefix.
      // That label is the provider name now, not the adapter type: this row
      // asks which provider you are signing in to, so it reads through
      // `MODEL_SOURCE_NAMES` rather than the display registry.
      await clickByText((t) => t.startsWith("OpenAI"));

      expect(mockAgentsApi.getAdapterAuthSignal).toHaveBeenCalledWith(
        "company-new",
        "codex_local",
        "env-sandbox-1",
      );

      await act(async () => root.unmount());
    });

    it("hides the panel when the resolved login environment driver is not sandbox", async () => {
      mockEnvironmentsApi.list.mockResolvedValue([LOCAL_ENVIRONMENT]);
      mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      const { root } = await openStep4({ adapterType: "claude_local" });
      expect(document.body.textContent).not.toContain("Sign in to Anthropic");
      expect(mockAgentsApi.getAdapterAuthSignal).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });

    it("restores the started-login state after a reload, resuming the active session with no press", async () => {
      // A reload loses `connectPhase` — the draft deliberately does not carry
      // it, because a login is a live server session with a deadline, not
      // wizard state to replay blindly. The step must instead re-derive it
      // from the caller's active session, so a customer who reloads mid-login
      // sees their sign-in still running rather than the tile row again.
      mockAgentsApi.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
      mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockResolvedValue({
        sessionId: "claude-session-1",
        environmentId: "env-sandbox-1",
        status: "waiting_for_user",
        expiresAt: null,
        failure: null,
        panelMode: "submitted_browser_code",
        prompt: { authorizationUrl: "https://claude.ai/oauth/authorize?code=true" },
      });
      const { root } = await openStep4({ adapterType: "claude_local" });
      // A reload's resume now runs one layer deeper than a fresh press: the
      // step's own active-session read has to land before it opens the
      // sequence, and only then does the mounted panel run its own resume
      // read. Each is a further round trip `flushReact` has to catch up to.
      for (let i = 0; i < 10; i += 1) await flushReact();

      // No press: the resumed session is discovered on load and the card
      // shows the login already running.
      expect(mockAgentsApi.startClaudeSetupTokenLogin).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Sign in to Claude then come back and enter authorization code",
      );

      await act(async () => root.unmount());
    });
  });
});
