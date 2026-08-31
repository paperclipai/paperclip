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

vi.mock("../api/companies", () => ({
  companiesApi: {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    detachInflightList: vi.fn(),
  },
}));
vi.mock("../adapters", () => ({
  listUIAdapters: () => mockAdapterRegistry.list,
  getUIAdapter: () => ({ buildAdapterConfig: () => ({}) }),
}));
vi.mock("../adapters/metadata", () => ({ isVisualAdapterChoice: () => true }));
vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (type: string) => ({
    type,
    recommended: false,
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
    supportsModelProfiles: false,
  }),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./FrontDoor", () => ({ FrontDoor: () => null }));
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
});
