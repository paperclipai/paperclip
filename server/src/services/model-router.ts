import type { ModelProfileKey } from "@paperclipai/shared";

/** Signals gathered at dispatch time. Pure data — no DB/IO here. */
export interface ModelRouterSignals {
  /** contextSnapshot.wakeReason, or null. */
  wakeReason: string | null;
  /** issues.priority: low|medium|high|urgent, or null. */
  issuePriority: string | null;
  /** issues.originKind: manual|detector|..., or null. */
  issueOriginKind: string | null;
  /** Length proxy = title + description characters. */
  promptChars: number;
  /** True if this issue already hit a blocking error (anti-loop). */
  hasBlockingErrorHistory: boolean;
  /** Phase-2 classifier verdict, or null when rules run alone. */
  classifierVerdict?: "reasoning" | "fast" | null;
}

export interface ModelRouterDecision {
  /** "cheap" => Gemma; null => keep the agent default (Qwen). */
  profile: ModelProfileKey | null;
  /** Machine-readable reason, surfaced in run metadata. */
  reason: string;
  /** True when rules are inconclusive and a classifier should decide (Phase 2). */
  needsClassifier: boolean;
}

/** Wake reasons that always indicate substantive, multi-step work. */
const SUBSTANTIVE_WAKE_REASONS = new Set([
  "issue_assigned",
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
]);

/** Below this many chars a non-substantive task is confidently trivial. */
const PROMPT_SHORT_THRESHOLD = 600;

function isHighPriority(priority: string | null): boolean {
  return priority === "high" || priority === "urgent";
}

/**
 * Decide which model profile a task should use. Default is Qwen (profile=null);
 * only confidently-trivial tasks are downgraded to the "cheap" (Gemma) profile.
 * Pure and synchronous so it is fully unit-testable.
 */
export function routeModelProfile(signals: ModelRouterSignals): ModelRouterDecision {
  // 1. Anti-loop: never downgrade an issue that already failed hard.
  if (signals.hasBlockingErrorHistory) {
    return { profile: null, reason: "error_history", needsClassifier: false };
  }

  // 2. Substantive wake reason => reasoning model.
  if (signals.wakeReason && SUBSTANTIVE_WAKE_REASONS.has(signals.wakeReason)) {
    return { profile: null, reason: "substantive_wake_reason", needsClassifier: false };
  }

  // 3. High/urgent priority => reasoning model.
  if (isHighPriority(signals.issuePriority)) {
    return { profile: null, reason: "high_priority", needsClassifier: false };
  }

  // 4. An explicit classifier verdict (Phase 2) wins for everything below.
  if (signals.classifierVerdict === "fast") {
    return { profile: "cheap", reason: "classifier_fast", needsClassifier: false };
  }
  if (signals.classifierVerdict === "reasoning") {
    return { profile: null, reason: "classifier_reasoning", needsClassifier: false };
  }

  // 5. Confidently trivial: short prompt + non-substantive wake reason.
  if (signals.promptChars <= PROMPT_SHORT_THRESHOLD) {
    return { profile: "cheap", reason: "short_non_substantive", needsClassifier: false };
  }

  // 6. Long & ambiguous: stay on Qwen, but flag for the classifier (Phase 2).
  return { profile: null, reason: "inconclusive", needsClassifier: true };
}
