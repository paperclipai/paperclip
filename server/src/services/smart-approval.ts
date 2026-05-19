// smart-approval.ts — capability-tag-based fast-execute routing.
//
// Companion to rule-of-two.ts: where Rule of Two gates IRREVERSIBLE actions
// at the issue level (untrusted + external_state_change + private), this
// module classifies individual ACTIONS at the operation level and routes
// cheap-and-reversible ones to a fast-execute path.
//
// Smart approval is ADDITIVE. Rule of Two still gates the risky issues;
// this just gives the cheap actions a clean "execute, log, move on" path
// instead of also gating them.
//
// Decision matrix (from RInc/docs/orchestration-architecture-2026-05-19.md
// §6 IMPROVE flow + §10 Q6):
//
//   file edit / cache write / search / paperclip comment   -> execute
//   gbrain page write                                      -> execute
//   api call < $0.50 / repo commit (no push)               -> execute
//   git push to feature branch                             -> execute + notify
//   git push to main / force push                          -> approve (rule of two)
//   external email / IAM / cron / sudoers                  -> approve (rule of two)
//   untrusted + external state change                      -> approve (rule of two)
//   cost-bearing > $X/mo delta                             -> approve if over threshold

export type SmartApprovalDecision = "execute" | "notify" | "approve";

export type SmartApprovalActionClass =
  | "file_edit"
  | "cache_write"
  | "search"
  | "paperclip_comment"
  | "gbrain_page_write"
  | "small_api_call"
  | "repo_commit"
  | "git_push_feature"
  | "git_push_main"
  | "git_force_push"
  | "external_email"
  | "iam_change"
  | "cron_change"
  | "sudoers_change"
  | "cost_bearing"
  | "untrusted_external"
  | "unknown";

export interface SmartApprovalAction {
  // Free-form short identifier (matches an entry in the matrix below).
  kind: string;
  // Optional caller-supplied capability tags. Same shape as Rule of Two.
  capabilityTags?: {
    untrusted?: boolean;
    private?: boolean;
    external_state_change?: boolean;
  } | null;
  // Optional cost delta in USD per month. > COST_THRESHOLD_USD_MO -> approve.
  costDeltaUsdPerMonth?: number | null;
  // Optional single-call dollar cost. < 0.50 implies "small_api_call" if kind matches.
  callCostUsd?: number | null;
  // Optional branch identifier (used when kind=git_push to refine class).
  branch?: string | null;
}

export interface SmartApprovalEvaluation {
  class: SmartApprovalActionClass;
  decision: SmartApprovalDecision;
  reasons: string[];
}

// Per spec: cost-bearing delta > this approves.
export const SMART_APPROVAL_COST_THRESHOLD_USD_PER_MONTH = 50;
// Per spec: api calls under this auto-execute.
export const SMART_APPROVAL_SMALL_CALL_USD = 0.5;

const KIND_TO_CLASS: Readonly<Record<string, SmartApprovalActionClass>> = {
  file_edit: "file_edit",
  cache_write: "cache_write",
  search: "search",
  paperclip_comment: "paperclip_comment",
  gbrain_page_write: "gbrain_page_write",
  api_call: "small_api_call",
  small_api_call: "small_api_call",
  repo_commit: "repo_commit",
  git_commit: "repo_commit",
  git_push: "git_push_feature",
  git_push_feature: "git_push_feature",
  git_push_main: "git_push_main",
  git_force_push: "git_force_push",
  external_email: "external_email",
  iam_change: "iam_change",
  cron_change: "cron_change",
  sudoers_change: "sudoers_change",
  cost_bearing: "cost_bearing",
};

const ALWAYS_EXECUTE: ReadonlySet<SmartApprovalActionClass> = new Set([
  "file_edit",
  "cache_write",
  "search",
  "paperclip_comment",
  "gbrain_page_write",
  "repo_commit",
]);

const ALWAYS_APPROVE: ReadonlySet<SmartApprovalActionClass> = new Set([
  "git_push_main",
  "git_force_push",
  "external_email",
  "iam_change",
  "cron_change",
  "sudoers_change",
]);

// Map a kind string + optional branch hint to a class. We refine git_push
// based on branch name when both are present.
function resolveClass(action: SmartApprovalAction): SmartApprovalActionClass {
  const baseClass = KIND_TO_CLASS[action.kind] ?? "unknown";
  if (baseClass === "git_push_feature" && typeof action.branch === "string") {
    const branch = action.branch.trim();
    if (branch === "main" || branch === "master") return "git_push_main";
  }
  if (baseClass === "small_api_call" && typeof action.callCostUsd === "number") {
    if (action.callCostUsd >= SMART_APPROVAL_SMALL_CALL_USD) {
      return "cost_bearing";
    }
  }
  return baseClass;
}

// Classify an action into a routing decision.
// Pure function, no side effects.
export function classifyAction(action: SmartApprovalAction): SmartApprovalEvaluation {
  const reasons: string[] = [];

  // Rule of Two short-circuit: untrusted + external_state_change implies
  // approve regardless of action class.
  const tags = action.capabilityTags ?? null;
  const untrusted = tags?.untrusted === true;
  const externalStateChange = tags?.external_state_change === true;
  if (untrusted && externalStateChange) {
    reasons.push("capability_tags: untrusted+external_state_change");
    return {
      class: "untrusted_external",
      decision: "approve",
      reasons,
    };
  }

  const resolvedClass = resolveClass(action);
  reasons.push(`class: ${resolvedClass}`);

  if (ALWAYS_APPROVE.has(resolvedClass)) {
    return { class: resolvedClass, decision: "approve", reasons };
  }
  if (ALWAYS_EXECUTE.has(resolvedClass)) {
    return { class: resolvedClass, decision: "execute", reasons };
  }
  if (resolvedClass === "git_push_feature") {
    return { class: resolvedClass, decision: "notify", reasons };
  }
  if (resolvedClass === "small_api_call") {
    return { class: resolvedClass, decision: "execute", reasons };
  }
  if (resolvedClass === "cost_bearing") {
    const delta = action.costDeltaUsdPerMonth ?? action.callCostUsd ?? 0;
    if (delta > SMART_APPROVAL_COST_THRESHOLD_USD_PER_MONTH) {
      reasons.push(`cost_delta_usd_per_month: ${delta} > ${SMART_APPROVAL_COST_THRESHOLD_USD_PER_MONTH}`);
      return { class: resolvedClass, decision: "approve", reasons };
    }
    reasons.push(`cost_delta_usd_per_month: ${delta} <= ${SMART_APPROVAL_COST_THRESHOLD_USD_PER_MONTH}`);
    return { class: resolvedClass, decision: "execute", reasons };
  }

  // Unknown action: be conservative — approve.
  reasons.push("unknown action kind, defaulting to approve");
  return { class: "unknown", decision: "approve", reasons };
}
