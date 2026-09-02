// Hard context budget + compaction gate.
//
// Reuses the KOMAA-167 run budget tiers (normal=4 / debug=6 / complex=8) and
// adds a hard context ceiling. Compaction/fork is triggered BEFORE another full
// replay would breach the ceiling, so multi-million cached-input replay loops
// are prevented. Compaction preserves objective, decisions, changed files,
// tests, blockers, next action, and runtime IDs in a bounded serialized form.

export type ContextBudgetTier = "normal" | "debug" | "complex";

/**
 * KOMAA-167 run budget: max turns before compaction is forced for the tier.
 * `normal` runs compact at 4 turns, `debug` at 6, `complex` at 8.
 */
export const RUN_BUDGET_TURNS: Record<ContextBudgetTier, number> = {
  normal: 4,
  debug: 6,
  complex: 8,
};

/**
 * Conservative hard ceiling. When exact token usage is available we compare
 * against this; otherwise we fall back to a chars ceiling. Values chosen so a
 * single replay can never silently approach the multi-million cached-input
 * loops seen on long runs (inputTokens 498247 / cachedInput 17.5M / total 18M).
 */
export const HARD_TOKEN_CEILING = 900_000;
export const HARD_CHARS_CEILING = 1_200_000;

export interface ContextCeilingInput {
  tier: ContextBudgetTier;
  /** Exact first-request input tokens if the runtime reports them. */
  firstModelInputTokens?: number | null;
  /** Conservative chars fallback (full prompt size). */
  promptChars?: number;
}

export interface ContextCeilingResult {
  exceeds: boolean;
  reason: string;
  measurementKind: "tokens" | "chars" | "unknown";
}

export function evaluateHardCeiling(input: ContextCeilingInput): ContextCeilingResult {
  if (typeof input.firstModelInputTokens === "number" && input.firstModelInputTokens > 0) {
    const exceeds = input.firstModelInputTokens >= HARD_TOKEN_CEILING;
    return {
      exceeds,
      measurementKind: "tokens",
      reason: exceeds
        ? `first-model input tokens ${input.firstModelInputTokens} >= hard ceiling ${HARD_TOKEN_CEILING}`
        : `first-model input tokens ${input.firstModelInputTokens} within hard ceiling ${HARD_TOKEN_CEILING}`,
    };
  }
  if (typeof input.promptChars === "number" && input.promptChars > 0) {
    const exceeds = input.promptChars >= HARD_CHARS_CEILING;
    return {
      exceeds,
      measurementKind: "chars",
      reason: exceeds
        ? `prompt chars ${input.promptChars} >= chars ceiling ${HARD_CHARS_CEILING}`
        : `prompt chars ${input.promptChars} within chars ceiling ${HARD_CHARS_CEILING}`,
    };
  }
  return {
    exceeds: false,
    measurementKind: "unknown",
    reason: "no token or chars measurement available; ceiling not evaluated",
  };
}

export interface CompactionDecisionInput {
  tier: ContextBudgetTier;
  /** Number of turns/replays already accumulated this run. */
  turns: number;
  /** Optional exact token measurement. */
  firstModelInputTokens?: number | null;
  /** Optional chars fallback. */
  promptChars?: number;
}

export interface CompactionDecision {
  compact: boolean;
  reason: string;
  /** True when the decision came from the hard ceiling rather than the turn budget. */
  byHardCeiling: boolean;
}

export function shouldCompact(input: CompactionDecisionInput): CompactionDecision {
  const budget = RUN_BUDGET_TURNS[input.tier] ?? RUN_BUDGET_TURNS.normal;
  if (input.turns >= budget) {
    return {
      compact: true,
      reason: `turn budget reached: ${input.turns} >= ${budget} for tier ${input.tier}`,
      byHardCeiling: false,
    };
  }
  const ceiling = evaluateHardCeiling({
    tier: input.tier,
    firstModelInputTokens: input.firstModelInputTokens,
    promptChars: input.promptChars,
  });
  if (ceiling.exceeds) {
    return {
      compact: true,
      reason: ceiling.reason,
      byHardCeiling: true,
    };
  }
  return {
    compact: false,
    reason: `within budget (${input.turns}/${budget}) and ceiling`,
    byHardCeiling: false,
  };
}

/** State that MUST survive compaction, in bounded form. */
export interface CompactableRunState {
  objective: string;
  decisions: string[];
  changedFiles: string[];
  tests: string[];
  blockers: string[];
  nextAction: string;
  runtimeIds: {
    runId?: string;
    agentId?: string;
    sessionId?: string;
  };
}

/** Max serialized size of preserved compact state (chars). */
export const COMPACT_STATE_MAX_CHARS = 20_000;

/**
 * Serialize the essential run state for a compacted/forked continuation. The
 * output is bounded: long arrays are truncated with an explicit marker so the
 * serialized size never exceeds COMPACT_STATE_MAX_CHARS.
 */
export function preserveCompactState(state: CompactableRunState): string {
  const truncated: CompactableRunState = {
    ...state,
    decisions: truncateList(state.decisions),
    changedFiles: truncateList(state.changedFiles),
    tests: truncateList(state.tests),
    blockers: truncateList(state.blockers),
  };
  let serialized = JSON.stringify(truncated);
  if (serialized.length > COMPACT_STATE_MAX_CHARS) {
    // Hard bound: drop the longest free-text lists first, then truncate.
    const bounded: CompactableRunState = {
      ...truncated,
      decisions: [],
      blockers: [],
      objective: truncated.objective.slice(0, 2000),
    };
    serialized = JSON.stringify(bounded);
    if (serialized.length > COMPACT_STATE_MAX_CHARS) {
      serialized = serialized.slice(0, COMPACT_STATE_MAX_CHARS);
    }
  }
  return serialized;
}

function truncateList(items: string[], max = 200): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `...(${items.length - max} more)`];
}

/** Detect an unbounded replay risk from a synthetic/measured large history. */
export function detectLargeHistory(input: {
  sessionHistoryChars?: number;
  replayCount?: number;
  maxReplay?: number;
}): boolean {
  const replayCount = input.replayCount ?? 0;
  const maxReplay = input.maxReplay ?? RUN_BUDGET_TURNS.normal;
  if (replayCount >= maxReplay) return true;
  if (
    typeof input.sessionHistoryChars === "number" &&
    input.sessionHistoryChars >= HARD_CHARS_CEILING
  ) {
    return true;
  }
  return false;
}
