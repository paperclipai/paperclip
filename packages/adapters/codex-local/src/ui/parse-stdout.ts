import {
  redactHomePathUserSegments,
  redactHomePathUserSegmentsInValue,
  type TranscriptEntry,
} from "@paperclipai/adapter-utils";

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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return redactHomePathUserSegments(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(redactHomePathUserSegmentsInValue(value), null, 2);
  } catch {
    return redactHomePathUserSegments(String(value));
  }
}

function parseCommandExecutionItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id);
  const command = asString(item.command);
  const status = asString(item.status);
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : null;
  const safeCommand = redactHomePathUserSegments(command);
  const output = redactHomePathUserSegments(asString(item.aggregated_output)).replace(/\s+$/, "");

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "command_execution",
      toolUseId: id || command || "command_execution",
      input: {
        id,
        command: safeCommand,
      },
    }];
  }

  const lines: string[] = [];
  if (safeCommand) lines.push(`command: ${safeCommand}`);
  if (status) lines.push(`status: ${status}`);
  if (exitCode !== null) lines.push(`exit_code: ${exitCode}`);
  if (output) {
    if (lines.length > 0) lines.push("");
    lines.push(output);
  }

  const isError =
    (exitCode !== null && exitCode !== 0) ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    status === "cancelled";

  return [{
    kind: "tool_result",
    ts,
    toolUseId: id || command || "command_execution",
    content: lines.join("\n").trim() || "command completed",
    isError,
  }];
}

function parseFileChangeItem(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const entries = changes
    .map((changeRaw) => asRecord(changeRaw))
    .filter((change): change is Record<string, unknown> => Boolean(change))
    .map((change) => {
      const kind = asString(change.kind, "update");
      const path = redactHomePathUserSegments(asString(change.path, "unknown"));
      return `${kind} ${path}`;
    });

  if (entries.length === 0) {
    return [{ kind: "system", ts, text: "file changes applied" }];
  }

  const preview = entries.slice(0, 6).join(", ");
  const more = entries.length > 6 ? ` (+${entries.length - 6} more)` : "";
  return [{ kind: "system", ts, text: `file changes: ${preview}${more}` }];
}

function parseCodexItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const itemType = asString(item.type);

  if (itemType === "agent_message") {
    const text = asString(item.text);
    if (text) return [{ kind: "assistant", ts, text: redactHomePathUserSegments(text) }];
    return [];
  }

  if (itemType === "reasoning") {
    const text = asString(item.text);
    if (text) return [{ kind: "thinking", ts, text: redactHomePathUserSegments(text) }];
    return [{ kind: "system", ts, text: phase === "started" ? "reasoning started" : "reasoning completed" }];
  }

  if (itemType === "command_execution") {
    return parseCommandExecutionItem(item, ts, phase);
  }

  if (itemType === "file_change" && phase === "completed") {
    return parseFileChangeItem(item, ts);
  }

  if (itemType === "tool_use") {
    return [{
      kind: "tool_call",
      ts,
      name: redactHomePathUserSegments(asString(item.name, "unknown")),
      toolUseId: asString(item.id),
      input: redactHomePathUserSegmentsInValue(item.input ?? {}),
    }];
  }

  if (itemType === "tool_result" && phase === "completed") {
    const toolUseId = asString(item.tool_use_id, asString(item.id));
    const content =
      asString(item.content) ||
      asString(item.output) ||
      asString(item.result) ||
      stringifyUnknown(item.content ?? item.output ?? item.result);
    const isError = item.is_error === true || asString(item.status) === "error";
    return [{ kind: "tool_result", ts, toolUseId, content: redactHomePathUserSegments(content), isError }];
  }

  if (itemType === "error" && phase === "completed") {
    const text = errorText(item.message ?? item.error ?? item);
    return [{ kind: "stderr", ts, text: redactHomePathUserSegments(text || "error") }];
  }

  const id = asString(item.id);
  const status = asString(item.status);
  const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
  return [{
    kind: "system",
    ts,
    text: redactHomePathUserSegments(`item ${phase}: ${itemType || "unknown"}${meta ? ` (${meta})` : ""}`),
  }];
}

export function parseCodexStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: redactHomePathUserSegments(line) }];
  }

  const type = asString(parsed.type);

  if (type === "thread.started") {
    const threadId = asString(parsed.thread_id);
    return [{
      kind: "init",
      ts,
      model: redactHomePathUserSegments(asString(parsed.model, "codex")),
      sessionId: redactHomePathUserSegments(threadId),
    }];
  }

  if (type === "turn.started") {
    return [{ kind: "system", ts, text: "turn started" }];
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(parsed.item);
    if (!item) return [{ kind: "system", ts, text: type.replace(".", " ") }];
    return parseCodexItem(item, ts, type === "item.started" ? "started" : "completed");
  }

  if (type === "turn.completed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    return [{
      kind: "result",
      ts,
      text: redactHomePathUserSegments(asString(parsed.result)),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: redactHomePathUserSegments(asString(parsed.subtype)),
      isError: parsed.is_error === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map(errorText).map(redactHomePathUserSegments).filter(Boolean)
        : [],
    }];
  }

  if (type === "turn.failed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    const message = errorText(parsed.error ?? parsed.message);
    return [{
      kind: "result",
      ts,
      text: redactHomePathUserSegments(asString(parsed.result)),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: redactHomePathUserSegments(asString(parsed.subtype, "turn.failed")),
      isError: true,
      errors: message ? [redactHomePathUserSegments(message)] : [],
    }];
  }

  if (type === "error") {
    const message = errorText(parsed.message ?? parsed.error ?? parsed);
    return [{ kind: "stderr", ts, text: redactHomePathUserSegments(message || line) }];
  }

  return [{ kind: "stdout", ts, text: redactHomePathUserSegments(line) }];
}
