// @vitest-environment jsdom
import { ApiError } from "@/api/api-error";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_LOOSE_WORK,
  fundraisingBehind,
  homeOverviewFixture,
  lpUpdatesStale,
  portfolioOnTrack,
  proposedDealFlow,
  responsibilityFixture,
  responsibilityOverviewFixture,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
} from "../../storybook/fixtures/responsibilities";
import { Responsibilities } from "./Responsibilities";

const api = vi.hoisted(() => ({ overview: vi.fn(), update: vi.fn(), link: vi.fn(), create: vi.fn() }));
const issuesApi = vi.hoisted(() => ({ update: vi.fn() }));
const routinesApi = vi.hoisted(() => ({ update: vi.fn() }));
const projectsApi = vi.hoisted(() => ({ update: vi.fn() }));
const areasApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
const agentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const authApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const autoOpen = vi.hoisted(() => vi.fn());
const breadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api, responsibilityAreasApi: areasApi }));
vi.mock("@/api/agents", () => ({ agentsApi }));
vi.mock("@/api/auth", () => ({ authApi }));
vi.mock("@/api/issues", () => ({ issuesApi }));
vi.mock("@/api/routines", () => ({ routinesApi }));
vi.mock("@/api/projects", () => ({ projectsApi }));
vi.mock("@/hooks/useAgentlessOnboardingAutoOpen", () => ({ useAgentlessOnboardingAutoOpen: autoOpen }));
// The chat composer at the foot of the page has its own tests.
vi.mock("@/components/responsibilities/DashboardChatComposer", () => ({ DashboardChatComposer: () => <div data-dashboard-chat-stub="" /> }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs }) }));
const location = vi.hoisted(() => ({ search: "" }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/responsibilities", search: location.search, hash: "", state: null, key: "default" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const guide = { id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, companyId: "company-storybook", name: "CTO", urlKey: "cto", status: "idle" } as Agent;
const codex = { id: "agent-codex", companyId: "company-storybook", name: "CodexCoder", urlKey: "codexcoder", status: "idle" } as Agent;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const text = () => host.textContent ?? "";
const section = (heading: string) =>
  [...host.querySelectorAll("section")].find((node) => node.querySelector("h2, h3")?.textContent?.startsWith(heading)) as HTMLElement | undefined;
const buttonByText = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
const rowFor = (id: string) => host.querySelector<HTMLElement>(`li[data-responsibility-id="${id}"]`);

async function render(primaryAgent: Agent | null = guide) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <PrimaryAgentPresentationProvider
            value={{ companyId: "company-storybook", primaryAgentId: primaryAgent?.id ?? null, primaryAgent, onChange: () => {} }}
          >
            <Responsibilities />
          </PrimaryAgentPresentationProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(RESPONSIBILITY_FIXTURE_NOW);
  vi.clearAllMocks();
  // These tests cover the full layout, which the Dashboard shows only when the address names it.
  location.search = "?view=full";
  agentsApi.list.mockResolvedValue([guide, codex]);
  authApi.getSession.mockResolvedValue({ user: { id: "user-storybook" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
});

describe("Responsibilities home", () => {
  it("shows a failed read of the agents with Retry where the chat would be", async () => {
    agentsApi.list.mockRejectedValue(new ApiError("Not allowed", 403, { error: "forbidden" }));
    await render();
    const dock = host.querySelector('[data-dashboard-chat-dock=""]')!;
    expect(dock.querySelector('[data-query-view="error"]')).not.toBeNull();
  });

  it("keeps the chat composer, and its draft, mounted when a refresh of the agents fails", async () => {
    await render();
    const composer = host.querySelector('[data-dashboard-chat-stub=""]');
    expect(composer).not.toBeNull();
    agentsApi.list.mockRejectedValue(new ApiError("Server error", 500, { error: "internal" }));
    await act(async () => { await client.refetchQueries(); });
    await flush();
    const dock = host.querySelector('[data-dashboard-chat-dock=""]')!;
    expect(dock.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(dock.querySelector('[data-dashboard-chat-stub=""]')).toBe(composer);
  });

  it("is titled Dashboard and offers onboarding to an agentless company", async () => {
    api.overview.mockResolvedValue(responsibilityOverviewFixture([portfolioOnTrack]));
    await render();
    expect(breadcrumbs).toHaveBeenCalledWith([{ label: "Dashboard" }]);
    expect(autoOpen).toHaveBeenCalled();
    expect(host.querySelector("h1")?.textContent).toBe("Dashboard");
    expect(text()).toContain("What you own, whether each one is meeting its bar, and the work underneath.");
  });

  it("orders the page: what you own and where things stand, what needs you, the areas, then the rest", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    const headings = [...host.querySelectorAll("h2, h3")]
      .map((node) => node.textContent ?? "")
      .filter((label) => /^(What you own|Where things stand|Needs you|Fundraising|Running without you|Outside your responsibilities)/.test(label))
      .map((label) => label.replace(/\d.*$/, ""));
    expect(headings).toEqual([
      "What you own",
      "Where things stand",
      "Needs you",
      "Fundraising",
      "Running without you",
      "Outside your responsibilities",
    ]);
  });

  it("groups what you own under area headings, with no-area last", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    const owned = section("What you own")!;
    const groups = [...owned.querySelectorAll("[data-area-group]")];
    expect(groups.map((group) => group.querySelector("h3 span")?.textContent)).toEqual(["Fundraising", "Portfolio", "Team", "Not in an area"]);
    // Behind before at risk within an area.
    expect([...groups[0]!.querySelectorAll("li[data-responsibility-id]")].map((row) => row.getAttribute("data-responsibility-id")))
      .toEqual([fundraisingBehind.id, lpUpdatesStale.id]);
    // Areas carry no status of their own.
    expect(groups[0]!.querySelector("h3")?.textContent).not.toMatch(/Behind|At risk|On track/);
  });

  it("shows each responsibility's status, sentence, number against target, signals and the agents on it", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    const row = rowFor(fundraisingBehind.id)!;
    expect(row.querySelector('a[href="/responsibilities/resp-fundraising"]')?.textContent).toBe("Seed extension");
    expect(row.textContent).toContain("Behind");
    expect(row.textContent).toContain("9 of 20 investors contacted, 45% of target");
    expect(row.querySelector('[aria-label="9 of 20 investors contacted"]')?.textContent).toBe("9of 20");
    expect(row.textContent).toContain("Investor update deck is 3 days past its target date");
    expect(row.textContent).toContain("Get the cap table from counsel is blocked");
    expect(row.textContent).not.toContain("2 open tasks with CodexCoder");
    expect(row.querySelector('[aria-label="Agents on this: CodexCoder"]')).not.toBeNull();
    // Nothing on the page hands a whole responsibility to an agent.
    expect(host.textContent).not.toMatch(/Run by (?!an agent)/);

    const stale = rowFor(lpUpdatesStale.id)!;
    expect(stale.textContent).toContain("At risk");
    expect(stale.textContent).toContain("36 days");
    expect(stale.textContent).toContain("vs. at most 30 days");
    expect(stale.textContent).toContain("Not updated in 19 days");
    expect(stale.textContent).toContain("No agents on this yet");

    expect(rowFor("resp-hiring")!.textContent).toContain("No reading yet");
    expect(rowFor("resp-board-reporting")!.querySelector('[title="Set by hand"]')?.textContent).toContain("At risk");
  });

  it("keeps areas where you own nothing behind one quiet line", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    expect(text()).not.toContain("Legal");
    const more = buttonByText("1 more area in the company")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(text()).toContain("Legal");
    expect(text()).toContain("Areas the company cares about where you own nothing yet.");
  });

  it("filters what you own by a status count", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    const owned = section("What you own")!;
    const counts = [...owned.querySelectorAll('[role="group"] button')].map((button) => button.textContent);
    expect(counts).toEqual(["Behind1", "At risk2", "On track1", "Not measured1"]);
    const onTrack = [...owned.querySelectorAll('[role="group"] button')].find((button) => button.textContent?.startsWith("On track"))!;
    await act(async () => (onTrack as HTMLButtonElement).click());
    expect(onTrack.getAttribute("aria-pressed")).toBe("true");
    expect([...owned.querySelectorAll("li[data-responsibility-id]")].map((row) => row.getAttribute("data-responsibility-id")))
      .toEqual([portfolioOnTrack.id]);
    expect(owned.textContent).toContain("Showing only on track.");
  });

  it("lists what needs you: the named project or task can be given to an agent, anything else becomes a new task", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    issuesApi.update.mockResolvedValue({ id: "task-blocked" });
    await render();
    const needs = section("Needs you")!;
    expect(needs.textContent).toContain("Seed extension");
    expect(needs.querySelector('button[aria-label="Give Investor update deck is 3 days past its target date to an agent"]')).not.toBeNull();
    const giveTask = needs.querySelector<HTMLButtonElement>('button[aria-label="Give Get the cap table from counsel is blocked to an agent"]')!;
    // A stale number names no item: it becomes a new task under the responsibility.
    expect(needs.querySelector('button[aria-label="New task for an agent: Days since the last LP letter was last updated 19 days ago"]')).not.toBeNull();
    // Marked at risk by hand with no attention signal: its sentence is the reason.
    expect(needs.querySelector('button[aria-label="New task for an agent: 4 of 4 decks sent on time this year, 100% of target"]')).not.toBeNull();
    expect(needs.textContent).not.toContain("Founder support");

    await act(async () => giveTask.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    const codexItem = [...document.body.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === "CodexCoder")!;
    await act(async () => codexItem.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(issuesApi.update).toHaveBeenCalledExactlyOnceWith("task-blocked", { assigneeAgentId: "agent-codex", assigneeUserId: null });
    expect(needs.textContent).toContain("CodexCoder has it now.");
  });

  it("shows what runs without you: the agent-powered measure and work agents and routines are doing", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    await render();
    const running = section("Running without you")!;
    expect(running.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe("5 of 10 open tasks");
    expect(running.textContent).toContain("Founder support");
    expect(running.querySelector('[aria-label="Agents on this: CTO"]')).not.toBeNull();
    expect(running.textContent).toContain("Monthly founder check-in is active, next run 2026-12-01");
    expect(running.textContent).not.toContain("LP updates");
    expect(running.textContent).not.toContain("Board reporting");
  });

  it("lists loose work quietly, each item opening its own page, with filing offered", async () => {
    api.overview.mockResolvedValue(homeOverviewFixture);
    api.link.mockResolvedValue({ link: { id: "link-new" } });
    await render();
    const loose = section("Outside your responsibilities")!;
    expect(loose.textContent).toContain("Not everything needs to be");
    expect(loose.querySelector('a[href^="/projects/"]')?.textContent).toContain("Team offsite");
    expect(loose.querySelector('a[href="/issues/PAP-88"]')?.textContent).toContain("Submit October expenses");
    expect(loose.textContent).toContain("Open tasks 57");
    expect(loose.textContent).toContain("Showing the 3 most recently updated of 57 open tasks.");
    expect(loose.querySelector('a[href="/routines/routine-standup"]')?.textContent).toContain("Daily standup notes");
    expect(loose.querySelector('button[aria-label="Give Team offsite to an agent"]')).not.toBeNull();
    expect(loose.querySelector('button[aria-label="Give Submit October expenses to an agent"]')).not.toBeNull();
    expect(loose.querySelector('button[aria-label="Give Daily standup notes to an agent"]')).not.toBeNull();

    const fileUnder = loose.querySelector<HTMLButtonElement>('button[aria-label="File Daily standup notes under a responsibility"]')!;
    await act(async () => fileUnder.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    const target = [...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "Founder support")!;
    await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(api.link).toHaveBeenCalledExactlyOnceWith(portfolioOnTrack.id, { routineId: "routine-standup" });
    expect(loose.textContent).toContain("Filed “Daily standup notes” under Founder support.");
  });

  it("puts proposals up for review above what you own", async () => {
    api.overview.mockResolvedValue(responsibilityOverviewFixture([portfolioOnTrack], [proposedDealFlow]));
    await render();
    const review = section("Proposed for you")!;
    expect(review.textContent).toContain("Sourcing");
    expect(review.compareDocumentPosition(section("What you own")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("says what to do first when there is nothing yet", async () => {
    api.overview.mockResolvedValue(responsibilityOverviewFixture([], [], { loose: EMPTY_LOOSE_WORK }));
    await render();
    expect(text()).toContain("What do you own?");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent?.trim())).toContain("Add a responsibility");
    expect(host.querySelector('a[href="/chats/cto"]')?.textContent).toContain("Ask CTO to draft them");
    expect(section("Outside your responsibilities")).toBeUndefined();
  });

  it("offers only adding one when no primary agent is set", async () => {
    api.overview.mockResolvedValue(responsibilityOverviewFixture([]));
    await render(null);
    expect(text()).toContain("What do you own?");
    expect(host.querySelector('a[href^="/chats/"]')).toBeNull();
  });

  it("hides let-go responsibilities until asked", async () => {
    const letGo = responsibilityFixture({ id: "resp-old", title: "Old fund", status: "let_go" });
    api.overview.mockImplementation(async (_companyId: string, filters?: { includeLetGo?: boolean }) =>
      responsibilityOverviewFixture(filters?.includeLetGo ? [portfolioOnTrack, letGo] : [portfolioOnTrack]),
    );
    await render();
    expect(text()).not.toContain("Old fund");
    await act(async () => buttonByText("Show let-go responsibilities")!.click());
    await flush();
    expect(api.overview).toHaveBeenLastCalledWith("company-storybook", { includeLetGo: true, ownerUserId: "user-storybook" });
    expect(text()).toContain("Old fund");
  });
});
