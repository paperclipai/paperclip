import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runBuilderTurn } from "../services/builder/runner.js";
import {
  _resetBuilderToolExtensions,
  registerBuilderTool,
} from "../services/builder/tool-registry.js";
import type { BuilderTool } from "../services/builder/types.js";
import type { PersistedBuilderMessage } from "../services/builder/session-store.js";

const mockExecuteBuilderTurn = vi.hoisted(() => vi.fn());

vi.mock("../services/builder/adapter-executor.js", () => ({
  executeBuilderTurn: mockExecuteBuilderTurn,
}));

/**
 * Runner tests use an in-memory session store + an injected tool catalog so
 * the orchestration loop can be exercised without Postgres or external HTTP.
 */

const sessionId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function makeStore() {
  const state = {
    messages: [] as PersistedBuilderMessage[],
    totals: { inputTokens: 0, outputTokens: 0, costCents: 0 },
  };
  const store = {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getSessionDetail: vi.fn(),
    listMessages: vi.fn(async (_id: string) => state.messages.slice()),
    createSession: vi.fn(),
    setSessionState: vi.fn(),
    appendMessage: vi.fn(async (
      sId: string,
      cId: string,
      input: {
        role: PersistedBuilderMessage["role"];
        content: PersistedBuilderMessage["content"];
        inputTokens: number;
        outputTokens: number;
        costCents: number;
      },
    ) => {
      const seq = state.messages.length;
      const msg: PersistedBuilderMessage = {
        id: `msg-${seq}`,
        sessionId: sId,
        companyId: cId,
        sequence: seq,
        role: input.role,
        content: input.content,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costCents: input.costCents,
        createdAt: new Date(),
      };
      state.messages.push(msg);
      return msg;
    }),
    applyTotals: vi.fn(async (
      _id: string,
      delta: { inputTokens: number; outputTokens: number; costCents: number },
    ) => {
      state.totals.inputTokens += delta.inputTokens;
      state.totals.outputTokens += delta.outputTokens;
      state.totals.costCents += delta.costCents;
    }),
  };
  return { state, store };
}

function makeCatalog(tools: BuilderTool[]) {
  const map = new Map<string, BuilderTool>();
  for (const tool of tools) map.set(`${tool.source}.${tool.name}`, tool);
  return map;
}

const config = {
  adapterType: "claude_local",
  adapterConfig: {
    model: "gpt-test",
  },
};

afterEach(() => {
  _resetBuilderToolExtensions();
  vi.restoreAllMocks();
});

describe("builder runner", () => {
  it("appends a single assistant message when the model finishes immediately", async () => {
    const { state, store } = makeStore();
    mockExecuteBuilderTurn.mockResolvedValueOnce({
      text: "hello",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4, costCents: 0 },
    });

    const result = await runBuilderTurn({
      db: {} as unknown as Db,
      adapterConfig: config,
      sessionId,
      companyId,
      actor: { type: "user", id: "user-1" },
      store: store as unknown as Parameters<typeof runBuilderTurn>[0]["store"],
      toolCatalog: makeCatalog([]),
    });

    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0].role).toBe("assistant");
    expect(result.newMessages[0].content.text).toBe("hello");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, costCents: 0 });
    expect(result.truncated).toBe(false);
    expect(mockExecuteBuilderTurn).toHaveBeenCalledTimes(1);
    expect(state.totals.inputTokens).toBe(10);
  });

  it("invokes a tool and feeds the result back to the model", async () => {
    const { store } = makeStore();
    const toolRun = vi.fn(async () => ({
      ok: true as const,
      result: { greeting: "hi from tool" },
    }));
    const tool: BuilderTool = {
      name: "say_hi",
      description: "test tool",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "test",
      source: "test_extension",
      run: toolRun,
    };

    mockExecuteBuilderTurn
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "c1", name: "say_hi", arguments: {} }],
        finishReason: "tool_calls",
        usage: { inputTokens: 5, outputTokens: 2, costCents: 0 },
      })
      .mockResolvedValueOnce({
        text: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3, costCents: 0 },
      });

    const result = await runBuilderTurn({
      db: {} as unknown as Db,
      adapterConfig: config,
      sessionId,
      companyId,
      actor: { type: "user", id: "user-1" },
      store: store as unknown as Parameters<typeof runBuilderTurn>[0]["store"],
      toolCatalog: makeCatalog([tool]),
    });

    expect(toolRun).toHaveBeenCalledOnce();
    expect(result.newMessages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result.newMessages[1].content.toolResult?.ok).toBe(true);
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("surfaces an unknown-tool error to the model rather than crashing", async () => {
    const { store } = makeStore();
    mockExecuteBuilderTurn
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "c1", name: "nonexistent_tool", arguments: {} }],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
      })
      .mockResolvedValueOnce({
        text: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
      });

    const result = await runBuilderTurn({
      db: {} as unknown as Db,
      adapterConfig: config,
      sessionId,
      companyId,
      actor: { type: "user", id: "user-1" },
      store: store as unknown as Parameters<typeof runBuilderTurn>[0]["store"],
      toolCatalog: makeCatalog([]),
    });

    const toolMessage = result.newMessages.find((m) => m.role === "tool");
    expect(toolMessage?.content.toolResult?.ok).toBe(false);
    expect(JSON.stringify(toolMessage?.content.toolResult?.result)).toContain("Unknown tool");
  });
});

describe("builder tool registry", () => {
  it("rejects duplicate registrations", () => {
    const tool: BuilderTool = {
      name: "dup",
      description: "",
      parametersSchema: { type: "object" },
      requiresApproval: false,
      capability: "test",
      source: "ext",
      run: async () => ({ ok: true, result: null }),
    };
    registerBuilderTool(tool);
    expect(() => registerBuilderTool(tool)).toThrow(/already registered/);
  });

  it("rejects core source via the extension API", () => {
    const tool: BuilderTool = {
      name: "x",
      description: "",
      parametersSchema: { type: "object" },
      requiresApproval: false,
      capability: "test",
      source: "core",
      run: async () => ({ ok: true, result: null }),
    };
    expect(() => registerBuilderTool(tool)).toThrow(/Core builder tools/);
  });
});
