import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

interface ParsedJcodeOutput {
  sessionId: string | null;
  text: string;
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  model: string | null;
  provider: string | null;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown; result: string | null; isError: boolean }>;
}

/**
 * Parse jcode --ndjson streaming output.
 *
 * jcode NDJSON event types:
 * - start: session start marker
 * - connection_phase / connection_type: connection metadata
 * - text_delta: streaming text chunk
 * - text_replace: text replacement
 * - tool_start / tool_input / tool_exec / tool_done: tool lifecycle
 * - tokens: token usage snapshot
 * - done: final event with session_id, model, provider, text, usage
 * - error: error event
 */
export function parseJcodeNdjson(stdout: string): ParsedJcodeOutput {
  const result: ParsedJcodeOutput = {
    sessionId: null,
    text: "",
    errors: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    model: null,
    provider: null,
    toolCalls: [],
  };

  const pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.type, "");

    switch (eventType) {
      case "start":
      case "connection_phase":
      case "connection_type":
        break;

      case "text_delta": {
        const delta = asString(event.delta, "");
        if (delta) result.text += delta;
        break;
      }

      case "text_replace": {
        const replacement = asString(event.text, "");
        if (replacement) result.text = replacement;
        break;
      }

      case "tool_start": {
        const toolCallId = asString(event.tool_call_id, `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const toolName = asString(event.tool_name, "unknown");
        const args = event.args ?? {};
        pendingToolCalls.set(toolCallId, { toolName, args });
        result.toolCalls.push({
          toolCallId,
          toolName,
          args,
          result: null,
          isError: false,
        });
        break;
      }

      case "tool_input": {
        const toolCallId = asString(event.tool_call_id, "");
        const toolInput = event.input;
        const pending = toolCallId ? pendingToolCalls.get(toolCallId) : null;
        if (pending && toolInput !== undefined) {
          pending.args = toolInput;
          const existing = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
          if (existing) existing.args = toolInput;
        }
        break;
      }

      case "tool_exec": {
        const toolCallId = asString(event.tool_call_id, "");
        const toolResult = event.result;
        const isError = event.is_error === true;
        const existing = toolCallId
          ? result.toolCalls.find((tc) => tc.toolCallId === toolCallId)
          : result.toolCalls[result.toolCalls.length - 1];
        if (existing) {
          existing.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
          existing.isError = isError;
        }
        break;
      }

      case "tool_done": {
        const toolCallId = asString(event.tool_call_id, "");
        const isError = event.is_error === true;
        if (toolCallId) pendingToolCalls.delete(toolCallId);
        // tool_done may carry final result for the tool
        const toolResult = event.result;
        if (toolResult !== undefined) {
          const existing = toolCallId
            ? result.toolCalls.find((tc) => tc.toolCallId === toolCallId)
            : result.toolCalls[result.toolCalls.length - 1];
          if (existing) {
            existing.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
            existing.isError = isError;
          }
        }
        break;
      }

      case "tokens": {
        result.usage.inputTokens += asNumber(event.input_tokens, 0);
        result.usage.outputTokens += asNumber(event.output_tokens, 0);
        result.usage.cachedInputTokens += asNumber(event.cache_read_input_tokens, 0);
        break;
      }

      case "done": {
        result.sessionId = asString(event.session_id, result.sessionId ?? "");
        result.model = asString(event.model, result.model ?? "");
        result.provider = asString(event.provider, result.provider ?? "");
        const doneText = asString(event.text, "");
        if (doneText) result.text = doneText;
        const usage = parseObject(event.usage);
        if (usage) {
          result.usage.inputTokens = asNumber(usage.input_tokens, result.usage.inputTokens);
          result.usage.outputTokens = asNumber(usage.output_tokens, result.usage.outputTokens);
          result.usage.cachedInputTokens = asNumber(usage.cache_read_input_tokens, result.usage.cachedInputTokens);
        }
        break;
      }

      case "error": {
        const message = asString(event.message, "").trim();
        if (message) result.errors.push(message);
        break;
      }

      default:
        break;
    }
  }

  return result;
}

export function isJcodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
}
