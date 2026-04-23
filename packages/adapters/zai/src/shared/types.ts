export interface ZaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ZaiToolCall[];
}

export interface ZaiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ZaiToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ZaiChatRequest {
  model: string;
  messages: ZaiMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ZaiToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  response_format?: { type: "text" | "json_object" };
}

export interface ZaiChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index: number;
    message: ZaiMessage;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

/**
 * Events that the server-side execute emits as JSON lines on stdout.
 * The UI parser reconstructs TranscriptEntry from these.
 */
export type ZaiStdoutEvent =
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_final"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      /** USD cost at Z.AI pay-as-you-go rates (reference even on Coding Plan). Undefined when model not priced. */
      costUsd?: number;
      /** "api" for pay-as-you-go; "subscription_included" when hitting the Coding Plan endpoint. */
      billingType?: "api" | "subscription_included";
    }
  | { kind: "model"; model: string; sessionId: string }
  | { kind: "error"; message: string };

export const ZAI_STDOUT_PREFIX = "[zai:event]";
