import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAdapterModel,
  encodeAdapterModel,
  getProviderForModel,
  type AdapterTurnContext,
} from "../services/chat-providers.js";

describe("AdapterExecuteProvider", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("encodes/decodes adapter model ids round-trip", () => {
    const encoded = encodeAdapterModel("claude_local", "claude-opus-4-7");
    expect(encoded).toBe("adapter:claude_local:claude-opus-4-7");
    const decoded = decodeAdapterModel(encoded);
    expect(decoded).toEqual({ adapterType: "claude_local", modelId: "claude-opus-4-7" });
  });

  it("decodeAdapterModel returns null for non-adapter ids", () => {
    expect(decodeAdapterModel("claude-opus-4-7")).toBeNull();
    expect(decodeAdapterModel("adapter:")).toBeNull();
    expect(decodeAdapterModel("adapter:onlytype")).toBeNull();
  });

  it("getProviderForModel routes adapter:* to the AdapterExecuteProvider", () => {
    const provider = getProviderForModel("adapter:claude_local:claude-opus-4-7");
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("adapter");
  });

  it("getProviderForModel routes bare claude-* to AnthropicProvider (not adapter)", () => {
    const provider = getProviderForModel("claude-opus-4-7");
    expect(provider?.name).toBe("anthropic");
  });

  it("AdapterExecuteProvider streams text via onLog and persists sessionParams", async () => {
    const fakeAdapter = {
      type: "claude_local",
      models: [],
      async execute(ctx: {
        runtime: { sessionParams: Record<string, unknown> | null; sessionId: string | null };
        context: Record<string, unknown>;
        onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }) {
        // Emit two stream-json assistant events as claude-local would.
        const event1 = JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello " }] },
        });
        const event2 = JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "world." }] },
        });
        await ctx.onLog("stdout", event1 + "\n");
        await ctx.onLog("stdout", event2 + "\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionParams: { sessionId: "claude-session-xyz", cwd: "/tmp/clippy" },
        };
      },
    };

    vi.doMock("../adapters/registry.js", () => ({
      findActiveServerAdapter: () => fakeAdapter,
      listEnabledServerAdapters: () => [fakeAdapter],
      listAdapterModels: async () => [{ id: "claude-opus-4-7", label: "Claude Opus 4.7" }],
    }));

    const { getProviderForModel: freshGetProvider } = await import("../services/chat-providers.js");
    const provider = freshGetProvider(encodeAdapterModel("claude_local", "claude-opus-4-7"));
    expect(provider).not.toBeNull();

    let savedParams: Record<string, unknown> | null = null;
    const ctx: AdapterTurnContext = {
      sessionId: "test-session",
      companyId: null,
      boardUserId: "u1",
      prevSessionParams: null,
      saveSessionParams: async (params) => {
        savedParams = params;
      },
    };

    const stream = provider!.streamTurn({
      model: encodeAdapterModel("claude_local", "claude-opus-4-7"),
      system: "You are Clippy",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      adapterContext: ctx,
    });

    const deltas: string[] = [];
    let result;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        result = next.value;
        break;
      }
      if (next.value.type === "text_delta") deltas.push(next.value.delta);
    }

    expect(deltas.join("")).toBe("Hello world.");
    expect(result.content).toEqual([{ type: "text", text: "Hello world." }]);
    expect(result.stopReason).toBe("end_turn");
    expect(savedParams).toEqual({ sessionId: "claude-session-xyz", cwd: "/tmp/clippy" });
  });

  it("AdapterExecuteProvider raises a clear error when adapterContext is missing", async () => {
    const provider = getProviderForModel(encodeAdapterModel("claude_local", "claude-opus-4-7"));
    expect(provider).not.toBeNull();
    const stream = provider!.streamTurn({
      model: encodeAdapterModel("claude_local", "claude-opus-4-7"),
      system: "",
      messages: [],
    });
    await expect(stream.next()).rejects.toThrow(/adapterContext/);
  });

  it("AdapterExecuteProvider raises if the adapter type isn't registered", async () => {
    vi.doMock("../adapters/registry.js", () => ({
      findActiveServerAdapter: () => null,
      listEnabledServerAdapters: () => [],
      listAdapterModels: async () => [],
    }));
    const { getProviderForModel: freshGetProvider } = await import("../services/chat-providers.js");
    const provider = freshGetProvider(encodeAdapterModel("nonexistent", "any"));
    const ctx: AdapterTurnContext = {
      sessionId: "s",
      companyId: null,
      boardUserId: "u",
      prevSessionParams: null,
      saveSessionParams: async () => {},
    };
    const stream = provider!.streamTurn({
      model: encodeAdapterModel("nonexistent", "any"),
      system: "",
      messages: [],
      adapterContext: ctx,
    });
    await expect(stream.next()).rejects.toThrow(/not registered/);
  });
});
