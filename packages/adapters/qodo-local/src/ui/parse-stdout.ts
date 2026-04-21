import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseQodoStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "assistant") {
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text) return [{ kind: "assistant", ts, text }];
  }

  if (type === "error") {
    const message = typeof parsed.message === "string" ? parsed.message : "";
    if (message) return [{ kind: "stderr", ts, text: message }];
  }

  if (type === "result") {
    const text = typeof parsed.result === "string" ? parsed.result : "";
    const usage = (typeof parsed.usage === "object" && parsed.usage !== null) ? parsed.usage as Record<string, unknown> : {};
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const cachedTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
    const costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
    return [{ kind: "result", ts, text, inputTokens, outputTokens, cachedTokens, costUsd, subtype: "", isError: false, errors: [] }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
