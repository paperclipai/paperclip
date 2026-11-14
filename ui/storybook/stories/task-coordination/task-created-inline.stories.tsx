import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueComment, IssueDocumentSummary } from "@paperclipai/shared";
import { TaskChatThread } from "@/components/TaskChatThread";
import { storybookAgents, storybookIssues } from "../../fixtures/paperclipData";
import { queryKeys } from "@/lib/queryKeys";

const parent = storybookIssues[0]!;
const at = (minute: number) => new Date(`2026-10-30T09:${String(minute).padStart(2, "0")}:00Z`);
const task: Issue = {
  ...parent, id: "inline-subtask", parentId: parent.id, identifier: "PAP-42",
  title: "Fix incomplete search results when the task list has multiple pages",
  status: "in_progress", createdByAgentId: "agent-1", createdAt: at(2),
};
const comments: IssueComment[] = [
  { id: "request", authorType: "user", authorUserId: "viewer", body: "Review the new findings and create a task for each repair that needs work.", createdAt: at(0) },
  { id: "progress", authorType: "agent", authorAgentId: "agent-1", body: "I found one actionable issue. I’ll create a subtask for the repair and save the batch report here.", createdAt: at(1) },
  { id: "response", authorType: "agent", authorAgentId: "agent-1", body: "Created one repair task. The batch report has the source evidence and selection details.", createdAt: at(4) },
].map((comment) => ({
  ...comment, authorType: comment.authorType as "user" | "agent",
  authorAgentId: comment.authorAgentId ?? null, authorUserId: comment.authorUserId ?? null,
  presentation: null, metadata: null, companyId: parent.companyId, issueId: parent.id, updatedAt: comment.createdAt,
}));
const report = {
  id: "report", issueId: parent.id, companyId: parent.companyId, key: "batch-report", title: "Batch report",
  format: "markdown", latestRevisionNumber: 1, latestRevisionId: "report-1", createdAt: at(3), updatedAt: at(3),
} as IssueDocumentSummary;

function TaskFeed({ multiple = false }: { multiple?: boolean }) {
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    cache.setQueryData([...queryKeys.issues.documents(parent.id), "plan"], null);
    return cache;
  });
  return <QueryClientProvider client={client}>
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col overflow-hidden bg-background px-4 text-foreground">
      <TaskChatThread
        issueId={parent.id} companyId={parent.companyId} issueStatus="done" conversationMode={false}
        comments={comments} documents={[report]}
        createdTasks={multiple ? [task, { ...task, id: "second-subtask", identifier: "PAP-43", title: "Verify the repair against the source evidence", status: "blocked", createdAt: at(2) }] : [task]}
        agentMap={new Map([["agent-1", { ...storybookAgents[0]!, id: "agent-1", name: "Researcher" }]])}
        currentUserId="viewer" enableLiveTranscriptPolling={false} onAdd={async () => {}} showComposer={false}
        threadHeader={<header className="border-b border-border p-4"><p className="text-xs text-muted-foreground">Task feed</p><h1 className="text-lg font-semibold">Daily findings and repair tasks</h1></header>}
      />
    </div>
  </QueryClientProvider>;
}

const meta = {
  id: "task-created-inline",
  title: "Tasks and conversations/Delegation, dependencies, and signoff/Created task cards",
  component: TaskFeed,
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/issues/parent"],
    paperclip: {
      capabilities: ["task-coordination/delegation", "tasks/discussion"],
      implementation: "production", boundary: "fixtures",
      notes: "Production TaskChatThread assembles created task cards beside a saved document. Task reads and status are fixtures; no agent runs or task writes occur.",
    },
  },
  globals: { theme: "light" },
} satisfies Meta<typeof TaskFeed>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InlineSubtask: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByTestId("task-chat-created-task");
    await expect(card).toHaveTextContent("Subtask created");
    await expect(card).toHaveTextContent("In progress");
    await expect(card).toHaveAttribute("href", "/PAP/issues/PAP-42");
    await expect(canvas.getAllByTestId("task-chat-created-task")).toHaveLength(1);
  },
};
export const MultipleSubtasks: Story = { args: { multiple: true } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Mobile: Story = { args: { multiple: true }, globals: { viewport: { value: "mobile", isRotated: false } } };
