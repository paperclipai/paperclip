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

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload = asRecord(record.data);
  return payload ?? record;
}

function eventType(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  return normalizeText(record.type || payload.type).toLowerCase();
}

function extractSessionId(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  const direct =
    normalizeText(payload.sessionId) ||
    normalizeText(payload.session_id) ||
    normalizeText(payload.sessionID) ||
    normalizeText(record.sessionId) ||
    normalizeText(record.session_id) ||
    normalizeText(record.sessionID);
  if (direct) return direct;
  const payloadSession = asRecord(payload.session);
  const recordSession = asRecord(record.session);
  return (
    normalizeText(payloadSession?.id) ||
    normalizeText(payloadSession?.sessionId) ||
    normalizeText(recordSession?.id) ||
    normalizeText(recordSession?.sessionId)
  );
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractErrorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  if (!record) return "";
  return (
    normalizeText(record.message) ||
    normalizeText(record.error) ||
    normalizeText(record.code) ||
    stringifyUnknown(value).trim()
  );
}

type CopilotParserState = { pendingModel: string };

function nextCopilotEntries(
  line: string,
  ts: string,
  state: CopilotParserState,
): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const payload = asPayload(parsed);
  const type = eventType(parsed, payload);

  if (type.startsWith("session.")) {
    const model = normalizeText(payload.model) || normalizeText(parsed.model);
    if (model) state.pendingModel = model;
    return [];
  }

  if (type === "assistant.turn_start" || type === "assistant.turn_end") {
    return [];
  }

  if (type === "user.message") {
    const text = normalizeText(payload.content) || normalizeText(parsed.content);
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (type === "assistant.reasoning") {
    const text = normalizeText(payload.content) || normalizeText(payload.text);
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "assistant.message") {
    const text =
      normalizeText(payload.content) ||
      normalizeText(payload.text) ||
      normalizeText(asRecord(payload.message)?.content);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "tool.execution_start") {
    const toolName = normalizeText(payload.toolName) || normalizeText(payload.name) || "tool";
    const toolUseId =
      normalizeText(payload.toolCallId) ||
      normalizeText(payload.tool_use_id) ||
      normalizeText(payload.id) ||
      toolName;
    const input = payload.arguments ?? payload.input ?? {};
    return [{ kind: "tool_call", ts, name: toolName, toolUseId, input }];
  }

  if (type === "tool.execution_complete") {
    const toolName = normalizeText(payload.toolName) || normalizeText(payload.name) || "tool";
    const toolUseId =
      normalizeText(payload.toolCallId) ||
      normalizeText(payload.tool_use_id) ||
      normalizeText(payload.id) ||
      toolName;
    const result = asRecord(payload.result);
    const content =
      normalizeText(result?.content) ||
      normalizeText(result?.detailedContent) ||
      normalizeText(result?.summary) ||
      normalizeText(payload.message) ||
      stringifyUnknown(result).trim() ||
      `${toolName} ${asBoolean(payload.success, true) ? "completed" : "failed"}`;

    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content,
      isError: !asBoolean(payload.success, true),
    }];
  }

  if (type === "result") {
    const usageObj = asRecord(payload.usage) ?? asRecord(parsed.usage);
    const inputTokens = asNumber(
      usageObj?.input_tokens,
      asNumber(usageObj?.inputTokens, asNumber(usageObj?.prompt_tokens, asNumber(usageObj?.promptTokens, 0))),
    );
    const outputTokens = asNumber(
      usageObj?.output_tokens,
      asNumber(
        usageObj?.outputTokens,
        asNumber(usageObj?.completion_tokens, asNumber(usageObj?.completionTokens, 0)),
      ),
    );
    const cachedTokens = asNumber(
      usageObj?.cached_input_tokens,
      asNumber(usageObj?.cachedInputTokens, 0),
    );
    const costUsd = asNumber(
      payload.costUsd,
      asNumber(payload.cost_usd, asNumber(payload.cost, asNumber(parsed.costUsd, asNumber(parsed.cost, 0)))),
    );
    const exitCode = asNumber(payload.exitCode, asNumber(parsed.exitCode, 0));
    const errorText = extractErrorText(payload.error ?? parsed.error ?? payload.message ?? parsed.message);
    const text =
      normalizeText(payload.summary) ||
      normalizeText(parsed.summary) ||
      (exitCode === 0 ? "completed" : "failed");
    const sessionId = extractSessionId(parsed, payload);
    const entries: TranscriptEntry[] = [];
    if (sessionId) {
      const model =
        normalizeText(payload.model) ||
        normalizeText(parsed.model) ||
        state.pendingModel;
      entries.push({
        kind: "init",
        ts,
        model: model || "copilot",
        sessionId,
      });
      state.pendingModel = "";
    }
    entries.push({
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype: exitCode === 0 ? "completed" : "failed",
      isError: exitCode !== 0 || errorText.length > 0,
      errors: errorText ? [errorText] : [],
    });
    return entries;
  }

  if (type.includes("error")) {
    const text = extractErrorText(payload.error ?? parsed.error ?? payload.message ?? parsed.message);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  const legacySummary =
    normalizeText(parsed.summary) ||
    normalizeText(parsed.output_text) ||
    normalizeText(parsed.text);
  if (legacySummary) {
    return [{ kind: "assistant", ts, text: legacySummary }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function createCopilotStdoutParser() {
  const state: CopilotParserState = { pendingModel: "" };
  return {
    parseLine(line: string, ts: string) {
      return nextCopilotEntries(line, ts, state);
    },
    reset() {
      state.pendingModel = "";
    },
  };
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return nextCopilotEntries(line, ts, { pendingModel: "" });
}
