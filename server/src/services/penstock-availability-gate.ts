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

interface ResolvedPenstockAnthropicCheck {
  capacityUrl: URL;
  messagesUrl: URL;
  token: string;
  model: string;
}

type PenstockCapacityState = "available" | "rate_limited" | "exhausted" | "unknown";

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

      const resolved = resolvePenstockAnthropicCheck(input);
      if (!resolved) return { allow: true };

      const nowMs = input.now.getTime();
      const key = `${resolved.capacityUrl.origin}${resolved.capacityUrl.pathname}::anthropic::${resolved.model}`;
      const cached = cache.get(key);
      if (cached && nowMs - cached.fetchedAt < cacheTtlMs) {
        return cached.result;
      }

      const readback = await readPenstockAnthropicCapacity({
        fetchImpl,
        url: resolved.capacityUrl,
        token: resolved.token,
        model: resolved.model,
        agentId: input.agentId,
        timeoutMs,
        defaultRetryDelayMs,
        now: nowFn,
        log: opts.log,
      });
      const result =
        readback ??
        (await probePenstockAnthropicModel({
          fetchImpl,
          url: resolved.messagesUrl,
          token: resolved.token,
          model: resolved.model,
          agentId: input.agentId,
          timeoutMs,
          defaultRetryDelayMs,
          now: nowFn,
          log: opts.log,
        }));
      cache.set(key, { fetchedAt: nowMs, result });
      return result;
    },
    _resetForTesting() {
      cache.clear();
    },
  };
}

function resolvePenstockAnthropicCheck(
  input: PenstockAvailabilityGateCheckInput,
): ResolvedPenstockAnthropicCheck | null {
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
      capacityUrl: buildCapacityUrl(baseUrl, model),
      messagesUrl: buildMessagesUrl(baseUrl),
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

function buildCapacityUrl(baseUrl: string, model: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/v1/pools/default/capacity";
  url.search = "";
  url.searchParams.set("provider", "anthropic");
  url.searchParams.set("model", model);
  url.hash = "";
  return url;
}

async function readPenstockAnthropicCapacity(input: {
  fetchImpl: typeof fetch;
  url: URL;
  token: string;
  model: string;
  agentId: string;
  timeoutMs: number;
  defaultRetryDelayMs: number;
  now: () => Date;
  log: PenstockAvailabilityGateLogger;
}): Promise<PenstockAvailabilityGateResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "x-api-key": input.token,
        "x-request-id": `paperclip-penstock-capacity-${input.agentId}-${randomUUID()}`,
      },
      signal: controller.signal,
    });

    if (response.status === 404) return null;

    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 503) {
      return capacityEndpointUnavailable(input, response.status);
    }

    if (!response.ok) {
      input.log.warn(
        {
          status: response.status,
          model: input.model,
        },
        "penstock capacity readback failed open",
      );
      return null;
    }

    const body = await response.json().catch(() => null);
    const state = readCapacityState(body);
    if (!state) return null;
    const capacityReason = readCapacityReason(body);
    if (state === "unknown") {
      if (!isAuthoritativeCapacityReason(capacityReason)) return null;
      return capacityEndpointUnavailable(input, response.status, {
        capacityState: state,
        capacityReason,
      });
    }
    if (state === "available") return { allow: true };

    const now = input.now();
    const retry = capacityRetryFromBody(body, input.defaultRetryDelayMs, now);
    const result: PenstockAvailabilityGateDenyResult = {
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
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
        capacityState: state,
        capacityReason,
        resumeAt: result.resumeAt?.toISOString() ?? null,
        retryAfterSeconds: result.retryAfterSeconds,
      },
      "heartbeat dispatch deferred: penstock model unavailable",
    );
    return result;
  } catch (err) {
    input.log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        model: input.model,
      },
      "penstock capacity readback failed open",
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function capacityEndpointUnavailable(
  input: {
    model: string;
    defaultRetryDelayMs: number;
    now: () => Date;
    log: PenstockAvailabilityGateLogger;
  },
  status: number,
  details?: {
    capacityState?: PenstockCapacityState;
    capacityReason?: string | null;
  },
): PenstockAvailabilityGateDenyResult {
  const retry = defaultCapacityRetry(input.defaultRetryDelayMs, input.now());
  const result: PenstockAvailabilityGateDenyResult = {
    allow: false,
    provider: "anthropic",
    reason:
      status === 429
        ? "penstock.model_capacity_unavailable"
        : "penstock.model_temporarily_unavailable",
    model: input.model,
    resumeAt: retry.resumeAt,
    retryAfterSeconds: retry.retryAfterSeconds,
  };
  input.log.info(
    {
      status,
      provider: result.provider,
      model: result.model,
      reason: result.reason,
      capacityState: details?.capacityState,
      capacityReason: details?.capacityReason,
      resumeAt: result.resumeAt?.toISOString() ?? null,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    "heartbeat dispatch deferred: penstock model unavailable",
  );
  return result;
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

    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 503) {
      const text = await response.text().catch(() => "");
      const parsed = parseCapacityRetry(text, response.headers, input.defaultRetryDelayMs, input.now());
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

function capacityRetryFromBody(
  body: unknown,
  defaultRetryDelayMs: number,
  now: Date,
): { resumeAt: Date | null; retryAfterSeconds: number | null } {
  const record = asRecord(body);
  const resumeAt = parseOptionalDate(
    readNonEmptyString(record?.resume_at) ?? readNonEmptyString(record?.resumeAt),
  );
  const retryAfterSeconds = readRetryAfterSeconds(record, now);
  if (resumeAt && resumeAt.getTime() > now.getTime()) {
    return {
      resumeAt,
      retryAfterSeconds: retryAfterSeconds ?? Math.ceil((resumeAt.getTime() - now.getTime()) / 1000),
    };
  }
  if (retryAfterSeconds !== null) {
    return {
      resumeAt: new Date(now.getTime() + retryAfterSeconds * 1000),
      retryAfterSeconds,
    };
  }
  return defaultCapacityRetry(defaultRetryDelayMs, now);
}

function readCapacityState(body: unknown): PenstockCapacityState | null {
  const record = asRecord(body);
  const state = readNonEmptyString(record?.state);
  if (
    state === "available" ||
    state === "rate_limited" ||
    state === "exhausted" ||
    state === "unknown"
  ) {
    return state;
  }
  return null;
}

function readCapacityReason(body: unknown): string | null {
  const record = asRecord(body);
  return readNonEmptyString(record?.reason);
}

function isAuthoritativeCapacityReason(reason: string | null): boolean {
  return reason?.startsWith("penstock.capacity_") ?? false;
}

function readRetryAfterSeconds(record: Record<string, unknown> | null, now: Date): number | null {
  if (!record) return null;
  const direct =
    readNumber(record.retry_after_seconds) ??
    readNumber(record.retryAfterSeconds) ??
    readNumber(record.retry_after) ??
    readNumber(record.retryAfter);
  if (direct !== null) return direct > 0 ? Math.ceil(direct) : null;
  return parseRetryAfterSeconds(
    readNonEmptyString(record.retry_after) ?? readNonEmptyString(record.retryAfter),
    now,
  );
}

function parseOptionalDate(value: string | null): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
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

function parseRetryAfterSeconds(value: string | null, now = new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  const delta = Math.ceil((parsedDate - now.getTime()) / 1000);
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
