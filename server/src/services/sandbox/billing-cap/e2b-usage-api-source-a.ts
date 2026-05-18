/**
 * Phase 4A-S4 B2 → S4 follow-up (LET-393): live `SourceA` adapter for the
 * E2B usage / metering API. Pairs with LET-367's `resolveSpend()` coalescer:
 * when this adapter is wired in `app.ts`, the billing-cap monitor prefers the
 * vendor-reported spend and falls back to Source B (internal estimate)
 * cleanly on any non-success.
 *
 * Failure / fallback semantics — Source A NEVER aborts a tick:
 *   - HTTP 401 / 403  → returns `null` (credentials invalid; treat as
 *                       unavailable so the monitor uses the internal estimate).
 *   - HTTP 404        → returns `null` (tier/feature not enabled).
 *   - Non-JSON body   → returns `null` (parse error; fall back).
 *   - Credential-shaped fields anywhere in the payload → returns `null` and
 *                       logs the redaction paths (defence in depth on top of
 *                       the monitor-side redactor in `resolveSpend`).
 *   - Network / 5xx   → throws; the coalescer logs and falls back.
 *
 * Read-only contract (S3 AC §Constraints): this adapter MUST be wired against
 * a read-only metering endpoint. It never issues POST/PUT/DELETE and it never
 * resolves a secret on its own — the caller passes an already-resolved
 * `apiKey` so the secret lifecycle stays under the LET-365 three-gate model.
 *
 * Endpoint shape — the E2B usage API path is still TBD with the vendor. The
 * adapter is therefore configured via two env vars that default to "unset":
 *   - `SANDBOX_E2B_USAGE_API_URL`  — full URL of the metering endpoint
 *   - `SANDBOX_E2B_USAGE_API_AUTH` — resolved API key sent as `X-API-Key`
 *     (matches the B1 live-transport header convention so the same key works)
 * When either is unset the adapter factory returns `null`, the monitor stays
 * on `sourceA: null`, and default deployments behave exactly as before LET-393.
 *
 * Response mapping — the adapter accepts a small set of equivalent JSON
 * shapes so we can wire against the vendor's eventual contract without
 * another release:
 *   { day_cents, month_cents }
 *   { dayCents, monthCents }
 *   { day:   { amount_cents | cents | amountCents }, month: { ... } }
 * Anything else falls back to `null`.
 */

import type { Logger } from "pino";
import {
  redactCredentialShapedValues,
  type RedactedVendorResponse,
} from "./redaction.js";
import type { SourceA, SourceASample } from "./usage-source.js";

export interface E2BUsageApiFetchResponse {
  status: number;
  text(): Promise<string>;
}

export interface E2BUsageApiFetcher {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<E2BUsageApiFetchResponse>;
}

export interface CreateE2BUsageApiSourceAOptions {
  /** Full metering endpoint URL (e.g. `https://api.e2b.app/billing/usage`). */
  url: string;
  /** Already-resolved API key — sent as `X-API-Key`. Never logged. */
  apiKey: string;
  /** Optional fetcher injection (defaults to `globalThis.fetch`). */
  fetcher?: E2BUsageApiFetcher;
  /** Optional request timeout in milliseconds. */
  timeoutMs?: number;
  /** Structured logger for warnings on fallback paths. */
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const E2B_USAGE_API_KEY_HEADER = "X-API-Key" as const;
const E2B_USAGE_API_ACCEPT_HEADER = "Accept" as const;

/**
 * Build a `SourceA` adapter against the E2B usage API, or return `null` when
 * either required env-derived input is missing. Returning `null` instead of
 * throwing lets `app.ts` keep the legacy `sourceA: null` wiring as the
 * default-deployment behaviour.
 */
export function createE2BUsageApiSourceA(
  opts: Partial<CreateE2BUsageApiSourceAOptions> & {
    url?: string | null;
    apiKey?: string | null;
  },
): SourceA | null {
  const url = typeof opts.url === "string" ? opts.url.trim() : "";
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (url.length === 0 || apiKey.length === 0) return null;
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as E2BUsageApiFetcher | undefined);
  if (typeof fetcher !== "function") {
    opts.logger?.warn(
      "E2B usage-API SourceA requested but no fetcher is available; returning null",
    );
    return null;
  }
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.ceil(opts.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const logger = opts.logger;
  return new E2BUsageApiSourceA({ url, apiKey, fetcher, timeoutMs, logger });
}

class E2BUsageApiSourceA implements SourceA {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetcher: E2BUsageApiFetcher;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Logger, "info" | "warn" | "error"> | undefined;

  constructor(input: {
    url: string;
    apiKey: string;
    fetcher: E2BUsageApiFetcher;
    timeoutMs: number;
    logger?: Pick<Logger, "info" | "warn" | "error">;
  }) {
    this.url = input.url;
    this.apiKey = input.apiKey;
    this.fetcher = input.fetcher;
    this.timeoutMs = input.timeoutMs;
    this.logger = input.logger;
  }

  async sample(input: {
    companyId: string;
    now: Date;
    signal?: AbortSignal;
  }): Promise<SourceASample | null> {
    const requestUrl = appendQuery(this.url, {
      company_id: input.companyId,
      as_of: input.now.toISOString(),
    });
    const headers: Record<string, string> = {
      [E2B_USAGE_API_KEY_HEADER]: this.apiKey,
      [E2B_USAGE_API_ACCEPT_HEADER]: "application/json",
    };

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let externalAbortHandler: (() => void) | null = null;
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else {
        externalAbortHandler = () => controller.abort();
        input.signal.addEventListener("abort", externalAbortHandler);
      }
    }

    let response: E2BUsageApiFetchResponse;
    try {
      response = await this.fetcher(requestUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
      if (input.signal && externalAbortHandler) {
        input.signal.removeEventListener("abort", externalAbortHandler);
      }
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.logger?.info(
        { status: response.status, companyId: input.companyId },
        "E2B usage-API SourceA returned non-success; falling back to internal estimate",
      );
      return null;
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error(
        `E2B usage-API SourceA upstream error: HTTP ${response.status}`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `E2B usage-API SourceA unexpected status: HTTP ${response.status}`,
      );
    }

    const bodyText = await response.text();
    if (bodyText.length === 0) {
      this.logger?.warn(
        { companyId: input.companyId },
        "E2B usage-API SourceA returned empty body; falling back",
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      this.logger?.warn(
        { err, companyId: input.companyId },
        "E2B usage-API SourceA returned non-JSON body; falling back",
      );
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger?.warn(
        { companyId: input.companyId },
        "E2B usage-API SourceA payload is not an object; falling back",
      );
      return null;
    }

    const redacted: RedactedVendorResponse<Record<string, unknown>> =
      redactCredentialShapedValues(parsed as Record<string, unknown>);
    if (redacted.redactedAny) {
      this.logger?.warn(
        { companyId: input.companyId, redactedPaths: redacted.redactedPaths },
        "E2B usage-API SourceA payload carried credential-shaped fields; falling back",
      );
      return null;
    }

    const dayCents = extractCents(redacted.value, "day");
    const monthCents = extractCents(redacted.value, "month");
    if (dayCents === null || monthCents === null) {
      this.logger?.warn(
        { companyId: input.companyId, keys: Object.keys(redacted.value) },
        "E2B usage-API SourceA payload missing day/month cents; falling back",
      );
      return null;
    }

    return {
      dayCents: Math.max(0, Math.trunc(dayCents)),
      monthCents: Math.max(0, Math.trunc(monthCents)),
      rawRedacted: redacted.value,
    };
  }
}

function appendQuery(url: string, params: Record<string, string>): string {
  const sep = url.includes("?") ? "&" : "?";
  const encoded = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return encoded.length === 0 ? url : `${url}${sep}${encoded}`;
}

function extractCents(payload: Record<string, unknown>, window: "day" | "month"): number | null {
  const snake = window === "day" ? "day_cents" : "month_cents";
  const camel = window === "day" ? "dayCents" : "monthCents";
  const direct = payload[snake] ?? payload[camel];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const nested = payload[window];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const obj = nested as Record<string, unknown>;
    const candidates = [obj.amount_cents, obj.amountCents, obj.cents];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isFinite(c)) return c;
    }
  }
  return null;
}

export const __testing = {
  appendQuery,
  extractCents,
};
