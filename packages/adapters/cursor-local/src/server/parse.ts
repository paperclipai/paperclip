import { stripVTControlCharacters } from "node:util";
import { asString, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";
import { normalizeCursorStreamLine } from "../shared/stream.js";

/** Select diagnostics without mistaking Cursor's trace-file notice for an error. */
export function firstCursorDiagnosticLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripVTControlCharacters(raw).trim();
    if (!line || /^cursor-retrieval: tracing to (?:'[^']*'|"[^"]*")$/.test(line)) continue;
    return line;
  }
  return "";
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function collectAssistantText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const rec = parseObject(message);
  const direct = asString(rec.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(rec.content) ? rec.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text") {
      const text = asString(part.text, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    null
  );
}

export function parseCursorJsonl(stdout: string) {
  return createCursorJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createCursorJsonlParser() {
  let sessionId: string | null = null;
  let sawResult = false;
  let sawLegacyStep = false;
  let usageReported = false;
  let missingUsage = false;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
  let reportedCost = false;
  let missingCost = false;
  const addCost = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      totalCostUsd += value;
      reportedCost = true;
    } else missingCost = true;
  };
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  // Missing counters are not reported zeroes. Preserve earlier valid counts,
  // but never present their partial sum as the complete invocation total.
  const addUsage = (input: unknown, output: unknown, cached: unknown = 0, written: unknown = 0) => {
    const counts = [input, output, cached, written];
    if (!counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
      missingUsage = true;
      return;
    }
    const [inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens] = counts as number[];
    const nextInput = usage.inputTokens + inputTokens + cacheWriteTokens;
    const nextOutput = usage.outputTokens + outputTokens;
    const nextCached = usage.cachedInputTokens + cachedInputTokens;
    if (![nextInput, nextOutput, nextCached].every(Number.isSafeInteger)) {
      missingUsage = true;
      return;
    }
    usage.inputTokens = nextInput;
    usage.outputTokens = nextOutput;
    usage.cachedInputTokens = nextCached;
    usageReported = true;
  };

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = normalizeCursorStreamLine(rawLine).line;
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const foundSession = readSessionId(event);
      if (foundSession) sessionId = foundSession;

      const type = asString(event.type, "").trim();

      if (type === "assistant") {
        messages.push(...collectAssistantText(event.message));
        continue;
      }

      if (type === "result") {
        sawResult = true;
        const usageObj = parseObject(event.usage);
        addUsage(
          usageObj.input_tokens ?? usageObj.inputTokens,
          usageObj.output_tokens ?? usageObj.outputTokens,
          usageObj.cached_input_tokens ?? usageObj.cachedInputTokens ?? usageObj.cache_read_input_tokens,
        );
        addCost(event.total_cost_usd ?? event.cost_usd ?? event.cost);

        const isError = event.is_error === true || asString(event.subtype, "").toLowerCase() === "error";
        const resultText = asString(event.result, "").trim();
        if (resultText && messages.length === 0) {
          messages.push(resultText);
        }
        if (isError) {
          const resultError = asErrorText(event.error ?? event.message ?? event.result).trim();
          if (resultError) errorMessage = resultError;
        }
        continue;
      }

      if (type === "error") {
        const message = asErrorText(event.message ?? event.error ?? event.detail).trim();
        if (message) errorMessage = message;
        continue;
      }

      if (type === "system") {
        const subtype = asString(event.subtype, "").trim().toLowerCase();
        if (subtype === "error") {
          const message = asErrorText(event.message ?? event.error ?? event.detail).trim();
          if (message) errorMessage = message;
        }
        continue;
      }

      // Compatibility with older stream-json shapes.
      if (type === "text") {
        const part = parseObject(event.part);
        const text = asString(part.text, "").trim();
        if (text) messages.push(text);
        continue;
      }

      if (type === "step_finish") {
        sawLegacyStep = true;
        const part = parseObject(event.part);
        const tokens = parseObject(part.tokens);
        const cache = parseObject(tokens.cache);
        addUsage(tokens.input, tokens.output, cache.read, cache.write);
        addCost(part.cost);
        continue;
      }
    }

    return {
      sawResult,
      sawLegacyStep,
      usageReported,
      usageComplete: usageReported && !missingUsage,
      sessionId,
      summary: messages.join("\n\n").trim(),
      usage: { ...usage },
      costUsd: reportedCost && !missingCost ? totalCostUsd : null,
      errorMessage,
    };
  };
}

/** Parse sanitized control records without changing the display/log capture. */
export function parseCursorProcessOutput(output: {
  stdout: string;
  controlOutput?: { stdout: string; stderr: string };
}) {
  return parseCursorJsonl(output.controlOutput?.stdout ?? output.stdout);
}

export function isCursorUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+(session|chat)|session\s+.*\s+not\s+found|chat\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|could\s+not\s+resume/i.test(
    haystack,
  );
}
