import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./client";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function installFetchMock(response: () => Response) {
  const captured: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { captured, fetchMock };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("api client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends application/json on POST with no custom headers", async () => {
    const { captured } = installFetchMock(() => jsonResponse({ ok: true }));

    await api.post("/x", { foo: 1 });

    expect(captured).toHaveLength(1);
    const headers = new Headers(captured[0].init.headers as HeadersInit | undefined);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  // Regression: previously `...init` was spread *after* `headers`, so
  // `init.headers` (a plain record) replaced the merged `Headers` object
  // and dropped `Content-Type: application/json`. fetch then defaulted the
  // body to `text/plain`, `express.json()` refused to parse it, and the
  // route 400'd before running. This test pins both headers go out.
  it("keeps Content-Type when a caller passes options.headers", async () => {
    const { captured } = installFetchMock(() => jsonResponse({ ok: true }));

    await api.post("/x", { foo: 1 }, { headers: { "Idempotency-Key": "k-123" } });

    expect(captured).toHaveLength(1);
    const headers = new Headers(captured[0].init.headers as HeadersInit | undefined);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("k-123");
  });

  it("uses the POST method and serialized body", async () => {
    const { captured } = installFetchMock(() => jsonResponse({ ok: true }));

    await api.post("/x", { foo: 1 }, { headers: { "Idempotency-Key": "k-1" } });

    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.body).toBe(JSON.stringify({ foo: 1 }));
  });

  it("does not force JSON Content-Type for FormData bodies", async () => {
    const { captured } = installFetchMock(() => jsonResponse({ ok: true }));

    const form = new FormData();
    form.append("name", "a");
    await api.postForm("/x", form);

    const headers = new Headers(captured[0].init.headers as HeadersInit | undefined);
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("throws ApiError on non-2xx", async () => {
    installFetchMock(() => jsonResponse({ error: "nope" }, { status: 422 }));

    await expect(api.post("/x", { foo: 1 })).rejects.toBeInstanceOf(ApiError);
  });
});
