import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

type RouteResult = { status: number; body?: unknown; headers?: Record<string, string> };
type Router = (method: string, path: string, body: unknown, callIndex: number) => RouteResult;

type RecordedCall = { method: string; path: string; search: string; body: unknown };

function installFetchRouter(router: Router): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const index = calls.length;
      calls.push({ method, path: url.pathname, search: url.search, body });
      const result = router(method, url.pathname, body, index);
      return new Response(result.body !== undefined ? JSON.stringify(result.body) : null, {
        status: result.status,
        headers: result.headers,
      });
    }),
  );
  return calls;
}

function apiEvent(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, type, sessionId: "sess-1", agent: "slug-1", at: "2026-01-01T00:00:00.000Z", ...extra };
}

function eventsPage(events: unknown[], cursor: string | null, hasMore = false): RouteResult {
  return { status: 200, body: { events, cursor, hasMore } };
}

const CREATED_AGENT: RouteResult = {
  status: 200,
  body: { agent: { slug: "slug-1", agentType: "claude_code", llm: "claude-opus-5", archived: false } },
};
const CREATED_SESSION: RouteResult = { status: 200, body: { session: { id: "sess-1" } } };

function happyTurnEvents(): unknown[] {
  return [
    apiEvent("m1", "user.message", { text: "ignored-echo", channel: "api" }),
    apiEvent("t1#accepted", "turn.accepted"),
    apiEvent("m2#0", "agent.reasoning", { part: { text: "thinking hard" } }),
    apiEvent("m2#1", "agent.tool_use", { part: { tool_name: "bash", args: { cmd: "ls" } } }),
    apiEvent("m2", "agent.message", { text: "All done\nWith detail" }),
    apiEvent("t1#idle", "turn.status_idle", { stop_reason: "end_turn" }),
  ];
}

function createContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & { logs: Array<{ stream: string; chunk: string }> } {
  const logs: Array<{ stream: string; chunk: string }> = [];
  const base: AdapterExecutionContext = {
    runId: "run-heartbeat-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "AgentSky Agent",
      adapterType: "agentsky_cloud",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      env: { AGENTSKY_API_TOKEN: "ast_test_token" },
      promptTemplate: "Do the work for {{agent.name}}",
    },
    context: { taskId: "issue-1", issueId: "issue-1", wakeReason: "issue_commented" },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    ...overrides,
  };
  return Object.assign(base, { logs });
}

function stdoutEventTypes(logs: Array<{ stream: string; chunk: string }>): string[] {
  return logs
    .filter((entry) => entry.stream === "stdout")
    .map((entry) => {
      try {
        return String(JSON.parse(entry.chunk).type);
      } catch {
        return "raw";
      }
    });
}

const MATCHING_SESSION_PARAMS = {
  agentSlug: "slug-1",
  sessionId: "sess-1",
  harness: "claude_code",
  model: "claude-opus-5",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("agentsky_cloud execute", () => {
  it("creates an agent + session on first run and completes the turn", async () => {
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], null) : eventsPage(happyTurnEvents(), "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("agentsky");
    expect(result.biller).toBe("agentsky");
    expect(result.billingType).toBe("api");
    expect(result.model).toBe("claude-opus-5");
    expect(result.summary).toBe("All done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.sessionParams).toMatchObject({ ...MATCHING_SESSION_PARAMS, lastEventCursor: "c2" });
    expect(result.resultJson).toMatchObject({ status: "finished", stopReason: "end_turn" });

    const createAgentCall = calls.find((c) => c.method === "POST" && c.path === "/api/v1/agents");
    expect(createAgentCall?.body).toMatchObject({ agentType: "claude_code", llm: "claude-opus-5" });
    const messageCall = calls.find((c) => c.path === "/api/v1/sessions/sess-1/messages");
    expect(messageCall?.body).toMatchObject({ parts: [{ type: "text", index: 0 }] });

    const types = stdoutEventTypes(ctx.logs);
    expect(types[0]).toBe("agentsky_cloud.init");
    expect(types).toContain("agentsky_cloud.message");
    expect(types[types.length - 1]).toBe("agentsky_cloud.result");
    const resultLine = JSON.parse(ctx.logs.filter((l) => l.stream === "stdout").at(-1)!.chunk);
    expect(resultLine.status).toBe("finished");
    expect(resultLine.result).toBe("All done\nWith detail");
  });

  it("reuses a matching persisted session without creating anything", async () => {
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], "c1") : eventsPage(happyTurnEvents(), "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const ctx = createContext({
      runtime: {
        sessionId: "sess-1",
        sessionParams: { ...MATCHING_SESSION_PARAMS, lastEventCursor: "c0" },
        sessionDisplayId: "sess-1",
        taskKey: null,
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/agents")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/sessions")).toBe(false);
    const baselineCall = calls.find((c) => c.path.endsWith("/events"));
    expect(baselineCall?.search).toContain("cursor=c0");
  });

  it("provisions a fresh agent when the configured harness changed", async () => {
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") {
        return {
          status: 200,
          body: { agent: { slug: "slug-2", agentType: "codex", llm: "gpt-5.6-sol", archived: false } },
        };
      }
      if (method === "POST" && path === "/api/v1/sessions") return { status: 200, body: { session: { id: "sess-2" } } };
      if (method === "POST" && path === "/api/v1/sessions/sess-2/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-2/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        const events = [
          apiEvent("m1", "user.message", { channel: "api" }),
          apiEvent("t9#accepted", "turn.accepted"),
          apiEvent("m3", "agent.message", { text: "ok" }),
          apiEvent("t9#idle", "turn.status_idle"),
        ];
        return isBaseline ? eventsPage([], null) : eventsPage(events, "c9");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const ctx = createContext({
      config: { env: { AGENTSKY_API_TOKEN: "ast_test_token" }, harness: "codex" },
      runtime: {
        sessionId: "sess-1",
        sessionParams: MATCHING_SESSION_PARAMS,
        sessionDisplayId: "sess-1",
        taskKey: null,
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/agents")).toBe(true);
    expect(result.sessionParams).toMatchObject({ agentSlug: "slug-2", sessionId: "sess-2", harness: "codex" });
  });

  it("attaches to an existing agent via agentSlug without creating one", async () => {
    const calls = installFetchRouter((method, path) => {
      if (method === "GET" && path === "/api/v1/agents/existing-agent") {
        return {
          status: 200,
          body: { agent: { slug: "existing-agent", agentType: "openclaw", llm: "gpt-5.6-sol", archived: false } },
        };
      }
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], null) : eventsPage(happyTurnEvents(), "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const ctx = createContext({
      config: { env: { AGENTSKY_API_TOKEN: "ast_test_token" }, agentSlug: "existing-agent" },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/agents")).toBe(false);
    expect(result.sessionParams).toMatchObject({
      agentSlug: "existing-agent",
      harness: "openclaw",
      model: "gpt-5.6-sol",
      attached: true,
    });
  });

  it("ignores a stale idle event from a turn that predates the wake message", async () => {
    const events = [
      apiEvent("t0#idle", "turn.status_idle", { stop_reason: "end_turn" }),
      apiEvent("m1", "user.message", { channel: "api" }),
      apiEvent("t1#accepted", "turn.accepted"),
      apiEvent("m2", "agent.message", { text: "our result" }),
      apiEvent("t1#idle", "turn.status_idle", { stop_reason: "end_turn" }),
    ];
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], null) : eventsPage(events, "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const result = await execute(createContext());
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("our result");
  });

  it("fails without AGENTSKY_API_TOKEN", async () => {
    installFetchRouter(() => ({ status: 500 }));
    const result = await execute(createContext({ config: { env: {} } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("AGENTSKY_API_TOKEN");
  });

  it("fails on a harness-incompatible model without calling the API", async () => {
    const calls = installFetchRouter(() => ({ status: 500 }));
    const result = await execute(
      createContext({
        config: { env: { AGENTSKY_API_TOKEN: "ast_test_token" }, harness: "codex", model: "claude-opus-5" },
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("not compatible");
    expect(calls.length).toBe(0);
  });

  it("maps 402 on send to insufficient_credits and preserves the session", async () => {
    installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") return eventsPage([], null);
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") {
        return { status: 402, body: { error: { code: "insufficient_credits", message: "wallet empty" } } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const result = await execute(createContext());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("insufficient_credits");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.clearSession).toBe(false);
    expect(result.sessionParams).toMatchObject({ agentSlug: "slug-1", sessionId: "sess-1" });
  });

  it("returns a failure and keeps the session when the turn is interrupted", async () => {
    const events = [
      apiEvent("m1", "user.message", { channel: "api" }),
      apiEvent("t1#accepted", "turn.accepted"),
      apiEvent("t1#interrupted", "turn.interrupted"),
    ];
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], null) : eventsPage(events, "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const result = await execute(createContext());
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("interrupted");
    expect(result.clearSession).toBe(false);
    expect(result.sessionParams).toMatchObject({ sessionId: "sess-1" });
  });

  it("clears the session when the remote session is deleted", async () => {
    const events = [
      apiEvent("m1", "user.message", { channel: "api" }),
      apiEvent("s1", "session.deleted"),
    ];
    const calls = installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") {
        const isBaseline = calls.filter((c) => c.path.endsWith("/events")).length === 1;
        return isBaseline ? eventsPage([], null) : eventsPage(events, "c2");
      }
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const result = await execute(createContext());
    expect(result.exitCode).toBe(1);
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeNull();
  });

  it("times out when the turn never completes, preserving the session", async () => {
    vi.useFakeTimers();
    installFetchRouter((method, path) => {
      if (method === "POST" && path === "/api/v1/agents") return CREATED_AGENT;
      if (method === "POST" && path === "/api/v1/sessions") return CREATED_SESSION;
      if (method === "POST" && path === "/api/v1/sessions/sess-1/messages") return { status: 202 };
      if (method === "GET" && path === "/api/v1/sessions/sess-1/events") return eventsPage([], null);
      return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    });

    const resultPromise = execute(
      createContext({ config: { env: { AGENTSKY_API_TOKEN: "ast_test_token" }, timeoutSec: 60 } }),
    );
    let settled = false;
    const tracked = resultPromise.then((value) => {
      settled = true;
      return value;
    });
    for (let i = 0; i < 100 && !settled; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    const result = await tracked;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.clearSession).toBe(false);
    expect(result.sessionParams).toMatchObject({ sessionId: "sess-1" });
  });
});
