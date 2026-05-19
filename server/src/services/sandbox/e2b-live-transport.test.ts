/**
 * Phase 4A-S4 (LET-431): focused transport-level unit tests for the
 * `E2BLiveHttpTransport` create/start lifecycle.
 *
 * Background: LET-370 fired the LET-366 live transport against api.e2b.app
 * with run id `9180a7a6-4284-4b35-99af-bd203f4297a9` and observed:
 *   POST /sandboxes                              → 200 (envd session populated)
 *   POST /sandboxes/ipvc2pptrh5yv6phoxnfq/connect → 400  (TRANSPORT_ERROR)
 *
 * Root cause: `connectSandbox` was unconditionally invoked from
 * `startSandbox`, even when the create response had already returned
 * `envdAccessToken` + `domain`. The E2B control plane rejects a redundant
 * `/connect` call against a freshly-created sandbox (the SDK does not make
 * that call either — `Sandbox.create` reads the session from the create
 * response; only `Sandbox.connect(id)` posts to `/connect`).
 *
 * These tests pin down the fix at the transport layer, independent of the
 * provider wrapper:
 *
 *  1. Fresh-create path: `createSandbox` then `startSandbox` makes ONE
 *     control-plane call (`POST /sandboxes`) — no `/connect`.
 *  2. Resume path: `startSandbox` against a sandbox the transport has never
 *     seen falls back to `POST /sandboxes/{id}/connect` (persisted-lease
 *     recovery / fresh provider instance).
 *  3. Resume path: if the cached session is incomplete (e.g. envdAccessToken
 *     missing — defensive against a create response without the token),
 *     `startSandbox` falls back to `/connect`.
 *  4. Regression guard: the LET-370 captured shape (one `/connect` after
 *     `/sandboxes`) is rejected — assertion fails if any future change
 *     reintroduces it on the fresh-create path.
 *
 * No live HTTP: every test injects a stub fetch. No new dependencies.
 */

import { describe, expect, it, vi } from "vitest";

import { PreProviderRedactionRegistry } from "./pre-provider-redaction.js";
import { E2BLiveHttpTransport } from "./e2b-live-transport.js";

const DUMMY_API_KEY = "let-431-dummy-api-key-do-not-leak";

interface CapturedFetchCall {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

interface MockResponse {
  ok: true;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function jsonResponse(body: unknown, status = 200): MockResponse {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

function makeTransport(fetchImpl: typeof fetch): E2BLiveHttpTransport {
  const redactor = new PreProviderRedactionRegistry();
  redactor.register(DUMMY_API_KEY);
  return new E2BLiveHttpTransport({
    apiKey: DUMMY_API_KEY,
    fetchImpl,
    redactor,
  });
}

describe("LET-431 E2BLiveHttpTransport — startSandbox /connect skipping", () => {
  it("fresh-create: startSandbox makes NO /connect call when createSandbox already populated the session", async () => {
    const calls: CapturedFetchCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      const parsed = new URL(url);
      if (parsed.pathname === "/sandboxes" && init?.method === "POST") {
        return jsonResponse({
          sandboxID: "sb-fresh-1",
          clientID: "client-fresh",
          envdAccessToken: "envd-token-fresh",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${parsed.pathname}`);
    });
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);

    const created = await transport.createSandbox({
      config: { template: "base" },
      environmentId: "env-1",
      heartbeatRunId: "run-1",
      issueId: null,
    });
    expect(created.id).toBe("sb-fresh-1");

    const started = await transport.startSandbox({ sandboxId: "sb-fresh-1" });
    expect(started.state).toBe("running");
    expect(started.metadata).toMatchObject({
      provider: "e2b",
      domain: "e2b.app",
      envdVersion: "v0.1.99",
    });

    // Exactly ONE control-plane call: POST /sandboxes. No /connect.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/sandboxes");
    expect(calls.some((c) => new URL(c.url).pathname.endsWith("/connect"))).toBe(false);
  });

  it("resume: startSandbox falls back to POST /connect with the SDK-shaped { timeout } body when the in-memory session is empty", async () => {
    const calls: CapturedFetchCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/connect") && init?.method === "POST") {
        return jsonResponse({
          sandboxID: "sb-resumed-1",
          envdAccessToken: "envd-token-resumed",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
        }) as unknown as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${parsed.pathname}`);
    });
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);

    // No prior createSandbox — fresh transport instance simulating a
    // server restart that handed us a persisted lease id. Caller supplies
    // an explicit 45_000 ms budget that should be rounded up to 45 seconds.
    const started = await transport.startSandbox({
      sandboxId: "sb-resumed-1",
      timeoutMs: 45_000,
    });
    expect(started.metadata).toMatchObject({
      domain: "e2b.app",
      envdVersion: "v0.1.99",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/sandboxes/sb-resumed-1/connect");
    // SDK-aligned body: `{ timeout: ceil(timeoutMs / 1000) }`.
    // e2b@2.20.x `SandboxApi.connectSandbox` sends exactly this shape.
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ timeout: 45 });
  });

  it("resume: startSandbox falls back to the SDK's DEFAULT_SANDBOX_TIMEOUT_MS (300_000) when the caller omits timeoutMs", async () => {
    const calls: CapturedFetchCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/connect") && init?.method === "POST") {
        return jsonResponse({
          sandboxID: "sb-resumed-default",
          envdAccessToken: "envd-token-resumed",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
        }) as unknown as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${parsed.pathname}`);
    });
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);

    await transport.startSandbox({ sandboxId: "sb-resumed-default" });
    // 300_000 ms → 300 s (SDK `DEFAULT_SANDBOX_TIMEOUT_MS`).
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ timeout: 300 });
  });

  it("defensive resume: if a create response did not include envdAccessToken, startSandbox refreshes via /connect", async () => {
    const calls: CapturedFetchCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      const parsed = new URL(url);
      if (parsed.pathname === "/sandboxes" && init?.method === "POST") {
        // Intentionally NO envdAccessToken — the cached session is incomplete.
        return jsonResponse({
          sandboxID: "sb-incomplete-1",
          clientID: "client-incomplete",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (parsed.pathname.endsWith("/connect") && init?.method === "POST") {
        return jsonResponse({
          sandboxID: "sb-incomplete-1",
          envdAccessToken: "envd-token-refreshed",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "running",
        }) as unknown as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${parsed.pathname}`);
    });
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);

    await transport.createSandbox({
      config: { template: "base" },
      environmentId: "env-i",
      heartbeatRunId: "run-i",
      issueId: null,
    });
    await transport.startSandbox({ sandboxId: "sb-incomplete-1" });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /sandboxes",
      "POST /sandboxes/sb-incomplete-1/connect",
    ]);
  });

  it("LET-370 regression guard: fresh-create + start must never reproduce the create→/connect→400 shape", async () => {
    // This test stubs the E2B control plane to mimic the LET-370 production
    // behaviour: create succeeds, /connect 400s. A regression that brings
    // back the unconditional /connect will surface as TRANSPORT_ERROR here.
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/sandboxes" && init?.method === "POST") {
        return jsonResponse({
          sandboxID: "sb-regression-1",
          envdAccessToken: "envd-token-regression",
          envdVersion: "v0.1.99",
          domain: "e2b.app",
          state: "created",
        }) as unknown as Response;
      }
      if (parsed.pathname.endsWith("/connect")) {
        // Simulate the LET-370 captured 400.
        return {
          ok: false,
          status: 400,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${parsed.pathname}`);
    });
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);

    await transport.createSandbox({
      config: { template: "base" },
      environmentId: "env-r",
      heartbeatRunId: "run-r",
      issueId: null,
    });
    // With the LET-431 fix, this resolves without ever hitting /connect.
    // Without it (regression), this throws PROVIDER_FAILURE / HTTP 400.
    await expect(transport.startSandbox({ sandboxId: "sb-regression-1" })).resolves.toMatchObject({
      state: "running",
    });
  });
});
