import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";

/**
 * Diagnostic kind marker stored as a `key_value` row inside comment metadata
 * (see {@link isZeroTokenDiagnosticMetadata}). Mirrors the "Recovery action"
 * marker pattern in recovery/successful-run-handoff.ts, so per-issue dedup can
 * find previously-posted diagnostics without a free-form metadata bag.
 */
export const ZERO_TOKEN_DIAGNOSTIC_KIND = "zero_token_run";

const DIAGNOSTIC_KIND_ROW_LABEL = "Diagnostic kind";

/**
 * Markers that indicate an upstream capacity / overload failure when a run dies
 * with zero tokens. Matched case-insensitively against stderr, stdout, and the
 * stringified result json. "529" is the gateway "service overloaded" status.
 */
const OVERLOAD_MARKER_RE = /(\b529\b|overloaded?|service unavailable|too many requests|rate limited?|capacity|temporarily unavailable)/i;

export interface ZeroTokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A run that finalized "succeeded" but consumed zero input AND zero output
 * tokens is never a real productive run: a real run always emits output tokens,
 * even under heavy prompt caching. Requiring `outputTokens === 0` is what guards
 * against false positives on legitimate low-usage / heavily-cached runs.
 */
export function isZeroTokenTermination(usage: ZeroTokenUsage | null | undefined): boolean {
  if (!usage) return false;
  return toNumber(usage.inputTokens) === 0 && toNumber(usage.outputTokens) === 0;
}

/**
 * Scan adapter output excerpts (stderr, stdout, stringified result json) for a
 * recognizable upstream-overload marker. Returns the matched phrase (e.g. "529",
 * "overloaded") or null if none is found. The first source with a match wins.
 */
export function sniffOverloadCause(sources: Array<string | null | undefined>): string | null {
  for (const source of sources) {
    if (!source) continue;
    const match = OVERLOAD_MARKER_RE.exec(source);
    if (match) {
      return match[0];
    }
  }
  return null;
}

export interface ZeroTokenDiagnosticInput {
  runId: string;
  provider?: string | null;
  model?: string | null;
  usage: ZeroTokenUsage | null;
  /** Overload marker from {@link sniffOverloadCause}, or null if none matched. */
  cause?: string | null;
}

export interface ZeroTokenDiagnosticComment {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
}

function keyValueRow(label: string, value: unknown) {
  const raw = value == null ? "" : typeof value === "string" ? value.trim() : String(value).trim();
  const text = raw.length > 0 ? raw : "unknown";
  return { type: "key_value" as const, label, value: text };
}

/**
 * Build the diagnostic issue comment for a zero-token run. The body names the
 * cause (overload marker if found, else the symptom) plus run/provider/model/
 * usage, and the metadata carries a {@link ZERO_TOKEN_DIAGNOSTIC_KIND} marker
 * row used for per-issue dedup.
 */
export function buildZeroTokenDiagnosticComment(input: ZeroTokenDiagnosticInput): ZeroTokenDiagnosticComment {
  const inputTokens = toNumber(input.usage?.inputTokens);
  const outputTokens = toNumber(input.usage?.outputTokens);
  const cachedInputTokens = toNumber(input.usage?.cachedInputTokens);

  const causeLine = input.cause
    ? `Likely cause: upstream gateway overload (\`${input.cause}\`). The model gateway rejected or dropped the request before any tokens were produced.`
    : "Likely cause: upstream gateway overload or an empty model response. No specific overload marker was captured in this run's output.";

  const body = [
    "**Zero-token run diagnostic**",
    "",
    "This run finalized as `succeeded` but consumed **0 input + 0 output tokens**, so the agent loop never executed. It is therefore invisible to liveness and retry, which key on non-success status.",
    "",
    causeLine,
    "",
    "- No code change or agent action is expected from the assignee. This is a platform/runtime signal, not a task failure.",
    "- If it repeats, productivity-review will escalate after a short streak.",
  ].join("\n");

  const presentation: IssueCommentPresentation = {
    kind: "system_notice",
    tone: "warning",
    title: "Zero-token run diagnostic",
    detailsDefaultOpen: false,
  };

  const metadata: IssueCommentMetadata = {
    version: 1,
    sourceRunId: input.runId,
    sections: [
      {
        title: "Zero-token run",
        rows: [
          keyValueRow(DIAGNOSTIC_KIND_ROW_LABEL, ZERO_TOKEN_DIAGNOSTIC_KIND),
          keyValueRow("Provider", input.provider ?? "unknown"),
          keyValueRow("Model", input.model ?? "unknown"),
          keyValueRow("Input tokens", inputTokens),
          keyValueRow("Output tokens", outputTokens),
          keyValueRow("Cached input tokens", cachedInputTokens),
          keyValueRow("Cause", input.cause ?? "no upstream marker found"),
        ],
      },
    ],
  };

  return { body, presentation, metadata };
}

/**
 * Returns true if a comment's metadata marks it as a zero-token diagnostic (via
 * the {@link ZERO_TOKEN_DIAGNOSTIC_KIND} key_value row). Used for per-issue dedup
 * so a retry burst does not post multiple diagnostics: the caller posts only when
 * the thread's newest comment is not already an unresolved zero-token diagnostic.
 */
export function isZeroTokenDiagnosticMetadata(metadata: IssueCommentMetadata | null | undefined): boolean {
  return (metadata?.sections ?? []).some((section) =>
    section.rows.some(
      (row) =>
        row.type === "key_value" &&
        row.label === DIAGNOSTIC_KIND_ROW_LABEL &&
        row.value === ZERO_TOKEN_DIAGNOSTIC_KIND,
    ),
  );
}
