import { afterEach, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { ConnectionApi } from "./connection-target.js";

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
