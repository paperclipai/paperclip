import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CompanyScorecard as CompanyScorecardData } from "@paperclipai/shared";
import { CompanyScorecard } from "@/components/CompanyScorecard";

const baseScorecard: CompanyScorecardData = {
  companyId: "company-storybook",
  pulse: "green",
  counters: {
    issues: { todo: 8, inProgress: 5, inReview: 2, blocked: 0, done7d: 14 },
    agents: { active: 4, idle: 2, paused: 0 },
    runs24h: { succeeded: 32, failed: 0, other: 2 },
  },
  attention: [],
  activity: [
    {
      kind: "run_finished",
      label: "heartbeat.cancelled",
      issueId: null,
      issueIdentifier: null,
      agentId: "agent-1",
      agentName: "Codex",
      occurredAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    },
    {
      kind: "comment",
      label: "issue.comment_added",
      issueId: "i-1",
      issueIdentifier: "PAP-128",
      agentId: "agent-2",
      agentName: "Claude",
      occurredAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    },
    {
      kind: "status_change",
      label: "issue.updated",
      issueId: "i-2",
      issueIdentifier: "PAP-127",
      agentId: "agent-1",
      agentName: "Codex",
      occurredAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    },
  ],
  computedAt: new Date().toISOString(),
};

const meta: Meta<typeof CompanyScorecard> = {
  title: "Control Plane Surfaces/Company Scorecard",
  component: CompanyScorecard,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof CompanyScorecard>;

export const Healthy: Story = {
  args: { scorecard: baseScorecard },
};

export const NeedsAttention: Story = {
  args: {
    scorecard: {
      ...baseScorecard,
      pulse: "amber",
      counters: {
        ...baseScorecard.counters,
        issues: { todo: 8, inProgress: 5, inReview: 4, blocked: 0, done7d: 6 },
      },
      attention: [
        {
          issueId: "i-1",
          identifier: "PAP-201",
          title: "Review pending for 3 days",
          status: "in_review",
          priority: "medium",
          assigneeAgentId: "agent-1",
          updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          reason: "in_review_waiting",
        },
        {
          issueId: "i-2",
          identifier: "PAP-202",
          title: "Workspace cleanup still in_progress",
          status: "in_progress",
          priority: "low",
          assigneeAgentId: null,
          updatedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
          reason: "stalled",
        },
        {
          issueId: "i-3",
          identifier: "PAP-203",
          title: "Routine never completed",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: null,
          updatedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString(),
          reason: "stalled",
        },
      ],
    },
  },
};

export const ActionRequired: Story = {
  args: {
    scorecard: {
      ...baseScorecard,
      pulse: "red",
      counters: {
        issues: { todo: 4, inProgress: 3, inReview: 1, blocked: 2, done7d: 5 },
        agents: { active: 3, idle: 1, paused: 1 },
        runs24h: { succeeded: 18, failed: 3, other: 1 },
      },
      attention: [
        {
          issueId: "i-1",
          identifier: "PAP-301",
          title: "Migration failing on prod replica",
          status: "blocked",
          priority: "high",
          assigneeAgentId: "agent-1",
          updatedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
          reason: "blocked",
        },
        {
          issueId: "i-2",
          identifier: "PAP-302",
          title: "Awaiting human approval",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: null,
          updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          reason: "blocked",
        },
      ],
    },
  },
};

export const Quiet: Story = {
  args: {
    scorecard: {
      ...baseScorecard,
      pulse: "grey",
      counters: {
        issues: { todo: 0, inProgress: 0, inReview: 0, blocked: 0, done7d: 0 },
        agents: { active: 0, idle: 2, paused: 0 },
        runs24h: { succeeded: 0, failed: 0, other: 0 },
      },
      attention: [],
      activity: [],
    },
  },
};
