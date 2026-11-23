import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HealthProbe, HostedApi } from "./hosted-api.js";
import {
  classifyFailure, connections, freshConnectionFetch, newRequestId, REQUEST_ID_HEADER, summarizeFailures, failureLines, type ClientClock, type FailureDiagnosis,
} from "./hosted-diagnostics.js";
import { hostedGate } from "./hosted-gate.js";
import { hostedTarget } from "./hosted-guard.js";
import type { HealthSample } from "./hosted-release.js";

const host = "release-proof-1.staging.paperclip.app";
const target = hostedTarget(`https://${host}`, host);
const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); });

const clock = (overrides: Partial<ClientClock> = {}): ClientClock => ({ timeoutMs: 10_000, elapsedMs: 40, monotonicMs: 40, timerLagMs: null, clockJumpMs: 0,
  loopDelayMaxMs: 25, gapBeforeMs: 1_960, intervalMs: 2_000, ...overrides });
const ok = { url: "https://www.cloudflare.com/cdn-cgi/trace", ok: true, status: 200, ms: 35, error: null, remoteAddress: "104.16.124.96" };
const down = { ...ok, ok: false, status: null, ms: 42, error: { name: "TypeError", message: "fetch failed", code: "ENETUNREACH" } };
const diagnosis = (overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({ url: "/api/health", method: "GET", aborted: false, answer: null,
  cause: { name: "Error", message: "fetch failed: read ECONNRESET", code: "ECONNRESET", errno: -54, syscall: "read" }, connection: null, clock: clock(), control: ok, retry: ok, ...overrides });

function resetError(): TypeError {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET",
    socket: { localAddress: "192.168.1.20", localPort: 51799, remoteAddress: "66.33.22.11", remotePort: 443, remoteFamily: "IPv4", timeout: undefined, bytesWritten: 612, bytesRead: 0 } });
  return new TypeError("fetch failed", { cause });
}

const sample = (at: number, failure: FailureDiagnosis | null): HealthSample => ({ at, ok: failure === null, status: failure?.answer?.status ?? (failure ? null : 200), ms: 40,
  processStartedAt: null, commit: null, ...(failure ? { failure: { ...failure, ...classifyFailure(failure) } } : {}) });

const gateInput = (healthSamples: HealthSample[]) => ({ handsOffPass: true, wantedReleases: 0, createErrors: 0, slotEvidenceMissing: [] as string[],
  r1: [{ identifier: "GIT-1", result: { verdict: "pass" as const, detail: "done" } }], bannersShown: 0,
  health: { requests: healthSamples.length, failures: healthSamples.filter(entry => !entry.ok).length, slow: 0, longestGapMs: 2_000, longestGap: null },
  healthClasses: summarizeFailures(healthSamples), duplicates: { overlappingRuns: [], duplicateComments: [], duplicateChildren: [] }, releases: [], metrics: [] });

describe("gate D failure classifier", () => {
  it("counts a reset as server-side when the control probe to the neutral endpoint succeeded", () => {
    expect(classifyFailure(diagnosis())).toMatchObject({ class: "server", reason: expect.stringContaining("connection reset (ECONNRESET)") });
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED" } })).class).toBe("server");
  });

  it("counts a reset as client-side when the control probe failed too", () => {
    expect(classifyFailure(diagnosis({ control: down }))).toMatchObject({ class: "client", reason: expect.stringContaining("control probe") });
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "connect timeout", code: "UND_ERR_CONNECT_TIMEOUT" },
      control: { ...down, error: { name: "TimeoutError", message: "aborted" } } })).class).toBe("client");
  });

  it("counts a stalled client timer as client-side even when the control probe succeeded", () => {
    const slept = diagnosis({ aborted: true, cause: { name: "TimeoutError", message: "The operation was aborted due to timeout" },
      clock: clock({ elapsedMs: 18_500, monotonicMs: 10_020, timerLagMs: 8_500, clockJumpMs: 8_480 }) });
    expect(classifyFailure(slept)).toMatchObject({ class: "client", reason: expect.stringMatching(/^client_stall: the 10000 ms abort fired after 18500 ms/) });
    expect(classifyFailure(diagnosis({ clock: clock({ gapBeforeMs: 16_000 }) })).reason).toMatch(/^client_stall: the probe loop paused 16000 ms/);
    expect(classifyFailure(diagnosis({ clock: clock({ loopDelayMaxMs: 4_000 }) })).reason).toMatch(/^client_stall: the event loop was blocked/);
    const onTime = diagnosis({ aborted: true, cause: { name: "TimeoutError", message: "aborted" }, clock: clock({ elapsedMs: 10_004, monotonicMs: 10_004, timerLagMs: 4 }) });
    expect(classifyFailure(onTime)).toMatchObject({ class: "server", reason: expect.stringContaining("timeout") });
  });

  it("counts a client DNS failure as client-side", () => {
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "getaddrinfo EAI_AGAIN", code: "EAI_AGAIN", hostname: host } })).class).toBe("client");
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "getaddrinfo ENOTFOUND", code: "ENOTFOUND", hostname: host } })).class).toBe("client");
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "getaddrinfo ENOTFOUND", code: "ENOTFOUND", hostname: host },
      retry: { ...down, error: { name: "Error", message: "getaddrinfo ENOTFOUND", code: "ENOTFOUND" } } })).class).toBe("unclassified");
  });

  it("leaves a failure without enough evidence unclassified, and gate D fails on it", () => {
    const bare = diagnosis({ cause: { name: "TypeError", message: "fetch failed" }, control: null, retry: null });
    expect(classifyFailure(bare).class).toBe("unclassified");
    expect(classifyFailure(diagnosis({ cause: { name: "Error", message: "certificate has expired", code: "CERT_HAS_EXPIRED" } })).class).toBe("unclassified");
    expect(classifyFailure(undefined)).toEqual({ class: "unclassified", reason: "no diagnosis recorded" });
    const gate = hostedGate(gateInput([sample(1, null), sample(2, bare)]));
    expect(gate.pass).toBe(false);
    expect(gate.lines).toContain("- FAIL health probes: 1 of 2 failed (0 server-side, 1 unclassified, 0 client-side, informational)");
  });

  it("passes gate D with only client-side failures and keeps them visible as informational lines", () => {
    const samples = [sample(Date.parse("2026-11-23T08:05:35.000Z"), diagnosis({ control: down })), sample(Date.parse("2026-11-23T08:05:37.000Z"), null)];
    const gate = hostedGate(gateInput(samples));
    expect(gate).toMatchObject({ pass: true, healthFailures: 0, healthClientSide: 1 });
    expect(gate.lines).toContain("- pass health probes: 1 of 2 failed (0 server-side, 0 unclassified, 1 client-side, informational)");
    const lines = failureLines("Health probe failures", summarizeFailures(samples));
    expect(lines[0]).toBe("Health probe failures: 0 server-side, 0 unclassified, 1 client-side (informational, not counted by gate D).");
    expect(lines[1]).toMatch(/^- 2026-11-23T08:05:35\.000Z client-side \(informational\): the control probe .*Evidence: ECONNRESET read; .*control failed ENETUNREACH in 42 ms; retry ok 200/);
    expect(hostedGate(gateInput([sample(1, diagnosis())])).pass).toBe(false);
    const { healthClasses: _ignored, ...withoutClasses } = gateInput([sample(1, diagnosis({ control: down }))]);
    expect(hostedGate(withoutClasses).pass).toBe(false);
  });
});

describe("hosted request failure recording", () => {
  it("records the 503's status, headers, body excerpt, parsed error and statusPage code, and counts it server-side", async () => {
    const body = JSON.stringify({ error: "Workspace is waking up", statusPage: { code: "idle_sweep" }, padding: "x".repeat(2_000) });
    const headers = { "x-paperclip-status": "waking", "retry-after": "5", server: "railway-edge", via: "1.1 railway", "x-railway-request-id": "req-1", "x-railway-edge": "edge-1",
      "cf-ray": "8f-SJC", date: "Mon, 23 Nov 2026 08:05:35 GMT", "content-type": "application/json", "cache-control": "no-store", connection: "keep-alive", "set-cookie": "secret=1" };
    const controlCalls: string[] = [];
    const api = new HostedApi(target, "t", 1_000, (async () => new Response(body, { status: 503, headers })) as unknown as typeof fetch,
      { control: (async (url: string) => { controlCalls.push(url); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch });
    const health = await api.health();
    expect(health).toMatchObject({ ok: false, status: 503 });
    const failure = health.failure!;
    expect(failure).toMatchObject({ class: "server", reason: "HTTP 503", url: "/api/health", method: "GET" });
    expect(failure.answer).toMatchObject({ status: 503, error: "Workspace is waking up", statusPageCode: "idle_sweep" });
    const { "set-cookie": _cookie, ...kept } = headers;
    expect(failure.answer!.headers).toEqual(kept);
    expect(Buffer.byteLength(failure.answer!.bodyExcerpt)).toBe(512);
    expect(failure.control).toMatchObject({ ok: true, status: 200 });
    expect(failure.retry).toMatchObject({ ok: false, status: 503 });
    expect(controlCalls).toEqual(["https://www.cloudflare.com/cdn-cgi/trace"]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.failure).toBe(failure);
  });

  it("records undici's error cause and socket for a reset, and classifies it by the control probe", async () => {
    const reset = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    const sampleOk = await reset.health();
    expect(sampleOk.error).toBe("fetch failed (UND_ERR_SOCKET)");
    expect(sampleOk.failure).toMatchObject({ class: "server", cause: { code: "UND_ERR_SOCKET", message: "fetch failed: other side closed",
      socket: { localAddress: "192.168.1.20", localPort: 51799, remoteAddress: "66.33.22.11", remotePort: 443, bytesWritten: 612, bytesRead: 0 } } });
    const flaky = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH", syscall: "connect" }) }); }) as unknown as typeof fetch });
    expect((await flaky.health()).failure).toMatchObject({ class: "client", control: { ok: false, error: { code: "ENETUNREACH", syscall: "connect" } } });
  });

  it("does not repeat a failed non-GET request as the immediate retry", async () => {
    let calls = 0;
    const api = new HostedApi(target, "t", 1_000, (async () => { calls += 1; throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    await expect(api.post("/api/companies/c1/issues", { title: "x" })).rejects.toThrow(/unreachable: fetch failed \(UND_ERR_SOCKET\)/);
    expect(calls).toBe(1);
    expect(api.requests[0]!.failure).toMatchObject({ retry: null, control: { ok: true }, class: "server" });
  });

  it("passes the gap before each probe to the health check", async () => {
    const seen: Array<number | null> = [];
    const probe = new HealthProbe({ health: async context => { seen.push(context?.gapBeforeMs ?? null); return sample(Date.now(), null); } }, 5).start();
    while (seen.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
    await probe.stop();
    expect(seen[0]).toBeNull();
    expect(seen.slice(1).every(gap => gap !== null && gap >= 0 && gap < 1_000)).toBe(true);
  });
});

describe("connection evidence", () => {
  async function listen(handler: http.RequestListener): Promise<{ url: string; ports: number[] }> {
    const ports: number[] = [];
    const server = http.createServer((request, response) => { ports.push((request.socket as Socket).remotePort!); handler(request, response); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`, ports };
  }

  it("opens a fresh connection for every health probe and records its phases", async () => {
    const { url, ports } = await listen((_request, response) => response.end("{}"));
    for (let index = 0; index < 2; index += 1) {
      const id = newRequestId();
      const response = await freshConnectionFetch(url, { headers: { [REQUEST_ID_HEADER]: id } });
      expect(await response.text()).toBe("{}");
      expect(connections.take(id)).toMatchObject({ reused: false, remoteAddress: "127.0.0.1", connectMs: expect.any(Number), ttfbMs: expect.any(Number) });
    }
    expect(new Set(ports).size).toBe(2);
  });

  it("tags an API request's socket as new or reused", async () => {
    connections.subscribe();
    const { url, ports } = await listen((_request, response) => response.end("{}"));
    const tags: Array<boolean | null> = [];
    for (let index = 0; index < 2; index += 1) {
      const id = newRequestId();
      await (await fetch(url, { headers: { [REQUEST_ID_HEADER]: id } })).text();
      await new Promise(resolve => setTimeout(resolve, 20));
      tags.push(connections.take(id)?.reused ?? null);
    }
    expect(tags).toEqual([false, true]);
    expect(new Set(ports).size).toBe(1);
  });

  it("reports a reset on a fresh connection with the socket's addresses and byte counts", async () => {
    const { url } = await listen(request => request.socket.destroy());
    const error = await freshConnectionFetch(url).catch(caught => caught as TypeError);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError & { cause: { code: string; socket: Record<string, unknown> } }).cause).toMatchObject({ code: "ECONNRESET",
      socket: { remoteAddress: "127.0.0.1", bytesWritten: expect.any(Number) } });
  });
});
