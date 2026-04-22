import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, GitBranch, ListChecks, Loader2, MessageSquareQuote, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { formatAssigneeUserLabel } from "../lib/assignees";
import {
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getQuestionAnswerLabels,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestConfirmationInteraction,
  type RequestConfirmationTarget,
  type SuggestTasksInteraction,
  type SuggestTasksResultCreatedTask,
  type SuggestedTaskDraft,
  type SuggestedTaskTreeNode,
} from "../lib/issue-thread-interactions";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { PriorityIcon } from "./PriorityIcon";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface IssueThreadInteractionCardProps {
  interaction: IssueThreadInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction | RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
}

function resolveActorLabel(args: {
  agentId?: string | null;
  userId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { agentId, userId, agentMap, currentUserId, userLabelMap } = args;
  if (agentId) {
    return agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
  }
  if (userId) {
    return formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ?? "Board";
  }
  return "Unknown";
}

function statusLabel(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "pending":
      return "Pending";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    case "answered":
      return "Answered";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function interactionKindLabel(kind: IssueThreadInteraction["kind"]) {
  switch (kind) {
    case "suggest_tasks":
      return "Suggested tasks";
    case "ask_user_questions":
      return "Ask user questions";
    case "request_confirmation":
      return "Confirmation";
    default:
      return kind;
  }
}

function statusIcon(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return CheckCircle2;
    case "rejected":
    case "failed":
      return XCircle;
    case "expired":
      return AlertTriangle;
    default:
      return CircleDashed;
  }
}

function statusClasses(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return {
        shell: "border-emerald-400/70 bg-transparent",
        badge: "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100",
      };
    case "rejected":
      return {
        shell: "border-rose-400/70 bg-transparent",
        badge: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
      };
    case "failed":
    case "expired":
      return {
        shell: "border-amber-400/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
      };
    default:
      return {
        shell: "border-sky-500/70 bg-transparent",
        badge: "border-sky-500/70 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
      };
  }
}

function TaskField({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "subtle";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]",
        tone === "default"
          ? "border-border/70 bg-transparent text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground",
      )}
    >
      {label}: {value}
    </span>
  );
}

function createdTaskMap(
  createdTasks: readonly SuggestTasksResultCreatedTask[] | undefined,
) {
  return new Map(
    (createdTasks ?? []).map((entry) => [entry.clientKey, entry] as const),
  );
}

function TaskTreeNode({
  node,
  createdByClientKey,
  agentMap,
  currentUserId,
  userLabelMap,
  depth = 0,
  selectedClientKeys,
  skippedClientKeys,
  showSelection,
  onToggleSelection,
}: {
  node: SuggestedTaskTreeNode;
  createdByClientKey: ReadonlyMap<string, SuggestTasksResultCreatedTask>;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  depth?: number;
  selectedClientKeys?: ReadonlySet<string>;
  skippedClientKeys?: ReadonlySet<string>;
  showSelection?: boolean;
  onToggleSelection?: (node: SuggestedTaskTreeNode, checked: boolean) => void;
}) {
  const visibleChildren = node.children.filter((child) => !child.task.hiddenInPreview);
  const hiddenChildCount = node.children
    .filter((child) => child.task.hiddenInPreview)
    .reduce((sum, child) => sum + countSuggestedTaskNodes(child), 0);
  const createdTask = createdByClientKey.get(node.task.clientKey);
  const isSelected = selectedClientKeys?.has(node.task.clientKey) ?? false;
  const isSkipped = skippedClientKeys?.has(node.task.clientKey) ?? false;
  const assigneeLabel = resolveActorLabel({
    agentId: node.task.assigneeAgentId,
    userId: node.task.assigneeUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const hasExplicitAssignee = Boolean(
    node.task.assigneeAgentId || node.task.assigneeUserId,
  );
  const labels = node.task.labels ?? [];
  const hasMetadata = hasExplicitAssignee
    || Boolean(node.task.billingCode)
    || Boolean(node.task.projectId)
    || labels.length > 0;

  return (
    <>
      <div
        className={cn(
          "relative border-b border-border/60 px-3 py-2.5 last:border-b-0",
          depth > 0 && "before:absolute before:left-3 before:top-0 before:h-full before:w-px before:bg-border/70",
        )}
        style={depth > 0 ? { paddingLeft: `${depth * 24 + 12}px` } : undefined}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              {showSelection ? (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(checked) => onToggleSelection?.(node, checked === true)}
                  aria-label={`Include ${node.task.title}`}
                  className="mt-0.5"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  {node.task.priority ? (
                    <PriorityIcon
                      priority={node.task.priority}
                      className="mt-px"
                    />
                  ) : null}
                  <div className="min-w-0 truncate text-sm font-medium text-foreground">
                    {node.task.title}
                  </div>
                </div>
                {depth > 0 ? (
                  <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Child task
                  </div>
                ) : null}
                {node.task.description ? (
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                    {node.task.description}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {createdTask?.issueId ? (
            <Link
              to={`/issues/${createdTask.identifier ?? createdTask.issueId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-900 transition-colors hover:bg-emerald-500/15 dark:text-emerald-100"
            >
              {createdTask.identifier ?? createdTask.issueId.slice(0, 8)}
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : isSkipped ? (
            <span className="inline-flex shrink-0 items-center rounded-sm border border-amber-500/60 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-900 dark:text-amber-100">
              Skipped
            </span>
          ) : null}
        </div>

        {hasMetadata ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasExplicitAssignee ? (
              <TaskField label="Assignee" value={assigneeLabel} />
            ) : null}
            {node.task.billingCode ? (
              <TaskField label="Billing" value={node.task.billingCode} />
            ) : null}
            {node.task.projectId ? (
              <TaskField label="Project" value={node.task.projectId} tone="subtle" />
            ) : null}
            {labels.map((label) => (
              <TaskField key={label} label="Label" value={label} tone="subtle" />
            ))}
          </div>
        ) : null}

        {hiddenChildCount > 0 ? (
          <div className="mt-2 flex items-center gap-2 rounded-sm border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>
              {hiddenChildCount === 1
                ? "1 follow-on task hidden in preview"
                : `${hiddenChildCount} follow-on tasks hidden in preview`}
            </span>
          </div>
        ) : null}
      </div>

      {visibleChildren.length > 0 ? (
        <>
          {visibleChildren.map((child) => (
            <TaskTreeNode
              key={child.task.clientKey}
              node={child}
              createdByClientKey={createdByClientKey}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              depth={depth + 1}
              selectedClientKeys={selectedClientKeys}
              skippedClientKeys={skippedClientKeys}
              showSelection={showSelection}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function SuggestTasksCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: SuggestTasksInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(
    interaction.result?.rejectionReason ?? "",
  );

  useEffect(() => {
    setRejectReason(interaction.result?.rejectionReason ?? "");
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.result?.rejectionReason, interaction.status]);

  const roots = useMemo(
    () =>
      buildSuggestedTaskTree(interaction.payload.tasks).filter(
        (node) => !node.task.hiddenInPreview,
      ),
    [interaction.payload.tasks],
  );
  const createdByClientKey = useMemo(
    () => createdTaskMap(interaction.result?.createdTasks),
    [interaction.result?.createdTasks],
  );
  const skippedClientKeys = useMemo(
    () => new Set(interaction.result?.skippedClientKeys ?? []),
    [interaction.result?.skippedClientKeys],
  );
  const totalTasks = interaction.payload.tasks.length;
  const [selectedClientKeys, setSelectedClientKeys] = useState<Set<string>>(
    () => new Set(interaction.payload.tasks.map((task) => task.clientKey)),
  );
  const taskSelectionSeed = useMemo(
    () => interaction.payload.tasks.map((task) => task.clientKey).join("\n"),
    [interaction.payload.tasks],
  );

  useEffect(() => {
    setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)));
  }, [interaction.id, interaction.status, taskSelectionSeed]);

  const taskByClientKey = useMemo(
    () => new Map(interaction.payload.tasks.map((task) => [task.clientKey, task] as const)),
    [interaction.payload.tasks],
  );
  const selectedCount = selectedClientKeys.size;
  const createdCount = interaction.result?.createdTasks?.length ?? 0;
  const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    try {
      await onAcceptInteraction(interaction, [...selectedClientKeys]);
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    if (!onRejectInteraction) return;
    setWorking("reject");
    try {
      await onRejectInteraction(interaction, rejectReason.trim() || undefined);
      setRejecting(false);
    } finally {
      setWorking(null);
    }
  }

  function handleToggleSelection(node: SuggestedTaskTreeNode, checked: boolean) {
    const subtreeClientKeys = collectSuggestedTaskClientKeys(node);
    setSelectedClientKeys((current) => {
      const next = new Set(current);
      if (!checked) {
        for (const clientKey of subtreeClientKeys) {
          next.delete(clientKey);
        }
        return next;
      }

      for (const clientKey of subtreeClientKeys) {
        next.add(clientKey);
      }

      let parentClientKey = taskByClientKey.get(node.task.clientKey)?.parentClientKey ?? null;
      while (parentClientKey) {
        next.add(parentClientKey);
        parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{totalTasks === 1 ? "1 draft issue" : `${totalTasks} draft issues`}</span>
        {interaction.payload.defaultParentId ? (
          <TaskField label="Default parent" value={interaction.payload.defaultParentId} tone="subtle" />
        ) : null}
      </div>

      <div className="overflow-hidden border border-border/70">
        {roots.map((root) => (
          <TaskTreeNode
            key={root.task.clientKey}
            node={root}
            createdByClientKey={createdByClientKey}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            selectedClientKeys={selectedClientKeys}
            skippedClientKeys={skippedClientKeys}
            showSelection={interaction.status === "pending"}
            onToggleSelection={handleToggleSelection}
          />
        ))}
      </div>

      {interaction.status === "accepted" ? (
        <div className="rounded-sm border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
            Resolution summary
          </div>
          <p className="mt-1 leading-6">
            {skippedCount > 0
              ? `Created ${createdCount} draft ${createdCount === 1 ? "issue" : "issues"} and skipped ${skippedCount} during review.`
              : `Created all ${createdCount} draft ${createdCount === 1 ? "issue" : "issues"}.`}
          </p>
        </div>
      ) : null}

      {interaction.status === "rejected" ? (
        <div className="rounded-sm border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700">
            Rejection reason
          </div>
          <p className={cn(
            "mt-1 leading-6",
            !interaction.result?.rejectionReason && "text-rose-900/75",
          )}>
            {interaction.result?.rejectionReason || "No reason provided."}
          </p>
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selectedCount === totalTasks
                  ? `All ${totalTasks} draft ${totalTasks === 1 ? "issue" : "issues"} selected`
                  : `${selectedCount} of ${totalTasks} draft ${totalTasks === 1 ? "issue" : "issues"} selected`}
              </span>
              {selectedCount < totalTasks ? (
                <span>
                  {totalTasks - selectedCount} will be skipped if you accept this interaction.
                </span>
              ) : null}
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                disabled={!onAcceptInteraction || working !== null || selectedCount === 0}
                onClick={() => void handleAccept()}
              >
                {working === "accept" ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Accepting...
                  </>
                ) : (
                  selectedCount === totalTasks ? "Accept drafts" : "Accept selected drafts"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => setRejecting((current) => !current)}
              >
                Reject
              </Button>
              {selectedCount < totalTasks ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)))}
                >
                  Reset selection
                </Button>
              ) : null}
            </div>
          </div>

          {rejecting ? (
            <div className="space-y-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="Add a short reason for rejecting this suggestion"
                className="min-h-24 bg-background text-sm"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onRejectInteraction || working !== null}
                  onClick={() => void handleReject()}
                >
                  {working === "reject" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save rejection"
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QuestionOptionButton({
  id,
  label,
  description,
  selected,
  selectionMode,
  onClick,
}: {
  id: string;
  label: string;
  description?: string | null;
  selected: boolean;
  selectionMode: "single" | "multi";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={selectionMode === "single" ? "radio" : "checkbox"}
      aria-checked={selected}
      className={cn(
        "w-full rounded-sm border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected
          ? "border-sky-500/80 bg-sky-500/10 text-sky-950 dark:border-sky-400/80 dark:bg-sky-400/15 dark:text-sky-50"
          : "border-border/70 bg-transparent text-foreground hover:border-sky-500/70 hover:bg-sky-500/10 dark:hover:border-sky-400/70 dark:hover:bg-sky-400/10",
      )}
      id={id}
      onClick={onClick}
    >
      <div
        className={cn(
          "text-sm font-medium",
          selected ? "text-sky-950 dark:text-sky-50" : "text-foreground",
        )}
      >
        {label}
      </div>
      {description ? (
        <div
          className={cn(
            "mt-1 text-sm leading-6",
            selected
              ? "text-sky-900/80 dark:text-sky-100/80"
              : "text-muted-foreground",
          )}
        >
          {description}
        </div>
      ) : null}
    </button>
  );
}

function AskUserQuestionsCard({
  interaction,
  onSubmitInteractionAnswers,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
}) {
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? []).map((answer) => [
        answer.questionId,
        [...answer.optionIds],
      ]),
    ),
  );
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setDraftAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? []).map((answer) => [
          answer.questionId,
          [...answer.optionIds],
        ]),
      ),
    );
  }, [interaction.result?.answers]);

  const questions = interaction.payload.questions;
  const requiredQuestions = questions.filter((question) => question.required);
  const canSubmit = requiredQuestions.every(
    (question) => (draftAnswers[question.id] ?? []).length > 0,
  );

  function toggleOption(questionId: string, optionId: string, selectionMode: "single" | "multi") {
    setDraftAnswers((current) => {
      const existing = current[questionId] ?? [];
      if (selectionMode === "single") {
        return { ...current, [questionId]: [optionId] };
      }
      const next = existing.includes(optionId)
        ? existing.filter((value) => value !== optionId)
        : [...existing, optionId];
      return { ...current, [questionId]: next };
    });
  }

  async function handleSubmit() {
    if (!onSubmitInteractionAnswers || !canSubmit) return;
    setWorking(true);
    try {
      await onSubmitInteractionAnswers(
        interaction,
        questions.map((question) => ({
          questionId: question.id,
          optionIds: draftAnswers[question.id] ?? [],
        })),
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 font-medium uppercase tracking-[0.16em] text-foreground/70">
          <MessageSquareQuote className="h-3 w-3" />
          Ask user questions
        </span>
        <span>
          {questions.length === 1
            ? "1 question"
            : `${questions.length} questions`}
        </span>
      </div>

      {interaction.status === "pending" ? (
        <div className="space-y-4">
          {questions.map((question, index) => (
            <div
              key={question.id}
              className="rounded-2xl border border-border/70 bg-background/82 p-4 shadow-[0_18px_42px_rgba(15,23,42,0.06)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Question {index + 1}
                  </div>
                  <div
                    id={`${interaction.id}-${question.id}-prompt`}
                    className="mt-1 text-sm font-semibold text-foreground"
                  >
                    {question.prompt}
                  </div>
                  {question.helpText ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {question.helpText}
                    </p>
                  ) : null}
                </div>
                <TaskField
                  label={question.selectionMode === "single" ? "Pick" : "Pick many"}
                  value={question.required ? "Required" : "Optional"}
                  tone="subtle"
                />
              </div>

              <div
                className="mt-3 grid gap-3"
                role={question.selectionMode === "single" ? "radiogroup" : "group"}
                aria-labelledby={`${interaction.id}-${question.id}-prompt`}
              >
                {question.options.map((option) => (
                  <QuestionOptionButton
                    key={option.id}
                    id={`${interaction.id}-${question.id}-${option.id}`}
                    label={option.label}
                    description={option.description}
                    selected={(draftAnswers[question.id] ?? []).includes(option.id)}
                    selectionMode={question.selectionMode}
                    onClick={() =>
                      toggleOption(question.id, option.id, question.selectionMode)}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="text-sm text-muted-foreground">
              Submit once after you finish the full form.
            </div>
            <Button
              size="sm"
              disabled={!onSubmitInteractionAnswers || !canSubmit || working}
              onClick={() => void handleSubmit()}
            >
              {working ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Submitting...
                </>
              ) : (
                interaction.payload.submitLabel ?? "Submit answers"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {questions.map((question) => {
            const labels = getQuestionAnswerLabels({
              question,
              answers: interaction.result?.answers ?? [],
            });
            return (
              <div
                key={question.id}
                className="rounded-2xl border border-border/70 bg-background/82 p-4"
              >
                <div className="text-sm font-semibold text-foreground">
                  {question.prompt}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {labels.length > 0 ? (
                    labels.map((label) => (
                      <TaskField key={label} label="Answer" value={label} />
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No answer recorded.</span>
                  )}
                </div>
              </div>
            );
          })}

          {interaction.result?.summaryMarkdown ? (
            <div className="rounded-2xl border border-emerald-300/60 bg-emerald-50/85 p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                Submitted summary
              </div>
              <MarkdownBody>{interaction.result.summaryMarkdown}</MarkdownBody>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function requestConfirmationTargetLabel(target: RequestConfirmationTarget) {
  if (target.label) return target.label;
  const revision = target.revisionNumber ? ` v${target.revisionNumber}` : "";
  if (target.type === "issue_document" && target.key === "plan") {
    return `Plan${revision}`;
  }
  return `${target.key}${revision}`;
}

function requestConfirmationTargetHref({
  interaction,
  target,
}: {
  interaction: RequestConfirmationInteraction;
  target: RequestConfirmationTarget;
}) {
  if (target.href) return target.href;
  if (target.type === "issue_document") {
    const issueId = target.issueId ?? interaction.issueId;
    return `/issues/${issueId}#document-${encodeURIComponent(target.key)}`;
  }
  return null;
}

function RequestConfirmationTargetChip({
  interaction,
  target,
  tone = "default",
}: {
  interaction: RequestConfirmationInteraction;
  target: RequestConfirmationTarget | null | undefined;
  tone?: "default" | "subtle";
}) {
  if (!target) return null;

  const href = requestConfirmationTargetHref({ interaction, target });
  const className = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]",
    tone === "default"
      ? "border-border/70 bg-transparent text-foreground"
      : "border-border/60 bg-transparent text-muted-foreground",
    href && "transition-colors hover:border-sky-500/70 hover:bg-sky-500/10",
  );
  const content = (
    <>
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{requestConfirmationTargetLabel(target)}</span>
    </>
  );

  if (!href) return <span className={className}>{content}</span>;
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {content}
    </Link>
  );
}

function RequestConfirmationResolution({
  interaction,
}: {
  interaction: RequestConfirmationInteraction;
}) {
  const outcome = interaction.result?.outcome;
  const target = interaction.payload.target ?? null;
  const staleTarget = interaction.result?.staleTarget ?? null;

  if (interaction.status === "accepted") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">Confirmed</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">Declined</span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {interaction.result?.reason ? (
          <blockquote className="rounded-sm border-l-2 border-rose-500/70 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-900 dark:text-rose-100">
            {interaction.result.reason}
          </blockquote>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "expired") {
    const expiredByComment = outcome === "superseded_by_comment";
    const expiredByTargetChange = outcome === "stale_target";
    return (
      <div className="space-y-3 rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
          {expiredByComment ? "Expired by comment" : "Expired by target change"}
        </div>
        <p className="leading-6">
          {expiredByComment
            ? "A board comment superseded this confirmation before it was resolved."
            : "The requested target changed before this confirmation was resolved."}
        </p>
        {expiredByComment && interaction.result?.commentId ? (
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-amber-950 hover:bg-amber-500/15 dark:text-amber-50">
            <a href={`#comment-${interaction.result.commentId}`}>Jump to comment</a>
          </Button>
        ) : null}
        {expiredByTargetChange ? (
          <div className="flex flex-wrap items-center gap-2">
            <RequestConfirmationTargetChip
              interaction={interaction}
              target={staleTarget}
              tone="subtle"
            />
            {staleTarget && target ? (
              <ChevronRight className="h-3.5 w-3.5 text-amber-700" />
            ) : null}
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        This request could not be resolved. Try again or create a new request.
      </p>
    );
  }

  return null;
}

function RequestConfirmationCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: RequestConfirmationInteraction;
  onAcceptInteraction?: (
    interaction: RequestConfirmationInteraction,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(interaction.result?.reason ?? "");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowDeclineReason = interaction.payload.allowDeclineReason !== false;
  const trimmedRejectReason = rejectReason.trim();
  const canReject = !rejectRequiresReason || trimmedRejectReason.length > 0;
  const declineReasonInvalid = rejectRequiresReason && !canReject;
  const declineReasonPlaceholder =
    interaction.payload.declineReasonPlaceholder
    ?? (interaction.payload.acceptLabel === "Approve plan"
      ? "Optional: what would you like revised?"
      : "Optional: tell the agent what you'd change.");

  useEffect(() => {
    setRejectReason(interaction.result?.reason ?? "");
    setRejectAttempted(false);
    setActionError(null);
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, interaction.result?.reason, interaction.status]);

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    setRejectAttempted(true);
    if (!onRejectInteraction || !canReject) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, trimmedRejectReason || undefined);
      setRejecting(false);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      {interaction.status === "pending" ? (
        <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
          <div className="text-sm leading-6 text-foreground">
            {interaction.payload.prompt}
          </div>
          {interaction.payload.detailsMarkdown ? (
            <div className="border-t border-border/60 pt-3 text-sm">
              <MarkdownBody>{interaction.payload.detailsMarkdown}</MarkdownBody>
            </div>
          ) : null}
          <RequestConfirmationTargetChip
            interaction={interaction}
            target={interaction.payload.target}
          />
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant={rejecting ? "outline" : "default"}
              disabled={!onAcceptInteraction || working !== null}
              onClick={() => void handleAccept()}
            >
              {working === "accept" ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Confirming...
                </>
              ) : (
                interaction.payload.acceptLabel ?? "Confirm"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!onRejectInteraction || working !== null}
              onClick={() => {
                if (!allowDeclineReason) {
                  void handleReject();
                  return;
                }
                setRejectAttempted(false);
                setRejecting((current) => !current);
              }}
            >
              {interaction.payload.rejectLabel ?? "Decline"}
            </Button>
          </div>

          {rejecting ? (
            <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder={declineReasonPlaceholder}
                aria-invalid={rejectAttempted && declineReasonInvalid}
                className={cn(
                  "min-h-24 bg-background text-sm",
                  rejectAttempted && declineReasonInvalid
                    && "border-rose-500 focus-visible:ring-rose-500/25",
                )}
              />
              {rejectAttempted && declineReasonInvalid ? (
                <p className="text-xs text-destructive">A decline reason is required.</p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => {
                    setRejecting(false);
                    setRejectAttempted(false);
                  }}
                >
                  Cancel decline
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onRejectInteraction || working !== null}
                  onClick={() => void handleReject()}
                >
                  {working === "reject" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    interaction.payload.rejectLabel ?? "Decline"
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {actionError ? (
            <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>
      ) : (
        <RequestConfirmationResolution interaction={interaction} />
      )}
    </div>
  );
}

export function IssueThreadInteractionCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
}: IssueThreadInteractionCardProps) {
  const StatusIcon = statusIcon(interaction.status);
  const styles = statusClasses(interaction.status);
  const createdByLabel = resolveActorLabel({
    agentId: interaction.createdByAgentId,
    userId: interaction.createdByUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const resolvedByLabel =
    interaction.resolvedByAgentId || interaction.resolvedByUserId
      ? resolveActorLabel({
          agentId: interaction.resolvedByAgentId,
          userId: interaction.resolvedByUserId,
          agentMap,
          currentUserId,
          userLabelMap,
        })
      : null;

  return (
    <div className={cn("rounded-sm border p-5 shadow-none", styles.shell)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-sm border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", styles.badge)}>
              <StatusIcon className="h-3.5 w-3.5" />
              {interactionKindLabel(interaction.kind)}
              <span className="text-current/60">/</span>
              {statusLabel(interaction.status)}
            </span>
            {interaction.continuationPolicy === "wake_assignee"
              || interaction.continuationPolicy === "wake_assignee_on_accept" ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-transparent px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/70">
                <ListChecks className="h-3.5 w-3.5" />
                {interaction.continuationPolicy === "wake_assignee_on_accept"
                  ? "Wakes on confirm"
                  : "Wakes assignee"}
              </span>
            ) : null}
          </div>

          <div className="mt-3 text-lg font-bold text-foreground">
            {interaction.title
              ?? (interaction.kind === "suggest_tasks"
                ? "Suggested task tree"
                : interaction.kind === "ask_user_questions"
                  ? interaction.payload.title ?? "Questions for the operator"
                  : "Confirmation requested")}
          </div>
          {interaction.summary ? (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {interaction.summary}
            </p>
          ) : null}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="rounded-sm border border-border/70 bg-transparent px-3 py-2 text-right text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{formatShortDate(interaction.createdAt)}</div>
              <div>proposed by {createdByLabel}</div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Created {formatDateTime(interaction.createdAt)}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-5">
        {interaction.kind === "suggest_tasks" ? (
          <SuggestTasksCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
          />
        ) : interaction.kind === "ask_user_questions" ? (
          <AskUserQuestionsCard
            interaction={interaction}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
          />
        ) : (
          <RequestConfirmationCard
            interaction={interaction}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
          />
        )}
      </div>

      {resolvedByLabel ? (
        <div className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Resolved by <span className="font-medium text-foreground">{resolvedByLabel}</span>
          {interaction.resolvedAt ? ` on ${formatShortDate(interaction.resolvedAt)}` : ""}
        </div>
      ) : null}
    </div>
  );
}
