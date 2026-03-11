import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginStreamBus } from "../services/plugin-stream-bus.js";
import { findServerAdapter, listAdapterModels, listServerAdapters } from "../adapters/index.js";

vi.mock("../services/companies.js");
vi.mock("../services/issues.js");
vi.mock("../services/activity-log.js");
vi.mock("../services/plugin-registry.js");
vi.mock("../services/plugin-state-store.js");
vi.mock("../services/plugin-secrets-handler.js");
vi.mock("../services/agents.js");
vi.mock("../services/projects.js");
vi.mock("../services/goals.js");
vi.mock("../services/activity.js");
vi.mock("../services/costs.js");
vi.mock("../services/assets.js");
vi.mock("../services/heartbeat.js");
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
  listServerAdapters: vi.fn(),
}));

function createPluginStateDb(): Db {
  const rows = new Map<string, {
    pluginId: string;
    scopeKind: string;
    scopeId: string;
    namespace: string;
    stateKey: string;
    valueJson: Record<string, unknown>;
  }>();

  return {
    insert: vi.fn(() => ({
      values: vi.fn((value: {
        pluginId: string;
        scopeKind: string;
        scopeId: string;
        namespace: string;
        stateKey: string;
        valueJson: Record<string, unknown>;
      }) => ({
        onConflictDoUpdate: vi.fn(async ({ set }: { set: { valueJson: Record<string, unknown> } }) => {
          rows.set(value.stateKey, {
            ...value,
            valueJson: set.valueJson,
          });
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => Array.from(rows.values())),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((updateValue: { valueJson: Record<string, unknown> }) => ({
        where: vi.fn(async () => {
          for (const [key, row] of rows) {
            rows.set(key, { ...row, valueJson: updateValue.valueJson });
          }
        }),
      })),
    })),
  } as unknown as Db;
}

describe("buildHostServices llmSessions", () => {
  const pluginId = "plugin-uuid";
  const pluginKey = "test.plugin";
  let db: Db;
  let eventBus: PluginEventBus;
  let streamBus: PluginStreamBus;
  let notifyWorker: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createPluginStateDb();
    eventBus = {
      forPlugin: vi.fn().mockReturnValue({
        emit: vi.fn(),
      }),
    } as unknown as PluginEventBus;
    streamBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
    };
    notifyWorker = vi.fn();
    vi.clearAllMocks();

    (pluginRegistryService as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      getCompanyAvailability: vi.fn().mockResolvedValue({ available: true }),
      getDisabledCompanyIds: vi.fn().mockResolvedValue(new Set<string>()),
      getConfig: vi.fn().mockResolvedValue(null),
    });
  });

  function streamedChunkCalls() {
    return (streamBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([callPluginId, callChannel, callCompanyId, event]) =>
        callPluginId === pluginId &&
        callChannel === "chat" &&
        callCompanyId === "c1" &&
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "chunk",
    );
  }

  it("only lists adapters that explicitly support direct LLM sessions", async () => {
    (listServerAdapters as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "codex_local", supportsDirectLlmSessions: true, models: [{ id: "gpt-5", label: "GPT-5" }] },
      { type: "openclaw_gateway", supportsDirectLlmSessions: false, models: [{ id: "x", label: "X" }] },
    ]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);

    await expect(services.llmSessions.listProviders()).resolves.toEqual([
      { id: "codex_local", label: "codex_local" },
    ]);
  });

  it("streams Codex agent_message output and avoids Claude-only extra args", async () => {
    const codexNdjsonLine = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hello from codex" },
    });
    const adapter = {
      type: "codex_local",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockImplementation(
        async (opts: {
          config: Record<string, unknown>;
          onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        }) => {
          expect(opts.config.extraArgs).toBeUndefined();
          await opts.onLog("stdout", codexNdjsonLine + "\n");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: "hello from codex",
            sessionParams: { sessionId: "thread-1" },
          };
        },
      ),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "gpt-5", label: "GPT-5" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "codex_local",
      model: "gpt-5",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).resolves.toEqual({ content: "hello from codex" });

    expect(notifyWorker).toHaveBeenCalledWith("llm.sessions.event", expect.objectContaining({
      sessionId: session.sessionId,
      eventType: "chunk",
      chunk: "hello from codex",
    }));
    expect(notifyWorker).toHaveBeenCalledWith("llm.sessions.event", expect.objectContaining({
      sessionId: session.sessionId,
      eventType: "done",
    }));
    // Chunk streamed in real-time via onLog parsing.
    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "chunk", content: "hello from codex" },
      "message",
    );
    // Done published as "message" (not "close") so the EventSource stays alive for multi-turn.
    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "done" },
      "message",
    );
  });

  it("streams wrapped Claude stream_event token deltas before the final assistant event", async () => {
    const claudeStreamEventLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    });
    const claudeAssistantLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hello" }],
      },
    });
    const adapter = {
      type: "claude_local",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockImplementation(
        async (opts: {
          config: Record<string, unknown>;
          onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        }) => {
          expect(opts.config.extraArgs).toEqual(["--include-partial-messages"]);
          await opts.onLog("stdout", `${claudeStreamEventLine}\n`);
          await opts.onLog("stdout", `${claudeAssistantLine}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: "hello",
            sessionParams: { sessionId: "thread-1" },
          };
        },
      ),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "claude-opus-4-6", label: "Claude Opus 4.6" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "claude_local",
      model: "claude-opus-4-6",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).resolves.toEqual({ content: "hello" });

    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "chunk", content: "hello" },
      "message",
    );
    expect(streamedChunkCalls()).toHaveLength(1);
  });

  it("streams Cursor assistant events", async () => {
    const cursorAssistantLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "output_text", text: "hello from cursor" }],
      },
    });
    const adapter = {
      type: "cursor",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockImplementation(
        async (opts: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
          await opts.onLog("stdout", `${cursorAssistantLine}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: "hello from cursor",
            sessionParams: { sessionId: "cursor-thread-1" },
          };
        },
      ),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "gpt-5", label: "GPT-5" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "cursor",
      model: "gpt-5",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).resolves.toEqual({ content: "hello from cursor" });

    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "chunk", content: "hello from cursor" },
      "message",
    );
  });

  it("streams Pi text deltas", async () => {
    const piDeltaLine = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello from pi" },
    });
    const adapter = {
      type: "pi_local",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockImplementation(
        async (opts: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
          await opts.onLog("stdout", `${piDeltaLine}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: "hello from pi",
            sessionParams: { sessionId: "pi-thread-1" },
          };
        },
      ),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "sonnet", label: "Sonnet" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "pi_local",
      model: "sonnet",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).resolves.toEqual({ content: "hello from pi" });

    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "chunk", content: "hello from pi" },
      "message",
    );
  });

  it("streams OpenCode text events", async () => {
    const openCodeTextLine = JSON.stringify({
      type: "text",
      part: { text: "hello from opencode" },
    });
    const adapter = {
      type: "opencode_local",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockImplementation(
        async (opts: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
          await opts.onLog("stdout", `${openCodeTextLine}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            summary: "hello from opencode",
            sessionParams: { sessionId: "opencode-thread-1" },
          };
        },
      ),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "opencode_local",
      model: "anthropic/claude-sonnet-4",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).resolves.toEqual({ content: "hello from opencode" });

    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "chunk", content: "hello from opencode" },
      "message",
    );
  });

  it("rejects failed adapter executions and emits an error event", async () => {
    const adapter = {
      type: "codex_local",
      supportsDirectLlmSessions: true,
      execute: vi.fn().mockResolvedValue({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "adapter failed",
        summary: "",
      }),
    };
    (findServerAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adapter);
    (listAdapterModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "gpt-5", label: "GPT-5" }]);

    const services = buildHostServices(db, pluginId, pluginKey, eventBus, notifyWorker, streamBus);
    const session = await services.llmSessions.create({
      companyId: "c1",
      adapterType: "codex_local",
      model: "gpt-5",
    });

    await expect(
      services.llmSessions.send({
        sessionId: session.sessionId,
        companyId: "c1",
        message: "Say hello",
        streamChannel: "chat",
      }),
    ).rejects.toThrow("adapter failed");

    expect(notifyWorker).toHaveBeenCalledWith("llm.sessions.event", expect.objectContaining({
      sessionId: session.sessionId,
      eventType: "error",
      error: "adapter failed",
    }));
    expect(notifyWorker).not.toHaveBeenCalledWith("llm.sessions.event", expect.objectContaining({
      sessionId: session.sessionId,
      eventType: "done",
    }));
    // Error events published as "message" so the EventSource remains open for inspection.
    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "error", error: "adapter failed" },
      "message",
    );
    expect(streamBus.publish).toHaveBeenCalledWith(
      pluginId,
      "chat",
      "c1",
      { type: "close", error: "adapter failed" },
      "message",
    );
  });
});
