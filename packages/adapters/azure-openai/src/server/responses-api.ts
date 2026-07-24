/**
 * OpenAI Responses API — SSE parser and request/response shapes.
 *
 * Wire format follows the public OpenAI Responses API SSE spec:
 *
 *   event: response.created            → lifecycle noise, ignore
 *   event: response.in_progress        → lifecycle noise, ignore
 *   event: response.output_item.added  → lifecycle noise, ignore
 *   event: response.content_part.added → lifecycle noise, ignore
 *   event: response.output_text.delta
 *   data: { "type":"response.output_text.delta", "delta":"...", ... }
 *   event: response.output_text.done
 *   data: { "type":"response.output_text.done", "text":"..." }
 *   event: response.content_part.done  → lifecycle noise, ignore
 *   event: response.output_item.done   → lifecycle noise, ignore
 *   event: response.completed
 *   data: {
 *     "type":"response.completed",
 *     "response": {
 *       "id": "...", "model": "<model-id>", "status": "completed",
 *       "usage": {
 *         "input_tokens": 14,
 *         "input_tokens_details": { "cached_tokens": 0 },
 *         "output_tokens": 5,
 *         "output_tokens_details": { "reasoning_tokens": 0 },
 *         "total_tokens": 19
 *       }
 *     }
 *   }
 *
 * Errors on stream: `event: error` with `{ "error": { ... } }`.
 */

import type { UsageSummary } from "@paperclipai/adapter-utils";

export type ResponsesApiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

export type ResponsesApiFinalResponse = {
  id?: string;
  model?: string;
  status?: string;
  usage?: ResponsesApiUsage | null;
  output?: unknown;
  error?: { message?: string; code?: string } | null;
};

export type ResponsesApiParsed = {
  outputText: string;
  finishReason: string | null;
  reportedModel: string | null;
  usage: ResponsesApiUsage | null;
  responseId: string | null;
  errorMessage: string | null;
};

type SseFrame = { event: string | null; data: string };

/**
 * Assemble Responses-API-style request body from the same inputs the
 * Chat-Completions path uses. Uses the OpenAI `input` string form (works both
 * for the classic Responses API and Foundry's OpenAI-compatible endpoint).
 * A system prompt is passed through the `instructions` field, which the
 * Responses API accepts as a stable directive.
 */
export function buildResponsesBody(args: {
  systemPrompt: string | null;
  prompt: string;
  model?: string | null;
  temperature: number;
  maxOutputTokens: number;
  stream: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: args.prompt,
    stream: args.stream,
    temperature: args.temperature,
    max_output_tokens: args.maxOutputTokens,
  };
  if (args.systemPrompt && args.systemPrompt.trim().length > 0) {
    body.instructions = args.systemPrompt.trim();
  }
  if (args.model && args.model.trim().length > 0) {
    body.model = args.model.trim();
  }
  return body;
}

function readFrames(buffer: string): { frames: SseFrame[]; remainder: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join("\n") });
    }
  }
  return { frames, remainder: rest };
}

/**
 * Parse a Responses-API SSE stream. Deltas are forwarded through onDelta so
 * callers can stream to `ctx.onLog("stdout", ...)` in real time. The terminal
 * `response.completed` event supplies usage / final model / finish state.
 */
export async function parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => Promise<void> | void,
): Promise<ResponsesApiParsed> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let outputText = "";
  let finalUsage: ResponsesApiUsage | null = null;
  let reportedModel: string | null = null;
  let responseId: string | null = null;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, remainder } = readFrames(buffer);
    buffer = remainder;

    for (const frame of frames) {
      if (frame.data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }

      const type = (payload.type as string | undefined) ?? frame.event ?? "";

      if (type === "response.output_text.delta") {
        const delta = payload.delta;
        if (typeof delta === "string" && delta.length > 0) {
          outputText += delta;
          await onDelta(delta);
        }
        continue;
      }

      if (type === "response.completed") {
        const response = payload.response as ResponsesApiFinalResponse | undefined;
        if (response) {
          if (response.model && !reportedModel) reportedModel = response.model;
          if (response.id && !responseId) responseId = response.id;
          if (response.status) finishReason = response.status;
          if (response.usage) finalUsage = response.usage;
        }
        continue;
      }

      if (type === "response.created" || type === "response.in_progress") {
        const response = payload.response as ResponsesApiFinalResponse | undefined;
        if (response?.model && !reportedModel) reportedModel = response.model;
        if (response?.id && !responseId) responseId = response.id;
        continue;
      }

      if (type === "error" || frame.event === "error") {
        const err = payload.error as { message?: string; code?: string } | undefined;
        errorMessage = err?.message ?? "Responses API stream error";
        continue;
      }

      // Otherwise: lifecycle noise (output_item.added / .done, content_part.*),
      // safely ignored — we already accumulated deltas.
    }
  }

  return {
    outputText,
    finishReason,
    reportedModel,
    usage: finalUsage,
    responseId,
    errorMessage,
  };
}

/**
 * Parse a non-streaming Responses API JSON body.
 */
export function parseResponsesJson(payload: unknown): ResponsesApiParsed {
  const root = (payload ?? {}) as Record<string, unknown>;
  const status = typeof root.status === "string" ? root.status : null;
  const model = typeof root.model === "string" ? root.model : null;
  const id = typeof root.id === "string" ? root.id : null;
  const usage = (root.usage as ResponsesApiUsage | undefined) ?? null;

  let text = "";
  const output = root.output as unknown;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "output_text") {
          const t = (part as { text?: string }).text;
          if (typeof t === "string") text += t;
        }
      }
    }
  }

  const err = root.error as { message?: string } | null | undefined;
  const errorMessage = err && typeof err.message === "string" ? err.message : null;

  return {
    outputText: text,
    finishReason: status,
    reportedModel: model,
    usage,
    responseId: id,
    errorMessage,
  };
}

/**
 * Normalise Responses-API usage into the Paperclip UsageSummary shape.
 * `cachedInputTokens` comes from `input_tokens_details.cached_tokens`.
 * Reasoning tokens (output_tokens_details.reasoning_tokens) are already
 * INCLUDED in output_tokens by the API, so we do not add them separately.
 */
export function extractUsageFromResponses(u: ResponsesApiUsage | null): UsageSummary | undefined {
  if (!u) return undefined;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cachedInputTokens = u.input_tokens_details?.cached_tokens;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
  };
}
