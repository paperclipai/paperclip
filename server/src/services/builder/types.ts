import type {
  BuilderMessage,
  BuilderToolDescriptor,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { BuilderProposalStore } from "./proposal-store.js";

/**
 * Internal types shared across the Builder module.
 *
 * Tools call core service functions (NOT raw HTTP), so the runtime context
 * exposes the database handle and the company being operated on. The runner
 * resolves the actor from the calling request and threads it through.
 */

/** Identity of the human/agent that is invoking a Builder turn. */
export interface BuilderActor {
  type: "user" | "agent";
  /** stable identifier (board user id or agent id) used for audit trails */
  id: string;
}

/** Per-call context handed to a tool's `run()` implementation. */
export interface BuilderToolRunContext {
  companyId: string;
  sessionId: string;
  /** Id of the assistant message that emitted this tool call. */
  messageId: string;
  actor: BuilderActor;
  /** DB handle for tools that need to call core services directly. */
  db: Db;
  /** Proposal store, for mutation tools that record a deferred change. */
  proposalStore: BuilderProposalStore;
}

/** Successful tool invocation result. */
export interface BuilderToolRunSuccess {
  ok: true;
  /** Model-visible payload. Should be small + JSON-serialisable. */
  result: unknown;
  /** Optional proposal id when this tool created a deferred mutation. */
  proposalId?: string;
  /** Optional activity-log id for direct mutations. */
  activityId?: string;
}

/** Failure result; never throws past the registry. */
export interface BuilderToolRunFailure {
  ok: false;
  /** Short, model-visible message. Do not include secrets. */
  error: string;
}

export type BuilderToolRunResult = BuilderToolRunSuccess | BuilderToolRunFailure;

/**
 * A registered Builder tool.
 *
 * Implementations MUST call core service functions; never read/write the
 * database directly (so atomic checkout, approval gates, budget hard-stop and
 * activity logging stay intact).
 */
export interface BuilderTool extends BuilderToolDescriptor {
  /**
   * Execute the tool. Caller has already validated `params` against
   * `parametersSchema` so implementations can trust shape; they should still
   * defensively guard untrusted string fields before passing them to services.
   */
  run(
    params: Record<string, unknown>,
    ctx: BuilderToolRunContext,
  ): Promise<BuilderToolRunResult>;
}

// ---------------------------------------------------------------------------
// LLM provider abstraction
// ---------------------------------------------------------------------------

export interface BuilderProviderToolDef {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

export interface BuilderProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Plain text content. May be empty for assistant turns that only emit tool calls. */
  content: string;
  /** Assistant-only: tool calls the model emitted on this turn. */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Tool-role only: id of the tool call this message responds to. */
  toolCallId?: string;
}

export interface BuilderProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Optional provider-reported cost in USD cents (× 100 for fractional). */
  costCents?: number;
}

export interface BuilderProviderResponse {
  /** Free-form assistant text. */
  text: string;
  /** Tool calls the model wants the host to execute. */
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** "stop" if the model is done; "tool_calls" if it wants tools run. */
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: BuilderProviderUsage;
}

export interface BuilderProviderConfig {
  providerType: string;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  extras?: Record<string, unknown>;
}

export interface BuilderProvider {
  type: string;
  chat(input: {
    messages: BuilderProviderMessage[];
    tools: BuilderProviderToolDef[];
    config: BuilderProviderConfig;
    signal?: AbortSignal;
  }): Promise<BuilderProviderResponse>;
}

// ---------------------------------------------------------------------------
// Runner internals (re-exported for tests)
// ---------------------------------------------------------------------------

export interface BuilderRunResult {
  /** All messages persisted on this turn, in sequence order. */
  newMessages: BuilderMessage[];
  /** Aggregate usage across the whole turn. */
  usage: { inputTokens: number; outputTokens: number; costCents: number };
  /** True if the loop hit `maxTurns` without the model finishing. */
  truncated: boolean;
}
