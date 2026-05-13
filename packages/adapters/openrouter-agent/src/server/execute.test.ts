import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { PaperclipApiError } from "./paperclip-api.js";

// Wrapper that zeroes out the generation fetch delay so tests run fast.
function exec(
  ctx: AdapterExecutionContext,
  opts: Omit<Parameters<typeof execute>[1], "generationFetchDelayMs"> & { generationFetchDelayMs?: number } = {},
) {
  return execute(ctx, { generationFetchDelayMs: 0, ...opts });
}

interface CapturedRequest {
  model: string;
  messages: unknown[];
  tools: unknown;
  tool_choice: unknown;
  reasoning?: unknown;
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
  reasoning?: string;
  reasoning_details?: Array<{ type: string; text?: string; content?: string }>;
}

interface ScriptedClient {
  capturedRequests: CapturedRequest[];
  defaultHeaders: Record<string, string> | undefined;
  baseURL: string | undefined;
  apiKey: string | undefined;
}

// Builds a client whose create() resolves normally for `firstReplies`, then
// hangs indefinitely until the AbortSignal fires (throwing AbortError).
function buildHangingClient(firstReplies: ScriptedReply[]): {
  factory: NonNullable<Parameters<typeof execute>[1]>["openAiFactory"];
  capturedRequests: CapturedRequest[];
} {
  const capturedRequests: CapturedRequest[] = [];
  let cursor = 0;

  const factory: NonNullable<Parameters<typeof execute>[1]>["openAiFactory"] = () => {
    return {
      chat: {
        completions: {
          create: vi.fn(async (req: CapturedRequest & { signal?: AbortSignal }) => {
            capturedRequests.push(req);
            const reply = firstReplies[cursor];
            cursor++;
            if (reply !== undefined) {
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
                      ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
                      ...(reply.reasoning_details !== undefined ? { reasoning_details: reply.reasoning_details } : {}),
                    },
                    finish_reason: tool_calls.length > 0 ? "tool_calls" : "stop",
                  },
                ],
                usage,
                ...(reply.provider ? { provider: reply.provider } : {}),
              };
            }
            // No more scripted replies — hang until signal fires.
            return new Promise<never>((_, reject) => {
              const onAbort = () => {
                const err = Object.assign(new Error("The operation was aborted."), {
                  name: "AbortError",
                });
                reject(err);
              };
              if (req.signal?.aborted) {
                onAbort();
              } else {
                req.signal?.addEventListener("abort", onAbort, { once: true });
              }
            });
          }),
        },
      },
    } as unknown as ReturnType<NonNullable<Parameters<typeof execute>[1]>["openAiFactory"]>;
  };

  return { factory, capturedRequests };
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
                    ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
                    ...(reply.reasoning_details !== undefined ? { reasoning_details: reply.reasoning_details } : {}),
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-agent-execute-"));
  logs = [];
  process.env.OPENROUTER_API_KEY = "sk-test";
  // Default fetch stub: non-2xx so generation cost stays 0 for tests that don't care about it.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  vi.unstubAllGlobals();
});

function buildCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "co-1",
      name: "agent",
      adapterType: "openrouter_agent",
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
    context: { paperclipWake: { issue: { title: "the task" } } },
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
    const result = await exec(buildCtx(), { openAiFactory: () => ({ chat: {} as never }) });
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
    const result = await exec(buildCtx(), { openAiFactory: factory });
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

    const result = await exec(buildCtx(), { openAiFactory: factory });
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
    await exec(
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
    expect(state.defaultHeaders?.["X-Title"]).toContain("openrouter-agent");
  });

  it("omits OpenRouter headers when baseUrl is not openrouter", async () => {
    const { factory, state } = buildClient([{ content: "ok" }]);
    await exec(
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
    await exec(
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
    await exec(
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
    await exec(buildCtx(), { openAiFactory: factory });
    const systemMessage = (state.capturedRequests[0].messages as Array<{
      role: string;
      content: string;
    }>).find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("follow the rules");
  });

  describe("company skills injection", () => {
    function skillCtx(overrideConfig: Record<string, unknown>) {
      return buildCtx({ config: { cwd: tmp, model: "openai/gpt-4o-mini", ...overrideConfig } });
    }

    async function makeSkill(name: string, content: string): Promise<string> {
      const dir = path.join(tmp, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), content);
      return dir;
    }

    function systemContent(capturedRequests: CapturedRequest[]): string {
      const msg = (capturedRequests[0].messages as Array<{ role: string; content: string }>)
        .find((m) => m.role === "system");
      return msg?.content ?? "";
    }

    it("injects desired skill SKILL.md into the system prompt", async () => {
      const source = await makeSkill("my-skill", "## My Skill\nDo the thing.");
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        skillCtx({
          paperclipRuntimeSkills: [{ key: "company/co-1/my-skill", runtimeName: "my-skill", source }],
          paperclipSkillSync: { desiredSkills: ["company/co-1/my-skill"] },
        }),
        { openAiFactory: factory },
      );
      expect(systemContent(state.capturedRequests)).toContain("Do the thing.");
    });

    it("does not inject skills absent from desiredSkills", async () => {
      const source = await makeSkill("secret-skill", "secret skill content");
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        skillCtx({
          paperclipRuntimeSkills: [{ key: "company/co-1/secret-skill", runtimeName: "secret-skill", source }],
          // no paperclipSkillSync — no desired skills selected
        }),
        { openAiFactory: factory },
      );
      expect(systemContent(state.capturedRequests)).not.toContain("secret skill content");
    });

    it("injects multiple desired skills as separate fragments", async () => {
      const srcA = await makeSkill("skill-a", "content from skill A");
      const srcB = await makeSkill("skill-b", "content from skill B");
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        skillCtx({
          paperclipRuntimeSkills: [
            { key: "company/co-1/skill-a", runtimeName: "skill-a", source: srcA },
            { key: "company/co-1/skill-b", runtimeName: "skill-b", source: srcB },
          ],
          paperclipSkillSync: { desiredSkills: ["company/co-1/skill-a", "company/co-1/skill-b"] },
        }),
        { openAiFactory: factory },
      );
      const sys = systemContent(state.capturedRequests);
      expect(sys).toContain("content from skill A");
      expect(sys).toContain("content from skill B");
    });

    it("appends skill fragments after AGENTS.md", async () => {
      await fs.writeFile(path.join(tmp, "AGENTS.md"), "agent instructions");
      const source = await makeSkill("my-skill", "skill instructions");
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        skillCtx({
          paperclipRuntimeSkills: [{ key: "company/co-1/my-skill", runtimeName: "my-skill", source }],
          paperclipSkillSync: { desiredSkills: ["company/co-1/my-skill"] },
        }),
        { openAiFactory: factory },
      );
      const sys = systemContent(state.capturedRequests);
      expect(sys.indexOf("agent instructions")).toBeLessThan(sys.indexOf("skill instructions"));
    });
  });

  describe("wall-clock timeout (timeoutSec)", () => {
    it("completes normally when no timeoutSec is configured", async () => {
      const { factory } = buildClient([
        { content: "done", usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]);
      const result = await exec(buildCtx(), { openAiFactory: factory });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect((result as { errorCode?: string }).errorCode).toBeUndefined();
    });

    it("returns timedOut when timeout fires during OpenAI call", async () => {
      const { factory } = buildHangingClient([]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, model: "x", timeoutSec: 1 } }),
        { openAiFactory: factory },
      );
      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("timeout");
    });

    it("returns timedOut when timeout fires between tool-call iterations", async () => {
      await fs.writeFile(path.join(tmp, "note.txt"), "data");
      const { factory } = buildHangingClient([
        {
          toolCalls: [
            { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        },
      ]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, model: "x", timeoutSec: 1 } }),
        { openAiFactory: factory },
      );
      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("timeout");
    });

    it("includes partial usage accumulated before the timeout", async () => {
      await fs.writeFile(path.join(tmp, "note.txt"), "data");
      const { factory } = buildHangingClient([
        {
          toolCalls: [
            { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 12 },
        },
      ]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, model: "x", timeoutSec: 1 } }),
        { openAiFactory: factory },
      );
      expect(result.timedOut).toBe(true);
      expect(result.usage?.inputTokens).toBe(50);
      expect(result.usage?.outputTokens).toBe(12);
    });

    it("does not fire timeout when run completes before timeoutSec elapses", async () => {
      const { factory } = buildClient([
        { content: "done fast", usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, model: "x", timeoutSec: 60 } }),
        { openAiFactory: factory },
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.summary).toBe("done fast");
    });
  });

  describe("reasoning token support", () => {
    it("emits no thinking entry when response has no reasoning content", async () => {
      const { factory } = buildClient([{ content: "plain answer" }]);
      await exec(buildCtx(), { openAiFactory: factory });
      const events = readJsonlEvents();
      expect(events.some((e) => e.kind === "thinking")).toBe(false);
    });

    it("emits kind:thinking before kind:assistant when message.reasoning is a string", async () => {
      const { factory } = buildClient([
        { content: "answer", reasoning: "let me think..." },
      ]);
      await exec(buildCtx(), { openAiFactory: factory });
      const events = readJsonlEvents();
      const thinkingIdx = events.findIndex((e) => e.kind === "thinking");
      const assistantIdx = events.findIndex((e) => e.kind === "assistant");
      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(events[thinkingIdx].text).toBe("let me think...");
      expect(thinkingIdx).toBeLessThan(assistantIdx);
    });

    it("extracts readable reasoning_details entries and ignores reasoning.encrypted", async () => {
      const { factory } = buildClient([
        {
          content: "answer",
          reasoning_details: [
            { type: "reasoning.text", text: "step one" },
            { type: "reasoning.encrypted", content: "opaque-blob" },
            { type: "reasoning.summary", text: "summary text" },
          ],
        },
      ]);
      await exec(buildCtx(), { openAiFactory: factory });
      const events = readJsonlEvents();
      const thinking = events.find((e) => e.kind === "thinking");
      expect(thinking).toBeTruthy();
      expect(thinking.text).toContain("step one");
      expect(thinking.text).toContain("summary text");
      expect(thinking.text).not.toContain("opaque-blob");
    });

    it("prefers reasoning_details over message.reasoning when both are present", async () => {
      const { factory } = buildClient([
        {
          content: "answer",
          reasoning: "plain fallback",
          reasoning_details: [{ type: "reasoning.text", text: "structured reasoning" }],
        },
      ]);
      await exec(buildCtx(), { openAiFactory: factory });
      const events = readJsonlEvents();
      const thinking = events.find((e) => e.kind === "thinking");
      expect(thinking?.text).toBe("structured reasoning");
      expect(thinking?.text).not.toContain("plain fallback");
    });

    it("passes { enabled: true } when config.reasoning is true", async () => {
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        buildCtx({ config: { cwd: tmp, model: "openai/gpt-4o-mini", reasoning: true } }),
        { openAiFactory: factory },
      );
      expect((state.capturedRequests[0] as CapturedRequest).reasoning).toEqual({ enabled: true });
    });

    it("forwards config.reasoning object verbatim", async () => {
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(
        buildCtx({ config: { cwd: tmp, model: "openai/gpt-4o-mini", reasoning: { effort: "high" } } }),
        { openAiFactory: factory },
      );
      expect((state.capturedRequests[0] as CapturedRequest).reasoning).toEqual({ effort: "high" });
    });

    it("omits reasoning key from completions call when config.reasoning is absent", async () => {
      const { factory, state } = buildClient([{ content: "ok" }]);
      await exec(buildCtx(), { openAiFactory: factory });
      expect("reasoning" in state.capturedRequests[0]).toBe(false);
    });
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
    const result = await exec(
      buildCtx({
        config: { cwd: tmp, model: "x", maxIterations: 2 },
      }),
      { openAiFactory: factory },
    );
    expect(state.capturedRequests).toHaveLength(2);
    expect(result.exitCode).toBe(0);
  });

  describe("USD cost tracking", () => {
    it("does not call the generation endpoint for a non-OpenRouter baseUrl", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
      vi.stubGlobal("fetch", fetchSpy);
      const { factory } = buildClient([{ content: "ok", usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
      await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" } }),
        { openAiFactory: factory },
      );
      const generationCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
        String(url).includes("openrouter.ai/api/v1/generation"),
      );
      expect(generationCalls).toHaveLength(0);
      const events = readJsonlEvents();
      const result = events.find((e) => e.kind === "result");
      expect(result?.costUsd).toBe(0);
    });

    it("fetches cost and provider for a single-turn OpenRouter run", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { total_cost: 0.001, provider_name: "Anthropic" } }),
        }),
      );
      const { factory } = buildClient([{ content: "done", usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
      await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4" } }),
        { openAiFactory: factory },
      );
      const events = readJsonlEvents();
      const result = events.find((e) => e.kind === "result");
      expect(result?.costUsd).toBeCloseTo(0.001);
    });

    it("sets provider from generation provider_name even when completion has none", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { total_cost: 0.002, provider_name: "Anthropic" } }),
        }),
      );
      const { factory } = buildClient([{ content: "done" }]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4" } }),
        { openAiFactory: factory },
      );
      expect(result.provider).toBe("Anthropic");
    });

    it("sums costs across multiple tool-loop iterations", async () => {
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            ok: true,
            json: async () => ({ data: { total_cost: 0.001 * callCount, provider_name: "Anthropic" } }),
          };
        }),
      );
      await fs.writeFile(path.join(tmp, "note.txt"), "data");
      const { factory } = buildClient([
        {
          toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
        {
          toolCalls: [{ id: "c2", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        },
        { content: "all done", usage: { prompt_tokens: 12, completion_tokens: 6 } },
      ]);
      await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://openrouter.ai/api/v1", model: "x/y" } }),
        { openAiFactory: factory },
      );
      const events = readJsonlEvents();
      const result = events.find((e) => e.kind === "result");
      // 3 completions → 3 fetch calls at 0.001, 0.002, 0.003 → sum = 0.006
      expect(result?.costUsd).toBeCloseTo(0.006);
    });

    it("degrades gracefully when the generation fetch throws a network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
      const { factory } = buildClient([{ content: "ok" }]);
      const result = await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://openrouter.ai/api/v1", model: "x/y" } }),
        { openAiFactory: factory },
      );
      expect(result.exitCode).toBe(0);
      const events = readJsonlEvents();
      const ev = events.find((e) => e.kind === "result");
      expect(ev?.costUsd).toBe(0);
    });

    it("returns costUsd: 0 when generation endpoint responds with non-2xx", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
      const { factory } = buildClient([{ content: "ok" }]);
      await exec(
        buildCtx({ config: { cwd: tmp, baseUrl: "https://openrouter.ai/api/v1", model: "x/y" } }),
        { openAiFactory: factory },
      );
      const events = readJsonlEvents();
      const result = events.find((e) => e.kind === "result");
      expect(result?.costUsd).toBe(0);
    });
  });

  describe("Paperclip API tools and checkout lifecycle", () => {
    function buildCheckoutCtx(checkoutIssue: () => Promise<unknown>) {
      const mockApiInstance = {
        checkoutIssue,
        getIssue: vi.fn().mockResolvedValue({}),
        updateIssue: vi.fn().mockResolvedValue({}),
        listCompanyIssues: vi.fn().mockResolvedValue([]),
        createIssue: vi.fn().mockResolvedValue({}),
        listIssueComments: vi.fn().mockResolvedValue([]),
        addIssueComment: vi.fn().mockResolvedValue({}),
        listCompanyAgents: vi.fn().mockResolvedValue([]),
        hireAgent: vi.fn().mockResolvedValue({}),
        createApproval: vi.fn().mockResolvedValue({}),
      };

      // Inject the mock via the module factory override isn't straightforward,
      // so we provide authToken and mock the PaperclipApi constructor via vi.mock.
      // Instead, we test via a real checkout call with a stubbed global fetch.
      return mockApiInstance;
    }

    it("checkout success — run proceeds normally", async () => {
      // Mock fetch: first call = checkout (POST issues/checkout) succeeds,
      // subsequent fetch calls = generation endpoint (non-2xx, don't care).
      let fetchCallCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        if (String(url).includes("/checkout")) {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, json: async () => ({}) };
      }));

      const { factory } = buildClient([{ content: "done" }]);
      const ctx = buildCtx({
        authToken: "tok-123",
        context: { paperclipWake: { issue: { id: "issue-42", title: "Work" } } },
      });
      const result = await exec(ctx, { openAiFactory: factory });
      expect(result.exitCode).toBe(0);
    });

    it("checkout 409 — execute returns issue_locked without entering tool loop", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes("/checkout")) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "locked" }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }));

      const { factory, state } = buildClient([{ content: "done" }]);
      const ctx = buildCtx({
        authToken: "tok-123",
        context: { paperclipWake: { issue: { id: "issue-locked", title: "Locked" } } },
      });
      const result = await exec(ctx, { openAiFactory: factory });
      expect(result.exitCode).toBe(1);
      expect((result as { errorCode?: string }).errorCode).toBe("issue_locked");
      // The model's completions.create should never have been called
      expect(state.capturedRequests).toHaveLength(0);
    });

    it("no authToken — no checkout attempted, Paperclip tools absent from tool list", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
      vi.stubGlobal("fetch", fetchSpy);

      const { factory, state } = buildClient([{ content: "done" }]);
      const ctx = buildCtx({
        // no authToken
        context: { paperclipWake: { issue: { id: "issue-1", title: "Work" } } },
      });
      const result = await exec(ctx, { openAiFactory: factory });
      expect(result.exitCode).toBe(0);

      const checkoutCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
        String(url).includes("/checkout"),
      );
      expect(checkoutCalls).toHaveLength(0);

      // Tool list should contain only filesystem tools, not Paperclip API tools
      const sentTools = state.capturedRequests[0].tools as Array<{ function: { name: string } }>;
      const names = sentTools.map((t) => t.function.name);
      expect(names).not.toContain("get_issue");
      expect(names).not.toContain("hire_agent");
      expect(names).toContain("read_file");
    });
  });
});
