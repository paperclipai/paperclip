import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ResponsibilityDashboardState } from "@paperclipai/shared";
import { DashboardChangesCard } from "@/components/responsibilities/DashboardChangesCard";
import { DashboardEditModuleView, DashboardVersionList } from "@/components/responsibilities/DashboardEditModule";
import {
  DASHBOARD_FIXTURE_AGENT_ID,
  dashboardChangesFixture,
  dashboardFixtureAgent,
  dashboardFixtureAgents,
  dashboardStateFixture,
  dashboardVersionsFixture,
  mixedAreaChanges,
} from "../../fixtures/responsibility-dashboard";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

function Gallery() {
  return null;
}

const meta = {
  id: "feature-responsibility-dashboard",
  title: "Oversight and operation/Dashboards and audit trails/Dashboard edit module",
  component: Gallery,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Shipped Dashboard edit module and DashboardChangesCard, behind the experimental enableResponsibilities flag. Proposals show area changes in their headings and explicitly labeled responsibility changes nested under their parent area. Covers first creation, existing and new areas together, an empty new area, rewords, moves, removals, drop/keep dependencies, narrow layout and the correction form. Also covers the edit-module entry states, Undo and versions. States, proposals, versions and the agent are synthetic fixtures; starting, applying, declining and restoring are simulated, so these stories do not prove server guardrails, the writer rule, atomic apply or what a restore puts back.",
    },
  },
  beforeEach: () =>
    prepareFixtureApi([
      { path: `/api/agents/${DASHBOARD_FIXTURE_AGENT_ID}`, method: "GET", read: () => dashboardFixtureAgent },
      {
        path: /^\/api\/issues\/[^/]+\/dashboard-changes\/[^/]+\/accept$/,
        method: "POST",
        read: () => ({
          interaction: dashboardChangesFixture("create", { status: "accepted", result: { version: 1, outcome: "accepted", summary: "Added 4 areas and 6 responsibilities" } }),
          version: dashboardVersionsFixture.versions[3],
        }),
      },
      {
        path: /^\/api\/issues\/[^/]+\/dashboard-changes\/[^/]+\/decline$/,
        method: "POST",
        read: () => dashboardChangesFixture("create", { status: "rejected", result: { version: 1, outcome: "declined" } }),
      },
      { path: /^\/api\/issues\/[^/]+\/comments$/, method: "POST", read: () => ({ id: "comment-not-right", body: "x" }) },
    ]).cleanup,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-3xl flex-col gap-4">{children}</div>;
}

const noop = () => {};

function ModuleIn({ state }: { state: ResponsibilityDashboardState }) {
  return (
    <Column>
      <DashboardEditModuleView
        empty={state.empty}
        state={state}
        agentsById={dashboardFixtureAgents}
        starting={false}
        startError={null}
        undoing={false}
        onStart={noop}
        onUndo={noop}
        onAddArea={noop}
        onOpenVersions={noop}
      />
    </Column>
  );
}

/** An empty dashboard: the owner's words, one button naming the agent, and adding an area by hand kept quiet. */
export const EmptyDashboard: Story = {
  name: "Empty dashboard: create it with an agent",
  render: () => <ModuleIn state={dashboardStateFixture("empty")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Create your custom dashboard" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Start with Chief" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add an area yourself" })).toBeInTheDocument();
  },
};

/** An empty dashboard with no agent that can do it: a few words, and adding an area by hand is the way forward. */
export const EmptyDashboardNoAgent: Story = {
  name: "Empty dashboard: no agent free",
  render: () => <ModuleIn state={dashboardStateFixture("no_agent")} />,
};

/** A populated dashboard: one quiet row below the areas, with a small way to previous versions. */
export const Minimized: Story = {
  name: "Populated dashboard: Edit your dashboard",
  render: () => <ModuleIn state={dashboardStateFixture("populated")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Edit your dashboard" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Versions" })).toBeInTheDocument();
  },
};

/** A conversation is open: the module says so in a few words, with the way into it. */
export const ConversationOpen: Story = {
  name: "Conversation open",
  render: () => (
    <Column>
      <ModuleIn state={dashboardStateFixture("empty_talking")} />
      <ModuleIn state={dashboardStateFixture("talking")} />
    </Column>
  ),
};

/** A first dashboard waits: the changes grouped by area, each droppable; dropping a new area drops what is filed under it. */
export const ProposalCreate: Story = {
  name: "Proposal waiting: a first dashboard",
  render: () => <ModuleIn state={dashboardStateFixture("create_proposal")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fundraising = within(canvas.getByRole("region", { name: "Fundraising" }));
    await expect(fundraising.getByRole("heading", { name: "Fundraising" })).toBeInTheDocument();
    await expect(fundraising.getByText("New area", { exact: true })).toBeInTheDocument();
    const responsibilities = within(fundraising.getByRole("list", { name: "Responsibilities in Fundraising" }));
    await expect(responsibilities.getAllByText("New responsibility", { exact: true })).toHaveLength(2);
    const team = within(canvas.getByRole("region", { name: "Team" }));
    await userEvent.click(team.getAllByRole("button", { name: "Drop this change" })[0]!);
    await expect(team.getByText("Goes with Team")).toBeInTheDocument();
    await userEvent.click(team.getAllByRole("button", { name: "Keep" })[1]!);
    await expect(team.queryByText("Goes with Team")).not.toBeInTheDocument();
  },
};

export const ProposalHierarchy: Story = {
  name: "Proposal hierarchy: new areas and responsibilities",
  render: () => <Column><DashboardChangesCard interaction={dashboardChangesFixture("create")} /></Column>,
};

export const ProposalHierarchyMobile: Story = {
  name: "Proposal hierarchy: mobile",
  render: () => <div className="max-w-sm"><DashboardChangesCard interaction={dashboardChangesFixture("create")} /></div>,
};

export const ProposalNewAndExistingAreas: Story = {
  name: "Proposal hierarchy: new and existing areas",
  render: () => {
    const interaction = dashboardChangesFixture("edit");
    return (
      <Column>
        <DashboardChangesCard interaction={{ ...interaction, payload: { ...interaction.payload, message: "Keep Product focused, and give quality a home of its own.", changes: mixedAreaChanges } }} />
      </Column>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const product = within(canvas.getByRole("region", { name: "Product" }));
    await expect(product.getByText("Existing area")).toBeInTheDocument();
    await expect(product.getByText("New responsibility")).toBeInTheDocument();
    const quality = within(canvas.getByRole("region", { name: "Quality & Reliability" }));
    await expect(quality.getByText("New area")).toBeInTheDocument();
    await expect(quality.getByText("Moved from Product")).toBeInTheDocument();
    const community = within(canvas.getByRole("region", { name: "Community" }));
    await expect(community.queryByRole("list")).not.toBeInTheDocument();
    await userEvent.click(quality.getAllByRole("button", { name: "Drop this change" })[0]!);
    await expect(quality.getAllByText("Goes with Quality & Reliability")).toHaveLength(2);
    await userEvent.click(quality.getAllByRole("button", { name: "Keep" })[2]!);
    await expect(quality.queryByText("Goes with Quality & Reliability")).not.toBeInTheDocument();
    await userEvent.click(quality.getByRole("button", { name: "Keep" }));
  },
};

/** A small edit waits: a reword (old sentence struck through), a move, a removal with its reason, a rename others see too. */
export const ProposalEdit: Story = {
  name: "Proposal waiting: a small edit",
  render: () => <ModuleIn state={dashboardStateFixture("edit_proposal")} />,
};

/** The same proposal as a card in the conversation, and "Not right" asking what should change. */
export const ProposalInConversation: Story = {
  name: "Proposal in the conversation, saying it is not right",
  render: () => <Column><DashboardChangesCard interaction={dashboardChangesFixture("edit")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Not right" }));
    await expect(canvas.getByLabelText("What should change? (optional)")).toBeTruthy();
  },
};

/** Right after applying: what changed, plainly, with Undo; and the settled card lines in the conversation. */
export const AfterApplying: Story = {
  name: "After applying, with Undo",
  render: () => (
    <Column>
      <ModuleIn state={dashboardStateFixture("applied")} />
      <DashboardChangesCard interaction={dashboardChangesFixture("create", { status: "accepted", result: { version: 1, outcome: "accepted", summary: "Added 4 areas and 6 responsibilities" } })} />
      <DashboardChangesCard interaction={dashboardChangesFixture("edit", { status: "rejected", result: { version: 1, outcome: "declined" } })} />
      <DashboardChangesCard interaction={dashboardChangesFixture("edit", { status: "expired", result: { version: 1, outcome: "replaced", replacedByInteractionId: "dashboard-changes-create" } })} />
    </Column>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Added 4 areas and 6 responsibilities.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  },
};

/** The version list: when, who, what changed, and Restore. */
export const Versions: Story = {
  name: "Version list",
  render: () => (
    <Column>
      <DashboardVersionList list={dashboardVersionsFixture} agentsById={dashboardFixtureAgents} restoringId={null} onRestore={noop} />
    </Column>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("button", { name: "Restore" })).toHaveLength(dashboardVersionsFixture.versions.length - 1);
  },
};
