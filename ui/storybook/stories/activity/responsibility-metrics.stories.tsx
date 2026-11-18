import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { Agent, ResponsibilityMetricSet } from "@paperclipai/shared";
import { BarProposalCard } from "@/components/responsibilities/BarProposalCard";
import { ResponsibilityMetricSetView } from "@/components/responsibilities/ResponsibilityMetricSet";
import { ResponsibilityStatusBlock } from "@/components/responsibilities/ResponsibilityStatusLead";
import { Card } from "@/components/ui/card";
import { storybookAgents } from "../../fixtures/paperclipData";
import { metricFixture, RESPONSIBILITY_FIXTURE_NOW } from "../../fixtures/responsibilities";
import { BAR_FIXTURE_AGENT_ID } from "../../fixtures/responsibility-bars";
import {
  barProposalWithMetricsFixture,
  METRIC_FIXTURE_AGENT_ID,
  METRIC_SET_FIXTURES,
  statusReportFixture,
} from "../../fixtures/responsibility-metrics";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

const agentsById = new Map<string, Agent>([
  [METRIC_FIXTURE_AGENT_ID, { ...(storybookAgents[0]!), id: METRIC_FIXTURE_AGENT_ID, name: "CodexCoder" }],
]);
const primary = metricFixture({ current: 9, attainment: 0.45, updatedAt: new Date("2026-11-12T08:00:00Z") });
const proposalAgent = { ...(storybookAgents[0]!), id: BAR_FIXTURE_AGENT_ID, name: "Chief of staff" };

function Gallery() {
  return null;
}

const meta = {
  id: "feature-responsibility-metrics",
  title: "Oversight and operation/Dashboards and audit trails/Responsibility metrics",
  component: Gallery,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Shipped pieces of a responsibility's bar module behind the experimental enableResponsibilities flag: up to three metrics drawn in their forms (a large number, a percentage ring, a line over time, bars per week) as the full layout's row and One screen's stack draw them, starters computed from the work, sparse and stale histories, the agent-written status leading the bar's status, and the bar proposal card carrying a metric set. Metric sets, readings, status reports and the agent are synthetic fixtures; these stories do not prove the server's starter rule, who may record readings, or the atomic accept.",
    },
  },
  beforeEach: () =>
    prepareFixtureApi([
      { path: `/api/agents/${BAR_FIXTURE_AGENT_ID}`, method: "GET", read: () => proposalAgent },
      { path: /^\/api\/responsibilities\/[^/]+\/status-report$/, method: "GET", read: () => statusReportFixture() },
      { path: /^\/api\/responsibilities\/[^/]+\/status-report\/request$/, method: "POST", read: () => statusReportFixture({}, { updateRequested: true }) },
    ]).cleanup,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The bar module's metrics as they sit in the full layout's bar card (a row) or One screen's (a stack). */
function BarModule({ set, layout = "grid", children }: { set: ResponsibilityMetricSet; layout?: "grid" | "stack"; children?: ReactNode }) {
  return (
    <Card elevation="low" className={layout === "stack" ? "max-w-sm gap-5 px-5 py-5" : "max-w-5xl gap-5 px-5 py-5"}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">The bar</h2>
      {children}
      <ResponsibilityMetricSetView set={set} now={RESPONSIBILITY_FIXTURE_NOW} primary={primary} agentsById={agentsById} layout={layout} canRemove />
    </Card>
  );
}

/** Three metrics the agent chose: the bar's own as a line toward 20, intro meetings as bars per week, replies as a share. */
export const ThreeMetrics: Story = {
  name: "Bar module, three metrics",
  render: () => <BarModule set={METRIC_SET_FIXTURES.chosen} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Chosen with CodexCoder")).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll("[data-metric-key]")).toHaveLength(3);
  },
};

/** Two metrics: the bar's own and reply time drifting above its at-most line. */
export const TwoMetrics: Story = {
  name: "Bar module, two metrics",
  render: () => <BarModule set={METRIC_SET_FIXTURES.two} />,
};

/** Only the bar's own metric, as a number with its meter toward the target. */
export const OneMetric: Story = {
  name: "Bar module, one metric",
  render: () => <BarModule set={METRIC_SET_FIXTURES.one} />,
};

/** Every form side by side: a large number with its target, a percentage ring with its target tick, bars per week. */
export const EachForm: Story = {
  name: "Bar module, each display form",
  render: () => (
    <div className="flex flex-col gap-6">
      <BarModule set={METRIC_SET_FIXTURES.forms} />
      <BarModule set={METRIC_SET_FIXTURES.two} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const forms = [...canvasElement.querySelectorAll<HTMLElement>("[data-metric-display]")].map((node) => node.dataset.metricDisplay);
    await expect(new Set(forms)).toEqual(new Set(["number", "percent", "bar", "line"]));
  },
};

/** One screen's narrow column stacks them. */
export const Stacked: Story = {
  name: "Bar module, stacked (One screen)",
  render: () => <BarModule set={METRIC_SET_FIXTURES.chosen} layout="stack" />,
};

/** Nobody chose metrics yet: starters from the work, labelled as such. */
export const Starters: Story = {
  name: "Bar module, starters only",
  render: () => <BarModule set={METRIC_SET_FIXTURES.starter} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Starter metrics from your work so far")).toBeInTheDocument();
  },
};

/** A supporting metric last read 20 days ago carries the stale flag. */
export const StaleReading: Story = {
  name: "Bar module, a stale reading",
  render: () => <BarModule set={METRIC_SET_FIXTURES.stale} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not updated in 20 days")).toBeInTheDocument();
  },
};

/** No readings yet, and a line with a single reading. */
export const NoReadings: Story = {
  name: "Bar module, no readings and one reading",
  render: () => (
    <div className="flex flex-col gap-6">
      <BarModule set={METRIC_SET_FIXTURES.empty} />
      <BarModule set={METRIC_SET_FIXTURES.sparse} />
    </div>
  ),
};

/** The agent's written status leads; the status from the number sits beneath as the fact it is. */
export const WithAgentStatus: Story = {
  name: "Bar module, agent-written status",
  render: () => (
    <BarModule set={METRIC_SET_FIXTURES.chosen} layout="stack">
      <ResponsibilityStatusBlock
        responsibility={{
          id: "resp-fundraising",
          ownerUserId: "user-storybook",
          status: "active",
          rollup: { health: "behind", healthOverridden: false, statusSentence: "9 of 20 investors contacted, 45% of target" },
        }}
        agentsById={agentsById}
        now={RESPONSIBILITY_FIXTURE_NOW}
        editable
      />
    </BarModule>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Written by CodexCoder · 2 days ago");
    await expect(canvas.getByText("From the number")).toBeInTheDocument();
  },
};

/** The agent's proposal carries the metric set, drawn as it will appear. */
export const ProposalWithMetrics: Story = {
  name: "Proposed bar with a metric set",
  render: () => (
    <div className="max-w-xl">
      <BarProposalCard interaction={barProposalWithMetricsFixture()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 metrics on the page");
    await expect(canvas.getByRole("heading", { name: "Intro calls booked per week" })).toBeInTheDocument();
  },
};
