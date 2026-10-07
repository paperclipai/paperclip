import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

type FetchCall = { url: string; init: RequestInit };

function completion(message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return new Response(JSON.stringify({ model: "served-model", choices: [{ message }], usage }), { status: 200 });
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: input.toString(), init };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}) {
  const logs: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Ada", adapterType: "openai_compatible", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      apiUrl: "https://llm.example.com/v1/chat/completions",
      model: "provider/model",
      env: { OPENAI_COMPATIBLE_API_KEY: "sk-test" },
      promptTemplate: "Work on your tasks, {{agent.name}}.",
      paperclipRuntimeSkills: [],
    },
    context: { taskId: "issue-9" },
    authToken: "run-jwt",
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
    ...overrides,
  } as AdapterExecutionContext;
  return { ctx, logs };
}

function events(logs: string[]) {
  return logs.flatMap((chunk) => chunk.split("\n")).filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai_compatible execute", () => {
  it("runs the tool loop and persists the conversation", async () => {
    let llmCalls = 0;
    const calls = installFetch(({ url }) => {
      if (url.startsWith("https://llm.example.com")) {
        llmCalls++;
        return llmCalls === 1
          ? completion({
              content: "",
              tool_calls: [{
                id: "c1",
                type: "function",
                function: { name: "paperclip_api_request", arguments: '{"method":"GET","path":"/api/agents/me"}' },
              }],
            })
          : completion({ content: "Posted an update.\nMore detail." });
      }
      return new Response('{"id":"agent-1"}', { status: 200 });
    });
    const { ctx, logs } = makeCtx();

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "Posted an update.",
      usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 },
      usageBasis: "per_run",
      model: "served-model",
      provider: "openai_compatible",
      biller: "llm.example.com",
      billingType: "api",
      clearSession: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://llm.example.com/v1/chat/completions",
      expect.stringMatching(/\/api\/agents\/me$/),
      "https://llm.example.com/v1/chat/completions",
    ]);
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(calls[1].init.headers).toMatchObject({ authorization: "Bearer run-jwt", "x-paperclip-run-id": "run-1" });
    const firstBody = JSON.parse(String(calls[0].init.body));
    expect(firstBody.model).toBe("provider/model");
    expect(firstBody.messages[0].role).toBe("system");
    expect(firstBody.messages[0].content).toContain("PAPERCLIP_TASK_ID = issue-9");
    expect(firstBody.messages[0].content).not.toContain("sk-test");
    expect(firstBody.messages[0].content).not.toContain("run-jwt");
    expect(firstBody.messages[1]).toEqual({ role: "user", content: expect.stringContaining("Work on your tasks, Ada.") });
    expect(firstBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["paperclip_api_request"]);

    const session = result.sessionParams as { messages: Array<{ role: string }>; apiUrl: string };
    expect(session.apiUrl).toBe("https://llm.example.com/v1");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(events(logs).map((event) => event.type)).toEqual([
      "openai_compatible.init",
      "openai_compatible.tool_call",
      "openai_compatible.tool_result",
      "openai_compatible.assistant",
      "openai_compatible.result",
    ]);
  });

  it("resumes a stored session for the same API URL", async () => {
    const calls = installFetch(() => completion({ content: "Continuing." }));
    const { ctx } = makeCtx({
      runtime: {
        sessionId: "s-1",
        sessionParams: {
          sessionId: "s-1",
          apiUrl: "https://llm.example.com/v1",
          model: "provider/model",
          messages: [{ role: "user", content: "earlier" }, { role: "assistant", content: "earlier reply" }],
        },
        sessionDisplayId: "s-1",
        taskKey: null,
      },
    });
    const result = await execute(ctx);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages.slice(1, 3)).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    expect(result.sessionId).toBe("s-1");
  });

  it("retries fresh when the stored history overflows the context window", async () => {
    let call = 0;
    installFetch(() => {
      call++;
      return call === 1
        ? new Response(JSON.stringify({ error: { message: "maximum context length exceeded" } }), { status: 400 })
        : completion({ content: "Fresh start." });
    });
    const { ctx } = makeCtx({
      runtime: {
        sessionId: "s-1",
        sessionParams: { sessionId: "s-1", apiUrl: "https://llm.example.com/v1", messages: [{ role: "user", content: "old" }] },
        sessionDisplayId: "s-1",
        taskKey: null,
      },
    });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).not.toBe("s-1");
  });

  it("fails fast on invalid configuration without calling the provider", async () => {
    const calls = installFetch(() => completion({ content: "unused" }));
    const { ctx } = makeCtx();
    ctx.config = { ...ctx.config, apiUrl: "not a url" };
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "configuration_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("reports provider errors and max-turn exhaustion", async () => {
    installFetch(() => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }));
    const failed = await execute(makeCtx().ctx);
    expect(failed).toMatchObject({
      exitCode: 1,
      errorCode: "provider_error",
      errorMessage: "Provider returned HTTP 401: Invalid API key",
    });

    installFetch(() =>
      completion({
        content: "",
        tool_calls: [{ id: "c", type: "function", function: { name: "unknown_tool", arguments: "{}" } }],
      }),
    );
    const { ctx } = makeCtx();
    ctx.config = { ...ctx.config, maxTurns: 2 };
    const exhausted = await execute(ctx);
    expect(exhausted).toMatchObject({ exitCode: 1, errorCode: "max_turns_reached" });
  });
});

describe("openai_compatible testEnvironment", () => {
  it("passes when the hello probe succeeds", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) =>
      input.toString().endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "provider/model" }] }), { status: 200 })
        : completion({ content: "hello" }),
    );
    const result = await testEnvironment(
      {
        companyId: "c",
        adapterType: "openai_compatible",
        config: { apiUrl: "https://llm.example.com/v1", model: "provider/model", env: { OPENAI_COMPATIBLE_API_KEY: "k" } },
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual([
      "openai_compatible_api_url_valid",
      "openai_compatible_model_listed",
      "openai_compatible_hello_probe_passed",
    ]);
  });

  it("fails without a URL and model, and warns without a key", async () => {
    const fetchImpl = vi.fn();
    const result = await testEnvironment(
      { companyId: "c", adapterType: "openai_compatible", config: {} },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual([
      "openai_compatible_api_url_missing",
      "openai_compatible_model_missing",
      "openai_compatible_api_key_missing",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
