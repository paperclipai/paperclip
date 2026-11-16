function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorText(event: Record<string, unknown>): string {
  for (const value of [event.message, event.error, event.detail, event.data]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    const nested = asRecord(value);
    if (nested) {
      const text = str(nested.message) || str(nested.error) || str(nested.detail) || str(nested.code);
      if (text.trim()) return text.trim();
    }
  }
  return "";
}

export interface ParsedDistillRun {
  sessionId: string | null;
  stopReason: string | null;
  requestId: string | null;
  errorMessage: string | null;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  primaryModel: string | null;
  sawEnd: boolean;
}

export function parseDistillJsonl(stdout: string): ParsedDistillRun {
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let requestId: string | null = null;
  let errorMessage: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let modelUsage: Record<string, unknown> | null = null;
  let costUsd: number | null = null;
  const textParts: string[] = [];
  const running = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, seen: false };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const event = parseLine(line);
    if (!event) continue;
    const type = str(event.type);

    if (type === "text") {
      const text = str(event.data);
      if (text) textParts.push(text);
    } else if (type === "usage") {
      const messageUsage = asRecord(event.usage);
      if (messageUsage) {
        running.input += num(messageUsage.input_tokens);
        running.output += num(messageUsage.output_tokens);
        running.cacheRead += num(messageUsage.cache_read_input_tokens);
        running.cacheWrite += num(messageUsage.cache_creation_input_tokens);
        running.seen = true;
      }
    } else if (type === "end") {
      sessionId = str(event.sessionId).trim() || sessionId;
      stopReason = str(event.stopReason).trim() || stopReason;
      requestId = str(event.requestId).trim() || requestId;
      usage = asRecord(event.usage) ?? usage;
      modelUsage = asRecord(event.modelUsage) ?? modelUsage;
      if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)) {
        costUsd = event.total_cost_usd;
      }
    } else if (type === "error") {
      const text = errorText(event);
      if (text) errorMessage = text;
    }
  }

  const fromRunning = usage === null && running.seen;
  const cacheRead = fromRunning ? running.cacheRead : num(usage?.cache_read_input_tokens);
  const cacheWrite = fromRunning ? running.cacheWrite : num(usage?.cache_creation_input_tokens);
  const uncachedInput = fromRunning ? running.input : num(usage?.input_tokens);
  const outputTokens = fromRunning ? running.output : num(usage?.output_tokens);

  let primaryModel: string | null = null;
  if (modelUsage) {
    let best = -1;
    for (const [name, value] of Object.entries(modelUsage)) {
      const entry = asRecord(value);
      const weight =
        num(entry?.inputTokens) +
        num(entry?.outputTokens) +
        num(entry?.cacheReadInputTokens) +
        num(entry?.cacheCreationInputTokens);
      if (weight > best) {
        best = weight;
        primaryModel = name;
      }
    }
  }

  return {
    sessionId,
    stopReason,
    requestId,
    errorMessage,
    summary: textParts.join("").trim(),
    inputTokens: uncachedInput + cacheWrite,
    outputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd,
    primaryModel,
    sawEnd: usage !== null || sessionId !== null,
  };
}

export function isDistillUnknownSessionError(stdout: string, stderr: string): boolean {
  return /session does not exist|unknown\s+session|session(?:\s+.*)?\s+not\s+found|no\s+session\s+found|invalid\s+session/i.test(
    `${stdout}\n${stderr}`,
  );
}

export function parseDistillModelsOutput(stdout: string): { defaultModel: string | null; models: string[] } {
  const ids: string[] = [];
  let defaultModel: string | null = null;
  let inList = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const def = /^Default model:\s*(.+)$/i.exec(line);
    if (def) {
      defaultModel = def[1]!.trim();
      continue;
    }
    if (/^Available models:/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const bullet = /^[*-]\s+(\S+)(?:\s+\(default\))?$/.exec(line);
    if (bullet) ids.push(bullet[1]!);
  }
  return { defaultModel, models: Array.from(new Set(ids)) };
}

export type DistillRuntimeEvent = {
  eventType: string;
  message?: string;
  payload: Record<string, unknown>;
};

// Live status for Paperclip's issue thread: maps stdout lines to `onEvent` payloads.
// Streamed text arrives as tiny deltas, so it is kept as a rolling tail and emitted at most
// once per `textIntervalMs`.
export function createRuntimeEventExtractor({
  textIntervalMs = 2000,
  tailChars = 300,
  now = Date.now,
}: { textIntervalMs?: number; tailChars?: number; now?: () => number } = {}) {
  let buffer = "";
  let tail = "";
  let tailType = "";
  let lastTextAt = 0;

  const textEvent = (): DistillRuntimeEvent[] => {
    const text = tail.replace(/\s+/g, " ").trim();
    tail = "";
    if (!text) return [];
    lastTextAt = now();
    return [{ eventType: tailType, message: text, payload: { text } }];
  };

  const handle = (raw: string): DistillRuntimeEvent[] => {
    const event = parseLine(raw.trim());
    if (!event) return [];
    const type = str(event.type);
    if (type === "text" || type === "thought") {
      const data = str(event.data);
      if (!data) return [];
      const eventType = type === "text" ? "assistant" : "thinking";
      const out = tailType && tailType !== eventType ? textEvent() : [];
      tailType = eventType;
      tail = (tail + data).slice(-tailChars);
      return now() - lastTextAt >= textIntervalMs ? out.concat(textEvent()) : out;
    }
    if (type === "tool_call") {
      const toolName = str(event.toolName) || str(event.title);
      return toolName ? textEvent().concat({ eventType: "tool_call", payload: { toolName } }) : [];
    }
    return [];
  };

  return {
    push(chunk: string): DistillRuntimeEvent[] {
      buffer += chunk;
      const events: DistillRuntimeEvent[] = [];
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        events.push(...handle(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
      return events;
    },
    flush(): DistillRuntimeEvent[] {
      const events = buffer.trim() ? handle(buffer) : [];
      buffer = "";
      return events.concat(textEvent());
    },
  };
}
