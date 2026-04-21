export interface ToolCallInResponse {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCallInResponse[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallInResponse[];
  tool_call_id?: string;
  name?: string;
}

export interface CompletionRequest {
  url: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  timeoutMs: number;
}

export interface CompletionResponse {
  message: AssistantMessage;
  usage?: { inputTokens: number; outputTokens: number };
}

export type LlmErrorKind = "network" | "model" | "timeout" | "unknown";

export class LlmClientError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

function classifyFetchError(err: unknown): LlmClientError {
  if (err instanceof LlmClientError) return err;
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? "";
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      return new LlmClientError("network", `LLM network error: ${code} (${err.message})`, err);
    }
    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      return new LlmClientError("timeout", `LLM call timed out: ${err.message}`, err);
    }
  }
  return new LlmClientError("unknown", `LLM call failed: ${String(err)}`, err);
}

function classifyHttpError(status: number, body: string): LlmClientError {
  if (/model.*not.*found|no.*model.*loaded/i.test(body)) {
    return new LlmClientError(
      "model",
      `LM Studio model error ${status}: ${body || "model not found"}`,
    );
  }
  return new LlmClientError("unknown", `LM Studio API error ${status}: ${body}`);
}

export async function callChatCompletion(req: CompletionRequest): Promise<CompletionResponse> {
  let response: Response;
  try {
    response = await fetch(`${req.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        tool_choice: "auto",
        stream: false,
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw classifyFetchError(err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw classifyHttpError(response.status, text);
  }

  const data = await response.json() as {
    choices: Array<{ message: AssistantMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = data.choices[0]?.message;
  if (!message) throw new LlmClientError("unknown", "No message in response");

  return {
    message,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

export interface StreamRequest {
  url: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  onToken: (token: string) => Promise<void>;
}

export async function streamChatCompletion(req: StreamRequest): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${req.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw classifyFetchError(err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw classifyHttpError(response.status, text);
  }

  const body = response.body;
  if (!body) throw new LlmClientError("unknown", "No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            await req.onToken(token);
          }
        } catch {
          // Skip malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export async function probeEndpoint(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await fetch(`${url}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
        return { ok: false, reason: `timeout after ${timeoutMs}ms` };
      }
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code) {
        return { ok: false, reason: `${code} (${err.message})` };
      }
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: String(err) };
  }
}
