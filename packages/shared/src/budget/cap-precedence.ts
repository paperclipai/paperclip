// Cap precedence — agent-budgeting policy §2.3. When several caps apply to one
// charge, this resolves which cap's action is the one applied and which approval
// gates must clear. Pure function; the preflight/charge handlers (later legs)
// feed it the set of currently-firing caps and act on the result.
//
// §2.3 rules, encoded below:
//   1. Hardest action wins: hard_stop > pause_runs > pause_writes > require_approval > warn.
//   2. Earliest threshold wins within the same action: highest currentPercent binds.
//   3. Approval gates do not cascade: every firing gate is returned; each must clear.
//   4. Cluster cap is non-overridable: a per-company approval-grant cannot relax it.

export const BUDGET_CAP_ACTIONS = [
  "warn",
  "require_approval",
  "pause_writes",
  "pause_runs",
  "hard_stop",
] as const;
export type BudgetCapAction = (typeof BUDGET_CAP_ACTIONS)[number];

// Increasing severity; index is the rank used for "hardest action wins".
const ACTION_SEVERITY: Record<BudgetCapAction, number> = {
  warn: 0,
  require_approval: 1,
  pause_writes: 2,
  pause_runs: 3,
  hard_stop: 4,
};

export function actionSeverity(action: BudgetCapAction): number {
  return ACTION_SEVERITY[action];
}

/** The hardest (highest-severity) of two actions. */
export function hardestAction(a: BudgetCapAction, b: BudgetCapAction): BudgetCapAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

export interface ApprovalGate {
  approverRole: "ceo" | "cfo" | "manager" | "board";
  approvalType?: string;
  expiresMinutes?: number;
}

export interface CapEvaluation {
  capId: string;
  scope: string; // 'cluster' is treated specially (rule 4)
  scopeKey?: string;
  action: BudgetCapAction;
  /** windowSpend / limit * 100. The binding tie-break within an action. */
  currentPercent: number;
  approvalGate?: ApprovalGate | null;
  /**
   * True when this (non-cluster) cap has an unexpired approval grant, so its
   * action is relaxed for this charge. Cluster caps ignore this flag (rule 4).
   */
  relaxed?: boolean;
}

export interface FiringGate {
  capId: string;
  scope: string;
  scopeKey?: string;
  gate: ApprovalGate | null;
}

export interface CapResolution {
  /** The cap whose action governs the charge, or null when nothing binds. */
  binding: CapEvaluation | null;
  /** The action to apply: max(severity) of the binding cap and the cluster floor. */
  action: BudgetCapAction | null;
  /** Every firing approval gate; gates do not cascade, so each must clear (rule 3). */
  approvalGates: FiringGate[];
  /** Hardest cluster-scope action present, which no per-company grant can relax (rule 4). */
  clusterFloorAction: BudgetCapAction | null;
}

function isClusterScope(scope: string): boolean {
  return scope === "cluster";
}

// Binding tie-break: hardest action, then highest currentPercent, then stable by
// capId so the result is deterministic.
function moreBinding(a: CapEvaluation, b: CapEvaluation): CapEvaluation {
  const sevA = ACTION_SEVERITY[a.action];
  const sevB = ACTION_SEVERITY[b.action];
  if (sevA !== sevB) return sevA > sevB ? a : b;
  if (a.currentPercent !== b.currentPercent) return a.currentPercent > b.currentPercent ? a : b;
  return a.capId <= b.capId ? a : b;
}

/**
 * Resolve the binding cap and approval requirements from the set of firing caps.
 * `firing` is the set of caps whose threshold is crossed for this charge.
 */
export function resolveBindingCap(firing: readonly CapEvaluation[]): CapResolution {
  // Rule 4: cluster caps always contend, even if marked relaxed. Non-cluster
  // caps drop out of binding selection once approval-relaxed.
  const contenders = firing.filter((c) => isClusterScope(c.scope) || !c.relaxed);

  let binding: CapEvaluation | null = null;
  let clusterFloorAction: BudgetCapAction | null = null;
  for (const cap of contenders) {
    binding = binding ? moreBinding(binding, cap) : cap;
    if (isClusterScope(cap.scope)) {
      clusterFloorAction = clusterFloorAction
        ? hardestAction(clusterFloorAction, cap.action)
        : cap.action;
    }
  }

  // The applied action never falls below the non-overridable cluster floor.
  let action = binding?.action ?? null;
  if (clusterFloorAction && (!action || ACTION_SEVERITY[clusterFloorAction] > ACTION_SEVERITY[action])) {
    action = clusterFloorAction;
  }

  // Rule 3: collect every firing gate (require_approval action or an explicit
  // approvalGate). Relaxed non-cluster caps no longer fire a gate.
  const approvalGates: FiringGate[] = contenders
    .filter((c) => c.action === "require_approval" || c.approvalGate)
    .map((c) => ({ capId: c.capId, scope: c.scope, scopeKey: c.scopeKey, gate: c.approvalGate ?? null }));

  return { binding, action, approvalGates, clusterFloorAction };
}
