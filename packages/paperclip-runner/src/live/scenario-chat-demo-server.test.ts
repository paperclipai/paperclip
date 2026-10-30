import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  assertScenarioChatEnvironmentSafe,
  forbiddenScenarioChatEnvironmentNames,
  scenarioChatCapabilityCookieForOrigin,
  ScenarioChatDemoRuntime,
} from "./scenario-chat-demo-server.js";
import { CapabilityChatSession } from "../scenarios/chat-session.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(packageRoot, "src");

describe("Scenario chat deployment boundary", () => {
  it("constructs the concrete mock and initializes a ready, bounded runtime", async () => {
    const runtime = new ScenarioChatDemoRuntime({
      publicOrigin: "https://scenario-chat.example.ts.net",
      basePath: "/scenario-chat",
      commitSha: "deadbeef",
      packageRoot,
      log: () => undefined,
    });
    await runtime.initialize();
    expect(runtime.health()).toMatchObject({
      ready: true,
      commitSha: "deadbeef",
      controlPlane: "capability-mock",
      providerAuthentication: "server-side",
      credentialsExposed: false,
      networkEgress: "denied",
      retention: "memory-only",
      activeSessions: 0,
    });
    await runtime.shutdown();
  });

  it("requires an explicit opt-in for tailnet HTTP and uses an HTTP-compatible capability cookie", async () => {
    expect(() => new ScenarioChatDemoRuntime({
      publicOrigin: "http://scenario-chat.example.ts.net:4197",
      basePath: "/scenario-chat",
      commitSha: "deadbeef",
      packageRoot,
      log: () => undefined,
    })).toThrow(/explicitly enabled/);

    const publicOrigin = "http://scenario-chat.example.ts.net:4197";
    const runtime = new ScenarioChatDemoRuntime({
      publicOrigin,
      basePath: "/scenario-chat",
      commitSha: "deadbeef",
      allowInsecureHttp: true,
      packageRoot,
      log: () => undefined,
    });
    await runtime.initialize();
    expect(runtime.health()).toMatchObject({ ready: true, commitSha: "deadbeef" });
    const setCookie = scenarioChatCapabilityCookieForOrigin(new URL(publicOrigin), "capability");
    expect(setCookie).toContain("paperclip_scenario-chat=capability");
    expect(setCookie).not.toContain("__Host-");
    expect(setCookie).not.toMatch(/; Secure(?:;|$)/);
    expect(setCookie).toContain("SameSite=Strict");
    await runtime.shutdown();
  });

  it("rejects ambient credential families by name without inspecting values", () => {
    const unsafe = {
      PATH: "/usr/bin",
      PAPERCLIP_API_KEY: "not-read",
      AWS_SECRET_ACCESS_KEY: "not-read",
      OPENAI_API_KEY: "not-read",
      VERCEL_TOKEN: "not-read",
    };
    expect(forbiddenScenarioChatEnvironmentNames(unsafe)).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "PAPERCLIP_API_KEY",
      "VERCEL_TOKEN",
    ]);
    expect(() => assertScenarioChatEnvironmentSafe(unsafe)).toThrow(/forbidden environment names/);
    expect(() => assertScenarioChatEnvironmentSafe({
      NODE_ENV: "production",
      PATH: "/usr/bin",
      SCENARIO_CHAT_COMMIT_SHA: "deadbeef",
      SCENARIO_CHAT_PUBLIC_ORIGIN: "https://scenario-chat.example.ts.net",
    })).not.toThrow();
  });

  it("keeps the deployed source closure package-local, mock-only, and free of dynamic imports", async () => {
    const closure = await sourceClosure(resolve(sourceRoot, "live/scenario-chat-demo-server.ts"));
    const rootSource = await readFile(resolve(sourceRoot, "live/scenario-chat-demo-server.ts"), "utf8");
    expect(rootSource).toContain('import { CapabilityMockControlPlaneAdapter }');
    expect(rootSource).toContain("new CapabilityMockControlPlaneAdapter(fixture.seed)");
    expect(closure.size).toBeGreaterThan(10);

    for (const [path, source] of closure) {
      expect(source, path).not.toMatch(/\bimport\s*\(/);
      expect(source, path).not.toMatch(/PaperclipControlPlanePort|PAPERCLIP_API_(?:URL|KEY)|@paperclipai\/db/);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${path} imports outside the standalone boundary`).not.toMatch(
          /^(?:server|ui|cli)(?:\/|$)|^@paperclipai\/(?!paperclip-runner(?:\/|$))/,
        );
      }
    }
  });

  it("requires the trusted proxy marker and exact forwarded authority over HTTP", async () => {
    await withHttpRuntime(async ({ request }) => {
      expect(await request("/api/capability/health", {
        headers: { ...proxyHeaders(), "x-scenario-chat-proxy": "" },
      })).toMatchObject({
        status: 403,
        body: { error: { code: "trusted_proxy_required" } },
      });
      expect(await request("/api/capability/health", {
        headers: { ...proxyHeaders(), "x-forwarded-proto": "https,http" },
      })).toMatchObject({ status: 403, body: { error: { code: "transport_denied" } } });
      expect(await request("/api/capability/health", {
        headers: {
          ...proxyHeaders(),
          "x-forwarded-host": "scenario-chat.example.ts.net,attacker.example",
        },
      })).toMatchObject({ status: 403, body: { error: { code: "host_denied" } } });
      expect(await request("/api/capability/health", { headers: proxyHeaders() })).toMatchObject({
        status: 200,
        body: { status: "ok", controlPlane: "capability-mock" },
      });
    });
  });

  it("requires exact Origin and Fetch Metadata on every mutation", async () => {
    await withHttpRuntime(async ({ request }) => {
      const body = JSON.stringify({ scenarioId: SCENARIO_ID });
      const invalidHeaders = [
        { origin: `${PUBLIC_ORIGIN}/` },
        { "sec-fetch-site": "none" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-mode": "same-origin" },
        { "sec-fetch-dest": "document" },
      ];
      for (const replacement of invalidHeaders) {
        const response = await request("/api/capability/sessions", {
          method: "POST",
          headers: { ...mutationHeaders(), ...replacement },
          body,
        });
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ error: { code: expect.stringMatching(/^(?:origin|fetch_metadata)_denied$/) } });
      }
      const missingFetchSite = mutationHeaders();
      delete missingFetchSite["sec-fetch-site"];
      expect(await request("/api/capability/sessions", {
        method: "POST",
        headers: missingFetchSite,
        body,
      })).toMatchObject({ status: 403, body: { error: { code: "fetch_metadata_denied" } } });
    });
  });

  it("accepts only JSON objects with the exact route fields", async () => {
    await withHttpRuntime(async ({ request }) => {
      for (const contentType of ["text/plain", "application/jsonp"]) {
        expect(await request("/api/capability/sessions", {
          method: "POST",
          headers: { ...mutationHeaders(), "content-type": contentType },
          body: JSON.stringify({ scenarioId: SCENARIO_ID }),
        })).toMatchObject({ status: 415, body: { error: { code: "json_required" } } });
      }
      expect(await request("/api/capability/sessions", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ scenarioId: SCENARIO_ID, adapter: "paperclip" }),
      })).toMatchObject({ status: 422, body: { error: { code: "unexpected_field" } } });
    });
  });

  it("returns the same 404 for missing, foreign, or identity-mismatched session authority", async () => {
    await withHttpRuntime(async ({ request }) => {
      const created = await createSession(request, "alice@example.com");
      const failures = [
        mutationHeaders("alice@example.com"),
        { ...mutationHeaders("alice@example.com"), cookie: "__Host-paperclip_scenario-chat=foreign" },
        { ...mutationHeaders("mallory@example.com"), cookie: created.cookie },
      ];
      for (const headers of failures) {
        const response = await request(`/api/capability/sessions/${created.id}/replay`, {
          method: "POST",
          headers,
          body: "{}",
        });
        expect(response).toMatchObject({
          status: 404,
          body: { error: { code: "session_not_found", message: "Session was not found." } },
        });
      }
    });
  });

  it("isolates two sessions even when the tailnet identity is shared", async () => {
    await withHttpRuntime(async ({ request }) => {
      const first = await createSession(request, "alice@example.com");
      const second = await createSession(request, "alice@example.com");
      expect(first.id).not.toBe(second.id);
      expect(first.cookie).not.toBe(second.cookie);

      expect(await replaySession(request, second.id, first.cookie, "alice@example.com")).toMatchObject({
        status: 404,
        body: { error: { code: "session_not_found" } },
      });
      expect(await replaySession(request, first.id, first.cookie, "alice@example.com")).toMatchObject({
        status: 200,
        body: { sessionId: first.id },
      });
      expect(await replaySession(request, second.id, second.cookie, "alice@example.com")).toMatchObject({
        status: 200,
        body: { sessionId: second.id },
      });
    });
  });

  it("rotates both session id and capability on reset and invalidates the old pair", async () => {
    await withHttpRuntime(async ({ request }) => {
      const original = await createSession(request, "alice@example.com");
      const reset = await request(`/api/capability/sessions/${original.id}/reset`, {
        method: "POST",
        headers: { ...mutationHeaders("alice@example.com"), cookie: original.cookie },
        body: "{}",
      });
      expect(reset.status).toBe(200);
      const replacementId = sessionId(reset);
      const replacementCookie = responseCookie(reset);
      expect(replacementId).not.toBe(original.id);
      expect(replacementCookie).not.toBe(original.cookie);

      expect(await replaySession(request, original.id, original.cookie, "alice@example.com")).toMatchObject({
        status: 404,
        body: { error: { code: "session_not_found" } },
      });
      expect(await replaySession(request, replacementId, original.cookie, "alice@example.com")).toMatchObject({
        status: 404,
        body: { error: { code: "session_not_found" } },
      });
      expect(await replaySession(request, replacementId, replacementCookie, "alice@example.com")).toMatchObject({
        status: 200,
        body: { sessionId: replacementId },
      });
    });
  });

  it("denies a concurrent second turn without invoking the chat twice", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const started = new Promise<void>((resolveStarted) => {
      entered = resolveStarted;
    });
    const originalSend = CapabilityChatSession.prototype.send;
    const send = vi.spyOn(CapabilityChatSession.prototype, "send").mockImplementationOnce(
      async function (this: CapabilityChatSession, prompt: string) {
        entered();
        await gate;
        return await originalSend.call(this, prompt);
      },
    );
    try {
      await withHttpRuntime(async ({ request }) => {
        const session = await createSession(request, "alice@example.com");
        const firstTurn = request(`/api/capability/sessions/${session.id}/turn`, {
          method: "POST",
          headers: { ...mutationHeaders("alice@example.com"), cookie: session.cookie },
          body: JSON.stringify({ prompt: "First turn" }),
        });
        await started;
        expect(await request(`/api/capability/sessions/${session.id}/turn`, {
          method: "POST",
          headers: { ...mutationHeaders("alice@example.com"), cookie: session.cookie },
          body: JSON.stringify({ prompt: "Second turn" }),
        })).toMatchObject({ status: 409, body: { error: { code: "turn_active" } } });
        release();
        expect(await firstTurn).toMatchObject({ status: 200, body: { sessionId: session.id } });
        expect(send).toHaveBeenCalledTimes(1);
      });
    } finally {
      release();
      send.mockRestore();
    }
  });

  it("enforces prompt, body, session-capacity, and request-rate bounds", async () => {
    await withHttpRuntime(async ({ request }) => {
      const session = await createSession(request, "alice@example.com");
      expect(await request(`/api/capability/sessions/${session.id}/turn`, {
        method: "POST",
        headers: { ...mutationHeaders("alice@example.com"), cookie: session.cookie },
        body: JSON.stringify({ prompt: "x".repeat(16 * 1024 + 1) }),
      })).toMatchObject({ status: 422, body: { error: { code: "prompt_too_large" } } });
      expect(await request("/api/capability/sessions", {
        method: "POST",
        headers: mutationHeaders("body@example.com"),
        body: JSON.stringify({ scenarioId: SCENARIO_ID, padding: "x".repeat(64 * 1024) }),
      })).toMatchObject({ status: 413, body: { error: { code: "request_too_large" } } });

      for (let index = 1; index < 8; index += 1) {
        expect((await createSession(request, `capacity-${index}@example.com`)).id).toHaveLength(32);
      }
      expect(await request("/api/capability/sessions", {
        method: "POST",
        headers: mutationHeaders("capacity-overflow@example.com"),
        body: JSON.stringify({ scenarioId: SCENARIO_ID }),
      })).toMatchObject({ status: 429, body: { error: { code: "session_capacity" } } });
    });

    await withHttpRuntime(async ({ request }) => {
      for (let index = 0; index < 90; index += 1) {
        expect((await request(`/api/capability/missing-${index}`, {
          method: "POST",
          headers: mutationHeaders("rate@example.com"),
          body: "{}",
        })).status).toBe(404);
      }
      expect(await request("/api/capability/rate-limit", {
        method: "POST",
        headers: mutationHeaders("rate@example.com"),
        body: "{}",
      })).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    });
  });

  it("returns stable redacted internal errors and security headers", async () => {
    await withHttpRuntime(async ({ request }) => {
      const first = await request("/%", { headers: proxyHeaders() });
      const second = await request("/%E0%A4%A", { headers: proxyHeaders() });
      expect(first).toMatchObject({
        status: 500,
        body: { error: { code: "internal_error", message: "The request could not be completed." } },
      });
      expect(second.body).toEqual(first.body);
      expect(JSON.stringify(first.body)).not.toMatch(/URIError|decodeURIComponent|%E0|stack/i);

      for (const response of [first, await request("/api/capability/health", { headers: proxyHeaders() })]) {
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
        expect(response.headers.get("permissions-policy")).toContain("camera=()");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      }
    });
  });
});

const PUBLIC_ORIGIN = "https://scenario-chat.example.ts.net";
const SCENARIO_ID = "hb-inbox-lite-01";

type HttpResult = {
  status: number;
  headers: Headers;
  body: unknown;
};

type HttpRequest = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResult>;

function proxyHeaders(identity = "alice@example.com"): Record<string, string> {
  return {
    "tailscale-user-login": identity,
    "x-forwarded-host": new URL(PUBLIC_ORIGIN).host,
    "x-forwarded-proto": new URL(PUBLIC_ORIGIN).protocol.slice(0, -1),
    "x-scenario-chat-proxy": "v1",
  };
}

function mutationHeaders(identity = "alice@example.com"): Record<string, string> {
  return {
    ...proxyHeaders(identity),
    "content-type": "application/json; charset=utf-8",
    origin: PUBLIC_ORIGIN,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

async function withHttpRuntime(
  run: (context: { runtime: ScenarioChatDemoRuntime; request: HttpRequest }) => Promise<void>,
): Promise<void> {
  const runtime = new ScenarioChatDemoRuntime({
    publicOrigin: PUBLIC_ORIGIN,
    basePath: "",
    commitSha: "deadbeef",
    packageRoot,
    log: () => undefined,
  });
  await runtime.initialize();
  const server = runtime.createServer();
  const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
  const socketDirectory = await mkdtemp(resolve(scratchRoot, "scenario-chat-http-"));
  const socketPath = resolve(socketDirectory, "server.sock");
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const request: HttpRequest = async (path, init = {}) => {
    return await new Promise<HttpResult>((resolveRequest, rejectRequest) => {
      const request = httpRequest({
        socketPath,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", rejectRequest);
        response.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, String(value));
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            status: response.statusCode ?? 0,
            headers,
            body: text === "" ? null : JSON.parse(text) as unknown,
          });
        });
      });
      request.once("error", rejectRequest);
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };
  try {
    await run({ runtime, request });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    await runtime.shutdown();
    await rm(socketDirectory, { recursive: true, force: true });
  }
}

async function createSession(request: HttpRequest, identity: string): Promise<{ id: string; cookie: string }> {
  const response = await request("/api/capability/sessions", {
    method: "POST",
    headers: mutationHeaders(identity),
    body: JSON.stringify({ scenarioId: SCENARIO_ID }),
  });
  expect(response.status).toBe(201);
  return { id: sessionId(response), cookie: responseCookie(response) };
}

function sessionId(response: HttpResult): string {
  if (
    typeof response.body !== "object" ||
    response.body === null ||
    !("sessionId" in response.body) ||
    typeof response.body.sessionId !== "string"
  ) {
    throw new Error("response did not contain a session id");
  }
  return response.body.sessionId;
}

function responseCookie(response: HttpResult): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("response did not set a capability cookie");
  return setCookie.split(";", 1)[0]!;
}

async function replaySession(
  request: HttpRequest,
  id: string,
  cookie: string,
  identity: string,
): Promise<HttpResult> {
  return await request(`/api/capability/sessions/${id}/replay`, {
    method: "POST",
    headers: { ...mutationHeaders(identity), cookie },
    body: "{}",
  });
}

function importSpecifiers(source: string): string[] {
  const matches = source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]{0,500}?\s+from\s+)?["']([^"']+)["']/g);
  return [...matches].map((match) => match[1]!);
}

async function sourceClosure(entry: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    if (found.has(path)) return;
    const source = await readFile(path, "utf8");
    found.set(path, source);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const imported = resolve(dirname(path), specifier);
      const target = extname(imported) === ".js" ? `${imported.slice(0, -3)}.ts` : imported;
      await visit(target);
    }
  };
  await visit(entry);
  return found;
}
