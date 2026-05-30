import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

const ENV_REFERENCE_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SENSITIVE_HTTP_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token)$/i;
const SENSITIVE_HEADER_TEMPLATE_RE = /^(?:Bearer\s+)?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

function interpolateEnvReferences(value: string, env: Record<string, unknown>): string {
  return value.replace(ENV_REFERENCE_RE, (_match, key: string) => {
    const envValue = env[key];
    if (typeof envValue !== "string") {
      throw new Error(`HTTP header references missing environment variable: ${key}`);
    }
    return envValue;
  });
}

function parseHeaders(headersValue: unknown): Record<string, string> {
  const rawHeaders = parseObject(headersValue);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string") {
      throw new Error(`HTTP header ${key} must be a string`);
    }
    if (SENSITIVE_HTTP_HEADER_RE.test(key) && !SENSITIVE_HEADER_TEMPLATE_RE.test(value.trim())) {
      throw new Error(`Sensitive HTTP header ${key} must use an env reference such as \${env:BRIDGE_TOKEN}`);
    }
    headers[key] = value;
  }
  return headers;
}

export function resolveHeaderTemplates(
  headers: Record<string, string>,
  env: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, interpolateEnvReferences(value, env)]),
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseHeaders(config.headers);
  const env = parseObject(config.env);
  const resolvedHeaders = resolveHeaderTemplates(headers, env);
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...resolvedHeaders,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const responseText = await res.text();
    let responseJson: Record<string, unknown> | null = null;
    if (contentType.includes("application/json") && responseText.trim()) {
      const parsed = JSON.parse(responseText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        responseJson = parsed as Record<string, unknown>;
      }
    }

    if (!res.ok) {
      const detail = responseJson?.error ?? responseJson?.message ?? responseText.slice(0, 300);
      throw new Error(`HTTP invoke failed with status ${res.status}${detail ? `: ${String(detail)}` : ""}`);
    }

    const remoteSummary =
      typeof responseJson?.summary === "string" && responseJson.summary.trim().length > 0
        ? responseJson.summary.trim()
        : null;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: remoteSummary ?? `HTTP ${method} ${url}`,
      resultJson: responseJson ?? (responseText ? { responseText } : null),
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
