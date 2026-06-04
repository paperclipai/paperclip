/**
 * Maps amplifier-agent output lines into paperclip `TranscriptEntry[]` for
 * the run viewer.
 *
 * The server's ChildProcessFactory (see server/execute.ts) feeds raw stream
 * chunks into paperclip's `onLog(stream, chunk)`. Paperclip splits those by
 * newline and calls this parser per line. We see two stream types:
 *
 *   - stdout: amplifier-agent emits exactly ONE §4.1 envelope JSON object at
 *     end-of-turn:
 *       { protocolVersion, sessionId, turnId, reply, error, metadata }
 *
 *   - stderr: NDJSON stream of typed notifications (the 9 wire events:
 *     result/delta, result/final, tool/started, tool/completed, progress,
 *     thinking/delta, thinking/final, usage, error) plus arbitrary
 *     non-JSON lines from the engine's startup / shutdown.
 *
 * The parser auto-discriminates by inspecting the JSON shape — we don't
 * need a `stream` parameter because envelope and notification have
 * distinguishable keys (`protocolVersion+reply+metadata` vs `method+params`
 * or `type+sessionId+...`).
 *
 * Defensive parsing: any line we can't parse becomes a `stdout` fallback
 * entry so it still shows up in the viewer.
 */

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

// ---------------------------------------------------------------------------
// Envelope detection + parsing
// ---------------------------------------------------------------------------

function looksLikeEnvelope(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.protocolVersion === "string" &&
    typeof obj.sessionId === "string" &&
    typeof obj.turnId === "string" &&
    "reply" in obj &&
    "metadata" in obj
  );
}

function parseEnvelope(obj: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const sessionId = asString(obj.sessionId);
  const metadata = asRecord(obj.metadata) ?? {};
  const engineVersion = asString(metadata.engineVersion);
  if (sessionId) {
    entries.push({
      kind: "init",
      ts,
      model: engineVersion ? `amplifier-agent ${engineVersion}` : "amplifier-agent",
      sessionId,
    });
  }
  const errorBlock = asRecord(obj.error);
  if (errorBlock) {
    // Terminal error envelope.
    const message = asString(errorBlock.message) || asString(errorBlock.code) || "amplifier-agent error";
    entries.push({
      kind: "result",
      ts,
      text: asString(obj.reply, ""),
      inputTokens: asNumber(metadata.tokensIn),
      outputTokens: asNumber(metadata.tokensOut),
      cachedTokens: asNumber(metadata.cachedTokens),
      costUsd: typeof metadata.costUsd === "number" ? (metadata.costUsd as number) : 0,
      subtype: asString(errorBlock.classification, "error"),
      isError: true,
      errors: [message],
    });
    return entries;
  }
  // Successful turn envelope.
  entries.push({
    kind: "result",
    ts,
    text: asString(obj.reply, ""),
    inputTokens: asNumber(metadata.tokensIn),
    outputTokens: asNumber(metadata.tokensOut),
    cachedTokens: asNumber(metadata.cachedTokens),
    costUsd: typeof metadata.costUsd === "number" ? (metadata.costUsd as number) : 0,
    subtype: "completed",
    isError: false,
    errors: [],
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Wire notification mapping
// ---------------------------------------------------------------------------

function notificationMethod(obj: Record<string, unknown>): string | null {
  const method = asString(obj.method);
  if (method) return method;
  const type = asString(obj.type);
  if (type) return type;
  return null;
}

function notificationParams(obj: Record<string, unknown>): Record<string, unknown> {
  return asRecord(obj.params) ?? {};
}

function parseNotification(
  obj: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const method = notificationMethod(obj);
  if (!method) return [];
  const params = notificationParams(obj);

  switch (method) {
    case "result/delta":
      return [
        {
          kind: "assistant",
          ts,
          text: asString(params.text),
        },
      ];
    case "result/final":
      return [
        {
          kind: "assistant",
          ts,
          text: asString(params.text),
        },
      ];
    case "tool/started":
      return [
        {
          kind: "tool_call",
          ts,
          name: asString(params.name, "<tool>"),
          input: (params.args ?? null) as Record<string, unknown>,
          toolUseId: asString(params.toolCallId),
        },
      ];
    case "tool/completed": {
      const resultValue = params.result;
      const content =
        typeof resultValue === "string"
          ? resultValue
          : resultValue != null
            ? JSON.stringify(resultValue)
            : "";
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: asString(params.toolCallId),
          content,
          isError: false,
        },
      ];
    }
    case "thinking/delta":
    case "thinking/final":
      return [
        {
          kind: "thinking",
          ts,
          text: asString(params.text),
        },
      ];
    case "progress": {
      const message = asString(params.message);
      const percent = typeof params.percent === "number" ? params.percent : null;
      return [
        {
          kind: "system",
          ts,
          text: percent !== null ? `${message} (${percent.toFixed(0)}%)` : message,
        },
      ];
    }
    case "usage":
      // Usage events are aggregated into the result entry; nothing to display
      // in-line. Could surface as system metadata in a future iteration.
      return [];
    case "error":
      return [
        {
          kind: "stderr",
          ts,
          text: asString(params.message) || asString(params.code) || "amplifier-agent error",
        },
      ];
    default:
      // Unknown notification — surface as system message so we don't lose
      // forward-compatible events.
      return [
        {
          kind: "system",
          ts,
          text: `[${method}] ${JSON.stringify(params).slice(0, 200)}`,
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function parseAmplifierLocalStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const parsed = safeJsonParse(trimmed);
  const obj = asRecord(parsed);
  if (!obj) {
    return [{ kind: "stdout", ts, text: line }];
  }
  if (looksLikeEnvelope(obj)) {
    return parseEnvelope(obj, ts);
  }
  // Notification or unknown — try the notification parser first.
  if (notificationMethod(obj)) {
    return parseNotification(obj, ts);
  }
  // Unknown JSON object — fallback to stdout entry.
  return [{ kind: "stdout", ts, text: line }];
}
