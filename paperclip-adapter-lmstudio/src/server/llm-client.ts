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

export async function callChatCompletion(req: CompletionRequest): Promise<CompletionResponse> {
  const response = await fetch(`${req.url}/v1/chat/completions`, {
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

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`LM Studio API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: AssistantMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = data.choices[0]?.message;
  if (!message) throw new Error("No message in response");

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
  const response = await fetch(`${req.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`LM Studio stream error ${response.status}: ${text}`);
  }

  const body = response.body;
  if (!body) throw new Error("No response body");

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
