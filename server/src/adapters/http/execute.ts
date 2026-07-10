import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abortFromControlPlane = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abortFromControlPlane, { once: true });
  if (ctx.signal?.aborted) abortFromControlPlane();

  try {
    const releaseLaunchPermit = await ctx.acquireLaunchPermit?.();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      releaseLaunchPermit?.();
    } catch (error) {
      releaseLaunchPermit?.();
      throw error;
    }

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
    if (err instanceof Error && err.name === "AbortError") {
      const cancelled = ctx.signal?.aborted === true;
      return {
        exitCode: null,
        signal: null,
        timedOut: !cancelled,
        errorMessage: cancelled
          ? `HTTP ${method} ${url} cancelled by the control plane`
          : `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: cancelled ? "cancelled" : "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abortFromControlPlane);
  }
}
