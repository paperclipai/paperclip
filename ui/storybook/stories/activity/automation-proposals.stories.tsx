import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AutomationProposalCard } from "@/components/responsibilities/AutomationProposalCard";
import { storybookAgents } from "../../fixtures/paperclipData";
import {
  acceptedAutomationProposalFixture,
  acceptedAutomationResponseFixture,
  AUTOMATION_FIXTURE_AGENT_ID,
  automationProposalFixture,
} from "../../fixtures/automation-proposals";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

const agent = { ...(storybookAgents[0]!), id: AUTOMATION_FIXTURE_AGENT_ID, name: "CodexCoder" };

function Gallery() {
  return null;
}

const meta = {
  id: "feature-automation-proposals",
  title: "Oversight and operation/Dashboards and audit trails/Automation proposals",
  component: Gallery,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Shipped automation proposal card behind the experimental enableResponsibilities flag: the card an agent's proposed automation appears as in its automation conversation, for each way it can start (on a schedule, from a webhook, as a standing check on each wake-up), and after it is set up (a webhook shows its address and, right after accepting, its secret once). Proposals, the agent and the secret are synthetic fixtures; accepting and declining are simulated, so these stories do not prove the server's guardrails, permissions, atomic accept or the routines module's webhook path.",
    },
  },
  beforeEach: () =>
    prepareFixtureApi([
      { path: `/api/agents/${AUTOMATION_FIXTURE_AGENT_ID}`, method: "GET", read: () => agent },
      {
        path: /^\/api\/issues\/[^/]+\/automation-proposals\/automation-proposal-webhook\/accept$/,
        method: "POST",
        read: () => acceptedAutomationResponseFixture("webhook"),
      },
      {
        path: /^\/api\/issues\/[^/]+\/automation-proposals\/[^/]+\/accept$/,
        method: "POST",
        read: () => acceptedAutomationResponseFixture("schedule"),
      },
      {
        path: /^\/api\/issues\/[^/]+\/automation-proposals\/[^/]+\/decline$/,
        method: "POST",
        read: () => automationProposalFixture("schedule", { status: "rejected", result: { version: 1, outcome: "declined" } }),
      },
      { path: /^\/api\/issues\/[^/]+\/comments$/, method: "POST", read: () => ({ id: "comment-not-right", body: "x" }) },
    ]).cleanup,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-xl flex-col gap-4">{children}</div>;
}

/** On a schedule: the cadence in words, who runs it and the two responsibilities it will be filed under. */
export const ProposalSchedule: Story = {
  name: "Proposed automation, on a schedule",
  render: () => <Column><AutomationProposalCard interaction={automationProposalFixture("schedule")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Send the monthly investor update");
    await expect(canvas.getByText("On a schedule: On the 1st of every month at 9 AM")).toBeTruthy();
  },
};

/** From a webhook: what the agent says should call it, and that the address and secret come after setting it up. */
export const ProposalWebhook: Story = {
  name: "Proposed automation, from a webhook",
  render: () => <Column><AutomationProposalCard interaction={automationProposalFixture("webhook")} /></Column>,
};

/** A standing check: what the agent will look for on each wake-up and what it does when it finds it; filed under no responsibility. */
export const ProposalStandingCheck: Story = {
  name: "Proposed automation, a standing check",
  render: () => <Column><AutomationProposalCard interaction={automationProposalFixture("standing_check")} /></Column>,
};

/** Setting up a webhook: right after accepting, the card shows the address to call and the secret, once. */
export const WebhookSetUp: Story = {
  name: "Proposed automation, setting up a webhook",
  render: () => <Column><AutomationProposalCard interaction={automationProposalFixture("webhook")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Set it up" }));
    await expect(await canvas.findByLabelText("Secret")).toBeTruthy();
  },
};

/** "Not right" asks what should change, then the conversation carries on. */
export const ProposalNotRight: Story = {
  name: "Proposed automation, saying it is not right",
  render: () => <Column><AutomationProposalCard interaction={automationProposalFixture("schedule")} /></Column>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Not right" }));
    await expect(canvas.getByLabelText("What should change? (optional)")).toBeTruthy();
  },
};

/** After it is set up (a webhook keeps its address and how it is secured, never the secret), and after "not right" or being replaced. */
export const ProposalSettled: Story = {
  name: "Proposed automation, settled",
  render: () => (
    <Column>
      <AutomationProposalCard interaction={acceptedAutomationProposalFixture("schedule")} />
      <AutomationProposalCard interaction={acceptedAutomationProposalFixture("webhook")} />
      <AutomationProposalCard interaction={acceptedAutomationProposalFixture("standing_check")} />
      <AutomationProposalCard interaction={automationProposalFixture("schedule", { status: "rejected", result: { version: 1, outcome: "declined" } })} />
      <AutomationProposalCard interaction={automationProposalFixture("webhook", {
        status: "expired", result: { version: 1, outcome: "replaced", replacedByInteractionId: "automation-proposal-schedule" },
      })} />
    </Column>
  ),
};
