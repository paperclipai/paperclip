import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";

import { harnessRuntimeRequestOutcome } from "../contracts/harness-driver.js";
import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessGoalOperation,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestResolution,
  HarnessSession,
  HarnessSessionRecoveryResult,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { LiveConsoleDemoServer } from "./live-console-demo-server.js";

const OPAQUE_BROWSER_CREDENTIALS = {
  clientSecret: "opaque-client-secret-value",
  providerApiKey: "opaque-provider-api-key-value",
  sessionToken: "opaque-session-token-value",
  idToken: "opaque-id-token-value",
  password: "opaque-password-value",
  authorization: "opaque-authorization-value",
  cookie: "opaque-cookie-value",
} as const;

class Queue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class StubSession implements HarnessSession {
  readonly queue = new Queue<PrpEvent>();
  readonly runId: string;
  readonly normalizedSessionId: string;
  readonly requestId: string;
  readonly requestKind: HarnessRuntimeRequest["requestKind"];
  sourceSequence: number;
  activeTurnId: string | null;
  pending: HarnessRuntimeRequest[];
  currentGoal: PersistedHarnessSession["goal"];

  constructor(input: {
    runId: string;
    normalizedSessionId: string;
    requestId?: string;
    requestKind?: HarnessRuntimeRequest["requestKind"];
    sourceSequence?: number;
    activeTurnId?: string | null;
    /**
     * Requests a crash left behind. Like the real driver, recovery reports each
     * one terminal rather than adopting it as live.
     */
    stalePending?: HarnessRuntimeRequest[];
    goal?: PersistedHarnessSession["goal"];
    resumed?: boolean;
  }) {
    this.runId = input.runId;
    this.normalizedSessionId = input.normalizedSessionId;
    this.requestId = input.requestId ?? "request-demo";
    this.requestKind = input.requestKind ?? "command_approval";
    this.sourceSequence = input.sourceSequence ?? 0;
    this.activeTurnId = input.activeTurnId ?? null;
    this.pending = [];
    this.currentGoal = input.goal ?? null;
    this.emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      diagnostic: "Bearer server-only-secret",
      sandbox: {
        writableRoots: [
          "/srv/paperclip/home/.paperclip/instances/company/codex-home/memories",
          // The real app-server reports this one; it leaked before the
          // redactor covered every hidden directory under a home root.
          "/srv/paperclip/home/.codex/memories",
        ],
      },
    });
    for (const stale of input.stalePending ?? []) {
      this.emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(stale, { reason: "transport_recovered" }),
        { turnId: stale.turnId, itemId: stale.itemId },
      );
    }
  }

  ids() {
    return {
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      displayId: "thread-demo",
    };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.queue;
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.activeTurnId = "turn-demo";
    this.emit("turn.submitted", {});
    this.emit("turn.accepted", { turnId: "turn-demo" }, { turnId: "turn-demo" });
    this.emit("turn.started", { status: "inProgress" }, { turnId: "turn-demo" });
    const request: HarnessRuntimeRequest = {
      requestId: this.requestId,
      requestKind: this.requestKind,
      method: this.requestKind === "elicitation"
        ? "mcpServer/elicitation/request"
        : "item/commandExecution/requestApproval",
      turnId: "turn-demo",
      itemId: "command-demo",
      status: "pending",
      prompt: "Approve the deterministic command.",
      details: {
        provider: {
          ...OPAQUE_BROWSER_CREDENTIALS,
          nested: {
            signingKey: "opaque-signing-key-value",
            private_key: "opaque-private-key-value",
          },
        },
        usage: {
          tokenBudget: 4096,
          tokensUsed: 128,
          tokenUsage: {
            inputTokens: 96,
            outputTokens: 32,
          },
        },
        invalidUsage: { tokenBudget: "opaque-token-budget-string" },
      },
    };
    this.pending = [request];
    this.emit("runtime_request.created", {
      request: { ...request, type: request.method },
    }, { turnId: request.turnId, itemId: request.itemId });
    return { turnId: "turn-demo" };
  }

  async steer(input: { turnId: string }): Promise<void> {
    this.emit("item.completed", {
      kind: "steering_acknowledgement",
      status: "acknowledged",
      text: "Steering acknowledged.",
    }, { turnId: input.turnId, itemId: "steer-demo" });
  }

  async interrupt(input: { turnId?: string }): Promise<void> {
    this.emit("item.completed", {
      kind: "interrupt_acknowledgement",
      status: "acknowledged",
      text: "Interrupt acknowledged.",
    }, { turnId: input.turnId, itemId: "interrupt-demo" });
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return structuredClone(this.pending);
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const request = this.pending.find(({ requestId }) => requestId === input.requestId);
    if (request === undefined) throw new Error(`unknown runtime request ${input.requestId}`);
    this.pending = this.pending.filter(({ requestId }) => requestId !== input.requestId);
    this.emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(request, { action: input.resolution.action }),
      { turnId: input.turnId, itemId: request.itemId },
    );
  }

  async goal(input: HarnessGoalOperation) {
    if (input.action === "clear") this.currentGoal = null;
    else if (input.action === "set") {
      this.currentGoal = {
        threadId: "thread-demo",
        objective: input.objective,
        status: "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 2,
      };
    }
    return this.currentGoal ?? null;
  }

  lineage() {
    return [{
      threadId: "thread-demo",
      providerSessionId: "provider-demo",
      parentThreadId: null,
      depth: 0,
      nickname: null,
      role: null,
      status: "active",
    }];
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "stub",
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      activeTurnId: this.activeTurnId,
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      goal: this.currentGoal ?? null,
      lineage: this.lineage(),
      lastSourceSequence: this.sourceSequence,
    };
  }

  /** Mirrors the real driver: a graceful close settles what is still pending. */
  async close(input: { reason: string }): Promise<void> {
    for (const request of this.pending.splice(0)) {
      this.emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(request, { reason: input.reason }),
        { turnId: request.turnId, itemId: request.itemId },
      );
    }
    this.queue.close();
  }

  private emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.sourceSequence;
    this.queue.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `stub:${this.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "stub",
      sourceKind: "runner",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      ...refs,
      eventType,
      schemaVersion: 1,
      priority: 1,
      emittedAt: "2026-08-08T12:00:00.000Z",
      payload,
    });
  }
}

class StubDriver implements HarnessDriver {
  openInputs: OpenHarnessSessionInput[] = [];

  constructor(
    readonly requestId = "request-demo",
    readonly requestKind: HarnessRuntimeRequest["requestKind"] = "command_approval",
  ) {}

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: "stub",
      displayName: "Stub",
      version: "1",
      capabilities: {
        resume: true,
        typedEvents: true,
        steering: true,
        interruption: true,
        structuredResult: true,
        runtimeRequestResolution: true,
        goals: true,
        threadLineage: true,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    this.openInputs.push(structuredClone(input));
    return new StubSession({
      ...input,
      requestId: this.requestId,
      requestKind: this.requestKind,
    });
  }

  async recoverSession(snapshot: PersistedHarnessSession): Promise<HarnessSessionRecoveryResult> {
    return {
      recovered: true,
      session: new StubSession({
        runId: snapshot.runId!,
        normalizedSessionId: snapshot.normalizedSessionId!,
        requestId: this.requestId,
        requestKind: this.requestKind,
        sourceSequence: snapshot.lastSourceSequence,
        activeTurnId: snapshot.activeTurnId,
        stalePending: snapshot.pendingRuntimeRequests,
        goal: snapshot.goal,
        resumed: true,
      }),
    };
  }
}

const servers: LiveConsoleDemoServer[] = [];

function browserHeaders(url: string, headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("origin", new URL(url).origin);
  result.set("sec-fetch-site", "same-origin");
  return result;
}

function browserRequest(
  url: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${url}${path}`, {
    ...init,
    headers: browserHeaders(url, init.headers),
  });
}

function jsonBrowserRequest(
  url: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return browserRequest(url, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rawRequest(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/liveConsole/health`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function openEventStream(
  url: string,
  sessionId: string,
): Promise<ReturnType<typeof httpRequest>> {
  const origin = new URL(url).origin;
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/liveConsole/sessions/${sessionId}/stream?after=0`, {
      headers: { origin, "sec-fetch-site": "same-origin" },
    }, (response) => {
      response.once("data", () => resolve(request));
    });
    request.once("error", reject);
    request.end();
  });
}

async function readEventStreamReplay(url: string, sessionId: string): Promise<string> {
  const response = await browserRequest(
    url,
    `/api/liveConsole/sessions/${sessionId}/stream?after=0`,
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("event stream response did not include a body");
  let result = "";
  try {
    while (!result.includes("data:")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += new TextDecoder().decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return result;
}

function expectOpaqueCredentialsRedacted(serialized: string): void {
  for (const value of Object.values(OPAQUE_BROWSER_CREDENTIALS)) {
    expect(serialized).not.toContain(value);
  }
  expect(serialized).not.toContain("opaque-signing-key-value");
  expect(serialized).not.toContain("opaque-private-key-value");
  expect(serialized).not.toContain("opaque-token-budget-string");
  expect(serialized).toContain("[REDACTED]");
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Live console package-local demo server", () => {
  it("rejects DNS-rebinding Host values even with same-origin browser metadata", async () => {
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url, port } = await server.start();

    const response = await rawRequest(url, {
      host: `attacker.test:${port}`,
      origin: `http://attacker.test:${port}`,
      "sec-fetch-site": "same-origin",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "invalid_host" });
  });

  it("fails closed before binding a standalone server to a non-loopback host", async () => {
    const server = new LiveConsoleDemoServer({
      host: "0.0.0.0",
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);

    await expect(server.start()).rejects.toThrow("available only over loopback");
  });

  it("rejects cross-origin and missing or hostile Fetch Metadata", async () => {
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url } = await server.start();

    const crossOrigin = await fetch(`${url}/api/liveConsole/health`, {
      headers: { origin: "http://attacker.test:4174", "sec-fetch-site": "same-origin" },
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ error: "invalid_origin" });

    const missing = await fetch(`${url}/api/liveConsole/health`);
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_fetch_metadata" });

    const hostile = await fetch(`${url}/api/liveConsole/health`, {
      headers: { origin: new URL(url).origin, "sec-fetch-site": "cross-site" },
    });
    expect(hostile.status).toBe(403);
    await expect(hostile.json()).resolves.toMatchObject({ error: "invalid_fetch_metadata" });
  });

  it("rejects text/plain simple mutations and accepts a valid loopback browser request", async () => {
    const driver = new StubDriver();
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => driver,
    });
    servers.push(server);
    const { url } = await server.start();

    const simplePost = await browserRequest(url, "/api/liveConsole/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(simplePost.status).toBe(415);
    await expect(simplePost.json()).resolves.toMatchObject({ error: "json_content_type_required" });

    const valid = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Exercise the browser transport.",
      startTurn: false,
    });
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({
      providerAuthentication: "server-side",
      credentialsExposed: false,
    });
    expect(driver.openInputs).toHaveLength(1);
  });

  it("uses an unguessable direct capability while keeping provider credentials server-side", async () => {
    const driver = new StubDriver();
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => driver,
    });
    servers.push(server);
    const { url } = await server.start();

    const invalid = await fetch(`${url}/api/liveConsole/health`, {
      headers: { authorization: "Bearer invalid" },
    });
    expect(invalid.status).toBe(401);

    const response = await fetch(`${url}/api/liveConsole/sessions`, {
      method: "POST",
      headers: {
        authorization: server.directApiAuthorization(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ objective: "Use the server-owned provider path." }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as Record<string, unknown>;
    expect(driver.openInputs[0]?.workingDirectory).toBe("/safe/server-owned-workspace");
    expect(JSON.stringify(created)).not.toContain(server.directApiAuthorization());
    expect(JSON.stringify(created)).not.toContain("server-only-secret");

    const credentialAttempt = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Browser must not choose provider credentials.",
      clientSecret: "browser-secret",
    });
    expect(credentialAttempt.status).toBe(422);
    await expect(credentialAttempt.json()).resolves.toMatchObject({
      error: "browser_credentials_forbidden",
    });
    expect(driver.openInputs).toHaveLength(1);
  });

  it("caps active sessions and frees capacity through explicit cleanup", async () => {
    const server = new LiveConsoleDemoServer({
      maxActiveSessions: 1,
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url } = await server.start();

    const first = await jsonBrowserRequest(url, "/api/liveConsole/sessions", { startTurn: false });
    expect(first.status).toBe(201);
    const { sessionId } = await first.json() as { sessionId: string };

    const capped = await jsonBrowserRequest(url, "/api/liveConsole/sessions", { startTurn: false });
    expect(capped.status).toBe(429);
    await expect(capped.json()).resolves.toMatchObject({ error: "session_limit_reached" });

    const closed = await jsonBrowserRequest(url, `/api/liveConsole/sessions/${sessionId}/close`, {});
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toEqual({ closed: true, sessionId });

    const replacement = await jsonBrowserRequest(url, "/api/liveConsole/sessions", { startTurn: false });
    expect(replacement.status).toBe(201);
  });

  it("caps SSE subscribers per session", async () => {
    const server = new LiveConsoleDemoServer({
      maxSessionSubscribers: 1,
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url } = await server.start();
    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", { startTurn: false });
    const { sessionId } = await created.json() as { sessionId: string };
    const first = await openEventStream(url, sessionId);

    try {
      const capped = await browserRequest(
        url,
        `/api/liveConsole/sessions/${sessionId}/stream?after=0`,
      );
      expect(capped.status).toBe(429);
      await expect(capped.json()).resolves.toMatchObject({ error: "subscriber_limit_reached" });
    } finally {
      first.destroy();
    }
  });

  it("keeps credentials and workspace selection server-side across replay and reconnect", async () => {
    const driver = new StubDriver();
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => driver,
    });
    servers.push(server);
    const { url } = await server.start();

    const health = await browserRequest(url, "/api/liveConsole/health").then((response) => response.json());
    expect(health).toEqual(expect.objectContaining({
      status: "ok",
      providerAuthentication: "server-side",
      credentialsExposed: false,
    }));

    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
        objective: "Exercise the server boundary.",
        workingDirectory: "/browser/chosen-path",
      }).then((response) => response.json()) as Record<string, unknown>;
    expect(driver.openInputs[0]?.workingDirectory).toBe("/safe/server-owned-workspace");
    expect(created).toMatchObject({
      providerAuthentication: "server-side",
      credentialsExposed: false,
      activeTurnId: "turn-demo",
      pendingRequests: [{ requestId: "request-demo" }],
    });
    expect(JSON.stringify(created)).not.toContain("browser-secret");
    expect(JSON.stringify(created)).not.toContain("browser-must-not-see");
    expect(JSON.stringify(created)).not.toContain("server-only-secret");
    expect(JSON.stringify(created)).not.toContain("/srv/paperclip/home");
    expectOpaqueCredentialsRedacted(JSON.stringify(created));
    expect(created).toMatchObject({
      pendingRequests: [{
        details: {
          provider: {
            clientSecret: "[REDACTED]",
            providerApiKey: "[REDACTED]",
            sessionToken: "[REDACTED]",
            idToken: "[REDACTED]",
            nested: {
              signingKey: "[REDACTED]",
              private_key: "[REDACTED]",
            },
          },
          usage: {
            tokenBudget: 4096,
            tokensUsed: 128,
            tokenUsage: { inputTokens: 96, outputTokens: 32 },
          },
          invalidUsage: { tokenBudget: "[REDACTED]" },
        },
      }],
    });

    const sessionId = String(created.sessionId);
    const replay = await browserRequest(url, `/api/liveConsole/sessions/${sessionId}/events?after=0`)
      .then((response) => response.json()) as { events: PrpEvent[]; cursor: number; replay: boolean };
    expect(replay.replay).toBe(true);
    expect(replay.events.length).toBeGreaterThanOrEqual(5);
    expect(replay.events.every((event, index) => event.sourceSeq === index + 1)).toBe(true);
    expect(JSON.stringify(replay)).not.toContain("/srv/paperclip/home");
    expect(JSON.stringify(replay)).toContain("<server-path>");
    expectOpaqueCredentialsRedacted(JSON.stringify(replay));

    const streamReplay = await readEventStreamReplay(url, sessionId);
    expectOpaqueCredentialsRedacted(streamReplay);
    expect(streamReplay).toContain('"tokenBudget":4096');
    expect(streamReplay).toContain('"tokensUsed":128');

    const otherSession = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Keep request scope separate.",
      startTurn: false,
    }).then((response) => response.json()) as { sessionId: string };
    const wrongSession = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${otherSession.sessionId}/requests/request-demo/resolve`,
      { turnId: "turn-demo", resolution: { action: "accept_for_session" } },
    );
    expect(wrongSession.status).toBe(409);
    await expect(wrongSession.json()).resolves.toMatchObject({ error: "runtime_request_not_pending" });

    const wrongTurn = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/requests/request-demo/resolve`,
      {
        turnId: "turn-attacker",
        resolution: { action: "accept_for_session" },
      },
    );
    expect(wrongTurn.status).toBe(409);
    await expect(wrongTurn.json()).resolves.toMatchObject({ error: "runtime_request_scope_mismatch" });

    const resolved = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/requests/request-demo/resolve`,
      {
          turnId: "turn-demo",
          resolution: { action: "accept_for_session" },
      },
    ).then((response) => response.json()) as Record<string, unknown>;
    expect(resolved.pendingRequests).toEqual([]);

    const duplicate = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/requests/request-demo/resolve`,
      { turnId: "turn-demo", resolution: { action: "decline" } },
    );
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: "runtime_request_not_pending" });

    const withGoal = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/goal/set`,
      { objective: "Keep the goal durable.", tokenBudget: 1024 },
    ).then((response) => response.json()) as Record<string, unknown>;
    expect(withGoal.goal).toMatchObject({
      objective: "Keep the goal durable.",
      status: "active",
      tokenBudget: 1024,
    });

    const reconnected = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/reconnect`,
      {},
    ).then((response) => response.json()) as Record<string, unknown>;
    expect(reconnected).toMatchObject({
      sessionId,
      runId: created.runId,
      normalizedSessionId: created.normalizedSessionId,
      driverSession: created.driverSession,
      goal: withGoal.goal,
    });
    const afterReconnect = await browserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/events?after=${replay.cursor}`,
    ).then((response) => response.json()) as { events: PrpEvent[] };
    expect(afterReconnect.events.some(({ eventType }) => eventType === "session.resumed")).toBe(true);
  });

  it("redacts structured credential diagnostics and bounds browser-visible errors", async () => {
    const errorSecret = "opaque-error-client-secret";
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => {
        throw new Error(
          `provider failed: {"clientSecret":"${errorSecret}"} ${"x".repeat(100_000)}`,
        );
      },
    });
    servers.push(server);
    const { url } = await server.start();

    const response = await browserRequest(url, "/api/liveConsole/sessions", {
      method: "POST",
      headers: { "connection": "close", "content-type": "application/json" },
      body: JSON.stringify({ objective: "Exercise a structured provider error." }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).not.toContain(errorSecret);
    expect(body.message).toContain('"clientSecret":"[REDACTED]"');
    expect(body.message.length).toBeLessThanOrEqual(16 * 1024 + "[TRUNCATED]".length);
    expect(body.message).toMatch(/\[TRUNCATED\]$/);
  });

  it("admits an origin-less same-origin stream but still requires an origin to mutate", async () => {
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url } = await server.start();
    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", { startTurn: false })
      .then((response) => response.json()) as { sessionId: string };

    // A same-origin EventSource GET sends Fetch Metadata but no Origin header.
    const stream = await fetch(
      `${url}/api/liveConsole/sessions/${created.sessionId}/stream?after=0`,
      { headers: { "sec-fetch-site": "same-origin" } },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();

    const mutation = await fetch(`${url}/api/liveConsole/sessions/${created.sessionId}/turns`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ text: "no origin" }),
    });
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ error: "origin_required" });
  });

  it("resolves a request identity that carries reserved characters", async () => {
    // Upstream request identities are opaque. The browser percent-encodes the
    // segment, so the server has to decode it before it can match.
    const requestId = "req/2026?scope=a#b c%d";
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(requestId),
    });
    servers.push(server);
    const { url } = await server.start();

    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Resolve a reserved-character request identity.",
    }).then((response) => response.json()) as Record<string, unknown>;
    const sessionId = String(created.sessionId);
    expect(created.pendingRequests).toEqual([expect.objectContaining({ requestId })]);

    const encoded = encodeURIComponent(requestId);
    expect(encoded).not.toBe(requestId);
    const resolved = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/requests/${encoded}/resolve`,
      { turnId: "turn-demo", resolution: { action: "accept" } },
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ pendingRequests: [] });

    const malformed = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/requests/%E0%A4%A/resolve`,
      { turnId: "turn-demo", resolution: { action: "accept" } },
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: "invalid_path_encoding" });
  });

  it("fails closed on a submit body that does not match the request kind", async () => {
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver("request-elicit", "elicitation"),
    });
    servers.push(server);
    const { url } = await server.start();

    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Answer an elicitation.",
    }).then((response) => response.json()) as Record<string, unknown>;
    const sessionId = String(created.sessionId);
    const resolve = `/api/liveConsole/sessions/${sessionId}/requests/request-elicit/resolve`;

    for (const resolution of [
      { action: "submit" },
      { action: "submit", content: {} },
      { action: "submit", answers: { answer: { answers: ["user-input shape"] } } },
      { action: "accept_for_session" },
    ]) {
      const rejected = await jsonBrowserRequest(url, resolve, { turnId: "turn-demo", resolution });
      expect(rejected.status).toBe(422);
      await expect(rejected.json()).resolves.toMatchObject({
        error: "invalid_runtime_request_resolution",
      });
      // A rejected submit must never settle the request.
      const state = await browserRequest(url, `/api/liveConsole/sessions/${sessionId}`)
        .then((response) => response.json()) as Record<string, unknown>;
      expect(state.pendingRequests).toEqual([
        expect.objectContaining({ requestId: "request-elicit" }),
      ]);
    }

    const accepted = await jsonBrowserRequest(url, resolve, {
      turnId: "turn-demo",
      resolution: { action: "submit", content: { answer: "green" } },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ pendingRequests: [] });
  });

  it("appends exactly one terminal fact per request across a reconnect", async () => {
    const server = new LiveConsoleDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => new StubDriver(),
    });
    servers.push(server);
    const { url } = await server.start();

    const created = await jsonBrowserRequest(url, "/api/liveConsole/sessions", {
      objective: "Reconnect while a request is still pending.",
    }).then((response) => response.json()) as Record<string, unknown>;
    const sessionId = String(created.sessionId);
    expect(created.pendingRequests).toEqual([
      expect.objectContaining({ requestId: "request-demo" }),
    ]);

    const reconnected = await jsonBrowserRequest(
      url,
      `/api/liveConsole/sessions/${sessionId}/reconnect`,
      {},
    );
    expect(reconnected.status).toBe(200);

    const { events } = await browserRequest(url, `/api/liveConsole/sessions/${sessionId}/events?after=0`)
      .then((response) => response.json()) as { events: PrpEvent[] };
    const terminal = events.filter(({ eventType }) =>
      eventType.startsWith("runtime_request.") && eventType !== "runtime_request.created");
    expect(terminal).toEqual([
      expect.objectContaining({
        eventType: "runtime_request.cancelled",
        turnId: "turn-demo",
        itemId: "command-demo",
        payload: {
          requestId: "request-demo",
          requestKind: "command_approval",
          turnId: "turn-demo",
          itemId: "command-demo",
          reason: "browser_reconnect",
        },
      }),
    ]);
    // The resumed session continues the sequence rather than replaying it.
    expect(events.map(({ sourceSeq }) => sourceSeq)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.some(({ eventType }) => eventType === "session.resumed")).toBe(true);
  });
});
