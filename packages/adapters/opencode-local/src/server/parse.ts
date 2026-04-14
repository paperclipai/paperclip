import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

interface OpenCodeJsonlParseState {
  sessionId: string | null;
  messages: string[];
  errors: string[];
  toolErrors: string[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  costUsd: number;
}

interface OpenCodeJsonlParseResult {
  sessionId: string | null;
  summary: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  costUsd: number;
  errorMessage: string | null;
  toolErrors: string[];
}

function createOpenCodeJsonlParseState(): OpenCodeJsonlParseState {
  return {
    sessionId: null,
    messages: [],
    errors: [],
    toolErrors: [],
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    costUsd: 0,
  };
}

function processOpenCodeJsonlEvent(state: OpenCodeJsonlParseState, event: Record<string, unknown>): void {
  const currentSessionId = asString(event.sessionID, "").trim();
  if (currentSessionId) state.sessionId = currentSessionId;

  const type = asString(event.type, "");

  if (type === "text") {
    const part = parseObject(event.part);
    const text = asString(part.text, "").trim();
    if (text) state.messages.push(text);
    return;
  }

  if (type === "step_finish") {
    const part = parseObject(event.part);
    const tokens = parseObject(part.tokens);
    const cache = parseObject(tokens.cache);
    state.usage.inputTokens += asNumber(tokens.input, 0);
    state.usage.cachedInputTokens += asNumber(cache.read, 0);
    state.usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
    state.costUsd += asNumber(part.cost, 0);
    return;
  }

  if (type === "tool_use") {
    const part = parseObject(event.part);
    const statePart = parseObject(part.state);
    if (asString(statePart.status, "") === "error") {
      const text = asString(statePart.error, "").trim();
      if (text) state.toolErrors.push(text);
    }
    return;
  }

  if (type === "error") {
    const text = errorText(event.error ?? event.message).trim();
    if (text) state.errors.push(text);
  }
}

function processOpenCodeJsonlLine(state: OpenCodeJsonlParseState, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;

  const event = parseJson(line);
  if (!event) return;
  processOpenCodeJsonlEvent(state, event);
}

function finalizeOpenCodeJsonlParse(state: OpenCodeJsonlParseState): OpenCodeJsonlParseResult {
  return {
    sessionId: state.sessionId,
    summary: state.messages.join("\n\n").trim(),
    usage: state.usage,
    costUsd: state.costUsd,
    errorMessage: state.errors.length > 0 ? state.errors.join("\n") : null,
    toolErrors: state.toolErrors,
  };
}

function parseOpenCodeJsonlText(stdout: string): OpenCodeJsonlParseResult {
  const state = createOpenCodeJsonlParseState();
  for (const rawLine of stdout.split(/\r?\n/)) {
    processOpenCodeJsonlLine(state, rawLine);
  }
  return finalizeOpenCodeJsonlParse(state);
}

async function parseOpenCodeJsonlStream(stdoutStream: AsyncIterable<string>): Promise<OpenCodeJsonlParseResult> {
  const state = createOpenCodeJsonlParseState();
  let buffer = "";

  for await (const chunk of stdoutStream) {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processOpenCodeJsonlLine(state, rawLine);
    }
  }

  if (buffer.trim()) {
    processOpenCodeJsonlLine(state, buffer);
  }

  return finalizeOpenCodeJsonlParse(state);
}

export function parseOpenCodeJsonl(stdout: string): OpenCodeJsonlParseResult;
export function parseOpenCodeJsonl(stdoutStream: AsyncIterable<string>): Promise<OpenCodeJsonlParseResult>;
export function parseOpenCodeJsonl(
  input: string | AsyncIterable<string>,
): OpenCodeJsonlParseResult | Promise<OpenCodeJsonlParseResult> {
  return typeof input === "string" ? parseOpenCodeJsonlText(input) : parseOpenCodeJsonlStream(input);
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
