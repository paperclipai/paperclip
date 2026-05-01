import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parse `hermes chat -q ... -Q` output.
 *
 * Empirically (Hermes 2026-05 build):
 *   stdout: the final assistant text only
 *   stderr: a single line of the form "session_id: <id>" (sometimes preceded
 *           by a blank line)
 *
 * If a session_id line happens to slip into stdout (older Hermes builds), we
 * still recognise + strip it so the summary is clean.
 */
export function parseHermesQuietStdout(
  stdout: string,
  stderr = "",
): {
  sessionId: string | null;
  summary: string;
} {
  let sessionId: string | null = null;

  // Primary location: stderr.
  for (const rawLine of stderr.split(/\r?\n/)) {
    const match = /^session_id:\s*(\S+)\s*$/.exec(rawLine.trim());
    if (match) {
      sessionId = match[1] ?? null;
      break;
    }
  }

  if (!stdout) return { sessionId, summary: "" };

  // Fallback / cleanup: in case session_id ever appears in stdout, strip it.
  const lines = stdout.split(/\r?\n/);
  let bodyStart = 0;
  for (let i = 0; i < lines.length && i < 3; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      bodyStart = i + 1;
      continue;
    }
    const match = /^session_id:\s*(\S+)\s*$/.exec(line);
    if (match) {
      if (!sessionId) sessionId = match[1] ?? null;
      bodyStart = i + 1;
    }
    break;
  }

  const summary = lines.slice(bodyStart).join("\n").replace(/\s+$/, "");
  return { sessionId, summary };
}

export type HermesSessionExport = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  billingProvider: string | null;
  model: string | null;
};

/**
 * Parse a single JSONL record from `hermes sessions export --session-id <id> -`.
 *
 * Hermes emits one JSON object per line; for a single-session export there is
 * exactly one line. We read whichever line successfully parses.
 */
export function parseHermesSessionExport(stdout: string): HermesSessionExport | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseJson(line);
    if (!parsed) continue;
    const record = parseObject(parsed);
    if (!record) continue;
    if (typeof record.id !== "string" && typeof record.session_id !== "string") {
      // First line might be a header — skip until we find a session record.
      continue;
    }
    const inputTokens = asNumber(record.input_tokens, 0);
    const outputTokens = asNumber(record.output_tokens, 0);
    const reasoningTokens = asNumber(record.reasoning_tokens, 0);
    const cachedInputTokens = asNumber(record.cache_read_tokens, 0);

    const actualCost = asNumber(record.actual_cost_usd, NaN);
    const estimatedCost = asNumber(record.estimated_cost_usd, NaN);
    const costUsd = Number.isFinite(actualCost)
      ? actualCost
      : Number.isFinite(estimatedCost)
        ? estimatedCost
        : null;

    return {
      inputTokens,
      outputTokens: outputTokens + reasoningTokens,
      cachedInputTokens,
      costUsd,
      billingProvider: asString(record.billing_provider, "").trim() || null,
      model: asString(record.model, "").trim() || null,
    };
  }
  return null;
}

export function isHermesUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return /(session.*not.found|unknown.session|no.*session.*with.*id|session.*does.not.exist)/.test(
    haystack,
  );
}
