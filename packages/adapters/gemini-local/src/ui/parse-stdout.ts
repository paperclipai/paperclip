import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

function parseJson(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

export function parseGeminiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(parseJson(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type, "");

  if (type === "init") {
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "gemini"),
      sessionId: asString(parsed.session_id, ""),
    }];
  }

  if (type === "message") {
    const role = asString(parsed.role, "");
    const content = asString(parsed.content, "");
    if (role === "assistant" && content) {
      return [{ kind: "assistant", ts, text: content }];
    }
    if (role === "user" && content) {
      return [{ kind: "user", ts, text: content }];
    }
    return [];
  }

  if (type === "tool_call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.name, "unknown"),
      input: parsed.input ?? {},
    }];
  }

  if (type === "tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.id, ""),
      content: asString(parsed.output, asString(parsed.content, "")),
      isError: parsed.is_error === true,
    }];
  }

  if (type === "error") {
    const message = asString(parsed.message, asString(parsed.error, ""));
    return [{ kind: "stderr", ts, text: message || line }];
  }

  if (type === "result") {
    const stats = asRecord(parsed.stats);
    const status = asString(parsed.status, "");
    const errorText = asString(parsed.error, asString(parsed.message, ""));
    const inputTokens = asNumber(stats?.input_tokens, asNumber(stats?.input, 0));
    const outputTokens = asNumber(stats?.output_tokens, 0);
    const cachedTokens = asNumber(stats?.cached, 0);
    return [{
      kind: "result",
      ts,
      text: "",
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: 0,
      subtype: "",
      isError: status.length > 0 && status !== "success",
      errors: status.length > 0 && status !== "success" && errorText ? [errorText] : [],
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
