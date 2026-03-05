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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isJsonLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function parseOpenCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    return [
      {
        kind: "system",
        ts,
        text: `step started${sessionId ? ` (${sessionId})` : ""}`,
      },
    ];
  }

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (type === "tool_use") {
    const part = asRecord(parsed.part);
    const toolUseId = asString(part?.callID, asString(part?.id, "tool_use"));
    const toolName = asString(part?.tool, "tool");
    const state = asRecord(part?.state);
    const input = state?.input ?? {};
    const output = asString(state?.output).trim();
    const status = asString(state?.status).trim();
    const exitCode = asNumber(asRecord(state?.metadata)?.exit, NaN);
    const isError =
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      (Number.isFinite(exitCode) && exitCode !== 0);

    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts,
        name: toolName,
        input,
      },
    ];

    if (status || output) {
      const lines: string[] = [];
      if (status) lines.push(`status: ${status}`);
      if (Number.isFinite(exitCode)) lines.push(`exit: ${exitCode}`);
      if (output) {
        if (lines.length > 0) lines.push("");
        if (isJsonLike(output)) {
          try {
            lines.push(JSON.stringify(JSON.parse(output), null, 2));
          } catch {
            lines.push(output);
          }
        } else {
          lines.push(output);
        }
      }
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId,
        content: lines.join("\n").trim() || "tool completed",
        isError,
      });
    }

    return entries;
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = asString(part?.reason);
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: asNumber(tokens?.input),
        outputTokens: asNumber(tokens?.output),
        cachedTokens: asNumber(cache?.read),
        costUsd: asNumber(part?.cost),
        subtype: reason || "step_finish",
        isError: reason === "error" || reason === "failed",
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const message =
      asString(parsed.message) ||
      asString(asRecord(parsed.part)?.message) ||
      stringifyUnknown(parsed.error ?? asRecord(parsed.part)?.error) ||
      line;
    return [{ kind: "stderr", ts, text: message }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
