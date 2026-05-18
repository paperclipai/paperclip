/**
 * Phase 4A-S4 (LET-366) — Live E2BSandboxProvider behind SANDBOX_PROVIDER_ALLOW_LIVE.
 *
 * These tests cover the acceptance criteria that distinguish the live adapter
 * from the LET-351 mock-only spike, and the QA-remediated contract surface:
 *
 *  1. Three-gate fail-closed: PROVIDER_DISABLED is thrown from `acquireLease`
 *     before any HTTP egress when any of the three gates is missing.
 *  2. Pre-egress redaction boundary: a resolved-secret canary registered into
 *     the pre-provider redaction registry never reaches the captured outbound
 *     payload (request body, env values, command args, stdin, headers).
 *  3. Lifecycle mapping: acquireLease → POST /sandboxes (api.e2b.app),
 *     start → POST /sandboxes/{id}/resume, exec → POST {envdHost}/process.Process/Start,
 *     release → DELETE /sandboxes/{id} (pilot default), destroy → DELETE.
 *  4. E2B documented HTTP contract: control-plane requests use `X-API-Key`
 *     (not `Authorization: Bearer`); create body uses `templateID`, `timeout`
 *     (seconds), `envVars`; sandbox-side exec uses Connect protocol with
 *     `application/connect+json`, `X-Access-Token`, and `Authorization: Basic`.
 *  5. Persisted-lease cleanup: a fresh provider instance can release/destroy/
 *     resume an existing providerLeaseId without calling acquireLease first.
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
import type { E2BCapturedRequest } from "./e2b-live-transport.js";

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
}

function jsonResponse(body: unknown, status = 200): OkResponse {
  return {
    ok: true,
    status,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204): OkResponse {
  return { ok: true, status, text: async () => "" };
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
    // Plant additional canaries (e.g. resolved env-bound secrets) into the
    // per-run registry BEFORE acquireLease so the live transport never echoes
    // them in any captured outbound payload.
    sharedRegistry.register(ENV_SECRET_CANARY);
    sharedRegistry.register(STDIN_CANARY);

    const captured: E2BCapturedRequest[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return jsonResponse({
          sandboxID: "e2b-sandbox-canary-1",
          clientID: "client-abc",
          envdAccessToken: "envd-canary-token",
          state: "created",
          metadata: {},
        }) as unknown as Response;
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

    // After the secret was resolved, the registry must contain at least the
    // resolved API key (plus any caller-planted canaries).
    expect(sharedRegistry.size()).toBeGreaterThanOrEqual(3);

    // The API-key header (control plane) and the Basic/X-Access-Token headers
    // (sandbox-side envd Connect) are the only places where the resolved key
    // or envd token are legitimately handed to the transport. The captured
    // hook view must show the redacted projection for all of them.
    for (const request of captured) {
      for (const header of ["X-API-Key", "Authorization", "X-Access-Token"]) {
        const value = request.headers[header];
        if (value) {
          expect(value).toContain("[REDACTED]");
          expect(value).not.toContain(RESOLVED_API_KEY_CANARY);
        }
      }
    }

    // Every captured outbound payload must be free of the canary values —
    // command lines, env values, stdin, request body, non-auth headers.
    const haystack = JSON.stringify(captured);
    expect(haystack).not.toContain(RESOLVED_API_KEY_CANARY);
    expect(haystack).not.toContain(ENV_SECRET_CANARY);
    expect(haystack).not.toContain(STDIN_CANARY);

    // The non-secret args/env values must still be visible so callers can
    // confirm redaction is targeted, not blanket.
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
          state: "created",
          metadata: {},
        }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname.endsWith("/resume")) {
        return jsonResponse({ sandboxID: "e2b-sandbox-lifecycle", state: "running", metadata: {} }) as unknown as Response;
      }
      if (method === "POST" && parsed.pathname === "/process.Process/Start") {
        return jsonResponse({ exitCode: 0, stdout: "ok", stderr: "" }) as unknown as Response;
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
      { method: "POST", host: "api.e2b.app", path: "/sandboxes/e2b-sandbox-lifecycle/resume" },
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
 * documented E2B API (X-API-Key header, templateID/timeout/envVars body
 * field names, Connect protocol headers on the envd host).
 */
describe("LET-366 E2B documented HTTP contract", () => {
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
    // Documented header for sandbox CRUD.
    expect(headers["X-API-Key"]).toBe(RESOLVED_API_KEY_CANARY);
    // Bearer is explicitly NOT used for control-plane calls.
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(first!.init?.body as string);
    // Documented body field names: templateID, timeout (seconds), envVars.
    expect(body).toMatchObject({
      templateID: "base",
      // 45_000 ms → 45 s rounded up.
      timeout: 45,
      envVars: expect.objectContaining({ SAFE_PUBLIC: "ok-public-value" }),
    });
    // Legacy field names from the pre-QA implementation must not be present.
    expect(body.image).toBeUndefined();
    expect(body.snapshot).toBeUndefined();
    expect(body.template).toBeUndefined();
    expect(body.env).toBeUndefined();
    expect(body.timeoutMs).toBeUndefined();
  });

  it("uses Connect protocol headers on the sandbox-side envd host for process.Process/Start", async () => {
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
          state: "created",
        }) as unknown as Response;
      }
      if (parsed.pathname === "/process.Process/Start") {
        return jsonResponse({ exitCode: 0, stdout: "", stderr: "" }) as unknown as Response;
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
    await provider.exec({
      config: e2bLiveConfig,
      providerLeaseId: lease.providerLeaseId,
      command: "echo",
      args: ["hello"],
    });
    expect(captured).toHaveLength(2);
    const execCall = captured[1];
    expect(execCall).toBeDefined();
    // Sandbox-side envd host (NOT api.e2b.app).
    const parsed = new URL(execCall!.url);
    expect(parsed.host).toBe("49983-sb-connect-1.e2b.app");
    expect(parsed.pathname).toBe("/process.Process/Start");
    const headers = (execCall!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/connect+json");
    expect(headers["Accept"]).toBe("application/connect+json");
    expect(headers["X-Access-Token"]).toBe("envd-token-connect");
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from(RESOLVED_API_KEY_CANARY, "utf8").toString("base64")}`,
    );
    // Body uses the documented Connect request shape: { process: { cmd, args, ... }, stdin, timeout }.
    const body = JSON.parse(execCall!.init?.body as string);
    expect(body).toMatchObject({
      process: { cmd: "echo", args: ["hello"] },
    });
  });
});

/**
 * QA-remediation: persisted-lease cleanup. A fresh provider instance must be
 * able to release/destroy/resume an existing providerLeaseId after a server
 * restart or via a deferred finalizer/cleanup worker that did not originally
 * call acquireLease. The live transport must be lazy-initialised on these
 * entry points; otherwise the inherited mock-disabled transport would throw
 * PROVIDER_DISABLED and the live sandbox would leak (live cost / lifecycle
 * integrity bug).
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

  it("resumeLease on a persisted lease calls the live resume endpoint without prior acquireLease", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const captured: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, method: init?.method ?? "GET" });
      return jsonResponse({ sandboxID: "persisted-sandbox-abc", state: "running" }) as unknown as Response;
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
      { url: "https://api.e2b.app/sandboxes/persisted-sandbox-abc/resume", method: "POST" },
    ]);
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

  // Regression: prior implementation also accepted "1" and case-insensitive
  // variants. The LET-366 acceptance criterion requires the literal value
  // "true". Any other value must fail closed so an operator cannot accidentally
  // half-enable the live transport with a non-canonical flag value.
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
