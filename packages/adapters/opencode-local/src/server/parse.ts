import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

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

/**
 * OpenCode can exit non-zero after a successful streamed run. When JSONL ends in `step_finish`
 * with reason `stop` and no parsed error/stderr, callers may treat this as a successful outcome.
 */
export function opencodeStdoutIndicatesIgnorableNonZeroExit(
  parsed: { lastStepFinishReason: string | null; errorMessage: string | null },
  stderr: string,
): boolean {
  const parsedError = typeof parsed.errorMessage === "string" ? parsed.errorMessage.trim() : "";
  return (
    parsed.lastStepFinishReason === "stop" &&
    parsedError.length === 0 &&
    !firstNonEmptyLine(stderr)
  );
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  let lastStepFinishReason: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

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
      const reason = asString(part.reason, "").trim();
      if (reason) lastStepFinishReason = reason;
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
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) errors.push(text);
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
    lastStepFinishReason,
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

/** Non-interactive `opencode run` auto-denies permission prompts; resumed sessions may still hit this until retried fresh. */
export function isOpenCodePermissionAutoRejectError(
  stdout: string,
  stderr: string,
  parsedErrorMessage: string | null,
): boolean {
  const haystack = [stdout, stderr, parsedErrorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (/auto-rejecting/i.test(haystack)) return true;
  if (/permission requested:/i.test(haystack) && /auto-reject/i.test(haystack)) return true;
  if (/rejected permission to use this specific tool call/i.test(haystack)) return true;
  if (/user rejected permission/i.test(haystack)) return true;
  return false;
}

/**
 * OpenCode tracks read-time metadata for edited files; if the file changes on disk before a write
 * (another run, tooling, or manual edit), the tool fails with this message. Retrying a fresh
 * `opencode run` re-reads the file and usually succeeds.
 */
export function isOpenCodeStaleWorkspaceFileError(
  stdout: string,
  stderr: string,
  parsedErrorMessage: string | null,
): boolean {
  const haystack = [stdout, stderr, parsedErrorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (/modified\s+since\s+it\s+was\s+last\s+read/i.test(haystack)) return true;
  if (/must\s+read\s+file/i.test(haystack) && /before\s+overwrit/i.test(haystack)) return true;
  return false;
}

/**
 * Detects tool-call schema/argument validation failures (for example webfetch
 * payload mismatches) that can happen on stale resumed sessions.
 */
export function isOpenCodeToolArgumentValidationError(
  stdout: string,
  stderr: string,
  parsedErrorMessage: string | null,
): boolean {
  const haystack = [stdout, stderr, parsedErrorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (/tool\b.*\bcalled with invalid arg(?:ument)?s?/i.test(haystack)) return true;
  if (/invalid arg(?:ument)?s?\s+for\s+tool/i.test(haystack)) return true;
  if (/webfetch\b.*\binvalid arg(?:ument)?s?/i.test(haystack)) return true;
  return false;
}

/** Detects invalid `webfetch.format` values (for example `json`) emitted by tool-call validation. */
export function isOpenCodeWebfetchFormatValidationError(
  stdout: string,
  stderr: string,
  parsedErrorMessage: string | null,
): boolean {
  const haystack = [stdout, stderr, parsedErrorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (!/webfetch/i.test(haystack)) return false;
  if (/path["'` ]*[:=]["'` ]*format/i.test(haystack) && /invalid/i.test(haystack)) return true;
  if (/expected one of ["'`]?text["'`]?\|["'`]?markdown["'`]?\|["'`]?html/i.test(haystack)) return true;
  if (/invalid option.*format/i.test(haystack)) return true;
  return false;
}

/**
 * Detects path-resolution failures (`File not found`, `ENOENT`) where the model can usually
 * recover by re-checking repository-relative paths on a fresh run.
 */
export function isOpenCodeFileNotFoundPathError(
  stdout: string,
  stderr: string,
  parsedErrorMessage: string | null,
): boolean {
  const haystack = [stdout, stderr, parsedErrorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (/file not found:/i.test(haystack)) return true;
  if (/enoent\b/i.test(haystack) && /(no such file|not found)/i.test(haystack)) return true;
  if (/path\b.*\bnot found/i.test(haystack)) return true;
  return false;
}
