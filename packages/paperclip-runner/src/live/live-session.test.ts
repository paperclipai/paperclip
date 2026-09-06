import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
} from "../drivers/codex/app-server-transport.js";
import {
  InMemoryCapabilityLiveSessionStore,
  CapabilityLiveSessionService,
  reconcileCapabilityLiveUsage,
  type CapabilityLiveSessionSnapshot,
  type CapabilityLiveSessionStore,
  type CapabilityLiveTransportFactory,
  type CapabilityLiveTurnEvent,
} from "./live-session.js";
import { DurableCapabilityLiveSessionStore } from "./durable-live-session-store.js";
import { defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
import { captureTurnRejection } from "../../test/capture-turn-rejection.js";

class AsyncNotifications implements AsyncIterable<CodexRpcNotification> {
  #values: CodexRpcNotification[] = [];
  #waiters: Array<(value: IteratorResult<CodexRpcNotification>) => void> = [];
  #closed = false;

  push(value: CodexRpcNotification): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface FakeProviderState {
  threadId: string;
  providerSessionId: string;
  nextTurn: number;
  lastToolResult: string;
  transports: FakeCapabilityCodexTransport[];
  turns: Map<string, string>;
  attachments: Array<{ runId: string; turnId: string; itemId: string }>;
  holdAfterTool: boolean;
  closeError: Error | null;
  usageRunDelta: Record<string, unknown> | null;
  onTurnStart?: () => Promise<void>;
  onUsage?: (queue: AsyncNotifications, turnId: string) => void | Promise<void>;
}

class FakeCapabilityCodexTransport implements CodexAppServerTransport {
  readonly notificationsQueue = new AsyncNotifications();
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  #handler: CodexServerRequestHandler = async () => ({});
  #closed = false;
  #activeTurnId: string | null = null;

  constructor(
    readonly state: FakeProviderState,
    readonly onClose: () => void = () => undefined,
  ) {
    state.transports.push(this);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "initialize") return { user: { sessionId: this.state.providerSessionId } };
    if (method === "thread/start") {
      expect(Array.isArray(params.dynamicTools)).toBe(true);
      expect(params.completionContract).toEqual({
        revision: "paperclip-capability-live-v1",
        criterionIds: ["objective"],
      });
      return {
        model: "gpt-eval-test",
        modelProvider: "openai",
        thread: { id: this.state.threadId, sessionId: this.state.providerSessionId },
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: this.state.threadId,
          sessionId: this.state.providerSessionId,
          turns: [...this.state.turns].map(([id, status]) => ({ id, status })),
          tokenUsage: {
            total: {
              inputTokens: this.state.nextTurn * 100,
              cachedInputTokens: this.state.nextTurn * 20,
              outputTokens: this.state.nextTurn * 10,
              reasoningOutputTokens: this.state.nextTurn * 2,
            },
          },
        },
      };
    }
    if (method === "thread/resume") {
      return {
        model: "gpt-eval-test",
        modelProvider: "openai",
        thread: { id: this.state.threadId, sessionId: this.state.providerSessionId },
      };
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.state.nextTurn}`;
      this.#activeTurnId = turnId;
      this.state.turns.set(turnId, "inProgress");
      const input = Array.isArray(params.input) ? params.input[0] as Record<string, unknown> : {};
      const message = String(input.text ?? "");
      await this.state.onTurnStart?.();
      void this.#runTurn(turnId, message);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      const turnId = String(params.turnId);
      this.state.turns.set(turnId, "interrupted");
      this.notificationsQueue.push({
        method: "turn/completed",
        params: { threadId: this.state.threadId, turn: { id: turnId, status: "interrupted" } },
      });
      this.#activeTurnId = null;
      return {};
    }
    throw new Error(`unsupported fake Codex method ${method}`);
  }

  notify(): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.notificationsQueue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  async attachRun(input: { runId: string; turnId: string; itemId: string }): Promise<void> {
    this.state.attachments.push(structuredClone(input));
  }

  invokeServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.#handler(request);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.notificationsQueue.close();
    this.onClose();
    if (this.state.closeError !== null) throw this.state.closeError;
  }

  processInfo() {
    return {
      pid: 4100 + this.state.transports.indexOf(this),
      processGroupId: 4100 + this.state.transports.indexOf(this),
      startedAt: "2026-08-01T00:00:00.000Z",
      exited: this.#closed,
      exitCode: this.#closed ? 0 : null,
      signal: null,
    };
  }

  async #runTurn(turnId: string, message: string): Promise<void> {
    await Promise.resolve();
    this.notificationsQueue.push({
      method: "turn/started",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "inProgress" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let assistantText: string;
    if (message.includes("progress")) {
      const idempotencyKey = message.includes("idempotent")
        ? "progress-governed-once"
        : `progress-${turnId}`;
      const result = await this.#toolCall({
        id: `request-${turnId}`,
        method: "item/tool/call",
        params: {
          threadId: this.state.threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "report_progress",
          arguments: {
            idempotencyKey,
            body: "Progress persisted through the live Codex tool loop.",
          },
        },
      });
      this.state.lastToolResult = String((result.contentItems as Array<Record<string, unknown>>)[0]?.text);
      if (this.state.holdAfterTool) await new Promise<never>(() => undefined);
      assistantText = `The typed result changed my response: ${this.state.lastToolResult}`;
    } else if (message.includes("semantic-interaction-result")) {
      assistantText = `Resumed the same provider thread with ${message}`;
    } else if (message.includes("question")) {
      const result = await this.#toolCall({
        id: `request-${turnId}`,
        method: "item/tool/call",
        params: {
          threadId: this.state.threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "request_human_input",
          arguments: {
            idempotencyKey: `question-${turnId}`,
            interactionKind: "questions",
            title: "Choose the mock path",
            prompt: "Which path should the mock agent take?",
            payload: { fields: [{ id: "path", label: "Path" }] },
            continuationPolicy: "wake_assignee",
          },
        },
      });
      this.state.lastToolResult = String((result.contentItems as Array<Record<string, unknown>>)[0]?.text);
      assistantText = "I created a durable question and will use its typed result when resumed.";
    } else if (message.includes("reference file")) {
      assistantText = "Open [guide.md](guide.md) for the complete notes.";
    } else if (message.includes("long")) {
      return;
    } else {
      assistantText = `Same thread remembers ${this.state.lastToolResult}`;
    }
    this.notificationsQueue.push({
      method: "item/completed",
      params: {
        threadId: this.state.threadId,
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: assistantText },
      },
    });
    this.state.turns.set(turnId, "completed");
    if (this.state.onUsage) {
      await this.state.onUsage(this.notificationsQueue, turnId);
    } else {
      this.notificationsQueue.push({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: this.state.threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: this.state.nextTurn * 100,
              cachedInputTokens: this.state.nextTurn * 20,
              outputTokens: this.state.nextTurn * 10,
              reasoningOutputTokens: this.state.nextTurn * 2,
            },
            ...(this.state.usageRunDelta === null
              ? {}
              : {
                  runDeltaAvailable: true,
                  runDelta: this.state.usageRunDelta,
                }),
          },
        },
      });
      this.notificationsQueue.push({
        method: "turn/completed",
        params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
      });
    }
    this.#activeTurnId = null;
  }

  #toolCall(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.#handler(request);
  }
}

function fakeTransportFactory(state: FakeProviderState): CapabilityLiveTransportFactory {
  return (options) => {
    const evidence = {
      runnerPid: 4100 + state.transports.length,
      runnerProcessGroupId: 4100 + state.transports.length,
      codexPid: 5100 + state.transports.length,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: ["CODEX_HOME", "HOME", "PATH"],
      diagnostics: ["paperclip-runnerd: capability codex proxy started"],
    };
    const transport = new FakeCapabilityCodexTransport(state, () => {
      evidence.runnerExited = true;
      options.onEvidence?.(evidence);
    });
    options.onEvidence?.(evidence);
    return { transport, evidence: () => ({ ...evidence, runnerExited: transport.processInfo().exited }) };
  };
}

function providerState(): FakeProviderState {
  return {
    threadId: "codex-thread-capability",
    providerSessionId: "codex-provider-capability",
    nextTurn: 0,
    lastToolResult: "nothing yet",
    transports: [],
    turns: new Map(),
    attachments: [],
    holdAfterTool: false,
    closeError: null,
    usageRunDelta: null,
  };
}

class TransientFailureLiveSessionStore implements CapabilityLiveSessionStore {
  readonly #delegate = new InMemoryCapabilityLiveSessionStore();
  #failNextSave = false;
  #terminalSaveFailuresRemaining = 0;
  #rejectTerminalSaves = false;
  #terminalSaveFailureCount = 0;

  failNextSave(): void {
    this.#failNextSave = true;
  }

  failNextTerminalSave(count = 1): void {
    this.#terminalSaveFailuresRemaining = count;
  }

  rejectTerminalSaves(): void {
    this.#rejectTerminalSaves = true;
  }

  allowTerminalSaves(): void {
    this.#rejectTerminalSaves = false;
  }

  terminalSaveFailureCount(): number {
    return this.#terminalSaveFailureCount;
  }

  load(sessionId: string): Promise<CapabilityLiveSessionSnapshot | null> {
    return this.#delegate.load(sessionId);
  }

  async save(snapshot: CapabilityLiveSessionSnapshot): Promise<void> {
    if (this.#failNextSave) {
      this.#failNextSave = false;
      throw new Error("transient live-session store failure");
    }
    if (
      snapshot.terminalTurns.length > 0 &&
      (this.#rejectTerminalSaves || this.#terminalSaveFailuresRemaining > 0)
    ) {
      if (this.#terminalSaveFailuresRemaining > 0) {
        this.#terminalSaveFailuresRemaining -= 1;
      }
      this.#terminalSaveFailureCount += 1;
      throw new Error("transient terminal-notification store failure");
    }
    await this.#delegate.save(snapshot);
  }

  delete(sessionId: string): Promise<void> {
    return this.#delegate.delete(sessionId);
  }
}

describe("Capability live runnerd and Codex session", () => {
  it("continues persisting newer snapshots after a transient store failure", async () => {
    const state = providerState();
    const store = new TransientFailureLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-transient-store",
      sessionId: "session-live-transient-store",
    });

    store.failNextSave();
    await expect(session.recordUsage({
      receiptId: "usage-before-recovery",
      inputTokens: 10,
      outputTokens: 2,
    })).rejects.toThrow("transient live-session store failure");
    await expect(session.recordUsage({
      receiptId: "usage-after-recovery",
      inputTokens: 20,
      outputTokens: 4,
    })).resolves.toBe("committed");

    expect((await store.load(session.id))?.usageLedger.map((receipt) => receipt.receiptId)).toEqual([
      "usage-before-recovery",
      "usage-after-recovery",
    ]);
    await service.shutdown(session.id);
  });

  it("rejects a terminal turn until its provider notification is durable", async () => {
    const state = providerState();
    const store = new TransientFailureLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-terminal-store",
      sessionId: "session-live-terminal-store",
    });

    store.failNextTerminalSave();
    await expect(session.sendMessage("finish durably")).rejects.toThrow(
      "transient terminal-notification store failure",
    );

    await vi.waitFor(async () => {
      expect((await store.load(session.id))?.status).toBe("failed");
    });
    expect((await store.load(session.id))?.terminalTurns).toEqual([
      expect.objectContaining({ turnId: "turn-1", status: "completed" }),
    ]);
    await service.shutdown(session.id);
  });

  it("retries an already-failed terminal snapshot when the service shuts down", async () => {
    const state = providerState();
    const store = new TransientFailureLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-terminal-store-retry",
      sessionId: "session-live-terminal-store-retry",
    });

    // Reject every automatic terminal checkpoint, including the provider
    // notification and the pump's best-effort failed-state save. The repaired
    // queue must admit a final shutdown retry once storage recovers.
    store.rejectTerminalSaves();
    await expect(session.sendMessage("finish after consecutive store failures")).rejects.toThrow(
      "transient terminal-notification store failure",
    );
    await vi.waitFor(async () => {
      expect(session.snapshot().status).toBe("failed");
      expect(store.terminalSaveFailureCount()).toBeGreaterThanOrEqual(2);
      expect((await store.load(session.id))?.terminalTurns).toEqual([]);
    });

    store.allowTerminalSaves();
    // The first explicit shutdown retry may still race one transient store
    // failure. Cleanup and the final retry must nevertheless complete.
    store.failNextSave();
    await expect(service.shutdown(session.id)).resolves.toBeUndefined();
    expect(await store.load(session.id)).toMatchObject({
      status: "failed",
      terminalTurns: [
        expect.objectContaining({ turnId: "turn-1", status: "completed" }),
      ],
    });
    expect(state.transports[0]?.processInfo().exited).toBe(true);
  });

  it("preserves cleanup and persistence failures from failed-session shutdown", async () => {
    const state = providerState();
    const store = new TransientFailureLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-shutdown-failures",
      sessionId: "session-live-shutdown-failures",
    });

    store.rejectTerminalSaves();
    await expect(session.sendMessage("fail before shutdown cleanup")).rejects.toThrow(
      "transient terminal-notification store failure",
    );
    await vi.waitFor(() => expect(session.snapshot().status).toBe("failed"));
    const cleanupFailure = new Error("provider cleanup failed");
    state.closeError = cleanupFailure;

    const failure = await service.shutdown(session.id).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(cleanupFailure);
    expect(String((failure as AggregateError).errors[1])).toContain(
      "transient terminal-notification store failure",
    );
    expect(state.transports[0]?.processInfo().exited).toBe(true);
  });

  it("turns an assistant local-file link into a verified dynamic-chat file card record", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-live-file-reference-"));
    await writeFile(join(root, "guide.md"), "# Dynamic guide\n\nVerified by the runner.\n");
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ workingDirectory: root });

    const result = await session.sendMessage("reference file");
    expect(result.snapshot.workspaceFileReferences).toHaveLength(1);
    expect(result.snapshot.workspaceFileReferences?.[0]?.reference).toMatchObject({
      schema: "paperclip.workspace.file_reference.v1",
      source: "runner_verified",
      path: "guide.md",
      preview: null,
      contentDigest: null,
    });
    await service.shutdown(session.id);
  });

  it("records runner-verified file changes for a dynamic chat turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-live-workspace-"));
    await writeFile(join(root, "existing.txt"), "before\n");
    const state = providerState();
    state.onTurnStart = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(join(root, "existing.txt"), "after\n");
      await writeFile(join(root, "created.ts"), "export const created = true;\n");
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ workingDirectory: root });

    const result = await session.sendMessage("edit the workspace");
    expect(result.snapshot.workspaceDiffs).toHaveLength(1);
    expect(result.snapshot.workspaceDiffs?.[0]).toMatchObject({
      turnId: "turn-1",
      diff: {
        schema: "paperclip.workspace.diff.v1",
        source: "runner_verified",
        complete: true,
        totals: { files: 2 },
      },
    });
    expect(result.snapshot.workspaceDiffs?.[0]?.diff.files.map((file) => file.path))
      .toEqual(["created.ts", "existing.txt"]);
    await service.shutdown(session.id);
  });

  it("suspends after every per-turn response and restores the same provider session", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });

    await session.sendMessage("first response");
    expect(session.snapshot()).toMatchObject({ status: "suspended", providerThreadId: state.threadId });
    expect(state.transports[0]?.processInfo().exited).toBe(true);

    await session.sendMessage("restored response");
    expect(state.transports).toHaveLength(2);
    expect(session.snapshot()).toMatchObject({ status: "suspended", providerThreadId: state.threadId });
    await service.shutdown(session.id);
  });

  it("keeps a warm runner through active work and suspends it only after idle expiry", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ lifecyclePolicy: { mode: "warm", idleTimeoutMs: 25 } });

    await session.sendMessage("warm response");
    expect(session.snapshot().status).toBe("warm_idle");
    expect(state.transports[0]?.processInfo().exited).toBe(false);
    await vi.waitFor(() => expect(session.snapshot().status).toBe("suspended"), { timeout: 500 });
    expect(state.transports[0]?.processInfo().exited).toBe(true);

    const active = session.sendMessage("start a long turn");
    await vi.waitFor(() => expect(session.snapshot().activeTurnId).not.toBeNull());
    expect(session.snapshot().status).toBe("running");
    await session.interrupt("test cleanup");
    await expect(active).resolves.toMatchObject({ status: "interrupted" });
    await service.shutdown(session.id);
  });

  it("interrupts pending admission without starting provider work", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } });

    const turn = session.sendMessage("do not admit this turn");
    expect(session.snapshot().transcript).toEqual([
      expect.objectContaining({ role: "user", text: "do not admit this turn" }),
    ]);
    await session.interrupt("cancel during workspace preflight");
    const result = await turn;

    expect(result.status).toBe("interrupted");
    expect(result.snapshot.status).toBe("warm_idle");
    expect(result.snapshot.terminalTurns).toEqual([
      expect.objectContaining({ turnId: result.turnId, status: "interrupted" }),
    ]);
    expect(state.transports[0]?.requests.filter((request) => request.method === "turn/start"))
      .toEqual([]);
    await service.shutdown(session.id);
  });

  it("fails visibly instead of blocking teardown on an unabortable provider start", async () => {
    const state = providerState();
    state.onTurnStart = () => new Promise<void>(() => undefined);
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } });
    const events: CapabilityLiveTurnEvent[] = [];
    session.subscribe((event) => events.push(event));

    const abandonedTurn = session.sendMessage("start a provider request that never returns");
    void abandonedTurn.catch(() => undefined);
    await vi.waitFor(() => {
      expect(state.transports[0]?.requests.some((request) => request.method === "turn/start"))
        .toBe(true);
    });

    await expect(session.suspend("bounded admission teardown")).resolves.toBeUndefined();
    expect(session.snapshot().status).toBe("failed");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("did not stop after transport close"),
      }),
    ]));
    expect(state.transports[0]?.processInfo().exited).toBe(true);
  });

  it("persists the selected provider and passes it to the live runner transport", async () => {
    const state = providerState();
    const providers: Array<string | undefined> = [];
    const permissionModes: Array<string | undefined> = [];
    const baseFactory = fakeTransportFactory(state);
    const service = new CapabilityLiveSessionService({
      transportFactory: (options) => {
        providers.push(options.provider);
        permissionModes.push(options.opencodePermissionMode);
        return baseFactory(options);
      },
    });
    const session = await service.create({
      provider: "opencode",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });

    expect(providers).toEqual(["opencode"]);
    expect(permissionModes).toEqual(["deny"]);
    expect(session.snapshot().config).toMatchObject({
      provider: "opencode",
      driver: "opencode_server",
      providerVersion: "1.18.17",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    await service.shutdown(session.id);
  });

  it("passes caller-supplied native system instructions to the provider", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({
      transportFactory: fakeTransportFactory(state),
      transportOptions: {
        baseInstructions:
          "Native instructions\n\nRead-only instruction sibling root: /runtime/instructions",
      },
    });
    const session = await service.create();

    expect(
      state.transports[0]?.requests.find(
        (request) => request.method === "thread/start",
      )?.params.baseInstructions,
    ).toBe(
      "Native instructions\n\nRead-only instruction sibling root: /runtime/instructions",
    );
    await service.shutdown(session.id);
  });

  it("attributes Claude Managed sessions to the pinned immutable Agent version", async () => {
    const state = providerState();
    const managedProfiles: Array<Record<string, unknown> | undefined> = [];
    const baseFactory = fakeTransportFactory(state);
    const service = new CapabilityLiveSessionService({
      transportFactory: (options) => {
        managedProfiles.push(options.managedProfile);
        return baseFactory(options);
      },
    });
    const session = await service.create({
      provider: "claude_managed",
      requestedModel: "claude-sonnet-5",
      managedProfile: {
        profileId: "managed-profile-1",
        anthropicAgentId: "agent-1",
        agentVersion: "17",
        environmentId: "environment-1",
        betaVersion: "managed-agents-2026-04-01",
        maxSessionListCostUsd: 0.5,
      },
    });

    expect(managedProfiles).toEqual([
      expect.objectContaining({
        agentVersion: "17",
        betaVersion: "managed-agents-2026-04-01",
        model: "claude-sonnet-5",
      }),
    ]);
    expect(session.snapshot().config).toMatchObject({
      provider: "claude_managed",
      driver: "claude_managed_agents_api",
      providerVersion: "17",
      requestedModel: "claude-sonnet-5",
    });
    await service.shutdown(session.id);
  });

  it("opens lazy sessions with core and discovery gateways instead of optional schemas", async () => {
    const state = providerState();
    const claim = "discovery:agents:read";
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({
      runId: "run-live-lazy", sessionId: "session-live-lazy", toolExposure: "lazy",
      capabilities: [claim], explicitClaims: [claim], scenario: { id: "lazy", claims: [claim] },
    });
    const start = state.transports[0]!.requests.find((entry) => entry.method === "thread/start")!;
    const names = (start.params.dynamicTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("get_task_context");
    expect(names).toContain("discover_capabilities");
    expect(names).toContain("invoke_discovered_capability");
    expect(names).not.toContain("list_agents");
    expect(session.snapshot().config.toolExposure).toBe("lazy");
    await service.shutdown(session.id);
  });

  it("keeps discovered invocations correlated to the provider gateway call", async () => {
    const state = providerState();
    const claim = "discovery:agents:read";
    const service = new CapabilityLiveSessionService({
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-lazy-invoke",
      sessionId: "session-live-lazy-invoke",
      toolExposure: "lazy",
      capabilities: [claim],
      explicitClaims: [claim],
      scenario: { id: "lazy-invoke", claims: [claim] },
    });
    let gatewayResult: Record<string, unknown> | null = null;
    state.onTurnStart = async () => {
      const transport = state.transports[0]!;
      const turnId = [...state.turns.keys()].at(-1)!;
      const discovery = await transport.invokeServerRequest({
        id: "request-discover",
        method: "item/tool/call",
        params: {
          threadId: state.threadId,
          turnId,
          callId: "call-discover",
          tool: "discover_capabilities",
          arguments: {
            query: "list company agents",
            namespace: "discovery",
            limit: 10,
          },
        },
      });
      expect(discovery.success).toBe(true);
      const invoked = await transport.invokeServerRequest({
        id: "request-invoke",
        method: "item/tool/call",
        params: {
          threadId: state.threadId,
          turnId,
          callId: "call-invoke",
          tool: "invoke_discovered_capability",
          arguments: { operationId: "list_agents", input: {} },
        },
      });
      gatewayResult = JSON.parse(
        String(
          (invoked.contentItems as Array<Record<string, unknown>>)[0]?.text,
        ),
      ) as Record<string, unknown>;
    };

    await session.sendMessage("Exercise the lazy discovery gateway.");

    expect(gatewayResult).toMatchObject({
      callId: "call-invoke",
      operationId: "invoke_discovered_capability",
      ok: true,
    });
    expect(
      session
        .snapshot()
        .evidence.filter((entry) => entry.kind === "tool_call")
        .map((entry) => entry.data.operationId),
    ).toContain("list_agents");
    await service.shutdown(session.id);
  });

  it("returns typed mock results to the same multi-turn Codex thread without Paperclip network calls", async () => {
    const state = providerState();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({
      runId: "run-live-tool-loop",
      sessionId: "session-live-tool-loop",
      requestedModel: "gpt-5.4-mini-2026-03-17",
    });

    const first = await session.sendMessage("Please report progress on this mock issue.");
    const second = await session.sendMessage("What did the prior tool result say?");

    expect(first.assistantText).toContain("stateRevision");
    expect(second.assistantText).toContain("stateRevision");
    expect(first.snapshot.providerThreadId).toBe(second.snapshot.providerThreadId);
    expect(state.attachments).toHaveLength(1);
    expect(second.snapshot.providerRunBinding).toEqual(state.attachments[0]);
    expect(second.snapshot.usageLedger.slice(-2)).toMatchObject([
      { providerRequests: 1, inputTokens: 100, outputTokens: 10 },
      { providerRequests: 1, inputTokens: 100, outputTokens: 10 },
    ]);
    expect(first.snapshot.providerModel).toEqual({ id: "gpt-eval-test", provider: "openai" });
    expect(first.snapshot.config.requestedModel).toBe("gpt-5.4-mini-2026-03-17");
    expect(
      state.transports[0]?.requests.find((entry) => entry.method === "thread/start")?.params.model,
    ).toBe("gpt-5.4-mini-2026-03-17");
    expect(session.mockState().comments.at(-1)?.body).toBe(
      "Progress persisted through the live Codex tool loop.",
    );
    expect(first.snapshot.evidence.some((entry) => entry.kind === "tool_call")).toBe(true);
    expect(first.snapshot.evidence.some((entry) => entry.kind === "tool_result")).toBe(true);
    expect(first.snapshot.networkEvidence).toEqual({
      realPaperclipRequests: 0,
      childPaperclipEnvironmentKeys: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await service.shutdown(session.id);
  });

  it("streams normalized usage before terminal with cumulative fallback and explicit run deltas", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({
      runId: "run-live-usage-stream",
      sessionId: "session-live-usage-stream",
    });
    const events: CapabilityLiveTurnEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.sendMessage("report cumulative usage");
    state.usageRunDelta = {
      requests: 2,
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 1,
      reasoningTokens: 2,
      providerCostUsd: 0.004,
    };
    await session.sendMessage("report explicit run delta");
    unsubscribe();

    const usageEvents = events.filter(
      (event): event is Extract<CapabilityLiveTurnEvent, { kind: "usage" }> =>
        event.kind === "usage",
    );
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      turnId: "turn-1",
      usage: {
        providerRequests: 1,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        reasoningTokens: 2,
        costNanodollars: 0,
      },
    });
    expect(usageEvents[1]).toMatchObject({
      turnId: "turn-2",
      usage: {
        providerRequests: 2,
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 1,
        reasoningTokens: 2,
        costNanodollars: 4_000_000,
      },
    });
    for (const usageEvent of usageEvents) {
      const usageIndex = events.indexOf(usageEvent);
      const terminalIndex = events.findIndex(
        (event) => event.kind === "terminal" && event.turnId === usageEvent.turnId,
      );
      expect(terminalIndex).toBeGreaterThan(usageIndex);
    }
    await service.shutdown(session.id);
  });

  it("does not add an overlapping token snapshot to raw response usage", async () => {
    const state = providerState();
    state.onUsage = (queue, turnId) => {
      queue.push({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: state.threadId,
          turnId,
          tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } },
        },
      });
      queue.push({
        method: "rawResponse/completed",
        params: {
          threadId: state.threadId,
          turnId,
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      });
      queue.push({
        method: "turn/completed",
        params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
      });
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ runId: "run-overlap-usage", sessionId: "session-overlap-usage" });

    const result = await session.sendMessage("report overlapping usage");

    expect(result.snapshot.usageLedger).toHaveLength(1);
    expect(result.snapshot.usageLedger[0]).toMatchObject({
      providerRequests: 1,
      inputTokens: 100,
      outputTokens: 10,
    });
    await service.shutdown(session.id);
  });

  it("prefers a fresh thread read when a later turn omits usage notifications", async () => {
    const state = providerState();
    state.onUsage = (queue, turnId) => {
      if (state.nextTurn === 1) {
        queue.push({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: state.threadId,
            turnId,
            tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } },
          },
        });
      }
      queue.push({
        method: "turn/completed",
        params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
      });
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ runId: "run-read-fallback", sessionId: "session-read-fallback" });

    await session.sendMessage("report initial usage");
    const second = await session.sendMessage("omit usage notification");

    expect(second.snapshot.usageLedger).toMatchObject([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 100, outputTokens: 10 },
    ]);
    await service.shutdown(session.id);
  });

  it("uses a fresh thread read for a cost-only usage report", async () => {
    const state = providerState();
    state.onUsage = (queue, turnId) => {
      queue.push({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: state.threadId,
          turnId,
          tokenUsage: { total: { requests: 1, providerCostUsd: 0.25 } },
        },
      });
      queue.push({
        method: "turn/completed",
        params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
      });
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ runId: "run-cost-only", sessionId: "session-cost-only" });

    const result = await session.sendMessage("report cost-only usage");

    expect(result.snapshot.usageLedger).toMatchObject([{
      providerRequests: 1,
      inputTokens: 100,
      outputTokens: 10,
      costNanodollars: 250_000_000,
    }]);
    await service.shutdown(session.id);
  });

  it("waits for all bounded late raw response receipts before committing usage", async () => {
    const state = providerState();
    state.onUsage = (queue, turnId) => {
      queue.push({
        method: "rawResponse/completed",
        params: {
          threadId: state.threadId,
          turnId,
          usage: { inputTokens: 40, outputTokens: 4 },
        },
      });
      queue.push({
        method: "turn/completed",
        params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
      });
      setTimeout(() => queue.push({
        method: "rawResponse/completed",
        params: {
          threadId: state.threadId,
          turnId,
          usage: { inputTokens: 60, outputTokens: 6 },
        },
      }), 25);
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ runId: "run-late-usage", sessionId: "session-late-usage" });

    const result = await session.sendMessage("report late usage");

    expect(result.snapshot.usageLedger).toHaveLength(1);
    expect(result.snapshot.usageLedger[0]).toMatchObject({
      providerRequests: 2,
      inputTokens: 100,
      outputTokens: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.snapshot().usageLedger).toEqual(result.snapshot.usageLedger);
    await service.shutdown(session.id);
  });

  it("combines explicit per-turn tokens with cumulative cost", async () => {
    const state = providerState();
    state.onUsage = (queue, turnId) => {
      const firstTurn = state.nextTurn === 1;
      queue.push({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: state.threadId,
          turnId,
          tokenUsage: {
            total: {
              requests: state.nextTurn,
              providerCostUsd: firstTurn ? 0.25 : 0.4,
            },
            runDeltaAvailable: true,
            runDelta: {
              requests: 1,
              inputTokens: firstTurn ? 12 : 7,
              outputTokens: firstTurn ? 4 : 3,
              providerCostUsd: 0,
            },
          },
        },
      });
      queue.push({
        method: "turn/completed",
        params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
      });
    };
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ runId: "run-mixed-usage", sessionId: "session-mixed-usage" });

    await session.sendMessage("report first mixed usage");
    const second = await session.sendMessage("report second mixed usage");

    expect(second.snapshot.usageLedger).toMatchObject([
      {
        providerRequests: 1,
        inputTokens: 12,
        outputTokens: 4,
        costNanodollars: 250_000_000,
      },
      {
        providerRequests: 1,
        inputTokens: 7,
        outputTokens: 3,
        costNanodollars: 150_000_000,
      },
    ]);
    await service.shutdown(session.id);
  });

  it("does not let a settled terminal replay resolve the next turn", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-late-terminal",
      sessionId: "session-live-late-terminal",
    });
    const first = await session.sendMessage("Remember this response.");
    state.onTurnStart = async () => {
      state.transports.at(-1)?.notificationsQueue.push({
        method: "turn/completed",
        params: {
          threadId: state.threadId,
          turn: { id: first.turnId, status: first.status },
        },
      });
      state.onTurnStart = undefined;
    };

    const second = await session.sendMessage("Return the remembered response.");

    expect(second.turnId).not.toBe(first.turnId);
    expect(second.assistantText).toContain("Same thread remembers");
    expect(second.snapshot.terminalTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: first.turnId, status: first.status }),
        expect.objectContaining({ turnId: second.turnId, status: "completed" }),
      ]),
    );
    await service.shutdown(session.id);
  });

  it("restores transcript, mock state, and pending interactions before resuming the same Codex thread", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      runId: "run-live-resume",
      sessionId: "session-live-resume",
      capabilities: ["control_plane:interactions"],
    });
    await first.sendMessage("Ask one structured question.");
    const pending = first.pendingInteractions()[0]!;

    const resumedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.restore(first.id);
    expect(resumed.snapshot().providerThreadId).toBe("codex-thread-capability");
    expect(resumed.pendingInteractions()).toHaveLength(1);
    expect(resumed.snapshot().transcript).toEqual(first.snapshot().transcript);

    const continuation = await resumed.resolveInteraction({
      interactionId: pending.id,
      outcome: "answered",
      result: { path: "safe" },
    });
    expect(continuation.assistantText).toContain("semantic-interaction-result");
    expect(resumed.pendingInteractions()).toHaveLength(0);
    expect(resumed.mockState().interactions[0]?.result).toEqual({ path: "safe" });
    expect(state.transports[1]?.requests.map((entry) => entry.method)).toContain("thread/resume");
    await resumedService.shutdown(resumed.id);
    await firstService.shutdown(first.id);
  });

  it("stops active work and reset archives the prior authority while restoring clean mock state", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-reset",
      sessionId: "session-live-reset",
      provider: "opencode",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    const longTurn = session.sendMessage("Start a long turn.");
    await vi.waitFor(() => expect(session.snapshot().activeTurnId).not.toBeNull());
    await session.interrupt("bounded test interrupt");
    await expect(longTurn).resolves.toMatchObject({ status: "interrupted" });
    await session.sendMessage("Please report progress before reset.");

    const replacement = await service.reset(session.id);
    expect(replacement.id).not.toBe(session.id);
    expect(replacement.snapshot().authority.runId).not.toBe("run-live-reset");
    expect(replacement.mockState().comments).toHaveLength(0);
    expect(replacement.snapshot().authority.active).toBe(true);
    expect(replacement.snapshot().config).toMatchObject({
      provider: "opencode",
      driver: "opencode_server",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(session.snapshot().authority.active).toBe(true);
    expect((await store.load(session.id))?.status).toBe("suspended");
    expect(state.transports[0]?.processInfo().exited).toBe(true);
    const stopped = await service.stop(replacement.id, "bounded test stop");
    expect(stopped.authority.active).toBe(true);
    expect(stopped.process?.runnerExited).toBe(true);
    expect((await store.load(replacement.id))?.status).toBe("suspended");
  });

  it("durably resumes a distinct attempt, preserves partial usage, and deduplicates the semantic effect", async () => {
    const state = providerState();
    const directory = await mkdtemp(join(tmpdir(), "capability-live-durable-"));
    const binding = {
      sessionId: "session-governed-resume",
      runId: "run-governed-resume",
      companyId: "company-1",
      actorId: "actor-1",
      taskId: "task-1",
    };
    const firstStore = new DurableCapabilityLiveSessionStore({ directory, binding });
    const firstService = new CapabilityLiveSessionService({
      store: firstStore,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      ...binding,
      attemptId: "attempt-killed",
      turnTimeoutMs: 500,
    });
    state.holdAfterTool = true;
    const killedTurn = captureTurnRejection(first.sendMessage("Apply idempotent progress once."));
    await vi.waitFor(async () => {
      expect((await firstStore.load(binding.sessionId))?.mockState).toContain(
        "Progress persisted through the live Codex tool loop.",
      );
    });
    await expect(first.recordUsage({
      receiptId: "provider-response-1",
      providerResponseId: "response-1",
      turnId: "turn-1",
      providerCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 1_500,
    })).resolves.toBe("committed");
    await state.transports[0]?.close();
    await expect(killedTurn).resolves.toMatchObject({ message: expect.stringContaining("timed out") });

    // A new service models worker termination: it owns no in-memory session.
    const resumedService = new CapabilityLiveSessionService({
      store: new DurableCapabilityLiveSessionStore({ directory, binding }),
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-resumed",
      resumeOf: "attempt-killed",
    });
    expect(resumed.snapshot().providerThreadId).toBe(state.threadId);
    expect(resumed.snapshot().attempts).toMatchObject([
      { attemptId: "attempt-killed", status: "terminated", failureCode: "worker_terminated" },
      { attemptId: "attempt-resumed", resumeOf: "attempt-killed", status: "running" },
    ]);

    await expect(resumed.reconcileActiveTurn()).resolves.toMatchObject({
      turnId: "turn-1",
      status: "interrupted",
    });
    state.holdAfterTool = false;

    const duplicate = await resumed.sendMessage("Apply idempotent progress once.");
    expect(duplicate.assistantText).toContain('"disposition":"duplicate"');
    expect(resumed.mockState().comments).toHaveLength(1);
    await expect(resumed.recordUsage({
      receiptId: "provider-response-1",
      providerResponseId: "response-1",
      turnId: "turn-1",
      providerCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 1_500,
    })).resolves.toBe("duplicate");
    await resumed.recordUsage({
      receiptId: "provider-response-2",
      providerResponseId: "response-2",
      providerCalls: 1,
      inputTokens: 80,
      outputTokens: 10,
      costNanodollars: 1_000,
    });
    await resumed.completeAttempt("succeeded");

    const final = await firstStore.load(binding.sessionId);
    expect(final?.attempts).toMatchObject([
      { attemptId: "attempt-killed", status: "terminated" },
      { attemptId: "attempt-resumed", status: "succeeded" },
    ]);
    expect(final?.usageLedger).toHaveLength(3);
    expect(final && reconcileCapabilityLiveUsage(final)).toEqual({
      providerCalls: 3,
      providerRequests: 1,
      inputTokens: 280,
      outputTokens: 30,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 2_500,
    });
  });

  it("persists a resumed turnTimeoutMs override so a later resume that omits it keeps the value", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const sessionId = "session-turn-timeout-persists";
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    await firstService.create({
      runId: "run-turn-timeout-persists",
      sessionId,
      attemptId: "attempt-first",
    });

    const secondService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const secondResume = await secondService.resume({
      sessionId,
      attemptId: "attempt-second",
      resumeOf: "attempt-first",
      turnTimeoutMs: 5_000,
    });
    expect(secondResume.snapshot().config.turnTimeoutMs).toBe(5_000);
    expect((await store.load(sessionId))?.config.turnTimeoutMs).toBe(5_000);

    const thirdService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const thirdResume = await thirdService.resume({
      sessionId,
      attemptId: "attempt-third",
      resumeOf: "attempt-second",
    });
    expect(thirdResume.snapshot().config.turnTimeoutMs).toBe(5_000);
    expect((await store.load(sessionId))?.config.turnTimeoutMs).toBe(5_000);
  });

  it("replays only a durable duplicate after restore reconciles the provider turn as interrupted", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      runId: "run-terminal-replay",
      sessionId: "session-terminal-replay",
      attemptId: "attempt-terminal-killed",
      turnTimeoutMs: 50,
    });
    state.holdAfterTool = true;
    const killedTurn = captureTurnRejection(first.sendMessage("Apply idempotent progress once."));
    await vi.waitFor(async () => {
      expect((await store.load(first.id))?.mockState).toContain("progress-governed-once");
    });
    await state.transports[0]!.close();
    await expect(killedTurn).resolves.toMatchObject({ message: expect.stringContaining("timed out") });
    state.turns.set("turn-1", "interrupted");

    const resumedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.resume({
      sessionId: first.id,
      attemptId: "attempt-terminal-resumed",
      resumeOf: "attempt-terminal-killed",
    });
    expect(resumed.snapshot()).toMatchObject({
      activeTurnId: null,
      providerThreadId: state.threadId,
      terminalTurns: [
        {
          turnId: "turn-1",
          status: "interrupted",
          reconciledByAttemptId: "attempt-terminal-resumed",
        },
      ],
    });

    const replay = await state.transports[1]!.invokeServerRequest({
      id: "request-turn-1:deterministic-resume-replay",
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId: "turn-1",
        callId: "call-turn-1:deterministic-resume-replay",
        tool: "report_progress",
        arguments: {
          idempotencyKey: "progress-governed-once",
          body: "Progress persisted through the live Codex tool loop.",
        },
      },
    });
    expect(replay.success).toBe(true);
    expect(String((replay.contentItems as Array<Record<string, unknown>>)[0]?.text)).toContain(
      '\"disposition\":\"duplicate\"',
    );
    expect(resumed.mockState().comments).toHaveLength(1);
    expect(resumed.mockState().idempotency).toHaveLength(1);
    const replayedSnapshot = resumed.snapshot();
    expect(replayedSnapshot.terminalTurns).toEqual([
      expect.objectContaining({ turnId: "turn-1", status: "interrupted" }),
      expect.objectContaining({
        turnId: "turn-1:durable-duplicate-replay",
        status: "completed",
        reconciledByAttemptId: "attempt-terminal-resumed",
      }),
    ]);
    expect(replayedSnapshot.evidence.filter((entry) => entry.kind === "tool_result")).toHaveLength(2);
    const receipts = replayedSnapshot.evidence.filter((entry) => entry.kind === "tool_result");
    expect(receipts.map((entry) => (entry.data.result as Record<string, unknown>).ok)).toEqual([true, true]);
    expect(receipts.map((entry) => (
      ((entry.data.result as Record<string, unknown>).result as Record<string, unknown>).disposition
    ))).toEqual(["applied", "duplicate"]);
    expect(receipts.every((entry) => (
      Number(entry.data.beforeRevision) <= Number(entry.data.afterRevision)
    ))).toBe(true);
    expect(receipts.every((entry) => (
      Number((entry.data.result as Record<string, unknown>).stateRevision)
        === Number(entry.data.afterRevision)
    ))).toBe(true);
    expect(receipts.at(-1)?.data.afterRevision).toBe(resumed.mockState().revision);
    expect(state.transports[1]!.requests.some((request) => request.method === "turn/start")).toBe(false);

    const rejected = await state.transports[1]!.invokeServerRequest({
      id: "request-turn-1:new-key",
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId: "turn-1",
        callId: "call-turn-1:new-key",
        tool: "report_progress",
        arguments: {
          idempotencyKey: "progress-new-effect",
          body: "This effect must not be applied.",
        },
      },
    });
    expect(rejected.success).toBe(false);
    expect(resumed.mockState().comments).toHaveLength(1);
    expect(resumed.mockState().idempotency).toHaveLength(1);
    expect(resumed.snapshot().evidence.filter((entry) => entry.kind === "tool_result")).toHaveLength(2);
    await resumed.completeAttempt("succeeded");
    expect((await store.load(resumed.id))?.attempts).toMatchObject([
      { attemptId: "attempt-terminal-killed", status: "terminated" },
      { attemptId: "attempt-terminal-resumed", status: "succeeded" },
    ]);
    await resumedService.shutdown(resumed.id, "terminal replay test complete");
  });

  it("fails closed for missing, corrupt, mismatched, and provider-drifted checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capability-live-fail-closed-"));
    const binding = {
      sessionId: "session-fail-closed",
      runId: "run-fail-closed",
      companyId: "company-1",
      actorId: "actor-1",
      taskId: "task-1",
    };
    const missingService = new CapabilityLiveSessionService({
      store: new DurableCapabilityLiveSessionStore({ directory, binding }),
      transportFactory: fakeTransportFactory(providerState()),
    });
    await expect(missingService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-missing-resume",
      resumeOf: "attempt-missing",
    })).rejects.toThrow("capability_live_resume_checkpoint_missing");

    const state = providerState();
    const store = new DurableCapabilityLiveSessionStore({ directory, binding });
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    await firstService.create({ ...binding, attemptId: "attempt-original" });
    const mismatched = new DurableCapabilityLiveSessionStore({
      directory,
      binding: { ...binding, taskId: "task-other" },
    });
    await expect(mismatched.load(binding.sessionId)).rejects.toThrow(
      "capability_live_checkpoint_binding_mismatch",
    );

    state.providerSessionId = "codex-provider-drifted";
    const driftedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    await expect(driftedService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-drifted",
      resumeOf: "attempt-original",
    })).rejects.toThrow("capability_live_provider_session_drift");
    expect((await store.load(binding.sessionId))?.attempts?.at(-1)).toMatchObject({
      attemptId: "attempt-drifted",
      status: "failed",
      failureCode: "provider_recovery_failed",
    });

    const checkpointFile = join(directory, `${createHash("sha256").update(binding.sessionId).digest("hex")}.json`);
    const checkpoint = await readFile(checkpointFile, "utf8");
    await writeFile(checkpointFile, checkpoint.replace('"snapshotSha256":"', '"snapshotSha256":"corrupt-'));
    await expect(store.load(binding.sessionId)).rejects.toThrow("capability_live_checkpoint_corrupt");
  });

  it("still asserts a turn-timeout rejection after a delay longer than the turn timeout", async () => {
    const state = providerState();
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({ turnTimeoutMs: 50 });
    state.holdAfterTool = true;
    const heldTurn = captureTurnRejection(session.sendMessage("Apply idempotent progress once."));
    // This delay outlasts turnTimeoutMs, so the rejection settles before this
    // test attaches its own assertion. Vitest fails a file on an unhandled
    // rejection, so this test would fail the file on its own without a
    // handler already attached at the moment the turn promise was created.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(heldTurn).resolves.toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it.skipIf(process.platform === "win32" || !existsSync(defaultCapabilityRunnerdBinary()))(
    "terminates real runnerd after a durable receipt and resumes its exact provider thread",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "capability-live-real-runnerd-"));
      const providerStatePath = join(directory, "provider-state.json");
      const fixture = fileURLToPath(new URL("../../test/fixtures/fake-durable-codex-app-server.mjs", import.meta.url));
      const binding = {
        sessionId: "session-real-runnerd-resume",
        runId: "run-real-runnerd-resume",
        companyId: "company-1",
        actorId: "actor-1",
        taskId: "task-1",
      };
      const store = new DurableCapabilityLiveSessionStore({ directory, binding });
      const transportOptions = {
        codexCommand: process.execPath,
        codexArgs: [fixture, providerStatePath],
        closeGraceMs: 100,
      };
      const firstService = new CapabilityLiveSessionService({ store, transportOptions });
      const first = await firstService.create({
        ...binding,
        workingDirectory: directory,
        attemptId: "attempt-real-killed",
        turnTimeoutMs: 2_000,
      });
      const killedTurn = captureTurnRejection(first.sendMessage("Apply the governed idempotent effect."));
      await vi.waitFor(async () => {
        const checkpoint = await store.load(binding.sessionId);
        expect(checkpoint?.mockState).toContain("One durable governed effect.");
        expect(checkpoint?.activeTurnId).toBe("turn-1");
        expect(checkpoint?.process?.runnerPid).not.toBeNull();
        expect(checkpoint?.process?.codexPid).not.toBeNull();
      });
      await first.recordUsage({
        receiptId: "real-response-1",
        providerResponseId: "fixture-response-1",
        turnId: "turn-1",
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 2,
        costNanodollars: 100,
      });
      const killedCheckpoint = await store.load(binding.sessionId);
      const runnerPid = killedCheckpoint?.process?.runnerPid;
      expect(runnerPid).toBeTypeOf("number");
      process.kill(runnerPid!, "SIGKILL");
      await expect(killedTurn).resolves.toBeInstanceOf(Error);

      const resumedService = new CapabilityLiveSessionService({
        store: new DurableCapabilityLiveSessionStore({ directory, binding }),
        transportOptions,
      });
      const resumed = await resumedService.resume({
        sessionId: binding.sessionId,
        attemptId: "attempt-real-resumed",
        resumeOf: "attempt-real-killed",
        // Smaller than this test's own timeout, so a stalled turn reports
        // which turn stalled instead of surfacing only as a bare test timeout.
        turnTimeoutMs: 10_000,
      });
      expect(resumed.snapshot().providerThreadId).toBe("thread-durable-runnerd");
      const reconciled = await resumed.reconcileActiveTurn();
      if (reconciled === null) throw new Error("checkpointed turn was not reconciled");
      // Recovery may observe the provider's authoritative completion before
      // the controller's interrupt wins the race; either terminal settles the
      // exact checkpointed turn without replaying its governed effect.
      expect(["completed", "interrupted"]).toContain(reconciled.status);
      const duplicate = await resumed.sendMessage("Apply the governed idempotent effect again.");
      expect(duplicate.assistantText).toContain("duplicate");
      expect(resumed.mockState().comments).toHaveLength(1);
      await resumed.completeAttempt("succeeded");
      const final = await store.load(binding.sessionId);
      expect(final?.attempts).toMatchObject([
        { attemptId: "attempt-real-killed", status: "terminated" },
        { attemptId: "attempt-real-resumed", status: "succeeded", resumeOf: "attempt-real-killed" },
      ]);
      expect(final?.usageLedger).toHaveLength(2);
      expect(final?.terminalTurns).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: "turn-1", status: reconciled.status }),
        expect.objectContaining({ turnId: "turn-2", status: "completed" }),
      ]));
      await resumedService.shutdown(resumed.id, "test complete");
    },
    // CI exercises two real process generations here and can exceed the unit default under load.
    30_000,
  );
});
