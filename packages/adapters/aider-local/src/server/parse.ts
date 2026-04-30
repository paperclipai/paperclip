/**
 * Parse Aider's human-readable stdout for usage and cost.
 *
 * Aider prints a trailer like:
 *   `Tokens: 1,234 sent, 567 received. Cost: $0.0123 message, $0.0456 session.`
 *
 * For local Ollama models the cost is typically $0.00 (no upstream provider),
 * but the line is still emitted so we can pick up token counts.
 */

const TOKENS_LINE_RE = /Tokens:\s*([\d,]+)\s*sent,\s*([\d,]+)\s*received/i;
const COST_LINE_RE = /Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session/i;
const ERROR_OLLAMA_UNREACHABLE_RE = /(?:could not connect to ollama|connection refused|ECONNREFUSED|getaddrinfo enotfound).*?(?:11434|ollama)/i;
const ERROR_MODEL_NOT_PULLED_RE = /(?:model\s+['"`]?[\w./:-]+['"`]?\s+not found|404 .*?\/api\/generate)/i;

export interface AiderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cost reported for the most recent message in USD. */
  messageCostUsd: number | null;
  /** Cumulative cost reported for the session in USD. */
  sessionCostUsd: number | null;
}

export function parseAiderUsage(stdout: string): AiderUsage {
  const tokens = stdout.match(TOKENS_LINE_RE);
  const cost = stdout.match(COST_LINE_RE);
  const toInt = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number.parseInt(raw.replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const toFloat = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    inputTokens: toInt(tokens?.[1]),
    outputTokens: toInt(tokens?.[2]),
    messageCostUsd: toFloat(cost?.[1]),
    sessionCostUsd: toFloat(cost?.[2]),
  };
}

export interface AiderFailureSignal {
  /**
   * Stable error code surfaced via AdapterExecutionResult.errorCode so the UI
   * can react. `null` means the run failed without a recognized cause.
   */
  errorCode: string | null;
  errorMessage: string | null;
  hint?: string;
}

export function classifyAiderFailure(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): AiderFailureSignal | null {
  if ((input.exitCode ?? 0) === 0) return null;
  const combined = [input.stdout, input.stderr].join("\n");
  if (ERROR_OLLAMA_UNREACHABLE_RE.test(combined)) {
    return {
      errorCode: "ollama_unreachable",
      errorMessage: "Aider could not reach the Ollama server.",
      hint: "Start Ollama (`ollama serve`) and verify it is bound to the configured ollamaBaseUrl.",
    };
  }
  if (ERROR_MODEL_NOT_PULLED_RE.test(combined)) {
    return {
      errorCode: "ollama_model_not_pulled",
      errorMessage: "The configured Ollama model is not available locally.",
      hint: "Run `ollama pull <model>` to download it before retrying.",
    };
  }
  return {
    errorCode: null,
    errorMessage: `Aider exited with code ${input.exitCode}`,
  };
}

const SUMMARY_TRAILER_RE = /\n+(?:Tokens:|Cost:|^>)/m;

/**
 * Best-effort extraction of Aider's narrative response (the part shown to the
 * user) by stripping the usage trailer and any prompt echo. Used purely for
 * the AdapterExecutionResult `summary` so the UI has something readable.
 */
export function extractAiderSummary(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  const cut = trimmed.split(SUMMARY_TRAILER_RE)[0] ?? trimmed;
  return cut.trim().slice(-4000);
}
