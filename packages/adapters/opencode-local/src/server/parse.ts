import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

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

export function parseOpenCodeJsonl(stdout: string) {
  return createOpenCodeJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createOpenCodeJsonlParser() {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd: number | null = null;
  let missingCost = false;
  let usageReported = false;
  let missingUsage = false;

  return (stdout: string) => {
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
        const counts = [tokens.input, tokens.output, cache.read === undefined ? 0 : cache.read, cache.write === undefined ? 0 : cache.write, tokens.reasoning === undefined ? 0 : tokens.reasoning];
        if (counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
          const [input, output, cached, written, reasoning] = counts as number[];
          const next = { inputTokens: usage.inputTokens + input + written,
            outputTokens: usage.outputTokens + output + reasoning, cachedInputTokens: usage.cachedInputTokens + cached };
          if (Object.values(next).every(Number.isSafeInteger)) { Object.assign(usage, next); usageReported = true; }
          else missingUsage = true;
        } else missingUsage = true;
        if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) costUsd = (costUsd ?? 0) + part.cost;
        else missingCost = true;
        continue;
      }

      if (type === "tool_use") {
        const part = parseObject(event.part);
        const state = parseObject(part.state);
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
      usage: { ...usage },
      usageReported,
      usageComplete: usageReported && !missingUsage,
      costUsd: missingCost ? null : costUsd,
      errorMessage: errors.length > 0 ? errors.join("\n") : null,
      toolErrors,
    };
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

// Provider-level usage walls. These do not clear on the retry cadence an
// in-run retry can afford, so they carry their own family and are handed to
// the durable quota recovery path instead of being retried in-process.
const OPENCODE_PROVIDER_QUOTA_RE =
  /free usage limit reached|usage limit (?:reached|exceeded)|provider quota|quota (?:limit )?exceeded|insufficient (?:credits|balance)|out of credits|credit balance|subscribe to opencode/i;

// Transient transport/provider failures: a short outage, rate limit or
// capacity wall that may clear while the run is still alive.
const OPENCODE_TRANSIENT_UPSTREAM_RE =
  /rate.?limit|too.?many.?requests|\b429\b|overloaded|\b529\b|throttl|model (?:is )?at capacity|at capacity|service.?unavailable|endpoint.?unavailable|\bunavailable\b|\b503\b|socket.?hang.?up|fetch.?failed|econnreset|econnrefused|etimedout|enotfound|\beof\b|cloudflare|gateway.?error|bad.?gateway|\b50[24]\b/i;

export function isOpenCodeProviderQuotaError(stdout: string, stderr: string): boolean {
  return OPENCODE_PROVIDER_QUOTA_RE.test(`${stdout}\n${stderr}`);
}

export function isOpenCodeApiError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  if (OPENCODE_PROVIDER_QUOTA_RE.test(haystack)) return false;
  return OPENCODE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

export type OpenCodeFailureClassification = {
  errorCode: "provider_quota" | "opencode_transient_upstream";
  errorFamily: "provider_quota" | "transient_upstream";
};

/**
 * Machine-readable classification for a failed OpenCode attempt. A null
 * result is deliberately terminal: the server must leave a non-transient
 * failure in `error` rather than retrying it.
 */
export function classifyOpenCodeFailure(
  stdout: string,
  stderr: string,
): OpenCodeFailureClassification | null {
  if (isOpenCodeProviderQuotaError(stdout, stderr)) {
    return { errorCode: "provider_quota", errorFamily: "provider_quota" };
  }
  if (isOpenCodeApiError(stdout, stderr)) {
    return {
      errorCode: "opencode_transient_upstream",
      errorFamily: "transient_upstream",
    };
  }
  return null;
}
