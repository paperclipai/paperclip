import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CoordinatorPresentation } from "@/components/coordinator/CoordinatorPresentation";
import { TaskChatCompactInteractionCard } from "@/components/task-chat/TaskChatCompactInteractionCard";
import { TaskChatPlanPreviewCard } from "@/components/task-chat/TaskChatPlanPreviewCard";
import { pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import type { SuggestTasksInteraction } from "@/lib/issue-thread-interactions";
import { CoordinatorChatDecisionReceipt } from "@/components/coordinator/CoordinatorChatDecisionReceipts";
import { Button } from "@/components/ui/button";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { storybookIssueDocuments } from "../../fixtures/paperclipData";

function suggestion(): SuggestTasksInteraction {
  return { ...pendingSuggestedTasksInteraction, id: `story-suggestion-${Date.now()}`, status: "pending", result: null,
    createdAt: new Date(), resolvedAt: null, payload: { ...pendingSuggestedTasksInteraction.payload,
      tasks: [{ clientKey: "launch", title: "Write the launch post", description: "Explain scoped connector access for teammates setting up their first agents.", priority: "medium" }] } };
}

function TaskCommitment() {
  const [interaction, setInteraction] = useState(suggestion);
  return <CoordinatorPresentation.Provider value><div className="coordinator-workspace min-h-dvh bg-background p-6 text-foreground"><div className="mx-auto max-w-2xl space-y-6">
    <header><h1 className="text-lg font-medium">Task commitment</h1><p className="mt-2 text-sm text-muted-foreground">Story fixtures demonstrate a suggestion becoming a confirmed task. No task is created.</p></header>
    <Button variant="outline" size="sm" onClick={() => setInteraction(suggestion())}>Replay suggestion</Button>
    <TaskChatPlanPreviewCard source={{ kind: "saved", document: { ...storybookIssueDocuments[0]!, body: "# Launch post\n\nWrite a clear introduction to scoped connector access." } }} />
    <TaskChatCompactInteractionCard key={interaction.id} interaction={interaction}
      onAcceptInteraction={async () => setInteraction(current => ({ ...current, status: "accepted", resolvedAt: new Date(), result: { version: 1, createdTasks: [{ clientKey: "launch", issueId: "storybook-task", identifier: "PAPER-108", title: "Write the launch post" }] } }))}
      onRejectInteraction={async (_item, reason) => setInteraction(current => ({ ...current, status: "rejected", resolvedAt: new Date(), result: { version: 1, reason } }))} />
    <CoordinatorChatDecisionReceipt receipt={{ id: "story-receipt", sourceKind: "issue_thread_interaction", sourceId: "story-interaction", issueId: "storybook-task", issueIdentifier: "PAPER-108", issueTitle: "Write the launch post", agentId: "mira", agentName: "Mira", projectId: null, projectName: null, title: "Blog draft", outcome: "accepted", label: "Approved · v3", resolvedAt: new Date(Date.now() - 60_000).toISOString(), resolvedByUserId: "story-reviewer", resolvedByAgentId: null, href: "/issues/PAPER-108#document-plan&revision=story-revision&interaction=story-interaction", target: { kind: "issue_document", key: "plan", revisionId: "story-revision" } }} />
  </div></div></CoordinatorPresentation.Provider>;
}
const meta = { id: "coordinator-task-commitment", title: "Tasks and conversations/Agent conversations and project handoff/Coordinator task commitment", component: TaskCommitment,
  parameters: { layout: "fullscreen", paperclip: { capabilities: ["agent-chat/handoff", "agent-chat/history"], status: "proposed", implementation: "production", boundary: "fixtures", notes: "Production Suggested Task card with Reject, Revise and Create, contained task motion, compact saved-plan link, created-task link and exact-revision receipt. Story-only canonical-shaped data and resolution callbacks; no agent execution, real task creation, delivery, task-detail destination or approval. Motion respects prefers-reduced-motion." } },
  beforeEach: () => prepareFixtureApi([
    { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-board", coordinatorWorkspaceEnabled: true, updatedAt: new Date().toISOString() }) },
    { path: /\/api\/companies\/[^/]+\/issues\/summaries$/, read: () => [{ id: "storybook-task", identifier: "PAPER-108", title: "Write the launch post", status: "todo" }] },
  ]).cleanup,
} satisfies Meta<typeof TaskCommitment>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Phone: Story = { globals: { viewport: { value: "mobile1" } } };
