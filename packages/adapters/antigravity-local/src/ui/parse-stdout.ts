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

export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Treat plain text line as stdout
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type).trim().toLowerCase();

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = asString(parsed.sessionId ?? parsed.session_id);
      return [{ kind: "init", ts, model: asString(parsed.model, "gemini"), sessionId }];
    }
    return [{ kind: "system", ts, text: asString(parsed.message ?? parsed.text ?? line) }];
  }

  if (type === "error" || type === "stderr") {
    return [{ kind: "stderr", ts, text: asString(parsed.message ?? parsed.error ?? line) }];
  }

  if (type === "assistant" || type === "text") {
    return [{ kind: "assistant", ts, text: asString(parsed.text ?? parsed.content ?? parsed.message ?? line) }];
  }

  if (type === "user") {
    return [{ kind: "user", ts, text: asString(parsed.text ?? parsed.content ?? parsed.message ?? line) }];
  }

  if (type === "thinking") {
    return [{ kind: "thinking", ts, text: asString(parsed.text ?? line) }];
  }

  if (type === "tool_call") {
    const name = asString(parsed.name ?? parsed.tool ?? "tool");
    return [{
      kind: "tool_call",
      ts,
      name,
      input: parsed.input ?? parsed.arguments ?? parsed.args ?? {},
    }];
  }

  if (type === "tool_result" || type === "tool_response") {
    const toolUseId = asString(parsed.toolUseId ?? parsed.tool_use_id ?? "tool_result");
    const content = asString(parsed.content ?? parsed.output ?? parsed.result ?? line);
    const isError = parsed.isError === true || parsed.is_error === true;
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      content,
      isError,
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
