export type EvalKind =
  | "toxicity"
  | "relevance"
  | "quality"
  | "hallucination"
  | "factuality";

export type EvalLabel = "pass" | "warn" | "fail";

export interface EvalResult {
  kind: EvalKind;
  score: number; // normalized 0..1
  label: EvalLabel;
  rationale?: string;
  meta?: Record<string, unknown>;
}

export interface EvalInput {
  runId: string;
  agentId: string;
  companyId: string;
  prompt: string;
  response: string;
  context?: {
    messages?: Array<{ role: string; content: string }>;
    toolTraces?: unknown;
  };
}

export interface EvalThreshold {
  warnAbove?: number;
  failAbove?: number;
  warnBelow?: number;
  failBelow?: number;
}

export type EvalAction = "require_approval" | "open_issue" | "tag_run";

export type EvalPreset = "off" | "light" | "moderate" | "strict" | "full" | "custom";

export interface EvalSamplingConfig {
  /** 0.0–1.0 probability of running evals on any given run. Default depends on preset. */
  rate?: number;
  /** Only eval every Nth run. Mutually exclusive with rate (rate takes priority). */
  every?: number;
  /** Per-kind overrides: run specific eval dimensions at different rates. */
  perKind?: Partial<Record<EvalKind, { rate?: number; every?: number }>>;
}

/**
 * How the judge evaluates dimensions:
 * - "batched": one LLM call scores all requested dimensions (cheapest, least accurate)
 * - "isolated": one LLM call per dimension with a dedicated rubric (more accurate, N calls)
 * - "specialized": per-kind strategy selection — uses best-fit approach per dimension
 */
export type EvalStrategy = "batched" | "isolated" | "specialized";

export interface EvalPolicyConfig {
  enabled: boolean;
  /** Preset controls defaults for sampling, thresholds, and which kinds run. */
  preset: EvalPreset;
  on: Array<"final_response">;
  sampling: EvalSamplingConfig;
  /** How dimensions are scored. Default: "batched". */
  strategy: EvalStrategy;
  thresholds: Partial<Record<EvalKind, EvalThreshold>>;
  actions: {
    onFail?: EvalAction[];
    onWarn?: EvalAction[];
  };
  judge?: {
    provider?: string;
    model?: string;
    apiKey?: string;
  };
}

export interface EvalEventPayload {
  schemaVersion: 1;
  target: { type: "agent.response"; step: string };
  results: EvalResult[];
  judge: { provider: string; model: string; latencyMs: number };
}

export interface EvalJudge {
  evaluate(input: EvalInput, kinds: EvalKind[]): Promise<EvalResult[]>;
  readonly provider: string;
  readonly model: string;
}
