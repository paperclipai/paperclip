import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import type { AskUserQuestionsInteraction, IssueComment } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { TaskChatThread } from "@/components/TaskChatThread";
import { pendingAskUserQuestionsInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const question: AskUserQuestionsInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "unanswered-color", title: "Welcome note preference", sourceRunId: "original-run",
  createdAt: new Date("2026-04-01T12:01:00Z"),
  payload: { version: 1, runtimeRequestId: "color-request", questions: [{ id: "color", prompt: "Which color should the welcome note use?",
    selectionMode: "single", required: true, options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }] }] },
};
const otherQuestion: AskUserQuestionsInteraction = {
  ...question, id: "unanswered-tone", sourceRunId: "second-run", title: "Welcome note tone",
  createdAt: new Date("2026-04-01T12:03:00Z"),
  payload: { version: 1, questions: [{ id: "tone", prompt: "Which tone should the welcome note use?",
    selectionMode: "single", required: true, options: [{ id: "friendly", label: "Friendly" }, { id: "formal", label: "Formal" }] }] },
};
function comment(id: string, body: string, at: string, agent = false): IssueComment {
  return { id, companyId: question.companyId, issueId: question.issueId, body, authorType: agent ? "agent" : "user",
    authorAgentId: agent ? question.createdByAgentId ?? null : null, authorUserId: agent ? null : "user-board",
    presentation: null, metadata: null, createdAt: new Date(at), updatedAt: new Date(at) };
}
function QuestionChat({ movedOn = false, multiple = false, answered = false }: { movedOn?: boolean; multiple?: boolean; answered?: boolean }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    // This conversation has no plan. Keep the real thread's plan query local
    // to the fixture rather than requesting an API from the static publisher.
    client.setQueryData([...queryKeys.issues.documents(question.issueId), "plan"], null);
    return client;
  });
  const [interactions, setInteractions] = useState<AskUserQuestionsInteraction[]>([
    answered ? { ...question, status: "answered", resolvedAt: new Date("2026-04-01T12:06:00Z"), result: { version: 1, answers: [{ questionId: "color", optionIds: ["blue"] }] } } : question,
    ...(multiple ? [otherQuestion] : []),
  ]);
  const [comments, setComments] = useState<IssueComment[]>([
    comment("start", "Help me plan a welcome note for our garden club.", "2026-04-01T12:00:00Z"),
    ...(movedOn || multiple || answered ? [
      comment("move-on", "Let's leave those choices for later. What can Paperclip tasks track?", "2026-04-01T12:04:00Z"),
      comment("reply", "Tasks track ownership, progress, and the work needed to reach a goal.", "2026-04-01T12:05:00Z", true),
    ] : []),
    ...(answered ? [comment("late-answer", "Blue it is. I'll use that preference when we return to the welcome note.", "2026-04-01T12:07:00Z", true)] : []),
  ]);
  return <QueryClientProvider client={queryClient}><div className="flex h-screen flex-col bg-background text-foreground">
    <TaskChatThread conversationMode comments={comments} interactions={interactions} issueId={question.issueId}
      issueStatus="in_review" currentUserId="user-board" agentMap={storybookAgentMap} enableLiveTranscriptPolling={false}
      threadHeader={<div className="p-4"><h1 className="text-xl font-semibold">Garden club chat</h1><p className="text-sm text-muted-foreground">Questions can wait. Open an unanswered question in history whenever you're ready.</p></div>}
      onAdd={async body => {
        setComments(rows => [...rows, comment(`user-${rows.length}`, body, new Date().toISOString()),
          comment(`agent-${rows.length}`, "We can come back to that question later. What would you like to work on next?", new Date(Date.now() + 1).toISOString(), true)]);
      }}
      onSubmitInteractionAnswers={async (interaction, answers) => {
        setInteractions(rows => rows.map(row => row.id === interaction.id ? { ...row, status: "answered", resolvedAt: new Date(), result: { version: 1, answers } } : row));
        setComments(rows => [...rows, comment(`answer-${rows.length}`, "Thanks, I've received your answer to the earlier question.", new Date().toISOString(), true)]);
      }}
    />
  </div></QueryClientProvider>;
}
const meta = { title: "Chat & Comments/Agent Chat Unanswered Questions", parameters: { layout: "fullscreen" }, component: QuestionChat,
  beforeEach: () => {
    for (const key of Object.keys(localStorage)) {
      if (key.includes(`paperclip:task-input:${question.issueId}:`)) localStorage.removeItem(key);
    }
  },
} satisfies Meta<typeof QuestionChat>;
export default meta;
type Story = StoryObj<typeof meta>;
export const JustAsked: Story = { args: {} };
export const DismissFreshQuestion: Story = { args: {}, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole("radio", { name: "Green" })).toBeVisible());
  await userEvent.click(canvas.getByRole("radio", { name: "Green" }));
  await userEvent.click(canvas.getByRole("button", { name: /^Cancel$/ }));
  await expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible();
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const MovedOn: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const Reopened: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByRole("button", { name: "Answer question: Which color should the welcome note use?" }));
  await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toBeVisible());
  await expect(canvas.getByRole("radio", { name: "Blue" })).toBeVisible();
} };
export const AnswerLater: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByTestId("task-chat-unanswered-question"));
  await userEvent.click(canvas.getByRole("radio", { name: "Blue" }));
  await userEvent.click(canvas.getByRole("button", { name: /^(Send|Submit) answers$/ }));
  await expect(canvas.queryByTestId("task-chat-unanswered-question")).not.toBeInTheDocument();
  await waitFor(() => expect(canvas.getByTestId("task-chat-answered-questions-receipt")).toBeVisible());
} };
export const MultipleUnanswered: Story = { args: { multiple: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getAllByTestId("task-chat-unanswered-question")).toHaveLength(2));
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const AnsweredHistory: Story = { args: { answered: true } };
export const Mobile: Story = { args: { movedOn: true }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const MoveOnWithoutAnswering: Story = { args: {}, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByRole("radio", { name: "Green" }));
  await userEvent.type(canvas.getByRole("textbox", { name: "editable markdown" }), "Leave that for later. Tell me about tasks.");
  await userEvent.click(canvas.getByRole("button", { name: /^Send$/ }));
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByTestId("task-chat-unanswered-question"));
  await expect(canvas.getByRole("radio", { name: "Green" })).toBeChecked();
} };
