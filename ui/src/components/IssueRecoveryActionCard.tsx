import { useMemo, useState } from "react";
import type {
  Agent,
  GitWorktreeBranchAncestryVerdict,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
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
  missing_disposition: "Missing Disposition",
  stranded_assigned_issue: "Stranded Task",
  workspace_validation: "Workspace Validation",
  configuration_validation: "Configuration Validation",
  active_run_watchdog: "Active Watchdog",
  issue_graph_liveness: "Task Needs Next Step",
};

const KIND_HEADLINE: Record<IssueRecoveryActionKind, string> = {
  missing_disposition:
    "This task's run finished, but no next step was chosen. Choose what happens next — try the task again, mark it done, or send it for review.",
  stranded_assigned_issue:
    "Paperclip retried this task's last run, but there is still no queued run, reviewer, blocker, or other next owner. To get it moving, choose what happens next — try the task again, mark it done, or send it for review.",
  workspace_validation:
    "Paperclip stopped this run because the task's git workspace could not be validated.",
  configuration_validation:
    "Paperclip stopped before dispatching this run because required secret/env bindings are missing.",
  active_run_watchdog:
    "The active run has been silent. Recovery is observing without interrupting it.",
  issue_graph_liveness:
    "Paperclip could not find a clear next step for this open task. Choose whether to continue work, send it for review, mark it done, or record what is blocking it.",
};

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
    label: "RECOVERY NEEDED",
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    label: "RECOVERY IN PROGRESS",
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    label: "OBSERVING ACTIVE RUN",
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    label: "RECOVERY ESCALATED",
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    label: "RECOVERY RESOLVED",
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
  handed_back: "handed back to original owner",
  owner_completed: "completed by recovery owner",
  delegated: "delegated to follow-up",
  false_positive: "false positive",
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
    label: "Forward-only",
    className: "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  diverged: {
    label: "Diverged",
    className: "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  unknown: {
    label: "Ancestry unknown",
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
          <span className="text-xs italic text-muted-foreground">detached / unknown</span>
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
        <span className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          Divergence diagnosis
        </span>
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
          label="Expected · recorded"
          branch={divergence.expectedBranch}
          sha={divergence.expectedHeadSha}
        />
        <BranchFacet
          label="Live · checked out"
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
          <span>
            Worktree claimed by{" "}
            <code className="font-mono text-foreground/90">{contentionLabel(divergence.contention)}</code>{" "}
            {divergence.contention.hasActiveRun ? "(active run)" : "(claim held)"} — the lossless repair
            can&apos;t run while another workspace holds the live branch.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function contentionLabel(contention: WorkspaceContention): string {
  return (
    contention.claimedByIssueIdentifier ??
    (contention.claimedByIssueId ? `issue ${contention.claimedByIssueId.slice(0, 8)}` : "another task")
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
          <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
          I&apos;ve verified this — reconcile anyway
        </Button>
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
            <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
            Break-glass reconciliation
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            This overrides Paperclip&apos;s safety check and points the recorded workspace at the live
            branch{" "}
            <span className="font-medium text-foreground/80">without an ancestry proof</span>. Confirm
            the divergence below and record why before continuing.
          </p>
        </div>
        <dl
          data-testid="recovery-breakglass-restated-divergence"
          className="space-y-1.5 rounded-md border border-red-400/40 bg-red-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Recorded · expected</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? "detached"}
              {expectedSha ? ` @ ${expectedSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Live · checked out</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? "detached"}
              {liveSha ? ` @ ${liveSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Ancestry verdict</dt>
            <dd className="font-medium">{verdictBadge.label}</dd>
          </div>
        </dl>
        <div className="space-y-1">
          <Label htmlFor="recovery-breakglass-reason" className="text-(length:--text-micro) text-muted-foreground">
            Reason <span className="text-red-600 dark:text-red-400">(required — recorded in the audit log)</span>
          </Label>
          <Textarea
            id="recovery-breakglass-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Verified the live branch carries only the intended follow-up commits; safe to adopt."
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
          {pending ? "Reconciling…" : "Reconcile anyway (break-glass)"}
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
  const dirtyCount = divergence.dirtyFileCount;
  const dirtyLabel =
    dirtyCount === null
      ? "Uncommitted changes"
      : `${dirtyCount} uncommitted ${dirtyCount === 1 ? "change" : "changes"}`;
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
      )}
      Repair workspace — quarantine changes &amp; restore branch
    </Button>
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
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            Repair workspace
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            This is lossless — no reason required. Your uncommitted changes are committed onto a fresh
            rescue branch, then the recorded branch is restored so the task can resume. The live branch
            is left exactly as it is.
          </p>
        </div>
        <dl
          data-testid="recovery-repair-restated"
          className="space-y-1.5 rounded-md border border-sky-400/30 bg-sky-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Dirty changes</dt>
            <dd data-testid="recovery-repair-dirty-count" className="font-medium text-foreground/90">
              {dirtyLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Live branch</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? "detached"}
              <span className="ml-1 font-sans text-muted-foreground">(left untouched)</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Rescue branch</dt>
            <dd
              data-testid="recovery-repair-rescue-branch"
              className="min-w-0 truncate font-mono text-foreground/90"
            >
              {divergence.rescueBranchPreview}
              <span className="text-muted-foreground">&lt;timestamp&gt;</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">Restore to</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? "recorded branch"}
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
          {pending ? "Repairing…" : "Quarantine changes & restore branch"}
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
  if (type === "wake_owner") return "An agent will be asked to choose the next step";
  if (type === "board_escalation") return "Board will decide";
  if (type === "manual") return "Manual follow-up needed";
  if (type === "manual_repair_required") return "Repair needed before retry";
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval ? `Check scheduled · ${interval}` : "Check scheduled";
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
      return diffMs >= 0 ? `in ${absMin}m` : `${absMin}m ago`;
    }
    return date.toLocaleString(undefined, {
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
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label = agent?.name ?? `agent ${agentId.slice(0, 8)}`;
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
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
        run {short}
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

const RESOLVE_OPTIONS: Array<{
  outcome: RecoveryResolveOutcome;
  label: string;
  description: string;
  destructive?: boolean;
  boardOnly?: boolean;
}> = [
  {
    outcome: "todo",
    label: "Try again",
    description: "Dismiss recovery and return the source task to todo.",
  },
  {
    outcome: "done",
    label: "Mark task done",
    description: "Restore by recording the requested work as complete.",
  },
  {
    outcome: "in_review",
    label: "Send for review",
    description: "Hand off to a reviewer with a real review path.",
  },
  {
    outcome: "false_positive_done",
    label: "False positive, done",
    description: "Dismiss recovery and mark the source task complete.",
    destructive: true,
    boardOnly: true,
  },
  {
    outcome: "false_positive_in_review",
    label: "False positive, review",
    description: "Dismiss recovery and send the source task for review.",
    destructive: true,
    boardOnly: true,
  },
];

export function IssueRecoveryActionCard({
  action,
  agentMap,
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
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action);
  const tone = STATE_TONE[cardState];
  const ToneIcon = tone.Icon;
  const divergence = useMemo(() => readWorkspaceDivergence(action), [action]);

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      return `Recovery resolved as ${OUTCOME_LABEL[action.outcome] ?? action.outcome}.`;
    }
    return KIND_HEADLINE[action.kind] ?? KIND_HEADLINE.missing_disposition;
  }, [action.kind, action.outcome, cardState]);

  const wakeSummary = readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  const showAttempt = action.attemptCount > 1 && action.maxAttempts !== null;
  const showTimeoutInline = (() => {
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
    in_progress: "in progress",
    observe_only: "observing active run",
    escalated: "escalated",
    resolved: "resolved",
  } satisfies Record<RecoveryCardCardState, string>)[cardState];

  const showResolveActions = onResolve !== undefined && cardState !== "resolved";
  const visibleResolveOptions = RESOLVE_OPTIONS.filter((option) => {
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });
  const reissueBaseRef = divergence?.reissueBaseRef ?? null;
  const showReissueAction =
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
    ? `Held by ${contentionLabel(repairContention)} — re-issue on an isolated workspace instead.`
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

  return (
    <section
      role="status"
      aria-label={`Recovery action: ${ariaState}`}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
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
        <MetadataRow label="Owner">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">Recovery:</span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">Board</span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium">user {action.ownerUserId.slice(0, 6)}</span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">System</span>
            ) : (
              <span className="text-muted-foreground">unassigned — pick one to wake them</span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">→ Returns to:</span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        <MetadataRow label="Source run">
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow label="Corrective run">
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow label="Evidence">
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
        <MetadataRow label="Next action">
          {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
        </MetadataRow>
        <MetadataRow label="Follow-up">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                attempt {action.attemptCount} of {action.maxAttempts}
              </span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                Times out {formatTimeShort(action.timeoutAt) ?? "soon"}
              </span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow label="Resolution">
            <span className={cn("font-medium", tone.labelClass)}>
              Resolved as {OUTCOME_LABEL[action.outcome]}
              {action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}
            </span>
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
                  aria-label="Resolve recovery"
                >
                  Resolve…
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-72 p-1.5"
              >
                <div className="px-2 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                  Resolve recovery
                </div>
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
              )}
              Reconcile forward &amp; continue
            </Button>
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
                  )}
                  Re-issue on isolated workspace
                  {reissueRecommended ? (
                    <span
                      data-testid="recovery-reissue-recommended"
                      className="ml-1 rounded-sm bg-background/25 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label)"
                    >
                      Recommended
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 space-y-3 p-3">
                <div className="space-y-1">
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    Re-issue on isolated workspace
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Creates a fresh copy of this task on an isolated git worktree based on the live
                    branch. Your current workspace and its commits are left untouched.
                  </p>
                </div>
                <dl className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-(length:--text-micro)">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">Base ref</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/90">{reissueBaseRef}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">Recorded</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/80">
                      {divergence.expectedBranch ?? "—"}
                    </dd>
                  </div>
                  {reissueVerdictBadge ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Ancestry</dt>
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
                  {reissuePending ? "Creating…" : "Create isolated re-issue"}
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
              <span className="text-(length:--text-micro) text-muted-foreground">
                Recovery is observing without interrupting the live run.
              </span>
            ) : (
              <span className="text-(length:--text-micro) text-muted-foreground">
                The card stays open until an explicit decision is recorded.
              </span>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
