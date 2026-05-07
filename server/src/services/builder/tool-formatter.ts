import type { BuilderToolDescriptor } from "@paperclipai/shared";

export interface BuilderAdapterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
}

type ParsedBuilderResponse = {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: "stop" | "tool_calls" | "length" | "other";
};

const RESPONSE_SHAPE = {
  text: "string",
  toolCalls: [{ id: "string", name: "string", arguments: {} }],
  finishReason: "stop | tool_calls",
};

export function buildBuilderPrompt(
  messages: BuilderAdapterMessage[],
  tools: BuilderToolDescriptor[],
): string {
  const toolCatalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
    requiresApproval: tool.requiresApproval,
    capability: tool.capability,
    source: tool.source,
  }));

  const transcript = messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls && message.toolCalls.length > 0
      ? { toolCalls: message.toolCalls }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  }));

  return [
    "You are the Bizbox Company AI Builder execution engine.",
    "Respond with exactly one JSON object and nothing else.",
    "Never wrap the JSON in markdown fences.",
    "",
    "Required JSON shape:",
    JSON.stringify(RESPONSE_SHAPE, null, 2),
    "",
    "Rules:",
    "- Use only the tools listed below.",
    "- If you need tools, set finishReason to \"tool_calls\" and include one or more toolCalls.",
    "- If you are ready to answer the operator, set finishReason to \"stop\" and return an empty toolCalls array.",
    "- Keep text concise.",
    "- Do not invent company facts; use tools instead.",
    "- Each tool call id must be a non-empty string unique within this response.",
    "",
    "Available tools:",
    JSON.stringify(toolCatalog, null, 2),
    "",
    "Conversation transcript:",
    JSON.stringify(transcript, null, 2),
  ].join("\n");
}

export function parseBuilderResponsePayload(raw: string): ParsedBuilderResponse | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const toolCalls = normalizeToolCalls(record.toolCalls ?? record.tool_calls);
  const rawFinishReason =
    typeof record.finishReason === "string"
      ? record.finishReason
      : typeof record.finish_reason === "string"
        ? record.finish_reason
        : null;

  const finishReason =
    rawFinishReason === "length" || rawFinishReason === "other"
      ? rawFinishReason
      : rawFinishReason === "tool_calls" || toolCalls.length > 0
        ? "tool_calls"
        : "stop";

  return {
    text: typeof record.text === "string" ? record.text : "",
    toolCalls,
    finishReason,
  };
}

function normalizeToolCalls(
  value: unknown,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      if (typeof entry !== "object" || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) return null;
      const args =
        typeof record.arguments === "object" &&
        record.arguments !== null &&
        !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : {};

      return {
        id:
          typeof record.id === "string" && record.id.trim().length > 0
            ? record.id.trim()
            : `call_${index + 1}`,
        name,
        arguments: args,
      };
    })
    .filter((entry): entry is { id: string; name: string; arguments: Record<string, unknown> } => Boolean(entry));
}

function extractJsonCandidate(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = tryParseJson(fencedMatch[1].trim());
    if (fenced !== null) return fenced;
  }

  const balancedObject = extractBalancedObject(trimmed);
  if (balancedObject) {
    const parsed = tryParseJson(balancedObject);
    if (parsed !== null) return parsed;
  }

  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractBalancedObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }

  return null;
}
