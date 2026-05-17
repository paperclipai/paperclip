/**
 * Phase 4A-S4 (LET-366) — Live E2BSandboxProvider behind SANDBOX_PROVIDER_ALLOW_LIVE.
 *
 * These tests cover the three acceptance criteria that distinguish the live
 * adapter from the LET-351 mock-only spike:
 *
 *  1. Three-gate fail-closed: PROVIDER_DISABLED is thrown from `acquireLease`
 *     before any HTTP egress when any of the three gates is missing.
 *  2. Pre-egress redaction boundary: a resolved-secret canary registered into
 *     the pre-provider redaction registry never reaches the captured outbound
 *     payload (request body, env values, command args, stdin, headers).
 *  3. Lifecycle mapping: acquireLease → POST /sandboxes, start → resume,
 *     exec → commands, release → DELETE (pilot default), destroy → DELETE.
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
        return jsonResponse({ id: "e2b-sandbox-live-1", state: "created", metadata: {} }) as unknown as Response;
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
        return jsonResponse({ id: "e2b-sandbox-canary-1", state: "created", metadata: {} }) as unknown as Response;
      }
      if (method === "DELETE") {
        return { ok: true, status: 204, text: async () => "" } as unknown as Response;
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

    // The Authorization header is the only place where the resolved key is
    // legitimately handed to the transport in raw form. Verify the captured
    // hook (which is observability-only) never sees the raw token there
    // either — the hook view shows the redacted projection.
    for (const request of captured) {
      const auth = request.headers["Authorization"];
      if (auth) {
        expect(auth).toContain("[REDACTED]");
        expect(auth).not.toContain(RESOLVED_API_KEY_CANARY);
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

  it("maps the Paperclip lifecycle to the E2B HTTP surface (create → resume → commands → DELETE) by default", async () => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
    const recorded: Array<{ method: string; path: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      recorded.push({ method, path });
      if (method === "POST" && path === "/sandboxes") {
        return jsonResponse({ id: "e2b-sandbox-lifecycle", state: "created", metadata: {} }) as unknown as Response;
      }
      if (method === "POST" && path.endsWith("/resume")) {
        return jsonResponse({ id: "e2b-sandbox-lifecycle", state: "running", metadata: {} }) as unknown as Response;
      }
      if (method === "POST" && path.endsWith("/commands")) {
        return jsonResponse({ exitCode: 0, stdout: "ok", stderr: "" }) as unknown as Response;
      }
      if (method === "DELETE") {
        return { ok: true, status: 204, text: async () => "" } as unknown as Response;
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
      { method: "POST", path: "/sandboxes" },
      { method: "POST", path: "/sandboxes/e2b-sandbox-lifecycle/resume" },
      { method: "POST", path: "/sandboxes/e2b-sandbox-lifecycle/commands" },
      // releaseLease maps to DELETE per pilot default (no warm reuse).
      { method: "DELETE", path: "/sandboxes/e2b-sandbox-lifecycle" },
      // destroyLease maps to DELETE.
      { method: "DELETE", path: "/sandboxes/e2b-sandbox-lifecycle" },
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
        return jsonResponse({ id: "e2b-sandbox-pause", state: "created", metadata: {} }) as unknown as Response;
      }
      return { ok: true, status: 204, text: async () => "" } as unknown as Response;
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
