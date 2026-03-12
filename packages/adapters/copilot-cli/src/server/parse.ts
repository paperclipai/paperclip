import { asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

const COPILOT_AUTH_REQUIRED_RE =
  /not\s+(?:authenticated|logged\s+in)|please\s+(?:authenticate|log\s+in)|gh\s+auth\s+login|github_token\s+(?:required|missing|invalid)|authentication\s+(?:required|failed)|unauthorized|invalid\s+credentials|401/i;

export function detectCopilotAuthRequired(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return COPILOT_AUTH_REQUIRED_RE.test(haystack);
}

export function parseCopilotOutput(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) {
      // Plain text output from gh copilot
      if (line) messages.push(line);
      continue;
    }

    const type = asString(event.type, "");

    if (type === "session.started" || type === "thread.started") {
      sessionId =
        asString(event.session_id, "") ||
        asString(event.thread_id, "") ||
        sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "message" || type === "response") {
      const text = asString(event.text, asString(event.content, "")).trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "usage") {
      usage.inputTokens = typeof event.input_tokens === "number" ? event.input_tokens : usage.inputTokens;
      usage.outputTokens = typeof event.output_tokens === "number" ? event.output_tokens : usage.outputTokens;
      usage.cachedInputTokens =
        typeof event.cached_input_tokens === "number" ? event.cached_input_tokens : usage.cachedInputTokens;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    errorMessage,
  };
}
