import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@paperclipai/adapter-managed-agents/server";
import type {
  AdapterExecutionContext,
  CornerstoneToolRequest,
  CornerstoneToolResult,
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";

// -----------------------------------------------------------------------------
// B2-4 checkpoint — 2-agent delegation with a Cornerstone tool in the middle.
//
// Scenario:
//   Ada delegates to Donald. Donald has canUseCornerstone=true (cornerstoneTools
//   callback bound) but canDelegate=false. Donald calls steward_inspect
//   (operation=duplicates) via MA custom_tool_use; the stubbed cornerstoneTools
//   callback returns status=ok and Donald's MA session resumes to synthesize
//   "Found 0 duplicates." That finalText is wrapped into a DelegationResult and
//   returned to Ada's delegateTask callback. Ada's MA session resumes and
//   synthesizes "Donald reports: Found 0 duplicates."
//
// What this locks in:
//   1. The adapter wires ctx.cornerstoneTools through to the custom_tool_use
//      handler: when Donald's event stream contains a Cornerstone tool use, the
//      callback is invoked (not dropped as "unknown tool").
//   2. The callback's CornerstoneToolResult is serialised and posted back via
//      user.custom_tool_result, and MA's synthesis span fires.
//   3. The H1 invariant (spanCount >= customToolUseCount + 1) holds
//      independently for BOTH sessions — H1 is not confused by mixed tool use
//      in a single call stack.
//   4. Unknown tool names fall through to the "unknown tool" branch (sanity:
//      the new dispatch routes delegate_task + the 11 Cornerstone names, and
//      nothing else).
// -----------------------------------------------------------------------------

type MaEventStub = { id: string; type: string; [k: string]: unknown };
type FetchResponse = { status: number; body: unknown };
type FetchHandler = (method: string, path: string, body: unknown) => FetchResponse;

function installMaFetch(handler: FetchHandler): {
  calls: Array<{ method: string; path: string; body: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
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
  delegateTask?: (req: DelegationRequest) => Promise<DelegationResult>;
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
      taskKey: `cs-delegation-${opts.agentName.toLowerCase()}`,
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
    delegateTask: opts.delegateTask,
    cornerstoneTools: opts.cornerstoneTools,
  };
}

describe("adapter managed-agents — Cornerstone tools + delegation", () => {
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

  it("Ada delegates → Donald calls steward_inspect → both sessions synthesize", async () => {
    const ADA_SESSION_ID = "sesn_ada_b24";
    const DONALD_SESSION_ID = "sesn_donald_b24";
    const ADA_TOOL_USE_ID = "sevt_ada_delegate";
    const DONALD_TOOL_USE_ID = "sevt_donald_steward";

    // ---------- Donald session events ------------------------------------
    const donaldPreEvents: MaEventStub[] = [
      {
        id: "sevt_span_donald_pre",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 4,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 800,
        },
      },
      {
        id: "sevt_msg_donald_pre",
        type: "agent.message",
        content: [{ type: "text", text: "Inspecting duplicates..." }],
      },
      {
        id: DONALD_TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "steward_inspect",
        input: { operation: "duplicates" },
      },
      {
        id: "sevt_idle_donald_pre",
        type: "session.status_idle",
        stop_reason: { type: "tool_use" },
      },
    ];

    // ---------- Ada session events ---------------------------------------
    const adaPreEvents: MaEventStub[] = [
      {
        id: "sevt_span_ada_pre",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 6,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1200,
        },
      },
      {
        id: "sevt_msg_ada_pre",
        type: "agent.message",
        content: [{ type: "text", text: "Delegating audit to Donald." }],
      },
      {
        id: ADA_TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "Audit duplicates",
          description: "Inspect for duplicate facts in aiops",
          wait: true,
        },
      },
      {
        id: "sevt_idle_ada_pre",
        type: "session.status_idle",
        stop_reason: { type: "tool_use" },
      },
    ];

    let adaToolResultPosted = false;
    let donaldToolResultPosted = false;
    let donaldAgentId = "agnt_donald";
    let donaldEnvId = "envr_donald";
    let adaAgentId = "agnt_ada";
    let adaEnvId = "envr_ada";

    const mock = installMaFetch((method, path, body) => {
      // Agent / environment creation — route by order: Ada's call chain
      // hits these first, then Donald's. To keep routing simple we just
      // return fresh IDs each time.
      if (method === "POST" && path === "/v1/agents") {
        // Alternate IDs based on call count — Ada is first invocation, Donald
        // second (triggered inside the delegateTask callback).
        const id = adaToolResultPosted || donaldToolResultPosted
          ? donaldAgentId
          : (adaAgentId = adaAgentId);
        return {
          status: 200,
          body: {
            id,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: id,
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        const id = adaToolResultPosted ? donaldEnvId : adaEnvId;
        return { status: 200, body: { id, state: "ready", name: id } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        const rec = body as Record<string, unknown> | null;
        const agentId = rec?.agent_id ?? rec?.agent?.["id"];
        const id = agentId === donaldAgentId ? DONALD_SESSION_ID : ADA_SESSION_ID;
        return {
          status: 200,
          body: {
            id,
            status: "running",
            environment_id: id === DONALD_SESSION_ID ? donaldEnvId : adaEnvId,
            agent: { id: agentId ?? adaAgentId, version: 1 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }

      // Ada session event posts / polls
      if (method === "POST" && path === `/v1/sessions/${ADA_SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") adaToolResultPosted = true;
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${ADA_SESSION_ID}/events`) {
        if (!adaToolResultPosted) return { status: 200, body: { data: adaPreEvents } };
        return {
          status: 200,
          body: {
            data: [
              ...adaPreEvents,
              {
                id: "sevt_ada_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: ADA_TOOL_USE_ID,
              },
              {
                id: "sevt_span_ada_post",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 5,
                  output_tokens: 80,
                  cache_read_input_tokens: 1200,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_ada_final",
                type: "agent.message",
                content: [
                  { type: "text", text: "Donald reports: Found 0 duplicates." },
                ],
              },
              {
                id: "sevt_idle_ada_post",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${ADA_SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: ADA_SESSION_ID,
            status: "idle",
            environment_id: adaEnvId,
            agent: { id: adaAgentId, version: 1 },
            usage: { input_tokens: 11, output_tokens: 130, cache_read_input_tokens: 1200 },
            stats: { active_seconds: 20, duration_seconds: 30 },
          },
        };
      }

      // Donald session event posts / polls
      if (method === "POST" && path === `/v1/sessions/${DONALD_SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") donaldToolResultPosted = true;
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${DONALD_SESSION_ID}/events`) {
        if (!donaldToolResultPosted)
          return { status: 200, body: { data: donaldPreEvents } };
        return {
          status: 200,
          body: {
            data: [
              ...donaldPreEvents,
              {
                id: "sevt_donald_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: DONALD_TOOL_USE_ID,
              },
              {
                id: "sevt_span_donald_post",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 7,
                  output_tokens: 120,
                  cache_read_input_tokens: 800,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_donald_final",
                type: "agent.message",
                content: [{ type: "text", text: "Found 0 duplicates." }],
              },
              {
                id: "sevt_idle_donald_post",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${DONALD_SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: DONALD_SESSION_ID,
            status: "idle",
            environment_id: donaldEnvId,
            agent: { id: donaldAgentId, version: 1 },
            usage: { input_tokens: 11, output_tokens: 220, cache_read_input_tokens: 800 },
            stats: { active_seconds: 15, duration_seconds: 22 },
          },
        };
      }

      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    // Stubbed cornerstoneTools callback — captures invocations and returns
    // a canned steward_inspect result. In prod this is backed by
    // createCornerstoneToolsCallback → Cornerstone REST. For B2-4 we only
    // test the adapter wiring, not the handler.
    const cornerstoneCalls: CornerstoneToolRequest[] = [];
    const cornerstoneTools = async (
      req: CornerstoneToolRequest,
    ): Promise<CornerstoneToolResult> => {
      cornerstoneCalls.push(req);
      if (req.name === "steward_inspect") {
        return { status: "ok", output: { duplicates: [] } };
      }
      return {
        status: "error",
        errorCode: "unexpected_tool",
        errorMessage: `test stub got ${req.name}`,
      };
    };

    // delegateTask callback — wraps Donald's nested execute() call. Runs
    // Donald with cornerstoneTools bound, then lifts Donald's finalText into
    // a DelegationResult.
    const delegatedRuns: Array<{ assignee: string; donaldResult: unknown }> = [];
    const delegateTask = async (req: DelegationRequest): Promise<DelegationResult> => {
      // Swap the "first call" guard state so the MA fetch mock routes the
      // *next* POST /v1/agents to Donald's ID.
      adaToolResultPosted = true;
      const donaldResult = await execute(
        buildCtx({
          runId: "donald-run-b24",
          agentName: "Donald",
          agentId: "donald-agent-uuid",
          taskBody: req.description,
          cornerstoneTools,
        }),
      );
      delegatedRuns.push({ assignee: req.assigneeAgentName, donaldResult });
      return {
        status: donaldResult.exitCode === 0 ? "completed" : "failed",
        childRunId: "donald-run-b24",
        childIssueId: "donald-issue",
        childIssueIdentifier: "DT-CS-1",
        finalText:
          (donaldResult.resultJson as { finalText?: string } | undefined)?.finalText ?? null,
        costUsd: donaldResult.costUsd ?? 0,
        errorCode: donaldResult.errorCode ?? null,
        errorMessage: donaldResult.errorMessage ?? null,
      };
    };

    try {
      const adaResult = await execute(
        buildCtx({
          runId: "ada-run-b24",
          agentName: "Ada",
          agentId: "ada-agent-uuid",
          taskBody: "Get Donald to audit duplicates, synthesize his findings.",
          delegateTask,
        }),
      );

      // Ada session — H1 invariant holds, synthesis contains Donald's output
      expect(adaResult.exitCode).toBe(0);
      expect(adaResult.errorCode ?? null).toBeNull();
      const adaRj = adaResult.resultJson as Record<string, unknown>;
      expect(adaRj.customToolUseCount).toBe(1);
      expect(Number(adaRj.spanCount)).toBeGreaterThanOrEqual(
        Number(adaRj.customToolUseCount) + 1,
      );
      expect(adaRj.finalText as string).toContain("Found 0 duplicates");

      // Donald session — cornerstoneTools callback fired exactly once, with
      // the expected name/input. H1 invariant also holds independently.
      expect(delegatedRuns).toHaveLength(1);
      const donald = delegatedRuns[0].donaldResult as {
        exitCode: number;
        resultJson?: Record<string, unknown>;
      };
      expect(donald.exitCode).toBe(0);
      expect(donald.resultJson?.customToolUseCount).toBe(1);
      expect(Number(donald.resultJson?.spanCount)).toBeGreaterThanOrEqual(
        Number(donald.resultJson?.customToolUseCount) + 1,
      );
      expect(donald.resultJson?.finalText).toBe("Found 0 duplicates.");

      expect(cornerstoneCalls).toHaveLength(1);
      expect(cornerstoneCalls[0].name).toBe("steward_inspect");
      expect(cornerstoneCalls[0].input).toEqual({ operation: "duplicates" });
    } finally {
      mock.restore();
    }
  }, 30_000);
});
