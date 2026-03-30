import { parseJson, parseObject, asString, asNumber } from "@paperclipai/adapter-utils/server-utils";

export interface CopilotParsedOutput {
  sessionId: string | null;
  messages: string[];
  errors: string[];
  usage: {
    premiumRequests: number;
    totalApiDurationMs: number;
    sessionDurationMs: number;
  };
  model: string;
  summary: string;
  codeChanges: {
    linesAdded: number;
    linesRemoved: number;
    filesModified: string[];
  } | null;
}

const COPILOT_AUTH_ERROR_RE =
  /no authentication information found|classic personal access tokens \(ghp_\) are not supported|not supported by copilot|copilot login|authenticate with copilot|run.*copilot login/i;

const COPILOT_UNKNOWN_SESSION_RE =
  /session.*not found|unknown session|no session found|invalid session|session does not exist/i;

export function parseCopilotJsonl(stdout: string): CopilotParsedOutput {
  let sessionId: string | null = null;
  let model = "";
  const messages: string[] = [];
  const errors: string[] = [];
  let premiumRequests = 0;
  let totalApiDurationMs = 0;
  let sessionDurationMs = 0;
  let codeChanges: CopilotParsedOutput["codeChanges"] = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const data = parseObject(event.data);

    if (type === "session.tools_updated") {
      const m = asString(data.model, "");
      if (m) model = m;
      continue;
    }

    if (type === "assistant.message") {
      const content = asString(data.content, "");
      if (content) messages.push(content);
      continue;
    }

    if (type === "tool.execution_complete") {
      const success = data.success;
      if (success === false) {
        const result = parseObject(data.result);
        const errContent = asString(result.content, "");
        if (errContent) errors.push(errContent);
      }
      continue;
    }

    if (type === "result") {
      sessionId = asString(event.sessionId, sessionId ?? "") || sessionId;
      const exitCode = asNumber(event.exitCode, 0);
      if (exitCode !== 0) {
        errors.push(`Copilot exited with code ${exitCode}`);
      }
      const usage = parseObject(event.usage);
      premiumRequests = asNumber(usage.premiumRequests, 0);
      totalApiDurationMs = asNumber(usage.totalApiDurationMs, 0);
      sessionDurationMs = asNumber(usage.sessionDurationMs, 0);
      const changes = parseObject(usage.codeChanges);
      if (changes) {
        codeChanges = {
          linesAdded: asNumber(changes.linesAdded, 0),
          linesRemoved: asNumber(changes.linesRemoved, 0),
          filesModified: Array.isArray(changes.filesModified)
            ? changes.filesModified.filter((v): v is string => typeof v === "string")
            : [],
        };
      }
      continue;
    }
  }

  const summary = messages.join("\n\n").trim();

  return {
    sessionId,
    messages,
    errors,
    usage: {
      premiumRequests,
      totalApiDurationMs,
      sessionDurationMs,
    },
    model,
    summary,
    codeChanges,
  };
}

export function isCopilotUnknownSessionError(stdout: string): boolean {
  return COPILOT_UNKNOWN_SESSION_RE.test(stdout);
}

export function isCopilotAuthError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return COPILOT_AUTH_ERROR_RE.test(combined);
}
