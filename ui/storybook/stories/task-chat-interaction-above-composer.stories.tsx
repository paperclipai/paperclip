import { useState, type CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { IssueThreadInteraction, IssueWorkMode } from "@paperclipai/shared";
import { ChevronLeft, Ellipsis } from "lucide-react";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import type { TaskChatRuntimeRequestItem } from "@/components/task-chat/task-chat-model";
import {
  genericPendingRequestConfirmationInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSuggestedTasksInteraction,
  pendingToolActionWriteInteraction,
  issueThreadInteractionFixtureMeta,
} from "@/fixtures/issueThreadInteractionFixtures";
import { composerAgentAppearance, composerAgents } from "../prototypes/composer-model-picker/fixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const agentMap = new Map(composerAgents.map((agent) => [agent.id, {
  id: agent.id,
  name: agent.name,
  appearance: composerAgentAppearance(agent.id),
}]));
const assignees = composerAgents.map((agent) => ({ id: `agent:${agent.id}`, label: agent.name }));
const mobileQuestionInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "interaction-mobile-question",
  title: "Question",
  payload: {
    ...pendingAskUserQuestionsInteraction.payload,
    title: "Question",
    questions: [{
      ...pendingAskUserQuestionsInteraction.payload.questions[0],
      id: "draft-choice",
      prompt: "Should I use the existing draft?",
      helpText: undefined,
      options: [
        { id: "keep", label: "Use the existing draft" },
        { id: "fresh", label: "Start fresh" },
      ],
    }],
  },
};

const mobileDetailedQuestionInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "interaction-mobile-detailed-question",
  payload: {
    ...pendingAskUserQuestionsInteraction.payload,
    questions: [pendingAskUserQuestionsInteraction.payload.questions[0]],
  },
};

function InteractionAboveComposer({ interaction, mobile = false }: { interaction: IssueThreadInteraction; mobile?: boolean }) {
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(true);
  const [messages, setMessages] = useState<string[]>([]);
  const resolve = () => { setPending(false); setOpen(false); };
  const content = (
    <TaskChatInteractionCard
      item={{ id: `interaction:${interaction.id}`, kind: "interaction", interaction }}
      presentation="takeover"
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      onAcceptInteraction={async () => resolve()}
      onRejectInteraction={async () => resolve()}
      onSubmitInteractionAnswers={async () => resolve()}
      onSubmitInteractionVerdicts={async () => resolve()}
    />
  );
  const composer = (
    <TaskChatComposer
      onAdd={async (body) => setMessages((current) => [...current, body])}
      workMode={workMode}
      onWorkModeChange={setWorkMode}
      enableReassign
      currentAssigneeValue="agent:codex"
      reassignOptions={assignees}
      agentMap={agentMap}
      mobile={mobile}
      takeover={pending && open ? {
        id: interaction.id,
        label: interaction.title ?? "Pending input",
        pendingCount: 1,
        content,
        onDismiss: () => setOpen(false),
        onSkip: resolve,
        inlineSkip: interaction.kind === "ask_user_questions" || interaction.kind === "request_item_verdicts",
        hideSkip: interaction.kind !== "ask_user_questions" && interaction.kind !== "request_item_verdicts",
        hideLabel: interaction.kind === "request_confirmation" && Boolean(interaction.payload.toolAction),
      } : null}
      pendingTakeover={pending ? { count: 1, label: "1 pending input", onOpen: () => setOpen(true) } : null}
    />
  );

  if (mobile) return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4 text-sm">
        <ChevronLeft className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">PAP-1715 · Interaction review</span>
        <Ellipsis className="size-4 text-muted-foreground" aria-hidden />
      </header>
      <main className="flex flex-1 flex-col p-4 pb-(--tc-composer-visible-nav-offset)"
        style={{ "--tc-composer-bottom": "var(--tc-composer-visible-nav-offset)" } as CSSProperties}>
        <div className="-mx-4 flex flex-1 flex-col">
          <div className="space-y-4 px-4 text-sm">
            {messages.map((body, index) => <p key={index} className="ml-8 rounded-lg bg-secondary px-3 py-2">{body}</p>)}
          </div>
          <div className="min-h-4 flex-1" />
          <TaskChatComposerDock mobile streamlined={false}>{composer}</TaskChatComposerDock>
        </div>
      </main>
      <MobileBottomNav visible />
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <header className="text-sm">
          <h1 className="text-base font-semibold">PAP-1715 · Interaction review</h1>
          <p className="text-muted-foreground">A pending decision stays visible while you write a normal message.</p>
        </header>
        <div className="flex-1 space-y-3 py-6">
          {messages.map((body, index) => <p key={index} className="ml-auto max-w-fit rounded-lg bg-secondary px-3 py-2 text-sm">{body}</p>)}
        </div>
        {composer}
      </div>
    </div>
  );
}

const meta = {
  title: "Composer/Interaction above composer",
  component: InteractionAboveComposer,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    docs: { description: { component: "The production task interaction card and composer shown together. Dismissal leaves a pending indicator; Skip or a decision resolves the card. The editor remains available throughout." } },
  },
  args: { interaction: pendingAskUserQuestionsInteraction, mobile: false },
} satisfies Meta<typeof InteractionAboveComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AskUserQuestions: Story = {};
export const AskUserQuestionsAndSend: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = canvas.getByTestId("mdx-editor");
    await userEvent.click(editor);
    await userEvent.type(editor, "I can keep working while I decide.");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(canvas.getByText("I can keep working while I decide.")).toBeVisible();
    await expect(canvas.getByTestId("task-chat-composer-takeover")).toBeVisible();
  },
};
export const PlanReview: Story = { args: { interaction: pendingRequestConfirmationInteraction } };
export const SimpleConfirmation: Story = { args: { interaction: genericPendingRequestConfirmationInteraction } };
export const CheckboxConfirmation: Story = { args: { interaction: pendingRequestCheckboxConfirmationInteraction } };
export const ItemVerdicts: Story = { args: { interaction: pendingRequestItemVerdictsInteraction } };
export const SuggestedTasks: Story = { args: { interaction: pendingSuggestedTasksInteraction } };
export const ToolReview: Story = { args: { interaction: pendingToolActionWriteInteraction } };

const runtimeRequest: TaskChatRuntimeRequestItem = {
  id: "runtime-question",
  kind: "protocol",
  surface: "runtime_request",
  runId: "storybook-run",
  requestId: "runtime-question",
  requestKind: "user_input",
  turnId: "storybook-turn",
  requestType: "input",
  status: "pending",
  prompt: "The agent needs your input to continue.",
  choices: [],
  fields: [],
  questionSet: {
    schema: "paperclip.question_set.v1",
    title: "Runtime question",
    questions: [{
      id: "environment",
      prompt: "Which environment should the run target?",
      answerMode: "single_select",
      required: true,
      options: [{ id: "staging", label: "Staging" }, { id: "production", label: "Production" }],
    }],
  },
};

function RuntimeQuestionAboveComposer() {
  const [open, setOpen] = useState(true);
  return <div className="flex min-h-screen flex-col bg-background p-6 text-foreground">
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end">
      <TaskChatComposer
        onAdd={async () => {}}
        workMode="standard"
        takeover={open ? {
          id: runtimeRequest.id,
          label: "Runtime question",
          pendingCount: 1,
          content: <TaskChatProtocolCard item={runtimeRequest} presentation="takeover" onRuntimeRequestDecision={async () => setOpen(false)} />,
          onDismiss: () => setOpen(false),
          onSkip: () => setOpen(false),
          inlineSkip: true,
        } : null}
      />
    </div>
  </div>;
}

export const RuntimeQuestion: Story = { render: () => <RuntimeQuestionAboveComposer /> };
export const MobileQuestionsWithBottomBar: Story = {
  args: { interaction: mobileQuestionInteraction, mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-composer-takeover")).toBeVisible();
    await expect(canvas.getByTestId("task-chat-composer-input")).toBeVisible();
    await expect(canvas.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  },
};
export const MobileDetailedQuestionsWithBottomBar: Story = {
  name: "Mobile detailed questions with bottom bar",
  args: { interaction: mobileDetailedQuestionInteraction, mobile: true },
  globals: { viewport: { value: "mobile", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByTestId("task-chat-composer-takeover");
    await expect(canvas.getByRole("radio", { name: /Only collapse hidden descendants/ })).toBeVisible();
    await expect(canvas.getByRole("radio", { name: /Collapse all descendants by default/ })).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Other" })).toBeVisible();
    await expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight);
    const composer = canvas.getByTestId("task-chat-composer-input");
    const nav = canvas.getByRole("navigation", { name: "Mobile navigation" });
    await expect(composer).toBeVisible();
    await expect(card.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top);
    await expect(composer.getBoundingClientRect().bottom).toBeLessThan(nav.getBoundingClientRect().top);
  },
};
export const MobileConfirmationWithBottomBar: Story = {
  args: { interaction: genericPendingRequestConfirmationInteraction, mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const MobileToolReviewWithBottomBar: Story = {
  args: { interaction: pendingToolActionWriteInteraction, mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
