export interface ParsedResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  sessionId: string | null;
}

export function parseResponse(
  response: Record<string, unknown>,
  format: 'gemini' | 'claude' | 'ollama' | 'llamacpp'
): ParsedResponse {
  // Format-specific parsing
  if (format === 'llamacpp' || format === 'ollama') {
    return parseLlamaResponse(response);
  } else if (format === 'gemini') {
    return parseGeminiResponse(response);
  } else if (format === 'claude') {
    return parseClaudeResponse(response);
  }
  throw new Error(`Unknown format: ${format}`);
}

function parseLlamaResponse(response: Record<string, unknown>): ParsedResponse {
  const choice = (response.choices as any[])?.[0];
  const message = choice?.message ?? {};

  return {
    text: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name,
      input: JSON.parse(tc.function?.arguments ?? "{}"),
    })),
    usage: {
      inputTokens: (response.usage as any)?.prompt_tokens ?? 0,
      outputTokens: (response.usage as any)?.completion_tokens ?? 0,
    },
    sessionId: null,
  };
}

function parseGeminiResponse(response: Record<string, unknown>): ParsedResponse {
  // Existing logic from packages/adapters/gemini-local/src/server/parse.ts
  // Refactored into generic parser

  const candidates = response.candidates as any[];
  if (!candidates || candidates.length === 0) {
    return {
      text: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      sessionId: null,
    };
  }

  const candidate = candidates[0];
  const content = candidate.content ?? {};
  const parts = content.parts ?? [];

  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  for (const part of parts) {
    if (part.text) {
      text += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.name + "_" + Math.random().toString(36).substr(2, 9),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: (response.usageMetadata as any)?.promptTokenCount ?? 0,
      outputTokens: (response.usageMetadata as any)?.candidatesTokenCount ?? 0,
    },
    sessionId: null,
  };
}

function parseClaudeResponse(response: Record<string, unknown>): ParsedResponse {
  // Existing logic from packages/adapters/claude-local

  const content = response.content as any[];
  if (!content) {
    return {
      text: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      sessionId: null,
    };
  }

  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  for (const block of content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: (response.usage as any)?.input_tokens ?? 0,
      outputTokens: (response.usage as any)?.output_tokens ?? 0,
    },
    sessionId: null,
  };
}