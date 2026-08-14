// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

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
  testEnvironment: vi.fn(async () => ({
    adapterType: "claude_local",
    status: "pass" as const,
    checks: [],
    testedAt: new Date().toISOString(),
  })),
  hire: vi.fn(async () => ({ agent: { id: "agent-1" }, approval: null })),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
}));
const mockApprovalsApi = vi.hoisted(() => ({
  create: vi.fn(),
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
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
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
}));
vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => mockAdapterRegistry.disabled,
  // Added by #11371's adapter snap. A module mock replaces the whole module,
  // so every export the component reaches for has to be here — omitting one
  // makes it undefined and the call throws.
  useAdapterRegistryLoaded: () => true,
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

import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { ONBOARDING_STORAGE_KEY, OnboardingWizard } from "./OnboardingWizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { container, root, queryClient };
}

describe("OnboardingWizard restore-gate (stale localStorage across accounts)", () => {
  beforeEach(() => {
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
      'input[placeholder="Chief of staff"]',
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Ops Lead");
    const currentStep = document.body.querySelector('[aria-current="step"]');
    expect(currentStep?.getAttribute("aria-label")).toBe("Step 3");

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
    expect(document.body.textContent).not.toBe("");
    // The draft is not restored, because ownership cannot be verified...
    const nameInput = document.body.querySelector(
      'input[placeholder="Chief of staff"]',
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
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(deny);
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(deny);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(deny);
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

    expect(getItem).toHaveBeenCalled();
    // It mounted: the wizard is open with no draft, rather than the render
    // throwing on the way in.
    expect(document.body.textContent).not.toBe("");

    getItem.mockRestore();
    removeItem.mockRestore();
    setItem.mockRestore();
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
    expect(document.body.textContent).not.toBe("");
    // ...but the draft was not restored, because the list cannot be trusted.
    const nameInput = document.body.querySelector(
      'input[placeholder="Chief of staff"]',
    ) as HTMLInputElement | null;
    expect(nameInput?.value ?? "").not.toBe("Ops Lead");

    await act(async () => {
      root.unmount();
    });
  });
  it("closes without throwing when the browser denies storage access", async () => {
    // `reset()` clears the draft and `handleClose` calls it, so the close
    // button is a fourth storage call site. Guarding the read, the cleanup and
    // the persist effect one at a time is how this one stayed unguarded while
    // the others looked fixed.
    const deny = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(deny);
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(deny);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(deny);
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

    const close = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Close"),
    );
    expect(close).toBeDefined();
    await act(async () => {
      close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockDialog.closeOnboarding).toHaveBeenCalled();

    getItem.mockRestore();
    removeItem.mockRestore();
    setItem.mockRestore();
    await act(async () => {
      root.unmount();
    });
  });
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
      'input[placeholder="Chief of staff"]',
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
    expect(document.body.textContent).not.toBe("");
    expect(document.body.textContent).not.toContain("A's Lead");
    const nameInput = document.body.querySelector(
      'input[placeholder="Chief of staff"]',
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
    queryClient.setQueryData(queryKeys.companies.all, {
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
    expect(document.body.textContent).not.toBe("");
    expect(document.body.textContent).not.toContain("A's Lead");
    const nameInput = document.body.querySelector(
      'input[placeholder="Chief of staff"]',
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
    queryClient.setQueryData(queryKeys.companies.all, {
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
});
