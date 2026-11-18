import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ResponsibilityHealth, ResponsibilityMetricKind } from "@paperclipai/shared";
import { BarProposalCard } from "@/components/responsibilities/BarProposalCard";
import { MetricGlance } from "@/components/responsibilities/MetricGlance";
import { ResponsibilityBarFields } from "@/components/responsibilities/ResponsibilityBarFields";
import { barDraftFrom, type BarDraft } from "@/lib/responsibilities";
import { storybookAgents } from "../../fixtures/paperclipData";
import { RESPONSIBILITY_FIXTURE_NOW } from "../../fixtures/responsibilities";
import {
  BAR_FIXTURE_AGENT_ID,
  barProposalFixture,
  METRIC_OF_EACH_TEMPLATE,
} from "../../fixtures/responsibility-bars";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

const KINDS: ResponsibilityMetricKind[] = ["volume", "percentage", "yes_no", "range"];
const HEALTH: Record<ResponsibilityMetricKind, ResponsibilityHealth> = {
  volume: "behind",
  percentage: "at_risk",
  yes_no: "on_track",
  range: "at_risk",
};
const agent = { ...(storybookAgents[0]!), id: BAR_FIXTURE_AGENT_ID, name: "Chief of staff" };

function Gallery() {
  return null;
}

const meta = {
  id: "feature-responsibility-bars",
  title: "Oversight and operation/Dashboards and audit trails/Responsibility bars",
  component: Gallery,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Shipped bar pieces behind the experimental enableResponsibilities flag: the card an agent's proposed bar appears as (in its bar conversation and on the responsibility's page), a metric of each bar template (volume, percentage, yes or no, range) as every responsibility view draws it, and the hand-edit fields per template. Proposals, readings and the agent are synthetic fixtures; accepting and declining are simulated, so these stories do not prove the server's status derivation, writer rule or atomic apply.",
    },
  },
  beforeEach: () =>
    prepareFixtureApi([
      { path: `/api/agents/${BAR_FIXTURE_AGENT_ID}`, method: "GET", read: () => agent },
      {
        path: /^\/api\/issues\/[^/]+\/bar-proposals\/[^/]+\/accept$/,
        method: "POST",
        read: ({ url }) => ({
          interaction: barProposalFixture("percentage", {
            id: url.pathname.split("/")[5]!,
            status: "accepted",
            result: { version: 1, outcome: "accepted", responsibilityId: "resp-fundraising" },
          }),
          responsibility: null,
        }),
      },
      {
        path: /^\/api\/issues\/[^/]+\/bar-proposals\/[^/]+\/decline$/,
        method: "POST",
        read: ({ url }) => barProposalFixture("percentage", {
          id: url.pathname.split("/")[5]!,
          status: "rejected",
          result: { version: 1, outcome: "declined" },
        }),
      },
      { path: /^\/api\/issues\/[^/]+\/comments$/, method: "POST", read: () => ({ id: "comment-not-right", body: "x" }) },
    ]).cleanup,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-xl flex-col gap-4">{children}</div>;
}

/** A volume bar with a reading the agent counted: at most 0 escalations waiting a day, 3 today. */
export const ProposalVolume: Story = {
  name: "Proposed bar, volume",
  render: () => <Column><BarProposalCard interaction={barProposalFixture("volume")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No escalated ticket waits a full day for a first reply.");
    await expect(canvas.getByText("On track at 0 or less; behind above that")).toBeTruthy();
  },
};

/** A share, with the line on how status will be read: "On track at 90% or more; at risk from 68%". */
export const ProposalPercentage: Story = {
  name: "Proposed bar, percentage",
  render: () => <Column><BarProposalCard interaction={barProposalFixture("percentage")} /></Column>,
};

/** A yes or no with no reading yet: no target, unit or status preview. */
export const ProposalYesNo: Story = {
  name: "Proposed bar, yes or no",
  render: () => <Column><BarProposalCard interaction={barProposalFixture("yes_no")} /></Column>,
};

/** A range with a reading below it. */
export const ProposalRange: Story = {
  name: "Proposed bar, range",
  render: () => <Column><BarProposalCard interaction={barProposalFixture("range")} /></Column>,
};

/** On the responsibility's page the card also links to the conversation it came from. */
export const ProposalOnResponsibilityPage: Story = {
  name: "Proposed bar, on the responsibility page",
  render: () => (
    <Column>
      <BarProposalCard interaction={barProposalFixture("percentage")} showConversationLink showResponsibilityLink={false} />
    </Column>
  ),
};

/** "Not right" asks what should change, then the conversation carries on. */
export const ProposalNotRight: Story = {
  name: "Proposed bar, saying it is not right",
  render: () => <Column><BarProposalCard interaction={barProposalFixture("percentage")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Not right" }));
    await expect(canvas.getByLabelText("What should change? (optional)")).toBeTruthy();
  },
};

/** After accepting, and after saying it is not right or being replaced: one quiet line each. */
export const ProposalSettled: Story = {
  name: "Proposed bar, settled",
  render: () => (
    <Column>
      <BarProposalCard interaction={barProposalFixture("percentage", {
        status: "accepted", result: { version: 1, outcome: "accepted", responsibilityId: "resp-fundraising" },
      })} />
      <BarProposalCard interaction={barProposalFixture("volume", { status: "rejected", result: { version: 1, outcome: "declined" } })} />
      <BarProposalCard interaction={barProposalFixture("range", {
        status: "expired", result: { version: 1, outcome: "replaced", replacedByInteractionId: "bar-proposal-percentage" },
      })} />
    </Column>
  ),
};

/** A bar of each template, in the row size the views use and the large size at the top of a page. */
export const BarsOfEachTemplate: Story = {
  name: "A bar of each template",
  render: () => (
    <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
      {KINDS.map((kind) => (
        <div key={kind} className="flex flex-col gap-4" data-template={kind}>
          <MetricGlance metric={METRIC_OF_EACH_TEMPLATE[kind]} health={HEALTH[kind]} now={RESPONSIBILITY_FIXTURE_NOW} />
          <MetricGlance metric={METRIC_OF_EACH_TEMPLATE[kind]} health={HEALTH[kind]} now={RESPONSIBILITY_FIXTURE_NOW} size="hero" />
          <p className="text-xs text-muted-foreground">{METRIC_OF_EACH_TEMPLATE[kind].statusRule}</p>
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect((await canvas.findAllByText("range 12–24 months")).length).toBeGreaterThan(0);
    await expect(canvas.getAllByText("Yes").length).toBeGreaterThan(0);
  },
};

function FieldsFor({ kind }: { kind: ResponsibilityMetricKind }) {
  const [draft, setDraft] = useState<BarDraft>(() => ({
    ...barDraftFrom(),
    metricKind: kind,
    standard: "We always have between 12 and 24 months of runway.",
    metricName: kind === "yes_no" ? "Board pack sent a week before the meeting" : "Runway",
    metricTarget: kind === "percentage" ? "90" : "12",
    metricUnit: kind === "range" ? "months" : "",
    metricLow: "12",
    metricHigh: "24",
  }));
  return <ResponsibilityBarFields draft={draft} onChange={setDraft} showCurrent />;
}

/** The hand-edit fields follow the kind of measure chosen. */
export const HandEditFields: Story = {
  name: "Editing the bar by hand, each template",
  render: () => (
    <div className="grid max-w-5xl gap-8 lg:grid-cols-2">
      {KINDS.map((kind) => <FieldsFor key={kind} kind={kind} />)}
    </div>
  ),
};
