import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@paperclipai/adapter-managed-agents/server";
import type {
  AdapterExecutionContext,
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";

// -----------------------------------------------------------------------------
// H1 detector — session terminates before tool_result resumes the model
//
// Context (2026-04-24, Ada's run 5fc47c80):
//   Ada's MA session emitted agent.custom_tool_use + session.status_idle in the
//   same batch with stop_reason="completed". The adapter called delegateTask
//   (which succeeded — Donald wrote 7956 chars to his heartbeat_run.resultJson),
//   then posted user.custom_tool_result back to MA. But MA never ran a second
//   turn for Ada — her heartbeat_run showed cacheReadTokens=0 (definitive proof
//   the session made only one API call) and her finalText was her 168-char
//   pre-delegation preamble, not Donald's audit.
//
// The invariant this test locks in:
//   For each agent.custom_tool_use event observed, there must be at least one
//   *subsequent* span.model_request_end event in the session's event stream.
//   span count must be >= customToolUseCount + 1 (initial span + one synthesis
//   span per tool_use). If not, MA abandoned the session before running the
//   synthesis turn — classify as failure so the reconciler can retry instead
//   of silently returning a preamble-only result.
//
// This test drives the adapter's execute() with a scripted fetch mock that
// simulates exactly the H1 event sequence. It exists to prevent the adapter
// from ever again silently classifying an un-resumed session as success.
// -----------------------------------------------------------------------------

type MaEventStub = {
  id: string;
  type: string;
  [k: string]: unknown;
};

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
  delegateTask: (req: DelegationRequest) => Promise<DelegationResult>;
}): AdapterExecutionContext {
  return {
    runId: opts.runId,
    agent: {
      id: "ada-agent-uuid",
      companyId: "charlie-oscar-uuid",
      name: "Ada",
      adapterType: "managed_agents",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "h1-test",
    },
    config: {
      role: "Lead agent",
      model: "claude-haiku-4-5-20251001",
      timeoutSec: 10,
    },
    context: {
      taskBody: "Synthesize Donald's audit",
    },
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    delegateTask: opts.delegateTask,
  };
}

describe("adapter managed-agents — H1 detector", () => {
  // Save + clear env vars that would cause the adapter to make real network
  // calls to Cornerstone / Cookbook. The test only exercises MA via mock.
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

  it("flags H1 when custom_tool_use produces no subsequent synthesis span", async () => {
    const SESSION_ID = "sesn_test_h1_01";
    const AGENT_ID = "agnt_test_h1";
    const ENV_ID = "envr_test_h1";
    const TOOL_USE_ID = "sevt_tool_use_h1";
    const RUN_ID = "parent-run-uuid-h1";

    // Events present BEFORE the custom tool handler posts a tool_result.
    // Note: session.status_idle with stop_reason="end_turn" (NOT "tool_use")
    // is the H1 smoking gun — MA signaled the turn ended, so the tool_result
    // post after this point will be a no-op.
    const preEvents: MaEventStub[] = [
      {
        id: "sevt_span_1",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 984,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: "sevt_msg_1",
        type: "agent.message",
        content: [{ type: "text", text: "I'll delegate this to Donald." }],
      },
      {
        id: TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "Audit",
          description: "Do the thing",
          wait: true,
        },
      },
      {
        id: "sevt_idle_1",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ];

    let toolResultPosted = false;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "test",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "ready", name: "test" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          toolResultPosted = true;
          return {
            status: 200,
            body: {
              data: [
                {
                  id: "sevt_tool_result_echo",
                  type: "user.custom_tool_result",
                  custom_tool_use_id: ev.custom_tool_use_id,
                },
              ],
            },
          };
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (!toolResultPosted) {
          return { status: 200, body: { data: preEvents } };
        }
        // H1: session accepts the tool_result post + emits a second idle,
        // but NO new span.model_request_end — MA never ran the synthesis turn.
        return {
          status: 200,
          body: {
            data: [
              ...preEvents,
              {
                id: "sevt_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID,
              },
              {
                id: "sevt_idle_2",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "terminated",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 3,
              output_tokens: 984,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 25.7, duration_seconds: 120 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    // delegateTask succeeds (the child run completed normally). H1 is NOT
    // about delegation failure — it's about MA not resuming the PARENT.
    const delegateTask = async (): Promise<DelegationResult> => ({
      status: "completed",
      childRunId: "child-run-uuid",
      childIssueId: "child-issue-uuid",
      childIssueIdentifier: "DT-1",
      finalText: "Donald's full audit: 7956 chars of substance.",
      costUsd: 0.42,
      errorCode: null,
      errorMessage: null,
    });

    try {
      const result = await execute(buildCtx({ runId: RUN_ID, delegateTask }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("session_terminated_before_tool_result");
      expect(result.errorMeta).toMatchObject({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        customToolUseCount: 1,
        spanCount: 1,
      });
    } finally {
      mock.restore();
    }
  }, 20_000);

  it("does not flag healthy delegation where a synthesis span follows tool_result", async () => {
    const SESSION_ID = "sesn_test_healthy";
    const AGENT_ID = "agnt_healthy";
    const ENV_ID = "envr_healthy";
    const TOOL_USE_ID = "sevt_tool_use_healthy";

    const preEvents: MaEventStub[] = [
      {
        id: "sevt_span_pre",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: "sevt_msg_pre",
        type: "agent.message",
        content: [{ type: "text", text: "delegating" }],
      },
      {
        id: TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "x",
          description: "y",
          wait: true,
        },
      },
      {
        id: "sevt_idle_pre",
        type: "session.status_idle",
        stop_reason: { type: "tool_use" },
      },
    ];

    let toolResultPosted = false;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "t",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "r", name: "t" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          toolResultPosted = true;
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (!toolResultPosted) {
          return { status: 200, body: { data: preEvents } };
        }
        return {
          status: 200,
          body: {
            data: [
              ...preEvents,
              {
                id: "sevt_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID,
              },
              {
                id: "sevt_span_post",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 5,
                  output_tokens: 3000,
                  cache_read_input_tokens: 19300,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_synthesis",
                type: "agent.message",
                content: [
                  {
                    type: "text",
                    text: "Synthesis: Donald's audit summary.",
                  },
                ],
              },
              {
                id: "sevt_idle_post",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 8,
              output_tokens: 3200,
              cache_read_input_tokens: 19300,
            },
            stats: { active_seconds: 135, duration_seconds: 160 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    const delegateTask = async (): Promise<DelegationResult> => ({
      status: "completed",
      childRunId: "c",
      childIssueId: "i",
      childIssueIdentifier: "X-1",
      finalText: "Donald output",
      costUsd: 0.1,
      errorCode: null,
      errorMessage: null,
    });

    try {
      const result = await execute(
        buildCtx({ runId: "healthy-run", delegateTask }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();
      const rj = result.resultJson as Record<string, unknown> | undefined;
      expect(typeof rj?.finalText).toBe("string");
      expect(rj?.finalText as string).toContain("Synthesis");
    } finally {
      mock.restore();
    }
  }, 20_000);

  // ---------------------------------------------------------------------------
  // Bug 3 regression — requires_action is NOT terminal
  //
  // Context (2026-04-24, Ada session sesn_011CaPRJPSkKLhPzTo4i5q9R on
  // paperclip-workforce-00035-fxf): Ada called get_context, the tool returned
  // 1969 bytes status=ok, post_tool_result_ok in 434ms. Immediately after, MA
  // emitted session.status_idle with stop_reason="requires_action" — meaning
  // "model has emitted a tool_use block, waiting for tool_result". The
  // adapter's pre-fix terminal-detection treated ANY status_idle as terminal,
  // so it exited via terminal_no_pending_tool before the next
  // agent.custom_tool_use event materialised in the events stream. Result:
  // h1Detected=true, isError=true, finalTextLen=183.
  //
  // The fix (execute.ts:263 area): isHardTerminal excludes requires_action
  //   isHardTerminal = sawStatusTerminated ||
  //                    (sawStatusIdle && lastIdleStopReason !== "requires_action")
  //
  // This test drives the exact race: poll 1 returns status_idle{requires_action}
  // without the next tool_use; poll 2 returns the next tool_use; adapter must
  // dispatch the second tool, post its result, then synthesise on poll 3.
  // ---------------------------------------------------------------------------
  it("does not terminate on session.status_idle with stop_reason=requires_action — keeps polling", async () => {
    const SESSION_ID = "sesn_test_requires_action";
    const AGENT_ID = "agnt_requires_action";
    const ENV_ID = "envr_requires_action";
    const TOOL_USE_ID_1 = "sevt_tool_use_1";
    const TOOL_USE_ID_2 = "sevt_tool_use_2";

    // Initial events: first tool_use + status_idle{requires_action}.
    // This is the state the adapter sees on its first GET /events poll after
    // POST /v1/sessions creation.
    const initialEvents: MaEventStub[] = [
      {
        id: "sevt_span_1",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: TOOL_USE_ID_1,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "first",
          description: "first call",
          wait: true,
        },
      },
      {
        id: "sevt_idle_after_tool_1",
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      },
    ];

    let toolResult1Posted = false;
    let toolResult2Posted = false;
    // Track whether we've completed the "requires_action with no new tool yet"
    // poll cycle. Pre-fix this was where the adapter would exit. Post-fix it
    // must continue to the next poll where the second tool_use lands.
    let postedToolResult1Polls = 0;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "t",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "r", name: "t" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          if (ev.custom_tool_use_id === TOOL_USE_ID_1) toolResult1Posted = true;
          else if (ev.custom_tool_use_id === TOOL_USE_ID_2) toolResult2Posted = true;
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (!toolResult1Posted) {
          return { status: 200, body: { data: initialEvents } };
        }
        // First poll AFTER tool_result_1: simulate the race — status_idle
        // already emitted with requires_action, but the next tool_use event
        // hasn't landed yet. Pre-fix this is where the bug fired.
        if (postedToolResult1Polls === 0) {
          postedToolResult1Polls += 1;
          return {
            status: 200,
            body: {
              data: [
                ...initialEvents,
                {
                  id: "sevt_tool_result_echo_1",
                  type: "user.custom_tool_result",
                  custom_tool_use_id: TOOL_USE_ID_1,
                },
              ],
            },
          };
        }
        // Second poll: the next tool_use event lands.
        if (!toolResult2Posted) {
          return {
            status: 200,
            body: {
              data: [
                ...initialEvents,
                {
                  id: "sevt_tool_result_echo_1",
                  type: "user.custom_tool_result",
                  custom_tool_use_id: TOOL_USE_ID_1,
                },
                {
                  id: "sevt_span_2",
                  type: "span.model_request_end",
                  model_usage: {
                    input_tokens: 5,
                    output_tokens: 150,
                    cache_read_input_tokens: 19300,
                    cache_creation_input_tokens: 0,
                  },
                },
                {
                  id: TOOL_USE_ID_2,
                  type: "agent.custom_tool_use",
                  name: "delegate_task",
                  input: {
                    assignee_agent_name: "Donald",
                    title: "second",
                    description: "second call",
                    wait: true,
                  },
                },
                {
                  id: "sevt_idle_after_tool_2",
                  type: "session.status_idle",
                  stop_reason: { type: "requires_action" },
                },
              ],
            },
          };
        }
        // Third poll: synthesis span + final message + end_turn.
        return {
          status: 200,
          body: {
            data: [
              ...initialEvents,
              {
                id: "sevt_tool_result_echo_1",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID_1,
              },
              {
                id: "sevt_span_2",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 5,
                  output_tokens: 150,
                  cache_read_input_tokens: 19300,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: TOOL_USE_ID_2,
                type: "agent.custom_tool_use",
                name: "delegate_task",
                input: {
                  assignee_agent_name: "Donald",
                  title: "second",
                  description: "second call",
                  wait: true,
                },
              },
              {
                id: "sevt_idle_after_tool_2",
                type: "session.status_idle",
                stop_reason: { type: "requires_action" },
              },
              {
                id: "sevt_tool_result_echo_2",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID_2,
              },
              {
                id: "sevt_span_3",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 8,
                  output_tokens: 800,
                  cache_read_input_tokens: 19300,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_synthesis",
                type: "agent.message",
                content: [
                  { type: "text", text: "Synthesis after two tool calls." },
                ],
              },
              {
                id: "sevt_idle_end_turn",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 8, output_tokens: 1150, cache_read_input_tokens: 19300 },
            stats: { active_seconds: 32, duration_seconds: 40 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    let delegateCalls = 0;
    const delegateTask = async (): Promise<DelegationResult> => {
      delegateCalls += 1;
      return {
        status: "completed",
        childRunId: `c-${delegateCalls}`,
        childIssueId: "i",
        childIssueIdentifier: `X-${delegateCalls}`,
        finalText: `Donald output ${delegateCalls}`,
        costUsd: 0.1,
        errorCode: null,
        errorMessage: null,
      };
    };

    try {
      const result = await execute(
        buildCtx({ runId: "requires-action-run", delegateTask }),
      );
      // Both tool calls dispatched.
      expect(delegateCalls).toBe(2);
      // Both tool results posted (proves adapter survived the requires_action idle).
      expect(toolResult1Posted).toBe(true);
      expect(toolResult2Posted).toBe(true);
      // Session synthesised cleanly — no H1 false-positive, exit code 0.
      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();
      const rj = result.resultJson as Record<string, unknown> | undefined;
      expect(rj?.finalText as string).toContain("Synthesis after two tool calls");
    } finally {
      mock.restore();
    }
  }, 20_000);

  // ---------------------------------------------------------------------------
  // Bug 5 regression — parallel tool_use blocks must NOT trigger H1
  //
  // Context (2026-04-25, Donald sessions on paperclip-workforce-00037-6kr):
  //   Three Donald audit sessions completed cleanly (stopReason=end_turn,
  //   maSessionStatus=idle, all API calls 200) but were flagged isError=true
  //   because spanCount=3, customToolUseCount=3 → 3 < 3+1 false-positives the
  //   old H1 invariant. The Anthropic Messages API permits a single assistant
  //   turn to emit multiple tool_use blocks in parallel — counting raw events
  //   over-counts.
  //
  // The fix (execute.ts:792 area): count distinct *tool-emitting spans*, not
  // raw tool_use events. The new invariant is spanCount >= toolUseSpanCount + 1.
  //
  // This test scripts a session where one model span emits TWO parallel
  // tool_use blocks, both tools resolve, then a synthesis span produces the
  // final text. spanCount=2, customToolUseCount=2, toolUseSpanCount=1.
  // Old detector: 2 < 2+1 → H1 (false positive). New detector: 2 >= 1+1 → ok.
  // ---------------------------------------------------------------------------
  it("does not flag parallel tool_use blocks within a single span", async () => {
    const SESSION_ID = "sesn_test_parallel_tools";
    const AGENT_ID = "agnt_parallel";
    const ENV_ID = "envr_parallel";
    const TOOL_USE_ID_A = "sevt_tool_use_parallel_a";
    const TOOL_USE_ID_B = "sevt_tool_use_parallel_b";

    // Pre-tool-result events: ONE span end, then TWO parallel tool_use
    // events emitted by that span, then status_idle{tool_use}.
    const preEvents: MaEventStub[] = [
      {
        id: "sevt_span_pre",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: "sevt_msg_pre",
        type: "agent.message",
        content: [{ type: "text", text: "I'll fetch context and search in parallel." }],
      },
      {
        id: TOOL_USE_ID_A,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "branch a",
          description: "first parallel call",
          wait: true,
        },
      },
      {
        id: TOOL_USE_ID_B,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "branch b",
          description: "second parallel call",
          wait: true,
        },
      },
      {
        id: "sevt_idle_pre",
        type: "session.status_idle",
        stop_reason: { type: "tool_use" },
      },
    ];

    let toolResultsPosted = 0;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "t",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "r", name: "t" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          toolResultsPosted += 1;
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (toolResultsPosted < 2) {
          return { status: 200, body: { data: preEvents } };
        }
        // Both tool_results posted → single synthesis span produces final text.
        return {
          status: 200,
          body: {
            data: [
              ...preEvents,
              {
                id: "sevt_tool_result_a",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID_A,
              },
              {
                id: "sevt_tool_result_b",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID_B,
              },
              {
                id: "sevt_span_synthesis",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 5,
                  output_tokens: 800,
                  cache_read_input_tokens: 19300,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_synthesis",
                type: "agent.message",
                content: [
                  { type: "text", text: "Synthesis after parallel tool calls." },
                ],
              },
              {
                id: "sevt_idle_end",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 8, output_tokens: 1000, cache_read_input_tokens: 19300 },
            stats: { active_seconds: 28, duration_seconds: 35 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    let delegateCalls = 0;
    const delegateTask = async (): Promise<DelegationResult> => {
      delegateCalls += 1;
      return {
        status: "completed",
        childRunId: `c-${delegateCalls}`,
        childIssueId: "i",
        childIssueIdentifier: `X-${delegateCalls}`,
        finalText: `branch ${delegateCalls} output`,
        costUsd: 0.1,
        errorCode: null,
        errorMessage: null,
      };
    };

    try {
      const result = await execute(
        buildCtx({ runId: "parallel-tools-run", delegateTask }),
      );
      // Both parallel tools dispatched.
      expect(delegateCalls).toBe(2);
      expect(toolResultsPosted).toBe(2);
      // Synthesis ran, no H1 false positive.
      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();
      const rj = result.resultJson as Record<string, unknown> | undefined;
      // Counts recorded for diagnostics.
      expect(rj?.customToolUseCount).toBe(2);
      expect(rj?.toolUseSpanCount).toBe(1);
      expect(rj?.spanCount).toBe(2);
      expect(rj?.h1Detected).toBe(false);
      expect(rj?.finalText as string).toContain("Synthesis after parallel");
    } finally {
      mock.restore();
    }
  }, 20_000);
});
