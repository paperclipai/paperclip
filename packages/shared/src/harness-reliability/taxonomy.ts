/**
 * Agent Harness runtime reliability observability taxonomy (v0).
 *
 * This module defines a single shared vocabulary for *why a run, issue, or
 * agent-harness interaction did not produce the next forward step*. Each
 * category maps to a canonical owner and a canonical next action, so that
 * downstream surfaces (Command Center, dashboards, CEO escalations) never
 * have to say only "failed" or "stalled".
 *
 * v0 scope:
 *  - Internal classification contract only.
 *  - No production wiring, no deploys, no live flags.
 *  - Adjacent existing types (RunLivenessState, HeartbeatRunStatus,
 *    IssueRecoveryActionKind) are NOT replaced. This taxonomy sits one
 *    layer above them: it consumes their signals and emits an
 *    owner/next-action verdict.
 */

export const HARNESS_RELIABILITY_CATEGORIES = [
  "product_failure",
  "adapter_or_process_loss",
  "useful_output_missing_disposition",
  "stale_blocker",
  "duplicate_recovery",
  "review_or_qa_failure",
  "approval_hold",
  "release_hold",
  "healthy_in_progress",
  "unclassified",
] as const;
export type HarnessReliabilityCategory =
  (typeof HARNESS_RELIABILITY_CATEGORIES)[number];

export const HARNESS_RELIABILITY_OWNER_KINDS = [
  "assignee_agent",
  "reviewer_agent",
  "qa_agent",
  "orchestrator",
  "release_manager",
  "ceo",
  "human_operator",
  "platform",
  "none",
] as const;
export type HarnessReliabilityOwnerKind =
  (typeof HARNESS_RELIABILITY_OWNER_KINDS)[number];

export const HARNESS_RELIABILITY_ACTION_KINDS = [
  "investigate_and_fix",
  "retry_adapter",
  "record_disposition",
  "refresh_blocker_or_unblock",
  "deduplicate_recovery",
  "rerun_review_or_qa",
  "await_approval_decision",
  "await_release_window",
  "continue_in_progress",
  "triage_unclassified",
] as const;
export type HarnessReliabilityActionKind =
  (typeof HARNESS_RELIABILITY_ACTION_KINDS)[number];

export const HARNESS_RELIABILITY_SEVERITIES = [
  "info",
  "warn",
  "attention",
  "critical",
] as const;
export type HarnessReliabilitySeverity =
  (typeof HARNESS_RELIABILITY_SEVERITIES)[number];

/**
 * Canonical descriptor for one taxonomy category. Stored as a flat record so
 * UI/dashboards can render labels and routing without re-deriving them.
 */
export type HarnessReliabilityCategoryDescriptor = {
  category: HarnessReliabilityCategory;
  label: string;
  /** Human-readable one-line definition. Stable contract for UI tooltips. */
  description: string;
  /** Canonical owner who should resolve the situation. */
  owner: HarnessReliabilityOwnerKind;
  /** Canonical next action the owner is expected to take. */
  action: HarnessReliabilityActionKind;
  /** Default severity; classifier may upgrade per-signal. */
  severity: HarnessReliabilitySeverity;
};

export const HARNESS_RELIABILITY_CATEGORY_CATALOG: Record<
  HarnessReliabilityCategory,
  HarnessReliabilityCategoryDescriptor
> = {
  product_failure: {
    category: "product_failure",
    label: "Product failure",
    description:
      "The agent produced output that violates the product contract (wrong content, bad code, broken behavior) — not a harness/adapter issue.",
    owner: "assignee_agent",
    action: "investigate_and_fix",
    severity: "attention",
  },
  adapter_or_process_loss: {
    category: "adapter_or_process_loss",
    label: "Adapter / process loss",
    description:
      "The adapter, sandbox, or worker process died, timed out, or returned no output before the agent could finish. Useful-output may still exist on disk.",
    owner: "platform",
    action: "retry_adapter",
    severity: "attention",
  },
  useful_output_missing_disposition: {
    category: "useful_output_missing_disposition",
    label: "Useful output, missing disposition",
    description:
      "The run produced real artifacts (diff, comment, document) but never marked a final disposition. Next forward step is recording the disposition, not redoing the work.",
    owner: "assignee_agent",
    action: "record_disposition",
    severity: "warn",
  },
  stale_blocker: {
    category: "stale_blocker",
    label: "Stale blocker",
    description:
      "Issue is marked blocked but the named blocker is gone, resolved, or never landed. Holding the tree on a phantom dependency.",
    owner: "orchestrator",
    action: "refresh_blocker_or_unblock",
    severity: "attention",
  },
  duplicate_recovery: {
    category: "duplicate_recovery",
    label: "Duplicate recovery",
    description:
      "Multiple recovery actions, self-wakes, or retries fired for the same underlying signal. Continuing would burn budget without progress.",
    owner: "platform",
    action: "deduplicate_recovery",
    severity: "warn",
  },
  review_or_qa_failure: {
    category: "review_or_qa_failure",
    label: "Review / QA failure",
    description:
      "Review or QA stage rejected the work, or stalled past expected runtime. Forward path requires rerunning the gate or addressing the verdict.",
    owner: "reviewer_agent",
    action: "rerun_review_or_qa",
    severity: "attention",
  },
  approval_hold: {
    category: "approval_hold",
    label: "Approval hold",
    description:
      "Work is intentionally paused awaiting an explicit human or board approval (deploy, spend, scope expansion). Not a failure.",
    owner: "human_operator",
    action: "await_approval_decision",
    severity: "info",
  },
  release_hold: {
    category: "release_hold",
    label: "Release hold",
    description:
      "Work is ready but held by a release window, merge freeze, or release-manager gate. Not a failure.",
    owner: "release_manager",
    action: "await_release_window",
    severity: "info",
  },
  healthy_in_progress: {
    category: "healthy_in_progress",
    label: "Healthy in-progress",
    description:
      "Signals show productive forward motion (queued, running, recently advanced). No intervention required.",
    owner: "none",
    action: "continue_in_progress",
    severity: "info",
  },
  unclassified: {
    category: "unclassified",
    label: "Unclassified",
    description:
      "Signals do not yet match a v0 category. Surfaces should flag for triage rather than silently dropping the case.",
    owner: "orchestrator",
    action: "triage_unclassified",
    severity: "warn",
  },
};

export function listHarnessReliabilityCategoryDescriptors(): readonly HarnessReliabilityCategoryDescriptor[] {
  return HARNESS_RELIABILITY_CATEGORIES.map(
    (key) => HARNESS_RELIABILITY_CATEGORY_CATALOG[key],
  );
}

export function getHarnessReliabilityCategoryDescriptor(
  category: HarnessReliabilityCategory,
): HarnessReliabilityCategoryDescriptor {
  return HARNESS_RELIABILITY_CATEGORY_CATALOG[category];
}
