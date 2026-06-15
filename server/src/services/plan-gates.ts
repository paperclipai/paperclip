import {
  GATE_APPROVAL_TYPES,
  type GateApprovalType,
  type IssueBlockedInboxReason,
  type PlanGateProfile,
} from "@paperclipai/shared";

// Pure helpers for the advisory dev-team gate protocol. No DB access here — the
// plan service composes these specs and performs the inserts, which keeps the
// mapping/precedence logic unit-testable in isolation.

const GATE_TYPE_SET = new Set<string>(Object.values(GATE_APPROVAL_TYPES));

export function isGateApprovalType(type: string): type is GateApprovalType {
  return GATE_TYPE_SET.has(type);
}

// urlKey of the agent each gate is routed to. Resolved by the plan service
// against company agents; a missing match falls back to the board.
export const GATE_DESIGNATED_URL_KEY: Record<GateApprovalType, string> = {
  [GATE_APPROVAL_TYPES.planApproval]: "architect",
  [GATE_APPROVAL_TYPES.codeReview]: "code-reviewer",
  [GATE_APPROVAL_TYPES.wiringReview]: "wiring-expert",
};

const GATE_TYPE_TO_REASON: Record<GateApprovalType, IssueBlockedInboxReason> = {
  [GATE_APPROVAL_TYPES.planApproval]: "pending_plan_approval",
  [GATE_APPROVAL_TYPES.codeReview]: "pending_code_review",
  [GATE_APPROVAL_TYPES.wiringReview]: "pending_wiring_review",
};

export function gateTypeToReason(type: GateApprovalType): IssueBlockedInboxReason {
  return GATE_TYPE_TO_REASON[type];
}

// Lower number = higher precedence. When one issue carries multiple pending
// gates (a leaf has both code-review and wiring), the board surfaces the
// highest-precedence one; the next gate appears only after the prior is decided.
const GATE_PRECEDENCE: Record<GateApprovalType, number> = {
  [GATE_APPROVAL_TYPES.planApproval]: 0,
  [GATE_APPROVAL_TYPES.codeReview]: 1,
  [GATE_APPROVAL_TYPES.wiringReview]: 2,
};

export function gatePrecedence(type: string): number {
  return isGateApprovalType(type) ? GATE_PRECEDENCE[type] : Number.POSITIVE_INFINITY;
}

export interface GateApprovalSpec {
  type: GateApprovalType;
  issueId: string;
  // Designated agent resolved by urlKey; null = board fallback.
  designatedAgentId: string | null;
  // B1: single-dimension lens for isolated review contexts.
  // Absent on wiring-review and light code-review gates (generalist).
  lensKey?: ReviewGateLens;
}

// B1: distinct-lens code-review gates. Each lens runs in an isolated agent
// context so blind spots are uncorrelated. Gate passes when ALL lenses approve.
export const REVIEW_GATE_LENSES = ["scalability", "test_coverage", "security_authz"] as const;
export type ReviewGateLens = (typeof REVIEW_GATE_LENSES)[number];

export interface GateActivationInput {
  planRootIssueId: string;
  leafIssueIds: string[];
  // urlKey → agentId for the three gate roles (null/absent = board fallback).
  designatedByUrlKey: Record<string, string | null>;
  // Gate profile right-sizes the set. Defaults to dev_team (full) for callers
  // that predate triage.
  gateProfile?: PlanGateProfile | null;
}

// Builds the gate-approval set for a plan activation, sized to the profile:
//   solo     → no gates.
//   light    → one code-review gate per leaf (single highest-value reviewer:
//              correctness + security). NOTE: the triage plan envisaged picking
//              code-review vs wiring-review by change nature, but per-leaf diffs
//              are not available at activation, so light deliberately uses
//              code-review only; diff-based reviewer selection is deferred.
//   dev_team → plan-approval on the root + code-review + wiring-review per leaf
//              (the original full set).
//   none     → no gates.
export function buildGateApprovalsForActivation(
  input: GateActivationInput,
): GateApprovalSpec[] {
  const resolve = (type: GateApprovalType): string | null =>
    input.designatedByUrlKey[GATE_DESIGNATED_URL_KEY[type]] ?? null;

  const profile: PlanGateProfile = input.gateProfile ?? "dev_team";
  if (profile === "none" || profile === "solo") return [];

  const specs: GateApprovalSpec[] = [];

  if (profile === "dev_team") {
    specs.push({
      type: GATE_APPROVAL_TYPES.planApproval,
      issueId: input.planRootIssueId,
      designatedAgentId: resolve(GATE_APPROVAL_TYPES.planApproval),
    });
  }

  for (const leafId of input.leafIssueIds) {
    if (profile === "dev_team") {
      // B1: one isolated code-review gate per lens (uncorrelated blind spots).
      for (const lensKey of REVIEW_GATE_LENSES) {
        specs.push({
          type: GATE_APPROVAL_TYPES.codeReview,
          issueId: leafId,
          designatedAgentId: resolve(GATE_APPROVAL_TYPES.codeReview),
          lensKey,
        });
      }
      specs.push({
        type: GATE_APPROVAL_TYPES.wiringReview,
        issueId: leafId,
        designatedAgentId: resolve(GATE_APPROVAL_TYPES.wiringReview),
      });
    } else {
      // light: single generalist code-review (no lens).
      specs.push({
        type: GATE_APPROVAL_TYPES.codeReview,
        issueId: leafId,
        designatedAgentId: resolve(GATE_APPROVAL_TYPES.codeReview),
      });
    }
  }

  return specs;
}

// Unique designated agent ids for gates that are actionable at plan activation.
// Only the plan-approval gate (the architect) can be acted on the moment a plan
// activates — the plan exists and is reviewable. Code-review/wiring gates are not
// actionable until their leaf is implemented, so their agents are not woken here
// (that is the in_review-triggered wake, tracked as W5b). Returns [] for profiles
// with no plan-approval gate (solo/light/none).
export function planApprovalAgentIds(specs: GateApprovalSpec[]): string[] {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (spec.type === GATE_APPROVAL_TYPES.planApproval && spec.designatedAgentId) {
      ids.add(spec.designatedAgentId);
    }
  }
  return Array.from(ids);
}

const REVIEW_GATE_TYPES = new Set<string>([
  GATE_APPROVAL_TYPES.codeReview,
  GATE_APPROVAL_TYPES.wiringReview,
]);

// Gate-review wake identity. These are emitted by the push-wakes that start a
// gate review off-cadence — W5a (plan activation, routes/plans.ts) and W5b (leaf
// reaches in_review, routes/issues.ts) — and consumed by the heartbeat queued-run
// staleness evaluator to exempt gate reviewers from the `issue_assignee_changed`
// cancellation. A gate reviewer (architect / code-reviewer / wiring-expert) is a
// non-assignee acting on someone else's issue, so a change of the issue's assignee
// (e.g. the CTO delegating the plan-root to an implementor) must not cancel its
// queued review. Centralized so the emitter and the checker can never drift.
export const PLAN_APPROVAL_WAKE_REASON = "gate_plan_approval_requested";
export const REVIEW_GATE_WAKE_REASON = "gate_review_requested";
export const GATE_REVIEW_WAKE_REASONS: ReadonlySet<string> = new Set([
  PLAN_APPROVAL_WAKE_REASON,
  REVIEW_GATE_WAKE_REASON,
]);
// The `contextSnapshot.source` tag each gate wake sets — the second factor that,
// together with the reason, authorizes the assignee-change exemption (mirrors how
// allowsIssueInteractionWake requires both a reason and a derived commentId).
export const GATE_WAKE_SOURCES: ReadonlySet<string> = new Set([
  "plan.activated.gate", // W5a — routes/plans.ts plan-approval wake
  "issue.in_review.gate", // W5b — routes/issues.ts review wake
]);

// Pure predicate for the heartbeat staleness evaluator: is this queued run a
// gate-review wake that should survive an assignee change? Requires BOTH the gate
// reason and the matching gate source so a stray wakeReason alone cannot bypass
// owner-change cancellation.
export function isGateReviewWake(
  context: { wakeReason?: unknown; source?: unknown } | null | undefined,
): boolean {
  if (!context) return false;
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason : "";
  const source = typeof context.source === "string" ? context.source : "";
  return GATE_REVIEW_WAKE_REASONS.has(wakeReason) && GATE_WAKE_SOURCES.has(source);
}

// W5b — the review-gate agents to push-wake when a leaf reaches in_review.
// Returns one entry per pending review-gate approval (not deduplicated by agent):
// B1 lens gates give the same agent multiple targeted wakes, each carrying the
// approvalId + lensKey so the agent knows exactly which gate to decide.
// Plan-approval gates are excluded (woken at activation, W5a); decided gates and
// board-routed gates (null designatedAgentId) yield nothing.
export interface ReviewGateWakeTarget {
  agentId: string;
  approvalId: string;
  lensKey: ReviewGateLens | null;
}

export function reviewGateAgentIdsFromApprovals(
  approvals: ReadonlyArray<{
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown> | null;
  }>,
): ReviewGateWakeTarget[] {
  const targets: ReviewGateWakeTarget[] = [];
  const seen = new Set<string>();
  for (const approval of approvals) {
    if (!REVIEW_GATE_TYPES.has(approval.type)) continue;
    if (approval.status !== "pending") continue;
    const designated = approval.payload?.designatedAgentId;
    if (typeof designated !== "string" || designated.length === 0) continue;
    if (seen.has(approval.id)) continue;
    seen.add(approval.id);
    const rawLens = approval.payload?.lensKey;
    const lensKey =
      typeof rawLens === "string" && (REVIEW_GATE_LENSES as ReadonlyArray<string>).includes(rawLens)
        ? (rawLens as ReviewGateLens)
        : null;
    targets.push({ agentId: designated, approvalId: approval.id, lensKey });
  }
  return targets;
}

// Fix 3 (B1 gap-fix) + triage — the pure `done`-gate decision, right-sized by
// profile. Returns the unmet preconditions for closing a gated issue. Empty
// array = ready to close. The caller decides what to do with the reasons (throw
// for an agent actor, log an override for a user/board actor).
//   none / solo → never gated (solo is the fix for the HIV-13 dead-end where a
//                 shared-branch task could never produce the PR the gate wanted).
//   light       → its single review gate must be approved; no PR required.
//   dev_team    → an open PR AND every review gate approved (the original).
// Non-`done` transitions are never gated.
export function evaluateDevTeamDoneReadiness(input: {
  gateProfile: string | null | undefined;
  targetStatus: string;
  currentStatus: string;
  prUrl: string | null;
  // Statuses of THIS issue's code-review + wiring-review gate approvals.
  reviewGateStatuses: string[];
}): { reasons: string[] } {
  if (input.targetStatus !== "done" || input.currentStatus === "done") return { reasons: [] };
  const profile = input.gateProfile;
  if (profile !== "dev_team" && profile !== "light") return { reasons: [] };

  const reasons: string[] = [];
  if (profile === "dev_team" && !input.prUrl) reasons.push("missing_pr");
  if (input.reviewGateStatuses.some((status) => status !== "approved")) reasons.push("gates_pending");
  return { reasons };
}
