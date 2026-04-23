import type { ZaiChatResponse, ZaiStdoutEvent, ZaiToolCall } from "../shared/types.js";
import { ZAI_STDOUT_PREFIX } from "../shared/types.js";

export function encodeEvent(event: ZaiStdoutEvent): string {
  return `${ZAI_STDOUT_PREFIX} ${JSON.stringify(event)}\n`;
}

/**
 * Consume an SSE stream from `/chat/completions?stream=true` and yield
 * the final assembled response. Emits ZaiStdoutEvent lines via onEvent as
 * the stream progresses (assistant_delta, tool_call, usage).
 */
export async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ZaiStdoutEvent) => Promise<void> | void,
): Promise<ZaiChatResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  let assistantText = "";
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  let finalModel: string | undefined;
  let finalId: string | undefined;
  let finalUsage: ZaiChatResponse["usage"];
  let finalFinishReason: string | null | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines.
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      await handleFrame(frame);
    }
  }
  if (buffer.trim().length > 0) {
    await handleFrame(buffer);
  }

  async function handleFrame(frame: string) {
    const dataLines = frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return;
    const data = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    if (typeof record.id === "string") finalId = record.id;
    if (typeof record.model === "string") finalModel = record.model;

    const usage = asRecord(record.usage);
    if (usage) finalUsage = normalizeUsage(usage);

    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) continue;

      const finishReason = choiceRecord.finish_reason;
      if (typeof finishReason === "string") finalFinishReason = finishReason;

      const delta = asRecord(choiceRecord.delta);
      if (!delta) continue;

      const contentDelta = typeof delta.content === "string" ? delta.content : "";
      if (contentDelta.length > 0) {
        assistantText += contentDelta;
        await onEvent({ kind: "assistant_delta", text: contentDelta });
      }

      const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tcDelta of toolCallDeltas) {
        const tc = asRecord(tcDelta);
        if (!tc) continue;
        const index = typeof tc.index === "number" ? tc.index : 0;
        const bucket = toolCallsByIndex.get(index) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id.length > 0) bucket.id = tc.id;
        const fn = asRecord(tc.function);
        if (fn) {
          if (typeof fn.name === "string" && fn.name.length > 0) bucket.name = fn.name;
          if (typeof fn.arguments === "string") bucket.args += fn.arguments;
        }
        toolCallsByIndex.set(index, bucket);
      }
    }
  }

  const assembledToolCalls: ZaiToolCall[] = [];
  for (const [, bucket] of Array.from(toolCallsByIndex.entries()).sort(([a], [b]) => a - b)) {
    if (!bucket.name) continue;
    assembledToolCalls.push({
      id: bucket.id || `call_${assembledToolCalls.length}`,
      type: "function",
      function: { name: bucket.name, arguments: bucket.args },
    });
    let parsedInput: unknown = {};
    if (bucket.args.trim().length > 0) {
      try {
        parsedInput = JSON.parse(bucket.args);
      } catch {
        parsedInput = { _raw: bucket.args };
      }
    }
    await onEvent({
      kind: "tool_call",
      id: bucket.id || `call_${assembledToolCalls.length - 1}`,
      name: bucket.name,
      input: parsedInput,
    });
  }

  return {
    id: finalId,
    model: finalModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: assistantText.length > 0 ? assistantText : null,
          ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
        },
        finish_reason: finalFinishReason ?? null,
      },
    ],
    usage: finalUsage,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeUsage(usage: Record<string, unknown>): ZaiChatResponse["usage"] {
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  const details = asRecord(usage.prompt_tokens_details);
  const cached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : undefined;
  return {
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    ...(total !== undefined ? { total_tokens: total } : {}),
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}
