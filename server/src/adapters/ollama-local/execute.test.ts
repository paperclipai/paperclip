import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { executeOllamaLocal } from "./execute.js";

function buildContext(overrides?: Partial<AdapterExecutionContext>): AdapterExecutionContext {
  const baseConfig = {
    model: "qwen3:latest",
    baseUrl: "http://127.0.0.1:11434",
    streaming: false,
  };
  return {
    runId: "run_ollama_local",
    agent: {
      id: "agent_ollama",
      companyId: "company_1",
      name: "Ollama Tester",
      adapterType: "ollama_local",
      adapterConfig: baseConfig,
    } as AdapterExecutionContext["agent"],
    config: baseConfig,
    context: {
      paperclipWake: {
        agent: { id: "agent_ollama", name: "Ollama Tester", role: "builder" },
        issue: { identifier: "PC-2", title: "Test ollama" },
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
});

describe("executeOllamaLocal", () => {
  it("handles a basic non-streaming assistant response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          message: { content: "Local Ollama says hello" },
          done_reason: "stop",
          prompt_eval_count: 12,
          eval_count: 9,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await executeOllamaLocal(buildContext());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toContain("Local Ollama says hello");
    expect(result.sessionParams).toBeTruthy();
  });

  it("executes a command tool call and continues the conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "run_command",
                    arguments: { command: "/usr/bin/printf", args: ["tool ok"] },
                  },
                },
              ],
            },
            done_reason: "tool_calls",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: { content: "Tool result received" },
            done_reason: "stop",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await executeOllamaLocal(
      buildContext({
        config: {
          model: "qwen3:latest",
          baseUrl: "http://127.0.0.1:11434",
          streaming: false,
          enableCommandExecution: true,
          commandTimeoutSec: 5,
          maxToolCalls: 2,
        },
        agent: {
          id: "agent_ollama",
          companyId: "company_1",
          name: "Ollama Tester",
          adapterType: "ollama_local",
          adapterConfig: {
            model: "qwen3:latest",
            baseUrl: "http://127.0.0.1:11434",
            streaming: false,
            enableCommandExecution: true,
            commandTimeoutSec: 5,
            maxToolCalls: 2,
          },
        } as AdapterExecutionContext["agent"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toContain("Tool result received");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
