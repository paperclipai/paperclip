import { fetchWithTimeout, readClaudeToken } from "./quota.js";
import type { AdapterAuthProbeResult, AdapterAuthProbeStatus } from "@paperclipai/adapter-utils";
import { isAdapterUnhealthy } from "@paperclipai/adapter-utils";

export type { AdapterAuthProbeResult, AdapterAuthProbeStatus };
export { isAdapterUnhealthy };

export type AdapterAuthProbeSource = "api_key" | "oauth" | "bedrock" | "none";

export interface ProbeClaudeAuthOptions {
  /** Override the network fetch (used by tests). */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Override the OAuth token reader (used by tests). */
  readToken?: () => Promise<string | null>;
  /** Override env lookup for ANTHROPIC_API_KEY / Bedrock vars. */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout for the upstream probe in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function detectBedrock(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL)
  );
}

function readRequestId(resp: Response): string | null {
  return resp.headers.get("request-id") ?? resp.headers.get("x-request-id");
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mapResponse(
  resp: Response,
  source: AdapterAuthProbeSource,
  probedAt: string,
): AdapterAuthProbeResult {
  const requestId = readRequestId(resp);
  const base: AdapterAuthProbeResult = {
    status: "transient_error",
    source,
    httpStatus: resp.status,
    probedAt,
    ...(requestId ? { requestId } : {}),
  };
  if (resp.ok) return { ...base, status: "ok" };
  if (resp.status === 401 || resp.status === 403) {
    return { ...base, status: "unauthenticated", detail: `auth probe rejected: HTTP ${resp.status}` };
  }
  if (resp.status === 429) {
    return { ...base, status: "rate_limited", detail: `auth probe rate limited: HTTP ${resp.status}` };
  }
  return { ...base, detail: `auth probe failed: HTTP ${resp.status}` };
}

async function probeViaApiKey(
  apiKey: string,
  fetchImpl: NonNullable<ProbeClaudeAuthOptions["fetchImpl"]>,
  timeoutMs: number,
  probedAt: string,
): Promise<AdapterAuthProbeResult> {
  try {
    const resp = await fetchImpl(ANTHROPIC_MODELS_URL, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    return mapResponse(resp, "api_key", probedAt);
  } catch (err) {
    return {
      status: "transient_error",
      source: "api_key",
      detail: stringifyError(err),
      probedAt,
    };
  }
}

async function probeViaOauth(
  token: string,
  fetchImpl: NonNullable<ProbeClaudeAuthOptions["fetchImpl"]>,
  timeoutMs: number,
  probedAt: string,
): Promise<AdapterAuthProbeResult> {
  try {
    const resp = await fetchImpl(ANTHROPIC_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    return mapResponse(resp, "oauth", probedAt);
  } catch (err) {
    return {
      status: "transient_error",
      source: "oauth",
      detail: stringifyError(err),
      probedAt,
    };
  }
}

/**
 * Single low-cost auth probe for the claude_local adapter.
 *
 * Picks the cheapest endpoint that exercises the credential the adapter would
 * use at runtime:
 *   - `ANTHROPIC_API_KEY` set       → `GET /v1/models?limit=1` with `x-api-key`.
 *   - OAuth/subscription token      → `GET /api/oauth/usage` (already used for quota).
 *   - Bedrock-configured            → returns `ok` without a network call (separate auth path).
 *   - Nothing configured            → returns `no_credentials`.
 *
 * The probe is intentionally stateless — callers decide cache/TTL policy. The
 * result NEVER contains the credential itself; only HTTP status, source, and
 * (when surfaced) the upstream request id for log correlation.
 */
export async function probeClaudeAuth(
  options: ProbeClaudeAuthOptions = {},
): Promise<AdapterAuthProbeResult> {
  const probedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readToken = options.readToken ?? readClaudeToken;
  const fetchImpl =
    options.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, timeoutMs));

  if (detectBedrock(env)) {
    return { status: "ok", source: "bedrock", probedAt };
  }

  const apiKey = isNonEmpty(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY.trim() : null;
  if (apiKey) {
    return probeViaApiKey(apiKey, fetchImpl, timeoutMs, probedAt);
  }

  const token = await readToken();
  if (token) {
    return probeViaOauth(token, fetchImpl, timeoutMs, probedAt);
  }

  return {
    status: "no_credentials",
    source: "none",
    detail: "no ANTHROPIC_API_KEY, OAuth token, or Bedrock config detected",
    probedAt,
  };
}

