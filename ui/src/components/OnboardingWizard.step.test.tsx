// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { ONBOARDING_AGENT_STEP } from "../lib/onboarding-route";

/**
 * Which step the onboarding wizard *lands on*, and what is allowed to move it
 * afterwards.
 *
 * These are seam tests on purpose. `initialStep` is derived from two queries
 * and consumed by an effect that calls `setStep`, and every defect this file
 * guards lived in that seam rather than in either side of it — the pure
 * helpers in `onboarding-route.test.ts` passed while the wizard was moving a
 * customer off the step they were typing on. So the real component is rendered
 * here, with the real route resolver, and only the network and the surrounding
 * contexts are stubbed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const mockAdaptersApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({
  create: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  instructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  testEnvironment: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));
const mockCompaniesApi = vi.hoisted(() => ({ create: vi.fn() }));
// The hire path resolves the Test environment before it probes: it reads the
// environment list, the instance settings, and the experimental settings. The
// test stubs these so the resolution settles on the local default, the same as
// a real run with no instance default.
const mockEnvironmentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));

const routerState = vi.hoisted(() => ({ pathname: "/" }));
const dialogState = vi.hoisted(() => ({
  onboardingOpen: false,
  onboardingOptions: {} as { initialStep?: number; companyId?: string },
  onboardingRouteDismissed: false,
  closeOnboarding: vi.fn(),
  setOnboardingRouteDismissed: vi.fn(),
}));
const companyState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", name: "Acme", issuePrefix: "PC1" },
    { id: "company-2", name: "Globex", issuePrefix: "PC2" },
  ],
  loading: false,
  setSelectedCompanyId: vi.fn(),
}));

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("@/api/adapters", () => ({ adaptersApi: mockAdaptersApi }));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: { create: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { create: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(), create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: routerState.pathname }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

// Canvas/animation leaves — nothing to do with the step machinery.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

const { OnboardingWizard } = await import("./OnboardingWizard");

/** The agent step renders this input; the org-name step ("other") does not. */
function currentStep(): "agent" | "closed" | "other" {
  const body = document.body;
  if (!body.querySelector("[role='dialog'], .fixed.inset-0")) return "closed";
  // Keyed on the name field, which is the agent step's only control now that
  // the role picker is gone.
  if (body.querySelector("#onboarding-agent-name")) return "agent";
  return "other";
}

/** Type into a controlled React input without a full user-event dependency. */
function setControlledValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const COMPANY_GOAL = {
  id: "goal-1",
  companyId: "company-1",
  title: "Ship the thing",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-02T00:00:00Z"),
  updatedAt: new Date("2026-03-02T00:00:00Z"),
};

describe("OnboardingWizard — which step it lands on", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: Root | null = null;

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
  }

  /** Re-render after mutating the stubbed contexts or the location. */
  async function rerender() {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizard />
        </QueryClientProvider>,
      );
    });
  }

  // React Query resolves through microtasks and React schedules the re-render
  // after them, so a single tick is not reliably enough under load. Several
  // ticks cost microseconds and remove the ordering sensitivity.
  async function settle(ticks = 12) {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The wizard restores its step from localStorage, so a step left behind by
    // an earlier case would decide the next one.
    localStorage.clear();
    routerState.pathname = "/";
    dialogState.onboardingOpen = false;
    dialogState.onboardingOptions = {};
    dialogState.onboardingRouteDismissed = false;
    mockAdaptersApi.list.mockResolvedValue([]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    // The hire step lists the company's agents first so it can adopt one that
    // already carries the typed name instead of hiring a duplicate.
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
    mockAgentsApi.instructionsBundle.mockResolvedValue({ entryFile: "AGENTS.md" });
    mockAgentsApi.saveInstructionsFile.mockResolvedValue({});
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date("2026-03-02T00:00:00Z").toISOString(),
    });
    // Onboarding applies a stored Claude login automatically; this suite is
    // not testing that path, so default to "no stored value" (the route's
    // fixed 404) so the hire path behaves as it did before that feature.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockRejectedValue(
      new ApiError("Not found", 404, null),
    );
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableManagedSandboxOnly: false,
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  /**
   * The progress strip counts the walk the customer is actually on, and the two
   * runs that enter on the agent step are on different walks.
   *
   * Both have a company already, so `entryStep` cannot tell them apart. What
   * does is `enableManagedSandboxOnly` — the cloud-tenant shape. A cloud tenant
   * was asked for its organization's name by Cloud, one screen earlier, so its
   * walk is four and this is the second. A self-hosted company that simply has
   * no agents yet was asked nothing before this, so its walk is three.
   */
  describe("progress strip length", () => {
    function announcedCount(): string | null {
      return (
        [...document.querySelectorAll(".sr-only")]
          .map((element) => element.textContent?.trim() ?? "")
          .find((text) => /^Step \d+ of \d+$/.test(text)) ?? null
      );
    }

    it("counts four on a cloud tenant, continuing the count Cloud started", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableManagedSandboxOnly: true,
      });
      routerState.pathname = "/PC1/onboarding";
      await render();
      await settle();

      expect(currentStep()).toBe("agent");
      expect(announcedCount()).toBe("Step 2 of 4");
    });

    it("counts three on a self-hosted company that has no agents yet", async () => {
      // Nothing was asked before this step here, so a fourth segment would be
      // one the run can never fill — and it would credit the customer with a
      // step they never walked.
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableManagedSandboxOnly: false,
      });
      routerState.pathname = "/PC1/onboarding";
      await render();
      await settle();

      expect(currentStep()).toBe("agent");
      expect(announcedCount()).toBe("Step 1 of 3");
    });
  });

  it("opens a company that already has its mission on the agent step", async () => {
    // The point of the change: Cloud collected the mission at signup and the
    // seed wrote it as a company-level goal, so asking for it again asks a
    // question the customer answered minutes earlier on another origin.
    routerState.pathname = "/PC1/onboarding";
    mockGoalsApi.list.mockResolvedValue([COMPANY_GOAL]);
    await render();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  // Four tests lived here, and all four were about one thing: the landing step
  // was derived from the company's goals, so every state of that lookup —
  // pending, failed, resolved, resolved-again-with-a-different-answer — could
  // move the customer. Onboarding no longer asks for the mission, so the step
  // no longer reads the goals at all and those four states collapse into one
  // assertion. Kept as three cases rather than one because the property worth
  // defending is that *none* of them reaches the wizard, which a single happy
  // path would not show.
  it("opens on the agent step without waiting for the goals lookup", async () => {
    // This used to stay closed until the lookup settled, because the step it
    // would have picked depended on the answer. Waiting now only delays the open.
    routerState.pathname = "/PC1/onboarding";
    mockGoalsApi.list.mockReturnValue(new Promise(() => {}));
    await render();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  it("opens on the agent step when the goals lookup fails outright", async () => {
    routerState.pathname = "/PC1/onboarding";
    mockGoalsApi.list.mockRejectedValue(new Error("goals unavailable"));
    await render();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  it("does not move an open wizard when a later refetch finds a mission", async () => {
    // The defect this file exists for, in its current form. A refetch landing
    // mid-flow used to flip the derived step from 2 to 3 and move the customer
    // mid-sentence. Nothing derives the step from goals any more, so the answer
    // changing is not an event the wizard can see — which is what this asserts.
    routerState.pathname = "/PC1/onboarding";
    mockGoalsApi.list.mockRejectedValue(new Error("goals unavailable"));
    await render();
    await settle();
    expect(currentStep()).toBe("agent");

    await act(async () => {
      queryClient.setQueryData(queryKeys.goals.list("company-1"), [COMPANY_GOAL]);
    });
    await settle();

    expect(currentStep()).toBe("agent");
  });

  it("does not move an open wizard when the dialog is re-opened with a new step", async () => {
    // The dashboard's auto-open sits behind queries too, so a refetch can call
    // `openOnboarding` again with a different step for the same company. The
    // wizard belongs to the customer by then, so the sync effect keys on the
    // company: the same company re-deciding a fresher step must not move them.
    dialogState.onboardingOpen = true;
    dialogState.onboardingOptions = {
      companyId: "company-1",
      initialStep: ONBOARDING_AGENT_STEP,
    };
    await render();
    await settle();
    expect(currentStep()).toBe("agent");

    dialogState.onboardingOptions = {
      companyId: "company-1",
      initialStep: 5,
    };
    await rerender();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  it("re-decides the company when the route names a different one", async () => {
    // The step is the same either way now; the company is not, and a route that
    // names a new one is still a new request.
    routerState.pathname = "/PC1/onboarding";
    await render();
    await settle();
    expect(currentStep()).toBe("agent");

    routerState.pathname = "/PC2/onboarding";
    await rerender();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  it("withdraws a company the wizard created once the route stops naming it", async () => {
    // The route only introduces a company when it names one the wizard is not
    // already holding, so a company the wizard *created* was never recorded as
    // route-owned and was never withdrawn. Visiting its own onboarding path and
    // then `/onboarding` left the wizard showing "create an organization" while
    // still holding it — and the next confirmation wrote into the old company.
    mockCompaniesApi.create.mockResolvedValue({ id: "company-1", issuePrefix: "PC1" });
    mockGoalsApi.create.mockResolvedValue({ id: "goal-company-1" });
    routerState.pathname = "/onboarding";
    await render();
    await settle();

    const nameInput = document.body.querySelector("input")! as HTMLInputElement;
    setControlledValue(nameInput, "Acme");
    await settle();
    await act(async () => {
      [...document.body.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Continue")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    await settle();
    expect(mockCompaniesApi.create).toHaveBeenCalled();
    expect(currentStep()).toBe("agent");

    // Its own onboarding path, then back to the unprefixed one.
    routerState.pathname = "/PC1/onboarding";
    await rerender();
    await settle();
    routerState.pathname = "/onboarding";
    await rerender();
    await settle();

    // Back at the organization-name step with nothing carried over.
    const nameAfter = document.body.querySelector("input") as HTMLInputElement | null;
    expect(nameAfter?.value).toBe("");
  });

  it("does not adopt a company it created once a route has supplied one", async () => {
    // The same guard from the other end. Nothing was in hand when the create
    // started, so "unchanged" means still nothing. A route that supplied a
    // company while the request was open has taken over the wizard, and
    // adopting the new company would fight it — and would leave the customer
    // on a company they never navigated to.
    let resolveCreate: (company: { id: string; issuePrefix: string }) => void = () => {};
    mockCompaniesApi.create.mockReturnValue(
      new Promise<{ id: string; issuePrefix: string }>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    routerState.pathname = "/onboarding";
    await render();
    await settle();

    // Step 1 creates the company on its own now — the mission step used to do
    // it, and no longer runs.
    const nameInput = document.body.querySelector("input")! as HTMLInputElement;
    setControlledValue(nameInput, "Initech");
    await settle();
    const next = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Continue",
    )!;
    await act(async () => {
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // A route supplies an existing company before the create lands.
    routerState.pathname = "/PC1/onboarding";
    await rerender();
    await settle();
    expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Initech" });
    await act(async () => resolveCreate({ id: "company-created", issuePrefix: "INI" }));
    await settle();

    // Adopting the created company would select it globally and take the
    // customer off the one they navigated to. The selection call is the
    // assertion; it always was, and the author of this test said so.
    //
    // The rendered name used to back it up, but the wizard lands on the agent
    // step now and that step names no company. Anchored on the step instead, so
    // a selection call that never happened because nothing rendered would fail
    // here rather than read as a pass.
    expect(currentStep()).toBe("agent");
    expect(companyState.setSelectedCompanyId).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Organization created, but onboarding switched to another organization.",
    );
  });

  it("finishes advancing when the returned company was already adopted", async () => {
    // The company-created live update can make the surrounding app adopt the
    // returned company before the POST continuation runs. That is not a
    // different-company takeover: both signals name the same company, so
    // dropping the continuation leaves the customer on the name step even
    // though the organization now exists.
    let resolveCreate: (company: { id: string; issuePrefix: string }) => void = () => {};
    mockCompaniesApi.create.mockReturnValue(
      new Promise<{ id: string; issuePrefix: string }>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    routerState.pathname = "/onboarding";
    await render();
    await settle();

    const nameInput = document.body.querySelector("input")! as HTMLInputElement;
    setControlledValue(nameInput, "Initech");
    await settle();
    const next = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue",
    )!;
    await act(async () => {
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Model the surrounding app adopting exactly the company that the pending
    // request is about, without choosing a new step on the wizard's behalf.
    dialogState.onboardingOpen = true;
    dialogState.onboardingOptions = { companyId: "company-created" };
    await rerender();
    await settle();

    await act(async () => resolveCreate({ id: "company-created", issuePrefix: "INI" }));
    await settle();

    expect(currentStep()).toBe("agent");
    expect(companyState.setSelectedCompanyId).toHaveBeenCalledWith("company-created");
    expect(mockCompaniesApi.create).toHaveBeenCalledTimes(1);
  });

  it("applies the step again when the wizard is re-opened", async () => {
    // Same guard, from the other side: closing and re-opening is a new
    // request, so a freeze that outlived the open would be its own defect. It
    // opens on step 1, closes, then re-opens on the agent step — the re-open
    // has to apply the fresh step rather than stay where the first one left it.
    dialogState.onboardingOpen = true;
    dialogState.onboardingOptions = {
      companyId: "company-1",
      initialStep: 1,
    };
    await render();
    await settle();
    expect(currentStep()).toBe("other");

    dialogState.onboardingOpen = false;
    await rerender();
    expect(currentStep()).toBe("closed");

    dialogState.onboardingOpen = true;
    dialogState.onboardingOptions = {
      companyId: "company-1",
      initialStep: ONBOARDING_AGENT_STEP,
    };
    await rerender();
    await settle();

    expect(currentStep()).toBe("agent");
  });

  describe("an existing company opened on the agent step", () => {
    // It opens on the agent step, so step 1 never runs. The wizard hires the
    // first agent there — the mission it once seeded from is now the server's.

    const MISSION_GOAL = {
      ...COMPANY_GOAL,
      title: "Scale the marketplace",
      description: "Reach 1000 sellers",
    };

    async function openOnAgentStep() {
      routerState.pathname = "/PC1/onboarding";
      mockGoalsApi.list.mockResolvedValue([MISSION_GOAL]);
      await render();
      await settle();
      expect(currentStep()).toBe("agent");
    }

    /**
     * Name the agent. The role picker is gone — the arc asks for a name and
     * hires with the neutral `general` role — so advancing from step 3 means
     * putting something in the one field it has.
     */
    async function nameAgent(name = "Ada") {
      const field = document.getElementById("onboarding-agent-name") as HTMLInputElement;
      expect(field, "the agent step should render its name field").toBeTruthy();
      setControlledValue(field, name);
      // Settle twice so the connect step's queries resolve before the press.
      await settle();
      await settle();
    }

    async function press(button: Element) {
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();
    }

    /**
     * The step's own CTA. By exact text, because "Back" sits beside it.
     *
     * Two labels rather than one: the connect step calls its forward button
     * "Connect", since there the press starts a sign-in rather than simply
     * advancing. The rest of the arc still says "Next". These tests are about
     * where a press lands, so either will do.
     */
    function stepCta(): HTMLButtonElement {
      const cta = [...document.body.querySelectorAll("button")].find((b) => {
        const text = b.textContent?.trim();
        return text === "Next" || text === "Connect";
      });
      expect(cta, "the step should render its forward button").toBeTruthy();
      return cta as HTMLButtonElement;
    }

    /**
     * Pick a model source. The connect step arrives with nothing chosen, so its
     * CTA stays disabled until a tile is pressed — found by `aria-checked`
     * rather than by label, because this suite mocks the display registry and
     * the tiles carry whatever it happens to return.
     */
    async function pickModelSource() {
      const tiles = [...document.body.querySelectorAll("button[aria-checked]")];
      expect(tiles.length, "the connect step should offer a source").toBeGreaterThan(0);
      await press(tiles[0]!);
    }

    it("hires under the neutral role, with the name the customer typed", async () => {
      // The arc stopped asking for a role, so every onboarding hire is filed
      // as `general` — and the hire guard returns *silently* when the role is
      // missing, which is exactly how removing the picker could have shipped a
      // Connect button that hires nobody. This is the test that catches that.
      await openOnAgentStep();
      await nameAgent("Ada");

      await press(stepCta());
      await pickModelSource();
      await press(stepCta());

      expect(mockAgentsApi.hire).toHaveBeenCalled();
      const [, payload] = mockAgentsApi.hire.mock.calls.at(-1)!;
      expect(payload.role).toBe("general");
      expect(payload.name).toBe("Ada");
    });

    it("does not offer a way back behind the step it entered on", async () => {
      // Step 1 creates a company. A run that already holds one must not be
      // able to walk into it, by the Back button or the progress bar.
      await openOnAgentStep();

      const back = [...document.body.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Back"),
      );
      expect(back).toBeUndefined();

      // The progress strip's segments are the only jump controls on this
      // screen. Entering here means there is nowhere behind to return to, so
      // every one of them is inert — asserted over the whole set rather than
      // one segment, since a single enabled one is the whole defect.
      const segments = [...document.body.querySelectorAll("button")].filter((b) =>
        ["Create your first agent", "Connect a model", "Review"].includes(
          b.getAttribute("aria-label") ?? "",
        ),
      ) as HTMLButtonElement[];
      expect(segments).toHaveLength(3);
      expect(segments.every((segment) => segment.disabled)).toBe(true);

      // And company creation is genuinely unreachable, not merely unlinked.
      expect(document.body.textContent).not.toContain("Name your organization");
    });
  });
});
