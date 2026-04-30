import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseJson } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Copilot CLI JSONL event types (--output-format json):
//
//   session.mcp_server_status_changed  — MCP server lifecycle
//   session.mcp_servers_loaded         — all MCP servers connected
//   session.tools_updated              — model resolved, tools ready
//   user.message                       — user prompt echoed
//   assistant.turn_start               — turn begins
//   assistant.message_delta            — streaming text chunk
//   assistant.message                  — complete assistant message
//   assistant.tool_request             — tool call request
//   tool.result                        — tool execution result
//   assistant.turn_end                 — turn ends
//   result                             — final run result with usage
// ---------------------------------------------------------------------------

export interface CopilotParsedStream {
  sessionId: string | null;
  model: string;
  costUsd: number | null;
  usage: UsageSummary | null;
  premiumRequests: number;
  summary: string;
  resultJson: Record<string, unknown> | null;
}

/**
 * Parse the complete JSONL stdout from a Copilot CLI run into a structured
 * result. Each line is an independent JSON object.
 */
export function parseCopilotStreamJson(stdout: string): CopilotParsedStream {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : null;

    if (type === "session.tools_updated" && data) {
      model = asString(data.model, model);
      continue;
    }

    if (type === "assistant.message" && data) {
      const content = asString(data.content, "");
      if (content) assistantTexts.push(content);
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.sessionId, sessionId ?? "") || sessionId;
      continue;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null,
      usage: null,
      premiumRequests: 0,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null,
    };
  }

  const usageObj =
    typeof finalResult.usage === "object" &&
    finalResult.usage !== null &&
    !Array.isArray(finalResult.usage)
      ? (finalResult.usage as Record<string, unknown>)
      : {};

  // Copilot reports premiumRequests rather than raw token counts.
  // We map premiumRequests as best-effort usage — the actual token counts
  // are not exposed in the Copilot CLI JSONL result event.
  const premiumRequests = asNumber(usageObj.premiumRequests, 0);
  const usage: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = assistantTexts.join("\n\n").trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    premiumRequests,
    summary,
    resultJson: finalResult,
  };
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

const AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|requires\s+login|unauthorized|authentication\s+required|copilot\s+login)/i;

const UNKNOWN_SESSION_RE =
  /(?:no (?:conversation|session) found|unknown session|session .* not found)/i;

export function describeCopilotFailure(
  parsed: Record<string, unknown>,
): string | null {
  const exitCode = asNumber(parsed.exitCode, -1);
  if (exitCode === 0) return null;
  return `Copilot CLI exited with code ${exitCode}`;
}

export function detectCopilotLoginRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean } {
  const combined = `${input.stdout}\n${input.stderr}`;
  return { requiresLogin: AUTH_REQUIRED_RE.test(combined) };
}

export function isCopilotUnknownSessionError(input: {
  stdout: string;
  stderr: string;
}): boolean {
  const combined = `${input.stdout}\n${input.stderr}`;
  return UNKNOWN_SESSION_RE.test(combined);
}
