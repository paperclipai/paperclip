export type OllamaApiMode = "openai" | "ollama";

export type OllamaFailure = {
  errorCode: "auth" | "quota" | "overload" | "connection" | "timeout" | "model_refusal";
  errorFamily: "transient_upstream" | "provider_quota" | "model_refusal";
  message: string;
};

type JsonRecord = Record<string, unknown>;

function mergeStreamArguments(previous: string, incoming: string): string {
  if (!previous || incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  return `${previous}${incoming}`;
}

type StreamToolCallMergeState = {
  nextUnidentifiedByStreamIndex: Map<number, number>;
  activeUnidentifiedByStreamIndex: Map<number, number>;
};

function hasCompleteJsonArguments(value: string): boolean {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function streamToolCallIndex(call: JsonRecord, position: number): number {
  return typeof call.index === "number" && Number.isInteger(call.index) ? call.index : position;
}

function mergeStreamToolCalls(
  existing: unknown[],
  incoming: unknown[],
  state: StreamToolCallMergeState,
): unknown[] {
  const merged = [...existing];
  const matched = new Set<number>();

  for (const [position, rawCall] of incoming.entries()) {
    if (typeof rawCall !== "object" || rawCall === null || Array.isArray(rawCall)) continue;
    const call = rawCall as JsonRecord;
    const streamIndex = streamToolCallIndex(call, position);
    const callId = typeof call.id === "string" && call.id ? call.id : null;
    let unidentifiedCandidates: number[] | null = null;
    let index = callId
      ? merged.findIndex((existingCall) => (
        typeof existingCall === "object" && existingCall !== null && !Array.isArray(existingCall) &&
        (existingCall as JsonRecord).id === callId
      ))
      : -1;

    if (index < 0 && callId) {
      index = merged.findIndex((existingCall, existingPosition) => {
        if (matched.has(existingPosition) || typeof existingCall !== "object" || existingCall === null || Array.isArray(existingCall)) {
          return false;
        }
        const existingRecord = existingCall as JsonRecord;
        return !existingRecord.id && streamToolCallIndex(existingRecord, existingPosition) === streamIndex;
      });
    }

    if (index < 0 && !callId) {
      const candidates = merged.flatMap((existingCall, existingPosition) => {
        if (matched.has(existingPosition) || typeof existingCall !== "object" || existingCall === null || Array.isArray(existingCall)) {
          return [];
        }
        const existingRecord = existingCall as JsonRecord;
        return streamToolCallIndex(existingRecord, existingPosition) === streamIndex ? [existingPosition] : [];
      });
      if (candidates.length > 0) {
        unidentifiedCandidates = candidates;
        const active = state.activeUnidentifiedByStreamIndex.get(streamIndex);
        if (active !== undefined && candidates.includes(active)) {
          index = active;
        } else {
          const cursor = state.nextUnidentifiedByStreamIndex.get(streamIndex) ?? candidates[0];
          index = candidates.find((candidate) => candidate >= cursor) ?? candidates[0];
        }
      }
    }

    if (index < 0) {
      index = merged[streamIndex] === undefined ? streamIndex : merged.length;
    }

    matched.add(index);
    const previous = typeof merged[index] === "object" && merged[index] !== null && !Array.isArray(merged[index])
      ? merged[index] as JsonRecord
      : {};
    const previousFunction = typeof previous.function === "object" && previous.function !== null && !Array.isArray(previous.function)
      ? previous.function as JsonRecord
      : {};
    const nextFunction = typeof call.function === "object" && call.function !== null && !Array.isArray(call.function)
      ? call.function as JsonRecord
      : {};
    const argumentChunk = typeof nextFunction.arguments === "string" ? nextFunction.arguments : null;
    const previousArguments = typeof previousFunction.arguments === "string" ? previousFunction.arguments : "";

    merged[index] = {
      ...previous,
      ...call,
      ...(typeof call.id !== "string" || !call.id ? previous.id ? { id: previous.id } : {} : {}),
      ...(typeof call.type !== "string" || !call.type ? previous.type ? { type: previous.type } : {} : {}),
      function: {
        ...previousFunction,
        ...nextFunction,
        ...(typeof nextFunction.name !== "string" || !nextFunction.name
          ? previousFunction.name ? { name: previousFunction.name } : {}
          : {}),
        ...(argumentChunk !== null
          ? { arguments: mergeStreamArguments(previousArguments, argumentChunk) }
          : previousFunction.arguments ? { arguments: previousFunction.arguments } : {}),
      },
    };

    const activeCall = state.activeUnidentifiedByStreamIndex.get(streamIndex) === index;
    if ((!callId && unidentifiedCandidates?.includes(index)) || (callId && activeCall)) {
      const argumentsValue = (merged[index] as JsonRecord).function as JsonRecord;
      const argumentsText = typeof argumentsValue.arguments === "string" ? argumentsValue.arguments : "";
      if (hasCompleteJsonArguments(argumentsText)) {
        state.activeUnidentifiedByStreamIndex.delete(streamIndex);
        state.nextUnidentifiedByStreamIndex.set(streamIndex, index + 1);
      } else {
        state.activeUnidentifiedByStreamIndex.set(streamIndex, index);
      }
    }
  }

  return merged.filter((call) => call !== undefined);
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function buildChatEndpoint(baseUrl: string, mode: OllamaApiMode = "openai"): string {
  const base = trimUrl(baseUrl || "http://127.0.0.1:11434");
  if (mode === "ollama") return base.endsWith("/api") ? `${base}/chat` : `${base}/api/chat`;
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function buildTagsEndpoint(baseUrl: string): string {
  const base = trimUrl(baseUrl || "http://127.0.0.1:11434");
  return base.endsWith("/api") ? `${base}/tags` : `${base}/api/tags`;
}

export function parseSseEvents(input: string): Array<JsonRecord | "[DONE]"> {
  const events: Array<JsonRecord | "[DONE]"> = [];
  for (const block of input.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as JsonRecord);
      }
    } catch {
      // Providers occasionally emit a partial or vendor-specific event. Ignore it;
      // the final response still determines the run result.
    }
  }
  return events;
}

export function classifyOllamaFailure(status: number, detail: string): OllamaFailure {
  const message = detail.trim() || `Ollama returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return { errorCode: "auth", errorFamily: "transient_upstream", message };
  }
  if (status === 408 || status === 504 || /timeout|timed out|deadline/i.test(message)) {
    return { errorCode: "timeout", errorFamily: "transient_upstream", message };
  }
  if (status === 429 || /rate.?limit|quota|too many requests/i.test(message)) {
    return { errorCode: "quota", errorFamily: "provider_quota", message };
  }
  if (status === 502 || status === 503 || /overload|temporarily unavailable|capacity/i.test(message)) {
    return { errorCode: "overload", errorFamily: "transient_upstream", message };
  }
  if (status >= 500) {
    return { errorCode: "connection", errorFamily: "transient_upstream", message };
  }
  return { errorCode: "model_refusal", errorFamily: "model_refusal", message };
}

export function classifyOllamaTransportFailure(error: unknown): OllamaFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") {
    return { errorCode: "timeout", errorFamily: "transient_upstream", message: "Ollama request timed out" };
  }
  return { errorCode: "connection", errorFamily: "transient_upstream", message };
}

export async function readResponseBody(
  response: Response,
  options: { stream: boolean; onDelta?: (text: string) => Promise<void> },
): Promise<JsonRecord> {
  if (!options.stream || !response.body) return (await response.json()) as JsonRecord;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const nativeMode = response.headers.get("content-type")?.includes("ndjson") ?? false;
  const toolCallMergeState: StreamToolCallMergeState = {
    nextUnidentifiedByStreamIndex: new Map(),
    activeUnidentifiedByStreamIndex: new Map(),
  };
  let pending = "";
  let final: JsonRecord = {};
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const chunks = pending.split(nativeMode ? /\r?\n/ : /\r?\n\r?\n/);
      pending = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const events = parseSseEvents(`${chunk}\n\n`);
        if (events.length === 0) {
          try {
            const parsed = JSON.parse(chunk) as JsonRecord;
            final = await mergeStreamEvent(final, parsed, toolCallMergeState, options.onDelta);
          } catch {
            // Ignore comments and incomplete vendor events.
          }
        } else {
          for (const event of events) {
            if (event !== "[DONE]") {
              final = await mergeStreamEvent(final, event, toolCallMergeState, options.onDelta);
            }
          }
        }
      }
      if (done) break;
    }
    if (pending.trim()) {
      try {
        const parsed = JSON.parse(pending) as JsonRecord;
        final = await mergeStreamEvent(final, parsed, toolCallMergeState, options.onDelta);
      } catch {
        // Ignore a trailing delimiter.
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (nativeMode && final.done === true) delete final.done;
  return final;
}

async function mergeStreamEvent(
  current: JsonRecord,
  event: JsonRecord,
  toolCallMergeState: StreamToolCallMergeState,
  onDelta?: (text: string) => Promise<void>,
): Promise<JsonRecord> {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const choice = choices[0] as JsonRecord | undefined;
  const delta = choice && typeof choice.delta === "object" && choice.delta !== null
    ? choice.delta as JsonRecord
    : null;
  const message = event.message && typeof event.message === "object"
    ? event.message as JsonRecord
    : choice?.message && typeof choice.message === "object"
      ? choice.message as JsonRecord
      : null;
  const text = typeof delta?.content === "string"
    ? delta.content
    : typeof message?.content === "string"
      ? message.content
      : "";
  if (text && onDelta) await onDelta(text);

  const existingChoices = Array.isArray(current.choices) ? current.choices : [{ message: { role: "assistant", content: "" } }];
  const existing = (existingChoices[0] ?? {}) as JsonRecord;
  const existingMessage = (existing.message && typeof existing.message === "object" ? existing.message : {
    role: "assistant",
    content: "",
  }) as JsonRecord;
  const incomingToolCalls = Array.isArray(delta?.tool_calls)
    ? delta.tool_calls
    : Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : null;
  const existingToolCalls = Array.isArray(existingMessage.tool_calls) ? existingMessage.tool_calls : [];
  const toolCalls = incomingToolCalls
    ? mergeStreamToolCalls(existingToolCalls, incomingToolCalls, toolCallMergeState)
    : null;
  const mergedMessage: JsonRecord = {
    ...existingMessage,
    ...(message ?? {}),
    content: `${typeof existingMessage.content === "string" ? existingMessage.content : ""}${text}`,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
  return {
    ...current,
    ...event,
    choices: [{ ...existing, ...choice, message: mergedMessage }],
    ...(event.usage ? { usage: event.usage } : {}),
  };
}
