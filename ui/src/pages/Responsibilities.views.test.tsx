// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OUTLINE_V2_COLLAPSED_STORAGE_KEY } from "@/lib/responsibility-outline-v2";
import {
  allOnTrackOverviewFixture,
  automationFixture,
  automationOverviewFixture,
  boardReportingOverridden,
  fundraisingBehind,
  hiringNotMeasured,
  homeAutomationFixture,
  lpUpdatesStale,
  homeOverviewFixture,
  portfolioOnTrack,
  proposedDealFlow,
  responsibilityFixture,
  responsibilityOverviewFixture,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
} from "../../storybook/fixtures/responsibilities";
import {
  mixedStatusReportsFixture,
  noneWrittenStatusReportsFixture,
} from "../../storybook/fixtures/responsibility-status-reports";
import { Responsibilities } from "./Responsibilities";

const api = vi.hoisted(() => ({ overview: vi.fn(), update: vi.fn(), link: vi.fn(), create: vi.fn(), companySummary: vi.fn(), automation: vi.fn(), statusReports: vi.fn(), writeStatusReport: vi.fn(), requestStatusUpdate: vi.fn() }));
const suggestionsApi = vi.hoisted(() => ({ accept: vi.fn(), decline: vi.fn(), repeatAsRoutine: vi.fn() }));
const conversationsApi = vi.hoisted(() => ({ start: vi.fn(), conversation: vi.fn(), accept: vi.fn(), decline: vi.fn() }));
const routinesApi = vi.hoisted(() => ({ update: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const areasApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
const agentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const authApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const dashboardApi = vi.hoisted(() => ({ state: vi.fn(), start: vi.fn(), versions: vi.fn(), restore: vi.fn(), accept: vi.fn(), decline: vi.fn() }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api, responsibilityAreasApi: areasApi }));
vi.mock("@/api/agents", () => ({ agentsApi }));
vi.mock("@/api/routine-suggestions", () => ({ routineSuggestionsApi: suggestionsApi }));
vi.mock("@/api/automation-conversations", () => ({ automationConversationsApi: conversationsApi }));
vi.mock("@/api/routines", () => ({ routinesApi }));
vi.mock("@/api/auth", () => ({ authApi }));
vi.mock("@/api/responsibility-dashboard", () => ({ responsibilityDashboardApi: dashboardApi }));
vi.mock("@/hooks/useAgentlessOnboardingAutoOpen", () => ({ useAgentlessOnboardingAutoOpen: vi.fn() }));
// The chat composer at the foot of the page has its own tests; here it only has to be there.
vi.mock("@/components/responsibilities/DashboardChatComposer", () => ({ DashboardChatComposer: () => <div data-dashboard-chat-stub="" /> }));
const companyState = vi.hoisted(() => ({ value: { selectedCompanyId: "company-storybook" } as Record<string, unknown> }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState.value }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
const location = vi.hoisted(() => ({ search: "" }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/responsibilities", search: location.search, hash: "", state: null, key: "default" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigate,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const guide = { id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, companyId: "company-storybook", name: "CTO", urlKey: "cto", status: "idle", createdAt: new Date("2026-10-01T00:00:00Z") } as Agent;
const codex = { id: "agent-codex", companyId: "company-storybook", name: "CodexCoder", urlKey: "codex", status: "idle", createdAt: new Date("2026-10-02T00:00:00Z") } as Agent;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const text = () => host.textContent ?? "";
const view = () => host.querySelector("[data-dashboard-view]")?.getAttribute("data-dashboard-view") ?? "full";

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <PrimaryAgentPresentationProvider value={{ companyId: "company-storybook", primaryAgentId: guide.id, primaryAgent: guide, onChange: () => {} }}>
            <Responsibilities />
          </PrimaryAgentPresentationProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

async function remount() {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(RESPONSIBILITY_FIXTURE_NOW);
  vi.clearAllMocks();
  location.search = "";
  localStorage.clear();
  companyState.value = { selectedCompanyId: "company-storybook" };
  agentsApi.list.mockResolvedValue([guide, codex]);
  api.automation.mockResolvedValue(homeAutomationFixture);
  api.statusReports.mockResolvedValue(mixedStatusReportsFixture);
  authApi.getSession.mockResolvedValue({ user: { id: "user-storybook", name: "Riley Board", email: "riley@example.com", image: null } });
  api.overview.mockResolvedValue(homeOverviewFixture);
  dashboardApi.state.mockImplementation(async (_companyId: string, ownerUserId: string) => ({
    ownerUserId, empty: false, state: "none", defaultAgentId: guide.id, conversation: null, proposal: null, latestChange: null,
  }));
  api.companySummary.mockResolvedValue({
    text: "One responsibility is behind: Seed extension is 11 investors short of its target.",
    source: "computed",
    generatedAt: RESPONSIBILITY_FIXTURE_NOW.toISOString(),
    refreshing: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Dashboard views", () => {
  it("is Outline v2, with no switch between views", async () => {
    await render();
    expect(view()).toBe("outline_v2");
    expect(host.querySelector('[role="radiogroup"][aria-label="Dashboard view"]')).toBeNull();
    expect(host.querySelector("[data-dashboard-back]")).toBeNull();
  });

  it("ignores a choice an earlier build remembered, and an address naming no view", async () => {
    localStorage.setItem("paperclip:responsibilities:dashboard-view", "board");
    location.search = "?view=kanban";
    await render();
    expect(view()).toBe("outline_v2");
  });

  it("shows an earlier exploration only while the address names it", async () => {
    location.search = "?view=board";
    await render();
    expect(view()).toBe("board");
    expect(host.querySelector('[role="radiogroup"][aria-label="Dashboard view"]')).toBeNull();
    // The Board keeps the page's own add buttons.
    const headerButtons = [...host.querySelector("header")!.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(headerButtons).toEqual(expect.arrayContaining(["Add area", "Add responsibility"]));

    location.search = "?view=exceptions";
    await remount();
    expect(view()).toBe("exceptions");
    expect(text()).not.toContain("Add area");

    // Nothing was remembered.
    location.search = "";
    await remount();
    expect(view()).toBe("outline_v2");
    expect(localStorage.getItem("paperclip:responsibilities:dashboard-view")).toBeNull();
  });

  it("puts the chat composer at the foot of every view, after the content", async () => {
    for (const choice of ["full", "outline", "outline_v2", "board", "exceptions", "automation", "agent_status"]) {
      location.search = `?view=${choice}`;
      await remount();
      const dock = host.querySelector<HTMLElement>("[data-dashboard-chat-dock]")!;
      expect(dock.querySelector("[data-dashboard-chat-stub]")).not.toBeNull();
      expect(dock.className).toContain("sticky");
      const viewRoot = host.querySelector("[data-dashboard-view]") ?? host.querySelector("main, h2");
      if (viewRoot) expect(viewRoot.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("Outline: the person, the overall status, four numbers and the areas with what must be true", async () => {
    location.search = "?view=outline";
    await render();
    await flush();
    const outline = host.querySelector<HTMLElement>('[data-dashboard-view="outline"]')!;
    expect(outline.querySelector('a[href="/u/user-storybook"]')?.textContent).toBe("Riley Board");
    expect(outline.querySelector("[data-overall-status]")?.textContent).toBe("Behind1 responsibility is behind and 2 are at risk.");
    const figures = [...outline.querySelectorAll("dl > div")].map((figure) => figure.textContent);
    expect(figures).toEqual(["Areas31 with something behind", "Responsibilities51 behind", "Projects41 late", "Tasks101 blocked"]);
    const fundraising = outline.querySelector<HTMLElement>('[data-outline-area="area-fundraising"]')!;
    expect(fundraising.textContent).toContain("2 responsibilities you own");
    expect(fundraising.textContent).toContain("0% on track");
    const row = fundraising.querySelector(`li[data-responsibility-id="${fundraisingBehind.id}"] a`)!;
    expect(row.getAttribute("href")).toBe("/responsibilities/resp-fundraising");
    expect(row.textContent).toBe(`Seed extension${fundraisingBehind.standard}Behind`);
    expect(outline.querySelector('[data-outline-area="area-portfolio"]')?.textContent).toContain("100% on track");
    expect([...outline.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual([
      "New area",
      "New responsibility",
      "New responsibility",
      "New responsibility",
      "New responsibility",
    ]);
  });

  it("design comparison: no whose-dashboard switch in any view; the Outline's header still names the demo person", async () => {
    const demo = (id: string, issuePrefix: string, description: string, createdAt: string) =>
      ({ id, issuePrefix, description, createdAt: new Date(createdAt), status: "active" });
    const scott = demo("company-storybook", "SCO", "[dashboard-demo] Scott — Chief Product Officer", "2026-11-01");
    const tom = demo("company-tom", "TOM", "[dashboard-demo] Tom — Investor", "2026-11-02");
    companyState.value = { selectedCompanyId: scott.id, selectedCompany: scott, companies: [scott, tom], setSelectedCompanyId: vi.fn() };
    for (const choice of ["full", "outline", "outline_v2", "board", "exceptions", "automation", "agent_status"]) {
      location.search = `?view=${choice}`;
      await remount();
      expect(host.querySelector("[data-dashboard-persona-switcher]")).toBeNull();
    }
    location.search = "?view=outline";
    await remount();
    await flush();
    const person = host.querySelector<HTMLElement>('[data-dashboard-view="outline"] [data-demo-person]')!;
    expect(person.textContent).toBe("SCScottChief Product Officer");
    expect(host.querySelector('[data-dashboard-view="outline"]')?.textContent).not.toContain("Riley Board");
  });

  it("Board: where things stand with its paragraph, then areas as rows and statuses as columns", async () => {
    location.search = "?view=board";
    await render();
    await flush();
    const board = host.querySelector<HTMLElement>('[data-dashboard-view="board"]')!;
    expect(board.textContent).toContain("Where things stand");
    const paragraph = board.querySelector<HTMLElement>("[data-narrative-source]")!;
    expect(paragraph.getAttribute("data-narrative-source")).toBe("computed");
    expect(paragraph.textContent).toContain("Seed extension is 11 investors short of its target.");
    expect(paragraph.textContent).toContain("Summarized from the numbers");
    expect(paragraph.textContent).not.toContain("AI");
    expect(board.querySelector("[data-board-columns]")?.textContent).toBe("Behind1At risk2On track1Not measured1");

    expect([...board.querySelectorAll("[data-board-area]")].map((area) => area.querySelector("h2")?.textContent)).toEqual([
      "Fundraising",
      "Portfolio",
      "Team",
      "Not in an area",
    ]);
    const fundraising = board.querySelector<HTMLElement>('[data-board-area="area-fundraising"]')!;
    expect(fundraising.textContent).toContain("2 responsibilities you own · 0% on track");
    expect([...fundraising.querySelectorAll("[data-board-cell]")].map((cell) => [
      cell.getAttribute("data-board-cell"),
      [...cell.querySelectorAll("li[data-responsibility-id]")].map((card) => card.getAttribute("data-responsibility-id")),
    ])).toEqual([
      ["behind", ["resp-fundraising"]],
      ["at_risk", ["resp-lp-updates"]],
      ["on_track", []],
      ["not_measured", []],
    ]);
    expect(board.querySelector('[data-board-area="area-portfolio"]')?.textContent).toContain("100% on track");

    const card = board.querySelector(`li[data-responsibility-id="${fundraisingBehind.id}"] a`)!;
    expect(card.getAttribute("href")).toBe("/responsibilities/resp-fundraising");
    expect(card.querySelector(".sr-only")?.textContent).toBe("Behind: ");
    expect(card.querySelector("[data-board-reading]")?.textContent).toBe("9");
    expect(card.textContent).toContain("of 20 · Investors contacted");
    expect(card.querySelector("[data-board-gap]")?.textContent).toBe("11 short of 20");
    expect([...card.querySelectorAll("[data-why-role]")].map((line) => line.textContent)).toEqual([
      "Investor update deck is 3 days past its target date",
      "Get the cap table from counsel is blocked",
    ]);
    const hiring = board.querySelector('li[data-responsibility-id="resp-hiring"]')!;
    expect(hiring.querySelector("[data-board-gap]")?.textContent).toBe("No reading of offers accepted yet.");
    expect(hiring.textContent).toContain("No work is filed under this yet.");
  });

  it("Board: shows no paragraph when the summary cannot be read, and the board all the same", async () => {
    location.search = "?view=board";
    api.companySummary.mockRejectedValue(new Error("down"));
    await render();
    await flush();
    const board = host.querySelector<HTMLElement>('[data-dashboard-view="board"]')!;
    expect(board.querySelector("[data-narrative-source]")).toBeNull();
    expect(board.querySelectorAll("li[data-responsibility-id]")).toHaveLength(5);
  });

  it("Board: labels a model-written paragraph as written by AI", async () => {
    location.search = "?view=board";
    api.companySummary.mockResolvedValue({
      text: "Fundraising is the one to watch.",
      source: "model",
      generatedAt: new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 5 * 60_000).toISOString(),
      refreshing: false,
    });
    await render();
    await flush();
    const paragraph = host.querySelector<HTMLElement>("[data-narrative-source]")!;
    expect(paragraph.getAttribute("data-narrative-source")).toBe("model");
    expect(paragraph.textContent).toContain("Written by AI");
    expect(paragraph.textContent).toContain("5m ago");
  });

  it("Exceptions: one sentence, only what is wrong, and one line per area for what is on track", async () => {
    location.search = "?view=exceptions";
    await render();
    const exceptions = host.querySelector<HTMLElement>('[data-dashboard-view="exceptions"]')!;
    expect(exceptions.querySelector("[data-overall-status]")?.textContent).toBe("Behind:1 responsibility is behind and 2 are at risk.");
    expect([...exceptions.querySelectorAll("li[data-reason]")].map((row) => row.getAttribute("data-responsibility-id"))).toEqual([
      "resp-fundraising",
      "resp-lp-updates",
      "resp-board-reporting",
      "resp-hiring",
    ]);
    expect(exceptions.textContent).toContain("Investor update deck is 3 days past its target date");
    expect(exceptions.textContent).not.toContain("Get the cap table from counsel is blocked");
    const onTrack = exceptions.querySelector('[data-on-track-area="area-portfolio"]')!;
    expect(onTrack.textContent).toBe("Portfolio: 1 of 1 on track · Founder support");
    expect(onTrack.querySelector("a")?.getAttribute("href")).toBe(`/responsibilities/${portfolioOnTrack.id}`);
  });

  it("Exceptions: says so, briefly, when nothing is wrong", async () => {
    location.search = "?view=exceptions";
    api.overview.mockResolvedValue(allOnTrackOverviewFixture);
    await render();
    const exceptions = host.querySelector<HTMLElement>('[data-dashboard-view="exceptions"]')!;
    expect(exceptions.querySelector("[data-overall-status]")?.textContent).toBe("On track:Everything you own is on track.");
    expect(exceptions.textContent).not.toContain("Needs a look");
    expect([...exceptions.querySelectorAll("[data-on-track-area]")].map((line) => line.textContent?.split(" · ")[0])).toEqual([
      "Fundraising: 2 of 2 on track",
      "Portfolio: 1 of 1 on track",
    ]);
  });

  it("never hides proposals: one notice that takes the person to review them", async () => {
    location.search = "?view=board";
    api.overview.mockResolvedValue(responsibilityOverviewFixture([portfolioOnTrack], [proposedDealFlow]));
    await render();
    const notice = host.querySelector<HTMLElement>("[data-proposals-notice]")!;
    expect(notice.textContent).toContain("1 proposed responsibility is waiting for your review.");
    await act(async () => notice.querySelector("button")!.click());
    expect(view()).toBe("full");
    expect(text()).toContain("Proposed for you");
    expect(host.querySelector("[data-dashboard-chat-stub]")).not.toBeNull();
  });

  it("keeps the empty state in every view but Outline v2", async () => {
    api.overview.mockResolvedValue(responsibilityOverviewFixture([], []));
    for (const choice of ["outline", "board", "exceptions", "automation", "agent_status"]) {
      location.search = `?view=${choice}`;
      await remount();
      expect(text()).toContain("What do you own?");
      expect(host.querySelector('a[href="/chats/cto"]')?.textContent).toContain("Ask CTO to draft them");
      expect(host.querySelector("[data-dashboard-chat-stub]")).not.toBeNull();
    }
  });

  describe("Automation", () => {
    const automationView = () => host.querySelector<HTMLElement>('[data-dashboard-view="automation"]')!;
    const row = (id: string) => automationView().querySelector<HTMLElement>(`li[data-responsibility-id="${id}"]`)!;
    const buttonIn = (root: ParentNode, label: string) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label)!;
    const candidateIds = (id: string) => [...row(id).querySelectorAll("[data-candidate-id]")].map((item) => item.getAttribute("data-candidate-id"));

    async function openAutomation() {
      location.search = "?view=automation";
      await render();
      await flush();
    }

    it("spans the whole content pane", async () => {
      await openAutomation();
      expect(view()).toBe("automation");
      expect(api.automation).toHaveBeenCalledWith("company-storybook");
      expect(host.firstElementChild?.className).toContain("max-w-none");
      expect(host.firstElementChild?.className).not.toContain("max-w-7xl");
    });

    it("shows no status anywhere: no behind, at risk, on track or not measured marks", async () => {
      await openAutomation();
      const words = automationView().textContent ?? "";
      for (const status of ["Behind", "At risk", "On track", "Not measured", "behind", "at risk", "on track", "not measured"]) {
        expect(words).not.toContain(status);
      }
      const styles = [...automationView().querySelectorAll<HTMLElement>("[style]")].map((element) => element.getAttribute("style") ?? "");
      for (const hue of ["--status-task-blocked", "--status-task-todo", "--status-task-done"]) {
        expect(styles.some((style) => style.includes(hue))).toBe(false);
      }
      expect(automationView().querySelector("[data-board-columns]")).toBeNull();
    });

    it("shows the overall picture in the new words, then one full-width row per responsibility grouped by area, most manual first", async () => {
      await openAutomation();
      const summary = automationView().querySelector<HTMLElement>("[data-automation-summary]")!;
      expect(summary.textContent).toContain("How much runs without you");
      expect([...summary.querySelectorAll("[data-level-count]")].map((figure) => figure.textContent)).toEqual([
        "Manual2",
        "Some automated1",
        "Mostly automated1",
        "Automated1",
      ]);
      expect(summary.querySelector("[data-automation-sentence]")?.textContent).toBe(
        "2 of your 5 responsibilities have nothing automated yet; 7 manual tasks could be automated.",
      );
      expect(summary.querySelector("[data-automation-totals]")?.textContent).toBe("6 automations running · 7 manual tasks in the last 30 days");

      expect([...automationView().querySelectorAll("[data-board-area]")].map((area) => [
        area.getAttribute("data-board-area"),
        [...area.querySelectorAll("li[data-responsibility-id]")].map((item) => item.getAttribute("data-responsibility-id")),
      ])).toEqual([
        ["area-fundraising", ["resp-lp-updates", "resp-fundraising"]],
        ["area-portfolio", ["resp-portfolio"]],
        ["area-team", ["resp-hiring"]],
        ["none", [boardReportingOverridden.id]],
      ]);
      const fundraising = automationView().querySelector<HTMLElement>('[data-board-area="area-fundraising"]')!;
      expect(fundraising.querySelector("h2")?.textContent).toBe("Fundraising");
      expect(fundraising.textContent).toContain("2 responsibilities you own · 14% automated");
      expect(row("resp-portfolio").getAttribute("data-automation-level")).toBe("automated");
      expect(row(boardReportingOverridden.id).getAttribute("data-automation-level")).toBe("mostly_automated");
    });

    it("filters the rows by the level counts", async () => {
      await openAutomation();
      const summary = automationView().querySelector<HTMLElement>("[data-automation-summary]")!;
      await act(async () => summary.querySelector<HTMLButtonElement>('[data-level-count="automated"]')!.click());
      expect(summary.querySelector('[data-level-count="automated"]')?.getAttribute("aria-pressed")).toBe("true");
      expect([...automationView().querySelectorAll("li[data-responsibility-id]")].map((item) => item.getAttribute("data-responsibility-id"))).toEqual(["resp-portfolio"]);
      await act(async () => summary.querySelector<HTMLButtonElement>("[data-automation-show-all]")!.click());
      expect(automationView().querySelectorAll("li[data-responsibility-id]")).toHaveLength(5);
    });

    it("reads each row left to right: how automated, what runs and how it starts, and the manual tasks with suggestions", async () => {
      await openAutomation();
      const seed = row(fundraisingBehind.id);
      const identity = seed.querySelector<HTMLElement>("[data-automation-identity]")!;
      expect(identity.querySelector("[data-automation-level-label]")?.textContent).toBe("Some automated");
      expect(identity.querySelector("[data-automation-share]")?.textContent).toBe("17% automated");
      expect(identity.querySelector("[data-automation-meter]")).not.toBeNull();
      expect(identity.querySelector("[data-automation-counts]")?.textContent).toBe("1 automation · 5 manual tasks");
      expect(seed.querySelector("[data-automation-running] [data-automation-start-words]")?.textContent).toBe("On a schedule · Every Monday at 9 AM · CodexCoder");

      // Tasks with a suggestion (or an offer, or a conversation) first; the rest behind "and N more".
      expect(candidateIds(fundraisingBehind.id)).toEqual(["task-done", "task-inbound", "task-chase"]);
      expect(seed.querySelector('[data-candidate-id="task-inbound"]')?.getAttribute("data-candidate-trigger")).toBe("webhook");
      const chase = seed.querySelector<HTMLElement>('[data-candidate-id="task-chase"]')!;
      expect(chase.querySelector("[data-candidate-hint]")?.textContent).toContain("Could be a standing check");
      expect(chase.querySelector("[data-candidate-why]")?.textContent).toBe("It sounds like watching for something (“Chase”), so a standing check on each wake-up could fit.");
      expect(buttonIn(chase, "Automate with CodexCoder")).toBeTruthy();
      expect(buttonIn(chase, "Set up by hand")).toBeTruthy();
      expect(buttonIn(seed.querySelector('[data-candidate-id="task-inbound"]')!, "Continue with CodexCoder")).toBeTruthy();
      expect(seed.querySelector('[data-candidate-id="task-done"] [data-candidate-offer]')?.textContent).toBe("CodexCoder offered to repeat it: On the 1st of every month at 9 AM");
      const more = seed.querySelector<HTMLButtonElement>("[data-automation-more]")!;
      expect(more.textContent).toBe("and 2 more manual tasks");
      await act(async () => more.click());
      expect(candidateIds(fundraisingBehind.id)).toEqual(["task-done", "task-inbound", "task-chase", "task-blocked", "task-intro"]);
      expect(seed.querySelector('[data-candidate-id="task-intro"] [data-candidate-why]')?.textContent).toBe("How it could run is unclear from the title; work it out with CodexCoder.");

      // Each way an automation starts, with who runs it and what happened last.
      const portfolio = row("resp-portfolio");
      expect([...portfolio.querySelectorAll("[data-automation-start]")].map((item) => item.getAttribute("data-automation-start"))).toEqual(["schedule", "webhook", "standing_check"]);
      const check = portfolio.querySelector<HTMLElement>('[data-automation-start="standing_check"]')!;
      expect(check.querySelector("[data-automation-start-words]")?.textContent).toBe("Standing check · on each wake-up · An agent");
      expect(check.querySelector("[data-automation-status]")?.textContent).toBe("Last checked 2 hours ago: acted (Reminded two founders) · PAP-88");
      expect(check.querySelector("[data-standing-check-actions]")).not.toBeNull();
      const webhook = portfolio.querySelector<HTMLElement>('[data-automation-start="webhook"]')!;
      expect(webhook.querySelector("[data-automation-webhook]")?.textContent).toContain("POST https://paperclip.example/api/routine-triggers/public/");
      expect(webhook.querySelector("[data-automation-webhook]")?.textContent).toContain("Authorization: Bearer <secret>");
      expect(portfolio.querySelector("[data-automation-quiet]")?.textContent).toBe("The automations are covering the work.");

      // Anything not running is called out.
      expect(row("resp-lp-updates").querySelector('[data-automation-stalled="paused"]')?.textContent).toBe("Monthly LP letter · Paused");
      expect(row(boardReportingOverridden.id).querySelector('[data-automation-stalled="no_wakeups"]')?.textContent).toContain("doesn’t wake up on its own (heartbeat off)");
      expect(row(boardReportingOverridden.id).querySelector('[data-automation-start="on_request"] [data-automation-start-words]')?.textContent).toBe("On request · when someone runs it · An agent");
      expect(buttonIn(row(boardReportingOverridden.id), "Review CTO’s proposal")).toBeTruthy();

      const hiring = row("resp-hiring");
      expect(hiring.querySelector("[data-automation-counts]")?.textContent).toBe("Nothing is filed under this yet.");
      expect(hiring.querySelector("[data-candidate-id]")).toBeNull();
    });

    it("starts the conversation with the responsible agent and goes there", async () => {
      conversationsApi.start.mockResolvedValue({
        sourceIssueId: "task-chase", state: "discussing", defaultAgentId: "agent-codex",
        conversation: { issueId: "conversation-new", identifier: "PAP-90", title: "Automate", status: "todo", agentId: "agent-codex", createdAt: new Date() },
        proposal: null,
      });
      await openAutomation();
      const chase = row(fundraisingBehind.id).querySelector<HTMLElement>('[data-candidate-id="task-chase"]')!;
      await act(async () => buttonIn(chase, "Automate with CodexCoder").click());
      await flush();
      expect(conversationsApi.start).toHaveBeenCalledWith("task-chase", { agentId: "agent-codex", responsibilityId: fundraisingBehind.id });
      expect(navigate).toHaveBeenCalledWith("/issues/PAP-90");

      // An open conversation is one tap away, without starting another.
      conversationsApi.start.mockClear();
      const inbound = row(fundraisingBehind.id).querySelector<HTMLElement>('[data-candidate-id="task-inbound"]')!;
      await act(async () => buttonIn(inbound, "Continue with CodexCoder").click());
      expect(conversationsApi.start).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/issues/PAP-70");
    });

    it("opens the set-it-up-by-hand form from a suggestion, prefilled, and sends it", async () => {
      suggestionsApi.repeatAsRoutine.mockResolvedValue({
        routine: { id: "routine-new", title: "Chase LPs who have waited more than a week", assigneeAgentId: "agent-codex", projectId: null, status: "active" },
        cadenceLabel: "Every Monday at 9 AM",
        timezone: "UTC",
        responsibilityIds: [fundraisingBehind.id],
        acceptedOfferId: null,
      });
      await openAutomation();
      const chase = row(fundraisingBehind.id).querySelector<HTMLElement>('[data-candidate-id="task-chase"]')!;
      await act(async () => buttonIn(chase, "Set up by hand").click());
      await flush();
      const dialog = document.querySelector<HTMLElement>("[data-make-routine-dialog]")!;
      expect(dialog.querySelector<HTMLInputElement>('input[aria-label="What repeats"]')?.value).toBe("Chase LPs who have waited more than a week");
      expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Who runs it"]')?.value).toBe("agent-codex");
      expect(dialog.querySelector("[data-routine-filing-note]")?.textContent).toBe(
        "The task itself stays as it is. The routine is filed under Seed extension, like the task.",
      );
      await act(async () => buttonIn(dialog, "Make it a routine").click());
      await flush();
      expect(suggestionsApi.repeatAsRoutine).toHaveBeenCalledWith("task-chase", expect.objectContaining({
        title: "Chase LPs who have waited more than a week",
        assigneeAgentId: "agent-codex",
      }));
      expect(conversationsApi.start).not.toHaveBeenCalled();
      expect(automationView().querySelector("[data-automation-made]")?.textContent).toContain("“Chase LPs who have waited more than a week” is automated now: Every Monday at 9 AM.");
      // The view reads the automation again so the row's share moves.
      expect(api.automation.mock.calls.length).toBeGreaterThan(1);
    });

    it("accepts an agent's pending offer from the row", async () => {
      suggestionsApi.accept.mockResolvedValue({ interaction: { id: "interaction-offer-update" }, routine: { id: "routine-update", title: "Monthly investor update" } });
      await openAutomation();
      const offer = row(fundraisingBehind.id).querySelector<HTMLElement>('[data-candidate-id="task-done"]')!;
      await act(async () => buttonIn(offer, "Accept").click());
      await flush();
      expect(suggestionsApi.accept).toHaveBeenCalledWith("task-done", "interaction-offer-update", expect.any(String));
      expect(automationView().querySelector("[data-automation-made]")?.textContent).toContain("“Monthly investor update” is automated now: On the 1st of every month at 9 AM.");
    });

    it("pauses a standing check", async () => {
      routinesApi.update.mockResolvedValue({});
      await openAutomation();
      const check = row("resp-portfolio").querySelector<HTMLElement>('[data-automation-start="standing_check"]')!;
      await act(async () => buttonIn(check, "Pause Follow up on overdue board decks").click());
      await flush();
      expect(routinesApi.update).toHaveBeenCalledWith("routine-board-decks", { status: "paused" });
    });

    it("stops suggesting a task the person says doesn't repeat, and remembers it", async () => {
      await openAutomation();
      const chase = row(fundraisingBehind.id).querySelector<HTMLElement>('[data-candidate-id="task-chase"]')!;
      await act(async () => buttonIn(chase, "Chase LPs who have waited more than a week doesn't repeat").click());
      expect(candidateIds(fundraisingBehind.id)).toEqual(["task-done", "task-inbound"]);
      expect(row(fundraisingBehind.id).querySelector("[data-automation-more]")?.textContent).toBe("and 2 more manual tasks");
      expect(automationView().querySelector("[data-automation-sentence]")?.textContent).toContain("6 manual tasks could be automated.");
      expect(suggestionsApi.decline).not.toHaveBeenCalled();
      await remount();
      await flush();
      expect(candidateIds(fundraisingBehind.id)).toEqual(["task-done", "task-inbound"]);
    });

    it("says something true when nothing is left to suggest, and works without storage", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      api.overview.mockResolvedValue(responsibilityOverviewFixture([portfolioOnTrack]));
      api.automation.mockResolvedValue(automationOverviewFixture([automationFixture({ responsibilityId: portfolioOnTrack.id, areaId: "area-portfolio", runningCount: 1 })]));
      await openAutomation();
      expect(automationView().querySelector("[data-automation-sentence]")?.textContent).toBe("Everything you own is automated.");
      expect(row(portfolioOnTrack.id).querySelector("[data-automation-quiet]")?.textContent).toBe("The automations are covering the work.");
    });

    it("shows a retry when the automation cannot be read", async () => {
      api.automation.mockRejectedValue(new Error("down"));
      await openAutomation();
      expect(automationView().querySelector("[data-automation-summary]")).toBeNull();
      expect(automationView().querySelector("button")?.textContent).toMatch(/Retry|Try again/);
      expect(host.querySelector("[data-dashboard-chat-stub]")).not.toBeNull();
    });
  });
  describe("Agent status", () => {
    const statusView = () => host.querySelector<HTMLElement>('[data-dashboard-view="agent_status"]')!;
    const row = (id: string) => statusView().querySelector<HTMLElement>(`li[data-responsibility-id="${id}"]`)!;
    const area = (id: string) => statusView().querySelector<HTMLElement>(`[data-agent-status-area="${id}"]`)!;

    async function openAgentStatus() {
      location.search = "?view=agent_status";
      await render();
      await flush();
    }

    it("reads every report in one request", async () => {
      await openAgentStatus();
      expect(view()).toBe("agent_status");
      expect(api.statusReports).toHaveBeenCalledTimes(1);
      expect(api.statusReports).toHaveBeenCalledWith("company-storybook");
      expect(host.firstElementChild?.className).toContain("max-w-5xl");
    });

    it("shows the person, four counts by the written status, where those come from, and a summary composed from the reports", async () => {
      await openAgentStatus();
      expect(statusView().querySelector('a[href="/u/user-storybook"]')?.textContent).toBe("Riley Board");
      const tiles = [...statusView().querySelectorAll<HTMLElement>("[data-agent-status-tile]")].map((tile) => [tile.dataset.agentStatusTile, tile.textContent]);
      expect(tiles).toEqual([
        ["on_track", "1On trackOf 5 responsibilities"],
        ["at_risk", "2At riskIn 2 areas"],
        ["behind", "1BehindIn 1 area"],
        ["unclear", "1Unclear1 not measured"],
      ]);
      expect(statusView().querySelector("[data-agent-status-provenance]")?.textContent)
        .toBe("3 written by agents · 1 out of date · 1 written by a person · 1 from the number");
      const summary = statusView().querySelector<HTMLElement>("[data-agent-status-summary]")!;
      expect(summary.textContent).toContain("4 of your 5 statuses are written; the rest come from the numbers. They put 1 behind and 2 at risk.");
      expect(summary.textContent).toContain("Seed extension:Nine of twenty contacted");
      expect(summary.textContent).toContain("Waiting on: CTO, for 1 update");
    });

    it("heads each area with its most concerning line, its worst status, the share on track and who reports there; areas start open and fold", async () => {
      await openAgentStatus();
      const fundraising = area("area-fundraising");
      const header = fundraising.querySelector<HTMLButtonElement>("h3 button")!;
      expect(fundraising.querySelector("[data-area-headline]")?.textContent)
        .toBe("Nine of twenty contacted, and the deck the rest are waiting for is three days late. (CodexCoder)");
      expect(header.querySelector("[data-agent-status-chip]")?.textContent).toBe("Behind");
      expect(header.textContent).toContain("0 of 2 responsibilities on track");
      expect(header.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Reporting here: CodexCoder, CTO");
      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(fundraising.querySelectorAll("li[data-responsibility-id]")).toHaveLength(2);
      await act(async () => header.click());
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(fundraising.querySelectorAll("li[data-responsibility-id]")).toHaveLength(0);
      expect(area("area-team").querySelector("[data-area-headline]")?.textContent).toContain("(from the number)");
      // The Outline's actions stay.
      expect([...statusView().querySelectorAll("button")].some((button) => button.textContent?.trim() === "New area")).toBe(true);
      expect([...statusView().querySelectorAll("button")].filter((button) => button.textContent?.trim() === "New responsibility").length).toBeGreaterThan(1);
    });

    it("reads each row: the bar with the agent's line, the metric, the status and who wrote it, fresh, out of date, by a person or from the number", async () => {
      await openAgentStatus();
      const fresh = row("resp-fundraising");
      expect(fresh.dataset.statusSource).toBe("agent");
      expect(fresh.querySelector("a")?.getAttribute("href")).toBe("/responsibilities/resp-fundraising");
      expect(fresh.querySelector("a")?.textContent).toBe("Twenty qualified investors contacted before the partner meeting in December.");
      expect(fresh.querySelector("[data-status-message]")?.textContent).toBe("Nine of twenty contacted, and the deck the rest are waiting for is three days late.");
      expect(fresh.querySelector("[data-status-metric]")?.textContent).toBe("Investors contacted9 · target 20");
      expect(fresh.querySelector("[data-agent-status-chip]")?.getAttribute("data-quiet")).toBeNull();
      expect(fresh.textContent).toContain("CodexCoder");
      expect(fresh.textContent).toContain("Written yesterday");

      const stale = row("resp-lp-updates");
      expect(stale.dataset.outOfDate).toBe("true");
      expect(stale.querySelector("[data-agent-status-chip]")?.getAttribute("data-quiet")).toBe("true");
      expect(stale.querySelector("[data-agent-status-chip]")?.textContent).toBe("At risk (out of date)");
      expect(stale.textContent).toContain("Out of date · written 9 days ago");

      const byPerson = row("resp-board-reporting");
      expect(byPerson.dataset.statusSource).toBe("person");
      expect(byPerson.textContent).toContain("You");

      const fromNumber = row("resp-hiring");
      expect(fromNumber.dataset.statusSource).toBe("number");
      expect(fromNumber.querySelector("[data-status-message]")?.textContent).toContain("From the number, not from an agent");
      expect(fromNumber.querySelector("[data-agent-status-chip]")?.getAttribute("data-quiet")).toBe("true");
      expect(fromNumber.textContent).toContain("Asked for an update");
    });

    it("asks the reporting agent for an update, and waits while one is pending", async () => {
      api.requestStatusUpdate.mockResolvedValue({ current: null, reporterAgentId: "agent-codex", updateRequested: true, history: [] });
      await openAgentStatus();
      const pending = row("resp-hiring").querySelector<HTMLButtonElement>("[data-ask-update]")!;
      expect(pending.disabled).toBe(true);
      expect(pending.textContent).toBe("Waiting for CTO");
      const ask = row("resp-portfolio").querySelector<HTMLButtonElement>("[data-ask-update]")!;
      expect(ask.disabled).toBe(false);
      expect(ask.getAttribute("aria-label")).toBe("Ask CodexCoder for an update on Founder support");
      await act(async () => ask.click());
      await flush();
      expect(api.requestStatusUpdate).toHaveBeenCalledWith("resp-portfolio");
      expect(api.statusReports.mock.calls.length).toBeGreaterThan(1);
    });

    it("lets the person write the status themselves", async () => {
      api.writeStatusReport.mockResolvedValue({ current: null, reporterAgentId: null, updateRequested: false, history: [] });
      await openAgentStatus();
      await act(async () => row("resp-hiring").querySelector<HTMLButtonElement>("[data-edit-status]")!.click());
      await flush();
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Edit the status");
      const atRisk = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === "At risk")!;
      await act(async () => atRisk.click());
      const input = dialog.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, "Two offers out, both waiting on the visa letter.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await flush();
      expect(api.writeStatusReport).toHaveBeenCalledWith("resp-hiring", { status: "at_risk", message: "Two offers out, both waiting on the visa letter.", detail: null });
    });

    it("says plainly when nothing is written yet", async () => {
      api.statusReports.mockResolvedValue(noneWrittenStatusReportsFixture);
      await openAgentStatus();
      expect(statusView().querySelector("[data-agent-status-summary]")?.textContent)
        .toContain("No agent has written a status yet. Every status below comes from the numbers.");
      expect(statusView().querySelectorAll('li[data-status-source="number"]')).toHaveLength(5);
    });
  });

  describe("Outline v2", () => {
    const outlineV2 = () => host.querySelector<HTMLElement>('[data-dashboard-view="outline_v2"]')!;
    const areaCard = (key: string) => outlineV2().querySelector<HTMLElement>(`[data-outline-v2-area="${key}"]`)!;
    const bar = (key: string) => areaCard(key).querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const plus = (key: string) => areaCard(key).querySelector<HTMLButtonElement>('button[aria-label^="Add a responsibility to"]')!;
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    function setText(field: HTMLTextAreaElement, value: string) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function openOutlineV2() {
      location.search = "?view=outline_v2";
      await render();
      await flush();
    }

    it("has search and the counts where the headline was, and narrows the areas as you type", async () => {
      await openOutlineV2();
      const header = host.querySelector("header")!;
      const shownAreas = () => [...outlineV2().querySelectorAll("[data-outline-v2-area]")].map((area) => area.getAttribute("data-outline-v2-area"));
      const type = async (value: string) => {
        const field = header.querySelector<HTMLInputElement>('input[aria-label="Search your dashboard"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      // The breadcrumb bar names the page; the page does not repeat it.
      expect(header.querySelector("h1")).toBeNull();
      expect(header.querySelector("[data-dashboard-counts]")?.textContent).toBe("4 areas and 5 responsibilities");
      expect(shownAreas()).toHaveLength(5);

      // A folded area opens while it matches a search.
      await act(async () => bar("area-fundraising").click());
      expect(bar("area-fundraising").getAttribute("aria-expanded")).toBe("false");
      await type("fundraising");
      expect(shownAreas()).toEqual(["area-fundraising"]);
      expect(bar("area-fundraising").getAttribute("aria-expanded")).toBe("true");
      // The counts stay the whole dashboard's.
      expect(header.querySelector("[data-dashboard-counts]")?.textContent).toBe("4 areas and 5 responsibilities");

      await type("zebra");
      expect(shownAreas()).toEqual([]);
      expect(outlineV2().querySelector("[data-outline-v2-no-match]")?.textContent).toBe("Nothing matches “zebra”.");

      await act(async () => header.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
      expect(shownAreas()).toHaveLength(5);
      expect(bar("area-fundraising").getAttribute("aria-expanded")).toBe("false");

      // Nothing to search or count on an empty dashboard.
      api.overview.mockResolvedValue(responsibilityOverviewFixture([], [], { areas: [] }));
      await remount();
      await flush();
      expect(host.querySelector("header [data-toolbar-search]")).toBeNull();
      expect(host.querySelector("[data-dashboard-counts]")).toBeNull();
    });

    it("starts with the areas: no person, no overall status, no numbers, no status words", async () => {
      await openOutlineV2();
      const root = outlineV2();
      // Every active area, holding what the person owns or nothing yet, then the ones in no area.
      expect([...root.querySelectorAll("[data-outline-v2-area]")].map((area) => bar(area.getAttribute("data-outline-v2-area")!).textContent))
        .toEqual(["Fundraising", "Portfolio", "Team", "Legal", "No area"]);
      expect(root.querySelector("[data-overall-status], dl, [data-demo-person]")).toBeNull();
      expect(root.querySelector("img, svg:not([aria-hidden='true'])")).toBeNull();
      const words = root.textContent ?? "";
      for (const word of ["Behind", "At risk", "On track", "Not measured", "Overview", "Areas", "What do you care about", "you own", "%"]) {
        expect(words).not.toContain(word);
      }
      expect(root.querySelector("[style]")).toBeNull();
      expect(root.querySelector(".status-fill")).toBeNull();
      // Its only words beyond the areas and the sentences.
      expect([...root.querySelectorAll("button")].map((button) => button.textContent?.trim() || button.getAttribute("aria-label"))).toEqual([
        "Fundraising", "Add a responsibility to Fundraising",
        "Portfolio", "Add a responsibility to Portfolio",
        "Team", "Add a responsibility to Team",
        "Legal", "Add a responsibility to Legal", "Add a responsibility",
        "No area", "Add a responsibility to No area",
        // The edit module, below every area.
        "Edit your dashboard", "Versions",
      ]);
      const areas = [...root.querySelectorAll("[data-outline-v2-area]")];
      const module = root.querySelector('[data-dashboard-module="edit"]')!;
      expect(areas.at(-1)!.compareDocumentPosition(module) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("on an empty dashboard shows only the create module, naming the agent, with adding an area by hand kept quiet", async () => {
      api.overview.mockResolvedValue(responsibilityOverviewFixture([], [], { areas: [] }));
      await openOutlineV2();
      const root = outlineV2();
      expect(root.querySelector("[data-outline-v2-area]")).toBeNull();
      expect(text()).not.toContain("What do you own?");
      const module = root.querySelector<HTMLElement>('[data-dashboard-module="create"]')!;
      expect(module.querySelector("h2")?.textContent).toBe("Create your custom dashboard");
      expect(module.textContent).toContain("Have an agent research and interview you to generate a custom dashboard of areas and responsibilities that matter to you.");
      expect([...module.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Start with CTO", "Add an area yourself"]);
      expect(dashboardApi.state).toHaveBeenCalledWith("company-storybook", homeOverviewFixture.ownerUserId);
      dashboardApi.start.mockResolvedValue({
        ownerUserId: homeOverviewFixture.ownerUserId, empty: true, state: "discussing", defaultAgentId: guide.id, proposal: null, latestChange: null,
        conversation: { issueId: "issue-dash", identifier: "SCO-9", title: "Create my dashboard", status: "todo", agentId: guide.id, mode: "create", createdAt: new Date() },
      });
      await act(async () => module.querySelector<HTMLButtonElement>("[data-dashboard-start]")!.click());
      await flush();
      expect(dashboardApi.start).toHaveBeenCalledWith("company-storybook", { mode: "create", ownerUserId: homeOverviewFixture.ownerUserId });
      expect(navigate).toHaveBeenCalledWith("/issues/SCO-9");
      await act(async () => module.querySelector<HTMLButtonElement>("[data-dashboard-add-area]")!.click());
      await flush();
      expect(dialog()?.textContent).toContain("Add an area");
    });

    it("shows each responsibility as one line, its bar sentence or else its title, in the overview's order, linking to the simplified page", async () => {
      const titleOnly = responsibilityFixture({ id: "resp-tokens", areaId: fundraisingBehind.areaId, title: "Token coverage", standard: null, sortOrder: 9, rollup: { health: "on_track" } });
      // At risk before behind: the view must not re-sort by status.
      api.overview.mockResolvedValue(responsibilityOverviewFixture([lpUpdatesStale, fundraisingBehind, titleOnly, hiringNotMeasured]));
      await openOutlineV2();
      const rows = [...areaCard("area-fundraising").querySelectorAll<HTMLAnchorElement>("li[data-responsibility-id] a")];
      expect(rows.map((row) => row.textContent)).toEqual([lpUpdatesStale.standard, fundraisingBehind.standard, "Token coverage"]);
      expect(rows.map((row) => row.getAttribute("href"))).toEqual([
        "/responsibilities/resp-lp-updates?view=one_screen_v2",
        "/responsibilities/resp-fundraising?view=one_screen_v2",
        "/responsibilities/resp-tokens?view=one_screen_v2",
      ]);
      // Nothing else in a row: no title above the sentence, no status, no metric.
      expect(rows[0]!.children).toHaveLength(0);
      expect(rows[0]!.className).not.toContain("truncate");
    });

    it("folds and unfolds an area by its bar, by mouse or keyboard, and remembers it", async () => {
      await openOutlineV2();
      const toggle = bar("area-fundraising");
      const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      expect(areaCard("area-fundraising").contains(list)).toBe(true);
      expect(toggle.tagName).toBe("BUTTON");
      expect(toggle.closest("h3")).not.toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(list.hidden).toBe(false);

      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(list.hidden).toBe(true);
      const scope = JSON.stringify(["company-storybook", homeOverviewFixture.ownerUserId]);
      const storageKey = `${OUTLINE_V2_COLLAPSED_STORAGE_KEY}:${scope}`;
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(["area-fundraising"]);

      // A native button: Enter and Space press it, and it takes focus in tab order.
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      expect(toggle.tabIndex).toBe(0);

      await remount();
      await flush();
      expect(bar("area-fundraising").getAttribute("aria-expanded")).toBe("false");
      expect(bar("area-portfolio").getAttribute("aria-expanded")).toBe("true");
      await act(async () => bar("area-fundraising").click());
      expect(bar("area-fundraising").getAttribute("aria-expanded")).toBe("true");
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([]);
    });

    it("folds without storage", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      await openOutlineV2();
      await act(async () => bar("area-portfolio").click());
      expect(bar("area-portfolio").getAttribute("aria-expanded")).toBe("false");
    });

    it("adds a responsibility from an area's \"+\" without folding it, as one sentence", async () => {
      areasApi.list.mockResolvedValue([]);
      api.create.mockResolvedValue(responsibilityFixture({ id: "resp-new", areaId: "area-portfolio", title: "Every founder hears from us monthly." }));
      await openOutlineV2();
      await act(async () => plus("area-portfolio").click());
      await flush();
      expect(bar("area-portfolio").getAttribute("aria-expanded")).toBe("true");
      expect(localStorage.getItem(OUTLINE_V2_COLLAPSED_STORAGE_KEY)).toBeNull();

      const form = dialog()!;
      expect(form.querySelector("h2")?.textContent).toBe("New responsibility");
      // One field for the sentence, the area already chosen, Cancel and the create button.
      expect(form.querySelectorAll("textarea, input")).toHaveLength(1);
      expect(form.querySelector<HTMLSelectElement>("select")?.value).toBe("area-portfolio");
      expect([...form.querySelectorAll("form button")].map((button) => button.textContent?.trim())).toEqual(["Cancel", "Add responsibility"]);
      await act(async () => setText(form.querySelector("textarea")!, "  Every founder hears\nfrom us monthly. "));
      await act(async () => form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await flush();
      expect(api.create).toHaveBeenCalledExactlyOnceWith("company-storybook", { title: "Every founder hears from us monthly.", areaId: "area-portfolio" });
      expect(dialog()).toBeNull();
    });

    it("offers an empty area's first responsibility from its one quiet line", async () => {
      await openOutlineV2();
      const legal = areaCard("area-legal");
      expect(legal.querySelector("li")).toBeNull();
      const line = [...legal.querySelectorAll("button")].find((button) => button.textContent === "Add a responsibility")!;
      await act(async () => line.click());
      await flush();
      expect(dialog()?.querySelector<HTMLSelectElement>("select")?.value).toBe("area-legal");
    });

    it("shows the error and keeps the sentence when adding fails", async () => {
      api.create.mockRejectedValue(new Error("The server is unavailable"));
      await openOutlineV2();
      await act(async () => plus("area-team").click());
      await flush();
      const form = dialog()!;
      await act(async () => setText(form.querySelector("textarea")!, "Two designers have accepted offers by spring."));
      await act(async () => form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await flush();
      expect(api.create).toHaveBeenCalledExactlyOnceWith("company-storybook", { title: "Two designers have accepted offers by spring.", areaId: "area-team" });
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t add the responsibility.");
      expect(dialog()?.querySelector("textarea")?.value).toBe("Two designers have accepted offers by spring.");
    });

    it("will not send an empty sentence", async () => {
      await openOutlineV2();
      await act(async () => plus("area-team").click());
      await flush();
      const form = dialog()!;
      await act(async () => setText(form.querySelector("textarea")!, "   "));
      const submit = [...form.querySelectorAll("button")].find((button) => button.textContent === "Add responsibility")!;
      expect(submit.disabled).toBe(true);
      await act(async () => form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(api.create).not.toHaveBeenCalled();
    });

    it("keeps the compact proposals notice", async () => {
      api.overview.mockResolvedValue(responsibilityOverviewFixture([portfolioOnTrack], [proposedDealFlow]));
      await openOutlineV2();
      const notice = outlineV2().querySelector<HTMLElement>("[data-proposals-notice]")!;
      expect(notice.textContent).toContain("1 proposed responsibility is waiting for your review.");
      await act(async () => notice.querySelector("button")!.click());
      expect(view()).toBe("full");
      // The review is a visit: "Back" returns to the dashboard.
      await act(async () => host.querySelector<HTMLButtonElement>("header [data-dashboard-back]")!.click());
      expect(view()).toBe("outline_v2");
      expect(host.querySelector("[data-dashboard-back]")).toBeNull();
    });

    it("puts responsibilities with no area in a last, plainly labelled group", async () => {
      api.overview.mockResolvedValue(responsibilityOverviewFixture([{ ...portfolioOnTrack, areaId: null }], [], { areas: [] }));
      await openOutlineV2();
      expect([...outlineV2().querySelectorAll("[data-outline-v2-area]")].map((area) => area.getAttribute("data-outline-v2-area"))).toEqual(["__no_area__"]);
      expect(bar("__no_area__").textContent).toBe("No area");
    });

    it("opens the new-area dialog from the header's primary button", async () => {
      await openOutlineV2();
      // The only button in the header, in the primary style, after search and the counts.
      const headerButtons = [...host.querySelector("header")!.querySelectorAll<HTMLButtonElement>("button")];
      expect(headerButtons.map((button) => button.textContent?.trim())).toEqual(["New area"]);
      const newArea = headerButtons[0]!;
      expect(newArea.getAttribute("data-variant")).toBe("default");
      expect(newArea.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(outlineV2().textContent).not.toContain("New area");
      await act(async () => newArea.click());
      await flush();
      expect(dialog()?.textContent).toContain("Add an area");
    });
  });
});
