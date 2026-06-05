// Deterministic Contract-Net award logic for the `solicit_bid` interaction
// (TON-2120 / TON-2056). Ported from the read-only PoC sidecar
// `cnp_allocator.py` so the live orchestration-core award reproduces the
// dry-run baseline exactly: same (candidates, loads, bids) -> same winner.
//
// This module is intentionally pure (no IO, no clock, no randomness) so the
// award is unit-testable and the manager's close-the-window step is a plain
// function call over whatever bids candidates submitted.

// Bid weight presets. Specialty fit dominates; load acts as a balancer;
// priority fit nudges senior roles toward critical work. `fit_first` maximizes
// matching; `balanced` raises the (super-linear) load penalty to spread work
// more evenly at a small matching cost — the manager picks the trade-off.
export const SOLICIT_BID_WEIGHT_PRESETS = {
  fit_first: { fit: 0.55, conf: 0.15, load: 0.2, priority: 0.1, loadExp: 1.0 },
  balanced: { fit: 0.45, conf: 0.1, load: 0.45, priority: 0.1, loadExp: 1.6 },
} as const;

export type SolicitBidWeightsPreset = keyof typeof SOLICIT_BID_WEIGHT_PRESETS;
export const SOLICIT_BID_WEIGHTS_PRESETS = Object.keys(
  SOLICIT_BID_WEIGHT_PRESETS,
) as [SolicitBidWeightsPreset, ...SolicitBidWeightsPreset[]];
export const DEFAULT_SOLICIT_BID_WEIGHTS_PRESET: SolicitBidWeightsPreset = "fit_first";

// Eligibility floor: a candidate must clear this specialty fit to win the award
// (the Announcement filter — "자격 있는 후보"). Mirrors FIT_GATE in cnp_allocator.py.
export const DEFAULT_SOLICIT_BID_FIT_GATE = 0.12;

const PRIORITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
// Roles considered "senior" for priority-fit (better suited to critical work).
const SENIOR_ROLES = new Set(["cto", "ceo", "qa"]);
// Effort heuristic: base hours by priority, discounted by fit (a strong fit
// finishes faster). Informational + a small confidence input.
const BASE_EFFORT: Record<string, number> = { critical: 8, high: 6, medium: 4, low: 2 };

export interface SolicitBidCandidate {
  agentId: string;
  agentName: string;
  role: string;
  /** Manager-computed specialty fit in [0,1] — the eligibility input. */
  specialtyFit: number;
  /** Current open-issue load for the candidate. */
  load: number;
}

/** A bid a candidate agent actually submitted during the bid window. */
export interface SubmittedBidInput {
  agentId: string;
  confidence: number;
  estEffortHours: number;
  specialtyFit: number;
  rationale: string;
}

/** A bid resolved at award time — either submitted or simulated-as-fallback. */
export interface ResolvedBid {
  agentId: string;
  agentName: string;
  role: string;
  specialtyFit: number;
  load: number;
  confidence: number;
  estEffortHours: number;
  priorityFit: number;
  score: number;
  rationale: string;
  /** true when the manager simulated this bid (candidate did not respond). */
  simulated: boolean;
}

export interface SolicitBidAwardResult {
  winnerAgentId: string | null;
  awardRationale: string | null;
  /** All resolved bids that cleared the fit gate, best-first. */
  bids: ResolvedBid[];
  /** Candidates that bid below the fit gate and were dropped. */
  ineligibleAgentIds: string[];
}

function normalizePriority(priority: string | null | undefined): string {
  return (priority ?? "medium").toLowerCase();
}

function priorityFitFor(role: string, priority: string): number {
  const rank = PRIORITY_RANK[priority] ?? 1;
  // Senior roles fit high-priority work; everyone fits routine work.
  if (rank >= 2) return SENIOR_ROLES.has(role.toLowerCase()) ? 1.0 : 0.4;
  return 0.7;
}

function maxLoadOf(candidates: SolicitBidCandidate[]): number {
  return Math.max(1, ...candidates.map((c) => c.load));
}

function scoreBid(args: {
  preset: SolicitBidWeightsPreset;
  fit: number;
  load: number;
  maxLoad: number;
  confidence: number;
  priorityFit: number;
}): number {
  const w = SOLICIT_BID_WEIGHT_PRESETS[args.preset];
  const loadNorm = args.maxLoad > 0 ? args.load / args.maxLoad : 0;
  const loadPenalty = Math.pow(loadNorm, w.loadExp);
  return (
    w.fit * args.fit + w.conf * args.confidence - w.load * loadPenalty + w.priority * args.priorityFit
  );
}

/**
 * Simulate a candidate's bid deterministically from manager-known metadata —
 * used as the quiet-fleet fallback for candidates that did not respond before
 * the window closed, so a silent fleet never deadlocks. Mirrors `bid()` in
 * cnp_allocator.py exactly.
 */
export function simulateSolicitBid(
  candidate: SolicitBidCandidate,
  priority: string,
  maxLoad: number,
  preset: SolicitBidWeightsPreset,
): ResolvedBid {
  const pri = normalizePriority(priority);
  const fit = candidate.specialtyFit;
  const loadNorm = maxLoad > 0 ? candidate.load / maxLoad : 0;
  const priorityFit = priorityFitFor(candidate.role, pri);
  // Confidence blends fit with availability — a perfect-fit agent who is already
  // buried is less confident they can take it on well.
  const confidence = Math.max(0, fit * (1 - 0.5 * loadNorm));
  const estEffortHours = (BASE_EFFORT[pri] ?? 4) * (1 - 0.4 * fit);
  const score = scoreBid({ preset, fit, load: candidate.load, maxLoad, confidence, priorityFit });
  return {
    agentId: candidate.agentId,
    agentName: candidate.agentName,
    role: candidate.role,
    specialtyFit: fit,
    load: candidate.load,
    confidence,
    estEffortHours,
    priorityFit,
    score,
    rationale:
      `${candidate.agentName} (${candidate.role}): fit=${fit.toFixed(2)}, ` +
      `load=${candidate.load}(norm ${loadNorm.toFixed(2)}), conf=${confidence.toFixed(2)}, ` +
      `priFit=${priorityFit.toFixed(2)}, est~${estEffortHours.toFixed(1)}h → score=${score.toFixed(3)} [simulated]`,
    simulated: true,
  };
}

/**
 * Score a bid a candidate actually submitted. The candidate controls
 * confidence / est-effort / specialty-fit / rationale; the manager keeps
 * authority over load and priority-fit (derived from role) so the score cannot
 * be gamed by a self-reported priority. When a submitted bid's confidence and
 * specialty-fit equal what `simulateSolicitBid` would produce, the resulting
 * score is identical — that is the deterministic-baseline equivalence.
 */
export function scoreSubmittedBid(
  candidate: SolicitBidCandidate,
  submitted: SubmittedBidInput,
  priority: string,
  maxLoad: number,
  preset: SolicitBidWeightsPreset,
): ResolvedBid {
  const pri = normalizePriority(priority);
  const fit = submitted.specialtyFit;
  const priorityFit = priorityFitFor(candidate.role, pri);
  const score = scoreBid({
    preset,
    fit,
    load: candidate.load,
    maxLoad,
    confidence: submitted.confidence,
    priorityFit,
  });
  return {
    agentId: candidate.agentId,
    agentName: candidate.agentName,
    role: candidate.role,
    specialtyFit: fit,
    load: candidate.load,
    confidence: submitted.confidence,
    estEffortHours: submitted.estEffortHours,
    priorityFit,
    score,
    rationale: submitted.rationale,
    simulated: false,
  };
}

/**
 * Run the deterministic Contract-Net award over the candidate pool, using each
 * candidate's submitted bid when present and falling back to a simulated bid
 * otherwise. Returns the highest-score winner among bids that clear the fit
 * gate. Deterministic tiebreak: (−score, load, agentId).
 */
export function awardSolicitBid(args: {
  priority: string;
  preset?: SolicitBidWeightsPreset;
  fitGate?: number;
  candidates: SolicitBidCandidate[];
  submittedBids: SubmittedBidInput[];
}): SolicitBidAwardResult {
  const preset = args.preset ?? DEFAULT_SOLICIT_BID_WEIGHTS_PRESET;
  const fitGate = args.fitGate ?? DEFAULT_SOLICIT_BID_FIT_GATE;
  const maxLoad = maxLoadOf(args.candidates);
  const submittedByAgent = new Map(args.submittedBids.map((b) => [b.agentId, b]));

  const eligible: ResolvedBid[] = [];
  const ineligibleAgentIds: string[] = [];
  for (const candidate of args.candidates) {
    const submitted = submittedByAgent.get(candidate.agentId);
    const resolved = submitted
      ? scoreSubmittedBid(candidate, submitted, args.priority, maxLoad, preset)
      : simulateSolicitBid(candidate, args.priority, maxLoad, preset);
    // The fit gate is the manager's eligibility floor (the Announcement filter), so it must be
    // evaluated against the manager-assigned `candidate.specialtyFit` — never the candidate's
    // self-reported `resolved.specialtyFit`, which an agent could inflate to bypass the gate.
    if (candidate.specialtyFit < fitGate) {
      ineligibleAgentIds.push(candidate.agentId);
      continue;
    }
    eligible.push(resolved);
  }

  eligible.sort((a, b) => b.score - a.score || a.load - b.load || a.agentId.localeCompare(b.agentId));

  const winner = eligible[0] ?? null;
  return {
    winnerAgentId: winner?.agentId ?? null,
    awardRationale: winner
      ? `Awarded to ${winner.agentName} (${winner.role}) — ${winner.rationale}`
      : null,
    bids: eligible,
    ineligibleAgentIds,
  };
}
