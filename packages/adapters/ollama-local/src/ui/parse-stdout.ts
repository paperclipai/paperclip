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

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const parsed = safeJsonParse(trimmed);
  const rec = asRecord(parsed);

  if (!rec) {
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(rec.type);

  if (type === "chunk") {
    const content = asString(rec.content).trim();
    if (!content) return [];
    return [{ kind: "assistant", ts, text: content }];
  }

  if (type === "done") {
    const model = asString(rec.model, "ollama");
    const inputTokens = asNumber(rec.prompt_eval_count, 0);
    const outputTokens = asNumber(rec.eval_count, 0);
    if (inputTokens === 0 && outputTokens === 0) return [];
    return [
      {
        kind: "result" as const,
        ts,
        text: `Completed — model: ${model}, tokens: ${inputTokens} in / ${outputTokens} out`,
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "done",
        isError: false,
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const message = asString(rec.message, "Unknown Ollama error");
    return [{ kind: "stdout", ts, text: `[error] ${message}` }];
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
