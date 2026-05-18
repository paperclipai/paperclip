import type {
  HarnessReliabilityActionKind,
  HarnessReliabilityCategory,
  HarnessReliabilityOwnerKind,
  HarnessReliabilitySeverity,
} from "./taxonomy.js";
import {
  HARNESS_RELIABILITY_CATEGORY_CATALOG,
  getHarnessReliabilityCategoryDescriptor,
} from "./taxonomy.js";

/**
 * Normalized input the classifier consumes. Callers (server liveness scan,
 * recovery service, UI preview tooling) are expected to project their
 * internal records into this shape so the classifier stays pure and easy to
 * test. All fields are optional — the classifier degrades to `unclassified`
 * when there is not enough signal.
 */
export type HarnessReliabilitySignal = {
  /** Current run-liveness state from RUN_LIVENESS_STATES, if known. */
  runLivenessState?:
    | "completed"
    | "advanced"
    | "plan_only"
    | "empty_response"
    | "blocked"
    | "failed"
    | "needs_followup"
    | null;
  /** Current heartbeat-run status from HEARTBEAT_RUN_STATUSES, if known. */
  heartbeatRunStatus?:
    | "queued"
    | "scheduled_retry"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | null;
  /** Issue status, if known. */
  issueStatus?:
    | "backlog"
    | "todo"
    | "in_progress"
    | "in_review"
    | "done"
    | "blocked"
    | "cancelled"
    | null;
  /** True if the run/agent left durable artifacts (diff, comment, document, work product). */
  hasUsefulOutput?: boolean;
  /** True if a final disposition was recorded for the latest run. */
  dispositionRecorded?: boolean;
  /** True if the adapter or worker process reported a transport-level failure. */
  adapterLost?: boolean;
  /** True if an active blocker exists but is itself resolved/done/cancelled. */
  hasStaleBlocker?: boolean;
  /** Recent recovery actions counted within the active dedup window. */
  recentRecoveryActionCount?: number;
  /** True if a review or QA stage produced a rejection verdict. */
  reviewOrQaRejected?: boolean;
  /** True if work stalled inside a review/QA stage past the expected runtime. */
  reviewOrQaStageHung?: boolean;
  /** True if work is paused on a human/board approval (deploy, spend, scope). */
  awaitingApproval?: boolean;
  /** True if work is held by a release window or release-manager gate. */
  awaitingReleaseWindow?: boolean;
  /** True if the assignee comment loop detected its own latest comment as the wake source. */
  selfWakeLoop?: boolean;
};

export type HarnessReliabilityVerdict = {
  category: HarnessReliabilityCategory;
  owner: HarnessReliabilityOwnerKind;
  action: HarnessReliabilityActionKind;
  severity: HarnessReliabilitySeverity;
  label: string;
  description: string;
  /** Ordered list of signal keys that drove this verdict. Useful for UI evidence rows. */
  reasonCodes: readonly string[];
};

const DUPLICATE_RECOVERY_THRESHOLD = 2;

/**
 * Pure classifier. Order matters: harder-stop categories win over softer
 * ones, so we evaluate from "explicit hold" upward to "healthy".
 */
export function classifyHarnessReliabilitySignal(
  signal: HarnessReliabilitySignal,
): HarnessReliabilityVerdict {
  const reasons: string[] = [];

  // 1. Explicit holds — these are not failures, surface them as such.
  if (signal.awaitingApproval) {
    reasons.push("awaitingApproval");
    return verdictFor("approval_hold", reasons);
  }
  if (signal.awaitingReleaseWindow) {
    reasons.push("awaitingReleaseWindow");
    return verdictFor("release_hold", reasons);
  }

  // 2. Review / QA outcomes outrank duplicate-recovery noise: a real
  // rejection or a hung gate is the next-owner truth.
  if (signal.reviewOrQaRejected) {
    reasons.push("reviewOrQaRejected");
    return verdictFor("review_or_qa_failure", reasons);
  }
  if (signal.reviewOrQaStageHung) {
    reasons.push("reviewOrQaStageHung");
    return verdictFor("review_or_qa_failure", reasons);
  }

  // 3. Stale blocker — issue is blocked on a phantom dependency.
  if (signal.issueStatus === "blocked" && signal.hasStaleBlocker) {
    reasons.push("hasStaleBlocker");
    return verdictFor("stale_blocker", reasons);
  }

  // 4. Duplicate recovery — many recovery actions or self-wake loops on the
  // same signal. Stop and dedup before burning more budget.
  if (
    (signal.recentRecoveryActionCount ?? 0) >= DUPLICATE_RECOVERY_THRESHOLD ||
    signal.selfWakeLoop === true
  ) {
    if (signal.selfWakeLoop) reasons.push("selfWakeLoop");
    if ((signal.recentRecoveryActionCount ?? 0) >= DUPLICATE_RECOVERY_THRESHOLD) {
      reasons.push("recentRecoveryActionCount");
    }
    return verdictFor("duplicate_recovery", reasons);
  }

  // 5. Useful output but missing disposition — work happened but was never
  // closed out. Forward action is recording disposition, not redoing work.
  if (signal.hasUsefulOutput && signal.dispositionRecorded === false) {
    reasons.push("hasUsefulOutput");
    reasons.push("dispositionMissing");
    return verdictFor("useful_output_missing_disposition", reasons);
  }

  // 6. Adapter / process loss — transport-level failure, possibly with
  // useful output still on disk.
  if (signal.adapterLost) {
    reasons.push("adapterLost");
    return verdictFor("adapter_or_process_loss", reasons);
  }
  if (
    signal.heartbeatRunStatus === "timed_out" ||
    signal.heartbeatRunStatus === "cancelled"
  ) {
    reasons.push(`heartbeatRunStatus=${signal.heartbeatRunStatus}`);
    return verdictFor("adapter_or_process_loss", reasons);
  }

  // 7. Product failure — run finished but the product contract failed.
  if (
    signal.runLivenessState === "failed" ||
    signal.heartbeatRunStatus === "failed"
  ) {
    if (signal.runLivenessState === "failed") reasons.push("runLivenessState=failed");
    if (signal.heartbeatRunStatus === "failed") {
      reasons.push("heartbeatRunStatus=failed");
    }
    return verdictFor("product_failure", reasons);
  }

  // 8. Healthy in-progress — forward motion signals.
  if (
    signal.heartbeatRunStatus === "running" ||
    signal.heartbeatRunStatus === "queued" ||
    signal.heartbeatRunStatus === "scheduled_retry" ||
    signal.runLivenessState === "advanced" ||
    signal.runLivenessState === "completed" ||
    signal.issueStatus === "in_progress" ||
    signal.issueStatus === "in_review"
  ) {
    if (signal.heartbeatRunStatus) {
      reasons.push(`heartbeatRunStatus=${signal.heartbeatRunStatus}`);
    }
    if (signal.runLivenessState) {
      reasons.push(`runLivenessState=${signal.runLivenessState}`);
    }
    if (signal.issueStatus) reasons.push(`issueStatus=${signal.issueStatus}`);
    return verdictFor("healthy_in_progress", reasons);
  }

  // 9. Fallback — caller should triage rather than silently drop.
  return verdictFor("unclassified", reasons);
}

function verdictFor(
  category: HarnessReliabilityCategory,
  reasons: readonly string[],
): HarnessReliabilityVerdict {
  const descriptor = getHarnessReliabilityCategoryDescriptor(category);
  return {
    category,
    owner: descriptor.owner,
    action: descriptor.action,
    severity: descriptor.severity,
    label: descriptor.label,
    description: descriptor.description,
    reasonCodes: reasons,
  };
}

/**
 * Compact summary suitable for Command Center evidence rows. Stable shape
 * across taxonomy revisions: callers can render this without knowing the
 * category enum.
 */
export type HarnessReliabilityEvidenceRow = {
  label: string;
  ownerLabel: string;
  actionLabel: string;
  severity: HarnessReliabilitySeverity;
  description: string;
  reasonCodes: readonly string[];
};

const OWNER_LABEL: Record<HarnessReliabilityOwnerKind, string> = {
  assignee_agent: "Assignee agent",
  reviewer_agent: "Reviewer agent",
  qa_agent: "QA agent",
  orchestrator: "Orchestrator",
  release_manager: "Release manager",
  ceo: "CEO",
  human_operator: "Human operator",
  platform: "Platform",
  none: "—",
};

const ACTION_LABEL: Record<HarnessReliabilityActionKind, string> = {
  investigate_and_fix: "Investigate and fix product output",
  retry_adapter: "Retry adapter / restart worker",
  record_disposition: "Record final disposition",
  refresh_blocker_or_unblock: "Refresh blocker or unblock",
  deduplicate_recovery: "Deduplicate recovery actions",
  rerun_review_or_qa: "Rerun review or QA",
  await_approval_decision: "Await approval decision",
  await_release_window: "Await release window",
  continue_in_progress: "Continue in progress",
  triage_unclassified: "Triage unclassified signal",
};

export function harnessReliabilityVerdictToEvidenceRow(
  verdict: HarnessReliabilityVerdict,
): HarnessReliabilityEvidenceRow {
  return {
    label: verdict.label,
    ownerLabel: OWNER_LABEL[verdict.owner],
    actionLabel: ACTION_LABEL[verdict.action],
    severity: verdict.severity,
    description: verdict.description,
    reasonCodes: verdict.reasonCodes,
  };
}

/**
 * Re-export so consumers can render owner/action labels without importing
 * internal maps.
 */
export const HARNESS_RELIABILITY_OWNER_LABELS = OWNER_LABEL;
export const HARNESS_RELIABILITY_ACTION_LABELS = ACTION_LABEL;
export { HARNESS_RELIABILITY_CATEGORY_CATALOG };
