/**
 * Provider-agnostic LLM orchestration types.
 *
 * The starter kit never hard-codes a model vendor. A client engagement swaps
 * the concrete {@link LlmProvider} (e.g. FakeChatModel -> OpenAIChatModel)
 * and everything downstream — agents, RAG, evals — keeps working. This is the
 * core "second client is faster than the first" lever: the interface is fixed,
 * only the adapter changes.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** Optional tool call id when role === "tool". */
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments as a JSON string (OpenAI convention). */
  arguments: string;
}

export interface CompletionRequest {
  messages: Message[];
  /** Temperature; providers clamp to their supported range. */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Optional structured tools the model may call. */
  tools?: ToolDefinition[];
  /** When true, force the model to emit a tool call rather than text. */
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /** Arbitrary provider passthrough (e.g. top_p, stop, seed). */
  extra?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the parameters. */
  parameters: Record<string, unknown>;
}

export interface CompletionResponse {
  /** The assistant's text (empty when a tool call was emitted). */
  content: string;
  /** Tool calls emitted by the model, if any. */
  toolCalls: ToolCall[];
  /** Token usage, when the provider reports it. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Which model produced this response (for audit / evals). */
  model: string;
}

/**
 * The single seam every client engagement implements. Deterministic, offline
 * behaviour is guaranteed by {@link FakeChatModel}; production behaviour is
 * provided by a vendor adapter (see openai.ts).
 */
export interface LlmProvider {
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
