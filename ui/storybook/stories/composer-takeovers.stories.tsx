import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AskUserQuestionsInteraction,
  IssueDocument,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatPlanPreviewCard } from "@/components/task-chat/TaskChatPlanPreviewCard";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { interactionReplacesComposerSkip } from "@/lib/issue-thread-interactions";
import {
  runtimeRequestReplacesComposerSkip,
  type TaskChatProviderActivityItem,
  type TaskChatRuntimeRequestDecision,
  type TaskChatRuntimeRequestItem,
} from "@/components/task-chat/task-chat-model";
import {
  genericPendingRequestConfirmationInteraction,
  humanOnlyRequestConfirmationInteraction,
  issueThreadInteractionFixtureMeta,
  manyItemsRequestItemVerdictsInteraction,
  manyOptionsRequestCheckboxConfirmationInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSecretProposalInteraction,
  pendingSuggestedTasksInteraction,
  pendingToolActionDestructiveInteraction,
  staleTargetRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const boardUserLabels = new Map([
  [issueThreadInteractionFixtureMeta.currentUserId, "Riley Board"],
]);

const storybookMentions = [
  {
    id: "agent:agent-codex",
    name: "CodexCoder",
    kind: "agent" as const,
    agentId: "agent-codex",
    agentIcon: "code",
  },
  {
    id: "user:user-board",
    name: "Riley Board",
    kind: "user" as const,
    userId: "user-board",
  },
];

const composerAssigneeOptions = [
  { id: "user:user-board", label: "Riley Board" },
  { id: "agent:agent-codex", label: "CodexCoder" },
  { id: "agent:agent-qa", label: "QAChecker" },
  { id: "user:user-product", label: "Morgan Product" },
];

const composerAssigneeUserProfiles = new Map([
  [
    "user-board",
    {
      label: "Riley Board",
      image:
        "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80",
    },
  ],
  ["user-product", { label: "Morgan Product", image: null }],
]);

const planDocument: IssueDocument = {
  id: "composer-plan",
  companyId: "storybook-company",
  issueId: "storybook-issue",
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "# Composer takeover rollout\n\n- Move pending action controls into the composer.\n- Keep the Plan preview in the originating turn.\n- Record a compact lifecycle receipt.",
  latestRevisionId: "composer-plan-r4",
  latestRevisionNumber: 4,
  createdByAgentId: "agent-codex",
  createdByUserId: null,
  updatedByAgentId: "agent-codex",
  updatedByUserId: null,
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: new Date("2026-08-24T13:00:00.000Z"),
  updatedAt: new Date("2026-08-24T13:02:00.000Z"),
};

const pendingPlanReviewInteraction: IssueThreadInteraction = {
  ...genericPendingRequestConfirmationInteraction,
  id: "plan-review",
  sourceRunId: "plan-run",
  title: "Review the proposed plan",
  payload: {
    ...genericPendingRequestConfirmationInteraction.payload,
    prompt: "Do you accept this plan?",
    acceptLabel: "Approve plan",
    rejectLabel: "Request changes",
    rejectRequiresReason: true,
    rejectReasonLabel: "What should change?",
    target: {
      type: "issue_document",
      issueId: planDocument.issueId,
      documentId: planDocument.id,
      key: "plan",
      revisionId: planDocument.latestRevisionId!,
      revisionNumber: planDocument.latestRevisionNumber,
    },
  },
};

function TaskFrame({
  children,
  composer,
}: {
  children: React.ReactNode;
  composer: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto flex min-h-(--sz-70vh) w-full max-w-(--tc-shell-max-w) flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="min-h-0 flex-1 p-4">{children}</div>
        <div className="border-t border-border bg-background/90 p-3">
          {composer}
        </div>
      </section>
    </main>
  );
}

function Header({ title }: { title: string }) {
  return (
    <header className="border-b border-border pb-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        PAP-16679 · Input requested
      </p>
      <h1 className="mt-1 text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The timeline keeps context; the composer owns the decision.
      </p>
    </header>
  );
}

function skippedInteraction(
  interaction: IssueThreadInteraction,
): IssueThreadInteraction {
  if (interaction.kind === "ask_user_questions") {
    return {
      ...interaction,
      status: "cancelled",
      resolvedAt: new Date(),
      result: {
        version: 1,
        outcome: "skipped",
        answers: [],
        cancelled: true,
        summaryMarkdown: null,
      },
    };
  }
  if (interaction.kind === "request_item_verdicts") {
    return {
      ...interaction,
      status: "cancelled",
      resolvedAt: new Date(),
      result: {
        version: 1,
        outcome: "skipped",
        complete: false,
        items: interaction.result?.items ?? [],
      },
    };
  }
  return {
    ...interaction,
    status: "cancelled",
    resolvedAt: new Date(),
    result: { version: 1, outcome: "skipped" },
  } as IssueThreadInteraction;
}

function InteractionTakeoverFrame({
  initial,
  title,
  mobile = false,
  pendingCount = 1,
  draftKey,
}: {
  initial: IssueThreadInteraction;
  title?: string;
  mobile?: boolean;
  pendingCount?: number;
  draftKey?: string;
}) {
  const [interaction, setInteraction] = useState(initial);
  const [open, setOpen] = useState(initial.status === "pending");
  const item = {
    id: `interaction:${interaction.id}`,
    kind: "interaction" as const,
    interaction,
  };
  const resolveAccepted = () =>
    setInteraction({
      ...interaction,
      status: "accepted",
      resolvedAt: new Date(),
      result:
        interaction.kind === "request_checkbox_confirmation"
          ? {
              version: 1,
              outcome: "accepted",
              selectedOptionIds:
                interaction.payload.defaultSelectedOptionIds ?? [],
            }
          : interaction.kind === "suggest_tasks"
            ? { version: 1, createdTasks: [], skippedClientKeys: [] }
            : { version: 1, outcome: "accepted" },
    } as IssueThreadInteraction);
  const takeover =
    open && interaction.status === "pending"
      ? {
          id: interaction.id,
          label: title ?? interaction.title ?? "Pending input",
          pendingCount,
          content: (
            <TaskChatInteractionCard
              item={item}
              presentation="takeover"
              draftKey={`storybook:composer-takeover:${interaction.id}`}
              planDocument={planDocument}
              agentMap={storybookAgentMap}
              currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
              userLabelMap={boardUserLabels}
              onAcceptInteraction={resolveAccepted}
              onRejectInteraction={(_candidate, reason) =>
                setInteraction({
                  ...interaction,
                  status: "rejected",
                  resolvedAt: new Date(),
                  result: { version: 1, outcome: "rejected", reason },
                } as IssueThreadInteraction)
              }
              onSubmitInteractionAnswers={(_candidate, answers) =>
                setInteraction({
                  ...interaction,
                  status: "answered",
                  resolvedAt: new Date(),
                  result: { version: 1, answers },
                } as IssueThreadInteraction)
              }
              onSubmitInteractionVerdicts={(_candidate, verdicts) =>
                setInteraction({
                  ...interaction,
                  status: "answered",
                  resolvedAt: new Date(),
                  result: {
                    version: 1,
                    outcome: "resolved",
                    complete: true,
                    items: verdicts.map((verdict) => ({
                      ...verdict,
                      resolvedAt: new Date(),
                      resolvedByUserId:
                        issueThreadInteractionFixtureMeta.currentUserId,
                    })),
                  },
                } as IssueThreadInteraction)
              }
              onUploadImage={async (file) => URL.createObjectURL(file)}
              mentions={storybookMentions}
            />
          ),
          onDismiss: () => setOpen(false),
          onSkip: () => {
            setInteraction(skippedInteraction(interaction));
            setOpen(false);
          },
          onShowNext: () => undefined,
          inlineSkip:
            interaction.kind === "ask_user_questions" ||
            interaction.kind === "request_item_verdicts",
          hideSkip: interactionReplacesComposerSkip(interaction),
        }
      : null;
  const body = (
    <TaskFrame
      composer={
        <TaskChatComposer
          onAdd={() => undefined}
          workMode="standard"
          draftKey={draftKey ?? `storybook:normal-draft:${interaction.id}`}
          takeover={takeover}
          pendingTakeover={
            !open && interaction.status === "pending"
              ? {
                  count: pendingCount,
                  label: "Return to pending request",
                  onOpen: () => setOpen(true),
                }
              : null
          }
          mobile={mobile}
        />
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={
          <Header title={title ?? interaction.title ?? "Resolve task input"} />
        }
        items={[
          {
            id: "request",
            kind: "message",
            author: "human",
            text: "Implement this carefully and ask when a product decision is needed.",
            timestamp: "8:58 AM",
          },
          item,
        ]}
        renderInteraction={(candidate) => (
          <TaskChatInteractionCard
            item={candidate}
            planDocument={planDocument}
            agentMap={storybookAgentMap}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
            userLabelMap={boardUserLabels}
          />
        )}
      />
    </TaskFrame>
  );
  return mobile ? (
    <div className="mx-auto max-w-(--sz-390px)">{body}</div>
  ) : (
    body
  );
}

function questionVariant(
  id: string,
  questions: NonNullable<
    AskUserQuestionsInteraction["payload"]["questionSet"]
  >["questions"],
  options: { title?: string; description?: string; submitLabel?: string } = {},
): AskUserQuestionsInteraction {
  const legacyQuestions = questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    helpText: question.helpText,
    selectionMode:
      question.answerMode === "multi_select"
        ? ("multi" as const)
        : ("single" as const),
    required: question.required,
    options:
      question.answerMode === "text"
        ? [{ id: "text", label: "Write an answer", freeText: true }]
        : (question.options ?? []).map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description,
          })),
  }));
  return {
    ...pendingAskUserQuestionsInteraction,
    id,
    title: options.title ?? null,
    payload: {
      version: 1,
      questions: legacyQuestions,
      questionSet: {
        schema: "paperclip.question_set.v1",
        ...options,
        questions,
      },
    },
  };
}

const singleQuestion = questionVariant("takeover-single", [
  {
    id: "scope",
    prompt: "Which rollout scope should we use?",
    helpText: "This controls who sees the new task view first.",
    required: false,
    answerMode: "single_select",
    options: [
      {
        id: "pilot",
        label: "Pilot workspace",
        description: "Start with the internal team.",
        recommended: true,
      },
      {
        id: "all",
        label: "All workspaces",
        description: "Release immediately.",
      },
    ],
  },
]);
const multiQuestion = questionVariant("takeover-multi", [
  {
    id: "checks",
    prompt: "Which checks must block launch?",
    required: false,
    answerMode: "multi_select",
    options: [
      { id: "a11y", label: "Accessibility", recommended: true },
      { id: "visual", label: "Visual snapshots" },
      { id: "e2e", label: "End-to-end" },
    ],
  },
]);
const textQuestion = questionVariant("takeover-text", [
  {
    id: "note",
    prompt: "Describe the rollout caveat.",
    required: false,
    answerMode: "text",
    textValidation: { minLength: 12, maxLength: 240 },
  },
]);
const customQuestion = questionVariant("takeover-custom", [
  {
    id: "adapter",
    prompt: "Which adapter should own the pilot?",
    required: false,
    answerMode: "single_select",
    options: [
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ],
    customAnswer: {
      enabled: true,
      label: "Another adapter",
      placeholder: "Name the adapter",
    },
  },
]);
const optionalQuestion = questionVariant("takeover-optional", [
  {
    id: "note",
    prompt: "Anything else the runner should know?",
    required: false,
    answerMode: "text",
  },
]);
const validatedQuestion = questionVariant("takeover-validated", [
  {
    id: "limit",
    prompt: "Maximum pending requests",
    required: false,
    answerMode: "text",
    textValidation: { inputType: "integer", minimum: 1, maximum: 10 },
  },
]);
const multiPageQuestions = questionVariant(
  "takeover-pages",
  [
    {
      id: "scope",
      header: "Scope",
      prompt: "Where should this ship?",
      required: false,
      answerMode: "single_select",
      options: [
        { id: "pilot", label: "Pilot", recommended: true },
        { id: "all", label: "Everyone" },
      ],
    },
    {
      id: "checks",
      header: "Quality",
      prompt: "Which checks matter?",
      required: false,
      answerMode: "multi_select",
      options: [
        { id: "a11y", label: "Accessibility" },
        { id: "visual", label: "Visual" },
      ],
    },
    {
      id: "note",
      header: "Context",
      prompt: "Add implementation context.",
      required: false,
      answerMode: "text",
    },
  ],
  { title: "Release decisions", submitLabel: "Submit answers" },
);

function RuntimeTakeoverFrame({
  initial,
  fallback,
}: {
  initial: TaskChatRuntimeRequestItem;
  fallback?: AskUserQuestionsInteraction;
}) {
  const [request, setRequest] = useState(initial);
  const [lost, setLost] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const active =
    dismissed || (lost && fallback)
      ? null
      : request.status === "pending"
        ? request
        : null;
  const draftKey = `storybook:runtime:${initial.runId}:${initial.requestId}`;
  const resolve = (
    _item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => {
    setRequest((current) => ({
      ...current,
      status: decision.action === "cancel" ? "cancelled" : "resolved",
    }));
  };
  const timelineItems =
    fallback && lost
      ? [
          {
            id: `interaction:${fallback.id}`,
            kind: "interaction" as const,
            interaction: fallback,
          },
        ]
      : [];
  return (
    <TaskFrame
      composer={
        <TaskChatComposer
          onAdd={() => undefined}
          workMode="standard"
          takeover={
            active
              ? {
                  id: `${active.runId}:${active.requestId}`,
                  label:
                    active.requestType === "permission"
                      ? "Runtime permission"
                      : (active.questionSet?.title ?? "Runtime input"),
                  pendingCount: 1,
                  content: (
                    <TaskChatProtocolCard
                      item={active}
                      presentation="takeover"
                      draftKey={draftKey}
                      imageUploadHandler={async (file) =>
                        URL.createObjectURL(file)
                      }
                      mentions={storybookMentions}
                      onRuntimeRequestDecision={resolve}
                    />
                  ),
                  onDismiss: () => setDismissed(true),
                  onSkip: () => resolve(active, { action: "cancel" }),
                  inlineSkip:
                    active.requestType === "input" &&
                    Boolean(active.questionSet),
                  hideSkip: runtimeRequestReplacesComposerSkip(active),
                }
              : !dismissed && lost && fallback
                ? {
                    id: fallback.id,
                    label: fallback.title ?? "Recovered questions",
                    pendingCount: 1,
                    content: (
                      <TaskChatInteractionCard
                        item={{
                          id: `interaction:${fallback.id}`,
                          kind: "interaction",
                          interaction: fallback,
                        }}
                        presentation="takeover"
                        draftKey={draftKey}
                        onUploadImage={async (file) =>
                          URL.createObjectURL(file)
                        }
                        mentions={storybookMentions}
                        onSubmitInteractionAnswers={() => undefined}
                      />
                    ),
                    onDismiss: () => setDismissed(true),
                    onSkip: () => undefined,
                    inlineSkip: true,
                  }
                : null
          }
          pendingTakeover={
            dismissed &&
            (request.status === "pending" ||
              (lost && fallback?.status === "pending"))
              ? {
                  count: 1,
                  label: "Return to pending runtime request",
                  onOpen: () => setDismissed(false),
                }
              : null
          }
        />
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<Header title="Live runner request" />}
        items={timelineItems}
        renderInteraction={(item) => <TaskChatInteractionCard item={item} />}
        tail={
          <TaskChatRunnerTurn
            runId={request.runId}
            agentName="Runner"
            items={[request]}
            status={lost ? "failed" : "running"}
            startedAtMs={Date.now() - 12_000}
          />
        }
      />
      {fallback ? (
        <button
          type="button"
          className="mt-3 rounded-md bg-muted px-3 py-2 text-sm"
          onClick={() => {
            setRequest((current) => ({ ...current, status: "expired" }));
            setLost(true);
          }}
        >
          Simulate runner loss
        </button>
      ) : null}
    </TaskFrame>
  );
}

const runtimePermission: TaskChatRuntimeRequestItem = {
  id: "runtime-permission",
  kind: "protocol",
  surface: "runtime_request",
  runId: "run-live",
  requestId: "permission-1",
  requestKind: "command_approval",
  turnId: "turn-1",
  requestType: "permission",
  status: "pending",
  prompt: "Allow the runner to execute the release verification command?",
  choices: [
    { key: "accept", label: "Allow once" },
    { key: "accept_for_session", label: "Allow for session" },
    { key: "decline", label: "Deny" },
    { key: "cancel", label: "Cancel" },
  ],
  fields: [],
};
const runtimeQuestions: TaskChatRuntimeRequestItem = {
  id: "runtime-questions",
  kind: "protocol",
  surface: "runtime_request",
  runId: "run-live",
  requestId: "input-1",
  requestKind: "runtime",
  turnId: "turn-1",
  requestType: "input",
  status: "pending",
  prompt: "Choose the verification environment.",
  choices: [],
  fields: [],
  questionSet: multiPageQuestions.payload.questionSet,
};
const runtimeCustomAnswer: TaskChatRuntimeRequestItem = {
  id: "runtime-custom-answer",
  kind: "protocol",
  surface: "runtime_request",
  runId: "run-live",
  requestId: "input-custom-answer",
  requestKind: "runtime",
  turnId: "turn-1",
  requestType: "input",
  status: "pending",
  prompt: "Choose an adapter or describe another one.",
  choices: [],
  fields: [],
  questionSet: {
    ...customQuestion.payload.questionSet!,
    title: "Codex needs your input",
  },
};
const runtimeTextInput: TaskChatRuntimeRequestItem = {
  id: "runtime-text-input",
  kind: "protocol",
  surface: "runtime_request",
  runId: "run-live",
  requestId: "text-input-1",
  requestKind: "user_input",
  turnId: "turn-1",
  requestType: "input",
  status: "pending",
  prompt: "Which environment should the verification target?",
  choices: [
    { key: "decline", label: "Deny" },
    { key: "cancel", label: "Cancel" },
  ],
  fields: [
    { name: "environment", label: "Environment", placeholder: "staging" },
  ],
};
const recoveredQuestion: AskUserQuestionsInteraction = {
  ...singleQuestion,
  id: "runtime-fallback",
  sourceRunId: "run-live",
  payload: { ...singleQuestion.payload, runtimeRequestId: "input-1" },
};

const writingPlan: TaskChatProviderActivityItem = {
  id: "writing-plan",
  kind: "protocol",
  surface: "provider_activity",
  family: "plan",
  eventType: "plan.updated",
  status: "running",
  title: "Plan",
  details: [],
  links: [],
  children: [],
  steps: [
    { id: "one", label: "Inventory composer inputs", status: "completed" },
    { id: "two", label: "Design the takeover", status: "in_progress" },
  ],
};

function PreservedDraftStory() {
  const draftKey = "storybook:preserved-normal-draft";
  try {
    localStorage.setItem(
      draftKey,
      "Keep the existing rollout boundary, but add mobile coverage.",
    );
  } catch {
    // Storybook's storage can be disabled in isolated renderers.
  }
  return (
    <InteractionTakeoverFrame initial={singleQuestion} draftKey={draftKey} />
  );
}

const meta = {
  title: "Task Page/Composer Takeovers",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleChoiceQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={singleQuestion} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Dismiss Pending input",
      }),
    ).toBeVisible();
  },
};
export const MultipleChoiceQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={multiQuestion} />,
};
export const TextQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={textQuestion} />,
};
export const CustomAnswerQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={customQuestion} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("radio", { name: "Another adapter" }),
    );
    await expect(
      canvas.getByTestId("question-other-answer-composer"),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Attach image" }),
    ).toBeVisible();
  },
};
export const OptionalQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={optionalQuestion} />,
};
export const ValidatedQuestion: Story = {
  render: () => <InteractionTakeoverFrame initial={validatedQuestion} />,
};
export const MultiPageQuestions: Story = {
  render: () => <InteractionTakeoverFrame initial={multiPageQuestions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Pilot"));
    await expect(canvas.getByText("Which checks matter?")).toBeVisible();
  },
};
export const GenericConfirmation: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={genericPendingRequestConfirmationInteraction}
    />
  ),
};
export const CheckboxSelection: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={pendingRequestCheckboxConfirmationInteraction}
    />
  ),
};
export const LongCheckboxSelection: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={manyOptionsRequestCheckboxConfirmationInteraction}
    />
  ),
};
export const SuggestedTasks: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={pendingSuggestedTasksInteraction} />
  ),
};
export const ItemVerdicts: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={pendingRequestItemVerdictsInteraction} />
  ),
};
export const ManyItemVerdicts: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={manyItemsRequestItemVerdictsInteraction}
    />
  ),
};
export const ToolActionApproval: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={pendingToolActionDestructiveInteraction}
    />
  ),
};
export const SecretProposalApproval: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={pendingSecretProposalInteraction} />
  ),
};
export const UnavailableResolver: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={humanOnlyRequestConfirmationInteraction}
      title="Human-only confirmation"
    />
  ),
};
export const ExpiredAndStaleReceipts: Story = {
  render: () => (
    <TaskFrame
      composer={
        <TaskChatComposer onAdd={() => undefined} workMode="standard" />
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<Header title="Lifecycle receipts" />}
        items={[
          {
            id: "stale",
            kind: "interaction",
            interaction: staleTargetRequestConfirmationInteraction,
          },
        ]}
        renderInteraction={(item) => (
          <TaskChatInteractionCard item={item} planDocument={planDocument} />
        )}
      />
    </TaskFrame>
  ),
};
export const LiveRuntimePermission: Story = {
  render: () => <RuntimeTakeoverFrame initial={runtimePermission} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        "Allow the runner to execute the release verification command?",
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Dismiss Runtime permission" }),
    ).toBeVisible();
  },
};
export const LiveRuntimeTextInput: Story = {
  render: () => <RuntimeTakeoverFrame initial={runtimeTextInput} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Environment")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Dismiss Runtime input" }),
    ).toBeVisible();
  },
};
export const LiveRuntimeQuestions: Story = {
  render: () => <RuntimeTakeoverFrame initial={runtimeQuestions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByTestId("task-chat-composer-takeover-header");
    await expect(within(header).getByText("Release decisions")).toBeVisible();
    await expect(within(header).getByText("1 of 3")).toBeVisible();
    await expect(
      within(header).getByRole("button", { name: "Dismiss Release decisions" }),
    ).toBeVisible();
  },
};
export const LiveRuntimeOtherAnswerRichComposer: Story = {
  render: () => <RuntimeTakeoverFrame initial={runtimeCustomAnswer} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("radio", { name: "Another adapter" }),
    );
    const richInput = canvas.getByTestId("question-other-answer-composer");
    await expect(richInput).toBeVisible();
    await expect(richInput.className).not.toContain("border");
    await expect(
      canvas.getByRole("button", { name: "Attach image" }),
    ).toBeVisible();
    await expect(
      canvas.getByText("or drop/paste an image into the note"),
    ).toBeVisible();
  },
};
export const RunnerLossFallback: Story = {
  render: () => (
    <RuntimeTakeoverFrame
      initial={runtimeQuestions}
      fallback={recoveredQuestion}
    />
  ),
};
export const MultiplePendingInputs: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={multiPageQuestions} pendingCount={4} />
  ),
  play: async ({ canvasElement }) => {
    const header = within(canvasElement).getByTestId(
      "task-chat-composer-takeover-header",
    );
    await expect(within(header).getByText("Release decisions")).toBeVisible();
    await expect(within(header).getByText("4 pending")).toBeVisible();
    await expect(within(header).getByText("1 of 3")).toBeVisible();
    await expect(
      within(header).getByRole("button", { name: "Dismiss Release decisions" }),
    ).toBeVisible();
  },
};
export const PreservedDraftAfterSkip: Story = {
  render: () => <PreservedDraftStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await expect(
      canvas.getByText(
        "Keep the existing rollout boundary, but add mobile coverage.",
      ),
    ).toBeVisible();
  },
};
export const AssigneeSelectorIdentities: Story = {
  render: () => (
    <TaskFrame
      composer={
        <TaskChatComposer
          onAdd={() => undefined}
          workMode="standard"
          enableReassign
          reassignOptions={composerAssigneeOptions}
          agentMap={storybookAgentMap}
          userProfileMap={composerAssigneeUserProfiles}
          currentAssigneeValue="user:user-board"
        />
      }
    >
      <TaskChatThreadView
        scroll={false}
        header={<Header title="Assign the next message" />}
        items={[
          {
            id: "assignee-context",
            kind: "message",
            author: "agent",
            authorName: "CodexCoder",
            text: "Choose a human or agent to receive the next message.",
            timestamp: "9:07 AM",
          },
        ]}
      />
    </TaskFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByTestId("task-chat-composer-assignee");
    await expect(
      trigger.querySelector('[data-assignee-trigger-avatar="user-board"]'),
    ).not.toBeNull();
    await userEvent.click(trigger);

    const documentBody = canvasElement.ownerDocument.body;
    await expect(
      documentBody.querySelector(
        '[data-assignee-option-avatar="user:user-board"]',
      ),
    ).not.toBeNull();
    await expect(
      documentBody.querySelector(
        '[data-assignee-option-icon="agent:agent-codex"]',
      ),
    ).not.toBeNull();
  },
};
export const MobileQuestion: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={multiPageQuestions} mobile />
  ),
};
export const PlanWriting: Story = {
  render: () => (
    <TaskFrame
      composer={
        <TaskChatComposer onAdd={() => undefined} workMode="planning" />
      }
    >
      <TaskChatRunnerTurn
        runId="plan-run"
        agentName="Codex"
        items={[writingPlan]}
        status="running"
        startedAtMs={Date.now() - 5_000}
      />
    </TaskFrame>
  ),
};
export const PlanSynchronizedReview: Story = {
  render: () => (
    <InteractionTakeoverFrame initial={pendingPlanReviewInteraction} />
  ),
};
export const PlanReviewWithPendingQueue: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={{
        ...pendingPlanReviewInteraction,
        id: "plan-review-pending-queue",
        title: "Review boats and super beasts",
      }}
      pendingCount={2}
    />
  ),
  play: async ({ canvasElement }) => {
    const header = within(canvasElement).getByTestId(
      "task-chat-composer-takeover-header",
    );
    await expect(
      within(header).getByText("Review boats and super beasts"),
    ).toBeVisible();
    await expect(within(header).getByText(/plan/)).toBeVisible();
    await expect(within(header).getByText("2 pending")).toBeVisible();
    await expect(
      within(header).getByRole("button", {
        name: "Dismiss Review boats and super beasts",
      }),
    ).toBeVisible();
  },
};
export const PlanRequestChangesRichComposer: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={{
        ...pendingPlanReviewInteraction,
        id: "plan-review-rich-revision",
        title: "Review boats and super beasts",
        payload: {
          ...pendingPlanReviewInteraction.payload,
          rejectRequiresReason: false,
          allowDeclineReason: true,
        },
      }}
      pendingCount={2}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Request changes" }),
    );
    await expect(canvas.getByTestId("plan-revision-composer")).toBeVisible();
    await expect(
      canvas.getByText("What should change? (optional)"),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Attach image" }),
    ).toBeVisible();
    await expect(
      canvas.getByText("or drop/paste an image into the note"),
    ).toBeVisible();
  },
};
export const PlanAccepted: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={
        {
          ...genericPendingRequestConfirmationInteraction,
          id: "plan-accepted",
          status: "accepted",
          payload: {
            ...genericPendingRequestConfirmationInteraction.payload,
            target: {
              type: "issue_document",
              issueId: planDocument.issueId,
              documentId: planDocument.id,
              key: "plan",
              revisionId: planDocument.latestRevisionId!,
              revisionNumber: planDocument.latestRevisionNumber,
            },
          },
          result: { version: 1, outcome: "accepted" },
        } as IssueThreadInteraction
      }
    />
  ),
};
export const PlanChangesRequested: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={
        {
          ...genericPendingRequestConfirmationInteraction,
          id: "plan-rejected",
          status: "rejected",
          payload: {
            ...genericPendingRequestConfirmationInteraction.payload,
            target: {
              type: "issue_document",
              issueId: planDocument.issueId,
              documentId: planDocument.id,
              key: "plan",
              revisionId: planDocument.latestRevisionId!,
              revisionNumber: planDocument.latestRevisionNumber,
            },
          },
          result: {
            version: 1,
            outcome: "rejected",
            reason: "Clarify rollout and rollback steps.",
          },
        } as IssueThreadInteraction
      }
    />
  ),
};
export const PlanSkipped: Story = {
  render: () => (
    <InteractionTakeoverFrame
      initial={skippedInteraction({
        ...genericPendingRequestConfirmationInteraction,
        id: "plan-skipped",
        payload: {
          ...genericPendingRequestConfirmationInteraction.payload,
          target: {
            type: "issue_document",
            issueId: planDocument.issueId,
            documentId: planDocument.id,
            key: "plan",
            revisionId: planDocument.latestRevisionId!,
            revisionNumber: planDocument.latestRevisionNumber,
          },
        },
      } as IssueThreadInteraction)}
    />
  ),
};
