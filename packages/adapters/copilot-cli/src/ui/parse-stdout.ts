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

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "session.started" || type === "thread.started") {
    const sessionId = asString(parsed.session_id, asString(parsed.thread_id));
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "copilot"),
        sessionId,
      },
    ];
  }

  if (type === "message" || type === "response") {
    const text = asString(parsed.text, asString(parsed.content));
    if (text) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (type === "error") {
    const message = asString(parsed.message, asString(parsed.error));
    return [{ kind: "stderr", ts, text: message || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
