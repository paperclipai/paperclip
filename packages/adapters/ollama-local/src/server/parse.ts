/**
 * Parse Ollama adapter stdout lines into a structured result.
 *
 * The execute loop writes JSONL lines to stdout with types:
 *   { type: "ollama_text", text: string }
 *   { type: "ollama_tool_call", tool: string, args: object }
 *   { type: "ollama_tool_result", tool: string, result: string }
 *
 * Plus plain "[paperclip] ..." log lines.
 */

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface ParsedOllamaResult {
  sessionId: string | null;
  summary: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  errors: string[];
  errorMessage: string | null;
}

export function parseOllamaStdout(stdout: string): ParsedOllamaResult {
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sessionId: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Try to parse as JSON event
    const event = asRecord(safeJsonParse(line));
    if (event) {
      const type = asString(event.type);

      if (type === "ollama_text") {
        const text = asString(event.text).trim();
        if (text) messages.push(text);
        continue;
      }

      if (type === "ollama_tool_call" || type === "ollama_tool_result") {
        // not included in summary, handled by CLI/UI
        continue;
      }

      // Session id if present
      const sid = asString(event.sessionId).trim();
      if (sid) sessionId = sid;

      // Usage accumulation from a summary event
      if (type === "ollama_usage") {
        usage.inputTokens += asNumber(event.inputTokens, 0);
        usage.outputTokens += asNumber(event.outputTokens, 0);
        continue;
      }

      if (type === "ollama_error") {
        const msg = asString(event.message).trim();
        if (msg) errors.push(msg);
        continue;
      }

      continue;
    }

    // Non-JSON lines are ignored (they are "[paperclip] ..." log lines)
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim() || null,
    usage,
    errors,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}
