import { asString, parseJson, parseObject } from "./server-utils.js";

/**
 * Drops JSONL event lines (stream events, structured results, and — critically
 * — the agent conversation embedded inside them) from raw CLI stdout, keeping
 * only plain-text lines such as CLI diagnostics and login prompts.
 *
 * Keyword error classifiers must never see the agent conversation: assistant
 * text routinely discusses rate limits, auth, sessions, and retries, and
 * matching it mis-coded successful or unrelated runs as transient/auth
 * failures, chaining full-cost retries (LAC-2760 failure mode).
 */
export function stripJsonlEventLines(stdout: string | null | undefined): string {
  if (!stdout) return "";
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (!trimmed.startsWith("{")) return true;
      return parseJson(trimmed) == null;
    })
    .join("\n");
}

function errorTextFrom(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  const record = parseObject(value);
  const message =
    asString(record.message, "").trim() ||
    asString(record.error, "").trim() ||
    asString(record.detail, "").trim() ||
    asString(record.code, "").trim();
  if (message) return message;
  try {
    const serialized = JSON.stringify(record);
    return serialized === "{}" ? "" : serialized;
  } catch {
    return "";
  }
}

/**
 * Extracts error text from a structured stream event, or "" for every other
 * event shape. Only failure-shaped events (error, turn.failed, system-error,
 * error results) contribute — conversation events (assistant/message/item
 * text) never do, so their text stays invisible to keyword classifiers.
 */
function extractErrorEventText(event: Record<string, unknown>): string {
  const type = asString(event.type, "").trim().toLowerCase();

  if (type === "error") {
    return errorTextFrom(event.error ?? event.message ?? event.detail);
  }

  if (type === "turn.failed") {
    return errorTextFrom(event.error ?? event.message);
  }

  if (type === "system") {
    if (asString(event.subtype, "").trim().toLowerCase() !== "error") return "";
    return errorTextFrom(event.error ?? event.message ?? event.detail);
  }

  if (type === "result") {
    const subtype = asString(event.subtype, "").trim().toLowerCase();
    const status = asString(event.status, "").trim().toLowerCase();
    const isError =
      event.is_error === true ||
      subtype.startsWith("error") ||
      status === "error" ||
      status === "failed";
    if (!isError) return "";
    return errorTextFrom(event.error ?? event.message ?? event.result);
  }

  return "";
}

/**
 * Builds the haystack keyword error classifiers are allowed to scan:
 * adapter-extracted structured error text, error text extracted from
 * failure-shaped JSONL events, plain-text (non-JSONL) stdout, and stderr.
 * Conversation-bearing JSONL events are dropped here, inside the builder, so
 * the "never scan the conversation" invariant is mechanism rather than a
 * per-call-site convention — passing raw stream stdout is safe, and structured
 * error events stay classifiable even when the caller has no parsed
 * errorMessage to pass.
 */
export function buildErrorClassificationHaystack(input: {
  errorMessage?: string | null;
  stdout?: string | null;
  stderr?: string | null;
}): string {
  const stdoutLines: string[] = [];
  for (const rawLine of (input.stdout ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const event = trimmed.startsWith("{") ? parseJson(trimmed) : null;
    if (event == null) {
      stdoutLines.push(trimmed);
      continue;
    }
    const errorText = extractErrorEventText(event);
    if (errorText) stdoutLines.push(errorText);
  }

  return [input.errorMessage ?? "", ...stdoutLines, input.stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
