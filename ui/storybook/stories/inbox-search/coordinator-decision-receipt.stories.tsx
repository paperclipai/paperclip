import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorDecisionReceipt } from "@/components/coordinator/CoordinatorDecisionReceipt";

const receipt: DecisionHistoryItem = {
  id: "issue_thread_interaction:review", sourceKind: "issue_thread_interaction", sourceId: "review",
  issueId: "task", issueIdentifier: "PAPER-102", issueTitle: "Write the launch post",
  agentId: "writer", agentName: "Mira", projectId: "launch", projectName: "Connector launch",
  title: "Review the launch copy", outcome: "accepted", label: "Copy approved · v3",
  resolvedAt: "2026-10-26T12:00:00Z", resolvedByUserId: "reviewer", resolvedByAgentId: null,
  href: "/PAPER/issues/PAPER-102#document-copy&revision=reviewed-revision&interaction=review",
  target: { kind: "issue_document", key: "copy", revisionId: "reviewed-revision" },
};
const meta = {
  id: "feature-coordinator-decision-receipt",
  title: "Tasks and conversations/Inbox, decisions, and search/Coordinator decision receipt",
  component: CoordinatorDecisionReceipt,
  args: { item: receipt, onOpen: fn() },
  parameters: { layout: "padded", paperclip: {
    capabilities: ["inbox-search/decisions"], status: "current", implementation: "production", boundary: "fixtures",
    notes: "Compact recorded-decision component. Fixture click verifies exact revision/interaction navigation intent; actual authorization, persistence and task scrolling require runtime verification.",
  } },
} satisfies Meta<typeof CoordinatorDecisionReceipt>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Approved: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /Copy approved/ }));
    expect(args.onOpen).toHaveBeenCalledWith(receipt.href);
  },
};
export const AnswerRecorded: Story = { args: { item: { ...receipt, label: "Answers recorded", outcome: "answered", target: null, href: "/PAPER/issues/PAPER-102#interaction-question" } } };
export const LongTaskTitle: Story = { args: { item: { ...receipt, issueTitle: "Explain scoped connector access to nontechnical teammates across the blog, LinkedIn and launch materials" } } };
