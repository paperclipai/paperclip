import { describe, expect, it, vi } from "vitest";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
} from "../drivers/codex/app-server-transport.js";
import {
  InMemoryCapabilityLiveSessionStore,
  CapabilityLiveSessionService,
  type CapabilityLiveTransportFactory,
} from "./live-session.js";

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
      return {
        model: "gpt-eval-test",
        modelProvider: "openai",
        thread: { id: this.state.threadId, sessionId: this.state.providerSessionId },
      };
    }
    if (method === "thread/read") {
      return { thread: { id: this.state.threadId, sessionId: this.state.providerSessionId, turns: [] } };
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
      const input = Array.isArray(params.input) ? params.input[0] as Record<string, unknown> : {};
      const message = String(input.text ?? "");
      void this.#runTurn(turnId, message);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      const turnId = String(params.turnId);
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

  async close(): Promise<void> {
    this.#closed = true;
    this.notificationsQueue.close();
    this.onClose();
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
      const result = await this.#toolCall({
        id: `request-${turnId}`,
        method: "item/tool/call",
        params: {
          threadId: this.state.threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "report_progress",
          arguments: {
            idempotencyKey: `progress-${turnId}`,
            body: "Progress persisted through the live Codex tool loop.",
          },
        },
      });
      this.state.lastToolResult = String((result.contentItems as Array<Record<string, unknown>>)[0]?.text);
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
    this.notificationsQueue.push({
      method: "turn/completed",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
    });
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
  };
}

describe("Capability live runnerd and Codex session", () => {
  it("returns typed mock results to the same multi-turn Codex thread without Paperclip network calls", async () => {
    const state = providerState();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({
      runId: "run-live-tool-loop",
      sessionId: "session-live-tool-loop",
    });

    const first = await session.sendMessage("Please report progress on this mock issue.");
    const second = await session.sendMessage("What did the prior tool result say?");

    expect(first.assistantText).toContain("stateRevision");
    expect(second.assistantText).toContain("stateRevision");
    expect(first.snapshot.providerThreadId).toBe(second.snapshot.providerThreadId);
    expect(first.snapshot.providerModel).toEqual({ id: "gpt-eval-test", provider: "openai" });
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

  it("stops active work and reset rotates authority while restoring clean mock state", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-reset",
      sessionId: "session-live-reset",
    });
    const longTurn = session.sendMessage("Start a long turn.");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await session.interrupt("bounded test interrupt");
    await expect(longTurn).resolves.toMatchObject({ status: "interrupted" });
    await session.sendMessage("Please report progress before reset.");

    const replacement = await service.reset(session.id);
    expect(replacement.id).not.toBe(session.id);
    expect(replacement.snapshot().authority.runId).not.toBe("run-live-reset");
    expect(replacement.mockState().comments).toHaveLength(0);
    expect(replacement.snapshot().authority.active).toBe(true);
    expect(session.snapshot().authority.active).toBe(false);
    expect((await store.load(session.id))).toBeNull();
    expect(state.transports[0]?.processInfo().exited).toBe(true);
    const stopped = await service.stop(replacement.id, "bounded test stop");
    expect(stopped.authority.active).toBe(false);
    expect(stopped.process?.runnerExited).toBe(true);
    expect((await store.load(replacement.id))?.status).toBe("closed");
  });
});
