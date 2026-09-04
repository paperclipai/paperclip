import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  GitBranch,
  ListChecks,
  Loader2,
  MessageSquareQuote,
  Plug,
  Search,
  X,
} from "lucide-react";
import type { IssueDocument } from "@paperclipai/shared";
import type {
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "@paperclipai/adapter-utils";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { MentionOption } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { describeInteractionAudience } from "@/lib/interaction-audience";
import { interactionResolutionErrorMessage } from "@/lib/interaction-resolution-error";
import {
  clearDraft,
  loadStructuredDraft,
  saveStructuredDraft,
} from "@/lib/composer-draft";
import {
  buildIssueThreadInteractionSummary,
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  normalizeRequestConfirmationTargetHref,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictValue,
  type SuggestTasksInteraction,
  type SuggestedTaskTreeNode,
} from "@/lib/issue-thread-interactions";
import { cn } from "@/lib/utils";
import { QuestionForm } from "./QuestionForm";
import {
  TaskChatComposerTakeoverControls,
  TaskChatComposerTakeoverHeader,
  useTaskChatComposerTakeoverActions,
} from "./TaskChatComposerTakeoverContext";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import { TaskChatRichInput } from "./TaskChatRichInput";

const TAKEOVER_TEXTAREA_CLASS =
  "min-h-16 resize-y border-0 bg-muted/35 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0";

type SharedInteractionProps = Omit<
  ComponentProps<typeof IssueThreadInteractionCard>,
  "interaction" | "primaryActionOnRight"
>;

export interface TaskChatCompactInteractionCardProps extends SharedInteractionProps {
  interaction: IssueThreadInteraction;
  planDocument?: IssueDocument | null;
  showPlanPreview?: boolean;
  presentation?: "timeline" | "takeover";
  draftKey?: string;
  mentions?: MentionOption[];
}

const KIND_COPY = {
  suggest_tasks: {
    fallbackTitle: "Suggested tasks",
    label: "Tasks",
    icon: GitBranch,
  },
  ask_user_questions: {
    fallbackTitle: "Questions",
    label: "Questions",
    icon: CircleHelp,
  },
  request_confirmation: {
    fallbackTitle: "Confirmation",
    label: "Confirmation",
    icon: CheckCircle2,
  },
  request_checkbox_confirmation: {
    fallbackTitle: "Choose options",
    label: "Selection",
    icon: ListChecks,
  },
  request_item_verdicts: {
    fallbackTitle: "Review items",
    label: "Review",
    icon: MessageSquareQuote,
  },
  connection_intent: {
    fallbackTitle: "Connect service",
    label: "Connection",
    icon: Plug,
  },
} as const;

function statusLabel(status: IssueThreadInteraction["status"]): string {
  return status.replaceAll("_", " ");
}

function statusTone(status: IssueThreadInteraction["status"]): string {
  if (status === "pending") return "text-(--status-agent-running)";
  if (status === "accepted" || status === "answered")
    return "text-(--status-task-icon-done)";
  if (status === "rejected" || status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function StatusIcon({ status }: { status: IssueThreadInteraction["status"] }) {
  if (status === "pending") {
    return (
      <Circle
        aria-hidden
        className={cn("h-3.5 w-3.5 fill-current", statusTone(status))}
      />
    );
  }
  if (status === "accepted" || status === "answered") {
    return (
      <Check aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />
    );
  }
  if (status === "rejected" || status === "failed") {
    return <X aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />;
  }
  return (
    <Circle aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />
  );
}

function InteractionShell({
  interaction,
  audienceLabel,
  presentation,
  children,
}: {
  interaction: IssueThreadInteraction;
  audienceLabel?: string | null;
  presentation: "timeline" | "takeover";
  children: ReactNode;
}) {
  const kind = KIND_COPY[interaction.kind];
  const Icon = kind.icon;
  const title = (
    <div className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <strong className="min-w-0 truncate text-sm font-medium text-foreground">
        {interaction.title ?? kind.fallbackTitle}
      </strong>
      {interaction.kind === "request_confirmation" &&
      interaction.payload.target?.type === "issue_document" &&
      interaction.payload.target.key === "plan" ? (
        <CompactTarget interaction={interaction} />
      ) : null}
      {interaction.status !== "pending" ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-xs capitalize text-muted-foreground"
          data-testid="interaction-status-badge"
        >
          <StatusIcon status={interaction.status} />
          {statusLabel(interaction.status)}
        </span>
      ) : null}
    </div>
  );
  return (
    <article
      className={cn(
        "overflow-hidden",
        presentation === "timeline" &&
          "rounded-md border border-border bg-card/60",
      )}
    >
      {presentation === "takeover" ? (
        <TaskChatComposerTakeoverHeader>{title}</TaskChatComposerTakeoverHeader>
      ) : (
        <header className="flex min-w-0 items-start gap-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            {title}
            {audienceLabel ? (
              <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
                {audienceLabel}
              </p>
            ) : null}
          </div>
        </header>
      )}
      <div
        className={
          presentation === "timeline"
            ? "border-t border-border/70 px-3 py-3"
            : undefined
        }
      >
        {children}
      </div>
    </article>
  );
}

function InteractionActionError({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive" data-testid="interaction-action-error">
      {message ? (
        <div className="mt-2 rounded-sm border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
          {message}
        </div>
      ) : null}
    </div>
  );
}

function Details({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <details className="mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground">
        <ChevronDown aria-hidden className="h-3.5 w-3.5" /> Details
      </summary>
      <div className="mt-2 rounded-sm bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function ActionRow({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string | null;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {hint ? (
        <span className="mr-auto text-xs text-muted-foreground">{hint}</span>
      ) : (
        <span className="mr-auto" />
      )}
      {children}
    </div>
  );
}

function targetLabel(
  interaction:
    | RequestConfirmationInteraction
    | RequestCheckboxConfirmationInteraction
    | RequestItemVerdictsInteraction,
) {
  const target = interaction.payload.target;
  if (!target) return null;
  const label =
    target.label ??
    (target.type === "issue_document" ? target.key : target.key);
  const revision =
    target.revisionNumber == null ? null : `v${target.revisionNumber}`;
  return [label, revision].filter(Boolean).join(" · ");
}

function CompactTarget({
  interaction,
}: {
  interaction:
    | RequestConfirmationInteraction
    | RequestCheckboxConfirmationInteraction
    | RequestItemVerdictsInteraction;
}) {
  const target = interaction.payload.target;
  const label = targetLabel(interaction);
  if (!target || !label) return null;
  const href = target.href
    ? normalizeRequestConfirmationTargetHref(target.href)
    : null;
  if (href) {
    return (
      <a
        href={href}
        className="inline-flex rounded-sm border border-border px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted/60"
      >
        {label}
      </a>
    );
  }
  return (
    <span className="inline-flex rounded-sm border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
      {label}
    </span>
  );
}

function PlanReviewPreview({
  interaction,
  planDocument,
}: {
  interaction: RequestConfirmationInteraction;
  planDocument?: IssueDocument | null;
}) {
  const target = interaction.payload.target;
  if (target?.type !== "issue_document" || target.key !== "plan") return null;

  const targetRevisionId = target.revisionId ?? null;
  const targetRevision = target.revisionNumber ?? null;
  const documentMatchesTarget = Boolean(
    planDocument &&
    (targetRevisionId != null
      ? planDocument.latestRevisionId === targetRevisionId
      : targetRevision == null ||
        planDocument.latestRevisionNumber === targetRevision),
  );

  return (
    <TaskChatPlanPreviewCard
      source={{
        kind: "saved",
        document: documentMatchesTarget ? planDocument : null,
        revision: targetRevision,
        fallbackTitle: target.label,
      }}
      href="#document-plan"
      testId="plan-review-preview"
      ariaLabel={`Open ${target.label ?? (targetRevision == null ? "plan" : `plan revision ${targetRevision}`)}`}
    />
  );
}

function receiptReason(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result;
  if (!result) return null;
  if ("reason" in result && typeof result.reason === "string")
    return result.reason;
  if (interaction.kind === "ask_user_questions") {
    return (
      interaction.result?.cancellationReason ??
      interaction.result?.expirationReason?.replaceAll("_", " ") ??
      null
    );
  }
  return null;
}

function ReceiptDisclosure({
  interaction,
  externalReferences,
  compact = false,
}: {
  interaction: IssueThreadInteraction;
  externalReferences?: SharedInteractionProps["externalReferences"];
  compact?: boolean;
}) {
  const reason = receiptReason(interaction);
  const answerReason =
    reason ??
    (interaction.kind === "suggest_tasks"
      ? (interaction.result?.rejectionReason ?? null)
      : null);
  let request: ReactNode;

  if (interaction.kind === "ask_user_questions") {
    const questionSet = questionSetForInteraction(interaction);
    const response = questionResponseForInteraction(interaction, questionSet);
    request = (
      <div className="grid gap-3">
        {questionSet.description ? (
          <p className="text-sm text-muted-foreground">
            {questionSet.description}
          </p>
        ) : null}
        {questionSet.questions.map((question) => {
          const answer = response?.answers[question.id];
          const selected = (answer?.selectedOptionIds ?? []).map(
            (optionId) =>
              question.options?.find((option) => option.id === optionId)
                ?.label ?? optionId,
          );
          const values = [...selected, answer?.text, answer?.customText].filter(
            (value): value is string => Boolean(value),
          );
          return (
            <div key={question.id}>
              {question.header ? (
                <p className="text-xs font-medium text-muted-foreground">
                  {question.header}
                </p>
              ) : null}
              <p className="text-sm text-foreground">{question.prompt}</p>
              {question.helpText ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {question.helpText}
                </p>
              ) : null}
              <p className="mt-1 text-sm font-medium text-foreground">
                Answer: {values.length > 0 ? values.join(", ") : "No answer"}
              </p>
            </div>
          );
        })}
      </div>
    );
  } else if (interaction.kind === "request_checkbox_confirmation") {
    const selected = new Set(interaction.result?.selectedOptionIds ?? []);
    const selectedLabels = interaction.payload.options
      .filter((option) => selected.has(option.id))
      .map((option) => option.label);
    request = (
      <div>
        <p className="text-sm text-foreground">{interaction.payload.prompt}</p>
        {interaction.status === "accepted" ? (
          <p className="mt-1 text-sm font-medium text-foreground">
            Answer:{" "}
            {selectedLabels.length > 0
              ? selectedLabels.join(", ")
              : "No options selected"}
          </p>
        ) : null}
        {interaction.payload.detailsMarkdown ? (
          <div className="mt-2 text-sm">
            <MarkdownBody externalReferences={externalReferences}>
              {interaction.payload.detailsMarkdown}
            </MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  } else if (interaction.kind === "request_item_verdicts") {
    const verdicts = new Map(
      (interaction.result?.items ?? []).map((item) => [item.id, item]),
    );
    const decidedItems = interaction.payload.items.filter((item) =>
      verdicts.has(item.id),
    );
    request = (
      <div>
        <p className="text-sm text-foreground">{interaction.payload.prompt}</p>
        {decidedItems.length > 0 ? (
          <ul className="mt-2 grid gap-1 text-sm">
            {decidedItems.map((item) => {
              const verdict = verdicts.get(item.id);
              return (
                <li key={item.id}>
                  <span className="font-medium">{item.label}</span> ·{" "}
                  {verdict?.verdict}
                  {verdict?.reason ? ` — ${verdict.reason}` : ""}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1 text-sm font-medium text-foreground">
            No verdicts submitted
          </p>
        )}
        {interaction.payload.detailsMarkdown ? (
          <div className="mt-2 text-sm">
            <MarkdownBody externalReferences={externalReferences}>
              {interaction.payload.detailsMarkdown}
            </MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  } else if (interaction.kind === "suggest_tasks") {
    const created = new Set(
      interaction.result?.createdTasks?.map((task) => task.clientKey) ?? [],
    );
    const createdTasks = interaction.payload.tasks.filter((task) =>
      created.has(task.clientKey),
    );
    request = (
      <div>
        {createdTasks.length > 0 ? (
          <ul className="grid gap-1 text-sm">
            {createdTasks.map((task) => (
              <li key={task.clientKey} className="font-medium">
                {task.title}
              </li>
            ))}
          </ul>
        ) : interaction.status === "accepted" ? (
          <p className="text-sm font-medium text-foreground">
            No tasks created
          </p>
        ) : null}
      </div>
    );
  } else if (interaction.kind === "connection_intent") {
    request = (
      <p className="text-sm text-foreground">
        {interaction.payload.requestingAgentName} requested access to{" "}
        {interaction.payload.serviceName}.
      </p>
    );
  } else {
    request = (
      <div className="grid gap-2">
        <p className="text-sm text-foreground">{interaction.payload.prompt}</p>
        {interaction.payload.detailsMarkdown ? (
          <div className="text-sm">
            <MarkdownBody externalReferences={externalReferences}>
              {interaction.payload.detailsMarkdown}
            </MarkdownBody>
          </div>
        ) : null}
        {interaction.payload.toolAction ? (
          <div className="rounded-sm bg-muted/45 px-3 py-2.5 text-sm">
            <p>
              <strong>{interaction.payload.toolAction.toolDisplayName}</strong>{" "}
              · {interaction.payload.toolAction.risk} risk
            </p>
            <p className="mt-1">
              Expires{" "}
              {new Date(
                interaction.payload.toolAction.expiresAt,
              ).toLocaleString()}
            </p>
            <div className="mt-2">
              <MarkdownBody externalReferences={externalReferences}>
                {interaction.payload.toolAction.previewMarkdown}
              </MarkdownBody>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
              {interaction.payload.toolAction.argumentsSummaryJson}
            </pre>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {interaction.payload.toolAction.argumentsHash}
            </p>
          </div>
        ) : null}
        {interaction.payload.secretProposal ? (
          <dl className="grid gap-1 rounded-sm bg-muted/45 px-3 py-2.5 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Secret</dt>
              <dd>{interaction.payload.secretProposal.sourceSecretLabel}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Binding</dt>
              <dd className="font-mono text-xs">
                {interaction.payload.secretProposal.configPath} →{" "}
                {interaction.payload.secretProposal.targetAgentName}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Why</dt>
              <dd>{interaction.payload.secretProposal.justification}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd>
                {new Date(
                  interaction.payload.secretProposal.expiresAt,
                ).toLocaleString()}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    );
  }

  const detail = (
    <div
      className={
        compact
          ? "space-y-3 pb-3 pl-7 pr-1"
          : "mt-2 space-y-3 border-t border-border/60 pt-3"
      }
    >
      {request}
      {answerReason ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">Reason:</span> {answerReason}
        </p>
      ) : null}
    </div>
  );

  if (compact) {
    const Icon = KIND_COPY[interaction.kind].icon;
    const summary =
      interaction.kind === "ask_user_questions" &&
      interaction.status === "answered"
        ? "Questions answered"
        : buildIssueThreadInteractionSummary(interaction);
    return (
      <details
        className="group"
        data-testid={
          interaction.kind === "ask_user_questions" &&
          interaction.status === "answered"
            ? "task-chat-answered-questions-receipt"
            : "task-chat-interaction-receipt"
        }
      >
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1.5 text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span
            className="flex w-6 shrink-0 items-center justify-center"
            data-testid="task-chat-interaction-receipt-icon-slot"
          >
            <Icon
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              data-testid="task-chat-interaction-receipt-icon"
            />
          </span>
          <span>{summary}</span>
          <ChevronRight
            aria-hidden
            className="ml-auto h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover:opacity-70 group-focus-visible:opacity-70 group-open:rotate-90"
            data-testid="task-chat-interaction-receipt-caret"
          />
        </summary>
        {detail}
      </details>
    );
  }

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        View original request and resolution
      </summary>
      {detail}
    </details>
  );
}

function questionSetForInteraction(
  interaction: AskUserQuestionsInteraction,
): PaperclipQuestionSet {
  if (interaction.payload.questionSet) return interaction.payload.questionSet;
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel
      ? { submitLabel: interaction.payload.submitLabel }
      : {}),
    questions: interaction.payload.questions.map((question) => {
      const freeText = question.options.find(
        (option) => option.freeText === true,
      );
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode:
          question.selectionMode === "multi"
            ? ("multi_select" as const)
            : ("single_select" as const),
        options: question.options
          .filter((option) => option.freeText !== true)
          .map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        ...(freeText
          ? {
              customAnswer: {
                enabled: true as const,
                label: freeText.label,
                ...(freeText.description
                  ? { placeholder: freeText.description }
                  : {}),
              },
            }
          : {}),
      };
    }),
  };
}

function questionResponseForInteraction(
  interaction: AskUserQuestionsInteraction,
  questionSet: PaperclipQuestionSet,
): PaperclipQuestionResponse | null {
  if (!interaction.result?.answers) return null;
  return {
    schema: "paperclip.question_response.v1",
    answers: Object.fromEntries(
      interaction.result.answers.map((answer) => {
        const question = questionSet.questions.find(
          (candidate) => candidate.id === answer.questionId,
        );
        return [
          answer.questionId,
          question?.answerMode === "text"
            ? { ...(answer.otherText ? { text: answer.otherText } : {}) }
            : {
                selectedOptionIds: answer.optionIds,
                ...(answer.otherText ? { customText: answer.otherText } : {}),
              },
        ];
      }),
    ),
  };
}

function AskUserQuestionsCard({
  interaction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  errorMessage,
  draftKey,
  onUploadImage,
  mentions,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: SharedInteractionProps["onSubmitInteractionAnswers"];
  onCancelInteraction?: SharedInteractionProps["onCancelInteraction"];
  errorMessage: (error: unknown) => string;
  draftKey?: string;
  onUploadImage?: SharedInteractionProps["onUploadImage"];
  mentions?: MentionOption[];
}) {
  const questionSet = questionSetForInteraction(interaction);
  const initialResponse = questionResponseForInteraction(
    interaction,
    questionSet,
  );
  return (
    <QuestionForm
      id={interaction.id}
      questionSet={questionSet}
      initialResponse={initialResponse}
      implicitCustomAnswer={interaction.payload.questionSet === undefined}
      draftKey={draftKey}
      disabled={!onSubmitInteractionAnswers}
      imageUploadHandler={onUploadImage}
      mentions={mentions}
      onSubmit={async (response) => {
        const answers: AskUserQuestionsAnswer[] = questionSet.questions.map(
          (question) => {
            const answer = response.answers[question.id];
            const otherText =
              question.answerMode === "text"
                ? answer?.text?.trim()
                : answer?.customText?.trim();
            return {
              questionId: question.id,
              optionIds:
                question.answerMode === "text"
                  ? []
                  : (answer?.selectedOptionIds ?? []),
              ...(otherText ? { otherText } : {}),
            };
          },
        );
        try {
          await onSubmitInteractionAnswers?.(interaction, answers);
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      }}
      onCancel={
        onCancelInteraction
          ? async () => {
              try {
                await onCancelInteraction(interaction);
              } catch (error) {
                throw new Error(errorMessage(error));
              }
            }
          : undefined
      }
    />
  );
}

function ConfirmationCard({
  interaction,
  planDocument,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
  errorMessage,
  draftKey,
  showPlanPreview,
  onUploadImage,
  mentions,
}: {
  interaction: RequestConfirmationInteraction;
  planDocument?: IssueDocument | null;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
  draftKey?: string;
  showPlanPreview: boolean;
  onUploadImage?: SharedInteractionProps["onUploadImage"];
  mentions?: MentionOption[];
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(() =>
    draftKey ? loadStructuredDraft(draftKey, "") : "",
  );
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revisionUploading, setRevisionUploading] = useState(false);
  const collectsRejectReason = Boolean(
    interaction.payload.rejectRequiresReason ||
    interaction.payload.allowDeclineReason ||
    interaction.payload.declineReasonPlaceholder,
  );
  const isPlanConfirmation =
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan";
  useEffect(() => {
    if (draftKey) saveStructuredDraft(draftKey, reason);
  }, [draftKey, reason]);
  async function resolve(action: "accept" | "reject") {
    if (
      action === "reject" &&
      interaction.payload.rejectRequiresReason &&
      !reason.trim()
    )
      return;
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept") await onAcceptInteraction?.(interaction);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
      if (draftKey) clearDraft(draftKey);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      {isPlanConfirmation && showPlanPreview ? (
        <PlanReviewPreview
          interaction={interaction}
          planDocument={planDocument}
        />
      ) : isPlanConfirmation && rejecting ? null : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm leading-5 text-foreground">
            {isPlanConfirmation
              ? "Do you accept this plan?"
              : interaction.payload.prompt}
          </p>
          {!isPlanConfirmation ? (
            <CompactTarget interaction={interaction} />
          ) : null}
        </div>
      )}
      {!isPlanConfirmation && interaction.payload.detailsMarkdown ? (
        <Details>
          <MarkdownBody externalReferences={externalReferences}>
            {interaction.payload.detailsMarkdown}
          </MarkdownBody>
        </Details>
      ) : null}
      {interaction.payload.toolAction ? (
        <div className="mt-3 space-y-2 rounded-sm bg-muted/45 px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{interaction.payload.toolAction.toolDisplayName}</strong>
            <span
              className={cn(
                "text-xs font-medium capitalize",
                interaction.payload.toolAction.risk === "destructive"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {interaction.payload.toolAction.risk} risk
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              Expires{" "}
              {new Date(
                interaction.payload.toolAction.expiresAt,
              ).toLocaleString()}
            </span>
          </div>
          <MarkdownBody externalReferences={externalReferences}>
            {interaction.payload.toolAction.previewMarkdown}
          </MarkdownBody>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Arguments and audit hash
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {interaction.payload.toolAction.argumentsSummaryJson}
            </pre>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {interaction.payload.toolAction.argumentsHash}
            </p>
          </details>
        </div>
      ) : null}
      {interaction.payload.secretProposal ? (
        <dl className="mt-3 grid gap-2 rounded-sm bg-muted/45 px-3 py-2.5 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Secret</dt>
            <dd>{interaction.payload.secretProposal.sourceSecretLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Binding</dt>
            <dd className="font-mono text-xs">
              {interaction.payload.secretProposal.configPath} →{" "}
              {interaction.payload.secretProposal.targetAgentName}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Why</dt>
            <dd>{interaction.payload.secretProposal.justification}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Expires</dt>
            <dd>
              {new Date(
                interaction.payload.secretProposal.expiresAt,
              ).toLocaleString()}
            </dd>
          </div>
        </dl>
      ) : null}
      {rejecting ? (
        <div className={cn("space-y-2", !isPlanConfirmation && "mt-3")}>
          <p
            id={`${interaction.id}-reject-reason-label`}
            className="text-xs font-medium leading-4 text-foreground"
          >
            {interaction.payload.rejectReasonLabel ?? "What should change?"}
            {interaction.payload.rejectRequiresReason ? "" : " (optional)"}
          </p>
          {isPlanConfirmation ? (
            <TaskChatRichInput
              value={reason}
              onChange={setReason}
              placeholder={
                interaction.payload.declineReasonPlaceholder ??
                "Describe what should change"
              }
              imageUploadHandler={onUploadImage}
              mentions={mentions}
              disabled={working !== null}
              autoFocus
              onUploadingChange={setRevisionUploading}
              onSubmit={() => {
                if (!revisionUploading) void resolve("reject");
              }}
              ariaLabelledBy={`${interaction.id}-reject-reason-label`}
              testId="plan-revision-composer"
              showImageAttachControls={false}
            />
          ) : (
            <Textarea
              id={`${interaction.id}-reject-reason`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                interaction.payload.declineReasonPlaceholder ??
                "Add a short note"
              }
              className={TAKEOVER_TEXTAREA_CLASS}
              autoFocus
            />
          )}
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow>
        {rejecting ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => {
                setRejecting(false);
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                working !== null ||
                revisionUploading ||
                (Boolean(interaction.payload.rejectRequiresReason) &&
                  !reason.trim()) ||
                !onRejectInteraction
              }
              onClick={() => void resolve("reject")}
            >
              {working === "reject" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {interaction.payload.rejectLabel ?? "Reject"}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null || !onRejectInteraction}
              onClick={() =>
                collectsRejectReason
                  ? setRejecting(true)
                  : void resolve("reject")
              }
            >
              {interaction.payload.rejectLabel ?? "Reject"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={working !== null || !onAcceptInteraction}
              onClick={() => void resolve("accept")}
            >
              {working === "accept" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {interaction.payload.acceptLabel ?? "Approve"}
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

function CheckboxConfirmationCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
  errorMessage,
  draftKey,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
  draftKey?: string;
}) {
  const restored = draftKey
    ? loadStructuredDraft<{ selected: string[]; reason: string }>(draftKey, {
        selected: interaction.payload.defaultSelectedOptionIds ?? [],
        reason: "",
      })
    : null;
  const [selected, setSelected] = useState(
    () =>
      new Set(
        restored?.selected ??
          interaction.payload.defaultSelectedOptionIds ??
          [],
      ),
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [filter, setFilter] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const collectsRejectReason = Boolean(
    interaction.payload.rejectRequiresReason ||
    interaction.payload.allowDeclineReason ||
    interaction.payload.declineReasonPlaceholder,
  );
  const minimum = interaction.payload.minSelected ?? 0;
  const maximum = interaction.payload.maxSelected ?? Number.POSITIVE_INFINITY;
  const validCount = selected.size >= minimum && selected.size <= maximum;
  const visibleOptions = interaction.payload.options.filter((option) => {
    const query = filter.trim().toLowerCase();
    return (
      !query ||
      option.label.toLowerCase().includes(query) ||
      option.description?.toLowerCase().includes(query)
    );
  });
  useEffect(() => {
    if (draftKey)
      saveStructuredDraft(draftKey, { selected: [...selected], reason });
  }, [draftKey, reason, selected]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < maximum) next.add(id);
      return next;
    });
  }

  async function resolve(action: "accept" | "reject") {
    if (action === "accept" && !validCount) return;
    if (
      action === "reject" &&
      interaction.payload.rejectRequiresReason &&
      !reason.trim()
    )
      return;
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept")
        await onAcceptInteraction?.(interaction, undefined, [...selected]);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
      if (draftKey) clearDraft(draftKey);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  const countHint =
    maximum < Number.POSITIVE_INFINITY
      ? `${selected.size} selected · choose ${minimum}–${maximum}`
      : minimum > 0
        ? `${selected.size} selected · at least ${minimum}`
        : `${selected.size} selected`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-5 text-foreground">
          {interaction.payload.prompt}
        </p>
        <CompactTarget interaction={interaction} />
      </div>
      <div
        className="mt-3 grid gap-1"
        role="group"
        aria-label={interaction.payload.prompt}
      >
        {interaction.payload.options.length > 10 ? (
          <label className="relative mb-1 block">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter options"
              aria-label="Filter options"
              className="pl-8"
            />
          </label>
        ) : null}
        {visibleOptions.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50"
          >
            <Checkbox
              checked={selected.has(option.id)}
              onCheckedChange={() => toggle(option.id)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm leading-5 text-foreground">
                {option.label}
              </span>
              {option.description ? (
                <span className="block text-xs leading-4 text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {interaction.payload.detailsMarkdown ? (
        <Details>
          <MarkdownBody externalReferences={externalReferences}>
            {interaction.payload.detailsMarkdown}
          </MarkdownBody>
        </Details>
      ) : null}
      {rejecting ? (
        <div className="mt-3 space-y-1.5">
          <label
            htmlFor={`${interaction.id}-reject-reason`}
            className="text-xs font-medium text-foreground"
          >
            {interaction.payload.rejectReasonLabel ?? "What should change?"}
            {interaction.payload.rejectRequiresReason ? "" : " (optional)"}
          </label>
          <Textarea
            id={`${interaction.id}-reject-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              interaction.payload.declineReasonPlaceholder ?? "Add a short note"
            }
            className={TAKEOVER_TEXTAREA_CLASS}
            autoFocus
          />
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow hint={countHint}>
        {rejecting ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => setRejecting(false)}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                working !== null ||
                (Boolean(interaction.payload.rejectRequiresReason) &&
                  !reason.trim()) ||
                !onRejectInteraction
              }
              onClick={() => void resolve("reject")}
            >
              {working === "reject" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {interaction.payload.rejectLabel ?? "Decline"}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null || !onRejectInteraction}
              onClick={() =>
                collectsRejectReason
                  ? setRejecting(true)
                  : void resolve("reject")
              }
            >
              {interaction.payload.rejectLabel ?? "Decline"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={working !== null || !validCount || !onAcceptInteraction}
              onClick={() => void resolve("accept")}
            >
              {working === "accept" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {interaction.payload.acceptLabel ?? "Confirm selection"}
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

function SuggestedTaskRow({
  node,
  selected,
  onToggle,
}: {
  node: SuggestedTaskTreeNode;
  selected: Set<string>;
  onToggle: (node: SuggestedTaskTreeNode) => void;
}) {
  if (node.task.hiddenInPreview) return null;
  const hiddenCount = collectSuggestedTaskClientKeys(node).filter(
    (key) =>
      key !== node.task.clientKey &&
      node.children.some(
        (child) => child.task.clientKey === key && child.task.hiddenInPreview,
      ),
  ).length;
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50">
        <Checkbox
          checked={selected.has(node.task.clientKey)}
          onCheckedChange={() => onToggle(node)}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-5 text-foreground">
            {node.task.title}
          </span>
          {hiddenCount > 0 ? (
            <span className="block text-xs text-muted-foreground">
              + {hiddenCount} hidden follow-up
            </span>
          ) : null}
        </span>
      </label>
      {node.children.length > 0 ? (
        <ul className="ml-4 border-l border-border/80 pl-2">
          {node.children.map((child) => (
            <SuggestedTaskRow
              key={child.task.clientKey}
              node={child}
              selected={selected}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SuggestedTasksCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  errorMessage,
  draftKey,
}: {
  interaction: SuggestTasksInteraction;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  errorMessage: (error: unknown) => string;
  draftKey?: string;
}) {
  const roots = useMemo(
    () => buildSuggestedTaskTree(interaction.payload.tasks),
    [interaction.payload.tasks],
  );
  const taskByKey = useMemo(
    () =>
      new Map(interaction.payload.tasks.map((task) => [task.clientKey, task])),
    [interaction.payload.tasks],
  );
  const restored = draftKey
    ? loadStructuredDraft<{ selected: string[]; reason: string }>(draftKey, {
        selected: interaction.payload.tasks.map((task) => task.clientKey),
        reason: "",
      })
    : null;
  const [selected, setSelected] = useState(
    () =>
      new Set(
        restored?.selected ??
          interaction.payload.tasks.map((task) => task.clientKey),
      ),
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [filter, setFilter] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (draftKey)
      saveStructuredDraft(draftKey, { selected: [...selected], reason });
  }, [draftKey, reason, selected]);
  const visibleRoots = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return roots;
    function retain(node: SuggestedTaskTreeNode): SuggestedTaskTreeNode | null {
      const children = node.children
        .map(retain)
        .filter((child): child is SuggestedTaskTreeNode => child !== null);
      const matches =
        node.task.title.toLowerCase().includes(query) ||
        node.task.description?.toLowerCase().includes(query);
      return matches || children.length > 0 ? { ...node, children } : null;
    }
    return roots
      .map(retain)
      .filter((node): node is SuggestedTaskTreeNode => node !== null);
  }, [filter, roots]);

  function toggle(node: SuggestedTaskTreeNode) {
    setSelected((current) => {
      const next = new Set(current);
      const subtree = collectSuggestedTaskClientKeys(node);
      if (next.has(node.task.clientKey))
        subtree.forEach((key) => next.delete(key));
      else {
        subtree.forEach((key) => next.add(key));
        let parentKey = node.task.parentClientKey;
        while (parentKey) {
          next.add(parentKey);
          parentKey = taskByKey.get(parentKey)?.parentClientKey;
        }
      }
      return next;
    });
  }

  async function resolve(action: "accept" | "reject") {
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept")
        await onAcceptInteraction?.(interaction, [...selected]);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
      if (draftKey) clearDraft(draftKey);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      <p className="text-sm leading-5 text-foreground">
        Select the tasks to create.
      </p>
      {interaction.payload.tasks.length > 10 ? (
        <label className="relative mt-3 block">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter suggested tasks"
            aria-label="Filter suggested tasks"
            className="pl-8"
          />
        </label>
      ) : null}
      <ul
        className="mt-2 max-h-(--sz-28dvh) overflow-y-auto scrollbar-auto-hide"
        aria-label="Suggested tasks"
      >
        {visibleRoots.map((node) => (
          <SuggestedTaskRow
            key={node.task.clientKey}
            node={node}
            selected={selected}
            onToggle={toggle}
          />
        ))}
      </ul>
      {rejecting ? (
        <div className="mt-3 space-y-1.5">
          <label
            htmlFor={`${interaction.id}-reject-reason`}
            className="text-xs font-medium text-foreground"
          >
            Why should these tasks change? (optional)
          </label>
          <Textarea
            id={`${interaction.id}-reject-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Add a short note"
            className={TAKEOVER_TEXTAREA_CLASS}
            autoFocus
          />
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow
        hint={`${selected.size} of ${interaction.payload.tasks.length} selected`}
      >
        {rejecting ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => setRejecting(false)}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={working !== null || !onRejectInteraction}
              onClick={() => void resolve("reject")}
            >
              {working === "reject" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              Send back
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working !== null || !onRejectInteraction}
              onClick={() => setRejecting(true)}
            >
              Revise
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                working !== null || selected.size === 0 || !onAcceptInteraction
              }
              onClick={() => void resolve("accept")}
            >
              {working === "accept" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              Create selected
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

type VerdictDraft = {
  verdict: RequestItemVerdictValue;
  reason: string;
  confirmed?: boolean;
};

function ItemVerdictsCard({
  interaction,
  onSubmitInteractionVerdicts,
  externalReferences,
  errorMessage,
  draftKey,
}: {
  interaction: RequestItemVerdictsInteraction;
  onSubmitInteractionVerdicts?: SharedInteractionProps["onSubmitInteractionVerdicts"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
  draftKey?: string;
}) {
  const takeoverActions = useTaskChatComposerTakeoverActions();
  const items = interaction.payload.items;
  const resolvedById = useMemo(
    () =>
      new Map((interaction.result?.items ?? []).map((item) => [item.id, item])),
    [interaction.result],
  );
  const firstPendingIndex = Math.max(
    items.findIndex((item) => !resolvedById.has(item.id)),
    0,
  );
  const restored = draftKey
    ? loadStructuredDraft<{
        page: number;
        drafts: Array<[string, VerdictDraft]>;
      }>(draftKey, { page: firstPendingIndex, drafts: [] })
    : null;
  const [page, setPage] = useState(restored?.page ?? firstPendingIndex);
  const [drafts, setDrafts] = useState<Map<string, VerdictDraft>>(
    () => new Map(restored?.drafts ?? []),
  );
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const enabledVerdicts = interaction.payload.verdicts ?? ["approve", "reject"];
  const requireReasonOn = new Set(
    interaction.payload.requireReasonOn ?? ["reject"],
  );

  useEffect(
    () =>
      setPage((current) => Math.min(current, Math.max(items.length - 1, 0))),
    [items.length],
  );
  useEffect(() => {
    setDrafts((current) => {
      const next = new Map(current);
      let changed = false;
      for (const id of resolvedById.keys()) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : current;
    });
    const nextPending = items.findIndex(
      (candidate) => !resolvedById.has(candidate.id),
    );
    if (nextPending >= 0) setPage(nextPending);
  }, [items, resolvedById]);
  useEffect(() => {
    if (draftKey) saveStructuredDraft(draftKey, { page, drafts: [...drafts] });
  }, [draftKey, drafts, page]);
  const item = items[page];
  if (!item)
    return (
      <p className="text-sm text-muted-foreground">
        No review items were provided.
      </p>
    );
  const resolved = resolvedById.get(item.id);
  const draft = drafts.get(item.id);
  const itemHref = item.href
    ? normalizeRequestConfirmationTargetHref(item.href)
    : null;
  const rejectionNeedsConfirmation = Boolean(
    !resolved &&
    draft &&
    requireReasonOn.has(draft.verdict) &&
    (!draft.reason.trim() || draft.confirmed === false),
  );

  function advance() {
    setPage((current) => Math.min(current + 1, items.length - 1));
  }

  function setVerdict(verdict: RequestItemVerdictValue) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(item.id);
      next.set(item.id, {
        verdict,
        reason: existing?.verdict === verdict ? existing.reason : "",
        confirmed: !requireReasonOn.has(verdict),
      });
      return next;
    });
    if (!requireReasonOn.has(verdict)) advance();
  }

  function setReason(reason: string) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(item.id);
      if (existing)
        next.set(item.id, { ...existing, reason, confirmed: false });
      return next;
    });
  }

  function confirmRejectionReason() {
    if (!draft?.reason.trim()) return;
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(item.id);
      if (existing) next.set(item.id, { ...existing, confirmed: true });
      return next;
    });
    advance();
  }

  async function submit() {
    if (!onSubmitInteractionVerdicts) return;
    const verdicts = [...drafts].map(([id, value]) => ({
      id,
      verdict: value.verdict,
      ...(value.reason.trim() ? { reason: value.reason.trim() } : {}),
    }));
    if (
      verdicts.length === 0 ||
      verdicts.some(
        (entry) => requireReasonOn.has(entry.verdict) && !entry.reason,
      )
    )
      return;
    setWorking(true);
    setActionError(null);
    try {
      await onSubmitInteractionVerdicts(interaction, verdicts);
      if (draftKey) clearDraft(draftKey);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const allDraftsValid =
    drafts.size > 0 &&
    [...drafts.values()].every(
      (candidate) =>
        !requireReasonOn.has(candidate.verdict) ||
        Boolean(candidate.reason.trim() && candidate.confirmed !== false),
    );

  return (
    <div>
      <div className="mb-2 flex items-center text-xs text-muted-foreground">
        <span>{drafts.size + resolvedById.size} decided</span>
        <TaskChatComposerTakeoverControls>
          <nav
            className="flex shrink-0 items-center gap-1"
            aria-label="Item pagination"
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Previous item"
              disabled={working || page === 0}
              onClick={() => setPage((current) => current - 1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="min-w-10 text-center tabular-nums">
              {page + 1} of {items.length}
            </span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Next item"
              disabled={
                working ||
                page === items.length - 1 ||
                rejectionNeedsConfirmation
              }
              onClick={() => setPage((current) => current + 1)}
            >
              <ChevronRight aria-hidden />
            </Button>
          </nav>
        </TaskChatComposerTakeoverControls>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5 text-foreground">
            {item.label}
          </p>
          {item.description ? (
            <p className="text-xs leading-4 text-muted-foreground">
              {item.description}
            </p>
          ) : null}
        </div>
        {itemHref ? (
          <a
            href={itemHref}
            className="text-xs font-medium text-primary hover:underline"
          >
            Open
          </a>
        ) : null}
      </div>
      {item.previewMarkdown ? (
        <div className="mt-2 rounded-sm bg-muted/40 px-2.5 py-2 text-xs">
          <MarkdownBody externalReferences={externalReferences}>
            {item.previewMarkdown}
          </MarkdownBody>
        </div>
      ) : null}
      {resolved ? (
        <p className="mt-3 inline-flex rounded-sm border border-border px-2 py-1 text-xs capitalize text-muted-foreground">
          {resolved.verdict}
          {resolved.reason ? ` · ${resolved.reason}` : ""}
        </p>
      ) : (
        <div
          className="mt-3 flex flex-wrap gap-1.5"
          role="group"
          aria-label={`Verdict for ${item.label}`}
        >
          {enabledVerdicts.map((verdict) => (
            <Button
              key={verdict}
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={draft?.verdict === verdict}
              onClick={() => setVerdict(verdict)}
              className={cn(
                "min-w-24 justify-center capitalize",
                verdict === "approve" &&
                  (draft?.verdict === verdict
                    ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                    : "border-emerald-500/35 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"),
                verdict === "reject" &&
                  (draft?.verdict === verdict
                    ? "border-destructive/60 bg-destructive/15 text-destructive hover:bg-destructive/20"
                    : "border-destructive/35 text-destructive hover:bg-destructive/10"),
              )}
            >
              {verdict === "approve" ? (
                <Check aria-hidden className="h-4 w-4" />
              ) : null}
              {verdict === "reject" ? (
                <X aria-hidden className="h-4 w-4" />
              ) : null}
              {verdict}
            </Button>
          ))}
        </div>
      )}
      {!resolved && draft && requireReasonOn.has(draft.verdict) ? (
        <div className="mt-2 space-y-1.5">
          <label
            htmlFor={`${interaction.id}-${item.id}-reason`}
            className="text-xs font-medium text-foreground"
          >
            {interaction.payload.reasonLabel ?? "Reason"}
          </label>
          <Textarea
            id={`${interaction.id}-${item.id}-reason`}
            value={draft.reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Add a short reason"
            className={TAKEOVER_TEXTAREA_CLASS}
            autoFocus
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!draft.reason.trim() || working}
              onClick={confirmRejectionReason}
            >
              Submit rejection reason
            </Button>
          </div>
        </div>
      ) : null}
      {interaction.payload.detailsMarkdown ? (
        <Details>
          <MarkdownBody externalReferences={externalReferences}>
            {interaction.payload.detailsMarkdown}
          </MarkdownBody>
        </Details>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow>
        {takeoverActions?.skipButton}
        <Button
          type="button"
          size="sm"
          disabled={!allDraftsValid || working || !onSubmitInteractionVerdicts}
          onClick={() => void submit()}
        >
          {working ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : null}
          {drafts.size > 0 ? `Apply ${drafts.size}` : "Apply decisions"}
        </Button>
      </ActionRow>
    </div>
  );
}

export function TaskChatCompactInteractionCard({
  interaction,
  planDocument,
  showPlanPreview = true,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onSubmitInteractionVerdicts,
  onUploadImage,
  externalReferences,
  presentation = "timeline",
  draftKey,
  mentions,
}: TaskChatCompactInteractionCardProps) {
  const creatorLabel = interaction.createdByAgentId
    ? agentMap?.get(interaction.createdByAgentId)?.name
    : interaction.createdByUserId
      ? interaction.createdByUserId === currentUserId
        ? "You"
        : userLabelMap?.get(interaction.createdByUserId)
      : null;
  const addresseeLabel = interaction.addresseeAgentId
    ? agentMap?.get(interaction.addresseeAgentId)?.name
    : interaction.addresseeUserId
      ? interaction.addresseeUserId === currentUserId
        ? "You"
        : (userLabelMap?.get(interaction.addresseeUserId) ??
          interaction.addresseeUserId)
      : null;
  const audience = describeInteractionAudience({
    interaction,
    creatorLabel,
    addresseeLabel,
  });
  const errorMessage = (error: unknown) =>
    interactionResolutionErrorMessage(error, audience);
  const audienceLabel =
    interaction.status === "pending" && !audience.isOpen
      ? audience.shortSummary
      : null;
  const isResolvedPlanReview =
    showPlanPreview &&
    interaction.status !== "pending" &&
    interaction.kind === "request_confirmation" &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan";

  if (interaction.kind === "connection_intent") {
    return (
      <InteractionShell
        interaction={interaction}
        audienceLabel={audienceLabel}
        presentation={presentation}
      >
        <ConnectionIntentInteractionBody
          interaction={interaction}
          currentUserId={currentUserId}
          addresseeLabel={addresseeLabel ?? "the addressed user"}
        />
      </InteractionShell>
    );
  }

  if (presentation === "timeline" && interaction.status !== "pending") {
    return (
      <>
        {isResolvedPlanReview ? (
          <div className="mb-2">
            <PlanReviewPreview
              interaction={interaction}
              planDocument={planDocument}
            />
          </div>
        ) : null}
        <ReceiptDisclosure
          interaction={interaction}
          externalReferences={externalReferences}
          compact
        />
      </>
    );
  }

  return (
    <InteractionShell
      interaction={interaction}
      audienceLabel={audienceLabel}
      presentation={presentation}
    >
      {interaction.status !== "pending" ? (
        <ReceiptDisclosure
          interaction={interaction}
          externalReferences={externalReferences}
        />
      ) : interaction.kind === "ask_user_questions" ? (
        <AskUserQuestionsCard
          interaction={interaction}
          onSubmitInteractionAnswers={onSubmitInteractionAnswers}
          onCancelInteraction={
            presentation === "timeline" ? onCancelInteraction : undefined
          }
          errorMessage={errorMessage}
          draftKey={draftKey}
          onUploadImage={onUploadImage}
          mentions={mentions}
        />
      ) : interaction.kind === "request_confirmation" ? (
        <ConfirmationCard
          interaction={interaction}
          planDocument={planDocument}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          externalReferences={externalReferences}
          errorMessage={errorMessage}
          draftKey={draftKey}
          showPlanPreview={showPlanPreview && presentation === "timeline"}
          onUploadImage={onUploadImage}
          mentions={mentions}
        />
      ) : interaction.kind === "request_checkbox_confirmation" ? (
        <CheckboxConfirmationCard
          interaction={interaction}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          externalReferences={externalReferences}
          errorMessage={errorMessage}
          draftKey={draftKey}
        />
      ) : interaction.kind === "suggest_tasks" ? (
        <SuggestedTasksCard
          interaction={interaction}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          errorMessage={errorMessage}
          draftKey={draftKey}
        />
      ) : (
        <ItemVerdictsCard
          interaction={interaction}
          onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
          externalReferences={externalReferences}
          errorMessage={errorMessage}
          draftKey={draftKey}
        />
      )}
    </InteractionShell>
  );
}
