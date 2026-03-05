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

function extractAssistantText(message: unknown): string {
  const rec = asRecord(message);
  if (!rec) return "";
  const content = Array.isArray(rec.content) ? rec.content : [];
  const parts: string[] = [];
  for (const part of content) {
    const p = asRecord(part);
    if (p && asString(p.type) === "text") parts.push(asString(p.text));
  }
  return parts.join("").trim();
}

export function parseCursorStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "system" && asString(parsed.subtype) === "init") {
    const sessionId = asString(parsed.session_id, asString(parsed.sessionId));
    const model = asString(parsed.model, "cursor");
    return [{ kind: "init", ts, model, sessionId }];
  }

  if (type === "user") {
    const text = asString(parsed.message, "").trim();
    return text ? [{ kind: "user", ts, text }] : [{ kind: "stdout", ts, text: line }];
  }

  if (type === "assistant") {
    const text = extractAssistantText(parsed.message);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  // tool_call: subtype "started" = invocation (tool_call entry); "completed"/"complete"/"finished" = result (tool_result entry with result/output/content, exit_code, status).
  if (type === "tool_call") {
    const subtype = asString(parsed.subtype);
    const input =
      (parsed.readToolCall as Record<string, unknown>) ??
      (parsed.writeToolCall as Record<string, unknown>) ??
      parsed;
    const isCompleted =
      subtype === "completed" || subtype === "complete" || subtype === "finished";
    if (isCompleted) {
      const inputRec = asRecord(input);
      const idFromInput = inputRec && typeof inputRec.id === "string" ? inputRec.id : "";
      const toolUseId =
        asString(parsed.id) || idFromInput || `tool_call_${ts}`;
      const content =
        asString(parsed.result) ||
        asString(parsed.output) ||
        asString(parsed.content) ||
        (typeof input === "object" && input !== null ? JSON.stringify(input) : "");
      const exitCode = asNumber(parsed.exit_code, -1);
      const status = asString(parsed.status, "").toLowerCase();
      const isError =
        (exitCode !== -1 && exitCode !== 0) ||
        status === "failed" ||
        status === "errored" ||
        status === "error" ||
        status === "cancelled";
      return [{ kind: "tool_result", ts, toolUseId, content: content.trim() || "completed", isError }];
    }
    const name =
      subtype === "started"
        ? Object.keys(parsed).find((k) => k.endsWith("ToolCall")) ?? "tool_call"
        : "tool_call";
    return [{ kind: "tool_call", ts, name: String(name), input }];
  }

  if (type === "result") {
    const text = asString(parsed.result, "").trim();
    const durationMs = asNumber(parsed.duration_ms);
    const resultEntry: TranscriptEntry = {
      kind: "result",
      ts,
      text,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "result",
      isError: false,
      errors: [],
    };
    return [resultEntry];
  }

  return [{ kind: "stdout", ts, text: line }];
}
