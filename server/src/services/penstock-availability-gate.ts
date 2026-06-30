import { randomUUID } from "node:crypto";

export interface PenstockAvailabilityGateLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface PenstockAvailabilityGateOptions {
  fetchImpl?: typeof fetch;
  log: PenstockAvailabilityGateLogger;
  cacheTtlMs?: number;
  timeoutMs?: number;
  defaultRetryDelayMs?: number;
  now?: () => Date;
}

export interface PenstockAvailabilityGateCheckInput {
  adapterType: string;
  agentId: string;
  adapterConfig: unknown;
  now: Date;
  env?: NodeJS.ProcessEnv;
}

export interface PenstockAvailabilityGateAllowResult {
  allow: true;
}

export interface PenstockAvailabilityGateDenyResult {
  allow: false;
  provider: "anthropic";
  reason: "penstock.model_capacity_unavailable" | "penstock.model_temporarily_unavailable";
  model: string;
  resumeAt: Date | null;
  retryAfterSeconds: number | null;
}

export type PenstockAvailabilityGateResult =
  | PenstockAvailabilityGateAllowResult
  | PenstockAvailabilityGateDenyResult;

export interface PenstockAvailabilityGate {
  checkAdapter(input: PenstockAvailabilityGateCheckInput): Promise<PenstockAvailabilityGateResult>;
  _resetForTesting(): void;
}

interface CacheEntry {
  fetchedAt: number;
  result: PenstockAvailabilityGateResult;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

export function createPenstockAvailabilityGate(
  opts: PenstockAvailabilityGateOptions,
): PenstockAvailabilityGate {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultRetryDelayMs = opts.defaultRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const nowFn = opts.now ?? (() => new Date());
  const cache = new Map<string, CacheEntry>();

  return {
    async checkAdapter(input: PenstockAvailabilityGateCheckInput): Promise<PenstockAvailabilityGateResult> {
      if (input.adapterType !== "claude_k8s") return { allow: true };

      const resolved = resolvePenstockAnthropicProbe(input);
      if (!resolved) return { allow: true };

      const nowMs = input.now.getTime();
      const key = `${resolved.url.origin}${resolved.url.pathname}::${resolved.model}`;
      const cached = cache.get(key);
      if (cached && nowMs - cached.fetchedAt < cacheTtlMs) {
        return cached.result;
      }

      const result = await probePenstockAnthropicModel({
        fetchImpl,
        url: resolved.url,
        token: resolved.token,
        model: resolved.model,
        agentId: input.agentId,
        timeoutMs,
        defaultRetryDelayMs,
        now: nowFn,
        log: opts.log,
      });
      cache.set(key, { fetchedAt: nowMs, result });
      return result;
    },
    _resetForTesting() {
      cache.clear();
    },
  };
}

function resolvePenstockAnthropicProbe(
  input: PenstockAvailabilityGateCheckInput,
): { url: URL; token: string; model: string } | null {
  const adapterConfig = asRecord(input.adapterConfig);
  const envConfig = asRecord(adapterConfig?.env);
  const env = input.env ?? process.env;
  const baseUrl =
    readConfigEnvString(envConfig, "ANTHROPIC_BASE_URL") ??
    readProcessEnvString(env, "ANTHROPIC_BASE_URL");
  if (!baseUrl || !isPenstockBaseUrl(baseUrl)) return null;

  const token =
    readConfigEnvString(envConfig, "ANTHROPIC_AUTH_TOKEN") ??
    readConfigEnvString(envConfig, "ANTHROPIC_API_KEY") ??
    readProcessEnvString(env, "ANTHROPIC_AUTH_TOKEN") ??
    readProcessEnvString(env, "ANTHROPIC_API_KEY");
  if (!token || token === "[redacted]") return null;

  const model = readNonEmptyString(adapterConfig?.model);
  if (!model) return null;

  try {
    return {
      url: buildMessagesUrl(baseUrl),
      token,
      model,
    };
  } catch {
    return null;
  }
}

function isPenstockBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.penstock.run" || url.hostname.endsWith(".penstock.run");
  } catch {
    return false;
  }
}

function buildMessagesUrl(baseUrl: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return new URL(`${trimmed}/messages`);
  return new URL(`${trimmed}/v1/messages`);
}

async function probePenstockAnthropicModel(input: {
  fetchImpl: typeof fetch;
  url: URL;
  token: string;
  model: string;
  agentId: string;
  timeoutMs: number;
  defaultRetryDelayMs: number;
  now: () => Date;
  log: PenstockAvailabilityGateLogger;
}): Promise<PenstockAvailabilityGateResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "x-api-key": input.token,
        "x-request-id": `paperclip-penstock-availability-${input.agentId}-${randomUUID()}`,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });

    if (response.status === 429 || response.status === 503) {
      const text = await response.text().catch(() => "");
      const parsed = parseCapacityRetry(text, response.headers, input.defaultRetryDelayMs, input.now());
      if (response.status === 429 && !parsed) {
        input.log.warn(
          {
            status: response.status,
            model: input.model,
          },
          "penstock availability probe saw provider 429 without capacity retry signal; failing open",
        );
        return { allow: true };
      }
      const retry = parsed ?? defaultCapacityRetry(input.defaultRetryDelayMs, input.now());
      const result: PenstockAvailabilityGateDenyResult = {
        allow: false,
        provider: "anthropic",
        reason:
          response.status === 429
            ? "penstock.model_capacity_unavailable"
            : "penstock.model_temporarily_unavailable",
        model: input.model,
        resumeAt: retry.resumeAt,
        retryAfterSeconds: retry.retryAfterSeconds,
      };
      input.log.info(
        {
          status: response.status,
          provider: result.provider,
          model: result.model,
          reason: result.reason,
          resumeAt: result.resumeAt?.toISOString() ?? null,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        "heartbeat dispatch deferred: penstock model unavailable",
      );
      return result;
    }

    if (response.ok) return { allow: true };

    input.log.warn(
      {
        status: response.status,
        model: input.model,
      },
      "penstock availability probe failed open",
    );
    return { allow: true };
  } catch (err) {
    input.log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        model: input.model,
      },
      "penstock availability probe failed open",
    );
    return { allow: true };
  } finally {
    clearTimeout(timeout);
  }
}

function parseCapacityRetry(
  bodyText: string,
  headers: Headers,
  defaultRetryDelayMs: number,
  now: Date,
): { resumeAt: Date | null; retryAfterSeconds: number | null } | null {
  const message = readErrorMessage(bodyText);
  const retryAfterHeader = headers.get("retry-after");
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
  const bodyReset = parseCapacityResetIso(message);
  if (bodyReset && bodyReset.getTime() > now.getTime()) {
    return { resumeAt: bodyReset, retryAfterSeconds };
  }
  if (retryAfterSeconds !== null) {
    return {
      resumeAt: new Date(now.getTime() + retryAfterSeconds * 1000),
      retryAfterSeconds,
    };
  }
  if (isPenstockCapacityBody(bodyText, message)) return defaultCapacityRetry(defaultRetryDelayMs, now);
  return null;
}

function defaultCapacityRetry(
  defaultRetryDelayMs: number,
  now: Date,
): { resumeAt: Date; retryAfterSeconds: number } {
  return {
    resumeAt: new Date(now.getTime() + defaultRetryDelayMs),
    retryAfterSeconds: Math.ceil(defaultRetryDelayMs / 1000),
  };
}

function isPenstockCapacityBody(bodyText: string, message: string): boolean {
  if (/all subscriptions .*rate-limited/i.test(message)) return true;
  if (/capacity resets at /i.test(message)) return true;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const record = asRecord(parsed);
    return readNonEmptyString(record?.code) === "capacity_retry_exhausted";
  } catch {
    return false;
  }
}

function readErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const record = asRecord(parsed);
    return readNonEmptyString(record?.error) ?? readNonEmptyString(record?.message) ?? bodyText;
  } catch {
    return bodyText;
  }
}

function parseCapacityResetIso(message: string): Date | null {
  const match = /capacity resets at ([0-9T:.\-+Z]+)/i.exec(message);
  if (!match?.[1]) return null;
  const time = Date.parse(match[1]);
  if (!Number.isFinite(time)) return null;
  return new Date(time);
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  const delta = Math.ceil((parsedDate - Date.now()) / 1000);
  return delta > 0 ? delta : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readConfigEnvString(envConfig: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!envConfig) return null;
  const value = envConfig[key];
  const direct = readNonEmptyString(value);
  if (direct) return direct;
  const nested = asRecord(value);
  return readNonEmptyString(nested?.value);
}

function readProcessEnvString(env: NodeJS.ProcessEnv, key: string): string | null {
  return readNonEmptyString(env[key]);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
