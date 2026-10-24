import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseAgyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventType = asString(parsed.event);

  if (eventType === "init") {
    const conversationId = asString(parsed.conversation_id);
    return [
      {
        kind: "init",
        ts,
        model: "agy",
        sessionId: conversationId,
      },
    ];
  }

  if (eventType === "step_update") {
    const stepUpdate = asRecord(parsed.step_update);
    if (!stepUpdate) return [];

    const stepType = asString(stepUpdate.step_type);

    if (stepType === "agent_response") {
      const entries: TranscriptEntry[] = [];
      const thinking = asString(stepUpdate.thinking);
      if (thinking) {
        entries.push({ kind: "thinking", ts, text: thinking });
      }
      const textDelta = asString(stepUpdate.text_delta);
      if (textDelta) {
        entries.push({ kind: "assistant", ts, text: textDelta, delta: true });
      }
      return entries;
    }

    if (stepType === "tool") {
      const toolName = asString(stepUpdate.tool_name, "tool");
      const toolInfo = asRecord(stepUpdate.tool_info) ?? {};
      // agy identifies tool steps by conversation + step_index, not by the
      // optional ID fields. Fall back to that pair so repeated calls to the
      // same tool stay separate transcript rows instead of merging under the
      // shared tool name.
      const conversationId = asString(stepUpdate.conversation_id);
      const stepIndex = asNumber(stepUpdate.step_index, -1);
      const stepFallback = conversationId && stepIndex >= 0
        ? `${conversationId}:${stepIndex}`
        : stepIndex >= 0
          ? `${toolName}:${stepIndex}`
          : toolName;
      const toolCallId = asString(stepUpdate.tool_call_id || toolInfo.id || toolInfo.tool_use_id, stepFallback);
      const params = asRecord(toolInfo.parameters || toolInfo.input || toolInfo.arguments) ?? {};
      const state = asString(stepUpdate.state);

      const callEntry: TranscriptEntry = {
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId: toolCallId,
        input: params,
      };

      if (state === "ACTIVE") {
        return [callEntry];
      }

      if (state === "DONE") {
        const rawOutput = toolInfo.output;
        const output = typeof rawOutput === "object" && rawOutput !== null
          ? JSON.stringify(rawOutput, null, 2)
          : asString(rawOutput, "done");
        return [
          callEntry,
          {
            kind: "tool_result",
            ts,
            toolUseId: toolCallId,
            content: output,
            isError: false,
          },
        ];
      }

      if (state === "ERROR") {
        const errObj = asRecord(toolInfo.error);
        const errMsg = asString(errObj?.message) || asString(toolInfo.error) || "Tool execution failed";
        return [
          callEntry,
          {
            kind: "tool_result",
            ts,
            toolUseId: toolCallId,
            content: errMsg,
            isError: true,
          },
        ];
      }

      return [callEntry];
    }

    if (stepType === "user_input") {
      return [{ kind: "user", ts, text: "Turn started" }];
    }

    if (stepType === "system_message") {
      return [{ kind: "system", ts, text: "System update" }];
    }
  }

  if (eventType === "result") {
    const resultObj = asRecord(parsed.result);
    if (!resultObj) return [];
    const response = asString(resultObj.response);
    const status = asString(resultObj.status);
    let errorMessage = "";
    for (const key of ["error", "error_message", "errorMessage", "message", "detail"]) {
      const val = asString(resultObj[key]).trim();
      if (val) {
        errorMessage = val;
        break;
      }
    }
    if (!errorMessage) {
      const nested = asRecord(resultObj.error);
      if (nested) {
        for (const key of ["message", "detail", "description"]) {
          const val = asString(nested[key]).trim();
          if (val) {
            errorMessage = val;
            break;
          }
        }
      }
    }
    const isError = Boolean(
      errorMessage ||
        (status && status !== "SUCCESS") ||
        status === "ERROR" ||
        status === "CANCELLED",
    );
    const text = response || errorMessage;
    const errors = isError ? [errorMessage || response || `Run ended with status ${status}`].filter(Boolean) : [];
    const usage = asRecord(resultObj.usage);
    return [
      {
        kind: "result",
        ts,
        text,
        inputTokens: asNumber(usage?.input_tokens, 0),
        outputTokens: asNumber(usage?.output_tokens, 0),
        cachedTokens: asNumber(usage?.cache_read_tokens, 0),
        costUsd: 0,
        subtype: isError ? "error" : "success",
        isError,
        errors,
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}
