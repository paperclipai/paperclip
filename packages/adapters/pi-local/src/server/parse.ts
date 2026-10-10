import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

/** Usage billed to one provider/model; provider/model are null for usage the CLI reported without them. */
export interface PiBilledUsage {
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export interface ParsedPiOutput {
  sawAgentEnd: boolean;
  sessionId: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number | null;
  };
  finalMessage: string | null;
  /** Provider/model of the last assistant message that did not fail; differs from the configured model after a fallback. */
  provider: string | null;
  model: string | null;
  /** Run usage split by the provider/model each turn was billed to; sums to `usage`. Provider/model are null for usage reported without them. */
  billedUsage: PiBilledUsage[];
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown; result: string | null; isError: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

export function parsePiJsonl(stdout: string) {
  return createPiJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createPiJsonlParser() {
  const result: ParsedPiOutput = {
    sawAgentEnd: false,
    sessionId: null,
    messages: [],
    errors: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
    },
    finalMessage: null,
    provider: null,
    model: null,
    billedUsage: [],
    toolCalls: [],
  };

  let missingCost = false;
  function addCost(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result.usage.costUsd = (result.usage.costUsd ?? 0) + value;
    else missingCost = true;
  }
  function addUsage(provider: string | null, model: string | null, usage: Omit<PiBilledUsage, "provider" | "model" | "costUsd">, cost: unknown) {
    result.usage.inputTokens += usage.inputTokens;
    result.usage.outputTokens += usage.outputTokens;
    result.usage.cachedInputTokens += usage.cachedInputTokens;
    addCost(cost);
    let entry = result.billedUsage.find((candidate) => candidate.provider === provider && candidate.model === model);
    if (!entry) {
      entry = { provider, model, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
      result.billedUsage.push(entry);
    }
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.cachedInputTokens += usage.cachedInputTokens;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) entry.costUsd += cost;
  }
  // Assistant-message failures stay provisional until the run ends: a later
  // successful auto_retry_end or retry_fallback_succeeded (an in-run model
  // fallback) means another attempt answered, so the failure no longer fails the run.
  let provisionalErrors: string[] = [];
  const recoveredErrors = new Set<string>();
  let currentToolCall: { toolCallId: string; toolName: string; args: unknown } | null = null;

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const eventType = asString(event.type, "");

      // Pi can exit successfully after a provider failure. The terminal assistant
      // message carries that failure in both message_end and turn_end envelopes.
      const terminalMessages = eventType === "agent_end"
        ? (Array.isArray(event.messages) ? event.messages : [])
        : eventType === "message_end" || eventType === "turn_end"
          ? [event.message]
          : [];
      for (const rawMessage of terminalMessages) {
        const message = asRecord(rawMessage);
        if (message?.role !== "assistant" || message.stopReason !== "error") continue;
        const error = asString(message.errorMessage, "").trim() || "Pi provider request failed.";
        if (eventType === "agent_end" && recoveredErrors.has(error)) continue;
        if (!provisionalErrors.includes(error) && !result.errors.includes(error)) provisionalErrors.push(error);
      }

      if ((eventType === "auto_retry_end" && event.success === true) || eventType === "retry_fallback_succeeded") {
        for (const error of provisionalErrors) recoveredErrors.add(error);
        provisionalErrors = [];
        continue;
      }

      // RPC protocol messages - skip these (internal implementation detail)
      if (eventType === "response" || eventType === "extension_ui_request" || eventType === "extension_ui_response" || eventType === "extension_error") {
        continue;
      }

      // Agent lifecycle
      if (eventType === "agent_start") {
        continue;
      }

      if (eventType === "agent_end") {
        result.sawAgentEnd = true;
        const messages = event.messages as Array<Record<string, unknown>> | undefined;
        if (messages && messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage?.role === "assistant") {
            const content = lastMessage.content as string | Array<{ type: string; text?: string }>;
            result.finalMessage = extractTextContent(content);
          }
        }
        continue;
      }

      if (eventType === "auto_retry_end") {
        const succeeded = event.success === true;
        if (!succeeded) {
          const finalError = asString(event.finalError, "").trim();
          result.errors.push(finalError || "Pi exhausted automatic retries without producing a response.");
        }
        continue;
      }

      // Turn lifecycle
      if (eventType === "turn_start") {
        continue;
      }

      if (eventType === "turn_end") {
        const message = asRecord(event.message);
        if (message) {
          const content = message.content as string | Array<{ type: string; text?: string }>;
          const text = extractTextContent(content);
          if (text) {
            result.finalMessage = text;
            result.messages.push(text);
          }
          if (message.role === "assistant" && message.stopReason !== "error") {
            const provider = asString(message.provider, "").trim();
            const model = asString(message.model, "").trim();
            if (provider && model) {
              result.provider = provider;
              result.model = model;
            }
          }

          // Extract usage and cost from assistant message, billed to the provider/model
          // that produced it (a failed fallback attempt can still be billed).
          const usage = asRecord(message.usage);
          if (usage) {
            const provider = asString(message.provider, "").trim();
            const model = asString(message.model, "").trim();
            // Pi stores cost in usage.cost.total (and broken down in usage.cost.input, etc.)
            const cost = asRecord(usage.cost);
            addUsage(provider && model ? provider : null, provider && model ? model : null, {
              inputTokens: asNumber(usage.input, 0) + asNumber(usage.cacheWrite, 0),
              outputTokens: asNumber(usage.output, 0),
              cachedInputTokens: asNumber(usage.cacheRead, 0),
            }, cost?.total);
          }
        }

        // Tool results are in toolResults array
        const toolResults = event.toolResults as Array<Record<string, unknown>> | undefined;
        if (toolResults) {
          for (const tr of toolResults) {
            const toolCallId = asString(tr.toolCallId, "");
            const content = tr.content;
            const isError = tr.isError === true;

            // Find matching tool call by toolCallId
            const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
            if (existingCall) {
              existingCall.result = typeof content === "string" ? content : JSON.stringify(content);
              existingCall.isError = isError;
            }
          }
        }
        continue;
      }

      // Message updates (streaming)
      if (eventType === "message_update") {
        const assistantEvent = asRecord(event.assistantMessageEvent);
        if (assistantEvent) {
          const msgType = asString(assistantEvent.type, "");
          if (msgType === "text_delta") {
            const delta = asString(assistantEvent.delta, "");
            if (delta) {
              // Append to last message or create new
              if (result.messages.length === 0) {
                result.messages.push(delta);
              } else {
                result.messages[result.messages.length - 1] += delta;
              }
            }
          }
        }
        continue;
      }

      if (eventType === "error") {
        const message = asString(event.message, "").trim();
        if (message) {
          result.errors.push(message);
        }
        continue;
      }

      // Tool execution
      if (eventType === "tool_execution_start") {
        const toolCallId = asString(event.toolCallId, "");
        const toolName = asString(event.toolName, "");
        const args = event.args;
        currentToolCall = { toolCallId, toolName, args };
        result.toolCalls.push({
          toolCallId,
          toolName,
          args,
          result: null,
          isError: false,
        });
        continue;
      }

      if (eventType === "tool_execution_end") {
        const toolCallId = asString(event.toolCallId, "");
        const toolName = asString(event.toolName, "");
        const toolResult = event.result;
        const isError = event.isError === true;

        // Find the tool call by toolCallId (not toolName, to handle multiple calls to same tool)
        const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
        if (existingCall) {
          existingCall.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
          existingCall.isError = isError;
        }
        currentToolCall = null;
        continue;
      }

      // Usage tracking if available in the event (fallback for standalone usage events)
      if (eventType === "usage" || event.usage) {
        const usage = asRecord(event.usage);
        if (usage) {
          // Support both Pi format (input/output/cacheRead) and generic format (inputTokens/outputTokens/cachedInputTokens)
          // Cost may be in usage.costUsd (direct) or usage.cost.total (Pi format)
          const cost = asRecord(usage.cost);
          addUsage(null, null, {
            inputTokens: asNumber(usage.inputTokens ?? usage.input, 0) + asNumber(usage.cacheWrite, 0),
            outputTokens: asNumber(usage.outputTokens ?? usage.output, 0),
            cachedInputTokens: asNumber(usage.cachedInputTokens ?? usage.cacheRead, 0),
          }, cost?.total ?? usage.costUsd);
        }
      }
    }

    if (missingCost) result.usage.costUsd = null;
    // Errors still provisional when this chunk ends are reported without being
    // committed, so a recovery event in a later chunk can still supersede them.
    const errors = [...result.errors, ...provisionalErrors.filter((error) => !result.errors.includes(error))];
    return {
      ...result,
      usage: { ...result.usage },
      messages: [...result.messages],
      errors,
      billedUsage: result.billedUsage.map((entry) => ({ ...entry })),
      toolCalls: [...result.toolCalls],
    };
  };
}

export function isPiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
}
