import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { normalizeOpenClawGatewayStreamLine } from "../shared/stream.js";

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

function parseAgentEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[openclaw-gateway:event\]\s+run=([^\s]+)\s+stream=([^\s]+)\s+data=(.*)$/s);
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const stream = asString(match[2]).toLowerCase();
  const data = asRecord(safeJsonParse(asString(match[3]).trim()));

  if (stream === "assistant") {
    const delta = asString(data?.delta);
    if (delta.length > 0) {
      return [{ kind: "assistant", ts, text: delta, delta: true }];
    }

    const text = asString(data?.text);
    if (text.length > 0) {
      return [{ kind: "assistant", ts, text }];
    }
    return [];
  }

  if (stream === "thinking") {
    const delta = asString(data?.delta);
    if (delta.length > 0) {
      return [{ kind: "thinking", ts, text: delta, delta: true }];
    }

    const text = asString(data?.text);
    if (text.length > 0) {
      return [{ kind: "thinking", ts, text }];
    }
    return [];
  }

  if (stream === "item" && asString(data?.kind) === "tool") {
    const toolUseId = asString(data?.toolCallId) || asString(data?.itemId);
    const name = asString(data?.name) || "tool";
    const title = asString(data?.title) || asString(data?.meta);
    const phase = asString(data?.phase).toLowerCase();
    if (phase === "start") {
      return [{ kind: "tool_call", ts, name, toolUseId: toolUseId || undefined, input: title ? { title } : {} }];
    }
    if (phase === "end") {
      const status = asString(data?.status).toLowerCase();
      return [{
        kind: "tool_result",
        ts,
        toolUseId: toolUseId || name,
        toolName: name,
        content: asString(data?.error) || title || status,
        isError: status !== "completed",
      }];
    }
    return [];
  }

  if (stream === "error") {
    const message = asString(data?.error) || asString(data?.message);
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  if (stream === "lifecycle") {
    const phase = asString(data?.phase).toLowerCase();
    const message = asString(data?.error) || asString(data?.message);
    if ((phase === "error" || phase === "failed" || phase === "cancelled") && message) {
      return [{ kind: "stderr", ts, text: message }];
    }
  }

  return [];
}

export function parseOpenClawGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeOpenClawGatewayStreamLine(line);
  if (normalized.stream === "stderr") {
    return [{ kind: "stderr", ts, text: normalized.line }];
  }

  const trimmed = normalized.line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[openclaw-gateway:event]")) {
    return parseAgentEventLine(trimmed, ts);
  }

  if (trimmed.startsWith("[openclaw-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[openclaw-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: normalized.line }];
}
