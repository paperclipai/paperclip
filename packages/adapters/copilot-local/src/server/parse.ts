import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const MAX_EXCERPT_BYTES = 32 * 1024;

/**
 * Parse Copilot CLI JSONL output into a structured result.
 *
 * Copilot JSONL events use a `type` field. Key non-ephemeral events:
 * - session.tools_updated: carries the resolved model name
 * - user.message: user prompt (with transformedContent)
 * - assistant.message: response text + toolRequests[] + outputTokens
 * - tool.execution_start: { toolCallId, toolName, arguments }
 * - tool.execution_complete: { toolCallId, success, result | error }
 * - result: session summary with sessionId, exitCode, usage
 *
 * Error cases (invalid session, auth failure) produce **zero** JSONL on stdout;
 * the error text lands in stderr as plain text.  Always pass stderr to
 * `describeCopilotFailure` and `isCopilotUnknownSessionError`.
 */
export function parseCopilotJsonl(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let resultEvent: Record<string, unknown> | null = null;
  let totalOutputTokens = 0;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const data = parseObject(event.data);

    if (type === "session.tools_updated") {
      model = asString(data.model, model);
      continue;
    }

    if (type === "assistant.message") {
      const content = asString(data.content, "");
      if (content) assistantTexts.push(content);
      const tokens = asNumber(data.outputTokens, 0);
      if (tokens > 0) totalOutputTokens += tokens;
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      sessionId = asString(event.sessionId, sessionId ?? "") || sessionId;
      continue;
    }
  }

  if (!resultEvent) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  sessionId = asString(resultEvent.sessionId, sessionId ?? "") || sessionId;
  const usageObj = parseObject(resultEvent.usage);
  const usage: UsageSummary = {
    inputTokens: 0, // Copilot CLI does not report input tokens
    outputTokens: totalOutputTokens,
  };

  return {
    sessionId,
    model,
    costUsd: null as number | null, // subscription billing — no per-run dollar cost
    usage,
    summary: assistantTexts.join("\n\n").trim(),
    resultJson: resultEvent,
    premiumRequests: asNumber(usageObj.premiumRequests, 0),
    totalApiDurationMs: asNumber(usageObj.totalApiDurationMs, 0),
    sessionDurationMs: asNumber(usageObj.sessionDurationMs, 0),
  };
}

/**
 * Build a human-readable error message from a failed Copilot run.
 *
 * Copilot errors land in **stderr** as plain text (no JSONL).  The JSONL
 * result event only carries exitCode, which is rarely informative alone.
 * Always pass stderr so the caller gets actionable context.
 */
export function describeCopilotFailure(
  parsed: Record<string, unknown> | null,
  stderr: string,
): string | null {
  const exitCode = parsed ? asNumber(parsed.exitCode, -1) : -1;
  if (exitCode === 0) return null;

  // Prefer the first meaningful line from stderr — that's where Copilot puts its errors.
  const stderrLine = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (stderrLine) {
    const excerpt =
      stderrLine.length > MAX_EXCERPT_BYTES
        ? stderrLine.slice(0, MAX_EXCERPT_BYTES - 1) + "…"
        : stderrLine;
    return `Copilot exited with code ${exitCode}: ${excerpt}`;
  }

  return `Copilot exited with code ${exitCode}`;
}

/**
 * Detect whether a Copilot failure was caused by an unknown/invalid session ID.
 *
 * Copilot outputs "No session or task matched '<id>'" to stderr with exit
 * code 1 and **zero JSONL** on stdout when a resume target is unavailable.
 * We must check stderr, not stdout or the parsed result.
 */
export function isCopilotUnknownSessionError(stderr: string): boolean {
  return /no session or task matched|session.*not found|unknown session/i.test(stderr);
}

/**
 * Detect whether Copilot is asking the user to authenticate with GitHub.
 */
export function detectCopilotAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const requiresLogin =
    /not\s+logged\s+in|please\s+log\s+in|login\s+required|authentication\s+required|gh auth login|copilot login/i.test(
      combined,
    );
  return { requiresLogin };
}
