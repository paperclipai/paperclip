import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConnectionError, ApiRequestError, PaperclipApiClient } from "../client/http.js";

describe("PaperclipApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("adds authorization and run-id headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      apiKey: "token-123",
      runId: "run-abc",
      transientRetry: { maxAttempts: 1, initialDelayMs: 0 },
    });

    await client.post("/api/test", { hello: "world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/test");

    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(headers["x-paperclip-run-id"]).toBe("run-abc");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("returns null on ignoreNotFound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      transientRetry: { maxAttempts: 1, initialDelayMs: 0 },
    });
    const result = await client.get("/api/missing", { ignoreNotFound: true });
    expect(result).toBeNull();
  });

  it("throws ApiRequestError with details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Issue checkout conflict", details: { issueId: "1" } }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      transientRetry: { maxAttempts: 1, initialDelayMs: 0 },
    });

    await expect(client.post("/api/issues/1/checkout", {})).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
      details: { issueId: "1" },
    } satisfies Partial<ApiRequestError>);
  });

  it("throws ApiConnectionError with recovery guidance when fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      transientRetry: { maxAttempts: 1, initialDelayMs: 0 },
    });

    await expect(client.post("/api/companies/import/preview", {})).rejects.toBeInstanceOf(ApiConnectionError);
    await expect(client.post("/api/companies/import/preview", {})).rejects.toMatchObject({
      url: "http://localhost:3100/api/companies/import/preview",
      method: "POST",
      causeMessage: "fetch failed",
    } satisfies Partial<ApiConnectionError>);
    await expect(client.post("/api/companies/import/preview", {})).rejects.toThrow(
      /Could not reach the Paperclip API\./,
    );
    await expect(client.post("/api/companies/import/preview", {})).rejects.toThrow(
      /curl http:\/\/localhost:3100\/api\/health/,
    );
    await expect(client.post("/api/companies/import/preview", {})).rejects.toThrow(
      /pnpm dev|pnpm paperclipai run/,
    );
  });

  it("retries once after interactive auth recovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Board access required" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const recoverAuth = vi.fn().mockResolvedValue("board-token-123");
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      recoverAuth,
      transientRetry: { maxAttempts: 1, initialDelayMs: 0 },
    });

    const result = await client.post<{ ok: boolean }>("/api/test", { hello: "world" });

    expect(result).toEqual({ ok: true });
    expect(recoverAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe("Bearer board-token-123");
  });

  it("retries on 503 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "down" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      transientRetry: { maxAttempts: 4, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 100 },
    });

    const promise = client.get<{ ok: boolean }>("/api/test");
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying 503 after maxAttempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      () => new Response(JSON.stringify({ error: "down" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      transientRetry: { maxAttempts: 2, initialDelayMs: 50, backoffMultiplier: 2, maxDelayMs: 50 },
    });

    const outcome = client
      .get("/api/test")
      .then(
        () => ({ ok: true as const, err: undefined }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    await vi.runAllTimersAsync();
    const { ok, err } = await outcome;
    expect(ok).toBe(false);
    expect(err).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
