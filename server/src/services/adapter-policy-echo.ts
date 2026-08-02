/**
 * TSMC-18738 / TSKB0055 K19 (TSBC-1590 class):
 * Detect runs whose only durable output is a paraphrase/echo of adapter
 * wake-handling policy, Paperclip runtime identity, or managed instruction text.
 *
 * When that is the sole "work product", the run must not settle as succeeded.
 */

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strong markers that almost never appear in legitimate task summaries. */
const STRONG_POLICY_MARKERS = [
  "wake-handling discipline",
  "## paperclip wake payload",
  "paperclip wake payload",
  "managed agent instructions",
  "paperclip runtime identity",
  "use this task context as the current assignment",
  "do not copy headings like `## paperclip wake payload`",
  "do not copy headings like ## paperclip wake payload",
  "treat stable adapter instructions as internal operating policy",
  "satisfy the \"acknowledge the latest comment\" rule",
  "final disposition checklist",
  "hermes validation mode",
] as const;

/** Weaker markers that only count when combined or when residual is tiny. */
const WEAK_POLICY_MARKERS = [
  "paperclip api guidance",
  "execution contract:",
  "x-paperclip-run-id",
  "paperclip_api_key",
  "checked out by the harness",
  "fallback fetch needed",
  "do not call `/api/issues/{id}/checkout` again",
  "do not call /api/issues/{id}/checkout again",
  "you are agent ",
  "company id:",
  "run id:",
  "api base:",
  "gate a — dedup",
  "gate b — process",
  "tskb consultation",
] as const;

/** Signals that real task work happened — negate echo classification. */
const REAL_WORK_SIGNAL_RE =
  /\b(?:committed|co-authored-by|pushed|opened pr|pull request|test(?:s)? (?:pass(?:ed)?|fail(?:ed)?|ok)|pnpm (?:test|typecheck|build)|npm (?:test|run)|vitest|pytest|cargo test|implemented|fixed bug|uploaded|attachment(?:s)?|work-?products?\/|sha-?256|diff --git|created file|wrote file|patched|measuredcount|closecontract|ledger row|artifact(?:s)? banked|verification (?:pass(?:ed)?|ok)|run id `?[0-9a-f]{8})\b/i;

export type AdapterPolicyEchoAssessment = {
  isEcho: boolean;
  markerHits: number;
  strongHits: number;
  residualChars: number;
  sourceChars: number;
  matchedMarkers: string[];
  reason: string | null;
};

function normalizeForMatch(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function collectOutputText(input: {
  summary?: unknown;
  result?: unknown;
  message?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  commentBodies?: Array<unknown> | null;
}): string {
  const parts = [
    readText(input.summary),
    readText(input.result),
    readText(input.message),
    readText(input.stdout),
    ...(input.commentBodies ?? []).map(readText),
  ].filter((value): value is string => Boolean(value));
  return parts.join("\n").trim();
}

function stripMarkers(text: string, markers: readonly string[]) {
  let residual = text;
  for (const marker of markers) {
    residual = residual.split(marker).join(" ");
  }
  // Drop common policy scaffolding tokens left after marker removal.
  residual = residual
    .replace(
      /\b(?:you are|agent id|company id|run id|api base|do not|never leave|prefer one|status update|issue status|assignee|authorization|bearer|heartbeat|paperclip|wake payload|managed agent|operating policy|execution contract|validation mode|checkout|comment ids?|latest comment|task context)\b/gi,
      " ",
    )
    .replace(/[`*_#>|[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return residual;
}

/**
 * Pure text classifier for the K19 adapter-echo pattern.
 * Short real summaries rarely trip this; long policy paraphrases do.
 */
export function assessAdapterPolicyEchoText(text: unknown): AdapterPolicyEchoAssessment {
  const raw = readText(text);
  if (!raw) {
    return {
      isEcho: false,
      markerHits: 0,
      strongHits: 0,
      residualChars: 0,
      sourceChars: 0,
      matchedMarkers: [],
      reason: null,
    };
  }

  const normalized = normalizeForMatch(raw);
  if (normalized.length < 120) {
    return {
      isEcho: false,
      markerHits: 0,
      strongHits: 0,
      residualChars: normalized.length,
      sourceChars: normalized.length,
      matchedMarkers: [],
      reason: null,
    };
  }

  if (REAL_WORK_SIGNAL_RE.test(raw)) {
    return {
      isEcho: false,
      markerHits: 0,
      strongHits: 0,
      residualChars: normalized.length,
      sourceChars: normalized.length,
      matchedMarkers: [],
      reason: null,
    };
  }

  const matchedMarkers: string[] = [];
  let strongHits = 0;
  for (const marker of STRONG_POLICY_MARKERS) {
    if (normalized.includes(marker)) {
      matchedMarkers.push(marker);
      strongHits += 1;
    }
  }
  for (const marker of WEAK_POLICY_MARKERS) {
    if (normalized.includes(marker)) {
      matchedMarkers.push(marker);
    }
  }

  const markerHits = matchedMarkers.length;
  const residual = stripMarkers(normalized, [...STRONG_POLICY_MARKERS, ...WEAK_POLICY_MARKERS]);
  const residualChars = residual.length;
  const sourceChars = normalized.length;
  const residualRatio = sourceChars > 0 ? residualChars / sourceChars : 1;

  // Two strong markers, or one strong + mostly residual-stripped body.
  if (strongHits >= 2) {
    return {
      isEcho: true,
      markerHits,
      strongHits,
      residualChars,
      sourceChars,
      matchedMarkers,
      reason: "adapter_policy_echo_strong_markers",
    };
  }

  if (strongHits >= 1 && residualRatio <= 0.25 && sourceChars >= 200) {
    return {
      isEcho: true,
      markerHits,
      strongHits,
      residualChars,
      sourceChars,
      matchedMarkers,
      reason: "adapter_policy_echo_low_residual",
    };
  }

  // Three+ total markers with thin residual (paraphrase of several instruction sections).
  if (markerHits >= 3 && residualRatio <= 0.35 && sourceChars >= 240) {
    return {
      isEcho: true,
      markerHits,
      strongHits,
      residualChars,
      sourceChars,
      matchedMarkers,
      reason: "adapter_policy_echo_marker_density",
    };
  }

  return {
    isEcho: false,
    markerHits,
    strongHits,
    residualChars,
    sourceChars,
    matchedMarkers,
    reason: null,
  };
}

export function isAdapterPolicyEchoText(text: unknown): boolean {
  return assessAdapterPolicyEchoText(text).isEcho;
}

export function assessAdapterPolicyEchoResult(input: {
  resultJson?: Record<string, unknown> | null;
  summary?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  commentBodies?: Array<unknown> | null;
}): AdapterPolicyEchoAssessment {
  const resultJson = input.resultJson ?? null;
  const text = collectOutputText({
    summary: input.summary ?? resultJson?.summary,
    result: resultJson?.result,
    message: resultJson?.message,
    stdout: input.stdout ?? resultJson?.stdout,
    stderr: input.stderr ?? resultJson?.stderr,
    commentBodies: input.commentBodies,
  });
  return assessAdapterPolicyEchoText(text);
}

export function isAdapterPolicyEchoResult(input: {
  resultJson?: Record<string, unknown> | null;
  summary?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  commentBodies?: Array<unknown> | null;
}): boolean {
  return assessAdapterPolicyEchoResult(input).isEcho;
}

export const ADAPTER_POLICY_ECHO_ERROR_CODE = "adapter_policy_echo" as const;
export const ADAPTER_POLICY_ECHO_ERROR_MESSAGE =
  "Run output is only adapter wake-handling/policy instruction text echoed back (TSKB0055 K19 / TSMC-18738); not counted as succeeded.";
