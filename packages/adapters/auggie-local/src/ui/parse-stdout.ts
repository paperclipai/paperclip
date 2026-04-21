import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse a single stdout line emitted by `auggie --print --output-format json`.
 *
 * Auggie emits a single JSON result object on success. Intermediate assistant
 * / tool-call events are not surfaced in JSON print-mode today, so the
 * transcript for a run is typically just one `result` entry plus an assistant
 * entry carrying the final text. Non-JSON preamble lines (e.g. "Applying
 * --max-turns override: ...") are treated as stdout so they remain visible.
 */
export function parseAuggieStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "result") {
    const resultText =
      asString(parsed.result, "").trim() ||
      asString(parsed.text, "").trim() ||
      asString(parsed.response, "").trim();
    const isError = parsed.is_error === true;
    const errors = isError
      ? [errorText(parsed.error ?? parsed.message ?? parsed.result)].filter(Boolean)
      : [];
    const entries: TranscriptEntry[] = [];
    if (resultText && !isError) {
      entries.push({ kind: "assistant", ts, text: resultText });
    }
    entries.push({
      kind: "result",
      ts,
      text: resultText,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost))),
      subtype: asString(parsed.subtype, "result"),
      isError,
      errors,
    });
    return entries;
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
