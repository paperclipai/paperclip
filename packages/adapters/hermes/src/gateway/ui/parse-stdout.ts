import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Strip ANSI escape sequences (CSI, OSC) from terminal text.
 * Same pattern used in claude-local adapter quota.ts.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  const eventMatch = trimmed.match(/^\[hermes-gateway:event\]\s+run=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s);
  if (eventMatch) {
    const eventName = eventMatch[2];
    const data = asRecord(safeJsonParse(eventMatch[3]));
    if (eventName === "message.delta") {
      const delta = asString(data?.delta) || asString(data?.text_delta);
      return delta ? [{ kind: "assistant", ts, text: stripAnsi(delta), delta: true }] : [];
    }
    if (eventName === "run.failed" || eventName === "run.error") {
      const message = asString(data?.error) || asString(data?.message) || "Hermes run failed";
      return [{ kind: "stderr", ts, text: message }];
    }
    if (eventName === "reasoning.available") {
      return [{ kind: "thinking", ts, text: "Hermes reasoning available" }];
    }
    return [{ kind: "system", ts, text: `Hermes event: ${eventName}` }];
  }

  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: cleaned }];
}
