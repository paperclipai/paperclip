import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const AGY_UNKNOWN_SESSION_RE =
  /(?:conversation\s+"[^"]+"\s+not\s+found|no\s+conversation\s+found\s+with\s+id|unknown\s+conversation|session\s+.*not\s+found)/i;

export interface ParsedAgyOutput {
  sessionId: string | null;
  model: string;
  costUsd: number | null;
  usage: UsageSummary | null;
  usageBasis: "per_run" | null;
  summary: string;
  resultJson: Record<string, unknown> | null;
  isError: boolean;
  errorMessage: string | null;
}

export function parseAgyUsage(rawUsage: unknown): UsageSummary | null {
  const obj = parseObject(rawUsage);
  if (Object.keys(obj).length === 0) return null;
  return {
    inputTokens: asNumber(obj.input_tokens, 0),
    outputTokens: asNumber(obj.output_tokens, 0),
    cachedInputTokens: asNumber(obj.cache_read_tokens, 0),
  };
}

export function parseAgyJsonl(stdout: string): ParsedAgyOutput {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  let lastUsage: UsageSummary | null = null;
  let isError = false;
  let errorMessage: string | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.event, "");
    if (eventType === "init") {
      sessionId = asString(event.conversation_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (eventType === "step_update") {
      const stepUpdate = parseObject(event.step_update);
      sessionId = asString(stepUpdate.conversation_id, sessionId ?? "") || sessionId;
      const stepType = asString(stepUpdate.step_type, "");

      if (stepType === "agent_response") {
        const delta = asString(stepUpdate.text_delta, "");
        if (delta) {
          assistantTexts.push(delta);
        }
        if (stepUpdate.usage) {
          const u = parseAgyUsage(stepUpdate.usage);
          if (u) lastUsage = u;
        }
      }

      if (stepType === "tool") {
        const state = asString(stepUpdate.state, "");
        if (state === "ERROR") {
          const toolInfo = parseObject(stepUpdate.tool_info);
          const errorObj = parseObject(toolInfo.error);
          const msg = asString(errorObj.message, "");
          if (msg) errorMessage = msg;
        }
      }
      continue;
    }

    if (eventType === "result") {
      const resultObj = parseObject(event.result);
      finalResult = resultObj;
      sessionId = asString(resultObj.conversation_id, sessionId ?? "") || sessionId;
      const status = asString(resultObj.status, "");
      if (status === "ERROR") {
        isError = true;
      }
      if (resultObj.usage) {
        const u = parseAgyUsage(resultObj.usage);
        if (u) lastUsage = u;
      }
      const response = asString(resultObj.response, "");
      if (response) {
        assistantTexts.length = 0;
        assistantTexts.push(response);
      }
    }
  }

  const summary = assistantTexts.join("").trim() || stdout.trim();

  return {
    sessionId,
    model,
    costUsd: null,
    usage: lastUsage,
    usageBasis: "per_run",
    summary,
    resultJson: finalResult,
    isError,
    errorMessage,
  };
}

export function isAgyUnknownSessionError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const messages = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ];
  return messages.some((message) => AGY_UNKNOWN_SESSION_RE.test(message));
}
