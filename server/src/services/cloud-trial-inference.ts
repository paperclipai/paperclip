import { createPrivateKey, randomBytes, sign, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  connectionGrants,
  heartbeatRuns,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS,
  CLOUD_TRIAL_DEFAULT_MODEL,
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  defaultMigrationTargetForProvider,
  isAgentUsingCloudTrialInference,
  type CloudTrialBlockedRunSummary,
  type CloudTrialInferenceState,
  type CloudTrialInferenceStatus,
  type MigrateCloudTrialAgentsInput,
  type MigrateCloudTrialAgentsResult,
  type MigratedCloudTrialAgentSummary,
} from "@paperclipai/shared";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/shared/openrouter-attribution";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { getCloudStackContext, type CloudInstanceEnv } from "./cloud-instance.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { publishLiveEvent } from "./live-events.js";
import { trackCloudPostHogEvent } from "../telemetry.js";

const DEFAULT_OPENROUTER_UPSTREAM_BASE = "https://openrouter.ai/api/v1";
const RUN_PROXY_TOKEN_TTL_MS = 30 * 60_000;
const USAGE_PROBE_MIN_INTERVAL_MS = 15_000;
const PROXY_REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;

export class CloudTrialExhaustedError extends HttpError {
  constructor(
    message = "You need to connect a model provider to continue.",
    details: Record<string, unknown> = {},
  ) {
    super(402, message, {
      code: CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
      ...details,
    });
    this.name = "CloudTrialExhaustedError";
  }
}

export function isCloudTrialExhaustedError(error: unknown): error is CloudTrialExhaustedError {
  if (error instanceof CloudTrialExhaustedError) return true;
  if (error instanceof HttpError) {
    const details = error.details as { code?: unknown } | undefined;
    return details?.code === CLOUD_TRIAL_EXHAUSTED_ERROR_CODE;
  }
  return false;
}

interface CachedCloudKeyState {
  status: CloudTrialInferenceState;
  reason?: string;
  apiKey: string | null;
  limitUsdCents: number;
  spentUsdCents: number;
  remainingUsdCents: number;
  defaultModel: string;
  fetchedAtMs: number;
  lastUsageProbeAtMs: number;
}

interface RunProxyTokenRecord {
  token: string;
  companyId: string;
  agentId: string;
  runId: string;
  allowedModel: string;
  expiresAtMs: number;
}

export interface PreparedCloudTrialRuntime {
  env: Record<string, string>;
  secretValues: string[];
  defaultModel: string;
  cleanup: () => Promise<void>;
}

export interface CloudTrialInferenceOptions {
  env?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stripOpenRouterPrefix(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}

function normalizeModelSlug(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return CLOUD_TRIAL_DEFAULT_MODEL;
  return trimmed.startsWith("openrouter/") ? trimmed : `openrouter/${trimmed}`;
}

function buildCloudStackAuthHeaders(
  env: CloudInstanceEnv,
  method: string,
  pathname: string,
  stackId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-paperclip-cloud-stack-id": stackId,
  };
  const signPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY?.trim();
  if (signPrivateKey) {
    try {
      const raw = Buffer.from(signPrivateKey, "base64url");
      if (raw.length === 32) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]);
        const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
        const payload = Buffer.from(`${method}\n${pathname}\n${stackId}\n${timestamp}`, "utf8");
        headers["x-paperclip-cloud-stack-timestamp"] = timestamp;
        headers["x-paperclip-cloud-stack-signature"] = sign(null, payload, key).toString("base64url");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to sign Cloud inference request with Ed25519 key; falling back to trust token");
    }
  }
  const tenantToken = env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (tenantToken) {
    headers.authorization = `Bearer ${tenantToken}`;
  }
  return headers;
}

function looksLikeOpenRouterLimitExhausted(status: number, bodyText: string): boolean {
  if (status === 402) return true;
  if (status === 403 || status === 429) {
    return /key\s+limit\s+exceeded|insufficient\s+credits|credit\s+limit|budget\s+exhausted|cloud_trial_exhausted/i.test(
      bodyText,
    );
  }
  return false;
}

export function createCloudTrialInferenceController(opts: CloudTrialInferenceOptions = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  // Server-memory-only key custody: raw OpenRouter key NEVER touches Postgres or UI.
  let cached: CachedCloudKeyState | null = null;
  let inflightFetch: Promise<CachedCloudKeyState> | null = null;
  const activeRunTokens = new Map<string, RunProxyTokenRecord>();

  // Best-effort PostHog funnel counters for this process (Cloud-only).
  let keyIssuedTracked = false;
  let keyIssuedAtMs: number | null = null;
  let trialRunsCount = 0;
  let exhaustedTracked = false;
  let exhaustedAtMs: number | null = null;

  function maybeTrackKeyIssued(state: CachedCloudKeyState) {
    if (keyIssuedTracked || state.status !== "active" || !state.apiKey) return;
    keyIssuedTracked = true;
    keyIssuedAtMs = now();
    trackCloudPostHogEvent("cloud_trial.key_issued", {
      model: state.defaultModel,
      limit_usd_cents: state.limitUsdCents,
    });
  }

  function upstreamBaseUrl(): string {
    return (env.PAPERCLIP_CLOUD_TRIAL_OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_UPSTREAM_BASE).replace(
      /\/+$/,
      "",
    );
  }

  function configuredDefaultModel(): string {
    return normalizeModelSlug(env.PAPERCLIP_CLOUD_TRIAL_MODEL);
  }

  function configuredLocalLimitCents(): number {
    const raw = env.PAPERCLIP_CLOUD_TRIAL_LIMIT_USD_CENTS?.trim();
    if (!raw) return CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS;
  }

  function pruneExpiredRunTokens() {
    const current = now();
    for (const [token, record] of activeRunTokens) {
      if (record.expiresAtMs <= current) {
        activeRunTokens.delete(token);
      }
    }
  }

  function findRunToken(presented: string): RunProxyTokenRecord | null {
    pruneExpiredRunTokens();
    const presentedBuf = Buffer.from(presented, "utf8");
    for (const [stored, record] of activeRunTokens) {
      const storedBuf = Buffer.from(stored, "utf8");
      if (storedBuf.length === presentedBuf.length && timingSafeEqual(storedBuf, presentedBuf)) {
        return record;
      }
    }
    return null;
  }

  async function fetchKeyFromCloudOrLocal(forceRefresh = false): Promise<CachedCloudKeyState> {
    if (!forceRefresh && cached) {
      if (cached.status === "exhausted" || cached.status === "disabled" || cached.status === "ineligible") {
        return cached;
      }
      if (cached.status === "active" && cached.apiKey) {
        return cached;
      }
    }

    // Local/dev override (allows running E2E and live key tests without Cloud Harness).
    const localKey = env.PAPERCLIP_CLOUD_TRIAL_OPENROUTER_API_KEY?.trim();
    if (localKey) {
      const limitUsdCents = configuredLocalLimitCents();
      const priorSpent = cached?.spentUsdCents ?? 0;
      const exhausted = cached?.status === "exhausted" || (limitUsdCents > 0 && priorSpent >= limitUsdCents);
      cached = {
        status: exhausted ? "exhausted" : "active",
        apiKey: exhausted ? null : localKey,
        limitUsdCents,
        spentUsdCents: priorSpent,
        remainingUsdCents: exhausted ? 0 : Math.max(0, limitUsdCents - priorSpent),
        defaultModel: configuredDefaultModel(),
        fetchedAtMs: now(),
        lastUsageProbeAtMs: cached?.lastUsageProbeAtMs ?? 0,
      };
      maybeTrackKeyIssued(cached);
      return cached;
    }

    const context = getCloudStackContext(env);
    if (!context?.cloudOrigin || !context.stackId) {
      return {
        status: "unavailable",
        reason: "cloud_not_configured",
        apiKey: null,
        limitUsdCents: 0,
        spentUsdCents: 0,
        remainingUsdCents: 0,
        defaultModel: configuredDefaultModel(),
        fetchedAtMs: now(),
        lastUsageProbeAtMs: 0,
      };
    }

    if (inflightFetch) return inflightFetch;
    inflightFetch = (async () => {
      const pathname = "/v1/tenant/inference-key";
      const url = new URL(pathname, context.cloudOrigin!);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          ...buildCloudStackAuthHeaders(env, "POST", pathname, context.stackId!),
          "content-type": "application/json",
        },
        body: JSON.stringify({ refreshUsage: forceRefresh }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new HttpError(502, `Cloud inference key request failed (HTTP ${response.status})`, {
          code: "cloud_inference_fetch_failed",
        });
      }
      const payload = readRecord(await response.json());
      const status = typeof payload.status === "string" ? (payload.status as CloudTrialInferenceState) : "unavailable";
      const limitUsdCents =
        typeof payload.limitUsdCents === "number" && Number.isFinite(payload.limitUsdCents)
          ? Math.max(0, Math.round(payload.limitUsdCents))
          : 0;
      const spentUsdCents =
        typeof payload.spentUsdCents === "number" && Number.isFinite(payload.spentUsdCents)
          ? Math.max(0, Math.round(payload.spentUsdCents))
          : 0;
      const remainingUsdCents =
        typeof payload.remainingUsdCents === "number" && Number.isFinite(payload.remainingUsdCents)
          ? Math.max(0, Math.round(payload.remainingUsdCents))
          : Math.max(0, limitUsdCents - spentUsdCents);
      const apiKey = status === "active" && typeof payload.apiKey === "string" && payload.apiKey.trim()
        ? payload.apiKey.trim()
        : null;
      cached = {
        status,
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        apiKey,
        limitUsdCents,
        spentUsdCents,
        remainingUsdCents,
        defaultModel: normalizeModelSlug(typeof payload.defaultModel === "string" ? payload.defaultModel : undefined),
        fetchedAtMs: now(),
        lastUsageProbeAtMs: now(),
      };
      maybeTrackKeyIssued(cached);
      return cached;
    })().finally(() => {
      inflightFetch = null;
    });
    return inflightFetch;
  }

  async function reportExhaustedToCloud(spentUsdCents: number, reason: string): Promise<void> {
    const context = getCloudStackContext(env);
    if (!context?.cloudOrigin || !context.stackId) return;
    try {
      const pathname = "/v1/tenant/inference-key/exhausted";
      const url = new URL(pathname, context.cloudOrigin);
      await fetchImpl(url, {
        method: "POST",
        headers: {
          ...buildCloudStackAuthHeaders(env, "POST", pathname, context.stackId),
          "content-type": "application/json",
        },
        body: JSON.stringify({ spentUsdCents, reason }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      logger.warn({ err }, "Failed to report Cloud trial inference exhaustion to Cloud Harness");
    }
  }

  async function markExhausted(input: {
    companyId?: string;
    agentId?: string;
    runId?: string;
    spentUsdCents?: number;
    reason?: string;
  }): Promise<void> {
    const limitUsdCents = cached?.limitUsdCents ?? configuredLocalLimitCents();
    const spentUsdCents = Math.max(
      cached?.spentUsdCents ?? 0,
      input.spentUsdCents ?? limitUsdCents,
    );
    cached = {
      status: "exhausted",
      reason: input.reason ?? "budget_exhausted",
      apiKey: null,
      limitUsdCents,
      spentUsdCents,
      remainingUsdCents: 0,
      defaultModel: cached?.defaultModel ?? configuredDefaultModel(),
      fetchedAtMs: now(),
      lastUsageProbeAtMs: now(),
    };
    // Immediately invalidate all active trial proxy tokens so in-flight retries fail fast.
    activeRunTokens.clear();

    if (!exhaustedTracked) {
      exhaustedTracked = true;
      exhaustedAtMs = now();
      const elapsedSeconds =
        keyIssuedAtMs !== null ? Math.max(0, Math.round((exhaustedAtMs - keyIssuedAtMs) / 1000)) : undefined;
      trackCloudPostHogEvent(
        "cloud_trial.exhausted",
        {
          reason: input.reason ?? "budget_exhausted",
          spent_usd_cents: spentUsdCents,
          limit_usd_cents: limitUsdCents,
          runs_count: trialRunsCount,
          ...(elapsedSeconds !== undefined ? { elapsed_seconds: elapsedSeconds } : {}),
        },
        input.companyId ? { companyId: input.companyId } : undefined,
      );
    }

    await reportExhaustedToCloud(spentUsdCents, input.reason ?? "budget_exhausted");

    if (input.companyId) {
      publishLiveEvent({
        companyId: input.companyId,
        type: "cloud_trial.status.updated",
        payload: {
          status: "exhausted",
          limitUsdCents,
          spentUsdCents,
          remainingUsdCents: 0,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          reason: input.reason ?? "budget_exhausted",
        },
      });
    }
  }

  async function probeOpenRouterUsage(companyId?: string, force = false): Promise<void> {
    if (!cached || cached.status !== "active" || !cached.apiKey) return;
    const current = now();
    if (!force && current - cached.lastUsageProbeAtMs < USAGE_PROBE_MIN_INTERVAL_MS) return;
    cached.lastUsageProbeAtMs = current;
    try {
      const response = await fetchImpl(`${upstreamBaseUrl()}/key`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${cached.apiKey}`,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 402 || response.status === 403) {
        await markExhausted({ companyId, reason: `openrouter_key_probe_${response.status}` });
        return;
      }
      if (!response.ok) return;
      const body = readRecord(await response.json());
      const data = readRecord(body.data);
      const limitUsd = typeof data.limit === "number" && Number.isFinite(data.limit) ? data.limit : null;
      const usageUsd = typeof data.usage === "number" && Number.isFinite(data.usage) ? data.usage : null;
      const remainingUsd =
        typeof data.limit_remaining === "number" && Number.isFinite(data.limit_remaining)
          ? data.limit_remaining
          : limitUsd !== null && usageUsd !== null
            ? Math.max(0, limitUsd - usageUsd)
            : null;

      if (limitUsd !== null) cached.limitUsdCents = Math.max(0, Math.round(limitUsd * 100));
      if (usageUsd !== null) cached.spentUsdCents = Math.max(cached.spentUsdCents, Math.round(usageUsd * 100));
      if (remainingUsd !== null) {
        cached.remainingUsdCents = Math.max(0, Math.round(remainingUsd * 100));
        if (remainingUsd <= 0) {
          await markExhausted({
            companyId,
            spentUsdCents: cached.limitUsdCents,
            reason: "openrouter_limit_remaining_zero",
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, "OpenRouter trial key usage probe failed");
    }
  }

  /**
   * Prepares an isolated, proxy-backed runtime environment for a single run of a
   * Cloud-trial agent. The raw `sk-or-v1-...` key NEVER leaves this server process.
   */
  async function prepareCloudTrialRuntime(
    db: Db,
    input: {
      companyId: string;
      agentId: string;
      runId: string;
      model?: string;
    },
  ): Promise<PreparedCloudTrialRuntime> {
    const experimental = await instanceSettingsService(db).getExperimental();
    if (!experimental.enableCloudTrialInference) {
      throw unprocessable("Cloud starter inference is not enabled on this instance.", {
        code: "cloud_trial_disabled",
      });
    }

    const state = await fetchKeyFromCloudOrLocal(false);
    if (state.status === "exhausted" || (state.status === "active" && state.remainingUsdCents <= 0)) {
      await markExhausted({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        spentUsdCents: state.spentUsdCents || state.limitUsdCents,
        reason: "budget_exhausted",
      });
      throw new CloudTrialExhaustedError(undefined, {
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
      });
    }
    if (state.status !== "active" || !state.apiKey) {
      throw unprocessable(
        "You need to connect a model provider to continue.",
        {
          code: state.status === "disabled" ? "cloud_trial_disabled" : CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
          trialStatus: state.status,
          reason: state.reason,
        },
      );
    }

    const serverOrigin = (env.PAPERCLIP_API_URL?.trim() || "http://127.0.0.1:3100").replace(/\/+$/, "");
    const proxyUrl = `${serverOrigin}/api/internal/cloud-inference/v1`;
    const token = `pctrial_${randomBytes(32).toString("base64url")}`;
    const allowedModel = stripOpenRouterPrefix(input.model || state.defaultModel);
    trialRunsCount += 1;

    activeRunTokens.set(token, {
      token,
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      allowedModel,
      expiresAtMs: now() + RUN_PROXY_TOKEN_TTL_MS,
    });

    return {
      env: {
        OPENROUTER_API_KEY: "",
        PAPERCLIP_OPENROUTER_PROXY_URL: proxyUrl,
        PAPERCLIP_OPENROUTER_PROXY_TOKEN: token,
      },
      secretValues: [token, state.apiKey],
      defaultModel: state.defaultModel,
      cleanup: async () => {
        activeRunTokens.delete(token);
        await probeOpenRouterUsage(input.companyId, true);
      },
    };
  }

  /**
   * Transparent OpenRouter reverse proxy for trial runs.
   * Authenticates strictly via the short-lived per-run token and injects the
   * server-held OpenRouter key upstream. Never exposes the raw key to the caller.
   */
  async function proxyOpenRouterRequest(
    req: IncomingMessage & { originalUrl?: string; url?: string; body?: unknown },
    res: ServerResponse,
    subpath: string,
  ): Promise<void> {
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const tokenRecord = bearer ? findRunToken(bearer) : null;
    if (!tokenRecord) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "Invalid or expired trial proxy token" } }));
      return;
    }

    const state = cached ?? (await fetchKeyFromCloudOrLocal(false));
    if (state.status === "exhausted" || !state.apiKey || state.remainingUsdCents <= 0) {
      await markExhausted({
        companyId: tokenRecord.companyId,
        agentId: tokenRecord.agentId,
        runId: tokenRecord.runId,
        reason: "budget_exhausted",
      });
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
            message: "You need to connect a model provider to continue.",
          },
        }),
      );
      return;
    }

    const normalizedSubpath = subpath.replace(/^\/+/, "");
    if (!["chat/completions", "responses", "models"].includes(normalizedSubpath)) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "unsupported_endpoint", message: "Unsupported proxy endpoint" } }));
      return;
    }

    const method = (req.method ?? "POST").toUpperCase();
    let forwardBody: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (req.body !== undefined && req.body !== null) {
        const serialized = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        forwardBody = Buffer.from(serialized, "utf8");
      } else {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_PROXY_REQUEST_BYTES) {
            res.statusCode = 413;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { code: "payload_too_large", message: "Request body too large" } }));
            return;
          }
          chunks.push(buf);
        }
        forwardBody = Buffer.concat(chunks);
      }

      // Guard against model exfiltration / switching to arbitrary expensive models.
      if (forwardBody.length > 0 && (normalizedSubpath === "chat/completions" || normalizedSubpath === "responses")) {
        try {
          const parsed = readRecord(JSON.parse(forwardBody.toString("utf8")));
          if (typeof parsed.model === "string" && parsed.model.trim()) {
            const requested = stripOpenRouterPrefix(parsed.model);
            if (requested !== tokenRecord.allowedModel) {
              res.statusCode = 403;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  error: {
                    code: "model_not_allowed",
                    message: `Trial inference is restricted to ${tokenRecord.allowedModel}`,
                  },
                }),
              );
              return;
            }
          }
        } catch {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "invalid_json", message: "Invalid JSON payload" } }));
          return;
        }
      }
    }

    const upstreamUrl = `${upstreamBaseUrl()}/${normalizedSubpath}`;
    let upstream: Response;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method,
        headers: {
          ...OPENROUTER_ATTRIBUTION_HEADERS,
          accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
          authorization: `Bearer ${state.apiKey}`,
          ...(forwardBody ? { "content-type": "application/json" } : {}),
        },
        ...(forwardBody ? { body: new Uint8Array(forwardBody) } : {}),
        signal: AbortSignal.timeout(PROXY_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: "upstream_unavailable",
            message: err instanceof Error ? err.message : "Failed to reach inference upstream",
          },
        }),
      );
      return;
    }

    if (upstream.status === 402 || upstream.status === 403 || upstream.status === 429) {
      const text = await upstream.text().catch(() => "");
      if (looksLikeOpenRouterLimitExhausted(upstream.status, text)) {
        await markExhausted({
          companyId: tokenRecord.companyId,
          agentId: tokenRecord.agentId,
          runId: tokenRecord.runId,
          reason: `openrouter_http_${upstream.status}`,
        });
        res.statusCode = 402;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              code: CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
              message: "You need to connect a model provider to continue.",
            },
          }),
        );
        return;
      }
      res.statusCode = upstream.status;
      res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
      res.end(text);
      return;
    }

    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
    } else {
      res.end(await upstream.text());
    }

    // Background usage probe (throttled) so UI stays current without blocking stream completion.
    void probeOpenRouterUsage(tokenRecord.companyId, false);
  }

  async function getCompanyStatus(
    db: Db,
    companyId: string,
    options: { refreshUsage?: boolean } = {},
  ): Promise<CloudTrialInferenceStatus> {
    const experimental = await instanceSettingsService(db).getExperimental();
    const enabled = experimental.enableCloudTrialInference === true;

    const companyAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

    const trialAgents = companyAgents
      .filter((a) => isAgentUsingCloudTrialInference(a.runtimeConfig))
      .map((a) => ({ id: a.id, name: a.name, role: a.role, title: a.title }));
    const trialAgentIds = trialAgents.map((a) => a.id);

    // Check most recent blocked/failed run caused by trial exhaustion.
    let blockedRun: CloudTrialBlockedRunSummary | null = null;
    if (trialAgentIds.length > 0) {
      const [recent] = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          issueId: heartbeatRuns.issueId,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.agentId, trialAgentIds),
            inArray(heartbeatRuns.errorCode, [CLOUD_TRIAL_EXHAUSTED_ERROR_CODE, "native_provider_usage_limit"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      if (recent) {
        blockedRun = {
          runId: recent.id,
          agentId: recent.agentId,
          issueId: recent.nativeIssueId ?? recent.issueId ?? null,
          failedAt: (recent.finishedAt ?? recent.createdAt).toISOString(),
        };
      }
    }

    if (!enabled) {
      return {
        enabled: false,
        provider: "openrouter",
        status: "unavailable",
        reason: "feature_disabled",
        limitUsdCents: 0,
        spentUsdCents: 0,
        remainingUsdCents: 0,
        defaultModel: configuredDefaultModel(),
        trialAgentIds,
        trialAgents,
        blockedRun,
      };
    }

    let state = cached;
    if (!state || options.refreshUsage) {
      try {
        state = await fetchKeyFromCloudOrLocal(Boolean(options.refreshUsage));
        if (options.refreshUsage && state.status === "active") {
          await probeOpenRouterUsage(companyId, true);
          state = cached ?? state;
        }
      } catch (err) {
        logger.warn({ err, companyId }, "Failed to fetch Cloud trial inference status");
        state = {
          status: "unavailable",
          reason: "cloud_unavailable",
          apiKey: null,
          limitUsdCents: 0,
          spentUsdCents: 0,
          remainingUsdCents: 0,
          defaultModel: configuredDefaultModel(),
          fetchedAtMs: now(),
          lastUsageProbeAtMs: 0,
        };
      }
    }

    // If the user already migrated every trial agent to their own subscription, report migrated.
    const effectiveStatus: CloudTrialInferenceState =
      state.status === "exhausted" && trialAgentIds.length === 0 && companyAgents.length > 0
        ? "migrated"
        : blockedRun && state.status === "active"
          ? "exhausted"
          : state.status;

    return {
      enabled: true,
      provider: "openrouter",
      status: effectiveStatus,
      ...(state.reason ? { reason: state.reason } : {}),
      limitUsdCents: state.limitUsdCents,
      spentUsdCents: state.spentUsdCents,
      remainingUsdCents: effectiveStatus === "exhausted" ? 0 : state.remainingUsdCents,
      defaultModel: state.defaultModel,
      trialAgentIds,
      trialAgents,
      blockedRun,
    };
  }

  /**
   * Migrates all (or selected) Cloud-trial agents in a company onto a newly
   * connected user subscription / API key, switching harness + default model
   * as needed, clearing stale provider sessions, and optionally resuming blocked work.
   */
  async function migrateTrialAgents(
    db: Db,
    companyId: string,
    input: MigrateCloudTrialAgentsInput,
    actor: { userId: string },
  ): Promise<MigrateCloudTrialAgentsResult> {
    // Verify the connection + grant belong to this company and are active.
    const [grantRow] = await db
      .select({
        connection: toolConnections,
        grant: connectionGrants,
      })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, connectionGrants.connectionId),
          eq(toolConnections.companyId, connectionGrants.companyId),
        ),
      )
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.id, input.grantId),
          eq(toolConnections.id, input.connectionId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      )
      .limit(1);

    if (!grantRow) {
      throw notFound("Selected AI connection grant was not found for this company");
    }
    if (grantRow.grant.status !== "active" || !grantRow.connection.enabled) {
      throw badRequest("Selected AI connection is not active");
    }
    if (grantRow.grant.kind === "user" && grantRow.grant.subjectUserId !== actor.userId) {
      throw forbidden("You cannot migrate agents onto another user's personal AI connection");
    }

    const companyAgents = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

    const requestedIds = input.agentIds ? new Set(input.agentIds) : null;
    const targets = companyAgents.filter((agent) => {
      if (!isAgentUsingCloudTrialInference(agent.runtimeConfig)) return false;
      if (requestedIds && !requestedIds.has(agent.id)) return false;
      return true;
    });

    const targetSpec = defaultMigrationTargetForProvider(input.provider, input.method, input.model);
    const binding = {
      provider: input.provider,
      method: input.method,
      mode: input.ownership === "shared" ? ("shared" as const) : ("delegated" as const),
      connectionId: input.connectionId,
      grantId: input.grantId,
    };

    const migrated: MigratedCloudTrialAgentSummary[] = [];
    const migratedAgentIds: string[] = [];

    await db.transaction(async (tx) => {
      for (const agent of targets) {
        const currentAdapterConfig = readRecord(agent.adapterConfig);
        const nextAdapterConfig: Record<string, unknown> = {
          ...currentAdapterConfig,
          model: targetSpec.model,
        };
        if (targetSpec.runnerProvider) {
          nextAdapterConfig.provider = targetSpec.runnerProvider;
        } else {
          delete nextAdapterConfig.provider;
        }

        const currentRuntimeConfig = readRecord(agent.runtimeConfig);
        const nextRuntimeConfig: Record<string, unknown> = {
          ...currentRuntimeConfig,
          aiConnection: binding,
        };
        delete nextRuntimeConfig.cloudTrialInference;

        await tx
          .update(agents)
          .set({
            adapterType: targetSpec.adapterType,
            adapterConfig: nextAdapterConfig,
            runtimeConfig: nextRuntimeConfig,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.id, agent.id), eq(agents.companyId, companyId)));

        // Reset incompatible provider task sessions so resumed work starts fresh on the new harness.
        await tx
          .delete(agentTaskSessions)
          .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agent.id)));

        migratedAgentIds.push(agent.id);
        migrated.push({
          agentId: agent.id,
          name: agent.name,
          adapterType: targetSpec.adapterType,
          ...(targetSpec.runnerProvider ? { runnerProvider: targetSpec.runnerProvider } : {}),
          model: targetSpec.model,
        });
      }

      if (migrated.length > 0) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "cloud_trial.agents_migrated",
          entityType: "company",
          entityId: companyId,
          details: {
            provider: input.provider,
            method: input.method,
            connectionId: input.connectionId,
            migratedAgentIds,
            targetAdapterType: targetSpec.adapterType,
            targetRunnerProvider: targetSpec.runnerProvider ?? null,
            targetModel: targetSpec.model,
          },
        });
      }
    });

    // Resume the most recent blocked turn/issue if requested.
    const resumedRunIds: string[] = [];
    let resumedIssueId: string | null = null;
    if (input.resumeBlockedWork && migratedAgentIds.length > 0) {
      const [blocked] = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          issueId: heartbeatRuns.issueId,
          nativeIssueId: heartbeatRuns.nativeIssueId,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.agentId, migratedAgentIds),
            inArray(heartbeatRuns.errorCode, [CLOUD_TRIAL_EXHAUSTED_ERROR_CODE, "native_provider_usage_limit"]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);

      if (blocked) {
        resumedIssueId = blocked.nativeIssueId ?? blocked.issueId ?? null;
        try {
          const woke = await heartbeatService(db).wakeup(blocked.agentId, {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "cloud_trial_migrated_resume",
            requestedByActorType: "user",
            requestedByActorId: actor.userId,
            payload: resumedIssueId ? { issueId: resumedIssueId } : undefined,
            contextSnapshot: {
              ...(resumedIssueId ? { issueId: resumedIssueId, taskId: resumedIssueId } : {}),
              wakeReason: "cloud_trial_migrated_resume",
              source: "cloud_trial_migration",
            },
          });
          if (woke?.id) {
            resumedRunIds.push(woke.id);
          }
        } catch (err) {
          logger.warn(
            { err, companyId, agentId: blocked.agentId, issueId: resumedIssueId },
            "Migrated trial agents succeeded, but auto-resuming the blocked run failed",
          );
        }
      }
    }

    publishLiveEvent({
      companyId,
      type: "cloud_trial.status.updated",
      payload: {
        status: "migrated",
        migratedCount: migrated.length,
        provider: input.provider,
        resumedRunIds,
        resumedIssueId,
      },
    });

    const secondsSinceExhausted =
      exhaustedAtMs !== null ? Math.max(0, Math.round((now() - exhaustedAtMs) / 1000)) : undefined;
    trackCloudPostHogEvent(
      "cloud_trial.migrated",
      {
        provider: input.provider,
        auth_method: input.method,
        ownership: input.ownership,
        migrated_agent_count: migrated.length,
        resumed_run_count: resumedRunIds.length,
        target_adapter_type: targetSpec.adapterType,
        target_model: targetSpec.model,
        ...(secondsSinceExhausted !== undefined ? { seconds_since_exhausted: secondsSinceExhausted } : {}),
      },
      { userId: actor.userId, companyId },
    );

    return {
      migratedCount: migrated.length,
      agents: migrated,
      resumedRunIds,
      resumedIssueId,
    };
  }

  /** Reset in-memory state (for unit tests). */
  function _resetForTests() {
    cached = null;
    inflightFetch = null;
    activeRunTokens.clear();
    keyIssuedTracked = false;
    keyIssuedAtMs = null;
    trialRunsCount = 0;
    exhaustedTracked = false;
    exhaustedAtMs = null;
  }

  return {
    prepareCloudTrialRuntime,
    proxyOpenRouterRequest,
    getCompanyStatus,
    migrateTrialAgents,
    markExhausted,
    probeOpenRouterUsage,
    _resetForTests,
  };
}

export type CloudTrialInferenceController = ReturnType<typeof createCloudTrialInferenceController>;

let defaultController: CloudTrialInferenceController | null = null;

export function getDefaultCloudTrialInferenceController(): CloudTrialInferenceController {
  if (!defaultController) {
    defaultController = createCloudTrialInferenceController();
  }
  return defaultController;
}
