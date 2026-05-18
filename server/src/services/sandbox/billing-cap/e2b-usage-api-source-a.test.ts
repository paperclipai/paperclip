/**
 * LET-393: tests for the E2B usage-API `SourceA` adapter.
 *
 * Coverage matches the issue's Definition of Done:
 *   - happy-path mapping of `{ day_cents, month_cents }`
 *   - 401 fallback (returns null; never throws)
 *   - 404 fallback (returns null; never throws)
 *   - credential-shape parse-error fallback (returns null, never persists secret)
 *   - factory returns null when env-derived inputs are missing
 *   - factory returns null when the apiKey is whitespace-only
 *   - `X-API-Key` header is sent on the GET; the URL gets companyId+as_of
 *   - alternate JSON shapes (`{ day: { cents }, ... }` and camelCase) map cleanly
 *   - HTTP 500 / 429 throws so the coalescer logs + falls back
 */

import { describe, expect, it, vi } from "vitest";
import {
  createE2BUsageApiSourceA,
  type E2BUsageApiFetcher,
  type E2BUsageApiFetchResponse,
} from "./e2b-usage-api-source-a.js";

const COMPANY = "company-let-393";
const NOW = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
const URL = "https://api.e2b.app/billing/usage";
const API_KEY = "e2b_test_key_for_unit_tests_only_abc123";

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function jsonResponse(status: number, body: unknown): E2BUsageApiFetchResponse {
  const text = JSON.stringify(body);
  return { status, text: async () => text };
}

function emptyResponse(status: number): E2BUsageApiFetchResponse {
  return { status, text: async () => "" };
}

function rawResponse(status: number, text: string): E2BUsageApiFetchResponse {
  return { status, text: async () => text };
}

describe("createE2BUsageApiSourceA — factory gating", () => {
  it("returns null when url is missing", () => {
    const adapter = createE2BUsageApiSourceA({ apiKey: API_KEY, fetcher: vi.fn() });
    expect(adapter).toBeNull();
  });
  it("returns null when apiKey is missing", () => {
    const adapter = createE2BUsageApiSourceA({ url: URL, fetcher: vi.fn() });
    expect(adapter).toBeNull();
  });
  it("returns null when apiKey is whitespace-only", () => {
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: "   ", fetcher: vi.fn() });
    expect(adapter).toBeNull();
  });
  it("returns null when both env-derived inputs are unset", () => {
    const adapter = createE2BUsageApiSourceA({});
    expect(adapter).toBeNull();
  });
  it("returns a SourceA when both inputs are present", () => {
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher: vi.fn() });
    expect(adapter).not.toBeNull();
    expect(typeof adapter?.sample).toBe("function");
  });
});

describe("E2BUsageApiSourceA.sample — happy paths", () => {
  it("maps { day_cents, month_cents } to dayCents/monthCents and surfaces rawRedacted", async () => {
    const fetcher: E2BUsageApiFetcher = vi.fn(async () =>
      jsonResponse(200, { day_cents: 1234, month_cents: 56_789, currency: "USD" }),
    );
    const adapter = createE2BUsageApiSourceA({
      url: URL,
      apiKey: API_KEY,
      fetcher,
      logger: silentLogger(),
    })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample).not.toBeNull();
    expect(sample!.dayCents).toBe(1234);
    expect(sample!.monthCents).toBe(56_789);
    expect(sample!.rawRedacted).toMatchObject({ day_cents: 1234, month_cents: 56_789, currency: "USD" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toContain(`company_id=${encodeURIComponent(COMPANY)}`);
    expect(calledUrl).toContain(`as_of=${encodeURIComponent(NOW.toISOString())}`);
    expect(init.method).toBe("GET");
    expect(init.headers["X-API-Key"]).toBe(API_KEY);
    expect(init.headers["Accept"]).toBe("application/json");
  });

  it("accepts camelCase keys", async () => {
    const fetcher: E2BUsageApiFetcher = async () =>
      jsonResponse(200, { dayCents: 10, monthCents: 200 });
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample).toEqual({
      dayCents: 10,
      monthCents: 200,
      rawRedacted: { dayCents: 10, monthCents: 200 },
    });
  });

  it("accepts nested { day: { amount_cents }, month: { cents } } shape", async () => {
    const fetcher: E2BUsageApiFetcher = async () =>
      jsonResponse(200, { day: { amount_cents: 50 }, month: { cents: 1500 } });
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample?.dayCents).toBe(50);
    expect(sample?.monthCents).toBe(1500);
  });

  it("floors fractional cents and clamps negatives to 0", async () => {
    const fetcher: E2BUsageApiFetcher = async () =>
      jsonResponse(200, { day_cents: 12.9, month_cents: -5 });
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample?.dayCents).toBe(12);
    expect(sample?.monthCents).toBe(0);
  });
});

describe("E2BUsageApiSourceA.sample — fallback paths", () => {
  it("returns null on HTTP 401 (credentials invalid)", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(401);
    const log = silentLogger();
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher, logger: log })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample).toBeNull();
    expect(log.info).toHaveBeenCalled();
  });

  it("returns null on HTTP 403", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(403);
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
  });

  it("returns null on HTTP 404 (tier/endpoint not available)", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(404);
    const log = silentLogger();
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher, logger: log })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
    expect(log.info).toHaveBeenCalled();
  });

  it("returns null when the payload contains a credential-shaped field", async () => {
    const leakedToken = "e2b_leaked_token_value_must_be_redacted_abcdef1234567890";
    const fetcher: E2BUsageApiFetcher = async () =>
      jsonResponse(200, {
        day_cents: 100,
        month_cents: 1000,
        debug: { api_key: leakedToken },
      });
    const log = silentLogger();
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher, logger: log })!;
    const sample = await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(sample).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    const warnCalls = log.warn.mock.calls.map((c) => JSON.stringify(c));
    // Defence in depth: the redaction-detection log must NOT include the leaked token verbatim.
    for (const call of warnCalls) {
      expect(call).not.toContain(leakedToken);
    }
  });

  it("returns null when body is empty", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(200);
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
  });

  it("returns null when body is non-JSON", async () => {
    const fetcher: E2BUsageApiFetcher = async () => rawResponse(200, "<html>nope</html>");
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
  });

  it("returns null when payload is a JSON array instead of object", async () => {
    const fetcher: E2BUsageApiFetcher = async () => jsonResponse(200, [{ day_cents: 1 }]);
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
  });

  it("returns null when day/month cents are missing", async () => {
    const fetcher: E2BUsageApiFetcher = async () => jsonResponse(200, { other: "shape" });
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    expect(await adapter.sample({ companyId: COMPANY, now: NOW })).toBeNull();
  });

  it("throws on HTTP 500 so the coalescer logs + falls back via the catch arm", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(500);
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    await expect(adapter.sample({ companyId: COMPANY, now: NOW })).rejects.toThrow(/HTTP 500/);
  });

  it("throws on HTTP 429", async () => {
    const fetcher: E2BUsageApiFetcher = async () => emptyResponse(429);
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    await expect(adapter.sample({ companyId: COMPANY, now: NOW })).rejects.toThrow(/HTTP 429/);
  });
});

describe("E2BUsageApiSourceA.sample — request shape", () => {
  it("only issues GET (never billable POST/PUT/DELETE) and sets X-API-Key", async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    const fetcher: E2BUsageApiFetcher = async (_url, init) => {
      calls.push({ method: init.method, headers: init.headers });
      return jsonResponse(200, { day_cents: 1, month_cents: 2 });
    };
    const adapter = createE2BUsageApiSourceA({ url: URL, apiKey: API_KEY, fetcher })!;
    await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["X-API-Key"]).toBe(API_KEY);
    // Authorization header must NOT be set — B1's transport uses X-API-Key only.
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("appends query params with `&` when the configured URL already has a query string", async () => {
    const seen: string[] = [];
    const fetcher: E2BUsageApiFetcher = async (url) => {
      seen.push(url);
      return jsonResponse(200, { day_cents: 0, month_cents: 0 });
    };
    const adapter = createE2BUsageApiSourceA({
      url: `${URL}?tier=pilot`,
      apiKey: API_KEY,
      fetcher,
    })!;
    await adapter.sample({ companyId: COMPANY, now: NOW });
    expect(seen[0]).toMatch(/\?tier=pilot&company_id=/);
  });
});
