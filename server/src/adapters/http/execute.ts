import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

// In-process sliding window: agentId -> recent invocation timestamps
const httpAgentCallHistory = new Map<string, number[]>();

function checkHttpRateGuard(
  agentId: string,
  maxRunsPer60s: number,
): { tripped: boolean; count: number } {
  const now = Date.now();
  const cutoff = now - 60_000;
  const history = (httpAgentCallHistory.get(agentId) ?? []).filter((ts) => ts > cutoff);
  history.push(now);
  httpAgentCallHistory.set(agentId, history);
  return { tripped: history.length > maxRunsPer60s, count: history.length };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  // Run-rate guard: prevent rapid consecutive invocations
  const guardConfig = parseObject(config.paperclipRunGuard);
  const guardEnabled = guardConfig.enabled !== false;
  const maxRunsPer60s = asNumber(guardConfig.maxRunsPer60s, 10);
  if (guardEnabled) {
    const { tripped, count } = checkHttpRateGuard(agent.id, maxRunsPer60s);
    if (tripped) {
      const msg = `[paperclip] Run guard: HTTP agent ${agent.name} rate limit — ${count} invocations in 60s (max ${maxRunsPer60s})`;
      const apiUrl = process.env["PAPERCLIP_API_URL"];
      const token = ctx.authToken ?? process.env["PAPERCLIP_API_KEY"];
      const issueId =
        (typeof context.taskId === "string" ? context.taskId : null) ??
        (typeof context.issueId === "string" ? context.issueId : null) ??
        null;
      if (apiUrl && token && issueId) {
        fetch(`${apiUrl}/api/issues/${issueId}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Paperclip-Run-Id": runId,
          },
          body: JSON.stringify({
            body: `**Run guard: HTTP rate limit on ${agent.name}**\n\n${msg}\n\nRun: ${runId}`,
          }),
        }).catch(() => {});
      }
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: msg,
        errorCode: "run_guard_rate_limit",
      };
    }
  }

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
