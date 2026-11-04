import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "@/components/coordinator/CoordinatorNeedsYou";
import { coordinatorTaskQuestion, coordinatorTaskQuestionAttention } from "@/fixtures/coordinatorTaskQuestion";
import { genericPendingRequestConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

function DecisionMotion() {
  return <div className="coordinator-workspace min-h-dvh bg-background p-6 text-foreground"><CoordinatorNeedsYou /></div>;
}

function fixtures(fail = false) {
  const suffix = Date.now();
  let question: IssueThreadInteraction = { ...coordinatorTaskQuestion, id: `motion-question-${suffix}` };
  let approval: IssueThreadInteraction = { ...genericPendingRequestConfirmationInteraction,
    id: `motion-approval-${suffix}`, issueId: "task-copy", title: "Approve the launch copy",
    payload: { version: 1, prompt: "The opening now explains what teammates can do with scoped access. Is this version ready?", acceptLabel: "Approve v3", rejectLabel: "Revise…" } };
  const receipts: DecisionHistoryItem[] = [];
  const attention = (interaction: IssueThreadInteraction) => ({ ...coordinatorTaskQuestionAttention,
    id: `issue_thread_interaction:${interaction.id}`, subject: { ...coordinatorTaskQuestionAttention.subject, id: interaction.id, title: interaction.title, metadata: { issueId: interaction.issueId } },
    relatedIssue: { ...coordinatorTaskQuestionAttention.relatedIssue!, id: interaction.issueId, identifier: interaction === approval ? "PAPER-103" : "PAPER-102" },
  });
  return prepareFixtureApi([
    { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-board", coordinatorWorkspaceEnabled: true, updatedAt: new Date().toISOString() }) },
    { path: /\/api\/companies\/[^/]+\/attention$/, read: () => ({ items: [approval, question].filter(item => item.status === "pending").map(attention) }) },
    { path: /\/api\/companies\/[^/]+\/attention\/history$/, read: () => ({ items: receipts, nextCursor: null }) },
    { path: /\/api\/issues\/(task-launch|task-copy)\/interactions$/, read: ({ url }) => [url.pathname.includes("task-copy") ? approval : question] },
    { path: /\/api\/issues\/(task-launch|task-copy)\/interactions\/[^/]+\/(accept|respond)$/, method: "POST", state: fail ? "mutation-failure" : "ready", read: ({ url, body }) => {
      const isApproval = url.pathname.endsWith("/accept");
      const before = isApproval ? approval : question;
      const resolved = { ...before, status: isApproval ? "accepted" : "answered", resolvedAt: new Date(), result: isApproval ? { version: 1 } : { version: 1, answers: body.answers } } as IssueThreadInteraction;
      if (isApproval) approval = resolved; else question = resolved;
      receipts.push({ id: `issue_thread_interaction:${resolved.id}`, sourceKind: "issue_thread_interaction", sourceId: resolved.id,
        issueId: resolved.issueId, issueIdentifier: isApproval ? "PAPER-103" : "PAPER-102", issueTitle: "Write the launch post",
        agentId: null, agentName: "Mira", projectId: null, projectName: null, title: resolved.title ?? "Decision",
        outcome: isApproval ? "accepted" : "answered", label: isApproval ? "Approved · v3" : "Answers recorded",
        resolvedAt: new Date().toISOString(), resolvedByUserId: "user-board", resolvedByAgentId: null,
        href: `/issues/${resolved.issueId}#interaction-${resolved.id}`, target: null });
      return resolved;
    } },
  ]).cleanup;
}

const meta = {
  id: "coordinator-decision-motion",
  title: "Design proposals/Components/Coordinator decision motion",
  component: DecisionMotion,
  parameters: { layout: "fullscreen", paperclip: {
    capabilities: ["inbox-search/decisions"], home: "design-proposals", status: "proposed", implementation: "production", boundary: "fixtures",
    exception: "Coordinator experimental motion is staged with Design proposals for review, using the implemented decision components.",
    notes: "Real Needs You and canonical resolver components with isolated API responses. Approve or answer to compare simultaneous card resize and contained Gather Light, then the move to Recent Decisions. Failed saves retain the form. Reload resets fixtures; no real decision or agent execution occurs.",
  } },
  beforeEach: () => fixtures(),
} satisfies Meta<typeof DecisionMotion>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Phone: Story = { globals: { viewport: { value: "mobile1" } } };
export const FailedSave: Story = { beforeEach: () => fixtures(true) };
