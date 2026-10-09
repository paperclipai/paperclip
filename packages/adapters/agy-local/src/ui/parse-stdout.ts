import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { agyUsage, normalizeAgyEvents } from "../events.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function parseAgyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const events = normalizeAgyEvents(line);
  if (!events) return [{ kind: "stdout", ts, text: line }];
  return events.flatMap((event) => parseEvent(event, line, ts));
}

function parseEvent(parsed: Record<string, unknown>, line: string, ts: string): TranscriptEntry[] {
  const type = asString(parsed.type).trim().toLowerCase();

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = asString(
        parsed.sessionId ?? parsed.session_id ?? parsed.conversationId ?? parsed.conversation_id,
      );
      return [{ kind: "init", ts, model: asString(parsed.model, "gemini"), sessionId }];
    }
    return [{ kind: "system", ts, text: asString(parsed.message ?? parsed.text ?? line) }];
  }

  if (type === "error" || type === "stderr") {
    return [{ kind: "stderr", ts, text: asString(parsed.message ?? parsed.error ?? line) }];
  }

  if (type === "assistant" || type === "text") {
    const delta = parsed.delta === true;
    const convId = asString(parsed.conversation_id ?? parsed.sessionId ?? parsed.session_id, "agy");
    const itemId = parsed.itemId
      ? asString(parsed.itemId)
      : parsed.stepIndex != null
      ? `${convId}:${parsed.stepIndex}`
      : undefined;
    return [
      {
        kind: "assistant",
        ts,
        text: asString(parsed.text ?? parsed.content ?? parsed.message ?? line),
        ...(delta ? { delta: true } : {}),
        ...(itemId ? { itemId } : {}),
      },
    ];
  }

  if (type === "result") {
    const usage = agyUsage(parsed.stats ?? parsed.usage);
    const isError = parsed.isError === true || parsed.is_error === true;
    return [{ kind: "result", ts, text: asString(parsed.text ?? parsed.response),
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedInputTokens, costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      subtype: asString(parsed.status ?? parsed.subtype), isError,
      errors: isError ? [asString(parsed.error ?? parsed.message, "AGY CLI error")] : [] }];
  }

  if (type === "user") {
    return [{ kind: "user", ts, text: asString(parsed.text ?? parsed.content ?? parsed.message ?? line) }];
  }

  if (type === "thinking") {
    const delta = parsed.delta === true;
    const convId = asString(parsed.conversation_id ?? parsed.sessionId ?? parsed.session_id, "agy");
    const itemId = parsed.itemId
      ? asString(parsed.itemId)
      : parsed.stepIndex != null
      ? `${convId}:${parsed.stepIndex}`
      : undefined;
    return [
      {
        kind: "thinking",
        ts,
        text: asString(parsed.text ?? line),
        ...(delta ? { delta: true } : {}),
        ...(itemId ? { itemId } : {}),
      },
    ];
  }

  if (type === "tool_call") {
    const name = asString(parsed.name ?? parsed.tool ?? "tool");
    const rawToolUseId = asString(parsed.toolUseId ?? parsed.tool_use_id ?? parsed.call_id ?? parsed.id).trim();
    const toolUseId = rawToolUseId.length > 0 ? rawToolUseId : undefined;
    return [
      {
        kind: "tool_call",
        ts,
        name,
        input: parsed.input ?? parsed.arguments ?? parsed.args ?? {},
        ...(toolUseId ? { toolUseId } : {}),
      },
    ];
  }

  if (type === "tool_result" || type === "tool_response") {
    const rawToolUseId = asString(parsed.toolUseId ?? parsed.tool_use_id ?? parsed.call_id ?? parsed.id).trim();
    const toolUseId = rawToolUseId.length > 0 ? rawToolUseId : "tool_result";
    const content = asString(parsed.content ?? parsed.output ?? parsed.result ?? line);
    const isError = parsed.isError === true || parsed.is_error === true;
    const toolName = parsed.toolName ? asString(parsed.toolName) : parsed.name ? asString(parsed.name) : undefined;
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId,
        content,
        isError,
        ...(toolName ? { toolName } : {}),
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export const parseAntigravityStdoutLine = parseAgyStdoutLine;
