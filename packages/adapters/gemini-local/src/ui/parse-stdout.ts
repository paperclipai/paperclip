import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseGeminiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "init") {
    return [
      {
        kind: "init",
        ts,
        model: typeof parsed.model === "string" ? parsed.model : "unknown",
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
      },
    ];
  }

  if (type === "message") {
    const role = typeof parsed.role === "string" ? parsed.role : "";
    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (role === "assistant" && content) {
      return [{ kind: "assistant", ts, text: content }];
    }
    if (role === "user" && content) {
      return [{ kind: "user", ts, text: content }];
    }
    return content ? [{ kind: "stdout", ts, text: content }] : [{ kind: "stdout", ts, text: line }];
  }

  if (type === "tool_use") {
    const name = typeof parsed.tool_name === "string" ? parsed.tool_name : "unknown";
    return [
      {
        kind: "tool_call",
        ts,
        name,
        input: parsed.parameters ?? {},
      },
    ];
  }

  if (type === "tool_result") {
    const toolUseId = typeof parsed.tool_id === "string" ? parsed.tool_id : "";
    const isError = parsed.status === "error";
    const content = typeof parsed.output === "string" ? parsed.output : "";
    return [{ kind: "tool_result", ts, toolUseId, content, isError }];
  }

  if (type === "result") {
    const stats = asRecord(parsed.stats) ?? {};
    const inputTokens = asNumber(stats.input_tokens);
    const outputTokens = asNumber(stats.output_tokens);
    const costUsd = asNumber(parsed.cost_usd);
    const status = typeof parsed.status === "string" ? parsed.status : "";
    const isError = status === "error";
    const errors: string[] = [];
    if (typeof parsed.error === "string" && parsed.error) errors.push(parsed.error);
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return [{
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      costUsd,
      subtype: status,
      isError,
      errors,
    }];
  }

  if (type === "error") {
    const errorMsg = typeof parsed.message === "string" ? parsed.message : (typeof parsed.error === "string" ? parsed.error : line);
    return [{ kind: "stdout", ts, text: errorMsg }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
