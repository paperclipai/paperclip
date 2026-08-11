import { createHash } from "node:crypto";

export interface NativeToolCallTelemetryEvent {
  toolCallId: string;
  toolName: string;
  protocolType: string;
  status: string | null;
  eventType: "call_started" | "call_completed" | "call_failed";
  outcome: "pending" | "success" | "failure";
}

const CODEX_NATIVE_TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "web_search",
  "image_generation",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function stableFallbackId(input: { protocolType: string; toolName: string; payload: Record<string, unknown> }) {
  const identity = JSON.stringify({
    protocolType: input.protocolType,
    toolName: input.toolName,
    input: input.payload.input ?? input.payload.arguments ?? input.payload.args ?? null,
  });
  return `native-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function parseNativeToolCallLine(line: string): NativeToolCallTelemetryEvent | null {
  let root: Record<string, unknown>;
  try {
    root = asRecord(JSON.parse(line));
  } catch {
    return null;
  }
  const protocolType = readString(root, ["type", "eventType", "event_type"]) ?? "";
  const item = asRecord(root.item);
  const itemType = readString(item, ["type", "kind"]) ?? "";
  const payload = Object.keys(item).length > 0 ? item : root;
  const looksLikeToolCall =
    /(?:^|[._-])tool[_-]?call(?:$|[._-])|function[_-]?call|mcp[_-]?tool/i.test(protocolType) ||
    /tool[_-]?call|function[_-]?call|mcp[_-]?tool/i.test(itemType) ||
    CODEX_NATIVE_TOOL_ITEM_TYPES.has(itemType);
  if (!looksLikeToolCall) return null;

  const toolName = readString(payload, ["name", "title", "toolName", "tool_name", "function"]) ??
    readString(asRecord(payload.tool), ["name", "title"]) ??
    (itemType || "native_tool");
  const status = readString(payload, ["status", "state", "outcome"]);
  const toolCallId = readString(payload, [
    "toolCallId", "tool_call_id", "callId", "call_id", "invocationId", "invocation_id", "id",
  ]) ?? stableFallbackId({ protocolType: protocolType || itemType, toolName, payload });
  const normalizedStatus = status?.toLowerCase() ?? "";
  if (/fail|error|denied/.test(normalizedStatus)) {
    return { toolCallId, toolName, protocolType: protocolType || itemType, status, eventType: "call_failed", outcome: "failure" };
  }
  if (/complete|success|succeeded|done/.test(normalizedStatus) || /completed$/.test(protocolType)) {
    return { toolCallId, toolName, protocolType: protocolType || itemType, status, eventType: "call_completed", outcome: "success" };
  }
  return { toolCallId, toolName, protocolType: protocolType || itemType, status, eventType: "call_started", outcome: "pending" };
}

/**
 * Adapters may split JSONL anywhere and ACP emits repeated status updates for
 * one call. This collector buffers incomplete lines and emits exactly one
 * ledger record per native call id for the lifetime of a run.
 */
export class NativeToolCallTelemetryCollector {
  private pendingStdout = "";
  private readonly seen = new Set<string>();

  ingest(stream: "stdout" | "stderr", chunk: string): NativeToolCallTelemetryEvent[] {
    if (stream !== "stdout" || chunk.length === 0) return [];
    const combined = this.pendingStdout + chunk;
    const lines = combined.split(/\r?\n/);
    this.pendingStdout = lines.pop() ?? "";
    // A malformed/unbounded provider line must not become retained context.
    if (this.pendingStdout.length > 256 * 1024) this.pendingStdout = this.pendingStdout.slice(-256 * 1024);
    const events: NativeToolCallTelemetryEvent[] = [];
    for (const line of lines) {
      const event = parseNativeToolCallLine(line.trim());
      if (!event || this.seen.has(event.toolCallId)) continue;
      this.seen.add(event.toolCallId);
      events.push(event);
    }
    return events;
  }
}
