import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";

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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseToolCallArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Map one `kimi -p ... --output-format stream-json` stdout line to transcript
 * entries. Verified shapes (kimi 0.27.0): assistant content, assistant
 * tool_calls (arguments is a JSON-encoded string), tool results, and a
 * trailing meta session.resume_hint event.
 */
export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  // ACP-lane runs emit acpx.* events (streaming text deltas, tool-call status
  // lifecycle); delegate those to the shared acpx transcript parser.
  if (asString(parsed.type).startsWith("acpx.")) {
    return parseAcpxStdoutLine(line, ts);
  }

  const role = asString(parsed.role).trim().toLowerCase();

  if (role === "assistant") {
    const entries: TranscriptEntry[] = [];
    const content = asString(parsed.content).trim();
    if (content) entries.push({ kind: "assistant", ts, text: content });
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    for (const callRaw of toolCalls) {
      const call = asRecord(callRaw);
      if (!call) continue;
      const fn = asRecord(call.function);
      const name = asString(fn?.name, asString(call.name, "tool")).trim() || "tool";
      entries.push({
        kind: "tool_call",
        ts,
        name,
        input: parseToolCallArguments(fn?.arguments ?? call.arguments),
        toolUseId: asString(call.id).trim() || undefined,
      });
    }
    return entries;
  }

  if (role === "tool") {
    const toolUseId = asString(parsed.tool_call_id).trim() || "tool_result";
    const content = asString(parsed.content) || stringifyUnknown(parsed.content);
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      content,
      isError: false,
    }];
  }

  if (role === "meta") {
    const type = asString(parsed.type).trim();
    if (type === "session.resume_hint") {
      const sessionId = asString(parsed.session_id).trim();
      return sessionId ? [{ kind: "system", ts, text: `session: ${sessionId}` }] : [];
    }
    return [];
  }

  if (role === "error" || asString(parsed.type).trim().toLowerCase() === "error") {
    const text =
      asString(parsed.content) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Kimi error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
