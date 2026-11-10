import type { Meta, StoryObj } from "@storybook/react-vite";
import { CoordinatorPresentation } from "@/components/coordinator/CoordinatorPresentation";
import { CoordinatorRelativeTime } from "@/components/coordinator/CoordinatorRelativeTime";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { CoordinatorChatPendingQuestion, useCoordinatorChatPendingQuestions } from "@/components/coordinator/CoordinatorChatPendingQuestions";
import { coordinatorTaskQuestion, coordinatorTaskQuestionAttention } from "@/fixtures/coordinatorTaskQuestion";
import { prepareFixtureApi } from "../../support/capability-gaps/api";
import { expect, userEvent, within, waitFor } from "storybook/test";

function Conversation() {
  return <CoordinatorPresentation.Provider value><div className="coordinator-workspace min-h-dvh bg-background p-6 text-foreground"><div className="mx-auto max-w-3xl space-y-8">
    <header className="flex items-center justify-between border-b border-border pb-4"><h1 className="text-lg font-medium">Chat</h1><span className="text-sm text-muted-foreground">Chief of Staff</span></header>
    <TaskChatBubble animateEntry={false} item={{ id: "review-sample-human", kind: "message", author: "human", authorName: "You", isCurrentUser: true, text: "Can we explain the new connector controls in a blog post?", createdAtIso: new Date(Date.now() - 4 * 60_000).toISOString() }} />
    <TaskChatBubble animateEntry={false} item={{ id: "review-sample-agent", kind: "message", author: "agent", authorName: "Chief of Staff", text: "Who should this help, and what should they understand after reading it?", createdAtIso: new Date(Date.now() - 3 * 60_000).toISOString() }} />
    <div className="rounded-xl border border-border bg-card p-4 text-sm"><p className="font-medium">Approved · Blog draft v3</p><p className="mt-1 text-muted-foreground">PAPER-102 · <CoordinatorRelativeTime value={new Date(Date.now() - 60_000)} /></p></div>
  </div></div></CoordinatorPresentation.Provider>;
}
const meta = { id: "coordinator-conversation", title: "Tasks and conversations/Agent conversations and project handoff/Coordinator conversation", component: Conversation,
  parameters: { layout: "fullscreen", paperclip: { capabilities: ["agent-chat/history"], status: "proposed", implementation: "production", boundary: "fixtures", notes: "Production task chat bubbles, shared relative timestamp primitive and approved Coordinator scoped tokens. The text is sample content solely for visual review; no agent/API execution or approval occurs." } },
} satisfies Meta<typeof Conversation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Phone: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };

function PendingTaskQuestion() {
  const query = useCoordinatorChatPendingQuestions("chat", true);
  return <div className="coordinator-workspace min-h-dvh bg-background p-6 text-foreground"><div className="mx-auto max-w-2xl space-y-6">
    <h1 className="text-lg font-medium">Chat with Mira</h1>
    {query.questions.map(item => <CoordinatorChatPendingQuestion key={item.id} item={item} />)}
    {query.isSuccess && !query.questions.length ? <p className="text-sm text-muted-foreground">Answer recorded on PAPER-102.</p> : null}
  </div></div>;
}
const questionFixtures = () => {
  let interaction = coordinatorTaskQuestion;
  return prepareFixtureApi([
    { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-board", coordinatorWorkspaceEnabled: true, updatedAt: new Date().toISOString() }) },
    { path: "/api/issues/chat/pending-questions", read: () => interaction.status === "pending" ? [coordinatorTaskQuestionAttention] : [] },
    { path: "/api/issues/task-launch/interactions", read: () => [interaction] },
    { path: `/api/issues/task-launch/interactions/${coordinatorTaskQuestion.id}/respond`, method: "POST", read: ({ body }) => {
      interaction = { ...interaction, status: "answered", resolvedAt: new Date(), result: { version: 1, answers: body.answers as NonNullable<typeof interaction.result>["answers"] } };
      return interaction;
    } },
  ]).cleanup;
};
export const TaskQuestion: Story = {
  render: () => <PendingTaskQuestion />, beforeEach: questionFixtures,
  parameters: { paperclip: { capabilities: ["agent-chat/history", "inbox-search/decisions"], status: "current", implementation: "production", boundary: "fixtures", notes: "Real pending-question hook and canonical resolver, with simulated API read/respond transitions. Does not prove model clarification choice, real delivery, access checks, or background task resumption." } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("radio", { name: /People setting up agents/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Confirm audience" }));
    await waitFor(() => expect(canvas.getByText("Answer recorded on PAPER-102.")).toBeVisible());
  },
};
export const TaskQuestionDark: Story = { ...TaskQuestion, play: undefined, globals: { theme: "dark" } };
export const TaskQuestionPhone: Story = { ...TaskQuestion, play: undefined, globals: { viewport: { value: "mobile1" } } };

const inlineDocumentLinkText = "Yes—we completed the onboarding interview here in chat. Your [plan is saved](#document-plan), approved, and handed off to execution task PIX-3.\n\nPIX-3 is now waiting for your bakery name, products/prices, contact details, and visual preferences.";
function InlineDocumentLinkConversation() {
  return <CoordinatorPresentation.Provider value><div className="coordinator-workspace min-h-dvh bg-background p-6 text-foreground"><div className="mx-auto max-w-3xl space-y-8">
    <TaskChatBubble animateEntry={false} item={{ id: "inline-document-link-agent", kind: "message", author: "agent", authorName: "Head baker", text: inlineDocumentLinkText, createdAtIso: new Date(Date.now() - 60_000).toISOString() }} />
  </div></div></CoordinatorPresentation.Provider>;
}
/** A document link inside a sentence must stay in the text line: no taller box that overlaps the lines around it. */
export const InlineDocumentLink: Story = {
  render: () => <InlineDocumentLinkConversation />,
  parameters: { paperclip: { capabilities: ["agent-chat/history"], status: "current", implementation: "production", boundary: "fixtures", notes: "Production task chat bubble and markdown document link inside running text. Sample content only; proves layout, not document storage or navigation." } },
  play: async ({ canvasElement }) => {
    const link = await within(canvasElement).findByRole("link", { name: /plan is saved/ });
    const paragraph = link.closest("p")!;
    const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
    const box = link.getBoundingClientRect();
    const textBox = paragraph.getBoundingClientRect();
    await expect(box.height).toBeLessThanOrEqual(lineHeight);
    await expect(box.top).toBeGreaterThanOrEqual(textBox.top);
  },
};
export const InlineDocumentLinkDark: Story = { ...InlineDocumentLink, play: undefined, globals: { theme: "dark" } };
