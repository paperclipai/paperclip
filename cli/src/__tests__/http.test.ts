import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConnectionError, ApiReadbackMismatchError, ApiRequestError, PaperclipApiClient } from "../client/http.js";

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
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("sends JSON mutations as UTF-8 bytes with an explicit charset", async () => {
    const payload = { body: "Кириллица сохранена" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });
    await expect(client.post("/api/issues/UTF-8/comments", payload)).resolves.toEqual(payload);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>)["content-type"]).toBe("application/json; charset=utf-8");
    expect((request.headers as Record<string, string>)["content-digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:/);
    expect(request.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(request.body as Uint8Array)).toBe(JSON.stringify(payload));
  });

  it("stops on a text readback mismatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ body: "????" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/UTF-8/comments", { body: "Кириллица сохранена" }))
      .rejects.toBeInstanceOf(ApiReadbackMismatchError);
  });

  it("checks child and nested interaction text against their authoritative responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ issue: { title: "Дочерняя задача", description: "Описание" } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ interaction: { payload: { prompt: "Нужно решение", steps: [{ message: "Первый шаг" }] }, result: { summaryMarkdown: "Нужно решение" } } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/parent/children", { title: "Дочерняя задача", description: "Описание" })).resolves.toBeTruthy();
    await expect(client.post("/api/issues/parent/interactions", { payload: { prompt: "Нужно решение", steps: [{ message: "Первый шаг" }] } })).resolves.toBeTruthy();
  });

  it.each([200, 201, 204])("rejects an empty %i response for a recognized text mutation", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/parent/interactions", { payload: { prompt: "Нужно решение" } }))
      .rejects.toBeInstanceOf(ApiReadbackMismatchError);
  });

  it("checks all persisted interaction and decision contract text recursively", async () => {
    const detailsMarkdown = "\u0414\u0435\u0442\u0430\u043b\u0438 \u0432 payload";
    const acceptLabel = "\u041f\u0440\u0438\u043d\u044f\u0442\u044c";
    const rejectLabel = "\u041e\u0442\u043a\u043b\u043e\u043d\u0438\u0442\u044c";
    const customField = "\u041f\u0440\u043e\u0438\u0437\u0432\u043e\u043b\u044c\u043d\u043e\u0435 \u043f\u043e\u043b\u0435";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "request_confirmation",
        payload: { detailsMarkdown, acceptLabel, rejectLabel },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ decision: { inputValues: { customField } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/parent/interactions", {
      kind: "request_confirmation",
      idempotencyKey: "run:confirmation",
      payload: { version: 1, detailsMarkdown, acceptLabel, rejectLabel },
    })).resolves.toBeTruthy();
    await expect(client.post("/api/decisions/decision-1/decide", {
      optionId: "approve",
      idempotencyKey: "run:decision",
      inputValues: { customField },
    })).resolves.toBeTruthy();
  });

  it("stops when an arbitrary decision input is absent from authoritative readback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ decision: { inputValues: {} } }), { status: 200 }),
    ));
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/decisions/decision-1/decide", {
      optionId: "approve",
      inputValues: { customField: "\u041a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430" },
    })).rejects.toBeInstanceOf(ApiReadbackMismatchError);
  });

  it("rejects a structurally swapped interaction text readback", async () => {
    const title = "Заголовок";
    const prompt = "Подтвердите действие";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      interaction: { title: prompt, payload: { prompt: title, steps: ["один", "два"] } },
    }), { status: 201 })));
    const client = new PaperclipApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/parent/interactions", {
      kind: "request_confirmation",
      title,
      payload: { prompt, steps: ["один", "два"] },
    })).rejects.toBeInstanceOf(ApiReadbackMismatchError);
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
