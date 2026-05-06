import type { AdapterSessionCodec } from "../types.js";
import { asString, parseObject } from "../utils.js";

export interface OllamaSessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
}

export interface OllamaSessionParams extends Record<string, unknown> {
  sessionId: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  messages: OllamaSessionMessage[];
  toolCallCount?: number;
  metadata?: Record<string, unknown>;
}

function normalizeMessage(raw: unknown): OllamaSessionMessage | null {
  const value = parseObject(raw);
  const role = asString(value.role, "").trim();
  const content = asString(value.content, "");
  if ((role !== "user" && role !== "assistant" && role !== "tool") || !content) {
    return null;
  }
  return {
    role,
    content,
    toolName: asString(value.toolName, "").trim() || null,
  };
}

export function parseOllamaSessionParams(raw: unknown): OllamaSessionParams | null {
  const value = parseObject(raw);
  const sessionId = asString(value.sessionId, "").trim();
  if (!sessionId) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter((message): message is OllamaSessionMessage => Boolean(message))
    : [];
  return {
    sessionId,
    model: asString(value.model, "").trim(),
    baseUrl: asString(value.baseUrl, "").trim(),
    createdAt: asString(value.createdAt, new Date().toISOString()),
    updatedAt: asString(value.updatedAt, new Date().toISOString()),
    messages,
    toolCallCount: typeof value.toolCallCount === "number" ? value.toolCallCount : undefined,
    metadata: parseObject(value.metadata),
  };
}

export const ollamaLocalSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const parsed = parseOllamaSessionParams(raw);
    return parsed ? { ...parsed } : null;
  },
  serialize(params: Record<string, unknown> | null) {
    const parsed = parseOllamaSessionParams(params);
    return parsed ? { ...parsed } : null;
  },
  getDisplayId(session) {
    return typeof session?.sessionId === "string" ? session.sessionId : null;
  },
};
