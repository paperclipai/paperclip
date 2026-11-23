import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HealthProbe, HostedApi } from "./hosted-api.js";
import {
  answerEvidence, classifyFailure, connections, failureLines, followUp, freshConnectionFetch, newRequestId, REQUEST_ID_HEADER, summarizeFailures, type ClientClock, type FailureDiagnosis,
} from "./hosted-diagnostics.js";
import { hostedGate } from "./hosted-gate.js";
import { hostedTarget } from "./hosted-guard.js";
import { watchIdentity } from "./hosted-main.js";
import { detectReleases, type HealthSample } from "./hosted-release.js";

const host = "release-proof-1.staging.paperclip.app";
const target = hostedTarget(`https://${host}`, host);
const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); });

const clock = (overrides: Partial<ClientClock> = {}): ClientClock => ({ timeoutMs: 10_000, elapsedMs: 40, monotonicMs: 40, timerLagMs: null, clockJumpMs: 0,
  loopDelayMaxMs: 25, gapBeforeMs: 1_960, intervalMs: 2_000, ...overrides });
const ok = { url: "https://www.cloudflare.com/cdn-cgi/trace", ok: true, status: 200, ms: 35, error: null, remoteAddress: "104.16.124.96" };
const down = { ...ok, ok: false, status: null, ms: 42, error: { name: "TypeError", message: "fetch failed", code: "ENETUNREACH" } };
const diagnosis = (overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({ url: "/api/health", method: "GET", aborted: false, answer: null,
  cause: { name: "Error", message: "fetch failed: read ECONNRESET", code: "ECONNRESET", errno: -54, syscall: "read" }, connection: null, clock: clock(), control: ok, retry: ok,
  controlReachedThisRun: true, ...overrides });

function resetError(): TypeError {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET",
    socket: { localAddress: "192.168.1.20", localPort: 51799, remoteAddress: "66.33.22.11", remotePort: 443, remoteFamily: "IPv4", timeout: undefined, bytesWritten: 612, bytesRead: 0 } });
  return new TypeError("fetch failed", { cause });
}

const sample = (at: number, failure: FailureDiagnosis | null): HealthSample => ({ at, ok: failure === null, status: failure?.answer?.status ?? (failure ? null : 200), ms: 40,
  processStartedAt: null, commit: null, ...(failure ? { failure: { ...failure, ...classifyFailure(failure), state: "settled" as const } } : {}) });

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

  it("does not trust a failed control probe when the neutral endpoint never answered in this run", () => {
    expect(classifyFailure(diagnosis({ control: down, controlReachedThisRun: false }))).toMatchObject({ class: "unclassified",
      reason: expect.stringContaining("has not answered once in this run") });
    const blocked = [{ at: 0, ok: true, status: 200, ms: 40, processStartedAt: "old", commit: "c" }, sample(2_000, diagnosis({ control: down, controlReachedThisRun: false })),
      { at: 4_000, ok: true, status: 200, ms: 40, processStartedAt: "new", commit: "c" }];
    expect(detectReleases(blocked, { now: 600_000 })[0]!.shape).toBe("stop_then_start");
    expect(hostedGate(gateInput(blocked)).pass).toBe(false);
  });

  it("counts a pending diagnosis as unclassified in the summary", () => {
    const pending = sample(1, diagnosis({ control: down }));
    pending.failure = { ...pending.failure!, state: "pending" };
    expect(summarizeFailures([pending]).failures[0]).toMatchObject({ class: "unclassified", reason: "diagnosis did not finish before the grade" });
    pending.failure = { ...pending.failure!, class: "client" };
    const gap = [{ at: 0, ok: true, status: 200, ms: 40, processStartedAt: "old", commit: "c" }, { ...pending, at: 2_000 },
      { at: 4_000, ok: true, status: 200, ms: 40, processStartedAt: "new", commit: "c" }];
    expect(detectReleases(gap, { now: 600_000 })[0]!.shape).toBe("stop_then_start");
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

  it("fails gate D on a failed health report whose samples are missing from the class summary", () => {
    const failedReport = { ...gateInput([]), health: { requests: 10, failures: 1, slow: 0, longestGapMs: 2_000, longestGap: null } };
    const withEmptySummary = hostedGate(failedReport);
    expect(withEmptySummary).toMatchObject({ pass: false, healthFailures: 1 });
    expect(withEmptySummary.lines).toContain("- FAIL health probes: 1 of 10 failed (0 server-side, 1 unclassified, 0 client-side, informational)");
    const { healthClasses: _ignored, ...withoutSummary } = failedReport;
    expect(hostedGate(withoutSummary)).toMatchObject({ pass: false, healthFailures: 1 });
  });

  it("does not call a release stop-then-start for a client-side failure in the swap gap", () => {
    const answer = (at: number, processStartedAt: string): HealthSample => ({ at, ok: true, status: 200, ms: 40, processStartedAt, commit: "c" });
    const withGapFailure = (failure: FailureDiagnosis) => [answer(0, "old"), answer(2_000, "old"), sample(4_000, failure), answer(6_000, "new"), answer(8_000, "new")];
    const client = detectReleases(withGapFailure(diagnosis({ control: down })), { now: 600_000 });
    expect(client).toHaveLength(1);
    expect(client[0]).toMatchObject({ shape: "clean_switch", failedRequests: 0, firstFailureAt: null });
    expect(detectReleases(withGapFailure(diagnosis()), { now: 600_000 })[0]).toMatchObject({ shape: "stop_then_start", failedRequests: 1 });
    const unclassified = diagnosis({ cause: { name: "TypeError", message: "fetch failed" }, control: null, retry: null });
    expect(detectReleases(withGapFailure(unclassified), { now: 600_000 })[0]!.shape).toBe("stop_then_start");
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
    await api.settleDiagnostics();
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
    await reset.settleDiagnostics();
    expect(sampleOk.error).toBe("fetch failed (UND_ERR_SOCKET)");
    expect(sampleOk.failure).toMatchObject({ class: "server", cause: { code: "UND_ERR_SOCKET", message: "fetch failed: other side closed",
      socket: { localAddress: "192.168.1.20", localPort: 51799, remoteAddress: "66.33.22.11", remotePort: 443, bytesWritten: 612, bytesRead: 0 } } });
    let controlUp = true;
    const flaky = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => {
        if (controlUp) return new Response("ok", { status: 200 });
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH", syscall: "connect" }) });
      }) as unknown as typeof fetch });
    expect(await flaky.primeControl()).toMatchObject({ ok: true });
    controlUp = false;
    await new Promise(resolve => setTimeout(resolve, 1_050));
    const flakySample = await flaky.health();
    await flaky.settleDiagnostics();
    expect(flakySample.failure).toMatchObject({ class: "client", control: { ok: false, error: { code: "ENETUNREACH", syscall: "connect" } } });
  });

  it("does not repeat a failed non-GET request as the immediate retry", async () => {
    let calls = 0;
    const api = new HostedApi(target, "t", 1_000, (async () => { calls += 1; throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    await expect(api.post("/api/companies/c1/issues", { title: "x" })).rejects.toThrow(/unreachable: fetch failed \(UND_ERR_SOCKET\)/);
    await api.settleDiagnostics();
    expect(calls).toBe(1);
    expect(api.requests[0]!.failure).toMatchObject({ retry: null, control: { ok: true }, class: "server" });
  });

  it("returns a failed probe without waiting for the control probe and attaches its evidence later", async () => {
    let release: (response: Response) => void = () => {};
    const control = (() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch;
    const api = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch, { control });
    const health = await api.health();
    expect(health.failure).toMatchObject({ class: "unclassified", reason: "diagnosis pending", control: null });
    await expect(api.post("/api/companies/c1/issues", {})).rejects.toThrow(/unreachable/);
    let written = false;
    const done = api.diagnosed(health.failure).then(() => { written = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(written).toBe(false);
    release(new Response("ok", { status: 200 }));
    await api.settleDiagnostics();
    await done;
    expect(health.failure).toMatchObject({ class: "server", control: { ok: true } });
    expect(api.requests[1]!.failure).toMatchObject({ class: "server", control: { ok: true } });
  });

  it("waits only for the frozen failures, up to a deadline, and leaves an unfinished one unclassified with the reason", async () => {
    const api = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch });
    const health = await api.health();
    expect(await api.settleDiagnostics([])).toBe(0);
    expect(await api.settleDiagnostics([health.failure], 20)).toBe(1);
    expect(health.failure).toMatchObject({ state: "pending" });
    expect(summarizeFailures([health]).failures[0]).toMatchObject({ class: "unclassified", reason: "diagnosis did not finish before the grade" });
    const gate = hostedGate(gateInput([health]));
    expect(gate.pass).toBe(false);
  });

  it("keeps a diagnosis that missed the grade's deadline pending when its evidence arrives later", async () => {
    let release: (response: Response) => void = () => {};
    const api = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch });
    const health = await api.health();
    expect(await api.settleDiagnostics([health.failure], 10)).toBe(1);
    release(new Response("ok", { status: 200 }));
    await api.diagnosed(health.failure);
    expect(health.failure).toMatchObject({ state: "pending", control: { ok: true } });
    expect(summarizeFailures([health]).unclassified).toBe(1);
  });

  it("reads the error and statusPage code from a truncated JSON body", () => {
    const truncated = `{"error":"Workspace is waking up","statusPage":{"code":"idle_sweep","title":"x"},"padding":"${"x".repeat(100)}`;
    expect(answerEvidence(503, new Headers(), truncated)).toMatchObject({ error: "Workspace is waking up", statusPageCode: "idle_sweep" });
  });

  it("skips the same-URL retry after a timeout", async () => {
    let calls = 0;
    const api = new HostedApi(target, "t", 1_000, (async () => { calls += 1; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as unknown as typeof fetch,
      { control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    const health = await api.health();
    await api.settleDiagnostics();
    expect(calls).toBe(1);
    expect(health.failure).toMatchObject({ aborted: true, retry: null, control: { ok: true }, class: "server" });
  });

  it("runs no control probe unless the live entry point or a test asks for one", async () => {
    const api = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch);
    const health = await api.health();
    await api.settleDiagnostics();
    expect(health.failure).toMatchObject({ control: null, retry: null, class: "unclassified" });
  });

  it("records a retry whose body cannot be read as failed", async () => {
    const broken = new ReadableStream({ start(controller) { controller.error(Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" })); } });
    const outcome = await followUp((async () => new Response(broken, { status: 200 })) as unknown as typeof fetch, "https://example.test/api/health", {}, 1_000);
    expect(outcome).toMatchObject({ ok: false, status: 200, error: { code: "UND_ERR_SOCKET" } });
  });

  it("writes a failed probe to health.jsonl only after its diagnosis, with the class", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-diag-"));
    const file = path.join(dir, "health.jsonl");
    const api = new HostedApi(target, "t", 1_000, (async () => { throw resetError(); }) as unknown as typeof fetch,
      { control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    const events: string[] = [];
    const onSample = watchIdentity({ add: kind => { events.push(kind); } }, file, api);
    onSample(await api.health());
    await api.settleDiagnostics();
    await new Promise(resolve => setImmediate(resolve));
    const saved = JSON.parse(await readFile(file, "utf8"));
    await rm(dir, { recursive: true, force: true });
    expect(saved.failure).toMatchObject({ class: "server", control: { ok: true } });
    expect(events).toEqual(["hosted_health_failed", "hosted_health_failure_classified"]);
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

  it("follows a same-origin redirect on a fresh connection and stops at a cross-origin one", async () => {
    const { url } = await listen((request, response) => {
      if (request.url === "/api/health") { response.writeHead(308, { location: "/api/health/" }).end(); return; }
      if (request.url === "/away") { response.writeHead(302, { location: "https://elsewhere.example/" }).end(); return; }
      response.end("{\"status\":\"ok\"}");
    });
    const followed = await freshConnectionFetch(url);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toBe("{\"status\":\"ok\"}");
    expect((await freshConnectionFetch(url.replace("/api/health", "/away"))).status).toBe(302);
  });

  it("keeps the status, headers and partial body when an answer is cut short, and counts the 503 server-side", async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "application/json", "x-paperclip-status": "draining", "content-length": "500" });
      response.write("{\"error\":\"draining\"");
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const api = new HostedApi(target, "t", 1_000, fetch, { health: ((_input: string, init: RequestInit) => freshConnectionFetch(url, init)) as unknown as typeof fetch,
      control: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    const health = await api.health();
    await api.settleDiagnostics();
    expect(health).toMatchObject({ ok: false, status: 503 });
    expect(health.failure).toMatchObject({ class: "server", reason: "HTTP 503", cause: { code: "ECONNRESET" },
      answer: { status: 503, headers: { "x-paperclip-status": "draining" }, bodyExcerpt: "{\"error\":\"draining\"" } });
  });

  it("stops reading a large non-2xx body and still keeps its parsed error and statusPage code", async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Workspace is waking up", statusPage: { code: "idle_sweep" }, padding: "x".repeat(500_000) }));
    });
    const answer = await freshConnectionFetch(url);
    expect(answer.status).toBe(503);
    const text = await answer.text();
    expect(text.length).toBe(16 * 1024);
    const evidence = answerEvidence(503, answer.headers, text);
    expect(evidence).toMatchObject({ error: "Workspace is waking up", statusPageCode: "idle_sweep" });
    expect(Buffer.byteLength(evidence.bodyExcerpt)).toBe(512);
  });

  it("reports a reset on a fresh connection with the socket's addresses and byte counts", async () => {
    const { url } = await listen(request => request.socket.destroy());
    const error = await freshConnectionFetch(url).catch(caught => caught as TypeError);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError & { cause: { code: string; socket: Record<string, unknown> } }).cause).toMatchObject({ code: "ECONNRESET",
      socket: { remoteAddress: "127.0.0.1", bytesWritten: expect.any(Number) } });
  });
});
