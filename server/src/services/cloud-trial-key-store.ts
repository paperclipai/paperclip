import { createPrivateKey, sign } from "node:crypto";
import {
  CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS,
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  parseCloudTrialMigrationTargetsEnv,
  resolveCloudTrialModel,
  type CloudTrialInferenceState,
  type CloudTrialMigrationTargetOverrides,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getCloudStackContext, type CloudInstanceEnv } from "./cloud-instance.js";
import { publishLiveEvent } from "./live-events.js";
import { trackCloudPostHogEvent } from "../telemetry.js";

const DEFAULT_OPENROUTER_UPSTREAM_BASE = "https://openrouter.ai/api/v1";
const USAGE_PROBE_MIN_INTERVAL_MS = 15_000;

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

export interface CachedCloudKeyState {
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

export interface CloudTrialKeyStoreOptions {
  env?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onExhausted?: () => void;
}

export function readJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stripOpenRouterPrefix(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}

function buildCloudStackAuthHeaders(
  env: CloudInstanceEnv,
  method: string,
  pathname: string,
  stackId: string,
): Record<string, string> {
  const signPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY?.trim();
  if (!signPrivateKey) {
    throw new HttpError(502, "Cloud stack signing key is not configured", {
      code: "cloud_inference_auth_unconfigured",
    });
  }
  const raw = Buffer.from(signPrivateKey, "base64url");
  if (raw.length !== 32) {
    throw new HttpError(502, "Cloud stack signing key is invalid", {
      code: "cloud_inference_auth_unconfigured",
    });
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const payload = Buffer.from(`${method}\n${pathname}\n${stackId}\n${timestamp}`, "utf8");
  return {
    accept: "application/json",
    "x-paperclip-cloud-stack-id": stackId,
    "x-paperclip-cloud-stack-timestamp": timestamp,
    "x-paperclip-cloud-stack-signature": sign(null, payload, key).toString("base64url"),
  };
}

/**
 * In-process custody for the tenant stack's Cloud-issued OpenRouter starter key.
 *
 * Paperclip Cloud tenant stacks run as a single Node instance per stack; the
 * raw OpenRouter key is intentionally held only in server process memory so it
 * never touches Postgres, sandboxes, logs, or UI responses.
 */
export function createCloudTrialKeyStore(opts: CloudTrialKeyStoreOptions = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let onExhaustedHook = opts.onExhausted;

  let cached: CachedCloudKeyState | null = null;
  let inflightFetch: Promise<CachedCloudKeyState> | null = null;

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
    return resolveCloudTrialModel(env.PAPERCLIP_CLOUD_TRIAL_MODEL);
  }

  function configuredMigrationTargets(): CloudTrialMigrationTargetOverrides {
    return parseCloudTrialMigrationTargetsEnv(env.PAPERCLIP_CLOUD_TRIAL_MIGRATION_TARGETS);
  }

  function configuredLocalLimitCents(): number {
    const raw = env.PAPERCLIP_CLOUD_TRIAL_LIMIT_USD_CENTS?.trim();
    if (!raw) return CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : CLOUD_TRIAL_DEFAULT_LIMIT_USD_CENTS;
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
      const payload = readJsonRecord(await response.json());
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
        defaultModel: resolveCloudTrialModel(typeof payload.defaultModel === "string" ? payload.defaultModel : undefined),
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
    onExhaustedHook?.();

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
      const body = readJsonRecord(await response.json());
      const data = readJsonRecord(body.data);
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

  return {
    env,
    fetchImpl,
    now,
    getCached: () => cached,
    getExhaustedAtMs: () => exhaustedAtMs,
    setOnExhausted: (hook: (() => void) | undefined) => {
      onExhaustedHook = hook;
    },
    recordRunPrepared: () => {
      trialRunsCount += 1;
    },
    upstreamBaseUrl,
    configuredDefaultModel,
    configuredMigrationTargets,
    fetchKeyFromCloudOrLocal,
    markExhausted,
    probeOpenRouterUsage,
    _resetForTests: () => {
      cached = null;
      inflightFetch = null;
      keyIssuedTracked = false;
      keyIssuedAtMs = null;
      trialRunsCount = 0;
      exhaustedTracked = false;
      exhaustedAtMs = null;
    },
  };
}

export type CloudTrialKeyStore = ReturnType<typeof createCloudTrialKeyStore>;
