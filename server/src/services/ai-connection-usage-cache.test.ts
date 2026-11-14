import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionUsage } from "@paperclipai/shared";
import {
  aiConnectionUsageCacheKey,
  createAiConnectionUsageCache,
  parseRetryAfter,
  probeAiConnectionUsageDetailed,
  usageRetryDelay,
} from "./ai-connection-usage.js";

const MINUTE = 60_000, HOUR = 3_600_000;
const metadata = { provider: "anthropic", method: "subscription" } as const;
const identity = { connectionId: "connection", grantId: "grant" };
const ok = () => new Response(JSON.stringify({ five_hour: { utilization: 42 } }));
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });

/** A cache on a controllable clock, plus a probe that runs the real parser on a mocked fetch. */
function harness(start = Date.parse("2026-01-01T00:00:00Z")) {
  // Only Date is faked: provider timestamps and HTTP-dates use the same clock as the cache.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  const cache = createAiConnectionUsageCache();
  const request = vi.fn<typeof fetch>();
  const observe = (key = "key") => cache.observe(key, async () => {
    const { usage, retryAfterMs } = await probeAiConnectionUsageDetailed(metadata, "fixture-token", { request });
    return { usage: { ...identity, ...usage } as AiConnectionUsage, retryAfterMs };
  });
  return { cache, request, observe, advance: (ms: number) => { vi.setSystemTime(Date.now() + ms); }, now: () => Date.now() };
}
afterEach(() => { vi.useRealTimers(); });

describe("Retry-After parsing", () => {
  it("reads delta-seconds and HTTP-dates, and ignores unusable values", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:10:00 GMT", now)).toBe(10 * MINUTE);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });

  it("clamps a provider hint and exponential backoff to [60 s, 1 h] for throttled checks", () => {
    expect(usageRetryDelay("rate_limited", 1, 5_000)).toBe(MINUTE);
    expect(usageRetryDelay("rate_limited", 1, 120_000)).toBe(2 * MINUTE);
    expect(usageRetryDelay("rate_limited", 1, 2 * HOUR)).toBe(HOUR);
    expect([1, 2, 3, 4, 5, 6, 7, 30].map((failures) => usageRetryDelay("rate_limited", failures)))
      .toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 16 * MINUTE, 32 * MINUTE, HOUR, HOUR]);
  });

  it("passes the raw hint of a 429 to the cache and keeps it apart from auth and exhaustion", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(status(429, { "Retry-After": "90" }));
    const { usage, retryAfterMs } = await probeAiConnectionUsageDetailed(metadata, "fixture-token", { request });
    expect(retryAfterMs).toBe(90_000);
    expect(usage).toMatchObject({ status: "error", errorCode: "rate_limited", limits: [], overage: null });
    expect(usage.message).toMatch(/throttled/);
    expect(usage.message).not.toMatch(/reconnect|sign in/i);
  });
});

describe("shared usage cache", () => {
  it("honours Retry-After seconds and does not call the provider during backoff", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(status(429, { "Retry-After": "300" }));
    const first = await h.observe();
    expect(first).toMatchObject({ status: "error", errorCode: "rate_limited", retryAt: new Date(h.now() + 5 * MINUTE).toISOString() });
    h.advance(5 * MINUTE - 1);
    expect(await h.observe()).toBe(first);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.request.mockResolvedValueOnce(ok());
    expect((await h.observe()).status).toBe("ok");
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("honours a Retry-After HTTP-date and clamps a short or long hint", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(status(429, { "Retry-After": new Date(h.now() + 20 * MINUTE).toUTCString() }));
    expect((await h.observe("date")).retryAt).toBe(new Date(h.now() + 20 * MINUTE).toISOString());
    h.request.mockResolvedValueOnce(status(429, { "Retry-After": "1" }));
    expect((await h.observe("short")).retryAt).toBe(new Date(h.now() + MINUTE).toISOString());
    h.request.mockResolvedValueOnce(status(429, { "Retry-After": "86400" }));
    expect((await h.observe("long")).retryAt).toBe(new Date(h.now() + HOUR).toISOString());
  });

  it("grows the backoff exponentially without Retry-After, up to one hour", async () => {
    const h = harness();
    h.request.mockImplementation(async () => status(429));
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const result = await h.observe();
      const delay = Date.parse(result.retryAt!) - h.now();
      delays.push(delay);
      h.advance(delay);
    }
    expect(delays).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 16 * MINUTE, 32 * MINUTE, HOUR, HOUR]);
    expect(h.request).toHaveBeenCalledTimes(8);
  });

  it("returns the last good observation as stale with its own timestamp during backoff", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(ok());
    const good = await h.observe();
    h.advance(2 * MINUTE);
    h.request.mockResolvedValueOnce(status(429, { "Retry-After": "600" }));
    const failed = await h.observe();
    expect(failed.checkedAt).toBe(new Date(h.now()).toISOString());
    // The failed result reports nothing as current usage.
    expect(failed).toMatchObject({ status: "error", errorCode: "rate_limited", limits: [], overage: null });
    expect(failed.lastGood).toEqual({ stale: true, checkedAt: good.checkedAt, source: "anthropic_oauth", planType: null, limits: good.limits, overage: good.overage });
    expect(failed.lastGood!.limits[0]).toMatchObject({ id: "five_hour", usedPercent: 42 });
    expect(failed.message).toContain("stale");
    h.advance(MINUTE);
    expect((await h.observe()).lastGood?.checkedAt).toBe(good.checkedAt);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("caches a 403 per credential version and clears it when the credential changes", async () => {
    const h = harness();
    const key = (secretVersion: number) => aiConnectionUsageCacheKey({
      companyId: "company", grantId: "grant", secretId: "secret", secretVersion, grantUpdatedAt: new Date(0),
    });
    h.request.mockImplementation(async () => status(403));
    const denied = await h.observe(key(1));
    expect(denied).toMatchObject({ status: "unavailable", errorCode: "permission_denied", retryAt: new Date(h.now() + 5 * MINUTE).toISOString() });
    // No cause is invented for a 403: no sign-in method, scope or reconnect advice.
    expect(denied.message).not.toMatch(/setup|token|scope|sign-in|reconnect/i);
    for (let i = 0; i < 5; i++) { h.advance(MINUTE / 2); await h.observe(key(1)); }
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValueOnce(ok());
    expect((await h.observe(key(2))).status).toBe("ok");
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("backs off a 401 and does not cache checks that never reached the provider", async () => {
    const h = harness();
    h.request.mockResolvedValue(status(401));
    expect((await h.observe("auth")).errorCode).toBe("authentication_required");
    await h.observe("auth");
    expect(h.request).toHaveBeenCalledTimes(1);
    const unsupported = vi.fn(async () => ({ usage: { ...identity, ...metadata, status: "unsupported", errorCode: "unsupported", checkedAt: new Date().toISOString(), source: null, planType: null, limits: [], overage: null } as AiConnectionUsage, retryAfterMs: null }));
    await h.cache.observe("unsupported", unsupported);
    await h.cache.observe("unsupported", unsupported);
    expect(unsupported).toHaveBeenCalledTimes(2);
  });

  it("shares one provider call among concurrent callers", async () => {
    const h = harness();
    h.request.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return ok(); });
    const results = await Promise.all(Array.from({ length: 8 }, () => h.observe()));
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it("releases the in-flight slot after a rejected or stuck check", async () => {
    const cache = createAiConnectionUsageCache({ probeTimeoutMs: 10 });
    await expect(cache.observe("stuck", () => new Promise(() => {}))).rejects.toThrow(/timed out/);
    await expect(cache.observe("broken", async () => { throw new Error("credential unavailable"); })).rejects.toThrow();
    const next = vi.fn(async () => ({ usage: { ...identity, ...metadata, status: "ok", checkedAt: new Date().toISOString(), source: "x", planType: null, limits: [], overage: null } as AiConnectionUsage, retryAfterMs: null }));
    await cache.observe("broken", next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never lets a timed-out check call the provider or publish after a newer check backs off", async () => {
    const cache = createAiConnectionUsageCache({ probeTimeoutMs: 20 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(status(429, { "retry-after": "120" }));
    let releaseCredential!: (value: string) => void;
    const delayedCredential = new Promise<string>((resolve) => { releaseCredential = resolve; });
    // Mirrors the service probe: wait for the credential, then check the deadline, then call the provider.
    const probe = (credential: () => Promise<string>) => async (signal: AbortSignal) => {
      const value = await credential();
      signal.throwIfAborted();
      const { usage, retryAfterMs } = await probeAiConnectionUsageDetailed(metadata, value, { request, signal });
      return { usage: { ...identity, ...usage } as AiConnectionUsage, retryAfterMs };
    };

    await expect(cache.observe("key", probe(() => delayedCredential))).rejects.toThrow(/timed out/);
    const throttled = await cache.observe("key", probe(async () => "fixture-token"));
    expect(throttled.errorCode).toBe("rate_limited");
    expect(request).toHaveBeenCalledTimes(1);

    releaseCredential("fixture-token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request).toHaveBeenCalledTimes(1);
    expect(cache.peek("key")).toBe(throttled);
  });

  it("aborts an expired provider request and drops its late result", async () => {
    const cache = createAiConnectionUsageCache({ probeTimeoutMs: 20 });
    let requestSignal: AbortSignal | undefined;
    let respond!: () => void;
    const request = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { respond = () => resolve(ok()); });
    });
    await expect(cache.observe("key", async (signal) => {
      const { usage, retryAfterMs } = await probeAiConnectionUsageDetailed(metadata, "fixture-token", { request, signal });
      return { usage: { ...identity, ...usage } as AiConnectionUsage, retryAfterMs };
    })).rejects.toThrow(/timed out/);
    expect(requestSignal?.aborted).toBe(true);
    respond();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.peek("key")).toBeUndefined();
  });

  it("stays bounded by evicting the oldest credentials", async () => {
    const cache = createAiConnectionUsageCache({ maxEntries: 3 });
    const probe = async () => ({ usage: { ...identity, ...metadata, status: "ok", checkedAt: new Date().toISOString(), source: "x", planType: null, limits: [], overage: null } as AiConnectionUsage, retryAfterMs: null });
    for (const key of ["a", "b", "c", "d"]) await cache.observe(key, probe);
    expect(cache.size).toBe(3);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("d")).toBeDefined();
  });
});
