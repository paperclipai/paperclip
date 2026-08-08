import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./gateway-execute.js";

function neverClosingNdjsonResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        // Deliberately never call controller.close() — simulates Eve's durable
        // stream staying open after the session parks.
      },
    }),
    { status: 200 },
  );
}

function ndjsonResponse(events: Array<Record<string, unknown>>, extraRawLines: string[] = []): Response {
  const lines = [...events.map((event) => JSON.stringify(event)), ...extraRawLines];
  const body = lines.map((line) => `${line}\n`).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function jsonResponse(payload: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

type FetchCall = { url: string; init: RequestInit | undefined };

function createContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & {
  logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  meta: Record<string, unknown>[];
} {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const meta: Record<string, unknown>[] = [];
  const base: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Eve Agent",
      adapterType: "eve_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      baseUrl: "http://127.0.0.1:3000",
      headers: { Authorization: "Bearer super-secret-token" },
      promptTemplate: "Do the work for {{agent.name}}",
    },
    context: {
      taskId: "issue-1",
      wakeReason: "issue_commented",
    },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (entry) => {
      meta.push(entry as unknown as Record<string, unknown>);
    },
  };
  return { ...base, ...overrides, logs, meta };
}

const fetchCalls: FetchCall[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  fetchCalls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function routeFetch(routes: Array<{ match: (url: string, method: string) => boolean; respond: () => Response }>) {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlString = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    fetchCalls.push({ url: urlString, init });
    for (const route of routes) {
      if (route.match(urlString, method)) return route.respond();
    }
    throw new Error(`Unexpected fetch: ${method} ${urlString}`);
  });
}

const happyStreamEvents = [
  { type: "session.started", data: { sessionId: "sess-1" } },
  { type: "message.completed", data: { text: "All done.\nMore detail here.", finishReason: "stop" } },
  { type: "step.completed", data: { finishReason: "stop", usage: { inputTokens: 100, outputTokens: 25 } } },
  { type: "session.waiting", data: {} },
];

describe("eve_gateway execute", () => {
  it("runs a fresh session happy path", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-1", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-1/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionParams).toMatchObject({
      eveSessionId: "sess-1",
      continuationToken: "tok-1",
      eventIndex: 4,
    });
    expect(result.sessionId).toBe("sess-1");
    expect(result.sessionDisplayId).toBe("sess-1");
    expect(result.provider).toBe("eve");
    expect(result.biller).toBe("eve");
    expect(result.billingType).toBe("api");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
    expect(result.summary).toBe("All done.");
    expect(result.clearSession).toBe(false);

    const stdoutChunks = ctx.logs.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk);
    const types = stdoutChunks.map((chunk) => (JSON.parse(chunk) as { type: string }).type);
    expect(types).toEqual(["eve.init", "eve.event", "eve.event", "eve.event", "eve.event", "eve.result"]);
  });

  it("resumes with the stored continuation token and startIndex", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session/sess-old",
        respond: () => jsonResponse({ continuationToken: "tok-new" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-old/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext({
      runtime: {
        sessionId: null,
        sessionDisplayId: "sess-old",
        taskKey: null,
        sessionParams: { eveSessionId: "sess-old", continuationToken: "tok-old", eventIndex: 7 },
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const followUpCall = fetchCalls.find(
      (call) => call.url === "http://127.0.0.1:3000/eve/v1/session/sess-old" && call.init?.method === "POST",
    );
    expect(followUpCall).toBeDefined();
    expect(JSON.parse(String(followUpCall?.init?.body))).toMatchObject({
      continuationToken: "tok-old",
    });
    const streamCall = fetchCalls.find((call) => call.url.includes("/stream"));
    expect(streamCall?.url).toContain("startIndex=7");
    expect(result.sessionParams).toMatchObject({
      eveSessionId: "sess-old",
      continuationToken: "tok-new",
      eventIndex: 11,
    });
  });

  it("falls back to a fresh session when the continuation token is stale", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session/sess-old",
        respond: () =>
          new Response(JSON.stringify({ error: "stale continuation token" }), { status: 409 }),
      },
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-new", continuationToken: "tok-new" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-new/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext({
      runtime: {
        sessionId: null,
        sessionDisplayId: "sess-old",
        taskKey: null,
        sessionParams: { eveSessionId: "sess-old", continuationToken: "tok-old", eventIndex: 7 },
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-new");
    expect(result.sessionParams).toMatchObject({ eveSessionId: "sess-new", eventIndex: 4 });
    const stderr = ctx.logs.filter((entry) => entry.stream === "stderr").map((entry) => entry.chunk).join("");
    expect(stderr).toContain("stale");
  });

  it("returns an early error when baseUrl is missing", async () => {
    const ctx = createContext({ config: {} });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("baseUrl");
    expect(result.provider).toBe("eve");
    expect(result.clearSession).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps session.failed to a failing run and preserves the session", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-fail", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-fail/stream"),
        respond: () =>
          ndjsonResponse([
            { type: "session.started", data: {} },
            { type: "session.failed", data: { code: "boom", message: "model exploded" } },
          ]),
      },
    ]);

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("model exploded");
    expect(result.clearSession).toBe(false);
    expect(result.sessionParams).toMatchObject({ eveSessionId: "sess-fail" });
  });

  it("parks the run on input.requested with exit code 0", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-hitl", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-hitl/stream"),
        respond: () =>
          ndjsonResponse([
            { type: "session.started", data: {} },
            { type: "turn.completed", data: {} },
            { type: "input.requested", data: { prompt: "Approve deploy?" } },
          ]),
      },
    ]);

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("waiting for human input");
    expect(result.resultJson).toMatchObject({ inputRequested: true });
  });

  it("accepts headers provided as a JSON object string (whole-field secret resolution)", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-1", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-1/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext({
      config: {
        baseUrl: "http://127.0.0.1:3000",
        headers: JSON.stringify({ Authorization: "Bearer from-string-secret" }),
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const sessionCall = fetchCalls.find((call) => call.url.endsWith("/eve/v1/session"));
    expect((sessionCall?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer from-string-secret",
    );
    // Even string-sourced header values never appear in logs or meta.
    const allLogs = ctx.logs.map((entry) => entry.chunk).join("");
    expect(allLogs).not.toContain("from-string-secret");
    expect(JSON.stringify(ctx.meta)).not.toContain("from-string-secret");
  });

  it("warns about unresolved secret_ref header entries by key name without leaking values", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-1", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-1/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext({
      config: {
        baseUrl: "http://127.0.0.1:3000",
        headers: {
          "X-Plain": "plain-ok",
          Authorization: { type: "secret_ref", secretId: "secret-id-123" },
        },
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const stderr = ctx.logs
      .filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.chunk)
      .join("");
    expect(stderr).toContain("Ignoring unresolved bindings for header keys: Authorization");
    expect(stderr).not.toContain("secret-id-123");
    const sessionCall = fetchCalls.find((call) => call.url.endsWith("/eve/v1/session"));
    const sentHeaders = sessionCall?.init?.headers as Record<string, string>;
    expect(sentHeaders["X-Plain"]).toBe("plain-ok");
    expect(sentHeaders).not.toHaveProperty("Authorization");
  });

  it("exits promptly on session.waiting even when the stream never closes and no turn.completed was seen", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-open", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-open/stream"),
        respond: () =>
          neverClosingNdjsonResponse([
            { type: "session.started", data: {} },
            { type: "message.completed", data: { text: "Done." } },
            { type: "session.waiting", data: {} },
          ]),
      },
    ]);

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done.");
    expect(result.resultJson).toMatchObject({ status: "session.waiting", eventCount: 3 });
  }, 5_000);

  it("exits promptly on mid-turn input.requested even when the stream never closes", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-hitl2", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-hitl2/stream"),
        respond: () =>
          neverClosingNdjsonResponse([
            { type: "session.started", data: {} },
            { type: "step.started", data: {} },
            // HITL pauses mid-turn: no turn.completed before input.requested.
            { type: "input.requested", data: { prompt: "Approve tool call?" } },
          ]),
      },
    ]);

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("waiting for human input");
    expect(result.resultJson).toMatchObject({ status: "input.requested", inputRequested: true });
  }, 5_000);

  it("never logs configured header values", async () => {
    routeFetch([
      {
        match: (url, method) => method === "POST" && url === "http://127.0.0.1:3000/eve/v1/session",
        respond: () => jsonResponse({ sessionId: "sess-1", continuationToken: "tok-1" }),
      },
      {
        match: (url, method) => method === "GET" && url.includes("/eve/v1/session/sess-1/stream"),
        respond: () => ndjsonResponse(happyStreamEvents),
      },
    ]);

    const ctx = createContext();
    await execute(ctx);

    const allLogs = ctx.logs.map((entry) => entry.chunk).join("");
    expect(allLogs).not.toContain("super-secret-token");
    const metaJson = JSON.stringify(ctx.meta);
    expect(metaJson).not.toContain("super-secret-token");
    // Header names may be listed, values must not.
    expect(metaJson).toContain("Authorization");
  });
});
