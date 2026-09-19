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

const SEARCH_TOOL_PATTERNS = /^(grep|glob|rg|find|search|webfetch|web_search|codesearch)/i;
const FILE_WRITE_TOOL_PATTERNS = /^(write|edit|create_file|write_file|str_replace_editor)/i;
const FILE_READ_TOOL_PATTERNS = /^(read|view|cat|head|less|file_read)/i;
const TEST_TOOL_PATTERNS = /^(test|pytest|vitest|jest|mocha|npm\s+test|run_test|run_tests)/i;
const BASH_TOOL_PATTERNS = /^(bash|shell|exec|run_command|terminal|powershell)/i;

function classifyToolName(toolName: string): "search" | "fileWrite" | "fileRead" | "test" | "bash" | "other" {
  if (SEARCH_TOOL_PATTERNS.test(toolName)) return "search";
  if (FILE_WRITE_TOOL_PATTERNS.test(toolName)) return "fileWrite";
  if (FILE_READ_TOOL_PATTERNS.test(toolName)) return "fileRead";
  if (TEST_TOOL_PATTERNS.test(toolName)) return "test";
  if (BASH_TOOL_PATTERNS.test(toolName)) return "bash";
  return "other";
}

export interface OpenCodeTelemetry {
  toolCalls: number;
  failedToolCalls: number;
  retryCount: number;
  searchCalls: number;
  fileReads: number;
  fileWrites: number;
  testCalls: number;
  bashCalls: number;
  timeToFirstWriteMs: number | null;
  timeToFirstTestMs: number | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  stepCount: number;
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  const telemetry: OpenCodeTelemetry = {
    toolCalls: 0,
    failedToolCalls: 0,
    retryCount: 0,
    searchCalls: 0,
    fileReads: 0,
    fileWrites: 0,
    testCalls: 0,
    bashCalls: 0,
    timeToFirstWriteMs: null,
    timeToFirstTestMs: null,
    firstEventAt: null,
    lastEventAt: null,
    stepCount: 0,
  };

  let firstEventTs: number | null = null;
  let firstWriteTs: number | null = null;
  let firstTestTs: number | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");
    const eventTs = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(eventTs)) {
      if (firstEventTs === null) firstEventTs = eventTs;
      telemetry.lastEventAt = new Date(eventTs).toISOString();
    }

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_start") {
      telemetry.stepCount += 1;
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const toolName = asString(part.tool, "tool");
      const state = parseObject(part.state);
      const status = asString(state.status, "");
      const category = classifyToolName(toolName);

      telemetry.toolCalls += 1;
      if (category === "search") telemetry.searchCalls += 1;
      if (category === "fileRead") telemetry.fileReads += 1;
      if (category === "fileWrite") {
        telemetry.fileWrites += 1;
        if (firstWriteTs === null && Number.isFinite(eventTs)) {
          firstWriteTs = eventTs;
        }
      }
      if (category === "test") {
        telemetry.testCalls += 1;
        if (firstTestTs === null && Number.isFinite(eventTs)) {
          firstTestTs = eventTs;
        }
      }
      if (category === "bash") telemetry.bashCalls += 1;

      if (status === "error") {
        telemetry.failedToolCalls += 1;
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  if (firstEventTs !== null) {
    telemetry.firstEventAt = new Date(firstEventTs).toISOString();
  }
  if (firstWriteTs !== null && firstEventTs !== null) {
    telemetry.timeToFirstWriteMs = firstWriteTs - firstEventTs;
  }
  if (firstTestTs !== null && firstEventTs !== null) {
    telemetry.timeToFirstTestMs = firstTestTs - firstEventTs;
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
    telemetry,
  };
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
