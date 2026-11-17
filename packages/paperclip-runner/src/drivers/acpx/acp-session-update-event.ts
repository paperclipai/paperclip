import { client, methods, type AnyMessage } from "@agentclientprotocol/sdk";
import type { AcpRuntimeEvent } from "acpx/runtime";

type Payload = Record<string, unknown>;

export const ACP_SESSION_UPDATE_EVENT_KINDS = [
  "tool_call",
  "tool_call_update",
  "agent_message_chunk",
  "agent_thought_chunk",
  "usage_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "plan",
] as const;

const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;
const ORIGIN_META_KEYS = ["origin", "kind", "source"] as const;
const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "fetch", "think", "switch_mode", "other"]);
const USAGE_BREAKDOWN_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["inputTokens", ["inputTokens", "input_tokens"]],
  ["outputTokens", ["outputTokens", "output_tokens"]],
  ["cachedReadTokens", ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]],
  ["cachedWriteTokens", ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]],
  ["thoughtTokens", ["thoughtTokens", "thought_tokens"]],
  ["totalTokens", ["totalTokens", "total_tokens"]],
];

function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return asTrimmedString(value) || undefined;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeOriginMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of ORIGIN_META_KEYS) {
    const entry = value[key];
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractTextDeltaOrigin(payload: Payload): { messageId?: string; meta?: Record<string, string> } {
  const messageId = asOptionalString(payload.messageId);
  const meta = sanitizeOriginMeta(payload._meta);
  return { ...(messageId ? { messageId } : {}), ...(meta ? { meta } : {}) };
}

function resolveTextChunk(payload: Payload, stream: "output" | "thought", tag: string): AcpRuntimeEvent | null {
  const origin = extractTextDeltaOrigin(payload);
  const contentRaw = payload.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== "text") return null;
    const text = asString(contentRaw.text);
    if (typeof text === "string" && (text.length > 0 || origin.messageId)) {
      return { type: "text_delta", text, stream, tag, ...origin } as AcpRuntimeEvent;
    }
  }
  const text = asString(payload.text);
  if (typeof text !== "string" || (text.length === 0 && !origin.messageId)) return null;
  return { type: "text_delta", text, stream, tag, ...origin } as AcpRuntimeEvent;
}

function readFirstString(record: Payload, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asOptionalString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function readFirstStringArray(record: Payload, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const entries = value.map((entry) => asOptionalString(entry)).filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) return entries;
  }
  return undefined;
}

function summarizeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) return undefined;
  if (typeof rawInput === "string" || typeof rawInput === "number" || typeof rawInput === "boolean") return String(rawInput);
  if (!isRecord(rawInput)) return undefined;
  const command = readFirstString(rawInput, ["command", "cmd", "program"]);
  const args = readFirstStringArray(rawInput, ["args", "arguments"]);
  if (command) return [command, ...(args ?? [])].join(" ");
  return readFirstString(rawInput, ["path", "file", "filePath", "filepath", "target", "uri", "url", "query", "pattern", "text", "search"]);
}

function truncateToolSummary(value: string): string {
  if (value.length <= TOOL_OUTPUT_SUMMARY_MAX_CHARS) return value;
  return `${value.slice(0, 499)}…`;
}

const TOOL_CONTENT_TEXT_READERS: Record<string, (record: Payload) => string | undefined> = {
  text: (record) => asString(record.text),
  audio: (record) => `[audio] ${asOptionalString(record.mimeType) || "audio"}`,
  resource_link: (record) => asOptionalString(record.title) || asOptionalString(record.name) || asOptionalString(record.uri),
  resource: (record) => {
    const resource = isRecord(record.resource) ? record.resource : undefined;
    return asString(resource?.text) || asOptionalString(resource?.uri);
  },
  diff: (record) => `diff ${asOptionalString(record.path) || "file"}`,
  terminal: (record) => {
    const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
    return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
  },
};

function readToolContentText(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  if (!record) return undefined;
  if (record.type === "content") return readToolContentText(record.content);
  const type = String(record.type);
  return Object.hasOwn(TOOL_CONTENT_TEXT_READERS, type) ? TOOL_CONTENT_TEXT_READERS[type]!(record) : undefined;
}

function summarizeToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const fragments = content.map((entry) => readToolContentText(entry)?.trim()).filter((entry): entry is string => Boolean(entry));
  if (fragments.length === 0) return undefined;
  return truncateToolSummary([...new Set(fragments)].join("\n"));
}

function summarizeToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput == null) return undefined;
  if (typeof rawOutput === "string" || typeof rawOutput === "number" || typeof rawOutput === "boolean") {
    return truncateToolSummary(String(rawOutput));
  }
  const record = isRecord(rawOutput) ? rawOutput : undefined;
  if (!record) return undefined;
  return truncateToolSummary(readFirstString(record, ["text", "message", "error", "stdout", "stderr", "content"]) ?? "") || undefined;
}

function createToolCallEvent(payload: Payload, tag: "tool_call" | "tool_call_update"): AcpRuntimeEvent {
  const title = asTrimmedString(payload.title) || "tool call";
  const status = asTrimmedString(payload.status);
  const inputSummary = summarizeToolInput(payload.rawInput);
  const outputSummary = summarizeToolContent(payload.content) ?? summarizeToolOutput(payload.rawOutput);
  const toolCallId = asOptionalString(payload.toolCallId);
  const rawKind = asOptionalString(payload.kind);
  const kind = rawKind && TOOL_KINDS.has(rawKind) ? rawKind : undefined;
  const summaryText = status ? `${title} (${status})` : title;
  const detailSummary = tag === "tool_call_update" ? outputSummary ?? inputSummary : inputSummary ?? outputSummary;
  const event: Payload = { type: "tool_call", text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText, tag, title };
  if (toolCallId) event.toolCallId = toolCallId;
  if (status) event.status = status;
  if (kind) event.kind = kind;
  const snapshot = JSON.parse(JSON.stringify(payload)) as Payload;
  if (Array.isArray(snapshot.locations)) event.locations = snapshot.locations;
  if (Object.prototype.hasOwnProperty.call(snapshot, "rawInput")) event.rawInput = snapshot.rawInput;
  if (Object.prototype.hasOwnProperty.call(snapshot, "rawOutput")) event.rawOutput = snapshot.rawOutput;
  if (Array.isArray(snapshot.content)) event.content = snapshot.content;
  if (isRecord(snapshot._meta)) event._meta = snapshot._meta;
  return event as unknown as AcpRuntimeEvent;
}

function normalizeUsageCost(value: unknown): { amount?: number; currency?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const amount = asOptionalFiniteNumber(value.amount);
  const currency = asTrimmedString(value.currency);
  if (amount == null && !currency) return undefined;
  return { ...(amount != null ? { amount } : {}), ...(currency ? { currency } : {}) };
}

function normalizeUsageBreakdown(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const breakdown: Record<string, number> = {};
  for (const [key, aliases] of USAGE_BREAKDOWN_FIELDS) {
    for (const alias of aliases) {
      const found = asOptionalFiniteNumber(value[alias]);
      if (found != null) {
        breakdown[key] = found;
        break;
      }
    }
  }
  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function usageUpdateEvent(payload: Payload): AcpRuntimeEvent {
  const used = asOptionalFiniteNumber(payload.used);
  const size = asOptionalFiniteNumber(payload.size);
  const meta = isRecord(payload._meta) ? payload._meta : undefined;
  const cost = normalizeUsageCost(payload.cost);
  const breakdown = normalizeUsageBreakdown(meta?.usage);
  return {
    type: "status",
    text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
    tag: "usage_update",
    ...(used != null ? { used } : {}),
    ...(size != null ? { size } : {}),
    ...(cost ? { cost } : {}),
    ...(breakdown ? { breakdown } : {}),
    ...(meta ? { _meta: meta } : {}),
  } as AcpRuntimeEvent;
}

function availableCommandsUpdateEvent(payload: Payload): AcpRuntimeEvent {
  const raw = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
  const availableCommands: Array<{ name: string; description?: string; hasInput: boolean }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = asTrimmedString(entry.name);
    if (!name) continue;
    const description = asTrimmedString(entry.description);
    availableCommands.push({ name, ...(description ? { description } : {}), hasInput: entry.input != null });
  }
  return {
    type: "status",
    text: availableCommands.length > 0 ? `available commands updated (${availableCommands.length})` : "available commands updated",
    tag: "available_commands_update",
    availableCommands,
  } as AcpRuntimeEvent;
}

const STATUS_TEXT_RESOLVERS: Record<string, (payload: Payload) => string> = {
  available_commands_update: (payload) => {
    const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
    return commands.length > 0 ? `available commands updated (${commands.length})` : "available commands updated";
  },
  current_mode_update: (payload) => {
    const mode = asTrimmedString(payload.currentModeId) || asTrimmedString(payload.modeId) || asTrimmedString(payload.mode);
    return mode ? `mode updated: ${mode}` : "mode updated";
  },
  config_option_update: (payload) => {
    const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
    const value = asTrimmedString(payload.currentValue) || asTrimmedString(payload.value) || asTrimmedString(payload.optionValue);
    if (id && value) return `config updated: ${id}=${value}`;
    return id ? `config updated: ${id}` : "config updated";
  },
  session_info_update: (payload) => asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated",
};

function statusUpdateEvent(tag: string, payload: Payload): AcpRuntimeEvent | null {
  const resolver = STATUS_TEXT_RESOLVERS[tag];
  const text = resolver ? resolver(payload) : null;
  if (!text) return null;
  return { type: "status", text, tag, ...(isRecord(payload._meta) ? { _meta: payload._meta } : {}) } as AcpRuntimeEvent;
}

function normalizePlanEntries(value: unknown): Array<{ content: string; status: string; priority?: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ content: string; status: string; priority?: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const content = asTrimmedString(entry.content);
    const status = asTrimmedString(entry.status);
    if (!content || !(status === "pending" || status === "in_progress" || status === "completed")) continue;
    const priority = asTrimmedString(entry.priority);
    entries.push({ content, status, ...(priority === "high" || priority === "medium" || priority === "low" ? { priority } : {}) });
  }
  return entries;
}

function planUpdateEvent(payload: Payload): AcpRuntimeEvent | null {
  const raw = payload.entries;
  const entries = normalizePlanEntries(raw);
  if (Array.isArray(raw) && raw.length === 0) return { type: "status", text: "plan updated", tag: "plan", entries: [] } as AcpRuntimeEvent;
  const firstContent = asTrimmedString((Array.isArray(raw) ? raw : []).find((entry) => isRecord(entry))?.content);
  const text = (firstContent ? `plan: ${firstContent}` : null) ?? (entries.length > 0 ? `plan: ${entries[0]?.content}` : null);
  if (!text) return null;
  return { type: "status", text, tag: "plan", ...(entries.length > 0 ? { entries } : {}) } as AcpRuntimeEvent;
}

const PARSERS: Record<string, (payload: Payload) => AcpRuntimeEvent | null> = {
  tool_call: (payload) => createToolCallEvent(payload, "tool_call"),
  tool_call_update: (payload) => createToolCallEvent(payload, "tool_call_update"),
  agent_message_chunk: (payload) => resolveTextChunk(payload, "output", "agent_message_chunk"),
  agent_thought_chunk: (payload) => resolveTextChunk(payload, "thought", "agent_thought_chunk"),
  usage_update: usageUpdateEvent,
  available_commands_update: availableCommandsUpdateEvent,
  current_mode_update: (payload) => statusUpdateEvent("current_mode_update", payload),
  config_option_update: (payload) => statusUpdateEvent("config_option_update", payload),
  session_info_update: (payload) => statusUpdateEvent("session_info_update", payload),
  plan: planUpdateEvent,
};

export function acpRuntimeEventFromValidatedSessionUpdate(message: unknown): AcpRuntimeEvent | null {
  if (!isRecord(message) || asTrimmedString(message.method) !== "session/update") return null;
  const params = message.params;
  if (!isRecord(params) || !isRecord(params.update)) return null;
  const payload = params.update;
  const kind = asTrimmedString(payload.sessionUpdate);
  return Object.hasOwn(PARSERS, kind) ? PARSERS[kind]!(payload) : null;
}

const BARRIER_METHOD = "_paperclip/session_update_barrier";

export type AcpSessionUpdateEventConverter = {
  convert(message: unknown): Promise<AcpRuntimeEvent | null>;
  close(): void;
};

export function createAcpSessionUpdateEventConverter(): AcpSessionUpdateEventConverter {
  let enqueue: ((message: AnyMessage) => void) | null = null;
  let closeInput: (() => void) | null = null;
  const pending = new Map<number, (event: AcpRuntimeEvent | null) => void>();
  let converted: AcpRuntimeEvent | null = null;
  let sequence = 0;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      enqueue = (message) => controller.enqueue(message);
      closeInput = () => controller.close();
    },
  });
  const writable = new WritableStream<AnyMessage>();
  client({ name: "paperclip-provider-turn" })
    .onNotification(methods.client.session.update, ({ params }) => {
      converted = acpRuntimeEventFromValidatedSessionUpdate({ jsonrpc: "2.0", method: "session/update", params });
    })
    .onNotification(BARRIER_METHOD, (params: unknown) => params as { sequence: number }, ({ params }) => {
      const settle = pending.get(params.sequence);
      pending.delete(params.sequence);
      const event = converted;
      converted = null;
      settle?.(event);
    })
    .connect({ readable, writable });
  let closed = false;
  return {
    convert(message) {
      const params = isRecord(message) ? message.params : undefined;
      const kind = isRecord(params) && isRecord(params.update) ? params.update.sessionUpdate : undefined;
      if (closed || !isRecord(message) || message.method !== "session/update" || message.id !== undefined || !isRecord(params)
        || !(ACP_SESSION_UPDATE_EVENT_KINDS as readonly unknown[]).includes(kind)) {
        return Promise.resolve(null);
      }
      const id = ++sequence;
      const result = new Promise<AcpRuntimeEvent | null>((resolve) => pending.set(id, resolve));
      enqueue!({ jsonrpc: "2.0", method: "session/update", params: structuredClone(params) } as AnyMessage);
      enqueue!({ jsonrpc: "2.0", method: BARRIER_METHOD, params: { sequence: id } } as AnyMessage);
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const settle of pending.values()) settle(null);
      pending.clear();
      closeInput?.();
    },
  };
}
