import { afterEach, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { ConnectionApi } from "./connection-target.js";
import { createServer } from "node:http";

afterEach(() => vi.unstubAllGlobals());
it("uses same-origin session cookies without sending fixture credentials through the traced request transport", async () => {
  const cookie = (domain: string, path = "/") => ({ name: domain, value: "session", domain, path, expires: -1, secure: true });
  const request = { storageState: vi.fn(async () => ({ cookies: [cookie("qa.example.test"), cookie("other.example.test"), cookie("qa.example.test", "/other"), cookie("qa.example.test", "/api/company")] })),
    fetch: vi.fn(() => { throw new Error("Sensitive body reached the traced transport"); }) };
  const send = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ Origin: "https://qa.example.test", Cookie: "qa.example.test=session" });
    expect(options.body).toBe(JSON.stringify({ credential: "fixture-only" }));
    return Response.json({ id: "owned-connection" });
  });
  vi.stubGlobal("fetch", send);
  const api = new ConnectionApi(request as unknown as APIRequestContext, "https://qa.example.test");
  await expect(api.postSensitive("/api/companies/owned/tools/apps/connect", { credential: "fixture-only" })).resolves.toEqual({ id: "owned-connection" });
  expect(request.fetch).not.toHaveBeenCalled();
  await expect(api.postSensitive("https://other.example.test/api/key", {})).rejects.toThrow("invalid_api_route");
  await expect(api.postSensitive("/login", {})).rejects.toThrow("invalid_api_route");
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["/api/companies", "/api/companies/", "/api/companies/owned/tools/apps/connect"])("sends a cookie scoped to the exact path or a containing directory: %s", async (path) => {
  const request = { storageState: async () => ({ cookies: [{ name: "scoped", value: "session", domain: "qa.example.test", path, expires: -1, secure: true }] }) } as unknown as APIRequestContext;
  const send = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Cookie: "scoped=session" });
    return Response.json({ id: "owned" });
  });
  vi.stubGlobal("fetch", send);
  await new ConnectionApi(request, "https://qa.example.test").postSensitive("/api/companies/owned/tools/apps/connect", {});
  expect(send).toHaveBeenCalledOnce();
});
it("withholds provider bodies and thrown transport details on sensitive failures", async () => {
  const request = { storageState: async () => ({ cookies: [] }) } as unknown as APIRequestContext;
  const api = new ConnectionApi(request, "https://qa.example.test");
  vi.stubGlobal("fetch", async () => new Response("SECRET response", { status: 400 }));
  await expect(api.postSensitive("/api/connection", {})).rejects.toThrow("api_status_400");
  vi.stubGlobal("fetch", async () => { throw new Error("SECRET transport"); });
  await expect(api.postSensitive("/api/connection", {})).rejects.toThrow("sensitive_api_request_failed");
});

it.each(["cancel", "deadline"])("retires the actual sensitive HTTP request on %s", async mode => {
  let entered!: () => void, retired!: () => void;
  const received = new Promise<void>(resolve => { entered = resolve; });
  const closed = new Promise<void>(resolve => { retired = resolve; });
  const server = createServer((_req, response) => { response.once("close", retired); entered(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address() as { port: number };
    const request = { storageState: async () => ({ cookies: [] }) } as unknown as APIRequestContext;
    const controller = new AbortController();
    const send = new ConnectionApi(request, `http://127.0.0.1:${address.port}`).postSensitive("/api/owned", { fixture: true },
      { signal: controller.signal, timeoutMs: mode === "deadline" ? 1000 : 3000 });
    const rejected = expect(send).rejects.toThrow("sensitive_api_request_failed");
    // A heavily delayed dispatch can time out before reaching the listener.
    // Report that failure and still clean up, rather than hanging on `received`.
    const first = await Promise.race([received.then(() => "received"), send.then(() => "settled", () => "settled")]);
    if (mode === "cancel") controller.abort();
    await rejected;
    expect(first).toBe("received");
    await closed;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("does not dispatch a sensitive mutation if cancellation happens while loading cookies", async () => {
  const controller = new AbortController();
  const request = { storageState: async () => { controller.abort(); return { cookies: [] }; } } as unknown as APIRequestContext;
  const send = vi.fn(); vi.stubGlobal("fetch", send);
  await expect(new ConnectionApi(request, "https://qa.example.test").postSensitive("/api/owned", {}, { signal: controller.signal }))
    .rejects.toThrow("sensitive_api_request_failed");
  expect(send).not.toHaveBeenCalled();
});
