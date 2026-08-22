// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — UI Parse Stdout
// Converts raw OpenRouter SSE stdout lines into Paperclip's shared
// transcript entry shape for the run viewer.
// ─────────────────────────────────────────────────────────────────

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

function parseSseData(data: string, ts: string): TranscriptEntry[] {
  if (data === "[DONE]") {
    return [{ kind: "system", ts, text: "run completed" }];
  }

  const parsed = asRecord(safeJsonParse(data));
  if (!parsed) {
    return data ? [{ kind: "stdout", ts, text: data }] : [];
  }

  const choice = asRecord((parsed.choices as unknown[] | undefined)?.[0]);
  const delta = asRecord(choice?.delta);
  const entries: TranscriptEntry[] = [];

  const reasoning = asString(delta?.reasoning_content) || asString(delta?.reasoning);
  if (reasoning) {
    entries.push({ kind: "thinking", ts, text: reasoning, delta: true });
  }

  const content = asString(delta?.content);
  if (content) {
    entries.push({ kind: "assistant", ts, text: content, delta: true });
  }

  const toolCalls = delta?.tool_calls as unknown[] | undefined;
  if (toolCalls?.length) {
    for (const raw of toolCalls) {
      const tc = asRecord(raw);
      const fn = asRecord(tc?.function);
      const argsText = asString(fn?.arguments);
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(fn?.name, "tool"),
        input: safeJsonParse(argsText) ?? argsText,
        toolUseId: asString(tc?.id) || undefined,
      });
    }
  }

  return entries;
}

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("data: ")) {
    return parseSseData(trimmed.slice(6).trim(), ts);
  }

  if (trimmed.includes("OpenRouter API error") || /error/i.test(trimmed)) {
    return [{ kind: "stderr", ts, text: line }];
  }

  if (
    trimmed.startsWith("[openrouter]") ||
    trimmed.startsWith("model:") ||
    trimmed.startsWith("tokens:") ||
    trimmed.startsWith("cost:")
  ) {
    return [{ kind: "system", ts, text: line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function createOpenRouterStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts);
    },
    reset() {
      // Stateless line-by-line parser today — nothing to reset. Kept as a
      // factory (matching the other streaming adapters) so buffering state
      // can be added later without changing the registration shape.
    },
  };
}

// Stateless fallback for callers that haven't migrated to the stateful factory.
export function parseOpenRouterStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
