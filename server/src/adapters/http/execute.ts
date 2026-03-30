import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    await onLog("stdout", `[http-adapter] invoking ${method} ${url} runId=${runId}\n`);
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
      await onLog("stderr", `[http-adapter] non-2xx response status=${res.status}\n`);
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    let resultJson: Record<string, unknown> | null = null;
    try {
      const body = await res.json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        resultJson = body as Record<string, unknown>;
      }
    } catch {
      resultJson = null;
    }

    await onLog("stdout", `[http-adapter] success status=${res.status}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
      resultJson,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await onLog("stderr", `[http-adapter] error ${message}\n`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
