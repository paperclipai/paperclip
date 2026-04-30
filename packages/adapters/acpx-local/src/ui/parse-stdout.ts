import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
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

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseAcpxStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = parseJson(line);
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  if (type === "acpx.session") {
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, asString(parsed.agent, "acpx")),
      sessionId: asString(parsed.sessionId, asString(parsed.acpSessionId)),
    }];
  }

  if (type === "acpx.text_delta") {
    const text = asString(parsed.text);
    if (!text) return [];
    const channel = asString(parsed.channel);
    return [{
      kind: channel === "thought" || channel === "thinking" ? "thinking" : "assistant",
      ts,
      text,
      delta: true,
    }];
  }

  if (type === "acpx.tool_call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.name, "acp_tool"),
      toolUseId: asString(parsed.id, asString(parsed.toolUseId)),
      input: parsed.input ?? {},
    }];
  }

  if (type === "acpx.tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.id, asString(parsed.toolUseId, "acp_tool")),
      toolName: asString(parsed.name) || undefined,
      content: stringify(parsed.content ?? parsed.output ?? parsed.error),
      isError: parsed.isError === true || parsed.error !== undefined,
    }];
  }

  if (type === "acpx.result") {
    return [{
      kind: "result",
      ts,
      text: asString(parsed.summary, asString(parsed.text)),
      inputTokens: asNumber(parsed.inputTokens),
      outputTokens: asNumber(parsed.outputTokens),
      cachedTokens: asNumber(parsed.cachedTokens),
      costUsd: asNumber(parsed.costUsd),
      subtype: asString(parsed.subtype, "acpx.result"),
      isError: parsed.isError === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((error) => stringify(error)).filter(Boolean)
        : [],
    }];
  }

  if (type === "acpx.error") {
    return [{ kind: "stderr", ts, text: asString(parsed.message, line) }];
  }

  if (type.startsWith("acpx.")) {
    return [{ kind: "system", ts, text: asString(parsed.message, type) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
