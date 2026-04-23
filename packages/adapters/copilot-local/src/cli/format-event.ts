import pc from "picocolors";

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
  return payload && Object.keys(payload).length > 0 ? payload : record;
}

function eventType(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  return normalizeText(record.type || payload.type).toLowerCase();
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

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const payload = asPayload(parsed);
  const type = eventType(parsed, payload);
  const sessionId = extractSessionId(parsed, payload);

  if (type.startsWith("session.")) {
    if (type === "session.tools_updated") {
      const model = normalizeText(payload.model) || normalizeText(parsed.model);
      if (model) console.log(pc.blue(`model: ${model}`));
    } else if (debug) {
      console.log(pc.gray(type));
    }
    if (sessionId && debug) {
      console.log(pc.blue(`session: ${sessionId}`));
    }
    return;
  }

  if (type === "assistant.turn_start" || type === "assistant.turn_end") {
    if (debug) console.log(pc.gray(type));
    return;
  }

  if (type === "assistant.reasoning") {
    const text = normalizeText(payload.content) || normalizeText(payload.text);
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "assistant.message") {
    const text =
      normalizeText(payload.content) ||
      normalizeText(payload.text) ||
      normalizeText(asRecord(payload.message)?.content);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "tool.execution_start") {
    const toolName = normalizeText(payload.toolName) || normalizeText(payload.name) || "tool";
    const args = payload.arguments ?? payload.input;
    console.log(pc.yellow(`tool_call: ${toolName}`));
    if (args !== undefined && debug) {
      console.log(pc.gray(stringifyUnknown(args)));
    }
    return;
  }

  if (type === "tool.execution_complete") {
    const toolName = normalizeText(payload.toolName) || normalizeText(payload.name) || "tool";
    const success = asBoolean(payload.success, true);
    const result = asRecord(payload.result);
    const content =
      normalizeText(result?.content) ||
      normalizeText(result?.detailedContent) ||
      normalizeText(result?.summary) ||
      normalizeText(payload.message) ||
      stringifyUnknown(result).trim() ||
      `${toolName} ${success ? "completed" : "failed"}`;
    console.log((success ? pc.cyan : pc.red)(`tool_result: ${toolName}${success ? "" : " (error)"}`));
    if (content) console.log((success ? pc.gray : pc.red)(content));
    return;
  }

  if (type === "result") {
    const usage = asRecord(payload.usage) ?? asRecord(parsed.usage);
    const input = asNumber(
      usage?.input_tokens,
      asNumber(usage?.inputTokens, asNumber(usage?.prompt_tokens, asNumber(usage?.promptTokens, 0))),
    );
    const output = asNumber(
      usage?.output_tokens,
      asNumber(
        usage?.outputTokens,
        asNumber(usage?.completion_tokens, asNumber(usage?.completionTokens, 0)),
      ),
    );
    const cached = asNumber(
      usage?.cached_input_tokens,
      asNumber(usage?.cachedInputTokens, 0),
    );
    const cost = asNumber(
      payload.costUsd,
      asNumber(payload.cost_usd, asNumber(payload.cost, asNumber(parsed.costUsd, asNumber(parsed.cost, 0)))),
    );
    const exitCode = asNumber(payload.exitCode, asNumber(parsed.exitCode, 0));
    if (sessionId) console.log(pc.blue(`session: ${sessionId}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    console.log((exitCode === 0 ? pc.blue : pc.red)(`result: exit_code=${exitCode}`));
    return;
  }

  if (type.includes("error")) {
    const error = extractErrorText(payload.error ?? parsed.error ?? payload.message ?? parsed.message);
    if (error) console.log(pc.red(`error: ${error}`));
    return;
  }

  if (debug) console.log(line);
}
