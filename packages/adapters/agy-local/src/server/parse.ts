import { asString } from "@paperclipai/adapter-utils/server-utils";
import { agyUsage, hasAgyUsage, normalizeAgyEvents, record } from "../events.js";

const CONVERSATION_ID_RE = /(?:conversation|session)(?:\s+id)?[:\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const CONVERSATION_TRAVERSED_RE = /traversed\s+workspace\s+for\s+conversation\s+([a-f0-9-]{36})/i;

export function parseAgyOutput(stdout: string, stderr: string) {
  const combined = stdout + "\n" + stderr;
  let sessionId: string | null = (combined.match(CONVERSATION_ID_RE) ?? combined.match(CONVERSATION_TRAVERSED_RE))?.[1] ?? null;
  let errorMessage: string | null = null;
  let isError = false;
  let finalText: string | null = null;
  let streamedText = "";
  const messages: string[] = [];
  let usage = agyUsage(null);
  let resultUsage: ReturnType<typeof agyUsage> | null = null;
  const stepUsage = new Map<number, ReturnType<typeof agyUsage>>();
  let costUsd: number | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const events = normalizeAgyEvents(line);
    if (!events) { messages.push(line); continue; }
    for (const event of events) {
      const id = asString(event.sessionId ?? event.session_id ?? event.conversationId ?? event.conversation_id, "");
      if (id) sessionId = id;
      if (typeof event.stepIndex === "number" && event.stepUsage != null) {
        // A step may emit usage repeatedly; retain its latest totals once.
        stepUsage.set(event.stepIndex, agyUsage(event.stepUsage));
      }
      const type = asString(event.type, "").toLowerCase();
      if (type === "assistant" || type === "text") {
        const text = asString(event.text ?? event.content ?? event.message, "");
        if (event.delta === true) streamedText += text;
        else if (text) messages.push(text);
      } else if (type === "error" || type === "stderr") {
        isError = true;
        errorMessage = asString(event.message ?? event.error ?? event.text, "AGY CLI error");
      } else if (type === "result" || type === "stats" || type === "usage") {
        if (typeof event.text === "string") finalText = event.text;
        if (event.isError === true || event.is_error === true) {
          isError = true;
          errorMessage = asString(event.error ?? event.message, "AGY CLI error");
        }
        const rawStats = event.stats ?? event.usage ?? (type === "stats" || type === "usage" ? event : null);
        if (rawStats && hasAgyUsage(rawStats)) {
          const stats = record(rawStats);
          resultUsage = agyUsage(stats);
          usage = resultUsage;
          const cost = stats.total_cost_usd ?? stats.costUsd ?? stats.cost;
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) costUsd = cost;
        } else if (rawStats) {
          const stats = record(rawStats);
          const cost = stats.total_cost_usd ?? stats.costUsd ?? stats.cost;
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) costUsd = cost;
        }
      }
    }
  }
  const hasStepUsage = stepUsage.size > 0;
  let usageBasis: "per_run" | "session_cumulative" | null = null;
  if (hasStepUsage) {
    usage = agyUsage(null);
    for (const step of stepUsage.values()) {
      usage.inputTokens += step.inputTokens;
      usage.outputTokens += step.outputTokens;
      usage.cachedInputTokens += step.cachedInputTokens;
    }
    usageBasis = "per_run";
  } else if (resultUsage) {
    usageBasis = "session_cumulative";
  }
  errorMessage ||= stderr.split(/\r?\n/).map((line) => line.trim())
    .find((line) => /error|failed/i.test(line)) ?? null;
  return {
    sessionId,
    summary: (finalText ?? (streamedText || messages.join("\n"))).trim(),
    usage,
    usageBasis,
    hasStepUsage,
    resultUsage,
    costUsd,
    errorMessage,
    isError,
  };
}

export const parseAntigravityOutput = parseAgyOutput;

export function isAgyUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes("unknown conversation") ||
    haystack.includes("conversation not found") ||
    haystack.includes("unknown session") ||
    haystack.includes("session not found") ||
    haystack.includes("failed to resume") ||
    haystack.includes("cannot resume") ||
    haystack.includes("no conversation found")
  );
}

export const isAntigravityUnknownSessionError = isAgyUnknownSessionError;

export function describeAgyFailure(stdout: string, stderr: string): string | null {
  const { errorMessage } = parseAgyOutput(stdout, stderr);
  if (errorMessage) {
    return `AGY CLI failed: ${errorMessage}`;
  }
  const firstStderr = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (firstStderr) {
    return `AGY CLI failed: ${firstStderr}`;
  }
  return "AGY CLI failed with non-zero exit code";
}

export const describeAntigravityFailure = describeAgyFailure;

const AGY_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|requires\s+login|unauthorized|authentication\s+required|api[_ ]?key\s+(?:required|missing|invalid)|invalid\s+credentials|run\s+`?agy\s+login`?\s+first)/i;

export function detectAgyAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const requiresAuth = AGY_AUTH_REQUIRED_RE.test(combined);
  return { requiresAuth };
}

export const detectAntigravityAuthRequired = detectAgyAuthRequired;

export function isAgyTurnLimitResult(
  stdout: string,
  stderr: string,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("turn_limit") ||
    combined.includes("max_turns") ||
    combined.includes("max_turns_exhausted") ||
    combined.includes("turn_limit_exhausted")
  );
}

export const isAntigravityTurnLimitResult = isAgyTurnLimitResult;

/**
 * Matches AGY CLI quota / rate-limit errors that are transient and
 * should be retried automatically after a back-off.
 */
const AGY_QUOTA_RE =
  /(?:individual\s+quota\s+reached|quota\s+(?:reached|exceeded|exhausted)|resource[_\s]exhausted|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|service\s+unavailable|\b503\b|overages\s+(?:not\s+)?enabled|resets?\s+in\s+\d)/i;

/**
 * Parses a human-readable duration string produced by agy such as
 * "4h3m21s", "2h30m", "45m", "90s" into milliseconds.
 * Returns null if the string cannot be parsed.
 */
export function parseAgyResetDurationMs(raw: string): number | null {
  const match = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return totalMs > 0 ? totalMs : null;
}

export function detectAgyQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): { exhausted: boolean; resetHint: string | null; retryNotBefore: string | null } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const exhausted = AGY_QUOTA_RE.test(combined);

  if (!exhausted) return { exhausted: false, resetHint: null, retryNotBefore: null };

  const resetMatch = combined.match(/resets?\s+in\s+([\dhms\s]+)/i);
  const resetHint = resetMatch ? `Resets in ${resetMatch[1].trim()}` : null;

  let retryNotBefore: string | null = null;
  if (resetMatch) {
    const durationMs = parseAgyResetDurationMs(resetMatch[1].trim());
    if (durationMs !== null) {
      retryNotBefore = new Date(Date.now() + durationMs + 60_000).toISOString();
    }
  }

  return { exhausted, resetHint, retryNotBefore };
}

export const detectAntigravityQuotaExhausted = detectAgyQuotaExhausted;
