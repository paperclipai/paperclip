export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type ChatCompletionResult = {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  model: string | null;
  usage: ChatCompletionUsage;
};

export type ChatCompletionRequest = {
  apiUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  temperature?: number | null;
  maxTokens?: number | null;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export class OpenAiCompatibleRequestError extends Error {
  readonly status: number | null;
  readonly body: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(
    message: string,
    options: { status?: number | null; body?: string; timedOut?: boolean; aborted?: boolean } = {},
  ) {
    super(message);
    this.name = "OpenAiCompatibleRequestError";
    this.status = options.status ?? null;
    this.body = options.body ?? "";
    this.timedOut = options.timedOut ?? false;
    this.aborted = options.aborted ?? false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  // Some gateways return content parts even for plain text responses.
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  return "";
}

export function buildRequestHeaders(apiKey: string, extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...extraHeaders,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function providerErrorMessage(status: number, body: string): string {
  const parsed = (() => {
    try {
      return asRecord(JSON.parse(body));
    } catch {
      return null;
    }
  })();
  const error = asRecord(parsed?.error);
  const detail =
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof parsed?.message === "string" && parsed.message.trim()) ||
    (typeof parsed?.detail === "string" && parsed.detail.trim()) ||
    body.trim().slice(0, 500);
  return `Provider returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

/** Parse a non-streaming Chat Completions response body. */
export function parseChatCompletionResponse(payload: unknown): ChatCompletionResult {
  const record = asRecord(payload);
  if (!record) throw new OpenAiCompatibleRequestError("Provider returned a non-object response.");
  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    const message = typeof errorRecord.message === "string" ? errorRecord.message : "unknown error";
    throw new OpenAiCompatibleRequestError(`Provider returned an error: ${message}`);
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  if (!choice || !message) {
    throw new OpenAiCompatibleRequestError("Provider response has no choices[0].message.");
  }
  const toolCalls: ChatToolCall[] = [];
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  rawToolCalls.forEach((raw, index) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) return;
    const args =
      typeof fn?.arguments === "string"
        ? fn.arguments
        : fn?.arguments !== undefined
          ? JSON.stringify(fn.arguments)
          : "{}";
    const id = typeof call?.id === "string" && call.id.trim() ? call.id.trim() : `call_${index}`;
    toolCalls.push({ id, type: "function", function: { name, arguments: args } });
  });
  const usage = asRecord(record.usage);
  const promptDetails = asRecord(usage?.prompt_tokens_details);
  const reasoning =
    (typeof message.reasoning_content === "string" && message.reasoning_content) ||
    (typeof message.reasoning === "string" && message.reasoning) ||
    "";
  return {
    content: contentToText(message.content),
    reasoning,
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : null,
    usage: {
      inputTokens: asNonNegativeInt(usage?.prompt_tokens),
      outputTokens: asNonNegativeInt(usage?.completion_tokens),
      cachedInputTokens: asNonNegativeInt(promptDetails?.cached_tokens),
    },
  };
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return {
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    timeoutSignal,
  };
}

export async function createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: false,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.maxTokens === "number" && request.maxTokens > 0) body.max_tokens = request.maxTokens;

  const { signal, timeoutSignal } = combineSignals(request.timeoutMs, request.signal);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(`${request.apiUrl}/chat/completions`, {
      method: "POST",
      headers: buildRequestHeaders(request.apiKey, request.extraHeaders),
      body: JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (err) {
    if (request.signal?.aborted) {
      throw new OpenAiCompatibleRequestError("Request cancelled.", { aborted: true });
    }
    if (timeoutSignal.aborted) {
      throw new OpenAiCompatibleRequestError(
        `Provider request timed out after ${Math.round(request.timeoutMs / 1000)}s.`,
        { timedOut: true },
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenAiCompatibleRequestError(`Could not reach ${request.apiUrl}: ${reason}`);
  }
  if (!response.ok) {
    throw new OpenAiCompatibleRequestError(providerErrorMessage(response.status, text), {
      status: response.status,
      body: text.slice(0, 4000),
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OpenAiCompatibleRequestError(
      `Provider returned invalid JSON (HTTP ${response.status}). Check that apiUrl points at an OpenAI-compatible base URL.`,
      { status: response.status, body: text.slice(0, 4000) },
    );
  }
  return parseChatCompletionResponse(payload);
}

export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof OpenAiCompatibleRequestError)) return false;
  if (err.status !== null && err.status !== 400 && err.status !== 413 && err.status !== 422) return false;
  const haystack = `${err.message}\n${err.body}`.toLowerCase();
  return (
    haystack.includes("context_length") ||
    haystack.includes("context length") ||
    haystack.includes("context window") ||
    haystack.includes("maximum context") ||
    haystack.includes("too many tokens") ||
    haystack.includes("prompt is too long")
  );
}
