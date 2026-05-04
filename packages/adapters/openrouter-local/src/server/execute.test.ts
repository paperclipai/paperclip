import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

interface CapturedRequest {
  model: string;
  messages: unknown[];
  tools: unknown;
  tool_choice: unknown;
}

interface ScriptedReply {
  content?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cached?: number };
  provider?: string;
}

interface ScriptedClient {
  capturedRequests: CapturedRequest[];
  defaultHeaders: Record<string, string> | undefined;
  baseURL: string | undefined;
  apiKey: string | undefined;
}

function buildClient(replies: ScriptedReply[]): {
  factory: NonNullable<Parameters<typeof execute>[1]>["openAiFactory"];
  state: ScriptedClient;
} {
  const state: ScriptedClient = {
    capturedRequests: [],
    defaultHeaders: undefined,
    baseURL: undefined,
    apiKey: undefined,
  };
  let cursor = 0;
  const factory: NonNullable<Parameters<typeof execute>[1]>["openAiFactory"] = (init) => {
    state.defaultHeaders = init.defaultHeaders;
    state.baseURL = init.baseURL;
    state.apiKey = init.apiKey;
    return {
      chat: {
        completions: {
          create: vi.fn(async (req: CapturedRequest) => {
            state.capturedRequests.push(req);
            const reply = replies[cursor] ?? replies[replies.length - 1];
            cursor++;
            const usage = reply.usage
              ? {
                  prompt_tokens: reply.usage.prompt_tokens ?? 0,
                  completion_tokens: reply.usage.completion_tokens ?? 0,
                  total_tokens:
                    (reply.usage.prompt_tokens ?? 0) + (reply.usage.completion_tokens ?? 0),
                  prompt_tokens_details: reply.usage.cached
                    ? { cached_tokens: reply.usage.cached }
                    : undefined,
                }
              : undefined;
            const tool_calls = (reply.toolCalls ?? []).map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));
            return {
              id: `cmpl-${cursor}`,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant" as const,
                    content: reply.content ?? null,
                    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
                  },
                  finish_reason: tool_calls.length > 0 ? "tool_calls" : "stop",
                },
              ],
              usage,
              ...(reply.provider ? { provider: reply.provider } : {}),
            };
          }),
        },
      },
    } as unknown as ReturnType<NonNullable<Parameters<typeof execute>[1]>["openAiFactory"]>;
  };
  return { factory, state };
}

let tmp: string;
let logs: { stream: string; chunk: string }[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-local-execute-"));
  logs = [];
  process.env.OPENROUTER_API_KEY = "sk-test";
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function buildCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "co-1",
      name: "agent",
      adapterType: "openrouter_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: tmp,
      promptTemplate: "do thing",
      model: "openai/gpt-4o-mini",
    },
    context: { taskTitle: "the task" },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    ...overrides,
  };
}

function readJsonlEvents() {
  return logs
    .filter((l) => l.stream === "stdout" && l.chunk.trim().startsWith("{"))
    .map((l) => JSON.parse(l.chunk.trim()));
}

describe("execute", () => {
  it("returns missing_api_key when no key is in the env", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await execute(buildCtx(), { openAiFactory: () => ({ chat: {} as never }) });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("missing_api_key");
  });

  it("emits init + assistant + result for a single non-tool reply", async () => {
    const { factory, state } = buildClient([
      {
        content: "all done",
        usage: { prompt_tokens: 10, completion_tokens: 4 },
        provider: "openai",
      },
    ]);
    const result = await execute(buildCtx(), { openAiFactory: factory });
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(result.provider).toBe("openai");
    expect(result.summary).toBe("all done");
    expect(state.capturedRequests).toHaveLength(1);
    const events = readJsonlEvents();
    expect(events[0].kind).toBe("init");
    expect(events.some((e) => e.kind === "assistant" && e.text === "all done")).toBe(true);
    expect(events[events.length - 1].kind).toBe("result");
  });

  it("dispatches a tool call, feeds the result back, and finalizes", async () => {
    await fs.writeFile(path.join(tmp, "note.txt"), "hello-from-disk");
    const { factory, state } = buildClient([
      {
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: JSON.stringify({ path: "note.txt" }),
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
      {
        content: "I read the file.",
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      },
    ]);

    const result = await execute(buildCtx(), { openAiFactory: factory });
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 8 });
    expect(state.capturedRequests).toHaveLength(2);

    // The second request must include the tool result with the file body.
    const secondMessages = state.capturedRequests[1].messages as Array<{
      role: string;
      content?: unknown;
    }>;
    const toolMessage = secondMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeTruthy();
    expect(String(toolMessage!.content)).toContain("hello-from-disk");

    const events = readJsonlEvents();
    expect(events.some((e) => e.kind === "tool_call" && e.name === "read_file")).toBe(true);
    const toolResultEvent = events.find((e) => e.kind === "tool_result");
    expect(toolResultEvent?.toolName).toBe("read_file");
    expect(toolResultEvent?.isError).toBe(false);
  });

  it("sends OpenRouter headers when baseUrl points at openrouter", async () => {
    const { factory, state } = buildClient([{ content: "ok" }]);
    await execute(
      buildCtx({
        config: {
          cwd: tmp,
          baseUrl: "https://openrouter.ai/api/v1",
          model: "x/y",
        },
      }),
      { openAiFactory: factory },
    );
    expect(state.defaultHeaders?.["HTTP-Referer"]).toBe(
      "https://github.com/paperclipai/paperclip",
    );
    expect(state.defaultHeaders?.["X-Title"]).toContain("openrouter-local");
  });

  it("omits OpenRouter headers when baseUrl is not openrouter", async () => {
    const { factory, state } = buildClient([{ content: "ok" }]);
    await execute(
      buildCtx({
        config: {
          cwd: tmp,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
      }),
      { openAiFactory: factory },
    );
    expect(state.defaultHeaders).toBeUndefined();
  });

  it("respects disabledTools", async () => {
    const { factory, state } = buildClient([{ content: "ok" }]);
    await execute(
      buildCtx({
        config: {
          cwd: tmp,
          model: "openai/gpt-4o-mini",
          disabledTools: ["run_command", "apply_patch"],
        },
      }),
      { openAiFactory: factory },
    );
    const sentTools = state.capturedRequests[0].tools as Array<{
      function: { name: string };
    }>;
    const names = sentTools.map((t) => t.function.name);
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("apply_patch");
    expect(names).toContain("read_file");
  });

  it("renders prompt template variables", async () => {
    const { factory, state } = buildClient([{ content: "ok" }]);
    await execute(
      buildCtx({
        config: {
          cwd: tmp,
          model: "openai/gpt-4o-mini",
          promptTemplate: "task={{taskTitle}} agent={{agentName}}",
        },
      }),
      { openAiFactory: factory },
    );
    const userMessage = (state.capturedRequests[0].messages as Array<{
      role: string;
      content: string;
    }>).find((m) => m.role === "user");
    expect(userMessage?.content).toBe("task=the task agent=agent");
  });

  it("loads AGENTS.md as the system prompt", async () => {
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "follow the rules");
    const { factory, state } = buildClient([{ content: "ok" }]);
    await execute(buildCtx(), { openAiFactory: factory });
    const systemMessage = (state.capturedRequests[0].messages as Array<{
      role: string;
      content: string;
    }>).find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("follow the rules");
  });

  it("stops after maxIterations even if model keeps requesting tools", async () => {
    await fs.writeFile(path.join(tmp, "note.txt"), "data");
    const reply = {
      toolCalls: [
        {
          id: "loop",
          name: "read_file",
          arguments: JSON.stringify({ path: "note.txt" }),
        },
      ],
    };
    const { factory, state } = buildClient([reply, reply, reply, reply]);
    const result = await execute(
      buildCtx({
        config: { cwd: tmp, model: "x", maxIterations: 2 },
      }),
      { openAiFactory: factory },
    );
    expect(state.capturedRequests).toHaveLength(2);
    expect(result.exitCode).toBe(0);
  });
});
