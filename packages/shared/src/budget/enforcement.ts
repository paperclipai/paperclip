// Budgeting lifecycle enforcement — agent-budgeting policy §4.1/§4.3. Pure
// helpers shared by the POST /cost/preflight and POST /cost/charge handlers
// (server) and any client that needs to interpret a budget decision. No I/O.
//
// Two concerns live here:
//   1. capFiringAction() — map one cap's current utilization to the action it is
//      firing (the threshold-band → action rule, §2.2/§4.3).
//   2. enforcementResponse() / preflightDecision() — translate a resolved
//      binding action into the §4.3 HTTP enforcement code and the §4.1 preflight
//      decision enum.

import type { BudgetCapAction } from "./cap-precedence.js";

// §4.1 preflight decision enum returned to the adapter.
export const PREFLIGHT_DECISIONS = ["allow", "warn", "require_approval", "deny"] as const;
export type PreflightDecision = (typeof PREFLIGHT_DECISIONS)[number];

// The threshold band a cap's current utilization falls in. `warn` covers
// [warnAtPercent, hardStopAtPercent); `critical` is the [criticalAtPercent,
// hardStopAtPercent) sub-band that makes preflight mandatory (§4.1) and raises
// the alert severity, but is still warn-class for enforcement. `enforce` is
// [hardStopAtPercent, ∞): the cap's configured `action` fully applies (and for a
// hard_stop cap this is the deny line — §4.3: "hard_stop is the only action that
// can be triggered at preflight to prevent the call entirely").
export type CapBand = "clear" | "warn" | "critical" | "enforce";

export interface CapThresholds {
  warnAtPercent: number;
  criticalAtPercent: number;
  hardStopAtPercent: number;
}

export function capBand(thresholds: CapThresholds, currentPercent: number): CapBand {
  if (currentPercent >= thresholds.hardStopAtPercent) return "enforce";
  if (currentPercent >= thresholds.criticalAtPercent) return "critical";
  if (currentPercent >= thresholds.warnAtPercent) return "warn";
  return "clear";
}

// The action a single cap is firing right now. In the warn/critical bands the
// only emitted action is `warn` (graduated alert — the real enforcement action
// is held until the hard-stop line so an in-flight call always completes and
// observability is preserved, §4.3). At/above hardStopAtPercent the cap's
// configured `action` applies. Returns null when the cap is not firing.
export function capFiringAction(
  cap: { action: BudgetCapAction } & CapThresholds,
  currentPercent: number,
): BudgetCapAction | null {
  switch (capBand(cap, currentPercent)) {
    case "enforce":
      return cap.action;
    case "critical":
    case "warn":
      return "warn";
    case "clear":
      return null;
  }
}

// §4.3 enforcement code map. The HTTP status + policy error code a write-path
// caller (POST /cost/charge, or the runtime gate) returns when the binding cap's
// action is enforcing. `warn` and `require_approval` are not HTTP-blocking on
// the charge path (the row is always recorded — the cost was incurred), so they
// have no enforcement response here.
export interface EnforcementResponse {
  status: number;
  code: string;
}

const ENFORCEMENT_RESPONSES: Partial<Record<BudgetCapAction, EnforcementResponse>> = {
  pause_writes: { status: 429, code: "policy.budget_paused_writes" },
  pause_runs: { status: 429, code: "policy.budget_paused_runs" },
  hard_stop: { status: 503, code: "policy.budget_hard_stopped" },
};

export function enforcementResponse(action: BudgetCapAction | null): EnforcementResponse | null {
  return action ? ENFORCEMENT_RESPONSES[action] ?? null : null;
}

// §4.1 preflight decision from the resolved binding action plus whether any
// approval gate is firing (and unmet). hard_stop → deny (the only pre-emptive
// block); an unmet approval gate → require_approval; any softer firing action →
// warn; nothing firing → allow.
export function preflightDecision(
  action: BudgetCapAction | null,
  hasUnmetApprovalGate: boolean,
): PreflightDecision {
  if (action === "hard_stop") return "deny";
  if (hasUnmetApprovalGate || action === "require_approval") return "require_approval";
  if (action) return "warn";
  return "allow";
}
