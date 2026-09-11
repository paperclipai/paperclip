import { i18n, t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent } from "@paperclipai/shared";
import { AlertTriangle, ArrowUpRight, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock, ExternalLink, FileText, GitBranch, ImagePlus, KeyRound, Loader2, MessageSquareQuote, MinusCircle, ShieldAlert, ThumbsUp, TriangleAlert, Wrench, X, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { formatAssigneeUserDisplayLabel as formatAssigneeUserLabel } from "../lib/assignees";
import { describeInteractionAudienceDisplay as describeInteractionAudience, type InteractionAudienceDescription } from "../lib/interaction-audience";
import { InteractionResolutionDisplayError } from "../lib/interaction-resolution-error";
import {
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getCheckboxConfirmationSelectedLabels,
  getItemVerdictProgress,
  getQuestionAnswerLabels,
  shouldHideInteractionCard,
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
import { InteractionAudienceLine } from "./InteractionAudienceLine";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { PriorityIcon } from "./PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ProposalJustification } from "../pages/secrets/proposal-review";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";

const OTHER_ANSWER_ID = "__paperclip_other__";

/**
 * The card's server-evaluated audience, shared with the per-kind subcards below
 * (PAP-17287). A subcard that catches a rejected resolution needs to name who
 * *can* respond, and re-deriving the audience per subcard would let two parts of
 * the same card describe one policy differently.
 */
const InteractionAudienceContext = createContext<InteractionAudienceDescription | null>(null);

/**
 * Turns a rejected resolution into copy for the inline error region: the
 * server's own denial reason, plus who can respond when the denial is an
 * audience refusal. Never invites a retry that policy will refuse again.
 */
function useResolutionErrorMessage() {
  const audience = useContext(InteractionAudienceContext);
  return (error: unknown) => new InteractionResolutionDisplayError(error, audience);
}

/**
 * The inline resolution error. Announced through an `aria-live` region because a
 * denial is the only feedback a failed decision gets — the row stays put and no
 * toast fires on the attention surface.
 *
 * The live region is the *outer* wrapper, mounted whether or not there is a
 * message: a region has to be in the accessibility tree before its content
 * changes for the change to be announced. The styled inner div deliberately
 * carries no `role="alert"` — `alert` is itself an assertive live region, and
 * nesting one inside another makes some screen reader / browser pairs announce
 * the same denial twice (PAP-17289).
 */
function InteractionActionError({ message }: { message: InteractionResolutionDisplayError | null }) {
  useTranslation();
  return (
    <div aria-live="assertive" data-testid="interaction-action-error">
      {message ? (
        <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message.displayMessage}
        </div>
      ) : null}
    </div>
  );
}

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
    rememberAction?: boolean,
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
  /** Render confirmation CTAs with the primary action rightmost (task-chat grammar). */
  primaryActionOnRight?: boolean;
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
    return formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ?? t("localizationActivity.board");
  }
  return t("common.unknown");
}

/**
 * Administrative terminal outcomes (P1): an interaction that was withdrawn by
 * its board/agent, or auto-expired when its issue reached a terminal state.
 * Both are stored as `status="cancelled"|"expired"` with the distinguishing
 * fact carried on `result.outcome` (there is no dedicated `withdrawn` status).
 */
function getAdministrativeOutcome(
  interaction: IssueThreadInteraction,
): "withdrawn" | "issue_closed" | null {
  const result = interaction.result;
  if (result && typeof result === "object" && "outcome" in result) {
    const outcome = (result as { outcome?: string | null }).outcome;
    if (outcome === "withdrawn" || outcome === "issue_closed") return outcome;
  }
  return null;
}

function getAdministrativeReason(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result;
  if (result && typeof result === "object" && "reason" in result) {
    const reason = (result as { reason?: string | null }).reason;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  }
  return null;
}

function statusLabel(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "pending":
      return t("localizationIssueDetail.ui_Pending");
    case "accepted":
      return t("localizationIssueDetail.ui_Accepted");
    case "rejected":
      return t("localizationIssueDetail.ui_Rejected");
    case "answered":
      return t("localizationIssueDetail.ui_Answered");
    case "cancelled":
      return t("localizationIssueDetail.ui_Cancelled");
    case "expired":
      return t("pages.tasks.expired");
    case "failed":
      return t("status.failed");
    default:
      return status;
  }
}

function interactionKindLabel(kind: IssueThreadInteraction["kind"]) {
  switch (kind) {
    case "suggest_tasks":
      return t("localizationSettings.kind_suggest_tasks");
    case "ask_user_questions":
      return t("localizationSettings.kind_ask_user_questions");
    case "request_confirmation":
      return t("localizationIssueDetail.ui_Confirmation");
    case "request_checkbox_confirmation":
      return t("localizationIssueDetail.ui_Checkbox_confirmation");
    case "request_item_verdicts":
      return t("localizationIssueDetail.ui_Item_verdicts");
    case "connection_intent":
      return t("localizationIssueDetail.ui_Connection_request");
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
  outcome?: string | null,
) {
  switch (status) {
    case "accepted":
    case "answered":
      if (resumeFailure) {
        return {
          shell: "border-2 border-amber-500/70 bg-transparent",
          badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
          get label() { return t("localizationIssueDetail.ui_Approved_agent_resume_failed"); },
          Icon: AlertTriangle,
        };
      }
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        get label() { return t("status.approved"); },
        Icon: CheckCircle2,
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: outcome === "withdrawn" ? t("localizationIssueDetail.ui_Withdrawn") : t("pages.pipelines.changesRequested"),
        Icon: XCircle,
      };
    case "failed":
    case "expired":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        get label() { return t("pages.tasks.expired"); },
        Icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        get label() { return t("pages.pipelines.inReview"); },
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

function secretProposalPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["secretProposal"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.secretProposal ?? null;
}

function isSecretProposalConfirmation(interaction: IssueThreadInteraction): boolean {
  return secretProposalPayload(interaction) != null;
}

/**
 * A `request_confirmation` carrying `payload.connectionAuthorization` is asking
 * one person to connect their own account so an agent can act as them
 * (PAP-17835). It keeps the interaction kind and the server-addressed audience;
 * only the presentation differs, and it reads that presentation from the payload
 * rather than parsing the title string.
 */
function connectionAuthorizationPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["connectionAuthorization"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.connectionAuthorization ?? null;
}

/**
 * The five states the connection-authorization card can be read in (PAP-17859).
 *
 * `actionable` and `waiting` are the *same* pending row seen by two different
 * readers: consent belongs to the addressed person alone, so who is looking
 * changes what may be offered — not merely whether a button is greyed out.
 */
type ConnectionAuthorizationCardState =
  | "actionable"
  | "waiting"
  | "connected"
  | "declined"
  | "expired";

function connectionAuthorizationCardState({
  interaction,
  isAddressee,
}: {
  interaction: RequestConfirmationInteraction;
  isAddressee: boolean;
}): ConnectionAuthorizationCardState {
  if (interaction.status === "accepted") return "connected";
  if (interaction.status === "rejected") return "declined";
  if (interaction.status === "pending") return isAddressee ? "actionable" : "waiting";
  // expired / cancelled / failed all mean the same thing to a reader here: the
  // authorization run this card carried is over.
  return "expired";
}

/**
 * True only when the signed-in reader *is* the person the server addressed.
 *
 * Deliberately strict: an unknown viewer (`currentUserId` not loaded yet) is
 * never treated as the addressee, so the Connect action cannot flash into view
 * for someone who may not consent. The server re-authorizes the callback
 * regardless; this only decides what the card offers.
 */
function isConnectionAuthorizationAddressee({
  interaction,
  currentUserId,
}: {
  interaction: RequestConfirmationInteraction;
  currentUserId?: string | null;
}): boolean {
  const addressee = interaction.addresseeUserId;
  if (!addressee || !currentUserId) return false;
  return addressee === currentUserId;
}

/**
 * The authorization URL this card may open, or `null`.
 *
 * A target is offered **only while the interaction is pending**. The server
 * re-upserts this row with a freshly minted `state` every time it starts a new
 * authorization run, so a pending card always carries a live target and a
 * resolved/declined/expired one always carries a spent one. Gating on the
 * status is therefore how "never reuse an expired OAuth URL" is enforced —
 * there is no client-visible expiry on the payload to check instead.
 */
function connectionAuthorizationHref(interaction: RequestConfirmationInteraction): string | null {
  if (interaction.status !== "pending") return null;
  const href = interaction.payload.target?.href;
  if (!href) return null;
  return normalizeRequestConfirmationTargetHref(href);
}

type ToolActionCardState =
  | "pending"
  | "running"
  | "executed"
  | "failed"
  | "cancelled"
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
  if (interaction.status === "cancelled") return "cancelled";
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
        get label() { return t("localizationIssueDetail.ui_Running"); },
        Icon: Loader2,
        spin: true,
      };
    case "executed":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        get label() { return t("localizationIssueDetail.ui_Executed"); },
        Icon: CheckCircle2,
      };
    case "failed":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        get label() { return t("status.failed"); },
        Icon: XCircle,
      };
    case "declined":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        get label() { return t("pages.apps.review.declinedTitle"); },
        Icon: XCircle,
        dimmed: true,
      };
    case "cancelled":
      return { shell: "border-2 border-border bg-transparent", badge: "border-border bg-muted text-muted-foreground", label: t("localizationIssueDetail.ui_Cancelled"), Icon: XCircle, dimmed: true };
    case "expired":
      return {
        shell: "border-2 border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        get label() { return t("pages.tasks.expired"); },
        Icon: Clock,
        dimmed: true,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        get label() { return t("localizationIssueDetail.ui_Awaiting_approval"); },
        Icon: ShieldAlert,
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
  useTranslation();
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
  const { t } = useTranslation();
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
                  aria-label={t("localizationIssueDetail.includeTask", { title: node.task.title })}
                  className="mt-0.5"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
                  {SHOW_TASK_PRIORITY_UI && node.task.priority ? (
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
                    {t("localizationIssueDetail.ui_Child_task")}
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
              {t("pages.secrets.status.skipped")}
            </span>
          ) : null}
        </div>

        {hasMetadata ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasExplicitAssignee ? (
              <TaskField label={t("localizationFilters.responsible")} value={assigneeLabel} />
            ) : null}
            {node.task.billingCode ? (
              <TaskField label={t("localizationIssueDetail.ui_Billing")} value={node.task.billingCode} />
            ) : null}
            {node.task.projectId ? (
              <TaskField label={t("pages.inbox.groupByProject")} value={node.task.projectId} tone="subtle" />
            ) : null}
            {labels.map((label) => (
              <TaskField key={label} label={t("localizationFilters.label")} value={label} tone="subtle" />
            ))}
          </div>
        ) : null}

        {hiddenChildCount > 0 ? (
          <div className="mt-2 flex items-center gap-2 rounded-sm border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t("localizationIssueDetail.hiddenFollowOn", { count: hiddenChildCount })}
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
  const { t } = useTranslation();
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
    [i18n.resolvedLanguage, interaction.payload.tasks],
  );
  const createdByClientKey = useMemo(
    () => createdTaskMap(interaction.result?.createdTasks),
    [i18n.resolvedLanguage, interaction.result?.createdTasks],
  );
  const skippedClientKeys = useMemo(
    () => new Set(interaction.result?.skippedClientKeys ?? []),
    [i18n.resolvedLanguage, interaction.result?.skippedClientKeys],
  );
  const totalTasks = interaction.payload.tasks.length;
  const [selectedClientKeys, setSelectedClientKeys] = useState<Set<string>>(
    () => new Set(interaction.payload.tasks.map((task) => task.clientKey)),
  );
  const taskSelectionSeed = useMemo(
    () => interaction.payload.tasks.map((task) => task.clientKey).join("\n"),
    [i18n.resolvedLanguage, interaction.payload.tasks],
  );

  useEffect(() => {
    setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)));
  }, [interaction.id, interaction.status, taskSelectionSeed]);

  const taskByClientKey = useMemo(
    () => new Map(interaction.payload.tasks.map((task) => [task.clientKey, task] as const)),
    [i18n.resolvedLanguage, interaction.payload.tasks],
  );
  const selectedCount = selectedClientKeys.size;
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const createdCount = interaction.result?.createdTasks?.length ?? 0;
  const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction, [...selectedClientKeys]);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
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
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
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
        <span>{t("localizationIssueDetail.draftIssues", { count: totalTasks })}</span>
        {interaction.payload.defaultParentId ? (
          <TaskField label={t("localizationIssueDetail.ui_Default_parent")} value={interaction.payload.defaultParentId} tone="subtle" />
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
            {t("localizationIssueDetail.ui_Resolution_summary")}
          </div>
          <p className="mt-1 leading-6">
            {skippedCount > 0
              ? t("localizationIssueDetail.createdDraftsSkipped", { count: createdCount, skipped: skippedCount })
              : t("localizationIssueDetail.createdAllDrafts", { count: createdCount })}
          </p>
        </div>
      ) : null}

      {interaction.status === "rejected" ? (
        <div className="rounded-sm border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-rose-700">
            {t("localizationIssueDetail.ui_Rejection_reason")}
          </div>
          <p className={cn(
            "mt-1 leading-6",
            !interaction.result?.rejectionReason && "text-rose-900/75",
          )}>
            {interaction.result?.rejectionReason || t("localizationIssueDetail.ui_No_reason_provided")}
          </p>
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selectedCount === totalTasks
                  ? t("localizationIssueDetail.allDraftsSelected", { count: totalTasks })
                  : t("localizationIssueDetail.draftsSelected", { count: totalTasks, selected: selectedCount })}
              </span>
              {selectedCount < totalTasks ? (
                <span>
                  {t("localizationIssueDetail.draftsWillSkip", { count: totalTasks - selectedCount })}
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
                    {t("localizationIssueDetail.ui_Accepting")}
                  </>
                ) : (
                  selectedCount === totalTasks ? t("localizationIssueDetail.ui_Accept_drafts") : t("localizationIssueDetail.ui_Accept_selected_drafts")
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => setRejecting((current) => !current)}
              >
                {t("pages.inbox.reject")}
              </Button>
              {selectedCount < totalTasks ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)))}
                >
                  {t("localizationIssueDetail.ui_Reset_selection")}
                </Button>
              ) : null}
            </div>
          </div>

          {rejecting ? (
            <div className="space-y-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder={t("localizationIssueDetail.ui_Add_a_short_reason_for_rejecting_this_suggestion")}
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
                      {t("pages.companySettings.saving")}
                    </>
                  ) : (
                    t("localizationIssueDetail.ui_Save_rejection")
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          <InteractionActionError message={actionError} />
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
  useTranslation();
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
  const { t } = useTranslation();
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
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

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

  function toggleOption(
    questionId: string,
    optionId: string,
    selectionMode: "single" | "multi",
    isFreeText = false,
  ) {
    // A free-text option is a first-class version of the built-in "Other"
    // affordance: selecting it reveals the inline text field and its typed
    // value is submitted as the question's `otherText`.
    if (optionId === OTHER_ANSWER_ID || isFreeText) {
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
    setActionError(null);
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
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function handleCancel() {
    if (!onCancelInteraction) return;
    setCancelling(true);
    setActionError(null);
    try {
      await onCancelInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="border-border/70 bg-background/70 px-2.5 py-1 uppercase tracking-(--tracking-eyebrow) text-foreground/70">
          <MessageSquareQuote className="h-3 w-3" />
          {t("pages.companySettings.interactionKind.askUserQuestions")}
        </Badge>
        <span>
          {t("localizationIssueDetail.questionCount", { count: questions.length })}
        </span>
      </div>

      {interaction.status === "pending" ? (
        <div className="space-y-4">
          {questions.map((question, index) => {
            const hasFreeTextOption = question.options.some(
              (option) => option.freeText === true,
            );
            return (
            <div
              key={question.id}
              className="rounded-2xl border border-border/70 bg-background/82 p-4 shadow-(--shadow-extract-9)"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {t("localizationIssueDetail.ui_Question")} {index + 1}
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
                  label={question.selectionMode === "single" ? t("localizationIssueDetail.ui_Pick") : t("localizationIssueDetail.pickMultiple")}
                  value={question.required ? t("localizationIssueDetail.ui_Required") : t("pages.secrets.common.optionalPlain")}
                  tone="subtle"
                />
              </div>

              <div className="mt-3 space-y-3">
                <div
                  className="grid gap-3"
                  role={question.selectionMode === "single" ? "radiogroup" : "group"}
                  aria-labelledby={`${interaction.id}-${question.id}-prompt`}
                >
                  {question.options.map((option) => {
                    const isFreeText = option.freeText === true;
                    const optionSelected = isFreeText
                      ? otherActiveQuestions[question.id] === true
                      : (draftAnswers[question.id] ?? []).includes(option.id);
                    return (
                      <div key={option.id} className="space-y-2">
                        <QuestionOptionButton
                          id={`${interaction.id}-${question.id}-${option.id}`}
                          label={option.label}
                          description={option.description}
                          selected={optionSelected}
                          selectionMode={question.selectionMode}
                          onClick={() =>
                            toggleOption(question.id, option.id, question.selectionMode, isFreeText)}
                        />
                        {isFreeText && optionSelected ? (
                          <Textarea
                            aria-label={t("localizationIssueDetail.answerFor", { question: question.prompt })}
                            value={draftOtherAnswers[question.id] ?? ""}
                            onChange={(event) =>
                              setDraftOtherAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))}
                            placeholder={t("localizationIssueDetail.ui_Type_your_answer")}
                            className="min-h-24 bg-background text-sm"
                            autoFocus
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {/*
                 * The built-in "Other" link is the fallback free-text affordance.
                 * Suppress it when the agent already authored a first-class
                 * free-text option so the card never shows two ways to type an
                 * answer (PAP-419).
                 */}
                {hasFreeTextOption || question.allowOther === false ? null : (
                  <>
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
                    >{t("pages.dashboard.chartOther")}</button>
                    {otherActiveQuestions[question.id] ? (
                      <Textarea
                        aria-label={t("localizationIssueDetail.otherAnswerFor", { question: question.prompt })}
                        value={draftOtherAnswers[question.id] ?? ""}
                        onChange={(event) =>
                          setDraftOtherAnswers((current) => ({
                            ...current,
                            [question.id]: event.target.value,
                          }))}
                        placeholder={t("localizationIssueDetail.ui_Type_your_answer")}
                        className="min-h-24 bg-background text-sm"
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="text-sm text-muted-foreground">
              {t("localizationIssueDetail.ui_Submit_once_after_you_finish_the_full_form")}
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
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />{t("pages.cliAuth.cancelling")}</>
                  ) : (
                    t("localizationIssueDetail.ui_Cancel_question")
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
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />{t("pages.pipelines.submitting")}</>
                ) : (
                  interaction.payload.submitLabel ?? t("localizationIssueDetail.ui_Submit_answers")
                )}
              </Button>
            </div>
          </div>

          <InteractionActionError message={actionError} />
        </div>
      ) : interaction.status === "cancelled" ? (
        <div className="rounded-2xl border border-rose-300/60 bg-rose-50/85 p-4 text-sm leading-6 text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
          <div className="font-semibold">
            {interaction.result?.outcome === "withdrawn"
              ? t("localizationIssueDetail.questionWithdrawn", { count: questions.length })
              : t("localizationIssueDetail.ui_Question_cancelled")}
          </div>
          {interaction.result?.cancellationReason ? (
            <p className="mt-1">{interaction.result.cancellationReason}</p>
          ) : interaction.result?.reason ? (
            <p className="mt-1">{interaction.result.reason}</p>
          ) : (
            <p className="mt-1">{t("localizationIssueDetail.ui_No_answer_was_recorded")}</p>
          )}
        </div>
      ) : interaction.status === "expired" ? (
        <div className="rounded-2xl border border-amber-300/70 bg-amber-50/85 p-4 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {interaction.result?.outcome === "issue_closed"
              ? t("localizationIssueDetail.questionClosed", { count: questions.length })
              : t("localizationIssueDetail.questionComment", { count: questions.length })}
          </div>
          <p className="mt-1">
            {interaction.result?.outcome === "issue_closed"
              ? t("localizationIssueDetail.ui_This_question_request_expired_automatically_when_the_issue_reached_a_terminal_state")
              : t("localizationIssueDetail.ui_A_later_board_user_comment_superseded_this_question_request_Create_a_fresh_request_if")}
          </p>
          {interaction.result?.commentId ? (
            <a
              href={`#comment-${interaction.result.commentId}`}
              className="mt-3 inline-flex text-sm font-medium underline underline-offset-4"
            >
              {t("localizationIssueDetail.ui_Jump_to_comment")}
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
                      <TaskField key={label} label={t("localizationIssueDetail.ui_Answer")} value={label} />
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("localizationIssueDetail.ui_No_answer_recorded")}</span>
                  )}
                </div>
              </div>
            );
          })}

          {interaction.result?.summaryMarkdown ? (
            <div className="rounded-2xl border border-emerald-300/60 bg-emerald-50/85 p-4">
              <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-emerald-700">
                {t("localizationIssueDetail.ui_Submitted_summary")}
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
    return t("localizationIssueDetail.planRevision", { revision });
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
  useTranslation();
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
  const { t } = useTranslation();
  const outcome = interaction.result?.outcome;
  const target = interaction.payload.target ?? null;
  const staleTarget = interaction.result?.staleTarget ?? null;

  if (interaction.status === "accepted") {
    const resumeFailure = requestConfirmationResumeFailure(interaction);
    if (resumeFailure) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
            <span className="font-medium">{t("localizationIssueDetail.ui_Confirmed")}</span>
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
          <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
              {t("localizationIssueDetail.ui_Agent_resume_failed")}
            </div>
            <p className="mt-1 leading-6">
              {resumeFailure.status === "retrying"
                ? t("localizationIssueDetail.resumeRetry", { attempt: resumeFailure.attempt, max: resumeFailure.maxAttempts })
                : t("localizationIssueDetail.ui_Paperclip_needs_attention_before_the_agent_can_resume_this_approved_work")}
            </p>
            {resumeFailure.errorCode ? (
              <p className="mt-1 leading-6">
                {t("localizationIssueDetail.ui_Latest_cause")} <code className="font-mono text-(length:--text-micro)">{resumeFailure.errorCode}</code>
              </p>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">{t("localizationIssueDetail.ui_Confirmed")}</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">{t("pages.apps.review.declinedTitle")}</span>
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

  if (interaction.status === "cancelled" && outcome === "withdrawn") {
    // Withdrawn is a neutral administrative retraction (P4 design review): the
    // card-level withdrawn footer carries the "Withdrawn by …" attribution and
    // reason, so this body only anchors the target chip — no rose/red styling
    // and no duplicated reason text.
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">{t("localizationIssueDetail.ui_Withdrawn")}</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "expired") {
    const expiredByComment = outcome === "superseded_by_comment";
    const expiredByIssueClosed = outcome === "issue_closed";
    const expiredByTargetChange = outcome === "stale_target";
    return (
      <div className="space-y-3 rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        {/*
         * issue_closed already carries its label in the header status badge
         * ("Expired · issue closed"), so this eyebrow would duplicate it
         * verbatim — only render the eyebrow for the states the header shows
         * generically as "Expired".
         */}
        {expiredByIssueClosed ? null : (
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
            {expiredByComment ? t("localizationIssueDetail.ui_Expired_by_comment") : t("localizationIssueDetail.ui_Expired_by_target_change")}
          </div>
        )}
        <p className="leading-6">
          {expiredByComment
            ? t("localizationIssueDetail.ui_A_board_comment_superseded_this_confirmation_before_it_was_resolved")
            : expiredByIssueClosed
              ? t("localizationIssueDetail.ui_This_confirmation_expired_automatically_when_the_issue_reached_a_terminal_state")
              : t("localizationIssueDetail.ui_The_requested_target_changed_before_this_confirmation_was_resolved")}
        </p>
        {expiredByComment && interaction.result?.commentId ? (
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-amber-950 hover:bg-amber-500/15 dark:text-amber-50">
            <a href={`#comment-${interaction.result.commentId}`}>{t("localizationIssueDetail.ui_Jump_to_comment")}</a>
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
        {t("localizationIssueDetail.ui_This_request_could_not_be_resolved_Try_again_or_create_a_new_request")}
      </p>
    );
  }

  return null;
}

function ToolActionResolution({
  state,
  interaction,
}: {
  state: ToolActionCardState;
  interaction: RequestConfirmationInteraction;
}) {
  const { t } = useTranslation();
  const result = interaction.result?.toolAction;
  const [resultOpen, setResultOpen] = useState(false);
  const output = state === "executed" ? result?.resultSummary?.trim() : null;
  let formattedOutput = output;
  if (output) {
    try { formattedOutput = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Plain-text results remain readable. */ }
  }
  const labels = {
    pending: t("localizationTaskExecution.waitingForApproval"),
    running: t("localizationTaskExecution.approvedRunning"),
    executed: t("localizationExternalChrome.category_succeeded"),
    failed: t("localizationTaskExecution.executionFailed"),
    declined: t("pages.apps.review.declinedTitle"),
    expired: t("localizationApps.expired146"),
    cancelled: t("localizationIssueDetail.ui_Cancelled"),
  };
  const Icon = state === "running" ? Loader2 : state === "executed" ? CheckCircle2 : state === "failed" ? AlertTriangle : state === "expired" ? Clock : MinusCircle;
  const detail = state === "failed" ? result?.errorMessage?.trim() || t("localizationTaskExecution.actionFailed")
    : state === "declined" ? interaction.result?.reason?.trim()
    : null;
  const status = <>
    <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "running" && "animate-spin", state === "failed" && "text-destructive")} />
    {labels[state]}
    {result?.rememberedAction ? t("localizationTaskExecution.alwaysAllowedSuffix") : ""}
  </>;
  return (
    <div className="space-y-1 text-sm text-muted-foreground" aria-live="polite">
      {output ? (
        <Collapsible open={resultOpen} onOpenChange={setResultOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={resultOpen ? t("localizationTaskExecution.hideResult") : t("localizationTaskExecution.showResult")}>
              {status}<ChevronDown className={cn("h-3 w-3", resultOpen && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-foreground">{formattedOutput}</pre>
          </CollapsibleContent>
        </Collapsible>
      ) : <p className="flex items-center gap-1.5">{status}</p>}
      {detail ? <p className={cn("break-words", state === "failed" && "text-destructive")}>{detail}</p> : null}
      {state === "executed" && result?.resultHref?.trim() ? (
        <a className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground" href={result.resultHref} target="_blank" rel="noreferrer">{t("localizationIssueDetail.ui_View_result")}<ExternalLink className="h-3 w-3" /></a>
      ) : null}
    </div>
  );
}

function RequestToolActionCard({
  interaction,
  state,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  state: ToolActionCardState;
  onAcceptInteraction?: IssueThreadInteractionCardProps["onAcceptInteraction"];
  onRejectInteraction?: (interaction: RequestConfirmationInteraction, reason?: string) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const { t } = useTranslation();
  const payload = interaction.payload.toolAction!;
  const [working, setWorking] = useState<"accept" | "always" | "reject" | null>(null);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const isPending = state === "pending";
  const variant = payload.risk === "destructive" ? "destructive" : "cta";

  useEffect(() => {
    if (!isPending) setWorking(null);
  }, [interaction.id, isPending]);

  async function decide(decision: "accept" | "always" | "reject") {
    setWorking(decision);
    setActionError(null);
    try {
      if (decision === "reject") await onRejectInteraction?.(interaction);
      else await onAcceptInteraction?.(interaction, undefined, undefined, decision === "always");
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="text-foreground">
      <div className="flex items-start gap-3">
        <span role="img" aria-label={payload.appDisplayName || payload.toolDisplayName}>
          <AppLogo name={payload.appDisplayName || payload.toolDisplayName} size={36} />
        </span>
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          <MarkdownBody externalReferences={externalReferences}>{payload.previewMarkdown || payload.toolDisplayName}</MarkdownBody>
          {!isPending ? <ToolActionResolution state={state} interaction={interaction} /> : null}
        </div>
      </div>
      {isPending ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={!onRejectInteraction || working !== null} onClick={() => void decide("reject")}>
            {working === "reject" ? t("localizationIssueDetail.ui_Declining") : t("localizationAttention.ui_Decline_oo69tl")}
          </Button>
          <div className="inline-flex" role="group" aria-label={t("localizationTaskExecution.approveRequest")}>
            <Button size="sm" variant={variant} className={payload.rememberActionScope ? "rounded-r-none" : undefined} disabled={!onAcceptInteraction || working !== null} onClick={() => void decide("accept")}>
              {working === "accept" || working === "always" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />{working === "always" ? t("localizationProjectRepositories.saving") : t("pages.secrets.status.approving")}</> : t("localizationIssueDetail.ui_Approve_run")}
            </Button>
            {payload.rememberActionScope ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant={variant} className="rounded-l-none border-l border-background/30" aria-label={t("localizationTaskExecution.approvalOptions")} disabled={!onAcceptInteraction || working !== null}>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void decide("always")} title={payload.rememberActionScope} aria-description={payload.rememberActionScope}>{t("localizationSettings.alwaysAllow")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
    </div>
  );
}

type SecretProposalCardState = ToolActionCardState;

function secretProposalCardState(
  interaction: RequestConfirmationInteraction,
): SecretProposalCardState {
  const proposalStatus = interaction.result?.secretProposal?.status ?? null;
  if (interaction.status === "pending") return "pending";
  if (proposalStatus === "executed") return "executed";
  if (proposalStatus === "failed" || interaction.status === "failed") return "failed";
  if (proposalStatus === "expired" || interaction.status === "expired") return "expired";
  if (
    proposalStatus === "rejected"
    || proposalStatus === "withdrawn"
    || interaction.status === "rejected"
    || interaction.status === "cancelled"
  ) {
    return "declined";
  }
  return "running";
}

function secretProposalStatusClasses(state: SecretProposalCardState): ReturnType<typeof toolActionStatusClasses> {
  if (state === "failed") {
    return {
      shell: "border-2 border-red-500/80 bg-transparent",
      badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
      get label() { return t("localizationIssueDetail.ui_FAILED"); },
      Icon: XCircle,
    };
  }
  return toolActionStatusClasses(state);
}

function SecretProposalIdentityHeader({
  state,
}: {
  state: SecretProposalCardState;
}) {
  const { t } = useTranslation();
  const dimmed = state === "declined" || state === "expired";
  return (
    <div className={cn("flex items-start gap-3", dimmed && "opacity-60 grayscale")}>
      <div
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-foreground"
      >
        <KeyRound className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-bold leading-tight text-foreground">
          {t("localizationIssueDetail.ui_Bind_an_existing_secret")}
        </div>
      </div>
    </div>
  );
}

function SecretProposalDetails({
  payload,
}: {
  payload: NonNullable<RequestConfirmationInteraction["payload"]["secretProposal"]>;
}) {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-3 rounded-sm border border-border/70 bg-muted/30 p-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {t("localizationIssueDetail.ui_Source_secret")}
        </dt>
        <dd className="truncate text-sm font-medium text-foreground">{payload.sourceSecretLabel}</dd>
      </div>
      <div className="min-w-0 space-y-1">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("pages.secrets.fields.targetAgent")}</dt>
        <dd className="truncate text-sm font-medium text-foreground">{payload.targetAgentName}</dd>
      </div>
      <div className="min-w-0 space-y-1 sm:col-span-2">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {t("localizationIssueDetail.ui_New_config_path")}
        </dt>
        <dd className="break-all font-mono text-sm text-foreground">{payload.configPath}</dd>
      </div>
    </dl>
  );
}

function SecretProposalResolution({
  interaction,
  state,
  resolvedByLabel,
}: {
  interaction: RequestConfirmationInteraction;
  state: SecretProposalCardState;
  resolvedByLabel: string | null;
}) {
  const { t } = useTranslation();
  const result = interaction.result?.secretProposal ?? null;
  const who = resolvedByLabel ?? t("localizationIssueDetail.boardActor");
  const when = interaction.resolvedAt
    ? formatDateTime(interaction.resolvedAt)
    : result?.updatedAt
      ? formatDateTime(result.updatedAt)
      : null;

  if (state === "running") {
    return (
      <div aria-live="polite" className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div>
          <div className="font-medium">{t("localizationIssueDetail.approvedBinding", { who })}</div>
          <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
            {t("localizationIssueDetail.ui_Paperclip_is_re_checking_authority_and_the_proposal_snapshot_before_writing")}
          </p>
        </div>
      </div>
    );
  }

  if (state === "executed") {
    return (
      <div aria-live="polite" className="flex items-start gap-2 rounded-sm border border-green-500/50 bg-green-500/10 px-4 py-3 text-sm text-green-900 dark:text-green-100">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">{t("localizationIssueDetail.bindingCreated", { who })}</div>
          <p className="mt-1 text-green-900/80 dark:text-green-100/80">
            {t("localizationIssueDetail.targetAgentPath", { when: when ? ` · ${when}` : "" })}
          </p>
        </div>
      </div>
    );
  }

  if (state === "failed") {
    const errorCode = result?.errorCode?.trim();
    return (
      <div aria-live="assertive" className="space-y-2 rounded-sm border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold uppercase tracking-(--tracking-eyebrow)">
              {t("localizationIssueDetail.ui_FAILED_binding_was_not_created")}
            </div>
            <p className="mt-1 text-red-900/80 dark:text-red-100/80">
              {t("localizationIssueDetail.ui_The_request_was_accepted_but_execution_failed_closed_No_secret_value_was_exposed")}
            </p>
          </div>
        </div>
        {errorCode ? (
          <div className="rounded-sm border border-red-500/50 bg-background/60 px-3 py-2">
            <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)">
              {t("localizationIssueDetail.ui_Error_code")}
            </span>{" "}
            <code className="font-mono text-foreground">{errorCode}</code>
          </div>
        ) : null}
      </div>
    );
  }

  if (state === "declined") {
    const reason = interaction.result?.reason?.trim();
    return (
      <div className="space-y-2 rounded-sm border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{t("localizationIssueDetail.rejectedBy", { who })}</div>
            <p className="mt-1 text-red-900/80 dark:text-red-100/80">{t("localizationIssueDetail.ui_The_binding_was_not_created")}</p>
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

  return (
    <div className="flex items-start gap-2 rounded-sm border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
      <Clock className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-medium text-foreground">{t("localizationIssueDetail.ui_Proposal_expired")}{when ? ` · ${when}` : ""}</div>
        <p className="mt-1">{t("localizationIssueDetail.ui_The_binding_was_not_created_A_fresh_proposal_is_required")}</p>
      </div>
    </div>
  );
}

function RequestSecretProposalCard({
  interaction,
  state,
  resolvedByLabel,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: RequestConfirmationInteraction;
  state: SecretProposalCardState;
  resolvedByLabel: string | null;
  onAcceptInteraction?: (interaction: RequestConfirmationInteraction) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const payload = interaction.payload.secretProposal!;
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const isPending = state === "pending";

  useEffect(() => {
    setActionError(null);
    if (!isPending) setWorking(null);
  }, [interaction.id, isPending]);

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason?: string) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      <SecretProposalIdentityHeader state={state} />
      <SecretProposalDetails payload={payload} />
      <ProposalJustification justification={payload.justification} />
      <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        {t("localizationIssueDetail.ui_Expires")} {formatDateTime(payload.expiresAt)}
      </div>

      {isPending ? (
        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? t("localizationIssueDetail.ui_Approve_bind")}
          reviseLabel={t("localizationIssueDetail.ui_Add_reason")}
          rejectLabel={interaction.payload.rejectLabel ?? t("pages.inbox.reject")}
          approveVariant="cta"
          allowRevise={interaction.payload.allowDeclineReason !== false}
          rejectRequiresReason={interaction.payload.rejectRequiresReason === true}
          reasonPlaceholder={interaction.payload.declineReasonPlaceholder ?? t("localizationIssueDetail.ui_Optional_explain_why_this_binding_should_not_be_created")}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
          stackActionsOnMobile
        />
      ) : (
        <SecretProposalResolution
          interaction={interaction}
          state={state}
          resolvedByLabel={resolvedByLabel}
        />
      )}
    </div>
  );
}

/**
 * The single approval grammar shared by every plan / task-approval card
 * (PAP-418): **Approve · Revise… · Reject**. "Revise…" reveals an attached text
 * field for the changes you want (the former "decline with a reason" path);
 * bare "Reject" sends the work back with no note. These are the default words —
 * producers may still override the accept/reject labels for domain-specific
 * confirmations (e.g. "Delete selected"), but the shape stays consistent.
 */
const CONFIRMATION_APPROVE_LABEL_KEY = "localizationSettings.approve";
const CONFIRMATION_REVISE_LABEL_KEY = "localizationIssueDetail.reviseAction";
const CONFIRMATION_REJECT_LABEL_KEY = "localizationSettings.reject";

/**
 * The one action control every confirmation card renders (PAP-418), collapsing
 * what used to be a two-button card plus a separate sticky Plan-pane bar into a
 * single consistent surface. Producer flags tune which affordances appear:
 * `allowDeclineReason: false` drops the Revise… path so only Approve/Reject
 * remain; `rejectRequiresReason: true` drops the bare Reject so every rejection
 * carries a note. The revise text stays attached to the card.
 */
function ConfirmationActionRow({
  resetKey,
  approveLabel,
  reviseLabel = t(CONFIRMATION_REVISE_LABEL_KEY),
  rejectLabel,
  approveVariant = "default",
  primaryActionOnRight = false,
  allowRevise,
  rejectRequiresReason,
  reasonPlaceholder,
  working,
  actionError,
  approveDisabled = false,
  canApprove,
  canReject,
  onApprove,
  onReject,
  composeReason,
  extraReasonSatisfied = false,
  revisePanelChildren,
  stackActionsOnMobile = false,
}: {
  /** Changing this (interaction id + status) collapses the revise panel and
   * clears its draft text — the row is reused across interaction updates. */
  resetKey: string;
  approveLabel: string;
  reviseLabel?: string;
  rejectLabel: string;
  approveVariant?: React.ComponentProps<typeof Button>["variant"];
  primaryActionOnRight?: boolean;
  allowRevise: boolean;
  rejectRequiresReason: boolean;
  reasonPlaceholder: string;
  working: "accept" | "reject" | null;
  actionError: InteractionResolutionDisplayError | null;
  approveDisabled?: boolean;
  canApprove: boolean;
  canReject: boolean;
  onApprove: () => void;
  onReject: (reason: string | undefined) => void;
  /** Compose the final reject reason from the typed text (plan cards append
   * screenshot markdown here). */
  composeReason?: (text: string) => string | undefined;
  /** A required reason is already satisfied by an attachment (e.g. screenshots),
   * so an empty text box should not block sending the revision. */
  extraReasonSatisfied?: boolean;
  /** Extra affordances rendered inside the revise panel (e.g. screenshot attach). */
  revisePanelChildren?: ReactNode;
  /** Give domain cards with longer action labels an intentional narrow-screen
   * hierarchy instead of relying on opportunistic flex wrapping. */
  stackActionsOnMobile?: boolean;
}) {
  const { t } = useTranslation();
  const [revising, setRevising] = useState(false);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    setRevising(false);
    setReason("");
    setAttempted(false);
  }, [resetKey]);

  const trimmed = reason.trim();
  const reasonMissing = rejectRequiresReason && trimmed.length === 0 && !extraReasonSatisfied;

  function submitRevision() {
    setAttempted(true);
    if (!canReject || reasonMissing) return;
    onReject(composeReason ? composeReason(reason) : trimmed || undefined);
  }

  return (
    <div className="space-y-3">
      <div
        data-testid="confirmation-actions"
        data-mobile-layout={stackActionsOnMobile ? "stacked" : "inline"}
        className={cn(
          stackActionsOnMobile
            ? "grid grid-cols-2 items-stretch gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
            : "flex flex-wrap items-center justify-end gap-2",
          primaryActionOnRight && "flex-row-reverse justify-start",
        )}
      >
        <Button
          size="sm"
          variant={revising ? "outline" : approveVariant}
          className={stackActionsOnMobile ? "col-span-2 w-full sm:col-auto sm:w-auto" : undefined}
          disabled={!canApprove || working !== null || approveDisabled}
          onClick={onApprove}
        >
          {working === "accept" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />{t("pages.secrets.status.approving")}</>
          ) : (
            approveLabel
          )}
        </Button>
        {allowRevise ? (
          <Button
            size="sm"
            variant="outline"
            className={stackActionsOnMobile ? "w-full sm:w-auto" : undefined}
            disabled={!canReject || working !== null}
            onClick={() => {
              setAttempted(false);
              setRevising((current) => !current);
            }}
          >
            {reviseLabel}
          </Button>
        ) : null}
        {!rejectRequiresReason ? (
          <Button
            size="sm"
            variant="ghost"
            className={stackActionsOnMobile ? "w-full sm:w-auto" : undefined}
            disabled={!canReject || working !== null}
            onClick={() => onReject(undefined)}
          >
            {working === "reject" && !revising ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />{t("pages.secrets.status.rejecting")}</>
            ) : (
              rejectLabel
            )}
          </Button>
        ) : null}
      </div>

      {revising ? (
        <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={reasonPlaceholder}
            aria-invalid={attempted && reasonMissing}
            className={cn(
              "min-h-24 bg-background text-sm",
              attempted && reasonMissing && "border-rose-500 focus-visible:ring-rose-500/25",
            )}
          />
          {attempted && reasonMissing ? (
            <p className="text-xs text-destructive">{t("localizationIssueDetail.ui_Add_a_note_describing_the_changes_you_want")}</p>
          ) : null}
          {revisePanelChildren}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => {
                setRevising(false);
                setAttempted(false);
              }}
            >
              {t("localizationFilters.cancel")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canReject || working !== null}
              onClick={submitRevision}
            >
              {working === "reject" ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  {t("localizationIssueDetail.ui_Sending")}
                </>
              ) : (
                t("localizationIssueDetail.ui_Send_revision")
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <InteractionActionError message={actionError} />
    </div>
  );
}

function connectionAuthorizationStatusClasses(
  state: ConnectionAuthorizationCardState,
  copy: { providerName: string; addresseeLabel: string },
): {
  shell: string;
  badge: string;
  label: string;
  Icon: typeof CheckCircle2;
} {
  switch (state) {
    case "actionable":
      return {
        shell: "border-2 border-sky-500/70 bg-transparent",
        badge: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
        get label() { return t("localizationIssueDetail.ui_Action_required"); },
        Icon: KeyRound,
      };
    case "waiting":
      // Not a warning and not a failure: someone else's decision is simply
      // outstanding. The calm inert lane keeps it out of the reader's queue.
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: t("localizationIssueDetail.waitingFor", { person: copy.addresseeLabel }),
        Icon: Clock,
      };
    case "connected":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: t("localizationIssueDetail.serviceConnected", { provider: copy.providerName }),
        Icon: CheckCircle2,
      };
    case "declined":
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        get label() { return t("pages.apps.connections.statusNotConnected"); },
        Icon: MinusCircle,
      };
    case "expired":
    default:
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        get label() { return t("localizationIssueDetail.ui_Authorization_expired"); },
        Icon: CircleDashed,
      };
  }
}

/**
 * Connection authorization — "Connect your Gmail to continue" (PAP-17796
 * Surface F, corrected in PAP-17859).
 *
 * This is deliberately *not* the generic Approve / Revise… / Reject grammar it
 * used to fall through to. Authorization is not a review: there is nothing to
 * revise, "Reject" is the wrong word for declining to link your own account,
 * and only one person in the company can answer at all. So the card composes
 * one title, one body, and exactly the affordances the reader legitimately has:
 *
 * - the addressed person gets the single primary **Connect <Provider>** target
 *   plus a plain **Not now**;
 * - anybody else gets **Waiting for <Person>** and no action at all — a
 *   policy-forbidden action is omitted, never rendered disabled, and the card
 *   must not imply a teammate can consent on their behalf;
 * - once resolved it states the outcome, who resolved it, and when.
 *
 * The primary action is a link to the server-minted authorization URL, not an
 * accept call: the OAuth callback is what resolves this interaction, so the
 * card never claims success the provider has not granted.
 */
function RequestConnectionAuthorizationCard({
  interaction,
  state,
  isAddressee,
  providerName,
  addresseeLabel,
  requestingAgentLabel,
  resolvedByLabel,
  resolvedByAgent,
  onRejectInteraction,
}: {
  interaction: RequestConfirmationInteraction;
  state: ConnectionAuthorizationCardState;
  /** Is the signed-in reader the person the server addressed? */
  isAddressee: boolean;
  providerName: string;
  addresseeLabel: string;
  requestingAgentLabel: string | null;
  resolvedByLabel: string | null;
  resolvedByAgent: boolean;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const href = connectionAuthorizationHref(interaction);
  const declineReason = getAdministrativeReason(interaction);

  useEffect(() => {
    setActionError(null);
    setWorking(false);
  }, [interaction.id, interaction.status]);

  async function handleNotNow() {
    if (!onRejectInteraction) return;
    setWorking(true);
    setActionError(null);
    try {
      await onRejectInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  // One body, composed here rather than split between the header summary and a
  // payload prompt that repeats the title.
  //
  // The server's summary is written in the second person ("needs *your* Gmail
  // identity for work running as *you*") because the server addressed one
  // person. Shown to a teammate it names the wrong account, so a reader who is
  // not the addressee gets the same fact stated about them. Caught by rendering
  // the card, not by reading it.
  const agentLabel = requestingAgentLabel ?? t("localizationIssueDetail.anAgent");
  const lead = isAddressee
    ? interaction.summary?.trim()
      || t("localizationIssueDetail.identityForYou", { agent: agentLabel, provider: providerName })
    : t(state === "connected" ? "localizationIssueDetail.identityForPersonPast" : "localizationIssueDetail.identityForPerson", { agent: agentLabel, person: addresseeLabel, provider: providerName });
  // Only the actionable state needs the consent boundary spelled out; the other
  // states carry it in their own status line.
  const consentSentence = state === "actionable" ? t("localizationIssueDetail.ui_No_one_else_can_complete_this_step") : null;

  return (
    <div className="space-y-4">
      <p
        className="max-w-3xl text-sm leading-6 text-muted-foreground"
        data-testid="connection-authorization-body"
      >
        {consentSentence ? `${lead} ${consentSentence}` : lead}
      </p>

      {state === "actionable" ? (
        <div className="space-y-3">
          {href ? (
            <div
              data-testid="connection-authorization-actions"
              className="grid grid-cols-1 items-stretch gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
            >
              <Button asChild size="sm" variant="cta" className="w-full sm:w-auto">
                <a href={href} target="_blank" rel="noreferrer">
                  {t("pages.apps.connections.connect")} {providerName}
                  <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full sm:w-auto"
                disabled={!onRejectInteraction || working}
                onClick={() => void handleNotNow()}
              >
                {working ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {t("pages.agentDetail.saving")}
                  </>
                ) : (
                  t("localizationIssueDetail.ui_Not_now")
                )}
              </Button>
            </div>
          ) : (
            // A pending card with no usable target is a server-side gap, not an
            // invitation to reuse an old URL.
            <ConnectionAuthorizationStatusLine
              Icon={TriangleAlert}
              testId="connection-authorization-no-target"
              headline={t("localizationIssueDetail.ui_This_authorization_link_is_unavailable")}
              detail={t("localizationIssueDetail.freshAuthLink", { agent: requestingAgentLabel ?? t("localizationIssueDetail.agentActor"), provider: providerName })}
            />
          )}
          <InteractionActionError message={actionError} />
        </div>
      ) : state === "waiting" ? (
        <ConnectionAuthorizationStatusLine
          Icon={Clock}
          testId="connection-authorization-waiting"
          headline={t("localizationIssueDetail.waitingFor", { person: addresseeLabel })}
          detail={t("localizationIssueDetail.onlyConnectOwn", { person: addresseeLabel, provider: providerName })}
        />
      ) : state === "connected" ? (
        <ConnectionAuthorizationStatusLine
          Icon={CheckCircle2}
          testId="connection-authorization-connected"
          headline={t("localizationIssueDetail.serviceConnected", { provider: providerName })}
          detail={
            <>
              <Trans i18nKey="localizationIssueDetail.connectedBy" values={{ person: resolvedByLabel ?? addresseeLabel }} components={{ actor: <span className="font-medium text-foreground" /> }} />
              {resolvedByAgent ? <ResolvedByAgentChip /> : null}
              {interaction.resolvedAt ? t("localizationIssueDetail.onDate", { date: formatDateTime(interaction.resolvedAt) }) : ""}
            </>
          }
        />
      ) : (
        // Declined or expired. No Connect action: the authorization target this
        // card carried is spent, and the agent asks again with a fresh one
        // rather than the board replaying a dead URL.
        <ConnectionAuthorizationStatusLine
          Icon={state === "declined" ? MinusCircle : CircleDashed}
          testId={state === "declined" ? "connection-authorization-declined" : "connection-authorization-expired"}
          headline={state === "declined" ? t("localizationIssueDetail.notConnected", { provider: providerName }) : t("localizationIssueDetail.ui_This_authorization_request_expired")}
          detail={
            declineReason
              ?? t("localizationIssueDetail.canRequestAuthAgain", { agent: requestingAgentLabel ?? t("localizationIssueDetail.anAgent"), provider: providerName })
          }
        />
      )}
    </div>
  );
}

function ConnectionAuthorizationStatusLine({
  Icon,
  testId,
  headline,
  detail,
}: {
  Icon: typeof CheckCircle2;
  testId: string;
  headline: string;
  detail: ReactNode;
}) {
  useTranslation();
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-2 rounded-sm border border-border/70 bg-muted/30 p-3"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-0.5 text-sm">
        <div className="font-medium text-foreground">{headline}</div>
        <div className="leading-6 text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function RequestConfirmationCard({
  interaction,
  isPlan = false,
  primaryActionOnRight = false,
  onAcceptInteraction,
  onRejectInteraction,
  onUploadImage,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  isPlan?: boolean;
  primaryActionOnRight?: boolean;
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
  const { t } = useTranslation();
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const [shots, setShots] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Screenshots ride along in the revise note as markdown image refs so the
  // board can attach images when sending a plan back — no schema change needed.
  const allowScreenshots = isPlan && Boolean(onUploadImage);
  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowRevise = interaction.payload.allowDeclineReason !== false;
  const reasonPlaceholder =
    interaction.payload.declineReasonPlaceholder
    ?? (interaction.payload.acceptLabel === "Approve plan"
      ? t("localizationIssueDetail.ui_Optional_what_would_you_like_revised")
      : t("localizationIssueDetail.ui_Optional_tell_the_agent_what_you_d_change"));

  useEffect(() => {
    setActionError(null);
    setShots([]);
    setUploadError(null);
    if (interaction.status !== "pending") {
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
      setUploadError(t("localizationIssueDetail.ui_Couldn_t_upload_that_image_Try_again"));
    } finally {
      setUploading(false);
    }
  }

  function composeReason(text: string) {
    const trimmed = text.trim();
    if (shots.length === 0) return trimmed || undefined;
    const images = shots.map((s) => `![${s.name}](${s.url})`).join("\n");
    return [trimmed, images].filter(Boolean).join("\n\n");
  }

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason: string | undefined) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
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
        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? t(CONFIRMATION_APPROVE_LABEL_KEY)}
          rejectLabel={t(CONFIRMATION_REJECT_LABEL_KEY)}
          approveVariant={isPlan ? "cta" : "default"}
          primaryActionOnRight={primaryActionOnRight}
          allowRevise={allowRevise}
          rejectRequiresReason={rejectRequiresReason}
          reasonPlaceholder={reasonPlaceholder}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
          composeReason={composeReason}
          extraReasonSatisfied={shots.length > 0}
          revisePanelChildren={
            allowScreenshots ? (
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
                          aria-label={t("localizationIssueDetail.removeImage", { name: shot.name })}
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
                      {t("localizationIssueDetail.ui_Uploading")}
                    </>
                  ) : (
                    <>
                      <ImagePlus className="mr-2 h-3.5 w-3.5" />
                      {t("localizationIssueDetail.ui_Attach_screenshots")}
                    </>
                  )}
                </Button>
                {uploadError ? (
                  <p className="text-xs text-destructive">{uploadError}</p>
                ) : null}
              </div>
            ) : null
          }
        />
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
  const { t } = useTranslation();
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
              ? t("localizationIssueDetail.ui_Confirmed_with_no_options_selected")
              : t("localizationIssueDetail.confirmedOfOptions", { count: totalOptions, selected: selectedCount })}
          </span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {visibleLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleLabels.map((label, index) => (
              <TaskField key={`${label}-${index}`} label={t("localizationIssueDetail.ui_Selected")} value={label} />
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
                {expanded ? t("localizationIssueDetail.ui_Show_less") : t("localizationIssueDetail.moreCount", { count: hiddenCount })}
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
        {t("localizationIssueDetail.ui_This_request_could_not_be_resolved_Try_again_or_create_a_new_request")}
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
  useTranslation();
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
  primaryActionOnRight = false,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  primaryActionOnRight?: boolean;
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
  const { t } = useTranslation();
  const options = interaction.payload.options;
  const optionIds = useMemo(() => options.map((option) => option.id), [i18n.resolvedLanguage, options]);
  const validOptionIds = useMemo(() => new Set(optionIds), [i18n.resolvedLanguage, optionIds]);
  const minSelected = interaction.payload.minSelected ?? 0;
  const maxSelected = interaction.payload.maxSelected ?? null;

  const defaultSelected = useMemo(
    () =>
      new Set(
        (interaction.payload.defaultSelectedOptionIds ?? []).filter((id) => validOptionIds.has(id)),
      ),
    [i18n.resolvedLanguage, interaction.payload.defaultSelectedOptionIds, validOptionIds],
  );

  const [selectedOptionIds, setSelectedOptionIds] = useState<Set<string>>(() => new Set(defaultSelected));
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [acceptAttempted, setAcceptAttempted] = useState(false);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

  const optionSeed = useMemo(() => optionIds.join("\n"), [i18n.resolvedLanguage, optionIds]);

  useEffect(() => {
    setSelectedOptionIds(new Set(defaultSelected));
    setAcceptAttempted(false);
    setActionError(null);
    if (interaction.status !== "pending") {
      setWorking(null);
    }
  }, [interaction.id, interaction.status, interaction.result?.reason, defaultSelected, optionSeed]);

  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowRevise = interaction.payload.allowDeclineReason !== false;
  const reasonPlaceholder =
    interaction.payload.declineReasonPlaceholder ?? t("localizationIssueDetail.ui_Optional_tell_the_agent_what_you_d_change");

  const selectedCount = selectedOptionIds.size;
  const totalOptions = options.length;
  const atMax = maxSelected != null && selectedCount >= maxSelected;
  const belowMin = selectedCount < minSelected;
  const aboveMax = maxSelected != null && selectedCount > maxSelected;
  const selectionValid = !belowMin && !aboveMax;

  const validationMessage = belowMin
    ? t("localizationIssueDetail.selectMin", { count: minSelected })
    : aboveMax && maxSelected != null
      ? t("localizationIssueDetail.selectMax", { count: maxSelected })
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
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason: string | undefined) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
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
    ? t("localizationIssueDetail.allOptionsSelected", { count: totalOptions })
    : t("localizationIssueDetail.optionsSelected", { count: totalOptions, selected: selectedCount });
  const boundsHint = maxSelected != null
    ? minSelected === maxSelected ? t("localizationIssueDetail.pickExactly", { count: maxSelected }) : t("localizationIssueDetail.pickRange", { min: minSelected, max: maxSelected })
    : minSelected > 0
      ? t("localizationIssueDetail.pickAtLeast", { count: minSelected })
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        {/* Show each piece of state once: a connection-authorization prompt is
            the same sentence as the card title, so repeating it here is noise. */}
        {interaction.payload.prompt === interaction.title ? null : (
          <div className="text-sm leading-6 text-foreground">{interaction.payload.prompt}</div>
        )}
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
              {t("localizationIssueDetail.ui_Select_all")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === 0}
              onClick={handleClearSelection}
            >
              {t("localizationIssueDetail.ui_Clear_selection")}
            </Button>
          </div>
        </div>

        <div
          role="group"
          aria-label={t("localizationIssueDetail.ui_Selectable_options")}
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

        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? t(CONFIRMATION_APPROVE_LABEL_KEY)}
          rejectLabel={interaction.payload.rejectLabel ?? t(CONFIRMATION_REJECT_LABEL_KEY)}
          primaryActionOnRight={primaryActionOnRight}
          allowRevise={allowRevise}
          rejectRequiresReason={rejectRequiresReason}
          reasonPlaceholder={reasonPlaceholder}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
        />
      </div>
    </div>
  );
}

// --- Per-item verdicts (C3) ---------------------------------------------

const VERDICT_LABEL: Record<RequestItemVerdictValue, string> = {
  get approve() { return t("localizationSettings.approve"); },
  get reject() { return t("localizationSettings.reject"); },
  get defer() { return t("localizationIssueDetail.ui_Defer"); },
};

/** Present-tense past-participle label for a resolved verdict chip. */
const VERDICT_RESOLVED_LABEL: Record<RequestItemVerdictValue, string> = {
  get approve() { return t("status.approved"); },
  get reject() { return t("localizationIssueDetail.ui_Rejected"); },
  get defer() { return t("localizationIssueDetail.ui_Deferred"); },
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
  useTranslation();
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
  const { t } = useTranslation();
  const href = item.href ? normalizeRequestConfirmationTargetHref(item.href) : null;
  if (!href) return null;
  const isInternal = href.startsWith("/") || href.startsWith("#");
  const className =
    "inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";
  const label = (
    <>
      {t("pages.pipelines.open")}
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
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("localizationIssueDetail.ui_Choose_a_verdict")}
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
            aria-label={t(`localizationIssueDetail.verdictAction_${verdict}`)}
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
  const { t } = useTranslation();
  const payload = interaction.payload;
  const items = payload.items;
  const enabledVerdicts = useMemo<RequestItemVerdictValue[]>(
    () => payload.verdicts ?? ["approve", "reject"],
    [i18n.resolvedLanguage, payload.verdicts],
  );
  const requireReasonOn = useMemo(
    () => new Set<RequestItemVerdictValue>(payload.requireReasonOn ?? ["reject"]),
    [i18n.resolvedLanguage, payload.requireReasonOn],
  );
  const allowBulkApprove = payload.allowBulkApprove !== false && enabledVerdicts.includes("approve");
  const reasonLabel = payload.reasonLabel ?? t("pages.pipelines.reason");

  const resolvedById = useMemo(
    () => new Map<string, RequestItemVerdictsResultItem>((interaction.result?.items ?? []).map((item) => [item.id, item])),
    [i18n.resolvedLanguage, interaction.result],
  );

  const [drafts, setDrafts] = useState<Map<string, VerdictDraft>>(new Map());
  const [applyingItemIds, setApplyingItemIds] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [actionError, setActionError] = useState<InteractionResolutionDisplayError | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

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
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
      setApplyingItemIds(new Set());
      setWorking(false);
    }
  }

  const applyLabel = t("localizationIssueDetail.applyDecisions", { count: draftCount });

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
              ? t("localizationIssueDetail.ui_This_review_expired_after_a_later_comment")
              : interaction.result?.outcome === "stale_target"
                ? t("localizationIssueDetail.ui_This_review_expired_after_the_target_changed")
                : t("localizationIssueDetail.ui_This_review_expired")}
          </div>
          {progress.decided > 0 ? (
            <p className="mt-1 text-xs leading-5">
              {t("localizationIssueDetail.appliedCannotRevert", { count: progress.decided })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Item list (S1/S2/S3/S4) */}
      <ul className="space-y-2" aria-label={t("localizationIssueDetail.ui_Items_to_review")}>
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
                      {t("localizationIssueDetail.ui_Applying")}
                    </span>
                  ) : isTerminal ? (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-muted/30 px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                      {t("localizationIssueDetail.ui_Not_decided")}
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
                    placeholder={t("localizationIssueDetail.ui_Give_the_agent_a_reason_so_it_can_act_on_this_item")}
                    aria-invalid={attempted && invalidDraftIds.has(item.id)}
                    className={cn(
                      "min-h-16 bg-background text-sm",
                      attempted && invalidDraftIds.has(item.id) && "border-rose-500 focus-visible:ring-rose-500/25",
                    )}
                  />
                  {attempted && invalidDraftIds.has(item.id) ? (
                    <p className="text-xs text-destructive">{t(`localizationIssueDetail.reasonRequired_${draft.verdict}`)}</p>
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
            {t("localizationIssueDetail.verdictComplete", { decided: progress.decided, approved: progress.approved, rejected: progress.rejected })} {progress.deferred > 0 ? ` · ${t("localizationIssueDetail.deferredCount", { count: progress.deferred })}` : ""}
          </span>
        </div>
      ) : null}

      {/* Pinned batch bar (S1/S2) — only while items remain actionable */}
      {!isTerminal && progress.pendingItemIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="text-xs text-muted-foreground">
            {draftCount > 0
              ? t("localizationIssueDetail.draftVerdictsReady", { count: draftCount })
              : t("localizationIssueDetail.ui_Mark_verdicts_then_apply_them_in_one_pass")}
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
                {t("localizationIssueDetail.ui_Approve_all")}
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
                  {t("localizationIssueDetail.ui_Applying")}
                </>
              ) : (
                applyLabel
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <InteractionActionError message={actionError} />
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
  const { t } = useTranslation();
  const pct = progress.total > 0 ? Math.round((progress.decided / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      {/* Von Restorff accent when a draft reject is missing its reason */}
      {pendingReason ? (
        <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-900 dark:text-amber-100">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {t("localizationIssueDetail.ui_Reason_needed")}
        </span>
      ) : null}
      <div
        className="flex items-center gap-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.decided}
        aria-label={t("localizationIssueDetail.decidedOfTotal", { count: progress.decided, total: progress.total })}
      >
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
          {t("localizationIssueDetail.decidedOfTotal", { count: progress.decided, total: progress.total })}
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
  primaryActionOnRight,
  onSubmitInteractionVerdicts,
  onUploadImage,
  externalReferences,
}: IssueThreadInteractionCardProps) {
  const { t } = useTranslation();
  // Single enforcement point (PAP-424, plan from PAP-420; extended by PAP-437):
  // a card that should never be drawn — a degenerate `ask_user_questions`
  // (placeholder junk like the onboarding `Test / A` card, no genuine question)
  // or a stale sibling the server auto-expired when its creator posted a newer
  // question (`superseded_by_newer_interaction`). Every render site (both thread
  // backbones + the attention resolver) routes through this component, so
  // suppressing here suppresses it everywhere at once. The interaction is still
  // created and stored server-side; only the render is suppressed. Composition
  // sites additionally filter it so no empty slot lingers.
  if (shouldHideInteractionCard(interaction)) return null;
  const isPlan = isPlanConfirmation(interaction);
  const isToolAction =
    interaction.kind === "request_confirmation" && isToolActionConfirmation(interaction);
  const isSecretProposal =
    interaction.kind === "request_confirmation" && isSecretProposalConfirmation(interaction);
  const connectionAuthorization = connectionAuthorizationPayload(interaction);
  const isConnectionAddressee =
    connectionAuthorization && interaction.kind === "request_confirmation"
      ? isConnectionAuthorizationAddressee({ interaction, currentUserId })
      : false;
  const connectionAuthorizationState =
    connectionAuthorization && interaction.kind === "request_confirmation"
      ? connectionAuthorizationCardState({ interaction, isAddressee: isConnectionAddressee })
      : null;
  const toolActionState =
    isToolAction && interaction.kind === "request_confirmation"
      ? toolActionCardState(interaction)
      : null;
  const toolActionStyles = toolActionState ? toolActionStatusClasses(toolActionState) : null;
  const secretProposalState =
    isSecretProposal && interaction.kind === "request_confirmation"
      ? secretProposalCardState(interaction)
      : null;
  const secretProposalStyles = secretProposalState
    ? secretProposalStatusClasses(secretProposalState)
    : null;
  const resumeFailure = requestConfirmationResumeFailure(interaction);
  const planStyles = isPlan
    ? planStatusClasses(
        interaction.status,
        resumeFailure,
        interaction.result && "outcome" in interaction.result ? interaction.result.outcome : null,
      )
    : null;
  // Interactions can be directed at a specific agent or board user. Resolved
  // before the status styling because the connection-authorization badge names
  // the addressee ("Waiting for Carol").
  const addresseeLabel = interaction.addresseeAgentId || interaction.addresseeUserId
    ? resolveActorLabel({
        agentId: interaction.addresseeAgentId,
        userId: interaction.addresseeUserId,
        agentMap,
        currentUserId,
        userLabelMap,
      })
    : null;
  const connectionAuthorizationStyles = connectionAuthorization && connectionAuthorizationState
    ? connectionAuthorizationStatusClasses(connectionAuthorizationState, {
        providerName: connectionAuthorization.providerName,
        addresseeLabel: addresseeLabel ?? t("localizationIssueDetail.addressedPerson"),
      })
    : null;
  const activeStyles =
    connectionAuthorizationStyles ?? secretProposalStyles ?? toolActionStyles ?? planStyles;
  const adminOutcome = getAdministrativeOutcome(interaction);
  const adminReason = adminOutcome ? getAdministrativeReason(interaction) : null;
  // P4 (design review R2): a withdrawal is a neutral administrative retraction by
  // the requester — NOT a board "no". It must not inherit the `cancelled` card's
  // rose/red border + XCircle, which is pixel-identical to a rejected plan and
  // mis-signals a denial to anyone scanning the thread. Give withdrawn its own
  // inert lane (sibling to the calm `expired` state): muted border/badge +
  // MinusCircle ("retracted"). This overrides the plan/tool-action/status styling
  // so a withdrawn plan or confirmation reads "closed", not "changes requested".
  const withdrawnStyles =
    adminOutcome === "withdrawn"
      ? { shell: "border-border bg-transparent", badge: "border-border bg-muted/60 text-muted-foreground" }
      : null;
  const StatusIcon = withdrawnStyles
    ? MinusCircle
    : activeStyles
      ? activeStyles.Icon
      : statusIcon(interaction.status);
  const iconSpin = secretProposalStyles?.spin ?? toolActionStyles?.spin ?? false;
  const styles = withdrawnStyles ?? activeStyles ?? statusClasses(interaction.status);
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
  // P4: audit-visible distinction between agent and human resolution.
  const resolvedByAgent = Boolean(interaction.resolvedByAgentId);
  // PAP-17280: the effective audience, shown *before* anyone responds so a
  // reader never has to guess whether an open card is waiting on them. Derived
  // from the same server snapshot the resolver routes enforce, so the copy
  // cannot promise a wider audience than the API allows.
  const audience = describeInteractionAudience({
    interaction,
    creatorLabel: interaction.createdByAgentId || interaction.createdByUserId ? createdByLabel : null,
    addresseeLabel,
    isCreatorCurrentUser: Boolean(currentUserId && interaction.createdByUserId === currentUserId),
    isAddresseeCurrentUser: Boolean(currentUserId && interaction.addresseeUserId === currentUserId),
  });
  if (isToolAction && interaction.kind === "request_confirmation" && toolActionState) {
    return (
      <InteractionAudienceContext.Provider value={audience}>
        <RequestToolActionCard
          interaction={interaction}
          state={toolActionState}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          externalReferences={externalReferences}
        />
      </InteractionAudienceContext.Provider>
    );
  }
  const statusText =
    adminOutcome === "withdrawn"
      ? t("localizationIssueDetail.ui_Withdrawn")
      : adminOutcome === "issue_closed"
        ? t("localizationIssueDetail.ui_Expired_issue_closed")
        : activeStyles
          ? activeStyles.label
          : statusLabel(interaction.status);

  return (
    // Every nested subcard resolves the same interaction, so they all explain a
    // denial with the same audience the header states (PAP-17287).
    <InteractionAudienceContext.Provider value={audience}>
      <div className={cn("rounded-lg border p-5 shadow-none", styles.shell)}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="interaction-status-badge"
                className={cn(
                  "inline-flex items-center gap-1 rounded-sm border px-2.5 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)",
                  styles.badge,
                )}
              >
                <StatusIcon className={cn("h-3.5 w-3.5", iconSpin && "animate-spin")} />
                {isSecretProposal ? (
                  <span className="flex flex-col sm:flex-row sm:items-center sm:gap-1">
                    <span>{t("localizationIssueDetail.ui_Secret_binding")}</span>
                    <span className="hidden text-current/60 sm:inline">/</span>
                    <span>{statusText}</span>
                  </span>
                ) : connectionAuthorization ? (
                  // One state, in the reader's own terms: "Action required",
                  // "Waiting for Carol", "Gmail connected". The interaction kind
                  // is machinery the person being asked does not need.
                  <span>{statusText}</span>
                ) : (
                  <>
                    {isPlan ? t("pages.pipelines.deliverablePlan") : interactionKindLabel(interaction.kind)}
                    <span className="text-current/60">/</span>
                    {statusText}
                  </>
                )}
              </span>
              {addresseeLabel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="gap-1"
                      data-testid="interaction-addressee-badge"
                    >
                      <Bot className="h-3 w-3" />
                      {t("localizationIssueDetail.forPerson", { person: addresseeLabel })}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    {t("localizationIssueDetail.directedTo", { person: addresseeLabel })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <div className="mt-3 text-lg font-bold text-foreground">
              {interaction.title
                ?? (interaction.kind === "suggest_tasks"
                  ? t("localizationIssueDetail.ui_Suggested_task_tree")
                  : interaction.kind === "ask_user_questions"
                    // Only a human-only card is genuinely "for the operator";
                    // an open card is answerable by any teammate (PAP-17280).
                    ? interaction.payload.title
                      ?? (audience.policy === "human_only"
                        ? t("localizationIssueDetail.ui_Questions_for_the_operator")
                        : t("localizationIssueDetail.ui_Questions_to_answer"))
                  : interaction.kind === "request_checkbox_confirmation"
                    ? t("localizationIssueDetail.ui_Checkbox_confirmation_requested")
                    : isSecretProposal
                      ? t("localizationIssueDetail.ui_Secret_binding_requested")
                    : connectionAuthorization
                      ? t("localizationIssueDetail.connectToContinue", { provider: connectionAuthorization.providerName })
                    : isToolAction
                      ? t("localizationIssueDetail.ui_Tool_approval_requested")
                      : interaction.kind === "request_item_verdicts"
                        ? t("localizationIssueDetail.ui_Review_these_items")
                        : isPlan
                          ? t("localizationIssueDetail.ui_Plan_review")
                          : t("localizationIssueDetail.ui_Confirmation_requested"))}
            </div>
            {/* A connection-authorization card composes its own single body
                below, because the closing sentence depends on whether the
                reader is the person who may consent. Rendering the summary here
                as well would be the second body PAP-17859 removed. */}
            {interaction.summary && !connectionAuthorization && interaction.kind !== "connection_intent" ? (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {interaction.summary}
              </p>
            ) : null}
            {interaction.status === "pending" ? (
              <InteractionAudienceLine audience={audience} className="mt-3" />
            ) : null}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-sm border border-border/70 bg-transparent px-3 py-2 text-right text-xs text-muted-foreground">
                <div className="font-medium text-foreground">{formatShortDate(interaction.createdAt)}</div>
                <div>{t("localizationIssueDetail.proposedBy", { person: createdByLabel })}</div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t("pages.projects.sort.created")} {formatDateTime(interaction.createdAt)}
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
              primaryActionOnRight={primaryActionOnRight}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
              externalReferences={externalReferences}
            />
          ) : connectionAuthorization
            && interaction.kind === "request_confirmation"
            && connectionAuthorizationState ? (
            <RequestConnectionAuthorizationCard
              interaction={interaction}
              state={connectionAuthorizationState}
              isAddressee={isConnectionAddressee}
              providerName={connectionAuthorization.providerName}
              addresseeLabel={addresseeLabel ?? t("localizationIssueDetail.addressedPerson")}
              requestingAgentLabel={connectionAuthorization.requestingAgentName ?? null}
              resolvedByLabel={resolvedByLabel}
              resolvedByAgent={resolvedByAgent}
              onRejectInteraction={onRejectInteraction}
            />
          ) : isSecretProposal && interaction.kind === "request_confirmation" && secretProposalState ? (
            <RequestSecretProposalCard
              interaction={interaction}
              state={secretProposalState}
              resolvedByLabel={resolvedByLabel}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
            />
          ) : interaction.kind === "connection_intent" ? (
            <ConnectionIntentInteractionBody
              interaction={interaction}
              currentUserId={currentUserId}
              addresseeLabel={addresseeLabel ?? t("localizationIssueDetail.addressedPerson")}
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
              primaryActionOnRight={primaryActionOnRight}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
              onUploadImage={onUploadImage}
              externalReferences={externalReferences}
            />
          )}
        </div>

        {adminOutcome === "withdrawn" ? (
          <div
            className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-withdrawn-footer"
          >
            <div>
              <Trans i18nKey="localizationIssueDetail.withdrawnBy" values={{ person: resolvedByLabel ?? t("localizationIssueDetail.agentActor") }} components={{ actor: <span className="font-medium text-foreground" /> }} />
              {resolvedByAgent ? <ResolvedByAgentChip /> : null}
              {interaction.resolvedAt ? t("localizationIssueDetail.onDate", { date: formatShortDate(interaction.resolvedAt) }) : ""}
            </div>
            {adminReason ? (
              <div className="mt-1 italic text-muted-foreground/90">"{adminReason}"</div>
            ) : null}
          </div>
        ) : adminOutcome === "issue_closed" && interaction.resolvedAt ? (
          // The header badge + body already explain the issue-closed expiry;
          // the footer is just the audit timestamp.
          <div
            className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-issue-closed-footer"
          >
            {formatShortDate(interaction.resolvedAt)}
          </div>
        ) : resolvedByLabel && !isToolAction && !connectionAuthorization ? (
          // The connection-authorization card states its own resolver and
          // timestamp inside the "Gmail connected" block, so the shared footer
          // would repeat it.
          <div
            className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-resolved-footer"
          >
            <Trans i18nKey="localizationIssueDetail.resolvedBy" values={{ person: resolvedByLabel }} components={{ actor: <span className="font-medium text-foreground" /> }} />
            {resolvedByAgent ? <ResolvedByAgentChip /> : null}
            {interaction.resolvedAt ? t("localizationIssueDetail.onDate", { date: formatShortDate(interaction.resolvedAt) }) : ""}
          </div>
        ) : null}
      </div>
    </InteractionAudienceContext.Provider>
  );
}

/**
 * Small audit chip marking that an interaction was resolved by an agent (rather
 * than a human board member) — governed agent resolution introduced in P2.
 */
function ResolvedByAgentChip() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="ml-1 gap-1 border-indigo-500/50 py-0 text-[length:--text-micro] text-indigo-700 dark:text-indigo-200"
          data-testid="interaction-resolved-by-agent-chip"
        >
          <Bot className="h-3 w-3" />
          {t("pages.agentDetail.agentFallback")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs">
        {t("localizationIssueDetail.ui_Resolved_by_an_agent_under_the_organization_s_interaction_governance_policy_audit_dis")}
      </TooltipContent>
    </Tooltip>
  );
}
