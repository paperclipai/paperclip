import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@paperclipai/adapter-managed-agents/server";
import type {
  AdapterExecutionContext,
  CornerstoneToolRequest,
  CornerstoneToolResult,
} from "@paperclipai/adapter-utils";

// -----------------------------------------------------------------------------
// B2-5 adapter-level tests for Cornerstone tool wiring.
//
// Covers two invariants not exercised by cornerstone-tools-delegation.test.ts:
//   1. Gate test: when ctx.cornerstoneTools is undefined, the 11 Cornerstone
//      tool specs MUST NOT be registered with Managed Agents (the POST
//      /v1/agents body.customTools should exclude every Cornerstone tool name).
//      This is the adapter-side of canUseCornerstone=false — analogous to the
//      canDelegate gate for delegate_task.
//   2. Multi-call H1 invariant: when a single session fires multiple
//      Cornerstone tool uses, H1 (spanCount >= customToolUseCount + 1) must
//      still hold and the callback must be invoked once per tool use.
// -----------------------------------------------------------------------------

type MaEventStub = { id: string; type: string; [k: string]: unknown };
type FetchResponse = { status: number; body: unknown };
type FetchCall = { method: string; path: string; body: unknown };
type FetchHandler = (method: string, path: string, body: unknown) => FetchResponse;

function installMaFetch(handler: FetchHandler): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const orig = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = init?.body ? JSON.parse(init.body as string) : null;
    const path = new URL(url).pathname;
    calls.push({ method, path, body: parsed });
    const { status, body } = handler(method, path, parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      global.fetch = orig;
    },
  };
}

function buildCtx(opts: {
  runId: string;
  agentName: string;
  agentId: string;
  taskBody: string;
  cornerstoneTools?: (req: CornerstoneToolRequest) => Promise<CornerstoneToolResult>;
}): AdapterExecutionContext {
  return {
    runId: opts.runId,
    agent: {
      id: opts.agentId,
      companyId: "charlie-oscar-uuid",
      name: opts.agentName,
      adapterType: "managed_agents",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: `cs-adapter-${opts.agentName.toLowerCase()}`,
    },
    config: {
      role: `${opts.agentName} test agent`,
      model: "claude-haiku-4-5-20251001",
      timeoutSec: 10,
    },
    context: { taskBody: opts.taskBody },
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    cornerstoneTools: opts.cornerstoneTools,
  };
}

describe("adapter managed-agents — Cornerstone tool gate + H1 invariant", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "CORNERSTONE_API_KEY",
    "MEMORY_API_KEY",
    "COOKBOOK_ACCESS_TOKEN",
    "COOKBOOK_API_KEY",
    "COOKBOOK_MOCK_MODE",
  ];

  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key-mocked-not-used";
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("gate: when canUseCornerstone=false (ctx.cornerstoneTools undefined), Cornerstone specs are NOT registered with MA", async () => {
    const SESSION_ID = "sesn_gate";
    const events: MaEventStub[] = [
      {
        id: "sevt_span",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 400,
        },
      },
      {
        id: "sevt_final",
        type: "agent.message",
        content: [{ type: "text", text: "no tools available; done." }],
      },
      {
        id: "sevt_idle",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ];

    const mock = installMaFetch((method, path) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: "agnt_gate",
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "gate",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: "envr_gate", state: "ready", name: "gate" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: "envr_gate",
            agent: { id: "agnt_gate", version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        return { status: 200, body: { data: events } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: "envr_gate",
            agent: { id: "agnt_gate", version: 1 },
            usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 0 },
            stats: { active_seconds: 3, duration_seconds: 5 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    try {
      const result = await execute(
        buildCtx({
          runId: "gate-run",
          agentName: "Gate",
          agentId: "gate-agent-uuid",
          taskBody: "no tools available",
          // cornerstoneTools OMITTED — this is the canUseCornerstone=false state.
        }),
      );

      expect(result.exitCode).toBe(0);

      // The single POST /v1/agents call must NOT have registered any Cornerstone
      // tool specs. The adapter should pass customTools=undefined (or a list
      // without any Cornerstone tool name).
      const agentPosts = mock.calls.filter(
        (c) => c.method === "POST" && c.path === "/v1/agents",
      );
      expect(agentPosts).toHaveLength(1);
      const body = agentPosts[0].body as { customTools?: Array<{ name: string }> };
      const registeredTools = (body.customTools ?? []).map((t) => t.name);
      const CORNERSTONE_TOOLS = [
        "get_context",
        "search",
        "list_facts",
        "recall",
        "add_fact",
        "save_conversation",
        "steward_inspect",
        "steward_advise",
        "steward_preview",
        "steward_apply",
        "steward_status",
      ];
      for (const name of CORNERSTONE_TOOLS) {
        expect(registeredTools).not.toContain(name);
      }
    } finally {
      mock.restore();
    }
  }, 15_000);

  it("multi-call H1: two Cornerstone tool uses in one session — spanCount >= customToolUseCount + 1, callback fires twice", async () => {
    const SESSION_ID = "sesn_multi";
    const TOOL_USE_1 = "sevt_tool_1";
    const TOOL_USE_2 = "sevt_tool_2";

    // Three-phase event stream:
    //   phase1 (before first result posted): span1 + tool_use get_context + idle(tool_use)
    //   phase2 (after first result posted):  phase1 + echo1 + span2 + tool_use list_facts + idle(tool_use)
    //   phase3 (after second result posted): phase2 + echo2 + span3 + final text + idle(end_turn)
    const phase1Events: MaEventStub[] = [
      {
        id: "sevt_span_1",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 4,
          output_tokens: 60,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 500,
        },
      },
      {
        id: "sevt_msg_1",
        type: "agent.message",
        content: [{ type: "text", text: "Pulling context..." }],
      },
      {
        id: TOOL_USE_1,
        type: "agent.custom_tool_use",
        name: "get_context",
        input: { query: "recent sprints", namespace: "aiops" },
      },
      { id: "sevt_idle_1", type: "session.status_idle", stop_reason: { type: "tool_use" } },
    ];

    const phase2Extra: MaEventStub[] = [
      {
        id: "sevt_echo_1",
        type: "user.custom_tool_result",
        custom_tool_use_id: TOOL_USE_1,
      },
      {
        id: "sevt_span_2",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 6,
          output_tokens: 80,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 0,
        },
      },
      {
        id: TOOL_USE_2,
        type: "agent.custom_tool_use",
        name: "list_facts",
        input: { namespace: "aiops", key_prefix: "co_paperclip_" },
      },
      { id: "sevt_idle_2", type: "session.status_idle", stop_reason: { type: "tool_use" } },
    ];

    const phase3Extra: MaEventStub[] = [
      {
        id: "sevt_echo_2",
        type: "user.custom_tool_result",
        custom_tool_use_id: TOOL_USE_2,
      },
      {
        id: "sevt_span_3",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 5,
          output_tokens: 70,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 0,
        },
      },
      {
        id: "sevt_msg_final",
        type: "agent.message",
        content: [{ type: "text", text: "Pulled context, listed 3 facts." }],
      },
      { id: "sevt_idle_3", type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];

    let toolResultsPosted = 0;
    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: "agnt_multi",
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "multi",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: "envr_multi", state: "ready", name: "multi" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: "envr_multi",
            agent: { id: "agnt_multi", version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") toolResultsPosted += 1;
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (toolResultsPosted === 0) return { status: 200, body: { data: phase1Events } };
        if (toolResultsPosted === 1)
          return { status: 200, body: { data: [...phase1Events, ...phase2Extra] } };
        return {
          status: 200,
          body: { data: [...phase1Events, ...phase2Extra, ...phase3Extra] },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: "envr_multi",
            agent: { id: "agnt_multi", version: 1 },
            usage: { input_tokens: 15, output_tokens: 210, cache_read_input_tokens: 500 },
            stats: { active_seconds: 12, duration_seconds: 18 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    const cornerstoneCalls: CornerstoneToolRequest[] = [];
    const cornerstoneTools = async (
      req: CornerstoneToolRequest,
    ): Promise<CornerstoneToolResult> => {
      cornerstoneCalls.push(req);
      if (req.name === "get_context") {
        return { status: "ok", output: { context: "Recent sprints: B2-4 complete." } };
      }
      if (req.name === "list_facts") {
        return { status: "ok", output: { facts: [{ key: "a" }, { key: "b" }, { key: "c" }] } };
      }
      return {
        status: "error",
        errorCode: "unexpected_tool",
        errorMessage: `test stub got ${req.name}`,
      };
    };

    try {
      const result = await execute(
        buildCtx({
          runId: "multi-run",
          agentName: "Multi",
          agentId: "multi-agent-uuid",
          taskBody: "pull context then list facts",
          cornerstoneTools,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();

      // Callback fired once per tool use with the right names + inputs.
      expect(cornerstoneCalls).toHaveLength(2);
      expect(cornerstoneCalls[0].name).toBe("get_context");
      expect(cornerstoneCalls[0].input).toMatchObject({ query: "recent sprints", namespace: "aiops" });
      expect(cornerstoneCalls[1].name).toBe("list_facts");
      expect(cornerstoneCalls[1].input).toMatchObject({ namespace: "aiops", key_prefix: "co_paperclip_" });

      // H1 invariant with multiple tools: customToolUseCount=2, spanCount>=3.
      const rj = result.resultJson as Record<string, unknown>;
      expect(rj.customToolUseCount).toBe(2);
      expect(Number(rj.spanCount)).toBeGreaterThanOrEqual(Number(rj.customToolUseCount) + 1);
      expect(rj.finalText as string).toContain("Pulled context");
    } finally {
      mock.restore();
    }
  }, 30_000);
});
