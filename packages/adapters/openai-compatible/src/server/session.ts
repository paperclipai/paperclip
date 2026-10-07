import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import type { ChatMessage, ChatToolCall } from "./client.js";

export type OpenAiCompatibleSession = {
  sessionId: string;
  apiUrl: string;
  model: string;
  messages: ChatMessage[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  for (const entry of value) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    const id = readString(call?.id);
    const name = readString(fn?.name);
    if (!id || !name) continue;
    calls.push({
      id,
      type: "function",
      function: { name, arguments: typeof fn?.arguments === "string" ? fn.arguments : "{}" },
    });
  }
  return calls;
}

/** Keep only well-formed, non-system history messages. */
export function normalizeSessionMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const entry of value) {
    const message = asRecord(entry);
    if (!message) continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (message.role === "user") {
      messages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const toolCalls = normalizeToolCalls(message.tool_calls);
      messages.push(toolCalls.length > 0 ? { role: "assistant", content, tool_calls: toolCalls } : { role: "assistant", content });
    } else if (message.role === "tool") {
      const toolCallId = readString(message.tool_call_id);
      if (toolCallId) messages.push({ role: "tool", tool_call_id: toolCallId, content });
    }
  }
  return dropOrphanToolMessages(messages);
}

/**
 * Providers reject tool messages whose assistant tool_call is missing, and
 * assistant tool_calls without every matching tool result. Drop both shapes.
 */
export function dropOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "tool") continue; // consumed with its assistant turn below
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      const results: ChatMessage[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === "tool") {
        results.push(messages[cursor]);
        cursor++;
      }
      const wanted = new Set(message.tool_calls.map((call) => call.id));
      const answered = new Set(
        results.map((result) => (result.role === "tool" ? result.tool_call_id : "")).filter((id) => wanted.has(id)),
      );
      if (answered.size === wanted.size) {
        out.push(message, ...results.filter((result) => result.role === "tool" && wanted.has(result.tool_call_id)));
      } else if (message.content.trim()) {
        out.push({ role: "assistant", content: message.content });
      }
      index = cursor - 1;
      continue;
    }
    out.push(message);
  }
  return out;
}

function messageChars(message: ChatMessage): number {
  return JSON.stringify(message).length;
}

/**
 * Trim the oldest history so the persisted conversation stays within budget.
 * The kept window always starts at a user message so tool exchanges stay whole.
 */
export function trimSessionMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const normalized = dropOrphanToolMessages(messages.filter((message) => message.role !== "system"));
  let total = normalized.reduce((sum, message) => sum + messageChars(message), 0);
  let start = 0;
  while (start < normalized.length && total > maxChars) {
    total -= messageChars(normalized[start]);
    start++;
  }
  while (start < normalized.length && normalized[start].role !== "user") start++;
  return normalized.slice(start);
}

export function readSession(raw: unknown): OpenAiCompatibleSession | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId = readString(record.sessionId);
  const apiUrl = readString(record.apiUrl);
  if (!sessionId || !apiUrl) return null;
  return {
    sessionId,
    apiUrl,
    model: readString(record.model) ?? "",
    messages: normalizeSessionMessages(record.messages),
  };
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const session = readSession(raw);
  return session ? { ...session } : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    return readSession(params)?.sessionId ?? null;
  },
};
