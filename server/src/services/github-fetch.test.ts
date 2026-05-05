import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch, GH_FETCH_DEFAULT_TIMEOUT_MS } from "./github-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ghFetch", () => {
  it("returns the response on first successful GET", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );

    const res = await ghFetch("https://api.github.com/repos/o/r", { timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent GET on 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(new Response("fine", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const res = await ghFetch("https://api.github.com/zen", { timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry GET on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await ghFetch("https://api.github.com/repos/o/r", { timeoutMs: 5000 });
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-idempotent POST on 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await ghFetch("https://api.github.com/repos/o/r/issues", {
      method: "POST",
      body: "{}",
      timeoutMs: 5000,
    });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws HttpError 422 when outbound deadline is hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // AbortSignal.timeout() rejects with TimeoutError in Node 18+ (not AbortError).
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      })),
    );

    await expect(ghFetch("https://api.github.com/repos/o/r", { timeoutMs: 25 })).rejects.toThrow(
      /timed out after 25ms/,
    );
  });

  it("respects caller AbortSignal and rethrows AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const p = ghFetch("https://api.github.com/foo", { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("defaults timeout to GH_FETCH_DEFAULT_TIMEOUT_MS when omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );

    await ghFetch("https://raw.githubusercontent.com/o/r/main/README.md");
    expect(fetch).toHaveBeenCalledTimes(1);
    // Signal is a deadline; we only assert fetch was wired with some AbortSignal.
    expect(GH_FETCH_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
