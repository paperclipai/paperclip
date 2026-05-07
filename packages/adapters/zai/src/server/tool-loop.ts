import type { ToolDefinition } from "@paperclipai/mcp-server";
import type {
  ZaiChatRequest,
  ZaiChatResponse,
  ZaiMessage,
  ZaiStdoutEvent,
  ZaiToolCall,
} from "../shared/types.js";
import { dispatchToolCall, stringifyToolResult } from "./tool-dispatch.js";
import { consumeSseStream } from "./streaming.js";

export interface ZaiAccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ZaiToolLoopResult {
  /** The final ZaiChatResponse — the one without tool_calls. */
  finalResponse: ZaiChatResponse;
  /** Sum of usage across every turn. */
  totalUsage: ZaiAccumulatedUsage;
  /** Total turns executed (1-based). */
  turns: number;
  /** True if we hit maxTurns before the model produced a clean response. */
  exhausted: boolean;
}

export interface ZaiToolLoopInput {
  baseUrl: string;
  apiKey: string;
  /** The base request shape — messages will be mutated across turns. */
  baseRequest: Omit<ZaiChatRequest, "stream" | "messages">;
  initialMessages: ZaiMessage[];
  /** Hard cap on turns (a turn = one round-trip to Z.AI). */
  maxTurns: number;
  /** Total budget across the whole loop. */
  timeoutMs: number;
  toolsByName: Map<string, ToolDefinition>;
  /**
   * If true, stream the FINAL turn (the one without tool_calls) so the user
   * sees deltas. Intermediate turns are always non-streamed because tool_call
   * arguments need to be fully assembled before dispatch.
   */
  streamFinalTurn: boolean;
  onEvent: (event: ZaiStdoutEvent) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

function emptyUsage(): ZaiAccumulatedUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function accumulateUsage(into: ZaiAccumulatedUsage, response: ZaiChatResponse): void {
  const u = response.usage;
  if (!u) return;
  if (typeof u.prompt_tokens === "number") into.inputTokens += u.prompt_tokens;
  if (typeof u.completion_tokens === "number") into.outputTokens += u.completion_tokens;
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") into.cachedInputTokens += cached;
}

function extractMessage(response: ZaiChatResponse): ZaiMessage | null {
  const choice = response.choices?.[0];
  return choice?.message ?? null;
}

function extractToolCalls(response: ZaiChatResponse): ZaiToolCall[] {
  return extractMessage(response)?.tool_calls ?? [];
}

function extractContent(response: ZaiChatResponse): string {
  const content = extractMessage(response)?.content;
  return typeof content === "string" ? content : "";
}

async function callZaiOnce(args: {
  baseUrl: string;
  apiKey: string;
  request: ZaiChatRequest;
  signal: AbortSignal;
  onEvent: (event: ZaiStdoutEvent) => Promise<void>;
  emitDeltas: boolean;
}): Promise<ZaiChatResponse> {
  const res = await fetch(`${args.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      Accept: args.request.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(args.request),
    signal: args.signal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const message = `Z.AI HTTP ${res.status}: ${errorText.slice(0, 500)}`;
    throw new ZaiHttpError(message, res.status);
  }

  if (args.request.stream && res.body) {
    // Only emit assistant deltas when the caller explicitly wants them
    // (i.e., the final turn). For intermediate turns we still consume the
    // stream to get the assembled tool_calls but suppress deltas.
    return consumeSseStream(res.body, args.emitDeltas ? args.onEvent : async () => {});
  }
  return (await res.json()) as ZaiChatResponse;
}

export class ZaiHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ZaiHttpError";
    this.status = status;
  }
}

/**
 * Run the agentic loop:
 *   1. Send messages to Z.AI.
 *   2. If the response has tool_calls, dispatch each one against the catalog,
 *      append assistant + tool messages, repeat.
 *   3. If the response has no tool_calls, that's the final response — return it.
 *   4. Bail out at maxTurns.
 *
 * One global timeout (timeoutMs) covers the whole loop.
 *
 * The caller is responsible for emitting `assistant_final` and `usage` events
 * AFTER the loop returns, using the result's finalResponse and totalUsage.
 */
export async function runZaiToolLoop(input: ZaiToolLoopInput): Promise<ZaiToolLoopResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const totalUsage = emptyUsage();
  let messages = [...input.initialMessages];
  let lastResponse: ZaiChatResponse | null = null;
  let exhausted = false;
  let turns = 0;

  try {
    for (let turn = 0; turn < input.maxTurns; turn++) {
      turns = turn + 1;
      const isFinalAttempt = turn === input.maxTurns - 1;
      // We can't know up-front whether THIS turn is the final one (no tool_calls)
      // because that depends on the response. Strategy: never stream during the
      // loop; the caller streams only after we return by replaying assistant_final.
      // The single exception is the configured streamFinalTurn flag, but since we
      // don't know which turn is final, the safe thing is to stream every turn's
      // text BUT only emit assistant_delta for the LAST turn (after we know it's
      // tool-free). We achieve that by buffering: we always non-stream here, and
      // the caller emits assistant_delta(s) of finalResponse content after.
      const stream = false;
      const request: ZaiChatRequest = {
        ...input.baseRequest,
        messages,
        stream,
      };

      await input.onLog(
        "stdout",
        `[zai/loop] turn ${turn + 1}/${input.maxTurns} messages=${messages.length} tools=${request.tools?.length ?? 0}\n`,
      );

      const response = await callZaiOnce({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        request,
        signal: controller.signal,
        onEvent: input.onEvent,
        emitDeltas: false,
      });
      lastResponse = response;
      accumulateUsage(totalUsage, response);

      const toolCalls = extractToolCalls(response);
      if (toolCalls.length === 0) {
        await input.onLog("stdout", `[zai/loop] final turn=${turn + 1} usage=${JSON.stringify(totalUsage)}\n`);
        return { finalResponse: response, totalUsage, turns, exhausted: false };
      }

      if (isFinalAttempt) {
        // We have tool_calls AND we're out of budget. Treat as exhausted and let the caller surface this.
        exhausted = true;
        await input.onLog(
          "stderr",
          `[zai/loop] exhausted maxTurns=${input.maxTurns} with ${toolCalls.length} pending tool_calls — aborting loop\n`,
        );
        break;
      }

      // Append the assistant turn (with tool_calls) so the next turn includes it.
      const assistantMessage = extractMessage(response);
      messages.push({
        role: "assistant",
        content: assistantMessage?.content ?? null,
        tool_calls: toolCalls,
      });

      // Dispatch each tool call sequentially. (Could be parallel, but sequential
      // gives deterministic ordering in transcripts and avoids hammering the API
      // with parallel writes — agents typically issue 1-3 calls per turn.)
      for (const call of toolCalls) {
        const parsedInput = (() => {
          if (!call.function.arguments) return {};
          try {
            return JSON.parse(call.function.arguments);
          } catch {
            return { _rawArguments: call.function.arguments };
          }
        })();
        await input.onEvent({ kind: "tool_call", id: call.id, name: call.function.name, input: parsedInput });

        const result = await dispatchToolCall({ toolsByName: input.toolsByName, call });

        await input.onLog(
          result.ok ? "stdout" : "stderr",
          `[zai/tool] ${call.function.name} ${result.ok ? "ok" : `error(${result.code})`} elapsed_ms=${result.elapsedMs}${result.ok ? "" : ` message=${JSON.stringify(result.message)}`}\n`,
        );
        await input.onEvent({
          kind: "tool_result",
          id: call.id,
          name: call.function.name,
          ok: result.ok,
          ...(result.ok ? { output: result.output } : { error: { code: result.code, message: result.message } }),
          elapsedMs: result.elapsedMs,
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyToolResult(result),
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // Reached only when exhausted with pending tool_calls.
  return {
    finalResponse: lastResponse ?? {
      choices: [],
    },
    totalUsage,
    turns,
    exhausted,
  };
}
