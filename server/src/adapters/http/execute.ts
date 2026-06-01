import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

const DEFAULT_HTTP_ADAPTER_MAX_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, baseMs: number): number {
  const capped = Math.min(baseMs * 2 ** (attempt - 1), 4_000);
  return capped + Math.floor(Math.random() * 250);
}

/**
 * True for a transient transport failure that is safe to retry: the Hermes
 * bridge momentarily refused/reset/closed the connection (worker respawn or a
 * brief network blip between Render and the VPS), so no run was started
 * server-side. `fetch()` surfaces these as `TypeError: fetch failed` with the
 * real error in `.cause`, so we walk the cause chain. A real request timeout
 * (AbortError) is intentionally NOT retryable — that is a long-run signal.
 */
function isRetryableNetworkError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth += 1) {
    if (cur.name === "AbortError") return false;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (/fetch failed|socket hang ?up|terminated|other side closed|connection (closed|reset)/i.test(cur.message)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}


const ENV_REFERENCE_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SENSITIVE_HTTP_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-bridge-token)$/i;
const SENSITIVE_HEADER_TEMPLATE_RE = /^(?:Bearer\s+)?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const PURE_ENV_HEADER_TEMPLATE_RE = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

function isAllowedSensitiveHeaderTemplate(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (/^x-bridge-token$/i.test(key)) return PURE_ENV_HEADER_TEMPLATE_RE.test(trimmed);
  return SENSITIVE_HEADER_TEMPLATE_RE.test(trimmed);
}

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
    if (SENSITIVE_HTTP_HEADER_RE.test(key) && !isAllowedSensitiveHeaderTemplate(key, value)) {
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

  // Bounded retry on TRANSIENT transport failures only (connection drops /
  // 429 / 502 / 503 / 504). The Hermes bridge can briefly 502 or reset the
  // connection when its worker respawns; without this a single blip fails the
  // entire run (adapter_failed). A real request timeout (AbortError) is never
  // retried — that is a long-run signal, not a connection blip.
  const maxAttempts = Math.max(
    1,
    Math.floor(asNumber(config.maxAttempts, DEFAULT_HTTP_ADAPTER_MAX_ATTEMPTS)),
  );
  const retryBackoffMs = Math.max(1, asNumber(config.retryBackoffMs, 400));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let retryFromAttempt: number | null = null;

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
        const message = `HTTP invoke failed with status ${res.status}${detail ? `: ${String(detail)}` : ""}`;
        if (RETRYABLE_HTTP_STATUS.has(res.status) && attempt < maxAttempts) {
          lastError = new Error(message);
          retryFromAttempt = attempt;
        } else {
          throw new Error(message);
        }
      } else {
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
      }
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
      if (isRetryableNetworkError(err) && attempt < maxAttempts) {
        lastError = err;
        retryFromAttempt = attempt;
      } else {
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (retryFromAttempt != null) {
      await sleep(backoffDelayMs(retryFromAttempt, retryBackoffMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`HTTP ${method} ${url} failed after ${maxAttempts} attempts`);
}
