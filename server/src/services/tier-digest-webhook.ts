// ROCAA-25 Slice 3: OPS-channel Slack webhook dispatcher for the daily
// tier-mix digest. Mirrors the shape of `auth-drift-webhook.ts` but is
// simpler: the digest fires once per day, so there is no debounce and
// no argv-masking concern (the payload is aggregate counts + dollar
// totals, not per-run command lines).
//
// Fire-and-forget contract: the scheduler MUST NOT block on delivery.
// Configuration:
//   PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_URL       (required to enable)
//   PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_TIMEOUT_MS (default 3000)
//   PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_MAX_ATTEMPTS (default 2)
//
// As of 2026-05-24 the prod URL is gated on board approval (see the
// existing approval flow used for ROCAA-21 / PAPERCLIP_OPS_AUTH_DRIFT_WEBHOOK_URL).

import { logger } from "../middleware/logger.js";
import type { TierDigest } from "./tier-digest.js";
import { buildTierDigestSlackBody } from "./tier-digest.js";

export type TierDigestWebhookOutcome = "sent" | "disabled" | "failed";

export interface TierDigestWebhookLogger {
  info: (meta: Record<string, unknown>, message: string) => void;
  warn: (meta: Record<string, unknown>, message: string) => void;
  error: (meta: Record<string, unknown>, message: string) => void;
}

export interface TierDigestWebhookDispatcherOptions {
  url?: string | null;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: TierDigestWebhookLogger;
}

export interface TierDigestWebhookDispatcher {
  readonly enabled: boolean;
  /** Fire-and-forget. Never throws, never blocks. */
  dispatch(digest: TierDigest): void;
  /** Awaitable variant for tests / integration. */
  dispatchAndWait(digest: TierDigest): Promise<TierDigestWebhookOutcome>;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

function defaultLogger(): TierDigestWebhookLogger {
  return {
    info: (meta, message) => logger.info(meta, message),
    warn: (meta, message) => logger.warn(meta, message),
    error: (meta, message) => logger.error(meta, message),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTierDigestWebhookDispatcher(
  options: TierDigestWebhookDispatcherOptions = {},
): TierDigestWebhookDispatcher {
  const url = options.url?.trim() || null;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultLogger();

  async function postOnce(body: string): Promise<{ ok: boolean; status: number | null; error?: string }> {
    if (!url || !fetchImpl) return { ok: false, status: null, error: "no-url-or-fetch" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(digest: TierDigest): Promise<TierDigestWebhookOutcome> {
    if (!url) return "disabled";
    const body = JSON.stringify(buildTierDigestSlackBody(digest));
    let attempt = 1;
    let result = await postOnce(body);
    while (!result.ok && attempt < maxAttempts) {
      await sleep(retryBaseDelayMs * Math.pow(2, attempt - 1));
      attempt += 1;
      result = await postOnce(body);
    }
    if (result.ok) {
      log.info(
        {
          status: result.status,
          attempts: attempt,
          totalInvocations: digest.totalInvocations,
          tier1Share24h: digest.tier1Share24h,
          tier1SaturationAlert: digest.tier1SaturationAlert,
        },
        "tier-digest webhook delivered",
      );
      return "sent";
    }
    log.warn(
      {
        status: result.status,
        attempts: attempt,
        error: result.error,
        tier1SaturationAlert: digest.tier1SaturationAlert,
      },
      "tier-digest webhook delivery failed",
    );
    return "failed";
  }

  return {
    enabled: Boolean(url),
    dispatch(digest) {
      if (!url) return;
      void send(digest).catch((err) => {
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "tier-digest webhook dispatcher crashed",
        );
      });
    },
    async dispatchAndWait(digest) {
      try {
        return await send(digest);
      } catch (err) {
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "tier-digest webhook dispatcher crashed",
        );
        return "failed";
      }
    },
  };
}

/**
 * Resolve env-driven dispatcher options. Centralized so the scheduler
 * and any future caller agree on env var names.
 */
export function tierDigestDispatcherOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TierDigestWebhookDispatcherOptions {
  const url = env.PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_URL?.trim() || null;
  const timeoutEnv = env.PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_TIMEOUT_MS;
  const maxAttemptsEnv = env.PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_MAX_ATTEMPTS;
  const parsedTimeout = timeoutEnv != null ? Number(timeoutEnv) : NaN;
  const parsedMaxAttempts = maxAttemptsEnv != null ? Number(maxAttemptsEnv) : NaN;
  const out: TierDigestWebhookDispatcherOptions = { url };
  if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) out.timeoutMs = parsedTimeout;
  if (Number.isFinite(parsedMaxAttempts) && parsedMaxAttempts > 0) {
    out.maxAttempts = Math.floor(parsedMaxAttempts);
  }
  return out;
}
