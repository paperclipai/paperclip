import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { executeCustomLlmLocal } from "./execute.js";

function buildContext(overrides?: Partial<AdapterExecutionContext>): AdapterExecutionContext {
  const baseConfig = {
    model: "qwen-3-max",
    baseUrl: "http://127.0.0.1:5678/v1",
    transport: "openai_chat_completions",
  };
  return {
    runId: "run_custom_llm",
    agent: {
      id: "agent_1",
      companyId: "company_1",
      name: "Bridge Tester",
      adapterType: "custom_llm_local",
      adapterConfig: baseConfig,
    } as AdapterExecutionContext["agent"],
    config: baseConfig,
    context: {
      paperclipWake: {
        agent: { name: "Bridge Tester", id: "agent_1", role: "builder" },
        issue: { identifier: "PC-1", title: "Test issue" },
      },
    } as AdapterExecutionContext["context"],
    runtime: {},
    authToken: null,
    onMeta: vi.fn(async () => undefined),
    onLog: vi.fn(async () => undefined),
    ...overrides,
  } as AdapterExecutionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CUSTOM_LLM_API_KEY;
});

describe("executeCustomLlmLocal", () => {
  it("executes the OpenAI chat completions transport", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from custom llm" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await executeCustomLlmLocal(buildContext());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toContain("Hello from custom llm");
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const requestInit = firstCall?.[1] as RequestInit | undefined;
    expect(String(requestInit?.body)).toContain("qwen-3-max");
  });

  it("uses apiKeyEnv for Anthropic transport and never requires raw apiKey", async () => {
    process.env.CUSTOM_LLM_API_KEY = "super-secret";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "x-api-key": "super-secret" });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Anthropic says hi" }],
          usage: { input_tokens: 33, output_tokens: 11 },
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await executeCustomLlmLocal(
      buildContext({
        config: {
          model: "claude-3-7-sonnet",
          baseUrl: "https://example.test/v1",
          transport: "anthropic_messages",
          apiKeyEnv: "CUSTOM_LLM_API_KEY",
        },
        agent: {
          id: "agent_1",
          companyId: "company_1",
          name: "Bridge Tester",
          adapterType: "custom_llm_local",
          adapterConfig: {
            model: "claude-3-7-sonnet",
            baseUrl: "https://example.test/v1",
            transport: "anthropic_messages",
            apiKeyEnv: "CUSTOM_LLM_API_KEY",
          },
        } as AdapterExecutionContext["agent"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toContain("Anthropic says hi");
  });

  it("rejects raw apiKey configuration", async () => {
    const result = await executeCustomLlmLocal(
      buildContext({
        config: {
          model: "qwen-3-max",
          baseUrl: "http://127.0.0.1:5678/v1",
          transport: "openai_chat_completions",
          apiKey: "should-not-be-here",
        },
        agent: {
          id: "agent_1",
          companyId: "company_1",
          name: "Bridge Tester",
          adapterType: "custom_llm_local",
          adapterConfig: {
            model: "qwen-3-max",
            baseUrl: "http://127.0.0.1:5678/v1",
            transport: "openai_chat_completions",
            apiKey: "should-not-be-here",
          },
        } as AdapterExecutionContext["agent"],
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("CONFIG_INVALID");
    expect(result.summary).toContain("apiKey");
  });
});
