import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { pollUntil, RunnerApi, RunnerApiHttpError } from "./api.js";
const response = (status: number, data: unknown = {}): APIResponse => ({
  ok: () => status >= 200 && status < 300, status: () => status,
  json: async () => data, text: async () => JSON.stringify(data), url: () => "http://fixture.invalid/instructions",
}) as APIResponse;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("fixture instruction revision fence", () => {
  function api(current: APIResponse, saved = response(200)) {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
    const request = { get: vi.fn(async () => current), put: vi.fn(async () => saved) };
    return { request, api: new RunnerApi(request as unknown as APIRequestContext) };
  }
  it.each([[404, {}, null], [200, { contentHash: "current-hash" }, "current-hash"]])("saves from a %s read with its exact base", async (status, detail, baseHash) => {
    const fixture = api(response(status as number, detail));
    await fixture.api.saveAgentInstructions("agent", "Fixture instructions");
    expect(fixture.request.get).toHaveBeenCalledWith("/api/agents/agent/instructions-bundle/file?path=AGENTS.md");
    expect(fixture.request.put).toHaveBeenCalledExactlyOnceWith("/api/agents/agent/instructions-bundle/file", {
      data: { path: "AGENTS.md", content: "Fixture instructions", baseHash },
    });
  });
  it.each([response(403), response(500), response(200, {})])("never treats a failed or incomplete read as a new file", async current => {
    const fixture = api(current);
    await expect(fixture.api.saveAgentInstructions("agent", "Fixture instructions")).rejects.toThrow();
    expect(fixture.request.put).not.toHaveBeenCalled();
  });
  it("surfaces a concurrent edit without retrying or overwriting it", async () => {
    const fixture = api(response(200, { contentHash: "old" }), response(409, { error: "Revision conflict" }));
    await expect(fixture.api.saveAgentInstructions("agent", "Fixture instructions")).rejects.toThrow("409");
    expect(fixture.request.get).toHaveBeenCalledTimes(1);
    expect(fixture.request.put).toHaveBeenCalledTimes(1);
  });
});


it("passes a bounded GET timeout to the request transport without changing its response", async () => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const get = vi.fn(async () => response(200, { status: "running" }));
  const api = new RunnerApi({ get } as unknown as APIRequestContext);
  await expect(api.get("/api/heartbeat-runs/run", { timeout: 1234 })).resolves.toEqual({ status: "running" });
  expect(get).toHaveBeenCalledExactlyOnceWith("/api/heartbeat-runs/run", { timeout: 1234 });
});


it("preserves GET HTTP status separately from diagnostic text", async () => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const api = new RunnerApi({ get: vi.fn(async () => response(503, { error: "PRIVATE" })) } as unknown as APIRequestContext);
  const error = await api.get("/api/environments/env/leases").catch(error => error);
  expect(error).toBeInstanceOf(RunnerApiHttpError);
  if (!(error instanceof RunnerApiHttpError)) throw new Error("Expected typed HTTP error");
  expect(error.status).toBe(503);
});


it("a strict observation cannot pass after first observing invalid evidence", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("invalid evidence")).mockResolvedValue(true);
  await expect(pollUntil({ label: "strict proof", deadlineAt: Date.now() + 1000,
    load, accept: Boolean, intervalMs: 1, retryOnError: () => false })).rejects.toThrow("invalid evidence");
  expect(load).toHaveBeenCalledTimes(1);
});


it("keeps existing polling retries when the strict error policy is absent", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("temporary transport failure")).mockResolvedValue(true);
  await expect(pollUntil({ label: "ordinary state", deadlineAt: Date.now() + 1000,
    load, accept: Boolean, intervalMs: 1 })).resolves.toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

it("observes identical native poll results with the actual actor and no traced request", async () => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const get = vi.fn(() => { throw new Error("Poll must not enter the Playwright API recorder"); });
  const api = new RunnerApi({ get } as unknown as APIRequestContext);
  api.setBrowserSession("synthetic-cookie");
  const rows = [{ id: "11111111-1111-4111-8111-111111111111", status: "running" }];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(rows), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const endpoint = "/api/companies/22222222-2222-4222-8222-222222222222/heartbeat-runs?limit=100";
  await expect(api.getRunObservation(endpoint, { timeout: 1234 })).resolves.toEqual(rows);
  expect(get).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![0])).toBe(`http://127.0.0.1:3100${endpoint}`);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error", headers: { Cookie: "synthetic-cookie", Origin: "http://127.0.0.1:3100" } });
  expect((fetcher.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
});
it("keeps local-trusted run observations cookie-free and preserves typed HTTP failure without retry", async () => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const api = new RunnerApi({} as APIRequestContext);
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("private failure body", { status: 403 })); vi.stubGlobal("fetch", fetcher);
  await expect(api.getRunObservation("/api/heartbeat-runs/11111111-1111-4111-8111-111111111111/events?afterSeq=0&limit=1000")).rejects.toMatchObject({ name: "RunnerApiHttpError", status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { "content-type": "application/json" } });
  expect((fetcher.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("Cookie");
});
it.each([
  "https://foreign.invalid/api/heartbeat-runs/11111111-1111-4111-8111-111111111111",
  "/api/companies/22222222-2222-4222-8222-222222222222/agents",
  "/api/heartbeat-runs/11111111-1111-4111-8111-111111111111?token=anything",
  "/api/heartbeat-runs/11111111-1111-4111-8111-111111111111/events?afterSeq=0&limit=10&extra=1",
])("rejects non-observation transport target %s before dispatch", async endpoint => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(new RunnerApi({} as APIRequestContext).getRunObservation(endpoint)).rejects.toThrow("allowlisted same-origin GET");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([200, 204, 404, 409])("forwards the cleanup request timeout and preserves DELETE status %s", async status => {
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
  const remove = vi.fn(async () => response(status));
  const api = new RunnerApi({ delete: remove } as unknown as APIRequestContext);
  const result = api.delete("/api/environments/environment", { allowNotFound: true, timeout: 500 });
  if (status === 409) await expect(result).rejects.toThrow("409");
  else await expect(result).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledExactlyOnceWith("/api/environments/environment", { timeout: 500 });
});
