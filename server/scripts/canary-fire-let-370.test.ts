/**
 * Phase 4A-S4 (LET-417) — unit tests for the canary-fire harness.
 *
 * These tests exercise the harness in `dry-run` mode against a stubbed
 * fetch so no live HTTP egress is performed. They cover:
 *   1. Gates-closed refusal when `--mode=live` is requested with any
 *      missing gate, surfacing GATE_FAILURE without contacting fetch.
 *   2. Gates-open dry-run happy path — full acquire/start/exec/release
 *      cycle resolves OK, the registry size is >= 3, and the four
 *      documented request shapes are captured.
 *   3. Planted-token redaction in every captured surface (URL, headers,
 *      body) for the API key, canary token, and dummy secret.
 *   4. Audit hook records each request exactly once.
 *   5. Evidence file is written to the configured dist directory.
 *
 * No live HTTP call is made. The pre-egress redaction registry is
 * the canonical contract under test — every assertion would fail if a
 * future regression let a planted token reach the captured payload.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CANARY_FIRE_EXIT_CODES,
  countRequests,
  createDryRunStubFetch,
  parseHarnessArgs,
  runCanaryFire,
  validateRequestShape,
  type CanaryFireDependencies,
  type CanaryFireRunInputs,
} from "./canary-fire-let-370.ts";
import { MANAGED_SANDBOX_LIVE_ENV } from "../src/services/sandbox/managed-provider-spikes.ts";

const RESOLVED_API_KEY_DUMMY = "dummy-resolved-e2b-key-do-not-leak-let-417-test";
const SANDBOX_ID = "e2b-sandbox-canary-let-417";

const originalLiveEnv = process.env[MANAGED_SANDBOX_LIVE_ENV];

interface OkResponse {
  ok: true;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function jsonResponse(body: unknown, status = 200): OkResponse {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

function emptyResponse(status = 204): OkResponse {
  return {
    ok: true,
    status,
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function encodeConnectFrame(payload: Uint8Array, endOfStream = false): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = endOfStream ? 0x02 : 0x00;
  const len = payload.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function connectStreamResponse(): OkResponse {
  const encoder = new TextEncoder();
  const startFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({ event: { start: { pid: 1 } } })),
  );
  const dataFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({
      event: { data: { stdout: Buffer.from("canary-ok\n", "utf8").toString("base64") } },
    })),
  );
  const endFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({ event: { end: { exitCode: 0 } } })),
  );
  const trailerFrame = encodeConnectFrame(encoder.encode("{}"), true);
  const bytes = concatBytes([startFrame, dataFrame, endFrame, trailerFrame]);
  return {
    ok: true,
    status: 200,
    text: async () => Buffer.from(bytes).toString("utf8"),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

interface StubFetchHandle {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string }>;
}

function makeStubFetch(): StubFetchHandle {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname === "/sandboxes") {
      return jsonResponse({
        sandboxID: SANDBOX_ID,
        clientID: "canary-client",
        envdAccessToken: "envd-canary-access-token",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "created",
        metadata: {},
      }) as unknown as Response;
    }
    if (method === "POST" && /\/sandboxes\/[^/]+\/connect$/.test(parsed.pathname)) {
      return jsonResponse({
        sandboxID: SANDBOX_ID,
        clientID: "canary-client",
        envdAccessToken: "envd-canary-access-token",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "running",
        metadata: {},
      }) as unknown as Response;
    }
    if (method === "POST" && parsed.pathname === "/process.Process/Start") {
      return connectStreamResponse() as unknown as Response;
    }
    if (method === "DELETE") {
      return emptyResponse(204) as unknown as Response;
    }
    return jsonResponse({}) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// Fixed UUID used as the default fixture run id. The harness enforces a
// strict UUID shape on --run-id so the value can safely be used as a
// basename component of the evidence file path; tests must follow the
// same contract.
const FIXTURE_RUN_ID = "00000000-0000-4000-8000-000000000001";

function makeInputs(overrides: Partial<CanaryFireRunInputs> = {}): CanaryFireRunInputs {
  const runId = overrides.runId ?? FIXTURE_RUN_ID;
  return {
    mode: overrides.mode ?? "dry-run",
    runId,
    canaryToken: overrides.canaryToken ?? `CANARY-S4-${runId}-deadbeef`,
    dummySecret: overrides.dummySecret ?? `DUMMY_SECRET_${runId}_cafef00d`,
  };
}

async function makeDeps(
  overrides: Partial<CanaryFireDependencies> = {},
): Promise<{ deps: CanaryFireDependencies; evidenceDir: string; calls: Array<{ url: string; method: string }> }> {
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "canary-fire-let-417-"));
  const stub = makeStubFetch();
  return {
    deps: {
      fetchImpl: overrides.fetchImpl ?? stub.fetchImpl,
      resolvedApiKey: overrides.resolvedApiKey ?? RESOLVED_API_KEY_DUMMY,
      gates: overrides.gates ?? { liveEnvAllowed: true, layer1Enabled: true, secretRefPresent: true },
      evidenceDir: overrides.evidenceDir ?? evidenceDir,
      logger: overrides.logger ?? (() => {}),
      requestShapeMode: overrides.requestShapeMode,
    },
    evidenceDir,
    calls: stub.calls,
  };
}

describe("LET-417 canary-fire harness — argument parsing", () => {
  it("defaults to dry-run mode and generates run-id/canary/dummy when not supplied", () => {
    const parsed = parseHarnessArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.inputs.mode).toBe("dry-run");
    expect(parsed.inputs.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.inputs.canaryToken.startsWith(`CANARY-S4-${parsed.inputs.runId}-`)).toBe(true);
    expect(parsed.inputs.dummySecret.startsWith(`DUMMY_SECRET_${parsed.inputs.runId}_`)).toBe(true);
  });

  it("accepts explicit run-id / canary-token / dummy-secret overrides", () => {
    const parsed = parseHarnessArgs([
      "--mode=live",
      "--run-id=11111111-2222-4333-8444-555555555555",
      "--canary-token=fixed-canary",
      "--dummy-secret=fixed-secret",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.inputs).toEqual({
      mode: "live",
      runId: "11111111-2222-4333-8444-555555555555",
      canaryToken: "fixed-canary",
      dummySecret: "fixed-secret",
    });
  });

  it("rejects invalid mode", () => {
    const parsed = parseHarnessArgs(["--mode=bogus"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/--mode/);
  });

  it("rejects unknown flags", () => {
    const parsed = parseHarnessArgs(["--bogus=1"]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects non-UUID --run-id values (slug-shaped)", () => {
    const parsed = parseHarnessArgs(["--run-id=fixed-run"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/--run-id must be a lowercase RFC 4122 UUID/);
  });

  it("rejects path-shaped --run-id values that would escape the evidence dir", () => {
    const parsed = parseHarnessArgs(["--run-id=../../../tmp/let417-owned"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/--run-id must be a lowercase RFC 4122 UUID/);
    expect(parsed.error).toMatch(/evidence directory/);
  });

  it("rejects uppercase / non-RFC-4122 --run-id values", () => {
    const parsed = parseHarnessArgs([
      "--run-id=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/--run-id must be a lowercase RFC 4122 UUID/);
  });
});

describe("LET-417 canary-fire harness — gates-closed refusal", () => {
  beforeEach(() => {
    delete process.env[MANAGED_SANDBOX_LIVE_ENV];
  });
  afterEach(async () => {
    if (originalLiveEnv === undefined) delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    else process.env[MANAGED_SANDBOX_LIVE_ENV] = originalLiveEnv;
  });

  it("refuses --mode=live with GATE_FAILURE when no gates pass and never calls fetch", async () => {
    const { deps, evidenceDir, calls } = await makeDeps({
      gates: { liveEnvAllowed: false, layer1Enabled: false, secretRefPresent: false },
    });
    try {
      const result = await runCanaryFire(makeInputs({ mode: "live" }), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.GATE_FAILURE);
      expect(result.failure ?? "").toMatch(/Refusing live mode/);
      expect(result.failure ?? "").toMatch(/SANDBOX_PROVIDER_ALLOW_LIVE/);
      expect(result.failure ?? "").toMatch(/sandbox\.providers\.e2b\.enabled/);
      expect(result.failure ?? "").toMatch(/apiKeySecret/);
      expect(calls).toHaveLength(0);
      expect(result.capturedRequests).toHaveLength(0);
      expect(result.evidencePath).not.toBeNull();
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("refuses --mode=live when only the secret ref gate is missing", async () => {
    const { deps, evidenceDir, calls } = await makeDeps({
      gates: { liveEnvAllowed: true, layer1Enabled: true, secretRefPresent: false },
    });
    try {
      const result = await runCanaryFire(makeInputs({ mode: "live" }), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.GATE_FAILURE);
      expect(result.failure ?? "").toMatch(/apiKeySecret/);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("permits --mode=dry-run even when no gates pass — the stubbed fetch keeps egress contained", async () => {
    const { deps, evidenceDir } = await makeDeps({
      gates: { liveEnvAllowed: false, layer1Enabled: false, secretRefPresent: false },
    });
    try {
      const result = await runCanaryFire(makeInputs({ mode: "dry-run" }), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});

describe("LET-417 canary-fire harness — dry-run happy path", () => {
  afterEach(() => {
    if (originalLiveEnv === undefined) delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    else process.env[MANAGED_SANDBOX_LIVE_ENV] = originalLiveEnv;
  });

  it("completes one acquire/start/exec/release cycle and records the fresh-create three-call shape (LET-431)", async () => {
    // Post-LET-431 the live transport skips POST /sandboxes/{id}/connect on
    // fresh-create because the create response carries envdAccessToken +
    // domain; the harness therefore captures three calls, not four.
    const { deps, evidenceDir, calls } = await makeDeps();
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.failure).toBeNull();
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      expect(result.capturedRequests).toHaveLength(3);
      expect(calls).toHaveLength(3);

      const methods = result.capturedRequests.map((request) => request.method);
      expect(methods).toEqual(["POST", "POST", "DELETE"]);

      const pathnames = result.capturedRequests.map((request) => new URL(request.url).pathname);
      expect(pathnames[0]).toBe("/sandboxes");
      expect(pathnames[1]).toBe("/process.Process/Start");
      expect(pathnames[2]).toBe(`/sandboxes/${SANDBOX_ID}`);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("registers the apiKey + canary token + dummy secret (registry size >= 3)", async () => {
    const { deps, evidenceDir } = await makeDeps();
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      expect(result.registrySize).toBeGreaterThanOrEqual(3);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("redacts every planted token from every captured request surface", async () => {
    const { deps, evidenceDir } = await makeDeps();
    try {
      const inputs = makeInputs();
      const result = await runCanaryFire(inputs, deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      for (const request of result.capturedRequests) {
        const surfaces: string[] = [request.url];
        for (const value of Object.values(request.headers)) surfaces.push(value);
        if (request.body !== null) surfaces.push(request.body);
        for (const surface of surfaces) {
          expect(surface).not.toContain(RESOLVED_API_KEY_DUMMY);
          expect(surface).not.toContain(inputs.canaryToken);
          expect(surface).not.toContain(inputs.dummySecret);
        }
      }
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("emits the [REDACTED] placeholder in the exec request body where the tokens were planted", async () => {
    const { deps, evidenceDir } = await makeDeps();
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      const execRequest = result.capturedRequests.find(
        (request) => new URL(request.url).pathname === "/process.Process/Start",
      );
      expect(execRequest).toBeDefined();
      expect(execRequest?.body ?? "").toContain("[REDACTED]");
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("writes the evidence JSON file with all captured requests", async () => {
    const { deps, evidenceDir } = await makeDeps();
    try {
      const inputs = makeInputs();
      const result = await runCanaryFire(inputs, deps);
      expect(result.evidencePath).toBe(path.join(evidenceDir, `canary-evidence-${inputs.runId}.json`));
      const text = await readFile(result.evidencePath!, "utf8");
      const parsed = JSON.parse(text);
      expect(parsed.schema).toBe("phase-4a-s4-canary-fire-let-370/v1");
      expect(parsed.runId).toBe(inputs.runId);
      expect(parsed.mode).toBe("dry-run");
      expect(parsed.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      expect(parsed.failure).toBeNull();
      expect(Array.isArray(parsed.requests)).toBe(true);
      expect(parsed.requests).toHaveLength(3);
      expect(text).not.toContain(RESOLVED_API_KEY_DUMMY);
      expect(text).not.toContain(inputs.canaryToken);
      expect(text).not.toContain(inputs.dummySecret);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("completes the full cycle with the built-in createDryRunStubFetch() (CLI default path)", async () => {
    const { deps, evidenceDir, calls } = await makeDeps({ fetchImpl: createDryRunStubFetch() });
    try {
      const inputs = makeInputs({ runId: "22222222-3333-4444-8555-666666666666" });
      const result = await runCanaryFire(inputs, deps);
      expect(result.failure).toBeNull();
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      // Post-LET-431: fresh-create skips /connect, so the captured set is 3.
      expect(result.capturedRequests).toHaveLength(3);
      // The injected stub fetch is the one we passed in via makeDeps, so the
      // tracked-calls handle from the makeStubFetch() default is unused here.
      expect(calls).toHaveLength(0);
      const pathnames = result.capturedRequests.map((request) => new URL(request.url).pathname);
      expect(pathnames[0]).toBe("/sandboxes");
      expect(pathnames[1]).toBe("/process.Process/Start");
      expect(pathnames[2]).toMatch(/^\/sandboxes\/[^/]+$/);
      const execBody = result.capturedRequests[1]?.body ?? "";
      expect(execBody).toContain("[REDACTED]");
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("restores SANDBOX_PROVIDER_ALLOW_LIVE to its previous value after running", async () => {
    const sentinel = "sentinel-value-from-test";
    process.env[MANAGED_SANDBOX_LIVE_ENV] = sentinel;
    const { deps, evidenceDir } = await makeDeps();
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      expect(process.env[MANAGED_SANDBOX_LIVE_ENV]).toBe(sentinel);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});

// LET-435 supersedes the LET-442 relaxation: the request-shape validator is
// now mode-aware. Fresh-create must capture exactly zero /connect calls
// (LET-431 regression guard); resume must capture exactly one. Both modes
// keep the strict create/exec/destroy assertions so a canary that never
// fires still surfaces a non-zero exit.
describe("LET-435 request-shape validator (mode-aware)", () => {
  function capturedRequest(method: string, pathname: string): Parameters<typeof countRequests>[0][number] {
    return {
      method,
      url: `https://api.e2b.app${pathname}`,
      headers: {},
      body: null,
    };
  }

  it("accepts the fresh-create shape (0 connects, 3 requests total) — LET-431 green path", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.connectSandbox).toBe(0);
    expect(counts.total).toBe(3);
    expect(validateRequestShape(counts, "fresh-create")).toEqual([]);
  });

  it("defaults to fresh-create when no mode is passed", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(validateRequestShape(counts)).toEqual([]);
  });

  it("regression-fails fresh-create when a /connect call IS captured (LET-435 AC)", () => {
    // If a future regression resurrects the pre-LET-431 4-call shape on
    // fresh-create the validator must flag it — this is the explicit
    // LET-435 acceptance-criterion check.
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/sandboxes/sbx-abc/connect"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.connectSandbox).toBe(1);
    const issues = validateRequestShape(counts, "fresh-create");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("/connect") && issue.includes("LET-431"))).toBe(true);
  });

  it("accepts the resume shape (exactly 1 connect, 4 requests total) when mode=resume", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/sandboxes/sbx-abc/connect"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.connectSandbox).toBe(1);
    expect(counts.total).toBe(4);
    expect(validateRequestShape(counts, "resume")).toEqual([]);
  });

  it("regression-fails mode=resume when /connect is missing — envd refresh did not happen", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.connectSandbox).toBe(0);
    const issues = validateRequestShape(counts, "resume");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("/connect") && issue.includes("refresh"))).toBe(true);
  });

  it("rejects a cycle that never fires the canary (0 exec calls) — non-zero exit signal preserved", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.processStart).toBe(0);
    const issues = validateRequestShape(counts, "fresh-create");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("/process.Process/Start"))).toBe(true);
  });

  it("rejects more than one /connect call on resume (resume must never repeat)", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/sandboxes/sbx-abc/connect"),
      capturedRequest("POST", "/sandboxes/sbx-abc/connect"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
    ]);
    expect(counts.connectSandbox).toBe(2);
    const issues = validateRequestShape(counts, "resume");
    expect(issues.some((issue) => issue.includes("/connect"))).toBe(true);
  });

  it("flags unrecognised endpoints in the captured set", () => {
    const counts = countRequests([
      capturedRequest("POST", "/sandboxes"),
      capturedRequest("POST", "/process.Process/Start"),
      capturedRequest("DELETE", "/sandboxes/sbx-abc"),
      capturedRequest("GET", "/unexpected/endpoint"),
    ]);
    const issues = validateRequestShape(counts, "fresh-create");
    expect(issues.some((issue) => issue.includes("unrecognised endpoint"))).toBe(true);
  });
});

// LET-435 end-to-end: re-run the harness against an injected stub that
// emulates a resume-style transport (one /connect call). With the explicit
// `requestShapeMode: "resume"` dependency the harness must exit OK with a
// four-call captured shape; without it (i.e. default fresh-create mode) the
// same captured set must be rejected as a LET-431 regression.
describe("LET-435 canary-fire harness — resume-style cycle exits OK when mode=resume", () => {
  afterEach(() => {
    if (originalLiveEnv === undefined) delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    else process.env[MANAGED_SANDBOX_LIVE_ENV] = originalLiveEnv;
  });

  function makeResumeStyleStubFetch(): StubFetchHandle {
    // Identical to the standard stub except the create response omits
    // envdAccessToken + domain. The live transport's `sessionFromCreate`
    // stores a session with empty token + domain, so `ensureSession`
    // detects a stale session and falls back to /connect — which is the
    // documented LET-431 resume path.
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: SANDBOX_ID,
          clientID: "canary-client",
          envdVersion: "v0.1.99",
          state: "created",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && /\/sandboxes\/[^/]+\/connect$/.test(parsed.pathname)) {
        return jsonResponse({
          sandboxID: SANDBOX_ID,
          clientID: "canary-client",
          envdAccessToken: "envd-canary-access-token",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse() as unknown as Response;
      }
      if (method === "DELETE") {
        return emptyResponse(204) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("captures POST /sandboxes, POST /connect, POST /process.Process/Start, DELETE /sandboxes/{id} and exits OK with mode=resume", async () => {
    const stub = makeResumeStyleStubFetch();
    const { deps, evidenceDir } = await makeDeps({
      fetchImpl: stub.fetchImpl,
      requestShapeMode: "resume",
    });
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.failure).toBeNull();
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.OK);
      expect(result.capturedRequests).toHaveLength(4);

      const pathnames = result.capturedRequests.map((request) => new URL(request.url).pathname);
      expect(pathnames[0]).toBe("/sandboxes");
      expect(pathnames[1]).toBe(`/sandboxes/${SANDBOX_ID}/connect`);
      expect(pathnames[2]).toBe("/process.Process/Start");
      expect(pathnames[3]).toBe(`/sandboxes/${SANDBOX_ID}`);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  it("regression-fails the same resume-style stub when mode defaults to fresh-create (LET-435 AC)", async () => {
    // If a future regression starts re-issuing /connect on the fresh-create
    // path, the default-mode harness must fail with WRONG_REQUEST_SHAPE
    // rather than silently writing a green evidence file.
    const stub = makeResumeStyleStubFetch();
    const { deps, evidenceDir } = await makeDeps({ fetchImpl: stub.fetchImpl });
    try {
      const result = await runCanaryFire(makeInputs(), deps);
      expect(result.exitCode).toBe(CANARY_FIRE_EXIT_CODES.WRONG_REQUEST_SHAPE);
      expect(result.failure ?? "").toMatch(/\/connect/);
      expect(result.failure ?? "").toMatch(/LET-431/);
      expect(result.capturedRequests).toHaveLength(4);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});
