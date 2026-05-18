/**
 * Phase 4A-S4 (LET-366) — Live E2BSandboxProvider behind SANDBOX_PROVIDER_ALLOW_LIVE.
 *
 * These tests cover the acceptance criteria that distinguish the live adapter
 * from the LET-351 mock-only spike, and the QA-remediated SDK-aligned wire
 * contract:
 *
 *  1. Three-gate fail-closed: PROVIDER_DISABLED is thrown from `acquireLease`
 *     before any HTTP egress when any of the three gates is missing.
 *  2. Pre-egress redaction boundary: a resolved-secret canary registered into
 *     the pre-provider redaction registry never reaches the captured outbound
 *     payload (request body, env values, command args, stdin, headers).
 *  3. Lifecycle mapping: acquireLease → POST /sandboxes (api.e2b.app),
 *     start → POST /sandboxes/{id}/connect (returns envdAccessToken/domain),
 *     exec → POST {envdHost}/process.Process/Start (Connect server-streaming),
 *     release → DELETE /sandboxes/{id} (pilot default), destroy → DELETE.
 *  4. SDK-aligned wire shape:
 *     - control-plane requests use `X-API-Key`, NOT `Authorization: Bearer`,
 *     - exec request body wraps the user's command as `cmd: "/bin/bash"`
 *       and `args: ["-l", "-c", <combined-shell-command>]`,
 *     - envd Connect request uses `Content-Type: application/connect+json`
 *       and `X-Access-Token: <envd-token>`,
 *     - the API key is NEVER sent as `Authorization: Basic`; Basic is only
 *       set when an explicit sudo `user` is supplied (mirrors
 *       `authenticationHeader(version, user)` in e2b@2.20.x).
 *     - the response is a Connect server-streaming frame sequence (5-byte
 *       envelope + JSON payload, end-of-stream flag in bit 1).
 *  5. Persisted-lease cleanup: a fresh provider instance can release/destroy/
 *     resume an existing providerLeaseId without prior acquireLease, AND can
 *     `resumeLease(...)` then `exec(...)` against the refreshed envd session
 *     (the persisted-lease + fresh-instance + exec gap the prior remediation
 *     did not cover).
 *
 * No live HTTP call is made — every test injects either a stub fetch or
 * an override transport factory. The vendor placeholder is `<E2B_API_KEY>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  E2B_LIVE_SECRET_INJECTION,
  E2B_SANDBOX_PROVIDER_KEY,
  E2BSandboxProvider,
  MANAGED_SANDBOX_LIVE_ENV,
  isManagedSandboxLiveAllowed,
  type ManagedSandboxProviderConfig,
} from "./managed-provider-spikes.js";
import { PreProviderRedactionRegistry } from "./pre-provider-redaction.js";
import {
  __testing as transportTesting,
  type E2BCapturedRequest,
} from "./e2b-live-transport.js";

const originalLiveFlag = process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
const RESOLVED_API_KEY_CANARY = "canary-resolved-e2b-key-do-not-leak-2026-05-17";
const ENV_SECRET_CANARY = "canary-resolved-env-secret-do-not-leak-2026-05-17";
const STDIN_CANARY = "canary-resolved-stdin-secret-do-not-leak-2026-05-17";

const e2bLiveConfig: ManagedSandboxProviderConfig = {
  provider: E2B_SANDBOX_PROVIDER_KEY,
  image: "e2b/code-interpreter:latest",
  template: "base",
  reuseLease: false,
  timeoutMs: 45_000,
  env: { MY_TEST_VAR: ENV_SECRET_CANARY, SAFE_PUBLIC: "ok-public-value" },
  network: { egress: "deny" },
};

function restoreLiveFlag(): void {
  if (originalLiveFlag === undefined) {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  } else {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = originalLiveFlag;
  }
}

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

/** Encode a single Connect protocol frame: 5-byte envelope
 *  (1 flag byte + 4-byte uint32 BE length) followed by `length` payload bytes. */
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

interface ProcessEventInput {
  type: "start" | "data" | "end" | "keepalive";
  pid?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  status?: string;
  error?: string;
}

/** Build a Connect server-streaming response body for process.Process/Start.
 *  `events` are wrapped as `{ event: { <type>: { ... } } }` envelopes;
 *  `data` payloads are base64-encoded utf-8 bytes per protobuf-json. */
function buildConnectStreamingBody(events: ProcessEventInput[], trailers: unknown = {}): Uint8Array {
  const encoder = new TextEncoder();
  const frames: Uint8Array[] = [];
  for (const event of events) {
    let envelope: Record<string, unknown>;
    if (event.type === "data") {
      const data: Record<string, string> = {};
      if (event.stdout !== undefined) {
        data.stdout = Buffer.from(event.stdout, "utf8").toString("base64");
      }
      if (event.stderr !== undefined) {
        data.stderr = Buffer.from(event.stderr, "utf8").toString("base64");
      }
      envelope = { event: { data } };
    } else if (event.type === "end") {
      const end: Record<string, unknown> = {};
      if (event.exitCode !== undefined) end.exitCode = event.exitCode;
      if (event.status !== undefined) end.status = event.status;
      if (event.error !== undefined) end.error = event.error;
      envelope = { event: { end } };
    } else if (event.type === "start") {
      envelope = { event: { start: { pid: event.pid ?? 1 } } };
    } else {
      envelope = { event: { keepalive: {} } };
    }
    frames.push(encodeConnectFrame(encoder.encode(JSON.stringify(envelope))));
  }
  frames.push(encodeConnectFrame(encoder.encode(JSON.stringify(trailers ?? {})), true));
  return concatBytes(frames);
}

function connectStreamResponse(events: ProcessEventInput[], trailers: unknown = {}, status = 200): OkResponse {
  const bytes = buildConnectStreamingBody(events, trailers);
  return {
    ok: true,
    status,
    text: async () => Buffer.from(bytes).toString("utf8"),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

describe("LET-366 E2BSandboxProvider live transport gating", () => {
  beforeEach(() => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  });
  afterEach(() => {
    restoreLiveFlag();
    vi.restoreAllMocks();
  });

  it("declares the LET-366 live secret-injection contract", () => {
    expect(E2B_LIVE_SECRET_INJECTION).toEqual({
      mode: "environment",
      acceptsRawSecrets: true,
      requiresResolvedSecrets: true,
      redactionBoundary: "before-provider",
    });
    const provider = new E2BSandboxProvider();
    expect(provider.secretInjection).toMatchObject(E2B_LIVE_SECRET_INJECTION);
  });

  it("throws PROVIDER_DISABLED before any HTTP egress when SANDBOX_PROVIDER_ALLOW_LIVE is unset", async () => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey,
      fetchImpl: globalThis.fetch.bind(globalThis),
      liveTransportFactory,
    });
    await expect(
      provider.acquireLease({
        config: e2bLiveConfig,
        environmentId: "env-1",
        heartbeatRunId: "run-1",
        issueId: "issue-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({
        gate: "env_flag",
        liveEnv: MANAGED_SANDBOX_LIVE_ENV,
        liveFlagSet: false,
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("throws PROVIDER_DISABLED before any HTTP egress when Layer 1 is disabled", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => false,
      resolveApiKey,
      fetchImpl: globalThis.fetch.bind(globalThis),
      liveTransportFactory,
    });
    await expect(
      provider.acquireLease({
        config: e2bLiveConfig,
        environmentId: "env-1",
        heartbeatRunId: "run-1",
        issueId: "issue-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("throws PROVIDER_DISABLED before any HTTP egress when no resolved secret is available", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => null,
      fetchImpl: globalThis.fetch.bind(globalThis),
      liveTransportFactory,
    });
    await expect(
      provider.acquireLease({
        config: e2bLiveConfig,
        environmentId: "env-1",
        heartbeatRunId: "run-1",
        issueId: "issue-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "secret_unresolved" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
  });

  it("rejects raw apiKey in user config even when live mode would otherwise be enabled", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
    });
    const result = await provider.validateConfig({
      ...e2bLiveConfig,
      // Raw apiKey is forbidden — resolved-only enforced at construction.
      apiKey: "<E2B_API_KEY>",
    } as ManagedSandboxProviderConfig);
    expect(result.ok).toBe(false);
    expect(result.issues ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "apiKey" }),
      ]),
    );
  });

  it("initialises the live transport only when all three gates pass", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const capturedRequests: E2BCapturedRequest[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return jsonResponse({ sandboxID: "e2b-sandbox-live-1", state: "created", metadata: {} }) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRequest: (request) => capturedRequests.push(request),
    });

    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-live-1",
      heartbeatRunId: "run-live-1",
      issueId: "issue-live-1",
    });
    expect(lease.providerLeaseId).toBe("sandbox://e2b/e2b-sandbox-live-1");
    expect(lease.metadata).toMatchObject({
      provider: E2B_SANDBOX_PROVIDER_KEY,
      transport: "live-http",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.method).toBe("POST");
    expect(capturedRequests[0]?.url).toMatch(/\/sandboxes$/);
  });

  it("redacts every registered secret from the captured outbound payload (planted canaries)", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const sharedRegistry = new PreProviderRedactionRegistry();
    sharedRegistry.register(ENV_SECRET_CANARY);
    sharedRegistry.register(STDIN_CANARY);

    const captured: E2BCapturedRequest[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "e2b-sandbox-canary-1",
          clientID: "client-abc",
          envdAccessToken: "envd-canary-token",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse([
          { type: "start", pid: 42 },
          { type: "data", stdout: "ok\n" },
          { type: "end", exitCode: 0 },
        ]) as unknown as Response;
      }
      if (method === "DELETE") {
        return emptyResponse(204) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });

    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      redactionRegistry: sharedRegistry,
      onRequest: (request) => captured.push(request),
    });

    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-canary",
      heartbeatRunId: "run-canary",
      issueId: "issue-canary",
    });

    await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      command: `echo ${ENV_SECRET_CANARY}`,
      args: ["--token", RESOLVED_API_KEY_CANARY, "--passthrough", "public-arg"],
      env: { LEAKY_ENV: ENV_SECRET_CANARY, SAFE_ENV: "safe-value" },
      stdin: `prefix ${STDIN_CANARY} suffix`,
    });

    expect(sharedRegistry.size()).toBeGreaterThanOrEqual(3);

    // X-API-Key on control plane and X-Access-Token on envd are the only places
    // where the resolved key/envd token are legitimately handed to the
    // transport. The captured-hook projection must show the redacted view for
    // them — and Authorization must NOT carry the API key (Basic auth is only
    // used when a sudo user is supplied, which this call does not request).
    for (const request of captured) {
      for (const header of ["X-API-Key", "X-Access-Token"]) {
        const value = request.headers[header];
        if (value) {
          expect(value).toBe("[REDACTED]");
          expect(value).not.toContain(RESOLVED_API_KEY_CANARY);
        }
      }
      const authHeader = request.headers["Authorization"];
      if (authHeader) {
        expect(authHeader).not.toContain(RESOLVED_API_KEY_CANARY);
        expect(authHeader.startsWith("Basic [REDACTED]")).toBe(true);
      }
    }

    // No captured outbound payload may contain the registered secrets.
    const haystack = JSON.stringify(captured);
    expect(haystack).not.toContain(RESOLVED_API_KEY_CANARY);
    expect(haystack).not.toContain(ENV_SECRET_CANARY);
    expect(haystack).not.toContain(STDIN_CANARY);

    // Non-secret args / env values still flow through unredacted so callers
    // can confirm redaction is targeted, not blanket.
    expect(haystack).toContain("public-arg");
    expect(haystack).toContain("safe-value");
  });

  it("maps the Paperclip lifecycle to the documented E2B HTTP surface (api.e2b.app + envd Connect host) by default", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const recorded: Array<{ method: string; host: string; path: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      recorded.push({ method, host: parsed.host, path: parsed.pathname });
      if (method === "POST" && parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "e2b-sandbox-lifecycle",
          clientID: "client-lc",
          envdAccessToken: "envd-token-lc",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname.endsWith("/connect")) {
        return jsonResponse({
          sandboxID: "e2b-sandbox-lifecycle",
          envdAccessToken: "envd-token-lc",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse([
          { type: "data", stdout: "ok" },
          { type: "end", exitCode: 0 },
        ]) as unknown as Response;
      }
      if (method === "DELETE") {
        return emptyResponse(204) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-lc",
      heartbeatRunId: "run-lc",
      issueId: "issue-lc",
    });
    await provider.start({ lease });
    await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      command: "echo",
      args: ["ok"],
    });
    await provider.releaseLease({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      status: "released",
    });
    await provider.destroyLease({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
    });
    expect(recorded).toEqual([
      { method: "POST", host: "api.e2b.app", path: "/sandboxes" },
      { method: "POST", host: "api.e2b.app", path: "/sandboxes/e2b-sandbox-lifecycle/connect" },
      // Exec leaves api.e2b.app and targets the sandbox-side envd Connect host.
      { method: "POST", host: "49983-e2b-sandbox-lifecycle.e2b.app", path: "/process.Process/Start" },
      // releaseLease maps to DELETE on api.e2b.app per pilot default (no warm reuse).
      { method: "DELETE", host: "api.e2b.app", path: "/sandboxes/e2b-sandbox-lifecycle" },
      // destroyLease maps to DELETE.
      { method: "DELETE", host: "api.e2b.app", path: "/sandboxes/e2b-sandbox-lifecycle" },
    ]);
  });

  it("can be configured to map releaseLease to pause for future warm-reuse pilots", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const recorded: Array<{ method: string; path: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      recorded.push({ method, path });
      if (method === "POST" && path === "/sandboxes") {
        return jsonResponse({ sandboxID: "e2b-sandbox-pause", state: "created", metadata: {} }) as unknown as Response;
      }
      return emptyResponse(204) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      releaseMode: "pause",
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-pause",
      heartbeatRunId: "run-pause",
      issueId: "issue-pause",
    });
    await provider.releaseLease({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      status: "released",
    });
    expect(recorded).toEqual([
      { method: "POST", path: "/sandboxes" },
      { method: "POST", path: "/sandboxes/e2b-sandbox-pause/pause" },
    ]);
  });
});

/**
 * QA-remediation contract tests: assert the on-the-wire shape matches the
 * official E2B JS SDK (`e2b@2.20.x`, `packages/js-sdk`):
 *   - X-API-Key for sandbox CRUD,
 *   - templateID/timeout/envVars body field names,
 *   - `/sandboxes/{id}/connect` (NOT `/resume`) returns envd session,
 *   - exec wraps user command as `/bin/bash -l -c <combined>`,
 *   - Connect protocol headers on the envd host,
 *   - no `Authorization: Basic base64(<apiKey>)` on envd by default,
 *   - response is a Connect streaming frame sequence, aggregated into stdout/exit.
 */
describe("LET-366 E2B SDK-aligned HTTP contract", () => {
  beforeEach(() => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  });
  afterEach(() => {
    restoreLiveFlag();
    vi.restoreAllMocks();
  });

  it("uses X-API-Key (not Authorization: Bearer) and documented body fields on /sandboxes create", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return jsonResponse({
        sandboxID: "sb-contract-1",
        clientID: "client-contract",
        envdAccessToken: "envd-contract",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "created",
      }) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-contract",
      heartbeatRunId: "run-contract",
      issueId: "issue-contract",
    });
    expect(captured).toHaveLength(1);
    const first = captured[0];
    expect(first).toBeDefined();
    const headers = (first!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(RESOLVED_API_KEY_CANARY);
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(first!.init?.body as string);
    expect(body).toMatchObject({
      templateID: "base",
      // 45_000 ms → 45 s rounded up.
      timeout: 45,
      envVars: expect.objectContaining({ SAFE_PUBLIC: "ok-public-value" }),
    });
    expect(body.image).toBeUndefined();
    expect(body.snapshot).toBeUndefined();
    expect(body.template).toBeUndefined();
    expect(body.env).toBeUndefined();
    expect(body.timeoutMs).toBeUndefined();
  });

  it("uses POST /sandboxes/{id}/connect (not /resume) for start, returning the envd session", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      captured.push({ url, method, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "sb-start-1",
          clientID: "client-start",
          envdAccessToken: "envd-token-start",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (parsed.pathname.endsWith("/connect")) {
        return jsonResponse({
          sandboxID: "sb-start-1",
          envdAccessToken: "envd-token-start-refreshed",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          trafficAccessToken: "traffic-tok",
          state: "running",
        }) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-start",
      heartbeatRunId: "run-start",
      issueId: "issue-start",
    });
    await provider.start({ lease });
    expect(captured.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /sandboxes",
      "POST /sandboxes/sb-start-1/connect",
    ]);
    // /resume must not be called.
    expect(captured.every((c) => !new URL(c.url).pathname.endsWith("/resume"))).toBe(true);
  });

  it("wraps user command as /bin/bash -l -c <combined> and uses Connect headers without Basic auth", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "sb-connect-1",
          clientID: "client-connect",
          envdAccessToken: "envd-token-connect",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse([
          { type: "data", stdout: "hello\n" },
          { type: "end", exitCode: 0 },
        ]) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-connect",
      heartbeatRunId: "run-connect",
      issueId: "issue-connect",
    });
    const result = await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      command: "echo",
      args: ["hello"],
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "" });
    expect(captured).toHaveLength(2);
    const execCall = captured[1]!;
    const parsed = new URL(execCall.url);
    expect(parsed.host).toBe("49983-sb-connect-1.e2b.app");
    expect(parsed.pathname).toBe("/process.Process/Start");
    const headers = (execCall.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/connect+json");
    expect(headers["Accept"]).toBe("application/connect+json");
    expect(headers["X-Access-Token"]).toBe("envd-token-connect");
    // The API key is NEVER sent as Basic auth on envd — the access token
    // authorises the envd channel. The SDK only sets Basic when a sudo `user`
    // is supplied, which this call does not request.
    expect(headers["Authorization"]).toBeUndefined();
    // Body wraps the user command as `cmd: '/bin/bash', args: ['-l', '-c', '<combined>']`.
    const body = JSON.parse(execCall.init?.body as string);
    expect(body.process.cmd).toBe("/bin/bash");
    expect(body.process.args).toEqual(["-l", "-c", "echo hello"]);
    // Legacy / pre-remediation shape must NOT be present.
    expect(body.process.args).not.toEqual(["hello"]);
    expect(body.process.cmd).not.toBe("echo");
  });

  it("aggregates a Connect server-streaming response into { exitCode, stdout, stderr }", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "sb-stream-1",
          clientID: "c",
          envdAccessToken: "envd-token",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse([
          { type: "start", pid: 17 },
          { type: "data", stdout: "first " },
          { type: "data", stdout: "second", stderr: "warn\n" },
          { type: "end", exitCode: 3 },
        ]) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-stream",
      heartbeatRunId: "run-stream",
      issueId: "issue-stream",
    });
    const result = await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      command: "true",
    });
    expect(result).toEqual({ exitCode: 3, stdout: "first second", stderr: "warn\n" });
  });

  it("raises PROVIDER_FAILURE when the Connect end-of-stream trailers carry an error envelope", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname === "/sandboxes") {
        return jsonResponse({
          sandboxID: "sb-err-1",
          envdAccessToken: "envd-token",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse(
          [{ type: "data", stdout: "partial" }],
          { error: { code: "internal", message: "sandbox died" } },
        ) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lease = await provider.acquireLease({
      config: e2bLiveConfig,
      environmentId: "env-err",
      heartbeatRunId: "run-err",
      issueId: "issue-err",
    });
    await expect(
      provider.exec({
        config: e2bLiveConfig,
        providerLeaseId: lease.providerLeaseId,
        command: "false",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
      message: expect.stringContaining("sandbox died"),
    });
  });
});

/**
 * QA-remediation: persisted-lease cleanup. A fresh provider instance must be
 * able to release/destroy/resume an existing providerLeaseId after a server
 * restart or via a deferred finalizer/cleanup worker that did not originally
 * call acquireLease. It must ALSO be able to `resumeLease(...)` then
 * `exec(...)` against the refreshed envd session (the lazy connect path that
 * the prior remediation did not cover).
 */
describe("LET-366 persisted-lease cleanup without prior acquireLease", () => {
  beforeEach(() => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  });
  afterEach(() => {
    restoreLiveFlag();
    vi.restoreAllMocks();
  });

  const persistedLeaseId = "sandbox://e2b/persisted-sandbox-abc";

  it("destroyLease on a persisted lease calls the live DELETE endpoint without prior acquireLease", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, method: init?.method ?? "GET" });
      return emptyResponse(204) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.destroyLease({
      config: e2bLiveConfig,
      providerLeaseId: persistedLeaseId,
    });
    expect(captured).toEqual([
      { url: "https://api.e2b.app/sandboxes/persisted-sandbox-abc", method: "DELETE" },
    ]);
  });

  it("releaseLease on a persisted lease maps to live DELETE (pilot default) without prior acquireLease", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, method: init?.method ?? "GET" });
      return emptyResponse(204) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.releaseLease({
      config: e2bLiveConfig,
      providerLeaseId: persistedLeaseId,
      status: "released",
    });
    expect(captured).toEqual([
      { url: "https://api.e2b.app/sandboxes/persisted-sandbox-abc", method: "DELETE" },
    ]);
  });

  it("resumeLease on a persisted lease calls the live /connect endpoint without prior acquireLease", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, method: init?.method ?? "GET" });
      return jsonResponse({
        sandboxID: "persisted-sandbox-abc",
        envdAccessToken: "envd-resume-token",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "running",
      }) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.resumeLease({
      config: e2bLiveConfig,
      providerLeaseId: persistedLeaseId,
    });
    expect(result?.providerLeaseId).toBe(persistedLeaseId);
    expect(captured).toEqual([
      { url: "https://api.e2b.app/sandboxes/persisted-sandbox-abc/connect", method: "POST" },
    ]);
  });

  it("resumeLease then exec on a fresh provider instance refreshes the envd session and sends X-Access-Token", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === "string" ? init.body : null;
      captured.push({ url, method, headers, body });
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname.endsWith("/connect")) {
        return jsonResponse({
          sandboxID: "persisted-sandbox-abc",
          envdAccessToken: "envd-refreshed-token",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return connectStreamResponse([
          { type: "data", stdout: "post-resume\n" },
          { type: "end", exitCode: 0 },
        ]) as unknown as Response;
      }
      return jsonResponse({}) as unknown as Response;
    });
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Fresh provider receives a persisted lease — resume, then exec.
    const resumed = await provider.resumeLease({
      config: e2bLiveConfig,
      providerLeaseId: persistedLeaseId,
    });
    expect(resumed?.providerLeaseId).toBe(persistedLeaseId);
    const result = await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: persistedLeaseId,
      command: "echo",
      args: ["post-resume"],
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "post-resume\n" });

    // Exactly two calls: /connect then envd /process.Process/Start. The exec
    // call must carry the refreshed envd access token (NOT null, NOT the API
    // key) and must target the envd host with the resolved domain.
    const requests = captured.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(requests).toEqual([
      "POST /sandboxes/persisted-sandbox-abc/connect",
      "POST /process.Process/Start",
    ]);
    const execCall = captured[1]!;
    const parsedExecUrl = new URL(execCall.url);
    expect(parsedExecUrl.host).toBe("49983-persisted-sandbox-abc.e2b.app");
    expect(execCall.headers["X-Access-Token"]).toBe("envd-refreshed-token");
    expect(execCall.headers["Authorization"]).toBeUndefined();
    // The API key must NOT appear anywhere in the exec request URL/body/headers.
    const execBlob = JSON.stringify({ url: execCall.url, headers: execCall.headers, body: execCall.body });
    expect(execBlob).not.toContain(RESOLVED_API_KEY_CANARY);
  });

  it("persisted-lease cleanup still fails closed when the three-gate check fails", async () => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });
    await expect(
      provider.destroyLease({ config: e2bLiveConfig, providerLeaseId: persistedLeaseId }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "env_flag" }),
    });
    await expect(
      provider.releaseLease({ config: e2bLiveConfig, providerLeaseId: persistedLeaseId, status: "released" }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
    });
    await expect(
      provider.resumeLease({ config: e2bLiveConfig, providerLeaseId: persistedLeaseId }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("LET-366 SANDBOX_PROVIDER_ALLOW_LIVE env-gate strict equality", () => {
  afterEach(() => {
    restoreLiveFlag();
  });

  it("returns false when the env flag is unset", () => {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
    expect(isManagedSandboxLiveAllowed()).toBe(false);
  });

  it("returns true only for the exact string 'true'", () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    expect(isManagedSandboxLiveAllowed()).toBe(true);
  });

  it.each(["1", "TRUE", "True", "yes", "on", " true", "true ", ""])(
    "fails closed for non-canonical flag value %j",
    (value) => {
      process.env.SANDBOX_PROVIDER_ALLOW_LIVE = value;
      expect(isManagedSandboxLiveAllowed()).toBe(false);
    },
  );

  it("does not initialise the live transport when the env flag is '1' even with all other gates passing", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn(async () => RESOLVED_API_KEY_CANARY);
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey,
      fetchImpl: globalThis.fetch.bind(globalThis),
      liveTransportFactory,
    });
    await expect(
      provider.acquireLease({
        config: e2bLiveConfig,
        environmentId: "env-strict",
        heartbeatRunId: "run-strict",
        issueId: "issue-strict",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "env_flag", liveFlagSet: false }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });
});

describe("LET-366 PreProviderRedactionRegistry semantics", () => {
  it("ignores values shorter than four characters to avoid masking benign tokens", () => {
    const registry = new PreProviderRedactionRegistry();
    registry.register("a");
    registry.register("ab");
    registry.register("abcd");
    expect(registry.size()).toBe(1);
    expect(registry.redact("abc abcd xyz")).toBe("abc [REDACTED] xyz");
  });

  it("redacts longer overlapping secrets in longest-first order", () => {
    const registry = new PreProviderRedactionRegistry();
    registry.register("abcd");
    registry.register("abcdefgh");
    expect(registry.redact("prefix abcdefgh middle abcd suffix")).toBe(
      "prefix [REDACTED] middle [REDACTED] suffix",
    );
  });

  it("returns the input unchanged when the registry is empty", () => {
    const registry = new PreProviderRedactionRegistry();
    expect(registry.redact("anything goes here")).toBe("anything goes here");
  });

  it("handles non-string inputs defensively", () => {
    const registry = new PreProviderRedactionRegistry();
    registry.register("sensitive-value");
    // @ts-expect-error — defensive: callers may hand undefined when the
    // source value was optional. The redactor must not throw.
    expect(registry.redact(undefined)).toBeUndefined();
  });
});

/**
 * Low-level unit coverage for the Connect framing + bash-wrapping helpers
 * the transport relies on. Keeping these as a separate describe lets future
 * QA passes spot wire-level regressions independently of provider semantics.
 */
describe("LET-366 transport helpers (Connect framing + bash wrap)", () => {
  it("decodes a Connect server-streaming body into messages + trailers", () => {
    const body = buildConnectStreamingBody(
      [
        { type: "data", stdout: "abc" },
        { type: "end", exitCode: 0 },
      ],
      {},
    );
    const decoded = transportTesting.decodeConnectStreamingBody(body);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.trailers).toEqual({});
  });

  it("aggregates ProcessEvent stdout/stderr/exitCode into a SandboxExecuteResult", () => {
    const messages = [
      { event: { data: { stdout: Buffer.from("hello", "utf8").toString("base64") } } },
      { event: { data: { stderr: Buffer.from("warn", "utf8").toString("base64") } } },
      { event: { end: { exitCode: 42 } } },
    ];
    const result = transportTesting.aggregateProcessEvents(messages, {});
    expect(result).toEqual({ exitCode: 42, stdout: "hello", stderr: "warn" });
  });

  it("shell-quotes only tokens with shell-significant characters", () => {
    expect(transportTesting.shellQuoteArg("hello")).toBe("hello");
    expect(transportTesting.shellQuoteArg("with space")).toBe("'with space'");
    expect(transportTesting.shellQuoteArg("it's")).toBe(`'it'"'"'s'`);
  });

  it("builds a bash -l -c-compatible command from command + args", () => {
    expect(transportTesting.buildBashCommand("echo", ["hello"])).toBe("echo hello");
    expect(transportTesting.buildBashCommand("ls", ["-la", "/tmp"])).toBe("ls -la /tmp");
    expect(transportTesting.buildBashCommand("echo", ["hi there"])).toBe("echo 'hi there'");
    expect(transportTesting.buildBashCommand("pwd", [])).toBe("pwd");
    expect(transportTesting.buildBashCommand("pwd", undefined)).toBe("pwd");
  });
});
