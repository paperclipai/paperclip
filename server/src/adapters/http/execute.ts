import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

function extractPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function normalizeUserId(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(body, "user_id")) {
    return body;
  }

  const userId = body.user_id;
  if (typeof userId === "string" && userId.length > 0 && !userId.startsWith("user_")) {
    return {
      ...body,
      user_id: `user_${userId}`,
    };
  }

  return body;
}

export function isComposioMcpUrl(url: string): boolean {
  const pathname = extractPathname(url);
  return (
    /^\/tool_router\/[^/]+\/mcp\/?$/.test(pathname) ||
    /^\/v3\/mcp\/[^/]+\/mcp\/?$/.test(pathname)
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  if (isComposioMcpUrl(url) && !hasHeader(headers, "accept")) {
    headers.Accept = "application/json, text/event-stream";
  }
  const body = normalizeUserId({ ...payloadTemplate, agentId: agent.id, runId, context });

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
      const cfRay = res.headers.get("cf-ray") ?? "n/a";
      const timestamp = new Date().toISOString();
      const responseBody = await res.text();
      throw new Error(
        `HTTP invoke failed with status ${res.status}, cf-ray: ${cfRay}, timestamp: ${timestamp}, body: ${responseBody}`,
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
