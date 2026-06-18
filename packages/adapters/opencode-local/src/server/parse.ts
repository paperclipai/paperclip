import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// Quota / rate-limit detection.
//
// OpenCode aggregates provider errors into a JSONL `error` event whose
// payload (after errorText() flattening) is a free-form string from the
// underlying provider. The providers we currently route through surface
// quota / usage-limit failures with one of the patterns below. The regex
// is intentionally broad (any "usage limit" / "rate limit" / "429" /
// "quota" / "too many requests" phrasing) so new providers that use a
// near-synonym get classified without an adapter code change.
//
// The minimax 2056 "Token Plan usage limit reached" family lands here —
// `errorText()` flattens the provider error message and the regex picks
// it up via "usage limit reached".
export const OPENCODE_QUOTA_RATE_LIMIT_RE =
  /(?:usage\s+limit\s+reached|usage\s+limit\s+exceeded|usage\s+cap\s+reached|hit\s+your\s+usage\s+limit|hit\s+the\s+usage\s+limit|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|quota\s+(?:exceeded|exhausted)|resource_exhausted|insufficient[_\s-]+(?:quota|credits|balance))/i;

// Free-form provider error code markers that identify a quota / rate-limit
// class failure independently of the message text. Some providers (and
// OpenCode's own gateway) emit these in `error.code` or
// `error.data.code` rather than in the human-readable message.
const OPENCODE_QUOTA_RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "too_many_requests",
  "quota_exceeded",
  "quota_exhausted",
  "usage_limit_reached",
  "insufficient_quota",
  "resource_exhausted",
]);

function isProviderQuotaCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return OPENCODE_QUOTA_RATE_LIMIT_CODES.has(value.trim().toLowerCase());
}

function collectErrorCodesForQuotaCheck(errorPayload: unknown): unknown[] {
  const codes: unknown[] = [];
  const rec = parseObject(errorPayload);
  if (!rec) return codes;
  codes.push(rec.code);
  codes.push(rec.type);
  const data = parseObject(rec.data);
  codes.push(data.code);
  codes.push(data.type);
  // Walk a few common nested shapes (e.g. provider SDKs nest the code
  // under `error.error.code`).
  const nested = parseObject(rec.error);
  codes.push(nested.code);
  codes.push(nested.type);
  return codes;
}

export function isOpenCodeQuotaRateLimitError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = [input.errorMessage ?? "", input.stdout ?? "", input.stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (haystack && OPENCODE_QUOTA_RATE_LIMIT_RE.test(haystack)) return true;

  // Code-based check: walk the most recent `error` event payload from
  // stdout. We avoid a full second JSONL pass by scanning once and
  // remembering the last error event's payload.
  const stdout = input.stdout ?? "";
  let lastErrorPayload: unknown = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event.type, "") === "error") {
      lastErrorPayload = event.error ?? event.message;
    }
  }
  if (lastErrorPayload == null) return false;
  for (const candidate of collectErrorCodesForQuotaCheck(lastErrorPayload)) {
    if (isProviderQuotaCode(candidate)) return true;
  }
  return false;
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;
  let toolCallCount = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      toolCallCount += 1;
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
    toolCallCount,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

// Pure classification for the FUL-191 silent-failure envelope. Kept here so
// the mapping table can be unit-tested without spinning up the full execute()
// context. Precedence: quota_rate_limit > adapter_failed > output_silence.
export type OpenCodeSilentFailureReason = "adapter_failed" | "output_silence" | "quota_rate_limit";

export function classifyOpenCodeSilentFailure(input: {
  timedOut: boolean;
  exitCode: number | null;
  errorMessage: string | null;
  summary: string | null | undefined;
  toolCallCount: number;
  stdout: string;
  stderr: string;
}): { silentFailure: boolean; silentFailureReason: OpenCodeSilentFailureReason | null } {
  if (input.timedOut) {
    return { silentFailure: true, silentFailureReason: "adapter_failed" };
  }
  const parsedError = typeof input.errorMessage === "string" ? input.errorMessage.trim() : "";
  const rawExitCode = input.exitCode;
  const failed = (rawExitCode ?? 0) !== 0 || parsedError.length > 0;
  const isQuota = isOpenCodeQuotaRateLimitError({
    stdout: input.stdout,
    stderr: input.stderr,
    errorMessage: parsedError || null,
  });
  if (failed) {
    return {
      silentFailure: true,
      silentFailureReason: isQuota ? "quota_rate_limit" : "adapter_failed",
    };
  }
  const outputIsEmpty =
    (input.summary ?? "").trim().length === 0 &&
    input.toolCallCount === 0;
  if (!parsedError && outputIsEmpty) {
    return { silentFailure: true, silentFailureReason: "output_silence" };
  }
  return { silentFailure: false, silentFailureReason: null };
}
