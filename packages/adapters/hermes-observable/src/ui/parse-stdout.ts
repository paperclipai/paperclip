import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { HERMES_OBSERVABLE_EVENT_TYPES } from "../shared/constants.js";

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

export function parseHermesObservableStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  const parsed = parseJson(trimmed);
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.init) {
    const mode = asString(parsed.endpointMode);
    const model = asString(parsed.model, "hermes");
    const sessionId =
      asString(parsed.sessionId) ||
      asString(parsed.conversation) ||
      asString(parsed.responseId);
    return [{
      kind: "init",
      ts,
      model: mode ? `${model} (${mode})` : model,
      sessionId,
    }];
  }

  if (type === HERMES_OBSERVABLE_EVENT_TYPES.textDelta) {
    const text = asString(parsed.text);
    if (!text) return [];
    const channel = asString(parsed.channel);
    return [{
      kind: channel === "thinking" ? "thinking" : "assistant",
      ts,
      text,
      delta: true,
    }];
  }

  if (type === HERMES_OBSERVABLE_EVENT_TYPES.toolCall) {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.name, "tool"),
      toolUseId: asString(parsed.toolCallId) || undefined,
      input: parsed.input ?? {},
    }];
  }

  if (type === HERMES_OBSERVABLE_EVENT_TYPES.toolResult) {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.toolCallId, asString(parsed.name, "tool")),
      toolName: asString(parsed.name) || undefined,
      content: stringify(parsed.content ?? parsed.output ?? parsed.text),
      isError: parsed.isError === true,
    }];
  }

  if (type === HERMES_OBSERVABLE_EVENT_TYPES.result) {
    return [{
      kind: "result",
      ts,
      text: asString(parsed.text),
      inputTokens: asNumber(parsed.inputTokens),
      outputTokens: asNumber(parsed.outputTokens),
      cachedTokens: asNumber(parsed.cachedTokens),
      costUsd: asNumber(parsed.costUsd),
      subtype: asString(parsed.subtype, "completed"),
      isError: parsed.isError === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((entry) => stringify(entry)).filter(Boolean)
        : [],
    }];
  }

  if (type === HERMES_OBSERVABLE_EVENT_TYPES.error) {
    return [{ kind: "stderr", ts, text: asString(parsed.message, line) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
