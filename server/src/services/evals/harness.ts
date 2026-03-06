import type {
  EvalAction,
  EvalEventPayload,
  EvalInput,
  EvalKind,
  EvalLabel,
  EvalPolicyConfig,
  EvalPreset,
  EvalResult,
  EvalSamplingConfig,
  EvalThreshold,
} from "./types.js";
import { createLlmJudge } from "./judges/llm-judge.js";

const ALL_EVAL_KINDS: EvalKind[] = [
  "toxicity",
  "relevance",
  "quality",
  "hallucination",
  "factuality",
];

const DEFAULT_THRESHOLDS: Record<EvalKind, EvalThreshold> = {
  toxicity: { warnAbove: 0.15, failAbove: 0.4 },
  relevance: { warnBelow: 0.5, failBelow: 0.3 },
  quality: { warnBelow: 0.4, failBelow: 0.2 },
  hallucination: { warnAbove: 0.3, failAbove: 0.6 },
  factuality: { warnBelow: 0.4, failBelow: 0.2 },
};

// ── Presets ──────────────────────────────────────────────────────────
//
//  off      → disabled (rate=0)
//  light    → 10% sample, toxicity only
//  moderate → 25% sample, toxicity + hallucination + relevance
//  strict   → 50% sample, all 5 dimensions
//  full     → 100%, all 5 dimensions
//  custom   → user supplies everything manually

interface PresetDefaults {
  rate: number;
  kinds: EvalKind[];
}

const PRESET_DEFAULTS: Record<EvalPreset, PresetDefaults> = {
  off:      { rate: 0,    kinds: [] },
  light:    { rate: 0.1,  kinds: ["toxicity"] },
  moderate: { rate: 0.25, kinds: ["toxicity", "hallucination", "relevance"] },
  strict:   { rate: 0.5,  kinds: ALL_EVAL_KINDS },
  full:     { rate: 1.0,  kinds: ALL_EVAL_KINDS },
  custom:   { rate: 1.0,  kinds: ALL_EVAL_KINDS },
};

// ── Sampling logic ──────────────────────────────────────────────────

/**
 * Decides whether this run should be evaluated at all, based on the
 * top-level sampling rate. Uses `runSeq` (a monotonic counter per agent)
 * for deterministic `every`-N gating, and `Math.random()` for rate-based.
 */
export function shouldRunEval(
  config: EvalPolicyConfig,
  runSeq?: number,
): boolean {
  if (!config.enabled || config.preset === "off") return false;

  const sampling = config.sampling;

  // `every` is checked first when explicitly set (deterministic gating)
  if (sampling.every != null && sampling.every > 0 && sampling.rate == null) {
    if (runSeq != null) return runSeq % sampling.every === 0;
    // No seq available — fall through to rate-based
  }

  const presetRate = PRESET_DEFAULTS[config.preset]?.rate ?? 1;
  const effectiveRate = sampling.rate ?? presetRate;

  if (effectiveRate <= 0) return false;
  if (effectiveRate >= 1) return true;

  return Math.random() < effectiveRate;
}

/**
 * Returns the eval dimensions to run for this particular invocation.
 * Respects per-kind sampling overrides on top of the global decision.
 */
export function resolveKindsForRun(
  config: EvalPolicyConfig,
  runSeq?: number,
): EvalKind[] {
  const presetKinds = PRESET_DEFAULTS[config.preset]?.kinds ?? ALL_EVAL_KINDS;

  // If user configured explicit thresholds, those determine which kinds run
  // (for "custom" preset). Otherwise fall back to preset kinds.
  const customKinds = Object.keys(config.thresholds).filter(
    (k): k is EvalKind => (ALL_EVAL_KINDS as string[]).includes(k),
  );
  const baseKinds =
    config.preset === "custom" && customKinds.length > 0
      ? customKinds
      : presetKinds;

  if (!config.sampling.perKind) return baseKinds;

  return baseKinds.filter((kind) => {
    const override = config.sampling.perKind?.[kind];
    if (!override) return true;

    if (override.rate != null) {
      if (override.rate <= 0) return false;
      if (override.rate >= 1) return true;
      return Math.random() < override.rate;
    }

    if (override.every != null && override.every > 0 && runSeq != null) {
      return runSeq % override.every === 0;
    }

    return true;
  });
}

/** Maps a raw score to a pass/warn/fail label using the threshold for the given kind. */
export function applyLabel(kind: EvalKind, score: number, threshold?: EvalThreshold): EvalLabel {
  // Merge user overrides with defaults so partial overrides (e.g. only failAbove)
  // don't silently drop the default warnAbove/warnBelow tier
  const defaults = DEFAULT_THRESHOLDS[kind];
  const t = threshold ? { ...defaults, ...threshold } : defaults;
  if (!t) return "pass";

  // "higher is worse" dimensions (toxicity, hallucination)
  if (t.failAbove != null && score >= t.failAbove) return "fail";
  if (t.warnAbove != null && score >= t.warnAbove) return "warn";

  // "lower is worse" dimensions (relevance, quality, factuality)
  if (t.failBelow != null && score <= t.failBelow) return "fail";
  if (t.warnBelow != null && score <= t.warnBelow) return "warn";

  return "pass";
}

/** Computes the worst label across results and collects triggered actions based on policy config. */
export function determineActions(
  results: EvalResult[],
  config: EvalPolicyConfig,
): { triggered: EvalAction[]; worstLabel: EvalLabel } {
  let worstLabel: EvalLabel = "pass";
  for (const r of results) {
    if (r.label === "fail") {
      worstLabel = "fail";
      break;
    }
    if (r.label === "warn") worstLabel = "warn";
  }

  const actions = new Set<EvalAction>();
  // onWarn fires at warn severity or worse (fail implies warn)
  if ((worstLabel === "warn" || worstLabel === "fail") && config.actions.onWarn) {
    for (const a of config.actions.onWarn) actions.add(a);
  }
  if (worstLabel === "fail" && config.actions.onFail) {
    for (const a of config.actions.onFail) actions.add(a);
  }

  return { triggered: [...actions], worstLabel };
}

/** Constructs the JSON payload stored in heartbeat_run_events for an eval run. */
export function buildEvalEventPayload(
  results: EvalResult[],
  judge: { provider: string; model: string },
  latencyMs: number,
): EvalEventPayload {
  return {
    schemaVersion: 1,
    target: { type: "agent.response", step: "final" },
    results,
    judge: { provider: judge.provider, model: judge.model, latencyMs },
  };
}

/** Builds a human-readable one-line summary of eval results for the run timeline. */
export function buildEvalSummaryMessage(results: EvalResult[]): string {
  return (
    "Evals: " +
    results.map((r) => `${r.kind}=${r.label}(${r.score.toFixed(2)})`).join(", ")
  );
}

export interface RunEvalOptions {
  input: EvalInput;
  config: EvalPolicyConfig;
  /** Monotonic run counter for the agent — used for deterministic every-N sampling. */
  runSeq?: number;
}

export interface RunEvalResult {
  payload: EvalEventPayload;
  results: EvalResult[];
  actions: EvalAction[];
  worstLabel: EvalLabel;
  summaryMessage: string;
}

/** Runs the full eval pipeline: resolve kinds → judge → apply labels → determine actions. */
export async function runEvals(opts: RunEvalOptions): Promise<RunEvalResult> {
  const { input, config, runSeq } = opts;

  const kinds = resolveKindsForRun(config, runSeq);
  if (kinds.length === 0) {
    return {
      payload: buildEvalEventPayload([], { provider: "none", model: "none" }, 0),
      results: [],
      actions: [],
      worstLabel: "pass" as EvalLabel,
      summaryMessage: "Evals: (no dimensions selected)",
    };
  }

  const judge = createLlmJudge({
    provider: config.judge?.provider,
    model: config.judge?.model,
    apiKey: config.judge?.apiKey,
    strategy: config.strategy,
  });

  const start = Date.now();
  const rawResults = await judge.evaluate(input, kinds);
  const latencyMs = Date.now() - start;

  // Apply labels based on thresholds
  const results = rawResults.map((r) => ({
    ...r,
    label: applyLabel(r.kind, r.score, config.thresholds[r.kind]),
  }));

  const { triggered, worstLabel } = determineActions(results, config);
  const payload = buildEvalEventPayload(results, judge, latencyMs);
  const summaryMessage = buildEvalSummaryMessage(results);

  return { payload, results, actions: triggered, worstLabel, summaryMessage };
}
