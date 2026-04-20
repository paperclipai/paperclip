import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "@paperclipai/adapter-utils/server-utils";

/* ---------- helpers ---------- */

/** Create a minimal Response-like object that fetchWithRetry can consume. */
function fakeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

/* ---------- tests ---------- */

describe("fetchWithRetry", () => {
  const url = "https://example.com/api";
  const init: RequestInit = { method: "POST" };

  // Stub out global.fetch
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---- success on first try ----
  it("returns immediately on 200 without retrying", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse(200));

    const res = await fetchWithRetry(url, init, { maxRetries: 3 });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ---- retries on retryable status ----
  it("retries on 429 then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(200));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 2,
      baseDelayMs: 1,   // keep tests fast
      maxDelayMs: 5,
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 502, 503, 504", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(504))
      .mockResolvedValueOnce(fakeResponse(200));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // ---- does NOT retry non-retryable statuses ----
  it("does not retry 400 (non-retryable)", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse(400));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 3,
      baseDelayMs: 1,
    });

    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry 401 by default", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse(401));

    const res = await fetchWithRetry(url, init, { maxRetries: 2, baseDelayMs: 1 });

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ---- custom retryableStatuses ----
  it("retries on 403 when included in retryableStatuses", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(403))
      .mockResolvedValueOnce(fakeResponse(200));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 2,
      baseDelayMs: 1,
      retryableStatuses: [403, 429, 502, 503, 504],
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ---- exhausts retries and returns last response ----
  it("returns last response after exhausting maxRetries", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(429));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });

    expect(res.status).toBe(429);
    // 1 initial + 2 retries = 3 calls
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // ---- zero retries ----
  it("does not retry when maxRetries is 0", async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse(503));

    const res = await fetchWithRetry(url, init, {
      maxRetries: 0,
      baseDelayMs: 1,
    });

    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ---- onRetry callback ----
  it("calls onRetry callback before each retry", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(200));

    const onRetry = vi.fn();

    await fetchWithRetry(url, init, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 429 }),
    );
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, status: 502 }),
    );
  });

  // ---- Retry-After header (seconds) ----
  it("respects Retry-After header in seconds", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(fakeResponse(200));

    const onRetry = vi.fn();

    await fetchWithRetry(url, init, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 5000,
      onRetry,
    });

    // Retry-After: 1 → 1000ms, but capped by maxDelayMs
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 1000 }),
    );
  });

  // ---- maxDelayMs cap ----
  it("caps delay at maxDelayMs", async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(429, { "retry-after": "60" }))
      .mockResolvedValueOnce(fakeResponse(200));

    const onRetry = vi.fn();

    await fetchWithRetry(url, init, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 100,
      onRetry,
    });

    // Retry-After: 60 → 60_000ms, should be capped to 100ms
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 100 }),
    );
  });

  // ---- network error propagation ----
  it("propagates network errors (does not catch them)", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      fetchWithRetry(url, init, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow("fetch failed");
  });

  // ---- timeout via timeoutMs ----
  it("aborts request when timeoutMs is exceeded", async () => {
    // Simulate a fetch that never resolves until aborted
    fetchSpy.mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (opts.signal as AbortSignal)?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    await expect(
      fetchWithRetry(url, init, {
        maxRetries: 0,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/abort/i);
  });

  // ---- caller signal respected ----
  it("respects caller-provided AbortSignal", async () => {
    const ac = new AbortController();

    fetchSpy.mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (opts.signal as AbortSignal)?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    // Abort immediately
    setTimeout(() => ac.abort(), 10);

    await expect(
      fetchWithRetry(url, { ...init, signal: ac.signal }, { maxRetries: 0 }),
    ).rejects.toThrow(/abort/i);
  });
});
