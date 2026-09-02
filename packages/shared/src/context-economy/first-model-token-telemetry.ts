// First-model-request token telemetry.
//
// Captures the first model request's input/cached-input token counts when the
// provider/runtime reports usage. We NEVER invent token counts from character
// counts; if the exact field is unavailable we keep null + an explicit reason.
// The promptChars decomposition is kept alongside so the char-based budget
// fallback remains explainable without fabricating token numbers.

export type MeasurementSource = "provider" | "runtime" | "unsupported";

export interface PromptCharsDecomposition {
  /** Total chars of the first-turn prompt. */
  total: number;
  /** Paperclip-owned baseline instructions chars. */
  baselineInstructions: number;
  /** Issue/assignment task context chars. */
  taskContext: number;
  /** Tool schema / MCP config chars. */
  toolSchema: number;
  /** Session-history (prior turns / resume) chars. */
  sessionHistory: number;
}

export interface FirstModelTokenTelemetryInput {
  /**
   * Provider/runtime-reported first-request input tokens. Pass `null` (not a
   * number) when the runtime does not expose it.
   */
  firstModelInputTokens?: number | null;
  firstModelCachedInputTokens?: number | null;
  /** Who supplied the numbers. */
  measurementSource?: MeasurementSource;
  /** Required when numbers are absent. */
  reason?: string;
  promptChars: PromptCharsDecomposition;
}

export interface FirstModelTokenTelemetry {
  firstModelInputTokens: number | null;
  firstModelCachedInputTokens: number | null;
  measurementSource: MeasurementSource;
  reason: string | null;
  promptChars: PromptCharsDecomposition;
  /** True when at least one token metric is deterministically measured. */
  measured: boolean;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function captureFirstModelTokenTelemetry(
  input: FirstModelTokenTelemetryInput,
): FirstModelTokenTelemetry {
  const inputTokens = isNonNegativeInt(input.firstModelInputTokens)
    ? input.firstModelInputTokens
    : null;
  const cachedTokens = isNonNegativeInt(input.firstModelCachedInputTokens)
    ? input.firstModelCachedInputTokens
    : null;

  const measured = inputTokens !== null || cachedTokens !== null;
  const measurementSource: MeasurementSource = measured
    ? input.measurementSource ?? "provider"
    : "unsupported";

  return {
    firstModelInputTokens: inputTokens,
    firstModelCachedInputTokens: cachedTokens,
    measurementSource,
    reason: measured
      ? null
      : input.reason ?? "provider/runtime did not report first-request usage",
    promptChars: input.promptChars,
    measured,
  };
}

/** Convenience: build a promptChars decomposition from explicit parts. */
export function decomposePromptChars(parts: {
  baselineInstructions?: number;
  taskContext?: number;
  toolSchema?: number;
  sessionHistory?: number;
}): PromptCharsDecomposition {
  const baselineInstructions = parts.baselineInstructions ?? 0;
  const taskContext = parts.taskContext ?? 0;
  const toolSchema = parts.toolSchema ?? 0;
  const sessionHistory = parts.sessionHistory ?? 0;
  return {
    baselineInstructions,
    taskContext,
    toolSchema,
    sessionHistory,
    total: baselineInstructions + taskContext + toolSchema + sessionHistory,
  };
}
