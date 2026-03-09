import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

const NANOCLAW_DEFAULT_URL = "http://127.0.0.1:18790";
const NANOCLAW_DEFAULT_TIMEOUT_MS = 30_000;

interface WakeupPayload {
  agentId: string;
  runId: string;
  context?: Record<string, unknown>;
}

interface WakeupResponse {
  ok: boolean;
  group?: string;
  error?: string;
}

function resolveBaseUrl(config: Record<string, unknown>): string {
  const url = typeof config.url === "string" ? config.url.trim() : "";
  return url || NANOCLAW_DEFAULT_URL;
}

function resolveAgentId(config: Record<string, unknown>): string {
  const agentName = typeof config.agentName === "string" ? config.agentName.trim() : "";
  const agentId = typeof config.agentId === "string" ? config.agentId.trim() : "";
  return agentId || agentName || "dozer";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const baseUrl = resolveBaseUrl(ctx.config);
  const agentId = resolveAgentId(ctx.config);
  const timeoutMs =
    typeof ctx.config.timeoutMs === "number" ? ctx.config.timeoutMs : NANOCLAW_DEFAULT_TIMEOUT_MS;

  const payload: WakeupPayload = {
    agentId,
    runId: ctx.runId,
    context: {
      ...ctx.context,
    },
  };

  const wakeupUrl = `${baseUrl.replace(/\/+$/, "")}/paperclip/wakeup`;

  await ctx.onLog("stdout", `[nanoclaw-gateway] POST ${wakeupUrl} agentId=${agentId} runId=${ctx.runId}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(wakeupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const body = (await response.json().catch(() => ({}))) as WakeupResponse;

    if (!response.ok) {
      const errorMsg = body.error || `HTTP ${response.status} ${response.statusText}`;
      await ctx.onLog("stderr", `[nanoclaw-gateway] wakeup failed: ${errorMsg}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: errorMsg,
        errorCode: "NANOCLAW_WAKEUP_FAILED",
        summary: `NanoClaw wakeup failed for agent "${agentId}": ${errorMsg}`,
      };
    }

    const group = body.group || agentId;
    await ctx.onLog(
      "stdout",
      `[nanoclaw-gateway] wakeup accepted — agent="${agentId}" group="${group}". Response will be delivered via WhatsApp.\n`,
    );

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `NanoClaw agent "${agentId}" invoked successfully. Output delivered via WhatsApp.`,
      provider: "nanoclaw",
    };
  } catch (err: unknown) {
    clearTimeout(timer);

    if (err instanceof DOMException && err.name === "AbortError") {
      await ctx.onLog("stderr", `[nanoclaw-gateway] wakeup timed out after ${timeoutMs}ms\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Wakeup request timed out after ${timeoutMs}ms`,
        errorCode: "NANOCLAW_TIMEOUT",
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[nanoclaw-gateway] wakeup error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "NANOCLAW_CONNECTION_ERROR",
      summary: `Failed to connect to NanoClaw at ${wakeupUrl}: ${message}`,
    };
  }
}
