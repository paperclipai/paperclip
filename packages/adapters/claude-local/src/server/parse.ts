import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

// The legacy login-prompt markers. The Claude CLI prints these words when it
// asks the user to log in. The detector matches them only against the run's
// own error surface (see collectClaudeErrorSurface), never the transcript.
const CLAUDE_LOGIN_PROMPT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;

// The token-failure markers. An assistant or model event can print these same
// words as ordinary prose, so the detector matches them only against the parsed
// terminal result fields of a failed run. See detectClaudeLoginRequired.
const CLAUDE_AUTH_TOKEN_FAILURE_RE =
  /(?:authentication[_\s-](?:failed|error)|failed\s+to\s+authenticate|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access)\s+token|(?:bearer|oauth|access)\s+token[\s\S]{0,40}(?:is\s+)?(?:invalid|expired|revoked))/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached)/i;
const CLAUDE_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;
const CLAUDE_MODEL_NOT_FOUND_RE =
  /(?:\b404\b[\s\S]{0,120})?(?:model[\s_-]*(?:not[\s_-]*found|does not exist|unknown|invalid)|unknown[\s_-]*model)/i;
const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

/**
 * Sum the per-model usage ledger from a Claude CLI result event. The result
 * event's top-level `usage` reflects only the main-loop message chain, so it
 * undercounts output tokens whenever subagents or sidechains ran; `modelUsage`
 * is the CLI's authoritative per-model accounting (it is what backs /cost).
 * Cache-creation tokens are billed prompt tokens, so they count as input.
 */
export function claudeModelUsageTotals(modelUsage: unknown): UsageSummary | null {
  const byModel = parseObject(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawEntry = false;
  for (const value of Object.values(byModel)) {
    const entry = parseObject(value);
    if (Object.keys(entry).length === 0) continue;
    sawEntry = true;
    inputTokens += asNumber(entry.inputTokens, 0) + asNumber(entry.cacheCreationInputTokens, 0);
    outputTokens += asNumber(entry.outputTokens, 0);
    cachedInputTokens += asNumber(entry.cacheReadInputTokens, 0);
  }
  if (!sawEntry) return null;
  return { inputTokens, outputTokens, cachedInputTokens };
}

export function claudeModelReceipts(modelUsage: unknown) {
  const entries = Object.entries(parseObject(modelUsage));
  if (!entries.length) return undefined;
  const receipts = entries.map(([model, raw]) => {
    const entry = parseObject(raw);
    const usage = claudeModelUsageTotals({ [model]: entry });
    const costUsd = entry.costUSD;
    return usage && typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? { model, usage, costUsd } : null;
  });
  return receipts.every((part) => part !== null) ? receipts : undefined;
}

export function parseClaudeStreamJson(stdout: string) {
  return createClaudeStreamParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createClaudeStreamParser() {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  const messageUsage = new Map<string, UsageSummary>();
  let anonymousMessage = 0;
  const observedTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const event = parseJson(line);
      if (!event) continue;

      const type = asString(event.type, "");
      if (type === "system" && asString(event.subtype, "") === "init") {
        sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
        model = asString(event.model, model);
        continue;
      }

      if (type === "assistant") {
        sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
        const message = parseObject(event.message);
        const observed = parseObject(message.usage);
        if (Object.keys(observed).length > 0) {
          const key = asString(message.id, "") || `anonymous:${anonymousMessage++}`;
          const previous = messageUsage.get(key);
          const next = {
            inputTokens: Math.max(previous?.inputTokens ?? 0, asNumber(observed.input_tokens, 0) + asNumber(observed.cache_creation_input_tokens, 0)),
            cachedInputTokens: Math.max(previous?.cachedInputTokens ?? 0, asNumber(observed.cache_read_input_tokens, 0)),
            outputTokens: Math.max(previous?.outputTokens ?? 0, asNumber(observed.output_tokens, 0)),
          };
          observedTotals.inputTokens += next.inputTokens - (previous?.inputTokens ?? 0);
          observedTotals.outputTokens += next.outputTokens - (previous?.outputTokens ?? 0);
          observedTotals.cachedInputTokens += next.cachedInputTokens - (previous?.cachedInputTokens ?? 0);
          messageUsage.set(key, next);
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const entry of content) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const block = entry as Record<string, unknown>;
          if (asString(block.type, "") === "text") {
            const text = asString(block.text, "");
            if (text) assistantTexts.push(text);
          }
        }
        continue;
      }

      if (type === "result") {
        finalResult = event;
        sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      }
    }

    if (!finalResult) {
      return {
        sessionId,
        model,
        costUsd: null as number | null,
        usage: messageUsage.size ? { ...observedTotals } : null,
        usageBasis: "per_run" as const,
        summary: assistantTexts.join("\n\n").trim(),
        resultJson: null as Record<string, unknown> | null,
      };
    }

    const modelUsageTotals = claudeModelUsageTotals(finalResult.modelUsage);
    const usageObj = parseObject(finalResult.usage);
    const usage: UsageSummary = modelUsageTotals ?? {
      inputTokens: asNumber(usageObj.input_tokens, 0) + asNumber(usageObj.cache_creation_input_tokens, 0),
      cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
      outputTokens: asNumber(usageObj.output_tokens, 0),
    };
    const costRaw = finalResult.total_cost_usd;
    const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
    const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

    return {
      sessionId,
      model,
      costUsd,
      usage,
      // modelUsage covers exactly this CLI invocation, so mark it per-run to
      // keep the server from applying its session-cumulative delta heuristic.
      usageBasis: "per_run" as const,
      summary,
      resultJson: finalResult,
    };
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

// Collect the parsed terminal result fields that carry an auth failure. The
// CLI writes the token-failure text to the result event, so the detector reads
// the result string, the top-level error field, and the errors array. It never
// reads the raw stdout, so an assistant event cannot inject a token marker.
function collectClaudeTerminalText(parsed: Record<string, unknown>): string {
  return [
    asString(parsed.result, ""),
    asString(parsed.error, ""),
    ...extractClaudeErrorMessages(parsed),
  ]
    .map((field) => field.trim())
    .filter(Boolean)
    .join("\n");
}

// Report whether the parsed terminal result marks the run as an auth failure.
// The token-failure markers apply only to a failed run. A successful probe
// whose answer text repeats an auth phrase does not classify as login required.
function claudeResultIndicatesAuthFailure(parsed: Record<string, unknown>): boolean {
  if (asBoolean(parsed.is_error, false)) return true;
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype.startsWith("error")) return true;
  const status =
    asNumber(parsed.api_error_status, 0) || asNumber(parsed.error_status, 0);
  if (status === 401 || status === 403) return true;
  if (asString(parsed.error, "").trim()) return true;
  return extractClaudeErrorMessages(parsed).length > 0;
}

// Markers of an HTML page or a CDN/edge challenge (for example a Cloudflare
// "Attention Required!" page). The Claude CLI can wrap such a response in
// "Failed to authenticate. API Error: 403 ...", but the edge, not the
// credential, rejected the request.
const CLAUDE_EDGE_MARKER_RE =
  /(?:<!doctype\s+html|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]|<title[\s>]|\bcloudflare\b|attention\s+required!?|just\s+a\s+moment\.\.\.|\bcf-ray\b|\bcf[-_]chl\w*|challenge-platform|\bray\s+id\b)/i;
const CLAUDE_EDGE_CHALLENGE_RE =
  /(?:attention\s+required|just\s+a\s+moment|\bcf[-_]chl\w*|challenge-platform|enable\s+javascript\s+and\s+cookies|checking\s+your\s+browser)/i;
// Genuine credential evidence. A 401 status, or a structured Anthropic
// authentication error, or an invalid/expired/revoked credential message.
// A bare "Failed to authenticate" or "authentication_failed" wrapper is not
// evidence by itself: the CLI prints the same wrapper for an edge 403.
const CLAUDE_GENUINE_AUTH_BODY_RE =
  /(?:"type"\s*:\s*"authentication_error"|\bauthentication_error\b|invalid\s+(?:x-)?api[\s_-]?key|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access|refresh)\s+token|(?:bearer|oauth|access|refresh)\s+token[\s\S]{0,40}(?:is\s+|has\s+)?(?:been\s+)?(?:invalid|expired|revoked)|oauth\s+session\s+(?:has\s+)?expired|not\s+logged\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login))/i;
const CLAUDE_API_ERROR_STATUS_RE = /\bAPI\s+Error:?\s*(\d{3})\b/i;
const CLAUDE_EDGE_RAY_ID_RE =
  /(?:\bcf-ray\s*[:=]\s*|\bray\s+id\s*[:#]?\s*(?:<[^>]{0,80}>\s*)*)([0-9a-f]{16}(?:-[a-z]{3})?)\b/i;
const CLAUDE_EDGE_TITLE_RE = /<title[^>]*>([^<]{0,200})<\/title>/i;

export interface ClaudeEdgeFailureEvidence {
  /** The HTTP status the CLI reported, when it reported one. */
  status: number | null;
  /** "text/html" when the response body was an HTML page. */
  contentType: "text/html" | null;
  /** True when the body carries a CDN/edge challenge marker. */
  challenge: boolean;
  /** The edge request (ray) id, when present. It is not a secret. */
  requestId: string | null;
  /** A short sanitised excerpt. It never contains raw HTML or credentials. */
  excerpt: string;
}

function readClaudeApiErrorStatus(parsed: Record<string, unknown> | null, text: string): number | null {
  const structured = parsed
    ? asNumber(parsed.api_error_status, 0) || asNumber(parsed.error_status, 0)
    : 0;
  if (structured) return structured;
  const match = text.match(CLAUDE_API_ERROR_STATUS_RE);
  return match ? Number.parseInt(match[1] ?? "", 10) || null : null;
}

// The run's own error surface: the parsed terminal result, error and errors
// fields, stderr, and any stdout line that is not a stream-json event. The
// agent transcript (assistant and tool events) is never scanned, so text that
// an agent reads or writes cannot change the classification.
function collectClaudeErrorSurface(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): string {
  // Under stream-json, tool output and assistant text travel inside JSON
  // events. A plain stdout line is the CLI's own message.
  const stdoutPlain = input.stdout
    .split(/\r?\n/)
    .filter((line) => !parseJson(line.trim()))
    .join("\n");
  return [input.parsed ? collectClaudeTerminalText(input.parsed) : "", input.stderr, stdoutPlain]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

/** Shorten provider text for persisted evidence. Never keep markup or secrets. */
export function sanitizeClaudeEdgeExcerpt(text: string, maxLength = 160): string {
  const title = text.match(CLAUDE_EDGE_TITLE_RE)?.[1];
  const base = title ?? text;
  return base
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\b(?:sk-ant-[\w-]+|Bearer\s+\S+|[A-Za-z0-9_-]{32,})/g, "[redacted]")
    .replace(/\b(?:cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Detect a transient edge rejection: an HTML or CDN challenge response, or a
 * 403 without genuine credential evidence. A 401, or a structured
 * authentication error / invalid, expired or revoked credential body, is not
 * an edge failure: it stays a credential failure.
 */
export function detectClaudeEdgeFailure(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): ClaudeEdgeFailureEvidence | null {
  const parsed = input.parsed ?? null;
  const surface = collectClaudeErrorSurface({ parsed, stdout: input.stdout, stderr: input.stderr });
  if (!surface) return null;
  const status = readClaudeApiErrorStatus(parsed, surface);
  if (status === 401) return null;
  const html = /<!doctype\s+html|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]|<title[\s>]/i.test(surface);
  const edgeMarker = CLAUDE_EDGE_MARKER_RE.test(surface);
  const genuineAuth = CLAUDE_GENUINE_AUTH_BODY_RE.test(surface);
  // A real credential body wins over a bare 403, but not over an HTML page:
  // an edge page is never a structured Anthropic authentication response.
  if (!edgeMarker && !(status === 403 && !genuineAuth)) return null;
  if (!edgeMarker && genuineAuth) return null;
  return {
    status,
    contentType: html ? "text/html" : null,
    challenge: CLAUDE_EDGE_CHALLENGE_RE.test(surface),
    requestId: surface.match(CLAUDE_EDGE_RAY_ID_RE)?.[1]?.toLowerCase() ?? null,
    excerpt: sanitizeClaudeEdgeExcerpt(surface),
  };
}

export const CLAUDE_EDGE_REJECTED_ERROR_CODE = "claude_edge_rejected";

/** A safe, human-readable run error for an edge rejection. */
export function describeClaudeEdgeFailure(evidence: ClaudeEdgeFailureEvidence): string {
  const status = evidence.status ? `HTTP ${evidence.status}` : "an HTML response";
  const kind = evidence.challenge ? "an edge challenge page" : evidence.contentType ? "an HTML page" : "a non-authentication rejection";
  const detail = evidence.excerpt ? ` (${evidence.excerpt})` : "";
  return `Claude API request was rejected before authentication with ${status}, ${kind}${detail}. `
    + "This is a transient network or edge failure, not invalid credentials; the connection was not changed.";
}

/**
 * Read a provider Retry-After hint from the run's own error surface. Accepts
 * delta-seconds or an HTTP date. Values beyond the cap are clamped, so a
 * malformed hint cannot park a task for an unbounded time.
 */
export function extractClaudeRetryAfter(
  input: { parsed?: Record<string, unknown> | null; stdout?: string | null; stderr?: string | null },
  now = new Date(),
  maxDelayMs = 60 * 60_000,
): Date | null {
  const surface = collectClaudeErrorSurface({
    parsed: input.parsed ?? null,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  const match = surface.match(/\bretry[-_\s]after["']?\s*[:=]\s*["']?([^\n"',;]+)/i);
  if (!match) return null;
  const raw = (match[1] ?? "").trim();
  let delayMs: number | null = null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) delayMs = Math.round(Number.parseFloat(raw) * 1000);
  else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) delayMs = at - now.getTime();
  }
  if (delayMs === null || !Number.isFinite(delayMs) || delayMs <= 0) return null;
  return new Date(now.getTime() + Math.min(delayMs, maxDelayMs));
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const parsed = input.parsed ?? null;

  // The legacy login-prompt markers match only the run's own error surface.
  // The stream-json transcript carries tool output and the injected prompt,
  // so scanning it let ordinary text such as "unauthorized" or "please log in"
  // invalidate a healthy connection. A successful terminal result's answer
  // text is not an error surface either.
  const promptSurface = parsed && !claudeResultIndicatesAuthFailure(parsed)
    ? collectClaudeErrorSurface({ parsed: null, stdout: input.stdout, stderr: input.stderr })
    : collectClaudeErrorSurface({ parsed, stdout: input.stdout, stderr: input.stderr });
  const promptLines = promptSurface
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const loginPrompt = promptLines.some((line) => CLAUDE_LOGIN_PROMPT_RE.test(line));

  // The token-failure markers match only against the parsed terminal fields of
  // a failed run. The raw stdout is untrusted, so a model that prints a token
  // phrase, or a successful run that repeats one, does not flip the classifier.
  const tokenFailure =
    parsed !== null &&
    claudeResultIndicatesAuthFailure(parsed) &&
    CLAUDE_AUTH_TOKEN_FAILURE_RE.test(collectClaudeTerminalText(parsed));

  // An edge rejection (HTML/CDN challenge, or a 403 without a genuine
  // credential body) is transient. It must never read as a login failure,
  // even when the CLI wraps it in "Failed to authenticate".
  const edgeFailure = (loginPrompt || tokenFailure)
    && detectClaudeEdgeFailure({ parsed, stdout: input.stdout, stderr: input.stderr }) !== null;

  return {
    requiresLogin: (loginPrompt || tokenFailure) && !edgeFailure,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeModelNotFoundError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const messages = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ];
  return messages.some((message) => CLAUDE_MODEL_NOT_FOUND_RE.test(message));
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit" ||
    reason === "turn_limit_exhausted",
  );
}

export function isClaudeRefusalResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  // A policy refusal exits the CLI cleanly (exitCode=0, is_error=false), so it
  // must be detected from the structured fields rather than the failure flag.
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "model_refusal" || subtype === "refusal") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) => reason === "refusal");
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i.test(
      msg,
    ),
  );
}

export function isClaudePoisonedPreviousMessageIdError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /diagnostics\.previous_message_id.*starts with `msg_`/i.test(msg),
  );
}

export function isClaudeImageProcessingError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /could not process image/i.test(msg),
  );
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractClaudeRetryNotBefore(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  now = new Date(),
): Date | null {
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  // Deterministic failures are handled by their own classifiers.
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  if (isClaudeProviderQuotaError(input)) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

export function isClaudeProviderQuotaError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_PROVIDER_QUOTA_RE.test(haystack);
}
