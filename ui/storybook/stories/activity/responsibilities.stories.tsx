import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ResponsibilityOverview } from "@paperclipai/shared";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { Route, Routes } from "@/lib/router";
import { Responsibilities } from "@/pages/Responsibilities";
import {
  DASHBOARD_VIEW_STORAGE_KEY,
  RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY,
  type DashboardView,
  type ResponsibilityPageView,
} from "@/lib/responsibility-views";
import { OUTLINE_V2_COLLAPSED_STORAGE_KEY } from "@/lib/responsibility-outline-v2";
import { ResponsibilityDetail } from "@/pages/ResponsibilityDetail";
import { storybookAgents } from "../../fixtures/paperclipData";
import {
  ALL_FIXTURE_AREAS,
  allOnTrackOverviewFixture,
  denseAutomationFixture,
  denseBoardOverviewFixture,
  EMPTY_LOOSE_WORK,
  fundraisingBehind,
  homeAutomationFixture,
  standingCheckAutomationFixture,
  homeOverviewFixture,
  looseWorkFixture,
  nothingMeasuredOverviewFixture,
  OUTLINE_DENSE_AREA_IDS,
  outlineDenseOverviewFixture,
  outlineNoAreasOverviewFixture,
  portfolioOnTrack,
  proposedDealFlow,
  proposedLpRelations,
  proposedWithoutBar,
  RESPONSIBILITY_DETAIL_FIXTURES,
  responsibilityFixture,
  responsibilityOverviewFixture,
  summaryFixture,
  type SummaryFixtureState,
} from "../../fixtures/responsibilities";
import { METRIC_SET_FIXTURES, statusReportFixture } from "../../fixtures/responsibility-metrics";
import { prepareFixtureApi, type FixtureState } from "../../support/capability-gaps/api";

type Variant = "home" | "proposals" | "empty" | "allOnTrack" | "nothingMeasured" | "dense" | "outlineDense" | "outlineNoAreas";

const OVERVIEWS: Record<Variant, ResponsibilityOverview> = {
  home: homeOverviewFixture,
  proposals: responsibilityOverviewFixture(
    [fundraisingBehind, portfolioOnTrack],
    [proposedDealFlow, proposedLpRelations, proposedWithoutBar],
    { loose: looseWorkFixture },
  ),
  empty: responsibilityOverviewFixture([], [], { loose: EMPTY_LOOSE_WORK }),
  allOnTrack: allOnTrackOverviewFixture,
  nothingMeasured: nothingMeasuredOverviewFixture,
  dense: denseBoardOverviewFixture,
  outlineDense: outlineDenseOverviewFixture,
  outlineNoAreas: outlineNoAreasOverviewFixture,
};

/** Opens a page in one of its views, as if the person had chosen it; restores the previous choice after. */
function chooseView(key: string, view: DashboardView | ResponsibilityPageView) {
  return () => {
    let previous: string | null = null;
    try {
      previous = window.localStorage.getItem(key);
      window.localStorage.setItem(key, view);
    } catch {
      // Without storage the page opens in its full view.
    }
    return () => {
      try {
        if (previous === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, previous);
      } catch {
        // Nothing to restore.
      }
    };
  };
}

/** Opens Outline v2 with these areas folded, as if the person had folded them; restores the previous state after. */
function chooseOutlineV2(collapsed: readonly string[] = []) {
  const view = chooseView(DASHBOARD_VIEW_STORAGE_KEY, "outline_v2");
  return () => {
    const restoreView = view();
    let previous: string | null = null;
    try {
      previous = window.localStorage.getItem(OUTLINE_V2_COLLAPSED_STORAGE_KEY);
      window.localStorage.setItem(OUTLINE_V2_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
    } catch {
      // Without storage every area opens unfolded.
    }
    return () => {
      restoreView();
      try {
        if (previous === null) window.localStorage.removeItem(OUTLINE_V2_COLLAPSED_STORAGE_KEY);
        else window.localStorage.setItem(OUTLINE_V2_COLLAPSED_STORAGE_KEY, previous);
      } catch {
        // Nothing to restore.
      }
    };
  };
}

const primaryAgent = storybookAgents[0]!;

function ResponsibilitiesSurface() {
  return (
    <PrimaryAgentPresentationProvider
      value={{ companyId: primaryAgent.companyId, primaryAgentId: primaryAgent.id, primaryAgent, onChange: () => {} }}
    >
      <Routes>
        <Route path="/PAP/responsibilities" element={<Responsibilities />} />
        <Route path="/PAP/responsibilities/:responsibilityId" element={<ResponsibilityDetail />} />
        {/* Where the Dashboard's composer lands; the Chat page itself has its own stories. */}
        <Route path="/PAP/chats/:agentRef" element={<p data-story-chat-landing="">Opened the chat.</p>} />
      </Routes>
    </PrimaryAgentPresentationProvider>
  );
}

const meta = {
  id: "feature-responsibilities",
  title: "Oversight and operation/Dashboards and audit trails/Responsibilities",
  component: ResponsibilitiesSurface,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/responsibilities"],
    variant: "home" satisfies Variant,
    summaryState: "computed" satisfies SummaryFixtureState,
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Shipped Responsibilities home (titled Dashboard while the flag is on) and responsibility page behind the experimental enableResponsibilities flag, rendered directly (the route gate is not mounted). Areas, responsibilities, rollups, skills, artifacts and mutations, including giving a task, routine or project to an agent, are synthetic fixtures; they do not prove server rollups, status derivation, permissions or assignment. The Dashboard opens on Board and the responsibility page on One screen; the other views (Full, Outline, Outline v2, Exceptions; Full, Scorecard, What's moving) are chosen with the header switch, and their stories seed that choice in local storage. The written summaries are fixtures in their computed, refreshing and model-written states; no model runs. The Dashboard chat composer is the shipped task composer; starting a chat and its first message are simulated. The bar's metric set and the agent-written status are fixtures, absent (so the bar reads as before) unless a story names them; no agent proposes or records anything.",
    },
  },
  beforeEach: ({ parameters }) => {
    // How many times each summary was read, so "refreshing" can turn into a model-written one.
    const summaryReads = { dashboard: 0, detail: 0 };
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/responsibilities",
          method: "GET",
          read: () => OVERVIEWS[(parameters.variant as Variant | undefined) ?? "home"],
        },
        // The Outline v2 view's edit module: no conversation yet, nothing to undo.
        {
          path: "/api/companies/company-storybook/responsibility-dashboard",
          method: "GET",
          read: ({ url }) => ({
            ownerUserId: url.searchParams.get("ownerUserId") ?? "user-storybook",
            empty: false,
            state: "none",
            defaultAgentId: storybookAgents[0]?.id ?? null,
            conversation: null,
            proposal: null,
            latestChange: null,
          }),
        },
        {
          path: "/api/companies/company-storybook/responsibility-areas",
          method: "GET",
          read: () => ALL_FIXTURE_AREAS.filter((area) => area.status !== "archived"),
        },
        // How automated each responsibility is (the Automation view and One screen's line).
        {
          path: "/api/companies/company-storybook/responsibilities/automation",
          method: "GET",
          read: () => parameters.automation === "standing"
            ? standingCheckAutomationFixture
            : (parameters.variant as Variant | undefined) === "dense" ? denseAutomationFixture : homeAutomationFixture,
        },
        // Opening the conversation with the agent about automating a task: a new conversation, simulated.
        {
          path: /^\/api\/issues\/[^/]+\/automation-conversation$/,
          method: "POST",
          read: ({ url, body }) => ({
            sourceIssueId: url.pathname.split("/")[3],
            state: "discussing",
            defaultAgentId: String(body.agentId ?? "agent-codex"),
            conversation: { issueId: "conversation-story", identifier: "PAP-90", title: "Automate", status: "todo", agentId: String(body.agentId ?? "agent-codex"), createdAt: new Date() },
            proposal: null,
          }),
        },
        // Pausing, resuming or removing a standing check: echoed.
        {
          path: /^\/api\/routines\/[^/]+$/,
          method: "PATCH",
          read: ({ url, body }) => ({ id: url.pathname.split("/")[3], status: body.status }),
        },
        // Turning a task into a routine, accepting or declining an agent's offer: echoed.
        {
          path: /^\/api\/issues\/[^/]+\/repeat-as-routine$/,
          method: "POST",
          read: ({ body }) => ({
            routine: { id: "routine-story", title: String(body.title ?? "New routine"), assigneeAgentId: String(body.assigneeAgentId ?? ""), projectId: null, status: "active" },
            cadenceLabel: "Every Monday at 9 AM",
            timezone: String(body.timezone ?? "UTC"),
            responsibilityIds: ["resp-fundraising"],
            acceptedOfferId: null,
          }),
        },
        {
          path: /^\/api\/issues\/[^/]+\/routine-suggestions\/[^/]+\/accept$/,
          method: "POST",
          read: ({ url }) => ({
            interaction: { id: url.pathname.split("/")[5], status: "accepted" },
            routine: { id: "routine-story-offer", title: "Monthly investor update" },
          }),
        },
        {
          path: /^\/api\/issues\/[^/]+\/routine-suggestions\/[^/]+\/decline$/,
          method: "POST",
          read: ({ url }) => ({ id: url.pathname.split("/")[5], status: "rejected" }),
        },
        { path: "/api/companies/company-storybook/agents", method: "GET", read: () => storybookAgents },
        {
          path: "/api/companies/company-storybook/responsibilities/summary",
          method: "GET",
          read: () => summaryFixture((parameters.summaryState as SummaryFixtureState | undefined) ?? "computed", "dashboard", summaryReads.dashboard++),
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/summary$/,
          method: "GET",
          read: () => summaryFixture((parameters.summaryState as SummaryFixtureState | undefined) ?? "computed", "detail", summaryReads.detail++),
        },
        // The bar module's metric set and the agent-written status: absent unless a story names them, so the bar reads as before.
        {
          path: /^\/api\/responsibilities\/[^/]+\/metrics$/,
          method: "GET",
          read: () => {
            const set = parameters.metricSet as keyof typeof METRIC_SET_FIXTURES | undefined;
            return set ? METRIC_SET_FIXTURES[set] : Response.json({ error: "Not found" }, { status: 404 });
          },
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/status-report$/,
          method: "GET",
          read: () => (parameters.statusReport ? statusReportFixture() : Response.json({ error: "Not found" }, { status: 404 })),
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/status-report\/request$/,
          method: "POST",
          read: () => statusReportFixture({}, { updateRequested: true }),
        },
        // The Dashboard composer: the one-per-agent chat, then its first message.
        {
          path: /^\/api\/companies\/company-storybook\/chats\/[^/]+$/,
          method: "POST",
          read: ({ url }) => ({
            id: "issue-chat-story",
            companyId: "company-storybook",
            identifier: null,
            title: "Chat",
            status: "in_review",
            conversationAgentId: decodeURIComponent(url.pathname.split("/").at(-1)!),
            updatedAt: new Date(),
          }),
        },
        {
          path: /^\/api\/issues\/[^/]+\/comments$/,
          method: "POST",
          read: ({ url, body }) => ({ id: "comment-story", issueId: url.pathname.split("/")[3], body: body.body, createdAt: new Date() }),
        },
        {
          path: "/api/companies/company-storybook/activity",
          method: "GET",
          read: () => [
            {
              action: "responsibility.metric_updated",
              actorType: "agent",
              actorId: "agent-codex",
              agentId: "agent-codex",
              entityType: "responsibility",
              entityId: "resp-fundraising",
              createdAt: "2026-11-12T08:00:00.000Z",
            },
          ],
        },
        {
          path: /^\/api\/responsibilities\/[^/]+$/,
          method: "GET",
          read: ({ url }) => RESPONSIBILITY_DETAIL_FIXTURES[url.pathname.split("/").at(-1)!] ?? RESPONSIBILITY_DETAIL_FIXTURES["resp-fundraising"],
        },
        {
          path: /^\/api\/responsibilities\/[^/]+$/,
          method: "PATCH",
          read: ({ url, body }) => {
            const id = url.pathname.split("/").at(-1)!;
            const all = [...OVERVIEWS.proposals.proposed, ...OVERVIEWS.home.responsibilities];
            const item = all.find((candidate) => candidate.id === id) ?? fundraisingBehind;
            return { ...item, ...body };
          },
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/links$/,
          method: "POST",
          read: ({ url, body }) => ({
            link: { id: "link-new", companyId: "company-storybook", responsibilityId: url.pathname.split("/")[3], projectId: null, issueId: null, routineId: null, ...body, createdAt: new Date() },
          }),
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/links\/[^/]+$/,
          method: "DELETE",
          read: ({ url }) => ({ id: url.pathname.split("/").at(-1) }),
        },
        // Adding a responsibility (Outline v2 sends only its sentence, as the title): echoed.
        {
          path: "/api/companies/company-storybook/responsibilities",
          method: "POST",
          read: ({ body }) => responsibilityFixture({
            id: "resp-new",
            title: String(body.title ?? "New responsibility"),
            areaId: typeof body.areaId === "string" ? body.areaId : null,
          }),
        },
        {
          path: "/api/companies/company-storybook/responsibility-areas",
          method: "POST",
          read: ({ body }) => ({ ...ALL_FIXTURE_AREAS[0]!, id: "area-new", title: String(body.title ?? "New area") }),
        },
        {
          path: /^\/api\/responsibility-areas\/[^/]+$/,
          method: "PATCH",
          read: ({ url, body }) => ({ ...(ALL_FIXTURE_AREAS.find((area) => area.id === url.pathname.split("/").at(-1)) ?? ALL_FIXTURE_AREAS[0]!), ...body }),
        },
        // "Give to an agent" on one item: the app's own assign calls, echoed.
        { path: /^\/api\/issues\/[^/]+$/, method: "PATCH", read: ({ url, body }) => ({ id: url.pathname.split("/").at(-1), ...body }) },
        { path: /^\/api\/routines\/[^/]+$/, method: "PATCH", read: ({ url, body }) => ({ id: url.pathname.split("/").at(-1), ...body }) },
        { path: /\/projects\/[^/]+$/, method: "PATCH", read: ({ url, body }) => ({ id: url.pathname.split("/").at(-1), ...body }) },
        {
          path: /^\/api\/responsibilities\/[^/]+\/delegate$/,
          method: "POST",
          read: ({ body }) => ({
            issue: {
              id: "issue-delegated",
              companyId: "company-storybook",
              identifier: "PAP-77",
              title: String(body.title ?? "Delegated task"),
              status: "todo",
              assigneeAgentId: String(body.assigneeAgentId ?? primaryAgent.id),
              projectId: null,
            },
            link: { id: "link-delegated", companyId: "company-storybook", responsibilityId: "resp-fundraising", projectId: null, issueId: "issue-delegated", routineId: null, createdAt: new Date() },
          }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof ResponsibilitiesSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Home: what needs you first, then one responsibility in each status (behind,
 * at risk and stale, on track, not measured, and one marked at risk by hand)
 * grouped by area, what runs without you, and the work outside any responsibility.
 */
export const OverviewMixedHealth: Story = {
  name: "Home",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "What you own" });
    await expect(canvas.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Running without you" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Outside your responsibilities" })).toBeInTheDocument();
    await expect(canvas.getAllByText("Investor update deck is 3 days past its target date").length).toBeGreaterThan(0);
    await userEvent.click(canvas.getByRole("button", { name: /^On track/ }));
    await expect(canvas.getByText("Showing only on track.")).toBeInTheDocument();
  },
};

/** Proposals the onboarding guide drafted, grouped by area, one without a bar yet. */
export const OverviewWithProposals: Story = {
  name: "Home with proposals",
  parameters: { variant: "proposals" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: /Proposed for you/ });
    // The one without a bar can be confirmed as it is: it reads as not measured until its bar is set.
    await expect(canvas.getByRole("button", { name: /Confirm all 3/ })).toBeInTheDocument();
  },
};

/** Nothing yet: add one, or ask the primary agent to draft them. */
export const OverviewEmpty: Story = {
  name: "Home, empty",
  parameters: { variant: "empty" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("What do you own?");
    await expect(canvas.getByRole("link", { name: new RegExp(`Ask ${primaryAgent.name} to draft them`) })).toBeInTheDocument();
  },
};

export const OverviewLoading: Story = { name: "Home, loading", parameters: { fixtureState: "loading" }, beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "full") };
export const OverviewFailed: Story = { name: "Home, failed", parameters: { fixtureState: "failure" }, beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "full") };

/**
 * A responsibility that is behind: its bar first, the work summary, projects,
 * tasks and routines (each can be given to an agent), the skills of the agents
 * on it and its artifacts as card grids (cut short at 3 of 63).
 */
export const AreaView: Story = {
  name: "Responsibility page",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "The bar" });
    await expect(canvas.getByRole("heading", { name: /^Skills/ })).toBeInTheDocument();
    await expect(canvas.getByText("Showing the newest 3 of 63.")).toBeInTheDocument();
    await expect(canvas.getByText(/1 task is blocked/)).toBeInTheDocument();
  },
};

/** At risk, lower is better, and the number has not been updated in over two weeks. */
export const ResponsibilityStale: Story = {
  name: "Responsibility page, stale number",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-lp-updates"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "The bar" });
    await expect(canvas.getAllByText(/Not updated in/).length).toBeGreaterThan(0);
  },
};

/** On track, with an agent holding its tasks and a routine doing the work. */
export const ResponsibilityOnTrack: Story = {
  name: "Responsibility page, on track",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-portfolio"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
};

/** Not measured yet, with nothing filed under it: every section says what belongs there. */
export const ResponsibilityNotMeasured: Story = {
  name: "Responsibility page, not measured",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-hiring"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Nothing produced yet/);
  },
};

/** The number says on track; the owner marked it at risk with a note. */
export const ResponsibilityOverridden: Story = {
  name: "Responsibility page, status set by hand",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-board-reporting"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/From the number alone it is on track/);
  },
};

// ---------------------------------------------------------------------------
// Simpler views, chosen with the switch in each page's header
// ---------------------------------------------------------------------------

/**
 * Dashboard, Outline: the person and the overall status, four numbers with
 * one exception each, then each area with its responsibilities as statements
 * of what must be true. Keeps New area and New responsibility.
 */
export const DashboardOutline: Story = {
  name: "Dashboard view: Outline",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "outline"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Overview" });
    await expect(canvas.getByText("1 responsibility is behind and 2 are at risk.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "New area" })).toBeInTheDocument();
    await expect(canvas.getAllByText("0% on track").length).toBeGreaterThan(0);
  },
};

/** Dashboard, Outline, with proposals waiting: one notice instead of the review. */
export const DashboardOutlineWithProposals: Story = {
  name: "Dashboard view: Outline with proposals",
  parameters: { variant: "proposals" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "outline"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 proposed responsibilities are waiting for your review.");
  },
};

/**
 * Dashboard, Board (the default view): where things stand with a paragraph
 * composed from the numbers, then areas as rows and the four statuses as
 * columns, each card saying why it has its status. The chat composer sits at
 * the foot of the page.
 */
export const DashboardBoard: Story = {
  name: "Dashboard view: Board",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Where things stand" });
    await canvas.findByText("Summarized from the numbers");
    await expect(canvas.getByRole("link", { name: /Seed extension/ })).toBeInTheDocument();
    await expect(canvas.getByText("11 short of 20")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add responsibility" })).toBeInTheDocument();
  },
};

/** Dashboard, Board, dense: four areas with 6 to 9 responsibilities each, every status and kind of reason, long titles. */
export const DashboardBoardDense: Story = {
  name: "Dashboard view: Board, dense",
  parameters: { variant: "dense" satisfies Variant },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "People and hiring" });
    await expect(canvas.getAllByText("No work is filed under this yet.").length).toBeGreaterThan(1);
    await expect(canvas.getByText("4 hours inside the limit of 24 hours")).toBeInTheDocument();
  },
};

/** Dashboard, Board, with the paragraph a model wrote, labelled as AI-written. */
export const DashboardBoardModelSummary: Story = {
  name: "Dashboard view: Board, AI summary",
  parameters: { variant: "dense" satisfies Variant, summaryState: "model" satisfies SummaryFixtureState },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Written by AI");
  },
};

/**
 * Dashboard, Board, while the AI version is being written: the computed
 * paragraph shows at once, then the page reads it again and swaps in the
 * model-written one without a loading state.
 */
export const DashboardBoardRefreshingSummary: Story = {
  name: "Dashboard view: Board, AI summary on the way",
  parameters: { summaryState: "refreshing" satisfies SummaryFixtureState },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("AI summary on the way");
    await canvas.findByText("Written by AI", undefined, { timeout: 6000 });
  },
};

/** Dashboard, chat composer: Enter starts a chat with the chosen agent and opens it. */
export const DashboardChatComposer: Story = {
  name: "Dashboard: start a chat",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Where things stand" });
    await expect(canvasElement.querySelector("[data-dashboard-chat]")).not.toBeNull();
  },
};

/** Dashboard, Board, with nothing measured yet. */
export const DashboardBoardNothingMeasured: Story = {
  name: "Dashboard view: Board, nothing measured",
  parameters: { variant: "nothingMeasured" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "board"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Where things stand" });
    await expect(canvas.getAllByText("Not measured").length).toBeGreaterThan(1);
  },
};

/**
 * Dashboard, Automation: how much runs without you (the four levels over one
 * bar, automations running and manual tasks, one sentence; each count filters
 * the rows), then the areas with one full-width row per responsibility, the
 * most manual first. No status marks anywhere. The fixture has one
 * responsibility at each level and every way an automation starts: Portfolio
 * runs on a schedule, a webhook and a standing check that acted; Board
 * reporting has a routine that runs on request, a standing check whose agent
 * never wakes up and a task whose proposal is waiting; Seed extension has an
 * agent's pending offer, a webhook hint with a conversation open, a
 * standing-check hint and tasks with no hint behind "and 2 more".
 */
export const DashboardAutomation: Story = {
  name: "Dashboard view: Automation",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "How much runs without you" });
    await expect(canvas.getByText("2 of your 5 responsibilities have nothing automated yet; 7 manual tasks could be automated.")).toBeInTheDocument();
    await expect(canvas.getByText("CodexCoder offered to repeat it: On the 1st of every month at 9 AM")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /Automate with CodexCoder/ })).toBeInTheDocument();
    await expect(canvas.getByText("Nothing is filed under this yet.")).toBeInTheDocument();
    await expect(canvas.getByText("The automations are covering the work.")).toBeInTheDocument();
    await expect(canvas.queryByText("Behind")).not.toBeInTheDocument();
  },
};

/** Dashboard, Automation: Portfolio's row, with an automation of each kind: a schedule, a webhook (its address and how it is secured) and a standing check. */
export const DashboardAutomationEachTrigger: Story = {
  name: "Dashboard view: Automation, a row with each way to start",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "How much runs without you" });
    await userEvent.click(canvas.getByRole("button", { name: /^Automated/ }));
    await expect(canvas.getByText("Answer new founder requests")).toBeInTheDocument();
    await expect(canvas.getByText(/POST https:\/\/paperclip\.example/)).toBeInTheDocument();
    await expect(canvas.getByText(/Last checked 2 hours ago: acted/)).toBeInTheDocument();
  },
};

/** Dashboard, Automation: a task whose conversation has a proposal waiting offers to review it, and a conversation in progress offers to continue. */
export const DashboardAutomationPendingProposal: Story = {
  name: "Dashboard view: Automation, a proposal waiting",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "How much runs without you" });
    await expect(canvas.getByRole("button", { name: /’s proposal/ })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Continue with CodexCoder" })).toBeInTheDocument();
  },
};

/** Dashboard, Automation: standing checks in every state: not checked yet, nothing needed, acted, paused (Resume) and an agent that never wakes up. */
export const DashboardAutomationStandingChecks: Story = {
  name: "Dashboard view: Automation, standing checks",
  parameters: { automation: "standing" },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "How much runs without you" });
    await expect(canvas.getByText(/Not checked yet/)).toBeInTheDocument();
    await expect(canvas.getByText(/nothing needed/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Resume Chase unsigned side letters" })).toBeInTheDocument();
    await expect(canvas.getByText(/doesn’t wake up on its own/)).toBeInTheDocument();
  },
};

/** Dashboard, Automation, dense: every level in every area, long task titles, paused and unassigned automations. */
export const DashboardAutomationDense: Story = {
  name: "Dashboard view: Automation, dense",
  parameters: { variant: "dense" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "People and hiring" });
    await expect(canvas.getAllByText("Nothing is filed under this yet.").length).toBeGreaterThan(1);
  },
};

/** Dashboard, Automation, opened while the page's reads are still loading. */
export const DashboardAutomationLoading: Story = {
  name: "Dashboard view: Automation, loading",
  parameters: { fixtureState: "loading" },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
};

/**
 * Dashboard, Automation: "Set up by hand" on a suggested task opens the small
 * form, prefilled from the task and the cadence its title suggests.
 */
export const DashboardMakeRoutine: Story = {
  name: "Dashboard: set a task up by hand",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "automation"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "How much runs without you" });
    const [make] = canvas.getAllByRole("button", { name: "Set up by hand" });
    await userEvent.click(make!);
    const body = within(canvasElement.ownerDocument.body);
    await body.findByRole("heading", { name: "Make it a routine" });
    // The first suggestion on the page: LP updates, Manual.
    await expect(body.getByRole("textbox", { name: "What repeats" })).toHaveValue("Write the November LP letter");
    await expect(body.getByText(/Every Monday at 9 AM, your time/)).toBeInTheDocument();
  },
};

/** Dashboard, Exceptions: one sentence, what is wrong, and one line per area for what is on track. */
export const DashboardExceptions: Story = {
  name: "Dashboard view: Exceptions",
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "exceptions"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("1 responsibility is behind and 2 are at risk.");
    await expect(canvas.getByText("Portfolio: 1 of 1 on track")).toBeInTheDocument();
  },
};

/** Dashboard, Exceptions, when everything is on track: very short. */
export const DashboardExceptionsAllOnTrack: Story = {
  name: "Dashboard view: Exceptions, all on track",
  parameters: { variant: "allOnTrack" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "exceptions"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Everything you own is on track.");
    await expect(canvas.queryByText(/Needs a look/)).not.toBeInTheDocument();
  },
};

/** Dashboard, Outline, when everything is on track. */
export const DashboardOutlineAllOnTrack: Story = {
  name: "Dashboard view: Outline, all on track",
  parameters: { variant: "allOnTrack" satisfies Variant },
  beforeEach: chooseView(DASHBOARD_VIEW_STORAGE_KEY, "outline"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Everything you own is on track.");
  },
};

/**
 * Dashboard, Outline v2: only the areas, each a card whose bar folds it, and
 * under each the responsibilities as the sentence of what must be true (the
 * title when there is none). No status, numbers or labels. "New area" above
 * the areas and a "+" on each bar; Legal holds nothing yet.
 */
export const DashboardOutlineV2: Story = {
  name: "Dashboard view: Outline v2",
  beforeEach: chooseOutlineV2(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fundraising = await canvas.findByRole("button", { name: "Fundraising", expanded: true });
    await expect(canvas.getByRole("link", { name: fundraisingBehind.standard! })).toBeInTheDocument();
    await expect(canvas.queryByText(/Behind|At risk|On track|Not measured/)).not.toBeInTheDocument();
    await userEvent.click(fundraising);
    await expect(canvas.getByRole("button", { name: "Fundraising", expanded: false })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Fundraising", expanded: false }));
  },
};

/** Dashboard, Outline v2, dense: 46 responsibilities in 22 areas, long sentences wrapping, titles where there is no sentence. */
export const DashboardOutlineV2Dense: Story = {
  name: "Dashboard view: Outline v2, dense",
  parameters: { variant: "outlineDense" satisfies Variant },
  beforeEach: chooseOutlineV2(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Design system", expanded: true });
    await expect(canvas.getByRole("link", { name: "Every screen is built from tokens, with no one-off colors, sizes, or shadows." })).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "Settings layout" })).toBeInTheDocument();
  },
};

/** Dashboard, Outline v2, dense, with most areas folded: their bars only. */
export const DashboardOutlineV2Collapsed: Story = {
  name: "Dashboard view: Outline v2, some areas folded",
  parameters: { variant: "outlineDense" satisfies Variant },
  beforeEach: chooseOutlineV2(OUTLINE_DENSE_AREA_IDS.filter((_, index) => index % 4 !== 0)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Design system", expanded: true });
    await expect(canvas.getByRole("button", { name: "Information architecture", expanded: false })).toBeInTheDocument();
  },
};

/** Dashboard, Outline v2: an area with nothing in it offers its first responsibility, one sentence. */
export const DashboardOutlineV2EmptyArea: Story = {
  name: "Dashboard view: Outline v2, adding to an empty area",
  beforeEach: chooseOutlineV2(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Legal", expanded: true });
    await userEvent.click(canvas.getByRole("button", { name: "Add a responsibility" }));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(await dialog.findByRole("heading", { name: "New responsibility" })).toBeInTheDocument();
    await expect(dialog.getByRole("textbox", { name: "What must be true?" })).toBeInTheDocument();
  },
};

/** Dashboard, Outline v2, with responsibilities and no areas at all: one plain last group. */
export const DashboardOutlineV2NoAreas: Story = {
  name: "Dashboard view: Outline v2, no areas",
  parameters: { variant: "outlineNoAreas" satisfies Variant },
  beforeEach: chooseOutlineV2(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "No area", expanded: true });
  },
};

/** Dashboard, Outline v2, with proposals waiting: the same compact notice as the other simple views. */
export const DashboardOutlineV2WithProposals: Story = {
  name: "Dashboard view: Outline v2 with proposals",
  parameters: { variant: "proposals" satisfies Variant },
  beforeEach: chooseOutlineV2(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 proposed responsibilities are waiting for your review.");
  },
};

/** Responsibility page, Scorecard: the number against its target, large, and three counts. */
export const ResponsibilityScorecard: Story = {
  name: "Responsibility view: Scorecard",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "scorecard"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("1 blocked, 2 with agents");
    await expect(canvas.getByText("1 late")).toBeInTheDocument();
  },
};

/** Responsibility page, Scorecard, not measured and with nothing under it. */
export const ResponsibilityScorecardNotMeasured: Story = {
  name: "Responsibility view: Scorecard, not measured",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-hiring"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "scorecard"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No reading yet");
  },
};

/** Responsibility page, What's moving: the summary first, then one list of the work, attention first. */
export const ResponsibilityWhatsMoving: Story = {
  name: "Responsibility view: What's moving",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "moving"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: /^The work/ });
    await expect(canvas.getByText("Needs attention")).toBeInTheDocument();
  },
};

/** Responsibility page, What's moving, at risk on a stale number. */
export const ResponsibilityWhatsMovingStale: Story = {
  name: "Responsibility view: What's moving, stale number",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-lp-updates"] },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "moving"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Not updated in/);
  },
};

/**
 * Responsibility page, One screen (the default view): the bar with "Edit the
 * bar" and a paragraph on what is affecting the number, beside short capped
 * lists where each item says how it bears on the number; the full page's
 * header actions; skills and artifacts beneath.
 */
export const ResponsibilityOneScreen: Story = {
  name: "Responsibility view: One screen",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "The bar" });
    await canvas.findByRole("heading", { name: "What is affecting the number" });
    await expect(canvas.getByText("and 1 more")).toBeInTheDocument();
    await expect(canvas.getByText("3 days late (due Nov 10)")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Edit the bar" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "New task for an agent" })).toBeInTheDocument();
    await canvas.findByText("1 routine · 4 one-off tasks · 20% on routines");
    await expect(canvas.getByRole("button", { name: "Make “Ask Dana for an intro to the lead” a routine" })).toBeInTheDocument();
  },
};

/**
 * Responsibility page, One screen, with the agent's metric set and its written
 * status: the status leads the bar, the number's status beneath it, then the
 * bar's own metric as a line, intro meetings as bars per week and replies as
 * a share. The work column puts routines and skills first, then projects and
 * tasks, then artifacts.
 */
export const ResponsibilityOneScreenMetrics: Story = {
  name: "Responsibility view: One screen, metrics and agent status",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"], metricSet: "chosen", statusReport: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Written by CodexCoder · 2 days ago");
    await canvas.findByRole("heading", { name: "Intro meetings booked per week" });
    await expect(canvas.getByRole("button", { name: "Ask CodexCoder for an update" })).toBeInTheDocument();
    const order = [...canvasElement.querySelectorAll<HTMLElement>("[data-work-order] [data-work-list], [data-work-order] [data-card-list]")]
      .map((node) => node.dataset.workList ?? node.dataset.cardList);
    await expect(order).toEqual(["routine", "skill", "project", "task", "artifact"]);
  },
};

/** Responsibility page, Full, with starter metrics computed from the work. */
export const ResponsibilityPageStarterMetrics: Story = {
  name: "Responsibility page, starter metrics",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"], metricSet: "starter" },
  beforeEach: chooseView(RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY, "full"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Starter metrics from your work so far");
    await expect(canvas.getByRole("heading", { name: "Tasks finished per week" })).toBeInTheDocument();
  },
};

/** Responsibility page, One screen, with the AI-written paragraph. */
export const ResponsibilityOneScreenModelSummary: Story = {
  name: "Responsibility view: One screen, AI summary",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"], summaryState: "model" satisfies SummaryFixtureState },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Written by AI");
  },
};

/** Responsibility page, One screen, while the AI paragraph is on its way. */
export const ResponsibilityOneScreenRefreshingSummary: Story = {
  name: "Responsibility view: One screen, AI summary on the way",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-fundraising"], summaryState: "refreshing" satisfies SummaryFixtureState },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("AI summary on the way");
  },
};

/** Responsibility page, One screen, not measured and with nothing under it. */
export const ResponsibilityOneScreenNotMeasured: Story = {
  name: "Responsibility view: One screen, not measured",
  parameters: { initialEntries: ["/PAP/responsibilities/resp-hiring"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No open tasks.");
  },
};
