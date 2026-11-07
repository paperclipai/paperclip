import { t, i18n, useTranslation, Trans } from "@/i18n";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { requiresExecutionReconciliation } from "@paperclipai/shared";
import { useMemo, useState } from "react";
import type {
  Agent,
  GitWorktreeBranchAncestryVerdict,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import {
  Eye,
  GitBranch,
  GitBranchPlus,
  Loader2,
  Lock,
  OctagonAlert,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { agentUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  deriveRecoveryDisplayState,
  type RecoveryDisplayState,
} from "@/lib/recovery-display";
import {
  formatRecoveryAttemptLabel,
  formatRecoveryRetryOffset,
  readRecoveryRetryLineage,
  type RecoveryRetryLineage,
} from "@/lib/recovery-lineage";

export type RecoveryCardCardState = RecoveryDisplayState;
export const deriveRecoveryCardState = deriveRecoveryDisplayState;

export type RecoveryResolveOutcome =
  | "todo"
  | "done"
  | "in_review"
  | "false_positive_done"
  | "false_positive_in_review";

/**
 * Payload for the "Re-issue on isolated workspace" action (workspace_validation only).
 * The caller composes an isolated-workspace re-issue whose git worktree bases off `baseRef`
 * — the live (checked-out) branch that diverged, or its HEAD sha when the branch is detached.
 */
export interface RecoveryReissueRequest {
  baseRef: string;
  liveBranch: string | null;
  liveHeadSha: string | null;
  expectedBranch: string | null;
}

export interface IssueRecoveryActionCardProps {
  action: IssueRecoveryAction;
  agentMap?: ReadonlyMap<string, Agent>;
  /**
   * The source issue's scheduled retry. It is the only signal that can confirm the run the
   * wake policy parked is genuinely in flight, which is what separates a retry the scheduler
   * is running from one whose due time quietly passed.
   */
  scheduledRetry?: IssueScheduledRetry | null;
  /** Preferred state hint (e.g. observe_only when watchdog tone is requested). Falls back to derived state. */
  forcedState?: RecoveryCardCardState;
  /** Optional click handler for resolve menu actions. If omitted, the buttons are not rendered. */
  onResolve?: (outcome: RecoveryResolveOutcome) => void;
  /**
   * Optional handler for the workspace_validation "Re-issue on isolated workspace" action.
   * Rendered only for a git-worktree branch-incoherence divergence with a resolvable live ref.
   * If omitted, the re-issue button is not shown.
   */
  onReissueIsolated?: (request: RecoveryReissueRequest) => void;
  /** Whether an isolated re-issue is currently in flight (disables the action + shows a spinner). */
  reissuePending?: boolean;
  /**
   * Handler for action 1 — "Reconcile forward & continue" (workspace_validation only). Rendered
   * only for an ancestry-proven (`ancestor`) git-worktree divergence; the caller invokes the S4
   * reconcile op in `forward` mode, which re-verifies ancestry server-side (the client hint is
   * never trusted). If omitted, the button is not shown.
   */
  onReconcileForward?: () => void;
  /**
   * Handler for action 2 — the audited break-glass override (workspace_validation only). Receives
   * the operator's required, non-empty reason and invokes the S4 reconcile op in `override` mode.
   * Rendered only when `canBreakGlass` is true AND this handler is provided; the server independently
   * rejects agent actors and re-checks runtime-manage permission, so UI hiding is defense-in-depth.
   */
  onBreakGlassOverride?: (reason: string) => void;
  /**
   * Whether the viewer may run the permission-gated break-glass override. When false, action 2 is
   * not rendered at all — a non-permitted user never sees the "reconcile anyway" affordance.
   */
  canBreakGlass?: boolean;
  /**
   * Handler for the lossless repair — "Repair workspace — quarantine changes & restore branch"
   * (workspace_validation only). Rendered only for a *dirty* divergence; the caller invokes the S4
   * reconcile op in `quarantine_restore` mode, which quarantines the dirty worktree onto a rescue
   * branch and restores the recorded branch. If omitted, the repair action is not shown.
   */
  onQuarantineRestore?: () => void;
  /** Whether a quarantine-restore repair is currently in flight (shares the reconcile spinner). */
  quarantineRestorePending?: boolean;
  /** Whether a reconcile (forward, override, or quarantine-restore) is currently in flight. */
  reconcilePending?: boolean;
  /** Whether the viewer can run destructive board-only actions (e.g. false-positive dismissal). */
  canFalsePositive?: boolean;
  /**
   * Rendering density. `full` (default) shows the complete metadata table; `compact` drops the
   * metadata rows for embedding beside a run on the agent run page, keeping the header, divergence
   * diagnosis, and action footer.
   */
  variant?: "full" | "compact";
  className?: string;
}

const KIND_LABEL: Record<IssueRecoveryActionKind, string> = {
  get missing_disposition() { return t("deep-ui:missing_disposition_5a6469"); },
  get deliberate_wait_without_target() { return t("deep-ui:wait_without_a_target_e42d92"); },
  get stranded_assigned_issue() { return t("deep-ui:stranded_task_cd5de6"); },
  get workspace_validation() { return t("deep-ui:workspace_validation_83db42"); },
  get configuration_validation() { return t("deep-ui:configuration_validation_2b595e"); },
  get active_run_watchdog() { return t("deep-ui:active_watchdog_c4490d"); },
  get issue_graph_liveness() { return t("deep-ui:task_needs_next_step_e8bed1"); },
};

const KIND_HEADLINE: Record<IssueRecoveryActionKind, string> = {
  get missing_disposition() { return t("deep-ui:this_task_s_run_finished_but_no_next_step_was_chosen_choose__5c7640"); },
  get deliberate_wait_without_target() { return t("deep-ui:this_task_s_last_run_stopped_to_wait_but_there_is_no_reviewe_0af056"); },
  get stranded_assigned_issue() { return t("deep-ui:paperclip_retried_this_task_s_last_run_but_there_is_still_no_a42569"); },
  get workspace_validation() { return t("deep-ui:paperclip_stopped_this_run_because_the_task_s_git_workspace__d3dc99"); },
  get configuration_validation() { return t("deep-ui:paperclip_stopped_before_dispatching_this_run_because_requir_e2ceb9"); },
  get active_run_watchdog() { return t("deep-ui:the_active_run_has_been_silent_recovery_is_observing_without_ffa7d0"); },
  get issue_graph_liveness() { return t("deep-ui:paperclip_could_not_find_a_clear_next_step_for_this_open_tas_ae6d3d"); },
};

/** Shared shell for the retry-timing pill so every timing state reads as the same control. */
const RETRY_PILL_CLASS =
  "rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground";

const STATE_TONE: Record<RecoveryCardCardState, {
  label: string;
  containerClass: string;
  iconWrapClass: string;
  iconClass: string;
  labelClass: string;
  Icon: typeof TriangleAlert;
  divider: string;
}> = {
  needed: {
    get label() { return t("task-components:recoveryNeeded_85e5d2f1"); },
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    get label() { return t("task-components:recoveryInProgress_477f0e94"); },
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    get label() { return t("task-components:observingActiveRun_a43568b4"); },
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    get label() { return t("task-components:recoveryEscalated_f577dda4"); },
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    get label() { return t("task-components:recoveryResolved_ed726d68"); },
    containerClass:
      "border-emerald-300/70 bg-emerald-50/80 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    iconWrapClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    iconClass: "text-emerald-700 dark:text-emerald-300",
    labelClass: "text-emerald-900 dark:text-emerald-200",
    Icon: Sparkles,
    divider: "border-emerald-300/60 dark:border-emerald-500/30",
  },
};

const OUTCOME_LABEL: Record<IssueRecoveryActionOutcome, string> = {
  restored: "restored",
  get handed_back() { return t("deep-ui:handed_back_to_original_owner_78f657"); },
  get owner_completed() { return t("deep-ui:completed_by_recovery_owner_2eb97a"); },
  get delegated() { return t("deep-ui:delegated_to_follow_up_4337e2"); },
  get false_positive() { return t("deep-ui:false_positive_594d50"); },
  blocked: "blocked",
  escalated: "escalated",
  cancelled: "cancelled",
};

function readEvidenceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

// Human-sentence evidence sources render as prose; code-shaped sources
// (error codes, statuses) stay in the mono treatment used for run ids.
const PROSE_EVIDENCE_KEYS = ["summary", "detectedProgressSummary", "missingDisposition", "retryReason"] as const;
const CODE_EVIDENCE_KEYS = ["latestRunErrorCode", "latestRunStatus", "latestIssueStatus"] as const;

function pickEvidenceSummary(action: IssueRecoveryAction): { text: string; isCode: boolean } | null {
  const evidence = action.evidence ?? {};
  for (const key of PROSE_EVIDENCE_KEYS) {
    const next = readEvidenceString(evidence[key]);
    if (next) return { text: next, isCode: false };
  }
  for (const key of CODE_EVIDENCE_KEYS) {
    const next = readEvidenceString(evidence[key]);
    if (next) return { text: next, isCode: true };
  }
  return null;
}

function readEvidenceRunId(action: IssueRecoveryAction, key: "sourceRunId" | "correctiveRunId" | "latestRunId") {
  const evidence = action.evidence ?? {};
  const next = readEvidenceString(evidence[key]);
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asAncestryVerdict(value: unknown): GitWorktreeBranchAncestryVerdict | null {
  return value === "ancestor" || value === "diverged" || value === "unknown" ? value : null;
}

function formatShortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/**
 * Diagnosis derived from a workspace_validation recovery action whose underlying failure is a
 * git-worktree branch incoherence. The evidence carries the recorded ("expected") branch, the
 * live ("actual"/checked-out) branch, both HEAD shas, and a server-computed ancestry verdict +
 * plain-language explanation of why the run was declined.
 */
interface WorkspaceContention {
  claimedByIssueId: string | null;
  claimedByIssueIdentifier: string | null;
  /** True when the claiming workspace has a queued/running run (not just a stale claim). */
  hasActiveRun: boolean;
}

interface WorkspaceDivergence {
  expectedBranch: string | null;
  liveBranch: string | null;
  expectedHeadSha: string | null;
  liveHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict | null;
  plainLanguageReason: string | null;
  cleanliness: "clean" | "dirty" | "unknown" | null;
  /** Number of dirty (uncommitted) status entries in the live worktree, when known. */
  dirtyFileCount: number | null;
  /** Sample of dirty paths (already truncated server-side) for the confirm step. */
  dirtyPathSample: string[];
  /**
   * Another workspace is holding the live branch. When present, the lossless quarantine repair is
   * refused server-side — re-issuing on an isolated workspace is the recommended path instead.
   */
  contention: WorkspaceContention | null;
  /**
   * Preview of the rescue branch the quarantine repair will create. The server appends a UTC
   * timestamp at repair time, so this is the stable prefix only (rendered with a trailing marker).
   */
  rescueBranchPreview: string;
  /** Ref a re-issue should base off — the live branch when known, else the live HEAD sha. */
  reissueBaseRef: string | null;
}

/** Mirrors the server's `sanitizeBranchName` for a faithful rescue-branch preview. */
function sanitizeBranchComponent(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .slice(0, 120) || "issue"
  );
}

function buildRescueBranchPreview(sourceIdentifier: string | null): string {
  return `paperclip/rescue/${sanitizeBranchComponent(sourceIdentifier ?? "issue")}/`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function readContention(value: unknown): WorkspaceContention | null {
  const record = asRecord(value);
  if (!record) return null;
  const activeRun = asRecord(record.activeRun);
  return {
    claimedByIssueId: asNonEmptyString(record.claimedByIssueId),
    claimedByIssueIdentifier: asNonEmptyString(record.claimedByIssueIdentifier),
    hasActiveRun: activeRun !== null,
  };
}

function readWorkspaceDivergence(action: IssueRecoveryAction): WorkspaceDivergence | null {
  if (action.kind !== "workspace_validation") return null;
  const workspaceValidation = asRecord(action.evidence?.workspaceValidation);
  if (!workspaceValidation) return null;
  if (workspaceValidation.reason !== "git_worktree_branch_incoherence") return null;
  const provenance = asRecord(workspaceValidation.provenance) ?? {};
  const expectedBranch = asNonEmptyString(workspaceValidation.expectedBranch);
  const liveBranch = asNonEmptyString(workspaceValidation.actualBranch);
  const expectedHeadSha = asNonEmptyString(provenance.expectedHeadSha);
  const liveHeadSha = asNonEmptyString(provenance.actualHeadSha);
  const cleanlinessRaw = workspaceValidation.cleanliness;
  const cleanliness =
    cleanlinessRaw === "clean" || cleanlinessRaw === "dirty" || cleanlinessRaw === "unknown"
      ? cleanlinessRaw
      : null;
  const sourceIdentifier = asNonEmptyString(workspaceValidation.sourceIdentifier);
  return {
    expectedBranch,
    liveBranch,
    expectedHeadSha,
    liveHeadSha,
    ancestryVerdict: asAncestryVerdict(provenance.ancestryVerdict),
    plainLanguageReason: asNonEmptyString(provenance.plainLanguageReason),
    cleanliness,
    dirtyFileCount: asNonNegativeInt(workspaceValidation.statusEntryCount),
    dirtyPathSample: asStringArray(workspaceValidation.dirtyPathSample),
    contention: readContention(workspaceValidation.contention),
    rescueBranchPreview: buildRescueBranchPreview(sourceIdentifier),
    reissueBaseRef: liveBranch ?? liveHeadSha,
  };
}

const ANCESTRY_BADGE: Record<
  GitWorktreeBranchAncestryVerdict,
  { label: string; className: string }
> = {
  ancestor: {
    get label() { return t("task-components:forwardOnly_8ab1faed"); },
    className: "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  diverged: {
    get label() { return t("task-components:diverged_ec67106c"); },
    className: "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  unknown: {
    get label() { return t("task-components:ancestryUnknown_83119bdb"); },
    className: "border-border bg-muted/60 text-muted-foreground",
  },
};

function BranchFacet({
  label,
  branch,
  sha,
}: {
  label: string;
  branch: string | null;
  sha: string | null;
}) {
  useTranslation("task-components");
  const shortSha = formatShortSha(sha);
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
      <div className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {branch ? (
          <code className="truncate font-mono text-xs text-foreground/90">{branch}</code>
        ) : (
          <span className="text-xs italic text-muted-foreground">{t("task-components:detachedUnknown_05fae70b")}</span>
        )}
      </div>
      <div className="mt-0.5 pl-5 font-mono text-(length:--text-micro) text-muted-foreground">
        {shortSha ? `@ ${shortSha}` : "@ —"}
      </div>
    </div>
  );
}

function DivergenceDiagnosis({
  divergence,
  dividerClass,
}: {
  divergence: WorkspaceDivergence;
  dividerClass: string;
}) {
  useTranslation("task-components");
  const badge = ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"];
  return (
    <div
      data-testid="recovery-divergence-diagnosis"
      className={cn(
        "space-y-2.5 border-t bg-background/40 px-3 py-3 dark:bg-background/20 sm:px-4",
        dividerClass,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:divergenceDiagnosis_02f094ee")}</span>
        <Badge variant="outline"
          data-testid="recovery-ancestry-verdict"
          className={cn(
            "text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label)",
            badge.className,
          )}
        >
          {badge.label}
        </Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <BranchFacet
          label={t("task-components:expectedRecorded_42e4fef0")}
          branch={divergence.expectedBranch}
          sha={divergence.expectedHeadSha}
        />
        <BranchFacet
          label={t("task-components:liveCheckedOut_842e7ba2")}
          branch={divergence.liveBranch}
          sha={divergence.liveHeadSha}
        />
      </div>
      {divergence.plainLanguageReason ? (
        <p className="text-xs leading-5 text-foreground/80">{divergence.plainLanguageReason}</p>
      ) : null}
      {divergence.contention ? (
        <p
          data-testid="recovery-contention-notice"
          className="flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-500/5 px-2.5 py-1.5 text-xs leading-5 text-amber-900 dark:text-amber-200"
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span><Trans ns="task-components" i18nKey="sentence_b036568ba00e" components={{ part1: <>{<code className="font-mono text-foreground/90">{contentionLabel(divergence.contention)}</code>}</>, part2: <>{divergence.contention.hasActiveRun ? t("task-components:activeRun_66a9e1b6") : t("task-components:claimHeld_20b3f865")}</> }} /></span>
        </p>
      ) : null}
    </div>
  );
}

function contentionLabel(contention: WorkspaceContention): string {
  return (
    contention.claimedByIssueIdentifier ??
    (contention.claimedByIssueId ? t("deep-ui:recovery_claiming_issue", { id: contention.claimedByIssueId.slice(0, 8) }) : t("deep-ui:another_task_ffc544"))
  );
}

/**
 * Action 2 — the audited break-glass override. Gated by an explicit confirm step that *restates the
 * divergence* (both branches + short SHAs + ancestry verdict) and a required, non-empty reason: the
 * confirm button stays disabled until the operator records why. The server re-checks the actor and
 * permission and appends the reason to the audit log — this UI gate is the operator-facing guardrail,
 * not the security boundary.
 */
function BreakGlassOverride({
  divergence,
  onConfirm,
  pending,
}: {
  divergence: WorkspaceDivergence;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  useTranslation("task-components");
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length > 0 && !pending;
  const verdictBadge = ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"];
  const expectedSha = formatShortSha(divergence.expectedHeadSha);
  const liveSha = formatShortSha(divergence.liveHeadSha);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="recovery-action-breakglass-trigger"
          className="border-red-400/60 text-red-700 hover:bg-red-500/10 dark:border-red-500/40 dark:text-red-300"
        >
          <OctagonAlert className="h-3.5 w-3.5" aria-hidden />{t("task-components:iVeVerifiedThisReconcileAnyway_d3c10467")}</Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-labelledby="recovery-breakglass-title"
        className="w-96 max-w-(--sz-calc-4) space-y-3 p-3"
      >
        <div className="space-y-1">
          <div
            id="recovery-breakglass-title"
            className="flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-red-700 dark:text-red-300"
          >
            <OctagonAlert className="h-3.5 w-3.5" aria-hidden />{t("task-components:breakGlassReconciliation_73512366")}</div>
          <p className="text-xs leading-5 text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_a2cac01eb39e" components={{ part1: <>{<span className="font-medium text-foreground/80">{t("task-components:withoutAnAncestryProof_d4c337c4")}</span>}</> }} /></p>
        </div>
        <dl
          data-testid="recovery-breakglass-restated-divergence"
          className="space-y-1.5 rounded-md border border-red-400/40 bg-red-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:recordedExpected_1869f1a4")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? t("task-components:detached_88e34e4c")}
              {expectedSha ? ` @ ${expectedSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:liveCheckedOut_842e7ba2")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? t("task-components:detached_88e34e4c")}
              {liveSha ? ` @ ${liveSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:ancestryVerdict_bee6031b")}</dt>
            <dd className="font-medium">{verdictBadge.label}</dd>
          </div>
        </dl>
        <div className="space-y-1">
          <Label htmlFor="recovery-breakglass-reason" className="text-(length:--text-micro) text-muted-foreground">{t("task-components:reason_f81ab834")}{" "}<span className="text-red-600 dark:text-red-400">{t("task-components:requiredRecordedInTheAuditLog_b0e8acff")}</span>
          </Label>
          <Textarea
            id="recovery-breakglass-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("task-components:eGVerifiedTheLiveBranchCarries_df2b78ba")}
            className="min-h-20 text-xs"
            data-testid="recovery-breakglass-reason"
            aria-required="true"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="w-full"
          disabled={!canSubmit}
          data-testid="recovery-action-breakglass-confirm"
          onClick={() => {
            if (!canSubmit) return;
            onConfirm(trimmedReason);
          }}
        >
          {pending ? t("task-components:reconciling_8adbed64") : t("task-components:reconcileAnywayBreakGlass_b9913635")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The lossless repair — quarantine the dirty worktree onto a rescue branch, then restore the
 * recorded branch. Unlike break-glass, this is *non-destructive* (no work is lost, so no reason is
 * required): the confirm popover simply restates what will happen — the dirty file count, that the
 * live branch is left untouched, the rescue branch that will hold the changes, and the recorded
 * branch to be restored. Disabled (with an inline explanation, no popover) when the live branch is
 * contended by another workspace, since the server refuses the repair in that case.
 */
function RepairWorkspace({
  divergence,
  onConfirm,
  pending,
  disabled,
  disabledReason,
}: {
  divergence: WorkspaceDivergence;
  onConfirm: () => void;
  pending: boolean;
  disabled: boolean;
  disabledReason: string | null;
}) {
  useTranslation("task-components");
  const dirtyCount = divergence.dirtyFileCount;
  const dirtyLabel =
    dirtyCount === null
      ? t("deep-ui:uncommitted_changes_a388bd")
      : t("deep-ui:recovery_dirty_count", { count: dirtyCount });
  const trigger = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending || disabled}
      data-testid="recovery-action-repair-trigger"
      className="border-sky-400/50 text-sky-700 hover:bg-sky-500/10 dark:border-sky-500/40 dark:text-sky-300"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Wrench className="h-3.5 w-3.5" aria-hidden />
      )}{t("task-components:repairWorkspaceQuarantineChangesRestoreBranch_e8da323d")}</Button>
  );
  if (disabled) {
    // Contended: the server refuses the repair, so render a plainly disabled control with the reason
    // inline rather than a popover the operator can't act on.
    return (
      <div className="flex flex-col gap-1" data-testid="recovery-action-repair-disabled">
        {trigger}
        {disabledReason ? (
          <span className="text-(length:--text-nano) leading-4 text-muted-foreground">
            {disabledReason}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-labelledby="recovery-repair-title"
        className="w-96 max-w-(--sz-calc-4) space-y-3 p-3"
      >
        <div className="space-y-1">
          <div
            id="recovery-repair-title"
            className="flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-sky-700 dark:text-sky-300"
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />{t("task-components:repairWorkspace_152f148b")}</div>
          <p className="text-xs leading-5 text-muted-foreground">{t("task-components:thisIsLosslessNoReasonRequiredYour_d38bf6fc")}</p>
        </div>
        <dl
          data-testid="recovery-repair-restated"
          className="space-y-1.5 rounded-md border border-sky-400/30 bg-sky-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:dirtyChanges_29f59cc3")}</dt>
            <dd data-testid="recovery-repair-dirty-count" className="font-medium text-foreground/90">
              {dirtyLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:liveBranch_b0d6b594")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? t("task-components:detached_88e34e4c")}
              <span className="ml-1 font-sans text-muted-foreground">{t("task-components:leftUntouched_2500b7ae")}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:rescueBranch_e1151230")}</dt>
            <dd
              data-testid="recovery-repair-rescue-branch"
              className="min-w-0 truncate font-mono text-foreground/90"
            >
              {divergence.rescueBranchPreview}
              <span className="text-muted-foreground">&lt;timestamp&gt;</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("task-components:restoreTo_9d1b6771")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? t("task-components:recordedBranch_9a6e1632")}
            </dd>
          </div>
        </dl>
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={pending}
          data-testid="recovery-action-repair-confirm"
          onClick={() => {
            if (pending) return;
            onConfirm();
          }}
        >
          {pending ? t("task-components:repairing_fb4c616e") : t("task-components:quarantineChangesRestoreBranch_e648b8fc")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function readWakePolicySummary(action: IssueRecoveryAction): string | null {
  const policy = action.wakePolicy;
  if (!policy) return null;
  const type = readEvidenceString(policy.type);
  if (!type) return null;
  if (type === "wake_owner") return t("deep-ui:an_agent_will_be_asked_to_choose_the_next_step_9beb9b");
  if (type === "bounded_owner_disposition_repair") {
    return t("deep-ui:paperclip_is_retrying_the_original_owner_833a8a");
  }
  if (type === "bounded_recovery_owner") return t("deep-ui:a_recovery_owner_is_repairing_the_next_step_f927e4");
  if (type === "board_escalation") return t("deep-ui:board_decision_required_e69366");
  if (type === "manual") return t("deep-ui:manual_follow_up_needed_9bd119");
  if (type === "manual_repair_required") return t("deep-ui:repair_needed_before_retry_a014a1");
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval ? t("deep-ui:recovery_check_scheduled", { interval }) : t("deep-ui:check_scheduled_c0f5c8");
  }
  return type.replaceAll("_", " ");
}

function formatTimeShort(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMs = date.getTime() - now;
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    if (absMin < 60) {
      return diffMs >= 0 ? t("deep-ui:recovery_in_minutes", { minutes: absMin }) : t("task-components:mAgo_28f5747c", { value1: absMin });
    }
    return date.toLocaleString(i18n.language, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function shortenRunId(runId: string | null | undefined) {
  if (!runId) return null;
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  useTranslation("task-components");
  return (
    <div className="grid grid-cols-(--gtc-8) gap-x-3 gap-y-0 px-3 py-1.5 text-xs sm:px-4">
      <dt className="truncate text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

function MissingValue() {
  useTranslation("task-components");
  return <span className="text-muted-foreground">—</span>;
}

function AgentLink({
  agentId,
  agentMap,
  fallback,
}: {
  agentId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Agent>;
  fallback?: string | null;
}) {
  useTranslation("task-components");
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label = agent?.name ?? t("deep-ui:recovery_agent_id", { id: agentId.slice(0, 8) });
  if (agent) {
    return (
      <Link
        to={agentUrl(agent)}
        className="rounded-sm font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}

function RunChip({
  runId,
  agentId,
  status,
}: {
  runId: string | null;
  agentId: string | null | undefined;
  status?: string | null;
}) {
  useTranslation("task-components");
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
        {t("final-boundary:runLabel", { id: short })}
      </code>
      {status ? (
        <span className="font-sans text-(length:--text-micro) text-muted-foreground">{status}</span>
      ) : null}
    </>
  );
  if (agentId) {
    return (
      <Link
        to={`/agents/${agentId}/runs/${runId}`}
        className="inline-flex items-center gap-2 rounded-sm underline-offset-2 hover:underline"
      >
        {inner}
      </Link>
    );
  }
  return <span className="inline-flex items-center gap-2">{inner}</span>;
}

function formatTimeAbsolute(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Headline for an action carrying a bounded retry lineage. It describes the recovery
 * state and next step without implying that a repair owner owns the deliverable.
 */
function lineageHeadline(lineage: RecoveryRetryLineage): string {
  if (lineage.lane === "native_run") {
    if (lineage.liveRunId) return t("deep-ui:paperclip_is_recovering_the_existing_run_e42d42");
    if (lineage.exhausted) return t("deep-ui:paperclip_could_not_recover_the_existing_run_within_its_retr_f094d6");
    if (lineage.retryExpired) return t("deep-ui:the_retry_for_the_existing_run_came_due_and_did_not_start_re_0d510e");
    if (lineage.nextRetryAt) return t("deep-ui:paperclip_has_scheduled_another_attempt_to_resume_the_existi_57633e");
    return t("deep-ui:the_existing_run_still_needs_recovery_review_the_recorded_fa_79370a");
  }
  // An attempt that came due and never ran leaves nobody working on this task, even though
  // attempts remain on paper. Say so before any lane wording that ends in "no action needed".
  if (lineage.retryExpired) {
    return t("deep-ui:this_task_s_automatic_retry_came_due_and_did_not_run_so_noth_5f7988");
  }
  if (lineage.lane === "source_owner") {
    return lineage.exhausted
      ? t("deep-ui:this_task_s_last_run_stopped_to_wait_but_nothing_was_waiting_03ede3")
      : t("deep-ui:this_task_s_last_run_stopped_to_wait_but_nothing_was_waiting_66f300");
  }
  if (lineage.lane === "recovery_owner") {
    return t("deep-ui:the_original_owner_could_not_record_a_next_step_within_its_r_87adaa");
  }
  return t("deep-ui:automatic_recovery_is_exhausted_so_the_board_must_choose_the_efd50a");
}

/** Spent/remaining attempts as pips. The readable count lives beside it in text. */
function AttemptMeter({ lineage }: { lineage: RecoveryRetryLineage }) {
  useTranslation("task-components");
  if (lineage.maxAttempts === null || lineage.maxAttempts > 12) return null;
  const spent = Math.min(lineage.attempt, lineage.maxAttempts);
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {Array.from({ length: lineage.maxAttempts }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 rounded-full",
            index < spent ? "bg-current opacity-80" : "bg-current opacity-25",
          )}
        />
      ))}
    </span>
  );
}

const RESOLVE_OPTIONS: Array<{
  outcome: RecoveryResolveOutcome;
  label: string;
  description: string;
  destructive?: boolean;
  boardOnly?: boolean;
}> = [
  {
    outcome: "todo",
    get label() { return t("task-components:tryAgain_d8b8392e"); },
    get description() { return t("task-components:dismissRecoveryAndReturnTheSourceTask_349c0362"); },
  },
  {
    outcome: "done",
    get label() { return t("task-components:markTaskDone_b33502ef"); },
    get description() { return t("task-components:restoreByRecordingTheRequestedWorkAs_c6d92468"); },
  },
  {
    outcome: "in_review",
    get label() { return t("task-components:sendForReview_f7cb7531"); },
    get description() { return t("task-components:handOffToAReviewerWithA_6c2fe06e"); },
  },
  {
    outcome: "false_positive_done",
    get label() { return t("task-components:falsePositiveDone_d72c84ea"); },
    get description() { return t("task-components:dismissRecoveryAndMarkTheSourceTask_887a2af6"); },
    destructive: true,
    boardOnly: true,
  },
  {
    outcome: "false_positive_in_review",
    get label() { return t("task-components:falsePositiveReview_26b07b9b"); },
    get description() { return t("task-components:dismissRecoveryAndSendTheSourceTask_fecfa574"); },
    destructive: true,
    boardOnly: true,
  },
];

export function IssueRecoveryActionCard({
  action,
  agentMap,
  scheduledRetry = null,
  forcedState,
  onResolve,
  onReissueIsolated,
  reissuePending = false,
  onReconcileForward,
  onBreakGlassOverride,
  onQuarantineRestore,
  quarantineRestorePending = false,
  canBreakGlass = false,
  reconcilePending = false,
  canFalsePositive = false,
  variant = "full",
  className,
}: IssueRecoveryActionCardProps) {
  useTranslation("task-components");
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const liveness = useMemo(() => ({ scheduledRetry }), [scheduledRetry]);
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action, liveness);
  const tone = STATE_TONE[cardState];
  const ToneIcon = tone.Icon;
  const divergence = useMemo(() => readWorkspaceDivergence(action), [action]);
  const lineage = useMemo(() => readRecoveryRetryLineage(action, liveness), [action, liveness]);

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      return t("deep-ui:recovery_resolved_as", { outcome: OUTCOME_LABEL[action.outcome] ?? action.outcome });
    }
    if (
      (cardState === "needed" || cardState === "escalated") &&
      action.kind === "active_run_watchdog" &&
      action.ownerType === "board"
    ) {
      return t("deep-ui:this_recovery_needs_a_human_decision_review_the_recorded_fai_bdc727");
    }
    if (lineage) return lineageHeadline(lineage);
    return KIND_HEADLINE[action.kind] ?? KIND_HEADLINE.missing_disposition;
  }, [action.kind, action.outcome, action.ownerType, cardState, lineage]);

  // A lane with no path left must not keep advertising a retry that will never run — whether
  // the budget ran out or the scheduled attempt simply never fired.
  const wakeSummary = lineage?.retryExpired
    ? t("deep-ui:the_scheduled_retry_did_not_run_a_retry_or_a_decision_is_nee_ed36a2")
    : lineage?.exhausted && !lineage.liveRunId && lineage.lane !== "board"
    ? t("deep-ui:automatic_retries_are_finished_a_decision_is_needed_82f7e2")
    : readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  // The lineage rows below already carry the attempt budget, so the generic chip only
  // covers actions without one.
  const showAttempt = !lineage && action.attemptCount > 1 && action.maxAttempts !== null;
  const sourceOwnerAgentId = action.returnOwnerAgentId ?? action.previousOwnerAgentId;
  const recoveryOwnerIsSourceOwner =
    action.ownerType === "agent" &&
    action.ownerAgentId !== null &&
    action.ownerAgentId === sourceOwnerAgentId;
  const retryOffset = lineage ? formatRecoveryRetryOffset(lineage) : null;
  const attemptLabel = lineage ? formatRecoveryAttemptLabel(lineage) : null;
  const showTimeoutInline = (() => {
    // The retry-progress row is the single place a lineage reports its timing.
    if (lineage) return false;
    if (!action.timeoutAt) return false;
    try {
      const date = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 && diffMs < 60 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  const updatedAtLabel = formatTimeShort(action.updatedAt);

  const ariaState = ({
    needed: "needed",
    in_progress: t("deep-ui:in_progress_2b6b85"),
    observe_only: t("deep-ui:observing_active_run_70a09b"),
    escalated: "escalated",
    resolved: "resolved",
  } satisfies Record<RecoveryCardCardState, string>)[cardState];

  const visibleResolveOptions = RESOLVE_OPTIONS.filter((option) => {
    if (action.cause === "native_workspace_finalization_owner_unverified") return false;
    if (isNativeWorkspaceExportRepairCause(action.cause) && ["todo", "done", "in_review"].includes(option.outcome)) return false;
    if (option.outcome === "todo" && requiresExecutionReconciliation(action.cause)) return false;
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });
  const showResolveActions = onResolve !== undefined && cardState !== "resolved" && visibleResolveOptions.length > 0;
  const reissueBaseRef = divergence?.reissueBaseRef ?? null;
  const showReissueAction =
    workspaceIsolationControlsVisible &&
    onReissueIsolated !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    reissueBaseRef !== null;
  const reissueVerdictBadge = divergence
    ? ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"]
    : null;
  // Action 1 — the ancestry-proven safe path. Only offered when the server-computed verdict is
  // "ancestor"; the server re-verifies before mutating, so this gate mirrors (not replaces) it.
  const showReconcileForward =
    onReconcileForward !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    divergence.ancestryVerdict === "ancestor";
  // Action 2 — the break-glass override. Permission-hidden: absent entirely unless the viewer is a
  // permitted operator. The confirm step (restated divergence + required reason) lives in the popover.
  const showBreakGlass =
    onBreakGlassOverride !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    canBreakGlass;
  // The lossless repair — offered only for a *dirty* divergence (a clean one reconciles forward or
  // via break-glass, with nothing to quarantine). Disabled when the live branch is contended by an
  // active claimant, since the server refuses `quarantine_restore` in that case.
  const repairContention = divergence?.contention ?? null;
  const showRepairAction =
    onQuarantineRestore !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    divergence.cleanliness === "dirty";
  const repairDisabledReason = repairContention
    ? showReissueAction ? t("deep-ui:recovery_held_reissue", { owner: contentionLabel(repairContention) }) : t("deep-ui:recovery_held", { owner: contentionLabel(repairContention) })
    : null;
  // When contended, the re-issue is the recommended path, so it takes the primary emphasis and a
  // "Recommended" hint while the repair button is disabled.
  const reissueRecommended = showRepairAction && repairContention !== null;
  const showFooter =
    showResolveActions ||
    showReissueAction ||
    showReconcileForward ||
    showBreakGlass ||
    showRepairAction;

  if (requiresExecutionReconciliation(action.cause) || action.cause === "native_workspace_sync_out_unsafe_archive") return null;

  return (
    <section
      role="status"
      aria-label={t("task-components:recoveryAction_68da7343", { value1: ariaState })}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
      data-recovery-lane={lineage?.lane}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-(--shadow-extract-8)",
        tone.containerClass,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone.iconWrapClass,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tone.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)">
            <span className={tone.labelClass}>{tone.label}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) tracking-normal text-muted-foreground">
              {KIND_LABEL[action.kind] ?? action.kind}
            </code>
            {updatedAtLabel ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {updatedAtLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-6">{headline}</p>
        </div>
      </header>
      {variant === "compact" ? null : (
      <dl className={cn("border-t bg-background/40 dark:bg-background/20", tone.divider)}>
        {lineage ? (
          <>
            <MetadataRow label={t("task-components:taskOwner_e600ccf8")}>
              <span
                className="inline-flex flex-wrap items-center gap-1.5"
                data-testid="recovery-source-owner"
              >
                <AgentLink
                  agentId={sourceOwnerAgentId}
                  agentMap={agentMap}
                  fallback="unassigned"
                />
                <span className="text-muted-foreground">{t("task-components:keepsThisTask_6fffd595")}</span>
              </span>
            </MetadataRow>
            <MetadataRow label={t("task-components:recoveryOwner_27c6c04c")}>
              <span
                className="inline-flex flex-wrap items-center gap-1.5"
                data-testid="recovery-recovery-owner"
              >
                {lineage.lane === "native_run" && (action.ownerType !== "board" || Boolean(lineage.liveRunId)) ? (
                  <>
                    <span className="font-medium">Paperclip</span>
                    <span className="text-muted-foreground">{t("task-components:recoversTheExistingRun_12f7f1d3")}</span>
                  </>
                ) : recoveryOwnerIsSourceOwner ? (
                  <span className="font-medium">{t("task-components:originalOwnerRetryingItself_21196882")}</span>
                ) : action.ownerType === "agent" && action.ownerAgentId ? (
                  <>
                    <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
                    <span className="text-muted-foreground">{t("task-components:repairsTheNextStepOnly_907769bc")}</span>
                  </>
                ) : action.ownerType === "board" ? (
                  <>
                    <span className="font-medium">{t("task-components:board_4816cbfd")}</span>
                    <span className="text-muted-foreground">{t("task-components:decidesTheNextStepOnly_425ea666")}</span>
                  </>
                ) : action.ownerType === "user" && action.ownerUserId ? (
                  <span className="font-medium"><Trans ns="task-components" i18nKey="sentence_0629bedc93f7" components={{ part1: <>{action.ownerUserId.slice(0, 6)}</> }} /></span>
                ) : (
                  <span className="text-muted-foreground">{t("task-components:unassignedPickOneToWakeThem_68903e71")}</span>
                )}
              </span>
            </MetadataRow>
            <MetadataRow label={t("task-components:retryProgress_edb85d9f")}>
              <span
                className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
                data-testid="recovery-retry-progress"
                data-recovery-lane={lineage.lane}
                data-recovery-attempt={lineage.attempt}
                data-recovery-max-attempts={lineage.maxAttempts ?? undefined}
              >
                <AttemptMeter lineage={lineage} />
                <span>{attemptLabel ?? t("task-components:attemptsNotBounded_3ccd1bed")}</span>
                {lineage.liveRunId ? (
                  <span
                    className={RETRY_PILL_CLASS}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                  >{t("task-components:attemptRunningNow_5ff77617")}</span>
                ) : lineage.retryExpired ? (
                  // The due time is stated plainly as missed. Rendering it as "Next try 5m
                  // ago" is what made an abandoned lane read as healthy recovery.
                  <span
                    className={cn(RETRY_PILL_CLASS, "border-destructive/50 bg-destructive/10 text-destructive")}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                    data-recovery-retry-expired="true"
                  >
                    {retryOffset ? t("task-components:retryMissed_80eb02e6", { value1: retryOffset }) : t("task-components:retryMissed_a3e392ad")}
                  </span>
                ) : retryOffset ? (
                  <span
                    className={RETRY_PILL_CLASS}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                  >
                    {retryOffset === "now" ? t("task-components:nextTryNow_3101ffa0") : t("task-components:nextTry_c3c3652c", { value1: retryOffset })}
                  </span>
                ) : lineage.exhausted ? (
                  <span className={RETRY_PILL_CLASS} data-testid="recovery-next-retry">{t("task-components:automaticRetriesUsedUp_d074fd7d")}</span>
                ) : null}
              </span>
            </MetadataRow>
            {lineage.lane !== "source_owner" && lineage.sourceMaxAttempts !== null ? (
              <MetadataRow label={t("task-components:ownerRetries_1db44f58")}>
                <span data-testid="recovery-source-attempts">{t("deep-ui:recovery_source_attempts", { attempts: lineage.sourceAttempt ?? lineage.sourceMaxAttempts, max: lineage.sourceMaxAttempts })}</span>
              </MetadataRow>
            ) : null}
          </>
        ) : (
        <MetadataRow label={t("task-components:owner_4b1b8aa3")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">{t("task-components:recovery_a812f4b2")}</span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">{t("task-components:board_4816cbfd")}</span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium"><Trans ns="task-components" i18nKey="sentence_0629bedc93f7" components={{ part1: <>{action.ownerUserId.slice(0, 6)}</> }} /></span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">{t("task-components:system_6725e7bb")}</span>
            ) : (
              <span className="text-muted-foreground">{t("task-components:unassignedPickOneToWakeThem_68903e71")}</span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">{t("task-components:returnsTo_1e820759")}</span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        )}
        <MetadataRow label={t("task-components:sourceRun_bb84312e")}>
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow label={t("task-components:correctiveRun_87e1de42")}>
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow label={t("task-components:evidence_03867aea")}>
          {evidenceSummary ? (
            evidenceSummary.isCode ? (
              <span className="break-words font-mono text-(length:--text-micro) text-foreground/80">
                {evidenceSummary.text}
              </span>
            ) : (
              <span className="text-xs leading-5 text-foreground/80">{evidenceSummary.text}</span>
            )
          ) : (
            <MissingValue />
          )}
        </MetadataRow>
        <MetadataRow label={t("task-components:nextAction_365987d0")}>
          {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
        </MetadataRow>
        <MetadataRow label={t("task-components:followUp_09b2d9cd")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">{t("final-boundary:attemptBudget", { attempt: action.attemptCount, max: action.maxAttempts })}</span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_da7a86f25072" components={{ part1: <>{formatTimeShort(action.timeoutAt) ?? t("task-components:soon_4a754148")}</> }} /></span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow label={t("task-components:resolution_d4055faf")}>
            <span className={cn("font-medium", tone.labelClass)}><Trans ns="task-components" i18nKey="sentence_127fda420ae8" components={{ part1: <>{OUTCOME_LABEL[action.outcome]}</>, part2: <>{action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}</> }} /></span>
          </MetadataRow>
        ) : null}
      </dl>
      )}
      {divergence ? <DivergenceDiagnosis divergence={divergence} dividerClass={tone.divider} /> : null}
      {showFooter ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          {showResolveActions ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="recovery-action-resolve-trigger"
                  aria-label={t("task-components:resolveRecovery_0e77e521")}
                >{t("task-components:resolve_a55fea56")}</Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-72 p-1.5"
              >
                <div className="px-2 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:resolveRecovery_0e77e521")}</div>
                <div className="flex flex-col">
                  {visibleResolveOptions.map((option) => (
                    <button
                      key={option.outcome}
                      type="button"
                      onClick={() => onResolve?.(option.outcome)}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        option.destructive ? "text-destructive" : null,
                      )}
                    >
                      <span className="font-medium leading-5">{option.label}</span>
                      <span className="text-(length:--text-micro) leading-4 text-muted-foreground">{option.description}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {showReconcileForward ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={reconcilePending}
              data-testid="recovery-action-reconcile-forward"
              onClick={() => onReconcileForward?.()}
            >
              {reconcilePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}{t("task-components:reconcileForwardContinue_b2b80494")}</Button>
          ) : null}
          {showRepairAction && divergence ? (
            <RepairWorkspace
              divergence={divergence}
              pending={quarantineRestorePending}
              disabled={repairContention !== null}
              disabledReason={repairDisabledReason}
              onConfirm={() => onQuarantineRestore?.()}
            />
          ) : null}
          {showReissueAction && divergence && reissueBaseRef ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={reissueRecommended ? "default" : "outline"}
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-trigger"
                  data-recommended={reissueRecommended ? "true" : undefined}
                >
                  {reissuePending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <GitBranchPlus className="h-3.5 w-3.5" aria-hidden />
                  )}{t("task-components:reIssueOnIsolatedWorkspace_21625ad5")}{reissueRecommended ? (
                    <span
                      data-testid="recovery-reissue-recommended"
                      className="ml-1 rounded-sm bg-background/25 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label)"
                    >{t("task-components:recommended_d70604e8")}</span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 space-y-3 p-3">
                <div className="space-y-1">
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:reIssueOnIsolatedWorkspace_21625ad5")}</div>
                  <p className="text-xs leading-5 text-muted-foreground">{t("task-components:createsAFreshCopyOfThisTask_251d91cd")}</p>
                </div>
                <dl className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-(length:--text-micro)">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t("task-components:baseRef_9c6c10f9")}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/90">{reissueBaseRef}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t("task-components:recorded_c7175fa7")}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/80">
                      {divergence.expectedBranch ?? "—"}
                    </dd>
                  </div>
                  {reissueVerdictBadge ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{t("task-components:ancestry_65a04682")}</dt>
                      <dd className="font-medium">{reissueVerdictBadge.label}</dd>
                    </div>
                  ) : null}
                </dl>
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-confirm"
                  onClick={() =>
                    onReissueIsolated?.({
                      baseRef: reissueBaseRef,
                      liveBranch: divergence.liveBranch,
                      liveHeadSha: divergence.liveHeadSha,
                      expectedBranch: divergence.expectedBranch,
                    })
                  }
                >
                  {reissuePending ? t("task-components:creating_c79ed949") : t("task-components:createIsolatedReIssue_3d7a1128")}
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
          {showBreakGlass && divergence ? (
            <BreakGlassOverride
              divergence={divergence}
              pending={reconcilePending}
              onConfirm={(reason) => onBreakGlassOverride?.(reason)}
            />
          ) : null}
          {showResolveActions ? (
            cardState === "observe_only" ? (
              <span className="text-(length:--text-micro) text-muted-foreground">{t("task-components:recoveryIsObservingWithoutInterruptingTheLive_b2a50809")}</span>
            ) : (
              <span className="text-(length:--text-micro) text-muted-foreground">{t("task-components:theCardStaysOpenUntilAnExplicit_84526fce")}</span>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
