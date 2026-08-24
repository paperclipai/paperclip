import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiAuthError, ApiConnectionError, ApiRequestError, PaperclipApiClient } from "../client/http.js";

describe("PaperclipApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });
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

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/1/checkout", {})).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
      details: { issueId: "1" },
    } satisfies Partial<ApiRequestError>);
  });

  it("throws ApiConnectionError with recovery guidance when fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

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
      /pnpm dev|npx paperclipai run/,
    );
  });

  it("throws ApiAuthError (not the generic ApiRequestError) on a 401", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ error: "Token expired" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/1/checkout", {})).rejects.toBeInstanceOf(ApiAuthError);
    await expect(client.post("/api/issues/1/checkout", {})).rejects.toMatchObject({
      status: 401,
      message: "Token expired",
    } satisfies Partial<ApiAuthError>);
  });

  it(
    "stops after one attempt on a 401 mid-retry-loop with a distinguishable error, not the generic timeout classification (RBR-1036)",
    async () => {
      // Simulate the API going from "slow under load" (network-error/timeout
      // territory) to a rejected credential (401) mid-run, then a caller-side
      // retry/backoff wrapper (the kind a heartbeat/background retry loop
      // would use) driving several attempts against it. Before RBR-1036, a
      // wrapper could treat every non-2xx the same way and burn its retry
      // budget on a token that can never succeed. After the fix, the wrapper
      // must special-case ApiAuthError and fail fast on the first occurrence.
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed")) // transient network hiccup — retryable
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "JWT expired" }), { status: 401 }),
        ) // credential rejected — terminal, must NOT retry
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // would "succeed" if wrongly retried
      vi.stubGlobal("fetch", fetchMock);

      const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

      const maxAttempts = 6;
      let attempts = 0;
      let caughtError: unknown;
      for (; attempts < maxAttempts; attempts++) {
        try {
          await client.post("/api/issues/1/comments", { body: "hi" });
          break;
        } catch (error) {
          caughtError = error;
          // The bounded retry/backoff wrapper's own special-case: a 401 is
          // terminal, so it must fail fast instead of looping like it would
          // for ApiConnectionError/5xx.
          if (error instanceof ApiAuthError) break;
        }
      }

      expect(caughtError).toBeInstanceOf(ApiAuthError);
      expect((caughtError as ApiAuthError).status).toBe(401);
      // One retryable network failure, then the terminal 401 — the wrapper
      // must stop there rather than continuing to the would-be-successful
      // third call.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(attempts).toBeLessThan(maxAttempts);
    },
  );

  it("recoverAuth still gets exactly one bounded recovery attempt on a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Token expired" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const recoverAuth = vi.fn().mockResolvedValue("fresh-token-456");
    const client = new PaperclipApiClient({
      apiBase: "http://localhost:3100",
      recoverAuth,
    });

    const result = await client.post<{ ok: boolean }>("/api/test", { hello: "world" });

    expect(result).toEqual({ ok: true });
    expect(recoverAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    });

    const result = await client.post<{ ok: boolean }>("/api/test", { hello: "world" });

    expect(result).toEqual({ ok: true });
    expect(recoverAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe("Bearer board-token-123");
  });
});
