import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const COPILOT_DANGEROUS_SHELL_BLOCK_RE =
  /command blocked: contains dangerous shell expansion patterns|dangerous shell expansion patterns|parameter transformation|indirect expansion|nested command substitution|arbitrary code execution/i;
const COPILOT_APPROVAL_NEEDED_RE =
  /(^|\n)\*?\*?approval needed:|\breply\s+\*?\*?approve\*?\*?\b|\bor\s+\*?\*?deny\*?\*?\b/i;
const COPILOT_RATE_LIMIT_RE = /\brate[_ -]?limit\b|too many requests|status\s*code\s*[:=]?\s*429|\b429\b/i;

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = parseObject(value);
  const message =
    asString(record.content, "") ||
    asString(record.detailedContent, "") ||
    asString(record.message, "") ||
    asString(record.error, "") ||
    asString(record.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(record);
  } catch {
    return "";
  }
}

export function parseCopilotJsonl(stdout: string) {
  let sessionId: string | null = null;
  let model: string | null = null;
  let errorMessage: string | null = null;
  let errorType: string | null = null;
  let statusCode: number | null = null;
  let blockedDangerousShellCommand: string | null = null;
  let premiumRequests: number | null = null;
  let outputTokens = 0;
  let finalResult: Record<string, unknown> | null = null;
  const messages: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "").trim();
    const data = parseObject(event.data);

    if (type === "session.tools_updated") {
      model = asString(data.model, model ?? "") || model;
      continue;
    }

    if (type === "assistant.message") {
      const content = asString(data.content, "").trim();
      if (content) messages.push(content);
      outputTokens += asNumber(data.outputTokens, 0);
      continue;
    }

    if (type === "tool.execution_complete") {
      const toolModel = asString(data.model, "").trim();
      if (toolModel) model = toolModel;
      if (data.success === false) {
        const text = readText(data.result ?? data.error).trim();
        if (text) {
          if (COPILOT_DANGEROUS_SHELL_BLOCK_RE.test(text)) {
            blockedDangerousShellCommand = text;
          } else {
            errorMessage = text;
          }
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId =
        asString(event.sessionId, "").trim() ||
        asString(event.session_id, "").trim() ||
        sessionId;
      const usage = parseObject(event.usage);
      const premium = usage.premiumRequests;
      if (typeof premium === "number" && Number.isFinite(premium)) {
        premiumRequests = premium;
      }
      continue;
    }

    if (type === "error" || type === "session.error") {
      const text = readText(data.error ?? data.message ?? data.detail).trim();
      const nextErrorType = asString(data.errorType, "").trim();
      const nextStatusCode = asNumber(data.statusCode, NaN);
      if (nextErrorType) errorType = nextErrorType;
      if (Number.isFinite(nextStatusCode)) statusCode = nextStatusCode;
      if (text) errorMessage = text;
    }
  }

  const summary = messages.join("\n\n").trim();
  const approvalRequired =
    blockedDangerousShellCommand != null && summary.length > 0 && COPILOT_APPROVAL_NEEDED_RE.test(summary);
  if (approvalRequired) {
    errorMessage = null;
  } else if (!errorMessage && blockedDangerousShellCommand) {
    errorMessage = blockedDangerousShellCommand;
  }

  return {
    sessionId,
    summary,
    errorMessage,
    errorType,
    statusCode,
    isRateLimit:
      errorType === "rate_limit" ||
      statusCode === 429 ||
      (errorMessage ? COPILOT_RATE_LIMIT_RE.test(errorMessage) : false),
    model,
    outputTokens,
    premiumRequests,
    approvalRequired,
    finalResult,
  };
}

export function isCopilotUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|failed\s+to\s+resume|resume\s+.*\s+not\s+found/i.test(
    haystack,
  );
}

const COPILOT_AUTH_REQUIRED_RE =
  /(?:\/login|not\s+logged\s+in|authenticate|authentication\s+required|copilot\s+subscription|copilot\s+requests|copilot\s+plan|failed\s+to\s+authenticate)/i;

export function detectCopilotAuthRequired(input: { stdout: string; stderr: string }): { requiresAuth: boolean } {
  const messages = `${input.stdout}\n${input.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    requiresAuth: messages.some((line) => COPILOT_AUTH_REQUIRED_RE.test(line)),
  };
}
