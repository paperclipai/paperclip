import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock, ExternalLink, FileText, GitBranch, ImagePlus, Loader2, MessageSquareQuote, MinusCircle, ShieldAlert, ThumbsUp, TriangleAlert, Wrench, X, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { formatAssigneeUserLabel } from "../lib/assignees";
import {
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getCheckboxConfirmationSelectedLabels,
  getItemVerdictProgress,
  getQuestionAnswerLabels,
  normalizeRequestConfirmationTargetHref,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestConfirmationTarget,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictsItem,
  type RequestItemVerdictsResultItem,
  type RequestItemVerdictValue,
  type SuggestTasksInteraction,
  type SuggestTasksResultCreatedTask,
  type SuggestedTaskDraft,
  type SuggestedTaskTreeNode,
} from "../lib/issue-thread-interactions";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { PriorityIcon } from "./PriorityIcon";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Badge } from "@/components/ui/badge";

const OTHER_ANSWER_ID = "__paperclip_other__";

interface IssueThreadInteractionCardProps {
  interaction: IssueThreadInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: { id: string; verdict: RequestItemVerdictValue; reason?: string }[],
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
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
    case "cancelled":
      return "Cancelled";
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
    case "request_checkbox_confirmation":
      return "Checkbox confirmation";
    case "request_item_verdicts":
      return "Item verdicts";
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
    case "cancelled":
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
    case "cancelled":
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

/**
 * A confirmation that targets the issue's `plan` document renders as a distinct
 * plan card (PAP-95g): a full state-coloured outline — violet while in review,
 * green once approved, red when changes are requested (PAP-75 palette) — with no
 * left stripe, so plans stand out from comments and status rows.
 */
function isPlanConfirmation(interaction: IssueThreadInteraction): boolean {
  if (interaction.kind !== "request_confirmation") return false;
  const target = interaction.payload.target;
  return target?.type === "issue_document" && target?.key === "plan";
}

function requestConfirmationResumeFailure(interaction: IssueThreadInteraction) {
  if (interaction.kind !== "request_confirmation" && interaction.kind !== "request_checkbox_confirmation") return null;
  return interaction.result?.resumeFailure ?? null;
}

function planStatusClasses(
  status: IssueThreadInteraction["status"],
  resumeFailure?: ReturnType<typeof requestConfirmationResumeFailure>,
) {
  switch (status) {
    case "accepted":
    case "answered":
      if (resumeFailure) {
        return {
          shell: "border-2 border-amber-500/70 bg-transparent",
          badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
          label: "Approved — agent resume failed",
          Icon: AlertTriangle,
        };
      }
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: "Approved",
        Icon: CheckCircle2,
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: "Changes requested",
        Icon: XCircle,
      };
    case "failed":
    case "expired":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: "Expired",
        Icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        label: "In review",
        Icon: FileText,
      };
  }
}

/**
 * A `request_confirmation` that carries a `payload.toolAction` block gates a
 * write/destructive MCP tool call (PAP-13726 §D1). It renders as a dedicated
 * tool-approval card (PAP-13745) instead of the generic confirmation rendering.
 * The governing rule: approve = run, so the card never terminally reads
 * "Accepted" — terminal states are Executed / Failed / Declined / Expired.
 */
function toolActionPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["toolAction"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.toolAction ?? null;
}

function isToolActionConfirmation(interaction: IssueThreadInteraction): boolean {
  return toolActionPayload(interaction) != null;
}

type ToolActionCardState =
  | "pending"
  | "running"
  | "executed"
  | "failed"
  | "declined"
  | "expired";

/**
 * Derives the visible lifecycle state from the interaction status plus the
 * `result.toolAction.status` written back by the gateway. The card must render
 * the resolved state without polling — the lifecycle metadata is authoritative,
 * so an optimistic "running…" reconciles to the server's terminal state.
 */
function toolActionCardState(
  interaction: RequestConfirmationInteraction,
): ToolActionCardState {
  const execStatus = interaction.result?.toolAction?.status ?? null;
  if (interaction.status === "pending") return "pending";
  if (interaction.status === "rejected") return "declined";
  if (interaction.status === "expired") return "expired";
  // Terminal execution outcomes take precedence over the coarse interaction
  // status so a self-resolving "running…" advances to its real result.
  if (execStatus === "executed") return "executed";
  if (execStatus === "failed") return "failed";
  if (execStatus === "expired") return "expired";
  if (interaction.status === "failed") return "failed";
  // accepted + approved/executing/unknown → the transient running state.
  return "running";
}

function toolActionStatusClasses(state: ToolActionCardState): {
  shell: string;
  badge: string;
  label: string;
  Icon: typeof CheckCircle2;
  spin?: boolean;
  dimmed?: boolean;
} {
  switch (state) {
    case "running":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: "Running…",
        Icon: Loader2,
        spin: true,
      };
    case "executed":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: "Executed",
        Icon: CheckCircle2,
      };
    case "failed":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: "Failed",
        Icon: XCircle,
      };
    case "declined":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: "Declined",
        Icon: XCircle,
        dimmed: true,
      };
    case "expired":
      return {
        shell: "border-2 border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: "Expired",
        Icon: Clock,
        dimmed: true,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        label: "Awaiting approval",
        Icon: ShieldAlert,
      };
  }
}

function toolActionRiskBadge(risk: "write" | "destructive") {
  if (risk === "destructive") {
    return {
      label: "DESTRUCTIVE",
      Icon: TriangleAlert,
      className:
        "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
    };
  }
  return {
    label: "WRITE",
    Icon: AlertTriangle,
    className:
      "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
  };
}

function toolActionInitial(payload: {
  appDisplayName: string | null;
  toolDisplayName: string;
}): string {
  const source = payload.appDisplayName?.trim() || payload.toolDisplayName.trim();
  return source ? source.charAt(0).toUpperCase() : "?";
}

function formatToolActionCountdown(expiresAt: string, nowMs: number): {
  text: string;
  urgent: boolean;
} | null {
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return null;
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { text: "Approval window closed · auto-declines any moment", urgent: true };
  }
  const minutes = Math.ceil(remainingMs / 60000);
  return {
    text: `Approval expires in ${minutes} min · auto-declines if not answered`,
    urgent: minutes <= 5,
  };
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
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow)",
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
                  <div className="mt-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
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
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-(length:--text-micro) font-medium text-emerald-900 transition-colors hover:bg-emerald-500/15 dark:text-emerald-100"
            >
              {createdTask.identifier ?? createdTask.issueId.slice(0, 8)}
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : isSkipped ? (
            <span className="inline-flex shrink-0 items-center rounded-sm border border-amber-500/60 bg-amber-500/10 px-2.5 py-1 text-(length:--text-micro) font-medium text-amber-900 dark:text-amber-100">
              Skipped
            </span>
          ) : null}
        </div>

        {hasMetadata ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasExplicitAssignee ? (
              <TaskField label="Responsible" value={assigneeLabel} />
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
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-emerald-700">
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
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-rose-700">
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
        "w-full rounded-sm border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
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
  onCancelInteraction,
  externalReferences,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? []).map((answer) => [
        answer.questionId,
        [...answer.optionIds],
      ]),
    ),
  );
  const [draftOtherAnswers, setDraftOtherAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, answer.otherText ?? ""]),
    ),
  );
  const [otherActiveQuestions, setOtherActiveQuestions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, true]),
    ),
  );
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    setDraftAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? []).map((answer) => [
          answer.questionId,
          [...answer.optionIds],
        ]),
      ),
    );
    setDraftOtherAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, answer.otherText ?? ""]),
      ),
    );
    setOtherActiveQuestions(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, true]),
      ),
    );
  }, [interaction.result?.answers]);

  const questions = interaction.payload.questions;
  const requiredQuestions = questions.filter((question) => question.required);
  const canSubmit = requiredQuestions.every(
    (question) =>
      (draftAnswers[question.id] ?? []).length > 0
      || (
        otherActiveQuestions[question.id] === true
        && (draftOtherAnswers[question.id]?.trim().length ?? 0) > 0
      ),
  );

  function toggleOption(questionId: string, optionId: string, selectionMode: "single" | "multi") {
    if (optionId === OTHER_ANSWER_ID) {
      setOtherActiveQuestions((current) => ({
        ...current,
        [questionId]: !current[questionId],
      }));
      if (selectionMode === "single") {
        setDraftAnswers((current) => ({ ...current, [questionId]: [] }));
      }
      return;
    }

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
    if (selectionMode === "single") {
      setOtherActiveQuestions((current) => ({ ...current, [questionId]: false }));
    }
  }

  async function handleSubmit() {
    if (!onSubmitInteractionAnswers || !canSubmit) return;
    setWorking(true);
    try {
      await onSubmitInteractionAnswers(
        interaction,
        questions.map((question) => {
          const otherText = otherActiveQuestions[question.id] === true
            ? draftOtherAnswers[question.id]?.trim() ?? ""
            : "";
          return {
            questionId: question.id,
            optionIds: draftAnswers[question.id] ?? [],
            ...(otherText ? { otherText } : {}),
          };
        }),
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleCancel() {
    if (!onCancelInteraction) return;
    setCancelling(true);
    try {
      await onCancelInteraction(interaction);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="border-border/70 bg-background/70 px-2.5 py-1 uppercase tracking-(--tracking-eyebrow) text-foreground/70">
          <MessageSquareQuote className="h-3 w-3" />
          Ask user questions
        </Badge>
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
              className="rounded-2xl border border-border/70 bg-background/82 p-4 shadow-(--shadow-extract-9)"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
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

              <div className="mt-3 space-y-3">
                <div
                  className="grid gap-3"
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
                <button
                  type="button"
                  id={`${interaction.id}-${question.id}-other`}
                  aria-expanded={otherActiveQuestions[question.id] === true}
                  className={cn(
                    "text-sm font-medium underline underline-offset-4 transition-colors outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
                    otherActiveQuestions[question.id]
                      ? "text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() =>
                    toggleOption(question.id, OTHER_ANSWER_ID, question.selectionMode)}
                >
                  Other
                </button>
                {otherActiveQuestions[question.id] ? (
                  <Textarea
                    aria-label={`Other answer for ${question.prompt}`}
                    value={draftOtherAnswers[question.id] ?? ""}
                    onChange={(event) =>
                      setDraftOtherAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))}
                    placeholder="Type your answer"
                    className="min-h-24 bg-background text-sm"
                  />
                ) : null}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="text-sm text-muted-foreground">
              Submit once after you finish the full form.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onCancelInteraction ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || cancelling}
                  onClick={() => void handleCancel()}
                >
                  {cancelling ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    "Cancel question"
                  )}
                  </Button>
                ) : null}
              <Button
                size="sm"
                disabled={!onSubmitInteractionAnswers || !canSubmit || working || cancelling}
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
        </div>
      ) : interaction.status === "cancelled" ? (
        <div className="rounded-2xl border border-rose-300/60 bg-rose-50/85 p-4 text-sm leading-6 text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
          <div className="font-semibold">Question cancelled</div>
          {interaction.result?.cancellationReason ? (
            <p className="mt-1">{interaction.result.cancellationReason}</p>
          ) : (
            <p className="mt-1">No answer was recorded.</p>
          )}
        </div>
      ) : interaction.status === "expired" ? (
        <div className="rounded-2xl border border-amber-300/70 bg-amber-50/85 p-4 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {questions.length === 1 ? "Question expired by comment" : "Questions expired by comment"}
          </div>
          <p className="mt-1">
            A later board/user comment superseded this question request. Create a fresh request if answers are still needed.
          </p>
          {interaction.result?.commentId ? (
            <a
              href={`#comment-${interaction.result.commentId}`}
              className="mt-3 inline-flex text-sm font-medium underline underline-offset-4"
            >
              Jump to comment
            </a>
          ) : null}
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
              <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-emerald-700">
                Submitted summary
              </div>
              <MarkdownBody externalReferences={externalReferences}>{interaction.result.summaryMarkdown}</MarkdownBody>
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
  interaction: Pick<IssueThreadInteraction, "issueId">;
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
  interaction: Pick<IssueThreadInteraction, "issueId">;
  target: RequestConfirmationTarget | null | undefined;
  tone?: "default" | "subtle";
}) {
  if (!target) return null;

  const href = requestConfirmationTargetHref({ interaction, target });
  const className = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow)",
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
    const resumeFailure = requestConfirmationResumeFailure(interaction);
    if (resumeFailure) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
            <span className="font-medium">Confirmed</span>
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
          <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
              Agent resume failed
            </div>
            <p className="mt-1 leading-6">
              {resumeFailure.status === "retrying"
                ? `Paperclip is retrying the agent resume after approval (attempt ${resumeFailure.attempt}/${resumeFailure.maxAttempts}).`
                : "Paperclip needs attention before the agent can resume this approved work."}
            </p>
            {resumeFailure.errorCode ? (
              <p className="mt-1 leading-6">
                Latest cause: <code className="font-mono text-(length:--text-micro)">{resumeFailure.errorCode}</code>
              </p>
            ) : null}
          </div>
        </div>
      );
    }
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
          <div className="rounded-sm border-l-2 border-rose-500/70 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-900 dark:text-rose-100">
            <MarkdownBody>{interaction.result.reason}</MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "expired") {
    const expiredByComment = outcome === "superseded_by_comment";
    const expiredByTargetChange = outcome === "stale_target";
    return (
      <div className="space-y-3 rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
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

function ToolActionIdentityHeader({
  payload,
  state,
}: {
  payload: NonNullable<RequestConfirmationInteraction["payload"]["toolAction"]>;
  state: ToolActionCardState;
}) {
  const risk = toolActionRiskBadge(payload.risk);
  const RiskIcon = risk.Icon;
  const dimmed = state === "declined" || state === "expired";
  const subParts = [payload.appDisplayName, payload.toolName].filter(
    (part): part is string => Boolean(part && part.trim()),
  );

  return (
    <div className={cn("flex items-start gap-3", dimmed && "opacity-60 grayscale")}>
      <div
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-base font-semibold text-foreground"
      >
        {toolActionInitial(payload)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-bold leading-tight text-foreground">
            {payload.toolDisplayName}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)",
              risk.className,
            )}
          >
            <RiskIcon className="h-3 w-3" />
            {risk.label}
          </span>
        </div>
        {subParts.length > 0 ? (
          <div className="mt-1 truncate font-mono text-(length:--text-compact) text-muted-foreground">
            {subParts.join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolActionTechnicalDetails({
  payload,
}: {
  payload: NonNullable<RequestConfirmationInteraction["payload"]["toolAction"]>;
}) {
  const [open, setOpen] = useState(false);
  const hasArgs = payload.argumentsSummaryJson.trim().length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {hasArgs ? (
          <pre className="max-h-64 overflow-auto rounded-sm border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground">
            {payload.argumentsSummaryJson}
          </pre>
        ) : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-(--tracking-eyebrow) text-(length:--text-nano)">
            args hash
          </span>
          <code className="truncate font-mono">{payload.argumentsHash}</code>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolActionResolution({
  state,
  interaction,
  resolvedByLabel,
  requestedByLabel,
}: {
  state: ToolActionCardState;
  interaction: RequestConfirmationInteraction;
  resolvedByLabel: string | null;
  requestedByLabel: string;
}) {
  const result = interaction.result?.toolAction ?? null;
  const who = resolvedByLabel ?? "the board";
  const when = interaction.resolvedAt
    ? formatDateTime(interaction.resolvedAt)
    : result?.updatedAt
      ? formatDateTime(result.updatedAt)
      : null;
  const whenSuffix = when ? ` at ${when}` : "";

  if (state === "running") {
    return (
      <div
        aria-live="polite"
        className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
      >
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div className="space-y-1 leading-6">
          <div className="font-medium">Approved by {who} — running the action now</div>
          <p className="text-amber-900/80 dark:text-amber-100/80">
            The action is executing server-side with the exact arguments you approved.
          </p>
        </div>
      </div>
    );
  }

  if (state === "executed") {
    const summary = result?.resultSummary?.trim();
    const href = result?.resultHref?.trim();
    return (
      <div
        aria-live="polite"
        className="space-y-2 rounded-sm border border-green-500/50 bg-green-500/10 px-4 py-3 text-sm text-green-900 dark:text-green-100"
      >
        <div className="flex items-start gap-2 leading-6">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Executed · approved by {who}{whenSuffix}</div>
            <p className="text-green-900/80 dark:text-green-100/80">
              {requestedByLabel} was resumed with this result.
            </p>
          </div>
        </div>
        {summary ? (
          <div className="rounded-sm border border-green-500/40 bg-background/60 px-3 py-2 font-medium text-foreground">
            {summary}
          </div>
        ) : (
          <div className="rounded-sm border border-green-500/40 bg-background/60 px-3 py-2 text-foreground">
            Executed successfully.
          </div>
        )}
        {href ? (
          <Button asChild size="sm" variant="outline" className="h-7 px-2">
            <a href={href} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              View result
            </a>
          </Button>
        ) : null}
      </div>
    );
  }

  if (state === "failed") {
    const errorText = result?.errorMessage?.trim();
    const errorCode = result?.errorCode?.trim();
    return (
      <div
        aria-live="polite"
        className="space-y-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
      >
        <div className="flex items-start gap-2 leading-6">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          <div>
            <div className="font-medium">Failed · approved by {who}{whenSuffix}</div>
            <p className="text-amber-900/80 dark:text-amber-100/80">
              You approved it and it ran, but the connector returned an error.{" "}
              {requestedByLabel} was resumed with this error.
            </p>
          </div>
        </div>
        {errorText || errorCode ? (
          <div className="rounded-sm border border-red-500/50 bg-red-500/10 px-3 py-2 text-red-900 dark:text-red-100">
            {errorCode ? (
              <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-red-700 dark:text-red-300">
                {errorCode}
              </div>
            ) : null}
            {errorText ? (
              <p className={cn("leading-6", errorCode && "mt-1")}>{errorText}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (state === "declined") {
    const reason = interaction.result?.reason?.trim();
    return (
      <div className="space-y-2 rounded-sm border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
        <div className="flex items-start gap-2 leading-6">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Declined by {who}{whenSuffix}</div>
            <p className="text-red-900/80 dark:text-red-100/80">
              The action did <strong>not</strong> run. {requestedByLabel} was resumed with
              your reason and told not to retry the same call.
            </p>
          </div>
        </div>
        {reason ? (
          <div className="rounded-sm border border-red-500/40 bg-background/60 px-3 py-2 text-foreground">
            <MarkdownBody>{reason}</MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  }

  // expired
  return (
    <div className="space-y-1 rounded-sm border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
      <div className="flex items-start gap-2 leading-6">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium text-foreground">
            Expired{when ? ` at ${when}` : ""} — no one responded within 60 minutes
          </div>
          <p>
            The action did <strong>not</strong> run. If it's still needed, the agent can
            request approval again — a fresh card will appear.
          </p>
        </div>
      </div>
    </div>
  );
}

function RequestToolActionCard({
  interaction,
  state,
  resolvedByLabel,
  requestedByLabel,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  state: ToolActionCardState;
  resolvedByLabel: string | null;
  requestedByLabel: string;
  onAcceptInteraction?: (
    interaction: RequestConfirmationInteraction,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const payload = interaction.payload.toolAction!;
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isPending = state === "pending";
  const isDestructive = payload.risk === "destructive";

  useEffect(() => {
    if (!isPending) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [isPending]);

  useEffect(() => {
    if (state !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, state]);

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch {
      setActionError("Couldn't submit. Try again.");
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, rejectReason.trim() || undefined);
      setRejecting(false);
    } catch {
      setActionError("Couldn't submit. Try again.");
    } finally {
      setWorking(null);
    }
  }

  const countdown = isPending ? formatToolActionCountdown(payload.expiresAt, nowMs) : null;

  return (
    <div className="space-y-4">
      <ToolActionIdentityHeader payload={payload} state={state} />

      <div className="text-sm leading-6 text-foreground">
        <MarkdownBody externalReferences={externalReferences}>
          {payload.previewMarkdown}
        </MarkdownBody>
      </div>

      <ToolActionTechnicalDetails payload={payload} />

      {isPending ? (
        <>
          {countdown ? (
            <div
              className={cn(
                "flex items-center gap-2 text-(length:--text-micro) font-medium",
                countdown.urgent ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
            >
              <Clock className="h-3.5 w-3.5" />
              {countdown.text}
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={isDestructive ? "destructive" : "cta"}
                disabled={!onAcceptInteraction || working !== null}
                onClick={() => void handleAccept()}
              >
                {working === "accept" ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Approving…
                  </>
                ) : (
                  "Approve & run"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => setRejecting((current) => !current)}
              >
                Decline
              </Button>
              <span className="text-(length:--text-micro) text-muted-foreground">
                Approving runs this action now.
              </span>
            </div>

            {rejecting ? (
              <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
                <Textarea
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                  placeholder="Optional: tell the agent why, so it doesn't retry the same call."
                  className="min-h-20 bg-background text-sm"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working !== null}
                    onClick={() => setRejecting(false)}
                  >
                    Cancel
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
                        Declining…
                      </>
                    ) : (
                      "Decline"
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
        </>
      ) : (
        <ToolActionResolution
          state={state}
          interaction={interaction}
          resolvedByLabel={resolvedByLabel}
          requestedByLabel={requestedByLabel}
        />
      )}
    </div>
  );
}

function RequestConfirmationCard({
  interaction,
  isPlan = false,
  onAcceptInteraction,
  onRejectInteraction,
  onUploadImage,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  isPlan?: boolean;
  onAcceptInteraction?: (
    interaction: RequestConfirmationInteraction,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(interaction.result?.reason ?? "");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shots, setShots] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Screenshots ride along in the decline reason as markdown image refs so the
  // board can attach images when sending a plan back — no schema change needed.
  const allowScreenshots = isPlan && Boolean(onUploadImage);
  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowDeclineReason = interaction.payload.allowDeclineReason !== false;
  const trimmedRejectReason = rejectReason.trim();
  const canReject = !rejectRequiresReason || trimmedRejectReason.length > 0 || shots.length > 0;
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
    setShots([]);
    setUploadError(null);
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, interaction.result?.reason, interaction.status]);

  async function handleAddScreenshots(files: FileList | null) {
    if (!onUploadImage || !files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded: { name: string; url: string }[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const url = await onUploadImage(file);
        uploaded.push({ name: file.name || "screenshot", url });
      }
      if (uploaded.length > 0) setShots((current) => [...current, ...uploaded]);
    } catch {
      setUploadError("Couldn't upload that image. Try again.");
    } finally {
      setUploading(false);
    }
  }

  function composeReason() {
    const text = trimmedRejectReason;
    if (shots.length === 0) return text || undefined;
    const images = shots.map((s) => `![${s.name}](${s.url})`).join("\n");
    return [text, images].filter(Boolean).join("\n\n");
  }

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
      await onRejectInteraction(interaction, composeReason());
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
              <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
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
              variant={rejecting ? "outline" : isPlan ? "cta" : "default"}
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
              {allowScreenshots ? (
                <div className="space-y-2">
                  {shots.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {shots.map((shot, index) => (
                        <div
                          key={`${shot.url}-${index}`}
                          className="group relative h-16 w-16 overflow-hidden rounded-sm border border-border/70"
                        >
                          <img
                            src={shot.url}
                            alt={shot.name}
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`Remove ${shot.name}`}
                            className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={() =>
                              setShots((current) => current.filter((_, i) => i !== index))
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void handleAddScreenshots(event.target.value ? event.target.files : null);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={working !== null || uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <ImagePlus className="mr-2 h-3.5 w-3.5" />
                        Attach screenshots
                      </>
                    )}
                  </Button>
                  {uploadError ? (
                    <p className="text-xs text-destructive">{uploadError}</p>
                  ) : null}
                </div>
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

const CHECKBOX_SUMMARY_LABEL_LIMIT = 8;

function RequestCheckboxConfirmationResolution({
  interaction,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
}) {
  const target = interaction.payload.target ?? null;
  const [expanded, setExpanded] = useState(false);

  if (interaction.status === "accepted") {
    const totalOptions = interaction.payload.options.length;
    const selectedLabels = getCheckboxConfirmationSelectedLabels({
      payload: interaction.payload,
      result: interaction.result,
    });
    const selectedCount = interaction.result?.selectedOptionIds?.length ?? selectedLabels.length;
    const visibleLabels = expanded
      ? selectedLabels
      : selectedLabels.slice(0, CHECKBOX_SUMMARY_LABEL_LIMIT);
    const hiddenCount = selectedLabels.length - CHECKBOX_SUMMARY_LABEL_LIMIT;
    const hasHiddenLabels = hiddenCount > 0;
    const chipClassName =
      "inline-flex items-center rounded-sm border border-border/60 bg-transparent px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">
            {selectedCount === 0
              ? "Confirmed with no options selected"
              : `Confirmed ${selectedCount} of ${totalOptions} ${totalOptions === 1 ? "option" : "options"}`}
          </span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {visibleLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleLabels.map((label, index) => (
              <TaskField key={`${label}-${index}`} label="Selected" value={label} />
            ))}
            {hasHiddenLabels ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className={cn(
                  chipClassName,
                  "cursor-pointer transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : `+${hiddenCount} more`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
  }

  if (interaction.status === "expired") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
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

function CheckboxOptionRow({
  id,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  description?: string | null;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 border-b border-border/60 px-3 py-2 last:border-b-0 transition-colors",
        checked ? "bg-sky-500/10" : "hover:bg-sky-500/5",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
        aria-label={label}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-5 text-foreground">{label}</div>
        {description ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </label>
  );
}

function RequestCheckboxConfirmationCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  onAcceptInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    selectedClientKeys: undefined,
    selectedOptionIds: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const options = interaction.payload.options;
  const optionIds = useMemo(() => options.map((option) => option.id), [options]);
  const validOptionIds = useMemo(() => new Set(optionIds), [optionIds]);
  const minSelected = interaction.payload.minSelected ?? 0;
  const maxSelected = interaction.payload.maxSelected ?? null;

  const defaultSelected = useMemo(
    () =>
      new Set(
        (interaction.payload.defaultSelectedOptionIds ?? []).filter((id) => validOptionIds.has(id)),
      ),
    [interaction.payload.defaultSelectedOptionIds, validOptionIds],
  );

  const [selectedOptionIds, setSelectedOptionIds] = useState<Set<string>>(() => new Set(defaultSelected));
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(interaction.result?.reason ?? "");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [acceptAttempted, setAcceptAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const optionSeed = useMemo(() => optionIds.join("\n"), [optionIds]);

  useEffect(() => {
    setSelectedOptionIds(new Set(defaultSelected));
    setRejectReason(interaction.result?.reason ?? "");
    setRejectAttempted(false);
    setAcceptAttempted(false);
    setActionError(null);
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, interaction.status, interaction.result?.reason, defaultSelected, optionSeed]);

  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowDeclineReason = interaction.payload.allowDeclineReason !== false;
  const trimmedRejectReason = rejectReason.trim();
  const canReject = !rejectRequiresReason || trimmedRejectReason.length > 0;
  const declineReasonInvalid = rejectRequiresReason && !canReject;
  const declineReasonPlaceholder =
    interaction.payload.declineReasonPlaceholder ?? "Optional: tell the agent what you'd change.";

  const selectedCount = selectedOptionIds.size;
  const totalOptions = options.length;
  const atMax = maxSelected != null && selectedCount >= maxSelected;
  const belowMin = selectedCount < minSelected;
  const aboveMax = maxSelected != null && selectedCount > maxSelected;
  const selectionValid = !belowMin && !aboveMax;

  const validationMessage = belowMin
    ? minSelected === 1
      ? "Select at least 1 option."
      : `Select at least ${minSelected} options.`
    : aboveMax && maxSelected != null
      ? maxSelected === 1
        ? "Select at most 1 option."
        : `Select at most ${maxSelected} options.`
      : null;

  function toggleOption(optionId: string, checked: boolean) {
    setSelectedOptionIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(optionId);
      } else {
        next.delete(optionId);
      }
      return next;
    });
  }

  function handleSelectAll() {
    const capped = maxSelected != null ? optionIds.slice(0, maxSelected) : optionIds;
    setSelectedOptionIds(new Set(capped));
  }

  function handleClearSelection() {
    setSelectedOptionIds(new Set());
  }

  async function handleAccept() {
    setAcceptAttempted(true);
    if (!onAcceptInteraction || !selectionValid) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction, undefined, [...selectedOptionIds]);
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

  if (interaction.status !== "pending") {
    return (
      <div className="space-y-4">
        <RequestCheckboxConfirmationResolution interaction={interaction} />
      </div>
    );
  }

  const selectionSummary = totalOptions > 0 && selectedCount === totalOptions
    ? `All ${totalOptions} options selected`
    : `${selectedCount} of ${totalOptions} ${totalOptions === 1 ? "option" : "options"} selected`;
  const boundsHint = maxSelected != null
    ? `Pick ${minSelected === maxSelected ? `exactly ${maxSelected}` : `${minSelected}-${maxSelected}`}.`
    : minSelected > 0
      ? `Pick at least ${minSelected}.`
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        <div className="text-sm leading-6 text-foreground">{interaction.payload.prompt}</div>
        {interaction.payload.detailsMarkdown ? (
          <div className="border-t border-border/60 pt-3 text-sm">
            <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
          </div>
        ) : null}
        <RequestConfirmationTargetChip
          interaction={interaction}
          target={interaction.payload.target}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{selectionSummary}</span>
            {boundsHint ? <span>{boundsHint}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === totalOptions || (maxSelected != null && selectedCount >= maxSelected)}
              onClick={handleSelectAll}
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === 0}
              onClick={handleClearSelection}
            >
              Clear selection
            </Button>
          </div>
        </div>

        <div
          role="group"
          aria-label="Selectable options"
          className="max-h-80 overflow-y-auto rounded-sm border border-border/70"
        >
          {options.map((option) => {
            const checked = selectedOptionIds.has(option.id);
            return (
              <CheckboxOptionRow
                key={option.id}
                id={`${interaction.id}-${option.id}`}
                label={option.label}
                description={option.description}
                checked={checked}
                disabled={working !== null || (!checked && atMax)}
                onToggle={(value) => toggleOption(option.id, value)}
              />
            );
          })}
        </div>

        {acceptAttempted && validationMessage ? (
          <p className="text-xs text-destructive">{validationMessage}</p>
        ) : null}

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
              interaction.payload.acceptLabel ?? "Confirm selected"
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
            {interaction.payload.rejectLabel ?? "Request changes"}
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
              <p className="text-xs text-destructive">A reason is required.</p>
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
                Cancel
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
                  interaction.payload.rejectLabel ?? "Request changes"
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
    </div>
  );
}

// --- Per-item verdicts (C3) ---------------------------------------------

const VERDICT_LABEL: Record<RequestItemVerdictValue, string> = {
  approve: "Approve",
  reject: "Reject",
  defer: "Defer",
};

/** Present-tense past-participle label for a resolved verdict chip. */
const VERDICT_RESOLVED_LABEL: Record<RequestItemVerdictValue, string> = {
  approve: "Approved",
  reject: "Rejected",
  defer: "Deferred",
};

function verdictChipClasses(verdict: RequestItemVerdictValue) {
  switch (verdict) {
    case "approve":
      return "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100";
    case "reject":
      return "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100";
    default:
      return "border-border/70 bg-muted/40 text-muted-foreground";
  }
}

function VerdictConsequenceChip({ verdict }: { verdict: RequestItemVerdictValue }) {
  const Icon = verdict === "approve" ? CheckCircle2 : verdict === "reject" ? XCircle : MinusCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)",
        verdictChipClasses(verdict),
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {VERDICT_RESOLVED_LABEL[verdict]}
    </span>
  );
}

function ItemVerdictDeepLink({ item }: { item: RequestItemVerdictsItem }) {
  const href = item.href ? normalizeRequestConfirmationTargetHref(item.href) : null;
  if (!href) return null;
  const isInternal = href.startsWith("/") || href.startsWith("#");
  const className =
    "inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";
  const label = (
    <>
      Open
      {isInternal ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ExternalLink className="h-3 w-3" aria-hidden />}
    </>
  );
  if (isInternal) {
    return (
      <Link to={href} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {label}
    </a>
  );
}

function ItemVerdictSegmentedControl({
  itemId,
  verdicts,
  value,
  disabled,
  onSelect,
}: {
  itemId: string;
  verdicts: RequestItemVerdictValue[];
  value: RequestItemVerdictValue | null;
  disabled: boolean;
  onSelect: (verdict: RequestItemVerdictValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Choose a verdict"
      className="flex shrink-0 flex-wrap items-center gap-2"
    >
      {verdicts.map((verdict) => {
        const active = value === verdict;
        const variant = verdict === "reject"
          ? (active ? "destructive" : "outline")
          : verdict === "approve"
            ? (active ? "default" : "outline")
            : (active ? "secondary" : "outline");
        const Icon = verdict === "approve" ? Check : verdict === "reject" ? X : MinusCircle;
        return (
          <Button
            key={verdict}
            type="button"
            size="sm"
            variant={variant}
            disabled={disabled}
            aria-pressed={active}
            aria-label={`${VERDICT_LABEL[verdict]} this item`}
            className="min-h-11 min-w-24"
            onClick={() => onSelect(verdict)}
            data-verdict={verdict}
            data-item-id={itemId}
            data-active={active}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {VERDICT_LABEL[verdict]}
          </Button>
        );
      })}
    </div>
  );
}

interface VerdictDraft {
  verdict: RequestItemVerdictValue;
  reason: string;
}

function RequestItemVerdictsCard({
  interaction,
  onSubmitInteractionVerdicts,
  externalReferences,
}: {
  interaction: RequestItemVerdictsInteraction;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: { id: string; verdict: RequestItemVerdictValue; reason?: string }[],
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const payload = interaction.payload;
  const items = payload.items;
  const enabledVerdicts = useMemo<RequestItemVerdictValue[]>(
    () => payload.verdicts ?? ["approve", "reject"],
    [payload.verdicts],
  );
  const requireReasonOn = useMemo(
    () => new Set<RequestItemVerdictValue>(payload.requireReasonOn ?? ["reject"]),
    [payload.requireReasonOn],
  );
  const allowBulkApprove = payload.allowBulkApprove !== false && enabledVerdicts.includes("approve");
  const reasonLabel = payload.reasonLabel ?? "Reason";

  const resolvedById = useMemo(
    () => new Map<string, RequestItemVerdictsResultItem>((interaction.result?.items ?? []).map((item) => [item.id, item])),
    [interaction.result],
  );

  const [drafts, setDrafts] = useState<Map<string, VerdictDraft>>(new Map());
  const [applyingItemIds, setApplyingItemIds] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // When the server merges newly-resolved items, drop their local drafts and
  // clear the applying/working state so the terminal chips take over (S3 → S4).
  useEffect(() => {
    setDrafts((current) => {
      let changed = false;
      const next = new Map(current);
      for (const id of [...next.keys()]) {
        if (resolvedById.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setApplyingItemIds(new Set());
    setWorking(false);
    setActionError(null);
  }, [resolvedById]);

  const progress = getItemVerdictProgress({ payload, result: interaction.result });
  const isTerminal = interaction.status !== "pending";
  const isExpired = interaction.status === "expired";
  const isComplete = interaction.status === "answered" || progress.decided === progress.total;

  const draftEntries = [...drafts.entries()];
  const draftCount = draftEntries.length;
  const invalidDraftIds = new Set(
    draftEntries
      .filter(([, draft]) => requireReasonOn.has(draft.verdict) && draft.reason.trim().length === 0)
      .map(([id]) => id),
  );
  // Apply is enabled as soon as there is ≥1 draft (spec §1). If a required
  // reject reason is missing, clicking Apply reveals the inline error instead
  // of silently submitting — the reason gates the actual submit (spec AC).
  const hasDrafts = draftCount > 0 && !working && Boolean(onSubmitInteractionVerdicts);
  const canApply = hasDrafts && invalidDraftIds.size === 0;

  function toggleDraft(itemId: string, verdict: RequestItemVerdictValue) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(itemId);
      if (existing?.verdict === verdict) {
        next.delete(itemId); // per-item undo
      } else {
        next.set(itemId, { verdict, reason: existing?.reason ?? "" });
      }
      return next;
    });
  }

  function setDraftReason(itemId: string, reason: string) {
    setDrafts((current) => {
      const existing = current.get(itemId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(itemId, { ...existing, reason });
      return next;
    });
  }

  function handleApproveAll() {
    if (!allowBulkApprove) return;
    setDrafts((current) => {
      const next = new Map(current);
      for (const id of progress.pendingItemIds) {
        const existing = next.get(id);
        next.set(id, { verdict: "approve", reason: existing?.reason ?? "" });
      }
      return next;
    });
  }

  async function handleApply() {
    setAttempted(true);
    if (!onSubmitInteractionVerdicts || draftCount === 0 || invalidDraftIds.size > 0) return;
    const verdicts = draftEntries.map(([id, draft]) => ({
      id,
      verdict: draft.verdict,
      reason: draft.reason.trim() ? draft.reason.trim() : undefined,
    }));
    setWorking(true);
    setApplyingItemIds(new Set(verdicts.map((entry) => entry.id)));
    setActionError(null);
    try {
      await onSubmitInteractionVerdicts(interaction, verdicts);
      // Success: the parent refetch updates `interaction.result`, the effect
      // above clears drafts + applying state, and terminal chips render.
    } catch {
      setActionError("Try again");
      setApplyingItemIds(new Set());
      setWorking(false);
    }
  }

  const applyLabel = draftCount === 0
    ? "Apply 0 decisions"
    : `Apply ${draftCount} decision${draftCount === 1 ? "" : "s"}`;

  return (
    <div className="space-y-4">
      {/* Prompt + details (S1) */}
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm leading-6 text-foreground">{payload.prompt}</div>
          <VerdictProgressBadge progress={progress} pendingReason={invalidDraftIds.size > 0} />
        </div>
        {payload.detailsMarkdown ? (
          <div className="border-t border-border/60 pt-3 text-sm">
            <MarkdownBody externalReferences={externalReferences}>{payload.detailsMarkdown}</MarkdownBody>
          </div>
        ) : null}
        {interaction.payload.target ? (
          <RequestConfirmationTargetChip interaction={interaction} target={interaction.payload.target} />
        ) : null}
      </div>

      {/* Stale / superseded notice (S6) */}
      {isExpired ? (
        <div className="rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            {interaction.result?.outcome === "superseded_by_comment"
              ? "This review expired after a later comment."
              : interaction.result?.outcome === "stale_target"
                ? "This review expired after the target changed."
                : "This review expired."}
          </div>
          {progress.decided > 0 ? (
            <p className="mt-1 text-xs leading-5">
              {progress.decided === 1 ? "1 item was" : `${progress.decided} items were`} already applied and cannot be
              reverted. Remaining items were cancelled.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Item list (S1/S2/S3/S4) */}
      <ul className="space-y-2" aria-label="Items to review">
        {items.map((item) => {
          const resolved = resolvedById.get(item.id);
          const applying = applyingItemIds.has(item.id);
          const draft = drafts.get(item.id);
          return (
            <li
              key={item.id}
              className={cn(
                "rounded-sm border border-border/70 bg-background/60 p-3",
                draft && !resolved && "border-border",
              )}
              data-item-id={item.id}
              data-item-state={resolved ? "resolved" : applying ? "applying" : draft ? "draft" : "pending"}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium leading-5 text-foreground">{item.label}</span>
                    <ItemVerdictDeepLink item={item} />
                  </div>
                  {item.description ? (
                    <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{item.description}</p>
                  ) : null}
                  {item.previewMarkdown ? (
                    <div className="mt-2 rounded-sm border border-border/50 bg-muted/20 px-2.5 py-2 text-xs">
                      <MarkdownBody externalReferences={externalReferences}>{item.previewMarkdown}</MarkdownBody>
                    </div>
                  ) : null}
                  {resolved?.reason ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      <span className="font-medium text-foreground">{reasonLabel}: </span>
                      {resolved.reason}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {resolved ? (
                    <VerdictConsequenceChip verdict={resolved.verdict} />
                  ) : applying ? (
                    <span className="inline-flex items-center gap-1.5 rounded-sm border border-border/70 bg-muted/40 px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                      Applying…
                    </span>
                  ) : isTerminal ? (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-muted/30 px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                      Not decided
                    </span>
                  ) : (
                    <ItemVerdictSegmentedControl
                      itemId={item.id}
                      verdicts={enabledVerdicts}
                      value={draft?.verdict ?? null}
                      disabled={working}
                      onSelect={(verdict) => toggleDraft(item.id, verdict)}
                    />
                  )}
                </div>
              </div>

              {/* Draft reason field (S2) — reveals when the draft verdict needs a reason */}
              {!resolved && !applying && draft && requireReasonOn.has(draft.verdict) ? (
                <div className="mt-3 space-y-1.5">
                  <label
                    htmlFor={`${interaction.id}-${item.id}-reason`}
                    className="text-xs font-medium text-foreground"
                  >
                    {reasonLabel}
                  </label>
                  <Textarea
                    id={`${interaction.id}-${item.id}-reason`}
                    value={draft.reason}
                    onChange={(event) => setDraftReason(item.id, event.target.value)}
                    placeholder="Give the agent a reason so it can act on this item."
                    aria-invalid={attempted && invalidDraftIds.has(item.id)}
                    className={cn(
                      "min-h-16 bg-background text-sm",
                      attempted && invalidDraftIds.has(item.id) && "border-rose-500 focus-visible:ring-rose-500/25",
                    )}
                  />
                  {attempted && invalidDraftIds.has(item.id) ? (
                    <p className="text-xs text-destructive">A reason is required to {VERDICT_LABEL[draft.verdict].toLowerCase()} this item.</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Complete summary (S5) */}
      {isComplete && !isExpired ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          <span className="font-medium">
            {progress.decided} decided · {progress.approved} approved · {progress.rejected} rejected
            {progress.deferred > 0 ? ` · ${progress.deferred} deferred` : ""}
          </span>
        </div>
      ) : null}

      {/* Pinned batch bar (S1/S2) — only while items remain actionable */}
      {!isTerminal && progress.pendingItemIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="text-xs text-muted-foreground">
            {draftCount > 0
              ? `${draftCount} draft verdict${draftCount === 1 ? "" : "s"} ready to apply`
              : "Mark verdicts, then apply them in one pass."}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {allowBulkApprove ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={working || progress.pendingItemIds.length === 0}
                onClick={handleApproveAll}
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />
                Approve all
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              aria-disabled={!canApply}
              disabled={!hasDrafts}
              onClick={() => void handleApply()}
            >
              {working ? (
                <>
                  <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  Applying…
                </>
              ) : (
                applyLabel
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
  );
}

function VerdictProgressBadge({
  progress,
  pendingReason,
}: {
  progress: ReturnType<typeof getItemVerdictProgress>;
  pendingReason: boolean;
}) {
  const pct = progress.total > 0 ? Math.round((progress.decided / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      {/* Von Restorff accent when a draft reject is missing its reason */}
      {pendingReason ? (
        <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-900 dark:text-amber-100">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Reason needed
        </span>
      ) : null}
      <div
        className="flex items-center gap-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.decided}
        aria-label={`${progress.decided} of ${progress.total} decided`}
      >
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
          {progress.decided} of {progress.total} decided
        </span>
      </div>
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
  onCancelInteraction,
  onSubmitInteractionVerdicts,
  onUploadImage,
  externalReferences,
}: IssueThreadInteractionCardProps) {
  const isPlan = isPlanConfirmation(interaction);
  const isToolAction =
    interaction.kind === "request_confirmation" && isToolActionConfirmation(interaction);
  const toolActionState =
    isToolAction && interaction.kind === "request_confirmation"
      ? toolActionCardState(interaction)
      : null;
  const toolActionStyles = toolActionState ? toolActionStatusClasses(toolActionState) : null;
  const resumeFailure = requestConfirmationResumeFailure(interaction);
  const planStyles = isPlan ? planStatusClasses(interaction.status, resumeFailure) : null;
  const activeStyles = toolActionStyles ?? planStyles;
  const StatusIcon = activeStyles ? activeStyles.Icon : statusIcon(interaction.status);
  const iconSpin = toolActionStyles?.spin ?? false;
  const styles = activeStyles ?? statusClasses(interaction.status);
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
    <div className={cn("rounded-lg border p-5 shadow-none", styles.shell)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-sm border px-2.5 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)", styles.badge)}>
              <StatusIcon className={cn("h-3.5 w-3.5", iconSpin && "animate-spin")} />
              {isPlan ? "Plan" : interactionKindLabel(interaction.kind)}
              <span className="text-current/60">/</span>
              {activeStyles ? activeStyles.label : statusLabel(interaction.status)}
            </span>
          </div>

          <div className="mt-3 text-lg font-bold text-foreground">
            {interaction.title
              ?? (interaction.kind === "suggest_tasks"
                ? "Suggested task tree"
                : interaction.kind === "ask_user_questions"
                  ? interaction.payload.title ?? "Questions for the operator"
                : interaction.kind === "request_checkbox_confirmation"
                  ? "Checkbox confirmation requested"
                  : isToolAction
                    ? "Tool approval requested"
                    : interaction.kind === "request_item_verdicts"
                      ? "Review these items"
                      : isPlan
                        ? "Plan review"
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
            onCancelInteraction={onCancelInteraction}
            externalReferences={externalReferences}
          />
        ) : interaction.kind === "request_checkbox_confirmation" ? (
          <RequestCheckboxConfirmationCard
            interaction={interaction}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            externalReferences={externalReferences}
          />
        ) : isToolAction && interaction.kind === "request_confirmation" && toolActionState ? (
          <RequestToolActionCard
            interaction={interaction}
            state={toolActionState}
            resolvedByLabel={resolvedByLabel}
            requestedByLabel={createdByLabel}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            externalReferences={externalReferences}
          />
        ) : interaction.kind === "request_item_verdicts" ? (
          <RequestItemVerdictsCard
            interaction={interaction}
            onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
            externalReferences={externalReferences}
          />
        ) : (
          <RequestConfirmationCard
            interaction={interaction}
            isPlan={isPlan}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        )}
      </div>

      {resolvedByLabel && !isToolAction ? (
        <div className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Resolved by <span className="font-medium text-foreground">{resolvedByLabel}</span>
          {interaction.resolvedAt ? ` on ${formatShortDate(interaction.resolvedAt)}` : ""}
        </div>
      ) : null}
    </div>
  );
}
