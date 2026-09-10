import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

export const AGY_SUCCESS_STATUS = "SUCCESS";

export interface AgyToolInvocation {
  stepIndex: number;
  name: string;
  parameters: Record<string, unknown> | null;
  output: string | null;
  durationSeconds: number | null;
  completed: boolean;
  isError: boolean;
}

export interface ParsedAgyOutput {
  sessionId: string | null;
  conversationId: string | null;
  model: string;
  status: string | null;
  response: string | null;
  costUsd: number | null;
  usage: UsageSummary | null;
  usageBasis: "per_run" | null;
  thinkingTokens: number | null;
  numTurns: number | null;
  durationSeconds: number | null;
  summary: string;
  resultJson: Record<string, unknown> | null;
  resultEvent: Record<string, unknown> | null;
  isError: boolean;
  errorMessage: string | null;
  tools: AgyToolInvocation[];
  availableTools: string[];
  permissionMode: string | null;
  assistantText: string;
  malformedLines: number;
}

export type AgyParsedStream = ParsedAgyOutput;

export function parseAgyUsage(rawUsage: unknown): {
  usage: UsageSummary;
  thinkingTokens: number | null;
} | null {
  const obj = parseObject(rawUsage);
  if (Object.keys(obj).length === 0) return null;
  const inputTokens = asNumber(obj.input_tokens, 0);
  const outputTokens = asNumber(obj.output_tokens, 0);
  const cachedInputTokens =
    obj.cache_read_tokens !== undefined ? asNumber(obj.cache_read_tokens, 0) : undefined;
  const thinkingTokens =
    obj.thinking_tokens !== undefined ? asNumber(obj.thinking_tokens, 0) : null;
  const usage: UsageSummary = {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
  return { usage, thinkingTokens };
}

function readResultError(result: Record<string, unknown>): string | null {
  for (const key of ["error", "error_message", "errorMessage", "message", "detail"]) {
    const val = asString(result[key], "").trim();
    if (val) return val;
  }
  const nested = parseObject(result.error);
  if (Object.keys(nested).length > 0) {
    for (const key of ["message", "detail", "description"]) {
      const val = asString(nested[key], "").trim();
      if (val) return val;
    }
  }
  return null;
}

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? null;
}

export function parseAgyJsonl(stdout: string): ParsedAgyOutput {
  let sessionId: string | null = null;
  let model = "";
  let status: string | null = null;
  let response: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let finalUsage: UsageSummary | null = null;
  let thinkingTokens: number | null = null;
  let numTurns: number | null = null;
  let durationSeconds: number | null = null;
  let isError = false;
  let errorMessage: string | null = null;
  let permissionMode: string | null = null;
  const availableTools: string[] = [];
  let assistantText = "";
  let malformedLines = 0;

  const toolsByStep = new Map<number, AgyToolInvocation>();
  let lastStepUsage: { usage: UsageSummary; thinkingTokens: number | null } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        malformedLines += 1;
        continue;
      }
    } catch {
      malformedLines += 1;
      continue;
    }

    const eventType = asString(event.event, "");

    if (eventType === "init") {
      const rawConv = asString(event.conversation_id, "");
      if (rawConv) sessionId = rawConv;
      const init = parseObject(event.init);
      if (Array.isArray(init.tools)) {
        for (const t of init.tools) {
          if (typeof t === "string" && t.trim()) availableTools.push(t.trim());
        }
      }
      const perm = asString(init.permission_mode, "");
      if (perm) permissionMode = perm;
      continue;
    }

    if (eventType === "step_update") {
      const stepUpdate = parseObject(event.step_update);
      const rawConv = asString(stepUpdate.conversation_id, "");
      if (rawConv) sessionId = rawConv;

      const parsedStepUsage = parseAgyUsage(stepUpdate.usage);
      if (parsedStepUsage) lastStepUsage = parsedStepUsage;

      const stepType = asString(stepUpdate.step_type, "");
      const state = asString(stepUpdate.state, "");

      if (stepType === "agent_response") {
        const delta = typeof stepUpdate.text_delta === "string" ? stepUpdate.text_delta : "";
        if (delta) assistantText += delta;
      }

      if (stepType === "tool") {
        const stepIndex = asNumber(stepUpdate.step_index, -1);
        if (stepIndex >= 0) {
          const toolInfo = parseObject(stepUpdate.tool_info);
          const name =
            asString(stepUpdate.tool_name, "") ||
            asString(toolInfo.name, "") ||
            "tool";
          const existing = toolsByStep.get(stepIndex);
          const invocation: AgyToolInvocation = existing ?? {
            stepIndex,
            name,
            parameters: null,
            output: null,
            durationSeconds: null,
            completed: false,
            isError: false,
          };
          invocation.name = name;
          if (toolInfo && Object.keys(toolInfo).length > 0) {
            const params = parseObject(toolInfo.parameters);
            if (Object.keys(params).length > 0) invocation.parameters = params;
            const out = asString(toolInfo.output, "");
            if (out) invocation.output = out;
            if (toolInfo.error !== undefined && toolInfo.error !== null) {
              invocation.isError = true;
              const errorObj = parseObject(toolInfo.error);
              const msg = asString(errorObj.message, "");
              if (msg && !errorMessage) errorMessage = msg;
            }
          }
          const dur = asNumber(stepUpdate.duration_seconds, -1);
          if (dur >= 0) invocation.durationSeconds = dur;
          if (state === "DONE") invocation.completed = true;
          toolsByStep.set(stepIndex, invocation);
        }
      }
      continue;
    }

    if (eventType === "result") {
      const resultObj = parseObject(event.result);
      resultEvent = resultObj;
      const rawConv = asString(resultObj.conversation_id, "");
      if (rawConv) sessionId = rawConv;
      status = asString(resultObj.status, "") || null;
      if (status && status !== AGY_SUCCESS_STATUS) {
        isError = true;
      }
      if (resultObj.usage) {
        const parsedResultUsage = parseAgyUsage(resultObj.usage);
        if (parsedResultUsage) {
          finalUsage = parsedResultUsage.usage;
          thinkingTokens = parsedResultUsage.thinkingTokens;
        }
      }
      if (typeof resultObj.response === "string") {
        response = resultObj.response;
      }
      if (resultObj.num_turns !== undefined) {
        numTurns = asNumber(resultObj.num_turns, 0);
      }
      if (resultObj.duration_seconds !== undefined) {
        durationSeconds = asNumber(resultObj.duration_seconds, 0);
      }
      const err = readResultError(resultObj);
      if (err) {
        errorMessage = err;
        isError = true;
      }
    }
  }

  const tools = [...toolsByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex);

  if (!finalUsage && lastStepUsage) {
    finalUsage = lastStepUsage.usage;
    thinkingTokens = lastStepUsage.thinkingTokens;
  }

  const responseText = response ?? assistantText;
  const summary = firstLine(responseText) ?? (responseText.trim() || stdout.trim());

  if (!errorMessage && status !== null && status !== AGY_SUCCESS_STATUS) {
    errorMessage = `agy finished with status ${status}`;
    isError = true;
  }

  return {
    sessionId,
    conversationId: sessionId,
    model,
    status,
    response,
    costUsd: null,
    usage: finalUsage,
    usageBasis: "per_run",
    thinkingTokens,
    numTurns,
    durationSeconds,
    summary,
    resultJson: resultEvent,
    resultEvent,
    isError,
    errorMessage,
    tools,
    availableTools,
    permissionMode,
    assistantText,
    malformedLines,
  };
}

export function isAgySuccessResult(parsed: ParsedAgyOutput): boolean {
  return parsed.status === AGY_SUCCESS_STATUS;
}

export const AUTH_PATTERNS: RegExp[] = [
  /not\s+(?:logged\s?in|authenticated|signed\s?in)/i,
  /please\s+(?:log|sign)\s?in/i,
  /authentication\s+(?:required|failed|error)/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /credentials?\s+(?:not\s+found|missing|expired|invalid)/i,
  /(?:run|use)\s+`?agy\s+(?:login|auth)/i,
  /\b401\b/,
];

export const QUOTA_PATTERNS: RegExp[] = [
  /\bquota\s+(?:exceeded|exhausted)/i,
  /\brate\s?limit(?:ed|s)?\b/i,
  /resource[_\s]exhausted/i,
  /too\s+many\s+requests/i,
  /\b429\b/,
];

export const TRANSIENT_PATTERNS: RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
  /socket\s+hang\s?up/i,
  /network\s+(?:is\s+)?(?:unreachable|error|unavailable)/i,
  /temporarily\s+unavailable/i,
  /connection\s+(?:reset|refused|closed|timed\s?out)/i,
  /\b50[234]\b/,
  /\bUNAVAILABLE\b/,
  /\bDEADLINE_EXCEEDED\b/,
];

export const SESSION_UNRECOVERABLE_PATTERNS: RegExp[] = [
  /conversation[^\n]{0,80}not\s+found/i,
  /(?:unknown|invalid|missing|expired)\s+conversation/i,
  /no\s+such\s+conversation/i,
  /conversation[_\s]not[_\s]found/i,
  /failed\s+to\s+(?:load|resume|open)\s+conversation/i,
  /no\s+conversation\s+found\s+with\s+id/i,
  /session\s+.*not\s+found/i,
];

function matchesAny(patterns: RegExp[], ...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of patterns) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

export function detectAgyAuthRequired(input: {
  stdout?: string | null;
  stderr?: string | null;
  parsed?: ParsedAgyOutput | null;
}): { requiresAuth: boolean } {
  const resultError = input.parsed?.errorMessage ?? null;
  return {
    requiresAuth: matchesAny(AUTH_PATTERNS, input.stdout, input.stderr, resultError),
  };
}

export function detectAgyQuotaExhausted(input: {
  stdout?: string | null;
  stderr?: string | null;
  parsed?: ParsedAgyOutput | null;
}): boolean {
  const resultError = input.parsed?.errorMessage ?? null;
  return matchesAny(QUOTA_PATTERNS, input.stdout, input.stderr, resultError);
}

export function isAgyTransientNetworkError(
  stdout?: string | null,
  stderr?: string | null,
): boolean {
  return matchesAny(TRANSIENT_PATTERNS, stdout, stderr);
}

export function isAgySessionUnrecoverableError(
  stdout?: string | null,
  stderr?: string | null,
): boolean {
  return matchesAny(SESSION_UNRECOVERABLE_PATTERNS, stdout, stderr);
}

export function isAgyUnknownSessionError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  return matchesAny(
    SESSION_UNRECOVERABLE_PATTERNS,
    input.errorMessage,
    input.stdout,
    input.stderr,
  );
}

export function describeAgyFailure(parsed: ParsedAgyOutput): string | null {
  if (parsed.errorMessage) return parsed.errorMessage;
  if (parsed.status !== null && parsed.status !== AGY_SUCCESS_STATUS) {
    return `agy finished with status ${parsed.status}`;
  }
  return null;
}
