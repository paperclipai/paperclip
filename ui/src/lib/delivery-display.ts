/**
 * Presentation helpers for the delivery lifecycle surfaces.
 *
 * Colors route through `statusBadge` (the shared status vocabulary) so a check
 * result, a delivery phase, and a reconciliation classification read the same
 * way as every other status chip in the app. Types and enum members come from
 * `@paperclipai/shared`; only labels and tones live here.
 */
import { DELIVERY_RECONCILIATION_CLASSIFICATIONS } from "@paperclipai/shared";
import type {
  DeliveryDisposition,
  DeliveryFinding,
  DeliveryFindingDisposition,
  DeliveryFindingState,
  DeliveryMergeMethod,
  DeliveryMergeQueueMode,
  DeliveryAutoDeployDisposition,
  DeliveryPolicy,
  DeliveryPolicyAuthorization,
  DeliveryProvenance,
  DeliveryReconciliationClassification,
  DeliveryReconciliationInventory,
  DeliveryReconciliationItem,
  DeliverySummary,
} from "@paperclipai/shared";
import { statusBadge, statusBadgeDefault } from "./status-colors";

export type DeliveryTone = "success" | "failure" | "pending" | "neutral" | "warning";

const TONE_BADGE_KEY: Record<DeliveryTone, string> = {
  success: "succeeded",
  failure: "failed",
  pending: "pending",
  neutral: "archived",
  warning: "warning",
};

/** Chip classes for a delivery tone, reusing the shared status-badge recipes. */
export function deliveryToneBadge(tone: DeliveryTone): string {
  return statusBadge[TONE_BADGE_KEY[tone]] ?? statusBadgeDefault;
}

export const DELIVERY_MERGE_METHOD_LABELS: Record<DeliveryMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const DELIVERY_MERGE_QUEUE_MODE_LABELS: Record<DeliveryMergeQueueMode, string> = {
  serialized: "Serialized protected merge",
  native_merge_queue: "GitHub native merge queue",
};

export const DELIVERY_AUTO_DEPLOY_DISPOSITION_LABELS: Record<DeliveryAutoDeployDisposition, string> = {
  none: "Deployment effect not yet verified",
  block_merge: "Block merge when the target auto-deploys",
  no_auto_deploy: "No automatic deployment — merge only",
  authorized: "Deployment authority recorded",
};

export const DELIVERY_FINDING_DISPOSITION_LABELS: Record<DeliveryFindingDisposition, string> = {
  fixed: "Fixed",
  disputed: "Disputed",
  already_addressed: "Already addressed",
};

export const DELIVERY_FINDING_STATE_LABELS: Record<DeliveryFindingState, string> = {
  open: "Open",
  fixed: "Fixed",
  disputed: "Disputed",
  already_addressed: "Already addressed",
  stale: "Stale head",
};

/**
 * Provider check conclusion → tone. Unknown conclusions are `pending`, never
 * success: an unrecognized provider state must not read as passing.
 */
export function checkStatusTone(status: string | null | undefined): DeliveryTone {
  const normalized = (status ?? "").trim().toLowerCase();
  if (!normalized) return "pending";
  if (["success", "succeeded", "completed", "passed", "pass", "ok"].includes(normalized)) return "success";
  if (["neutral", "skipped", "cancelled_by_provider"].includes(normalized)) return "neutral";
  if (
    ["failure", "failed", "error", "timed_out", "cancelled", "action_required", "stale", "startup_failure"].includes(
      normalized,
    )
  ) {
    return "failure";
  }
  return "pending";
}

export function deliveryCheckLabel(status: string | null | undefined): string {
  const normalized = (status ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/_/g, " ");
}

/** `abc1234…` — machine values stay short and monospace at the call site. */
export function shortSha(sha: string | null | undefined, length = 7): string | null {
  if (!sha) return null;
  return sha.length > length ? sha.slice(0, length) : sha;
}

/**
 * A review is stale when the reviewed head is not the branch head. Either side
 * missing is not stale — absence of evidence is surfaced separately, never as
 * a pass.
 */
export function isReviewStale(
  reviewedHeadSha: string | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!reviewedHeadSha || !headSha) return false;
  return reviewedHeadSha !== headSha;
}

export function findingStateLabel(state: DeliveryFinding["state"] | null | undefined): string | null {
  if (!state) return null;
  return DELIVERY_FINDING_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

export function findingDispositionLabel(disposition: string | null | undefined): string | null {
  if (!disposition) return null;
  return (
    DELIVERY_FINDING_DISPOSITION_LABELS[disposition as DeliveryFindingDisposition] ??
    disposition.replace(/_/g, " ")
  );
}

/** Queue identity: one durable queue per canonical repository + target branch. */
export function deliveryQueueKey(summary: Pick<DeliverySummary, "repository" | "targetBranch">): string {
  return `${summary.repository ?? "unknown repository"}::${summary.targetBranch ?? "default branch"}`;
}

export function deliveryQueueLabel(summary: Pick<DeliverySummary, "repository" | "targetBranch">): string {
  return `${summary.repository ?? "Unknown repository"} → ${summary.targetBranch ?? "default branch"}`;
}

export interface DeliveryQueueGroup {
  key: string;
  repository: string | null;
  targetBranch: string | null;
  items: DeliverySummary[];
}

/** Group a company delivery feed into its per-repository/target queues. */
export function groupDeliveryQueues(items: readonly DeliverySummary[]): DeliveryQueueGroup[] {
  const groups = new Map<string, DeliveryQueueGroup>();
  for (const item of items) {
    const key = deliveryQueueKey(item);
    let group = groups.get(key);
    if (!group) {
      group = { key, repository: item.repository, targetBranch: item.targetBranch, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return Array.from(groups.values()).sort((left, right) => left.key.localeCompare(right.key));
}

export function reconciliationClassificationLabel(
  classification: DeliveryReconciliationItem["classification"] | null | undefined,
): string {
  const normalized = (classification ?? "").trim().toLowerCase();
  if (normalized === "code_verified") return "Code verified";
  if (normalized === "code_unverified") return "Code unverified";
  if (normalized === "non_code") return "Non-code";
  if (normalized === "unknown") return "Unknown";
  if (!normalized) return "Unknown";
  return normalized.replace(/_/g, " ");
}

export function reconciliationClassificationTone(
  classification: DeliveryReconciliationItem["classification"] | null | undefined,
): DeliveryTone {
  const normalized = (classification ?? "").trim().toLowerCase();
  if (normalized === "code_verified") return "success";
  if (normalized === "non_code") return "neutral";
  if (normalized === "code_unverified") return "warning";
  return "warning";
}

export function reconciliationOutcomeLabel(outcome: DeliveryReconciliationItem["outcome"] | null | undefined): string {
  const normalized = (outcome ?? "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.replace(/_/g, " ");
}

export interface ReconciliationCountRow {
  classification: DeliveryReconciliationClassification;
  label: string;
  tone: DeliveryTone;
  count: number;
}

/**
 * Inventory counts. The server's `counts` record is authoritative; when it is
 * absent the rows are tallied from the items themselves.
 */
export function reconciliationCounts(
  counts: DeliveryReconciliationInventory["counts"] | undefined,
  items: readonly DeliveryReconciliationItem[],
): ReconciliationCountRow[] {
  const tally = new Map<DeliveryReconciliationClassification, number>();
  if (!counts) {
    for (const item of items) {
      tally.set(item.classification, (tally.get(item.classification) ?? 0) + 1);
    }
  }
  return DELIVERY_RECONCILIATION_CLASSIFICATIONS
    .filter((classification) => counts !== undefined || tally.has(classification))
    .map((classification) => ({
      classification,
      label: reconciliationClassificationLabel(classification),
      tone: reconciliationClassificationTone(classification),
      count: counts?.[classification] ?? tally.get(classification) ?? 0,
    }));
}

/** One-line accepted-revision provenance for the reconciliation table. */
export function provenanceLabel(provenance: DeliveryProvenance | null | undefined): string | null {
  if (!provenance) return null;
  const merged = shortSha(provenance.mergedSha);
  const parts = [
    merged ? `merged ${merged}` : null,
    provenance.mergeMethod,
    provenance.squashOrRebase ? "rewritten" : null,
    `${provenance.checks.length} ${provenance.checks.length === 1 ? "check" : "checks"}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Full provenance detail for a tooltip — every recorded receipt field. */
export function provenanceDetail(provenance: DeliveryProvenance | null | undefined): string | null {
  if (!provenance) return null;
  return [
    `${provenance.repository} → ${provenance.targetBranch} (from ${provenance.sourceBranch})`,
    `submitted ${provenance.submittedHeadSha}`,
    `accepted ${provenance.acceptedHeadSha}`,
    `merged ${provenance.mergedSha}`,
    provenance.mergeCommitSha ? `merge commit ${provenance.mergeCommitSha}` : null,
    provenance.baseSha ? `base ${provenance.baseSha}` : null,
    `method ${provenance.mergeMethod}`,
    `review ${provenance.reviewStatus} (${provenance.blockingFindings} blocking)`,
    `verified ${provenance.verifiedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function dispositionLabel(disposition: DeliveryDisposition | null | undefined): string | null {
  if (!disposition) return null;
  return `${disposition.reasonCode} — ${disposition.message}`;
}

export function dispositionDetail(disposition: DeliveryDisposition | null | undefined): string | null {
  if (!disposition) return null;
  return [
    `reason ${disposition.reasonCode}`,
    disposition.owner ? `owner ${disposition.owner}` : null,
    disposition.nextAction ? `next ${disposition.nextAction}` : null,
    `by ${disposition.actorType} ${disposition.actorId}`,
    `at ${disposition.at}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Server-owned standing-authorization record, rendered read-only. */
export function authorizationLabel(authorization: DeliveryPolicyAuthorization | null | undefined): string | null {
  if (!authorization) return null;
  return `Approved by ${authorization.approvedByUserId} · ${authorization.approvedAt} · ${authorization.scope} scope`;
}

/** Scope fields that voided a standing authorization, in operator words. */
export function authorizationScopeLabel(scope: readonly string[] | null | undefined): string | null {
  if (!scope || scope.length === 0) return null;
  return scope.map((field) => AUTHORIZATION_SCOPE_LABELS[field] ?? field).join(", ");
}

const AUTHORIZATION_SCOPE_LABELS: Record<string, string> = {
  repository: "repository identity",
  targetBranch: "target branch",
  mergeMethod: "merge method",
  mergeQueueMode: "merge queue mode",
  requiredChecks: "required checks",
  requireGreptile: "Greptile requirement",
  requireIndependentApproval: "independent approval requirement",
  githubConnectionId: "GitHub connection",
  greptileConnectionId: "Greptile connection",
  autoDeployDisposition: "deployment disposition",
  authorization: "the authorization record itself",
};

/**
 * Why there is no standing authority. `missing` and `invalidated` are different
 * operator facts and are never rendered as the same sentence: the first needs
 * a first decision, the second needs a re-decision for the scope that changed.
 */
export function authorizationStateMessage(
  policy: Pick<DeliveryPolicy, "authorization" | "authorizationState" | "authorizationInvalidatedScope"> | null | undefined,
): string {
  if (policy?.authorizationState === "invalidated") {
    const scope = authorizationScopeLabel(policy.authorizationInvalidatedScope);
    return scope
      ? `No standing authorization: a material scope change (${scope}) voided the recorded authorization. Re-authorize the changed scope.`
      : "No standing authorization: the recorded authorization was removed. Re-authorize before automated merge resumes.";
  }
  return "No standing authorization recorded. The delivery service keeps automated merge off until an operator records one.";
}

/**
 * Review tone. Only an explicit approval reads as success: `unknown` (a failed
 * or superseded read) is never painted as a pass.
 */
export function reviewStatusTone(status: string | null | undefined, blockingFindings: number): DeliveryTone {
  if (blockingFindings > 0) return "failure";
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "approved") return "success";
  if (normalized === "unknown") return "warning";
  if (normalized === "changes_requested") return "failure";
  return "pending";
}
