import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ResponsibilityOverview, ResponsibilityStatusReportsOverview } from "@paperclipai/shared";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { DASHBOARD_VIEW_STORAGE_KEY } from "@/lib/responsibility-views";
import { Route, Routes } from "@/lib/router";
import { Responsibilities } from "@/pages/Responsibilities";
import { storybookAgents } from "../../fixtures/paperclipData";
import { ALL_FIXTURE_AREAS, homeOverviewFixture } from "../../fixtures/responsibilities";
import {
  allFreshStatusReportsFixture,
  denseAgentStatusOverviewFixture,
  denseStatusReportsFixture,
  mixedStatusReportsFixture,
  noneWrittenStatusReportsFixture,
} from "../../fixtures/responsibility-status-reports";
import { prepareFixtureApi, type FixtureState } from "../../support/capability-gaps/api";

type Variant = "mixed" | "fresh" | "none" | "dense";

const DATA: Record<Variant, { overview: ResponsibilityOverview; reports: ResponsibilityStatusReportsOverview }> = {
  mixed: { overview: homeOverviewFixture, reports: mixedStatusReportsFixture },
  fresh: { overview: homeOverviewFixture, reports: allFreshStatusReportsFixture },
  none: { overview: homeOverviewFixture, reports: noneWrittenStatusReportsFixture },
  dense: { overview: denseAgentStatusOverviewFixture, reports: denseStatusReportsFixture },
};

const primaryAgent = storybookAgents[0]!;

function AgentStatusSurface() {
  return (
    <PrimaryAgentPresentationProvider
      value={{ companyId: primaryAgent.companyId, primaryAgentId: primaryAgent.id, primaryAgent, onChange: () => {} }}
    >
      <Routes>
        <Route path="/PAP/responsibilities" element={<Responsibilities />} />
        <Route path="/PAP/responsibilities/:responsibilityId" element={<p data-story-responsibility-landing="">Opened the responsibility.</p>} />
      </Routes>
    </PrimaryAgentPresentationProvider>
  );
}

const meta = {
  id: "feature-responsibilities-agent-status",
  title: "Oversight and operation/Dashboards and audit trails/Responsibilities, agent status",
  component: AgentStatusSurface,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/responsibilities"],
    variant: "mixed" satisfies Variant,
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "The Dashboard's Agent status view behind the experimental enableResponsibilities flag, rendered through the shipped page with the view chosen in local storage. Responsibilities, areas and the agent-written status reports are synthetic fixtures: they do not prove the reporter rule, who may write, freshness on the server, or that an agent ran. Asking for an update and a person's correction are echoed by the fixture API; no task is created and no agent wakes.",
    },
  },
  beforeEach: ({ parameters }) => {
    const data = DATA[(parameters.variant as Variant | undefined) ?? "mixed"];
    let previous: string | null = null;
    try {
      previous = window.localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY);
      window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, "agent_status");
    } catch {
      // Without storage the Dashboard opens on its default view.
    }
    const cleanup = prepareFixtureApi(
      [
        { path: "/api/companies/company-storybook/responsibilities", method: "GET", read: () => data.overview },
        { path: "/api/companies/company-storybook/responsibilities/status-reports", method: "GET", read: () => data.reports },
        {
          path: "/api/companies/company-storybook/responsibility-areas",
          method: "GET",
          read: () => ALL_FIXTURE_AREAS.filter((area) => area.status !== "archived"),
        },
        { path: "/api/companies/company-storybook/agents", method: "GET", read: () => storybookAgents },
        {
          path: /^\/api\/responsibilities\/[^/]+\/status-report\/request$/,
          method: "POST",
          read: () => ({ current: null, reporterAgentId: "agent-codex", updateRequested: true, history: [] }),
        },
        {
          path: /^\/api\/responsibilities\/[^/]+\/status-report$/,
          method: "POST",
          read: ({ body }) => ({
            current: { ...body, detail: body.detail ?? null, agentId: null, userId: "user-storybook", writtenAt: new Date().toISOString(), outOfDate: false },
            reporterAgentId: "agent-codex",
            updateRequested: false,
            history: [],
          }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
    return () => {
      cleanup();
      try {
        if (previous === null) window.localStorage.removeItem(DASHBOARD_VIEW_STORAGE_KEY);
        else window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, previous);
      } catch {
        // Nothing to restore.
      }
    };
  },
} satisfies Meta<typeof AgentStatusSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Mixed: a fresh agent report with detail, one out of date, one corrected by
 * the person, and one with no report (from the number) whose update was asked
 * for. The four counts, the summary composed from the reports, and the areas.
 */
export const Mixed: Story = {
  name: "Dashboard view: Agent status",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 written by agents · 1 out of date · 1 written by a person · 1 from the number");
    await expect(canvas.getByText("Waiting for CTO")).toBeInTheDocument();
    await expect(canvas.getByText(/From the number, not from an agent/)).toBeInTheDocument();
    await expect(canvas.getByText("Out of date · written 9 days ago", { exact: false })).toBeInTheDocument();
  },
};

/** Every status written by an agent this week, one of them "can't tell yet". */
export const AllFresh: Story = {
  name: "Dashboard view: Agent status, all fresh",
  parameters: { variant: "fresh" satisfies Variant },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("5 written by agents · 0 from the numbers");
    await expect(canvas.getAllByText("Can't tell yet").length).toBeGreaterThan(0);
  },
};

/** No agent has written anything: every row says it is from the number and whose view it waits for. */
export const NoneWritten: Story = {
  name: "Dashboard view: Agent status, none written",
  parameters: { variant: "none" satisfies Variant },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No agent has written a status yet. Every status below comes from the numbers.");
    await expect(canvas.getAllByText(/From the number, not from an agent/)).toHaveLength(5);
  },
};

/** 46 responsibilities across 22 areas, as one of the demo dashboards has; an area folds. */
export const Dense: Story = {
  name: "Dashboard view: Agent status, dense",
  parameters: { variant: "dense" satisfies Variant },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const onboarding = await canvas.findByRole("button", { name: /^Onboarding/ });
    await expect(onboarding).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(onboarding);
    await expect(onboarding).toHaveAttribute("aria-expanded", "false");
  },
};

/** The person corrects a status by hand. */
export const EditStatus: Story = {
  name: "Dashboard view: Agent status, edit",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit the status of Hiring" }));
    const dialog = within(document.body);
    await dialog.findByRole("heading", { name: "Edit the status" });
  },
};

/** Opened while the reports are still loading. */
export const Loading: Story = {
  name: "Dashboard view: Agent status, loading",
  parameters: { fixtureState: "loading" },
};
