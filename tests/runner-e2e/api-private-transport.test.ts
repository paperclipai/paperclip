import { afterEach, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { RunnerApi, RunnerApiHttpError } from "./api.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() { vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100"); const instrumented = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }; const api = new RunnerApi(instrumented as unknown as APIRequestContext); api.setBrowserSession("synthetic-session-cookie-928364"); return { api, instrumented }; }
it("keeps cookie requests outside Test while preserving actual query/body/JSON and attachment bytes", async () => {
  const { api, instrumented } = fixture(); const calls: Array<{ url: string; options: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => { calls.push({ url: url.href, options }); return url.pathname.endsWith("/content") ? new Response(Buffer.from([0, 1, 255])) : Response.json({ actualProductValue: "unredacted-product-oracle-canary" }); }));
  await expect(api.get("/api/issues?limit=2", { timeout: 1234 })).resolves.toEqual({ actualProductValue: "unredacted-product-oracle-canary" });
  await api.post("/api/issues", { title: "synthetic" }); await api.patch("/api/issues/one", { status: "backlog" }); await api.delete("/api/issues/one");
  await expect(api.getAttachmentContent("11111111-1111-4111-8111-111111111111")).resolves.toEqual(Buffer.from([0, 1, 255]));
  expect(calls[0]?.url).toBe("http://127.0.0.1:3100/api/issues?limit=2"); expect(calls.map(call => call.options.method)).toEqual(["GET", "POST", "PATCH", "DELETE", "GET"]);
  expect(calls[1]?.options.body).toBe(JSON.stringify({ title: "synthetic" }));
  for (const call of calls) { expect(call.options.redirect).toBe("error"); expect(call.options.headers).toMatchObject({ Cookie: "synthetic-session-cookie-928364", Origin: "http://127.0.0.1:3100" }); }
  for (const method of Object.values(instrumented)) expect(method).not.toHaveBeenCalled();
});
it("rejects cross-origin/path escapes before transport and withholds status/error response bodies", async () => {
  const { api } = fixture(); const transport = vi.fn(async () => new Response("private-response-canary-123456", { status: 403 })); vi.stubGlobal("fetch", transport);
  await expect(api.get("https://foreign.invalid/api/issues")).rejects.toThrow("fixture API"); await expect(api.post("/api/../private", {})).rejects.toThrow("fixture API"); expect(transport).not.toHaveBeenCalled();
  const failure = await api.get("/api/private?private=value").catch(error => error); expect(failure).toBeInstanceOf(RunnerApiHttpError); if (!(failure instanceof RunnerApiHttpError)) throw new Error("Expected typed HTTP status"); expect(failure.status).toBe(403);
  expect(failure.message).toBe("GET /api/private returned 403; body withheld"); expect(failure.message).not.toContain("private-response-canary");
  await expect(api.delete("/api/missing", { allowNotFound: true })).rejects.toThrow("403");
  transport.mockImplementation(async () => new Response(null, { status: 404 })); await expect(api.delete("/api/missing", { allowNotFound: true })).resolves.toBeUndefined();
  transport.mockImplementation(async () => { throw new Error("synthetic-session-cookie-928364 private network error"); });
  await expect(api.get("/api/issues")).rejects.toThrow("details withheld");
});
it("uses sensitive PATCH outside Test with same session boundary and no raw parse or error diagnostics", async () => {
  const { api, instrumented } = fixture(); const transport = vi.fn(async (_url: URL, _options: RequestInit) => Response.json({ saved: true })); vi.stubGlobal("fetch", transport);
  await expect(api.patchSensitive("/api/agents/one", { privateReference: "synthetic-value" })).resolves.toEqual({ saved: true });
  expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", redirect: "error", body: JSON.stringify({ privateReference: "synthetic-value" }) }); expect(instrumented.patch).not.toHaveBeenCalled();
  transport.mockImplementation(async () => new Response("not-json-private-value"));
  await expect(api.patchSensitive("/api/agents/one", {})).rejects.toThrow("response body withheld");
});

it("surfaces a bounded product validation reason for 400/409/422 without request values, details or the session", async () => {
  const { api } = fixture();
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", reply(422, { error: "Built-in fake sandbox environments are reserved for internal probes and cannot be saved.", details: { issues: [{ received: "private-detail-canary" }] } }));
  const failure = await api.post("/api/companies/c/environments", { name: "control", config: { provider: "fake" } }).catch((error: Error) => error) as Error;
  expect(failure).toBeInstanceOf(RunnerApiHttpError); expect((failure as RunnerApiHttpError).status).toBe(422);
  expect(failure.message).toBe("POST /api/companies/c/environments returned 422; reason: Built-in fake sandbox environments are reserved for internal probes and cannot be saved.; other body fields withheld");
  expect(failure.message).not.toContain("private-detail-canary");
  vi.stubGlobal("fetch", reply(400, { error: "Invalid apiKey private-request-value-123 for synthetic-session-cookie-928364 token abcdefghijklmnopqrstuvwxyzABCDEFGHIJ" }));
  const echoed = await api.post("/api/x", { apiKey: "private-request-value-123" }).catch((error: Error) => error) as Error;
  expect(echoed.message).toContain("reason: Invalid apiKey [redacted] for [redacted] token [redacted]");
  for (const canary of ["private-request-value-123", "synthetic-session-cookie-928364", "abcdefghijklmnopqrstuvwxyz"]) expect(echoed.message).not.toContain(canary);
  vi.stubGlobal("fetch", reply(409, { error: "word ".repeat(400) }));
  expect((await api.post("/api/x", {}).catch((error: Error) => error) as Error).message).toBe(`POST /api/x returned 409; reason: ${"word ".repeat(48).slice(0, 240)}...; other body fields withheld`);
  for (const [status, body] of [[403, { error: "private-403-canary" }], [500, { error: "private-500-canary" }], [422, "not-json-private-canary"], [422, { message: "no-error-field-canary" }]] as const) {
    vi.stubGlobal("fetch", reply(status, body));
    const other = await api.post("/api/x", {}).catch((error: Error) => error) as Error;
    expect(other.message).toBe(`POST /api/x returned ${status}; body withheld`);
  }
});
