// Held semantic-tool & late-completion close fencing tests split out of
// runnerd-codex-transport.test.ts so Vitest schedules them in parallel with the
// core transport suite instead of serializing them on one worker.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import {
  createCapabilityRunnerdCodexTransport,
  readRunnerdArtifactBinding,
} from "./runnerd-codex-transport.js";
import {
  defaultCapabilityRunnerdBinary,
  expectTurnStarted,
  fakeCodex,
  fakeCodexArgs,
} from "../../test/support/runnerd-transport.js";

it.each([false, true])("refuses a terminal call decided before earlier results were seen (seen: %s)", async seen => {
  // Restart chaos t03: Codex called write_document, the controller was held,
  // and Codex re-sampled the model until it called paperclip_block. After the
  // reattach the Runner delivered the backlog in order: write_document ran and
  // returned, then the stale block arrived before Codex had seen that result.
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-stale-terminal-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return core = new OriginalCore(options);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
  });
  const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText" as const, text: "{\"blocked\":true}" }] }));
  bundle.transport.setServerRequestHandler(handler);
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const identity = core.store.state.identity;
    let seq = 9000;
    const commit = (eventType: string, payload: Record<string, unknown>) => {
      seq += 1;
      core.store.state.committedEvents.push({ sourceSeq: seq, sourceEventId: `stale-terminal-${seq}`, eventType, priority: 1,
        envelope: { payload: { eventType, turnId: identity.turnId, payload } }, deliveryCount: 1, logicalEffectCount: 1 });
      return `stale-terminal-${seq}`;
    };
    const write = { executionId: "exec-write", transport: "dynamic", name: "write_document" };
    commit("tool.execution.started", { ...write, status: "running" });
    // Paperclip's result, recorded as the controller records it for the Runner.
    core.queueCommand("semantic_tool.result", { callId: "exec-write", operationId: "write_document",
      inputDigest: "sha256:write", result: { created: true }, isError: false }, "command_tool_stale_terminal_write", true);
    if (seen) commit("tool.execution.completed", { ...write, status: "completed" });
    // The terminal call's own event bounds the history (in production its
    // semantic_tool.input event; any later event works the same way).
    const sourceEventId = commit("tool.execution.started", { executionId: "exec-block", transport: "dynamic", name: "paperclip_block", status: "running" });
    const blockInput = { summary: "Paperclip has not returned the save" };
    const outcome = await callbacks.onSemanticToolInput!({ callId: "block-call", operationId: "paperclip_block",
      input: blockInput, sourceEventId, sourceEventType: "semantic_tool.input", correlation: identity });
    if (seen) {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(outcome.isError).not.toBe(true);
    } else {
      expect(handler).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results", retryable: true } } });
      expect(JSON.stringify(outcome.result)).toContain("write_document");
    }
  } finally {
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 20_000);

it("refuses a terminal call that arrives before a held call's result (restart chaos t05)", async () => {
  // Restart chaos t05: Codex called write_document during a K4 hold, then
  // re-sampled until it called paperclip_block. After the reattach the
  // controller recovered the held write while the Runner delivered the block,
  // and the block arrived a few milliseconds before the write's result.
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-held-terminal-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return core = new OriginalCore(options);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
  });
  const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText" as const, text: "{\"blocked\":true}" }] }));
  bundle.transport.setServerRequestHandler(handler);
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const identity = core.store.state.identity;
    let seq = 9100;
    const commit = (eventType: string, payload: Record<string, unknown>) => {
      seq += 1;
      core.store.state.committedEvents.push({ sourceSeq: seq, sourceEventId: `held-terminal-${seq}`, eventType, priority: 1,
        envelope: { payload: { eventType, turnId: identity.turnId, payload } }, deliveryCount: 1, logicalEffectCount: 1 });
      return `held-terminal-${seq}`;
    };
    commit("tool.execution.started", { executionId: "exec-held-write", transport: "dynamic", name: "write_document", status: "running" });
    const sourceEventId = commit("tool.execution.started", { executionId: "exec-held-block", transport: "dynamic", name: "paperclip_block", status: "running" });
    // The recovered write returns just after the block reaches the transport.
    setTimeout(() => core.queueCommand("semantic_tool.result", { callId: "exec-held-write", operationId: "write_document",
      inputDigest: "sha256:write", result: { created: false }, isError: false }, "command_tool_held_terminal_write", true), 100);
    const outcome = await callbacks.onSemanticToolInput!({ callId: "held-block-call", operationId: "paperclip_block",
      input: { summary: "Paperclip has not confirmed the save" }, sourceEventId, sourceEventType: "semantic_tool.input", correlation: identity });
    expect(handler).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results", retryable: true } } });
    expect(JSON.stringify(outcome.result)).toContain("Those calls have now returned");
  } finally {
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 20_000);

it("refuses a finish once for a returned call that never reaches the agent, then accepts the next finish", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-unseen-once-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return core = new OriginalCore(options);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
  });
  const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText" as const, text: "{\"done\":true}" }] }));
  bundle.transport.setServerRequestHandler(handler);
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const identity = core.store.state.identity;
    let seq = 9200;
    const commit = (eventType: string, payload: Record<string, unknown>) => {
      seq += 1;
      core.store.state.committedEvents.push({ sourceSeq: seq, sourceEventId: `unseen-once-${seq}`, eventType, priority: 1,
        envelope: { payload: { eventType, turnId: identity.turnId, payload } }, deliveryCount: 1, logicalEffectCount: 1 });
      return `unseen-once-${seq}`;
    };
    commit("tool.execution.started", { executionId: "exec-search", transport: "dynamic", name: "paperclip_search_assigned_tools", status: "running" });
    core.queueCommand("semantic_tool.result", { callId: "exec-search", operationId: "paperclip_search_assigned_tools",
      inputDigest: "sha256:search", result: { tools: [] }, isError: false }, "command_tool_unseen_once_search", true);
    const finish = (n: number) => {
      const sourceEventId = commit("tool.execution.started", { executionId: `exec-finish-${n}`, transport: "dynamic", name: "paperclip_finish", status: "running" });
      return callbacks.onSemanticToolInput!({ callId: `exec-finish-${n}`, operationId: "paperclip_finish",
        input: { summary: "Done" }, sourceEventId, sourceEventType: "semantic_tool.input", correlation: identity });
    };
    expect(await finish(1)).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results" } } });
    expect(handler).not.toHaveBeenCalled();
    commit("tool.execution.completed", { executionId: "exec-finish-1", transport: "dynamic", name: "paperclip_finish", status: "failed" });
    expect((await finish(2)).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 20_000);

it("answers a held call before starting the next turn (restart chaos t101)", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-held-before-turn-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    return core = new OriginalCore(options);
  });
  const order: string[] = [];
  const recovered = vi.fn(async (call: { callId: string }) => {
    order.push(`recover:${call.callId}`);
    await new Promise<void>((resolveRead) => setTimeout(resolveRead, 300));
    return { result: { success: true, contentItems: [{ type: "inputText", text: "brief body" }] } };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory), stateDirectory, recoverSemanticToolInput: recovered,
  });
  bundle.transport.setServerRequestHandler(vi.fn(async () => ({ success: true, contentItems: [] })));
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: codexSemanticToolSpecs() });
    const identity = core.store.state.identity;
    const correlation = { runId: identity.runId, normalizedSessionId: identity.normalizedSessionId,
      turnId: identity.turnId, itemId: identity.itemId };
    core.store.state.committedEvents.unshift({ sourceSeq: 0, sourceEventId: "held-read-input", eventType: "semantic_tool.input",
      priority: 1, deliveryCount: 1, logicalEffectCount: 1, envelope: { payload: { runId: identity.runId,
        normalizedSessionId: identity.normalizedSessionId, sourceEventId: "held-read-input", eventType: "semantic_tool.input",
        itemId: identity.itemId, payload: { semantic_tool: { callId: "exec-held-read", operationId: "read_document",
          input: { key: "brief" }, correlation } } } } });
    expect(core.semanticToolResultsSettled()).toBe(false);
    const queueCommand = core.queueCommand.bind(core);
    vi.spyOn(core, "queueCommand").mockImplementation((type, ...rest) => {
      order.push(type);
      return queueCommand(type, ...rest);
    });
    const startupPass = core.recoverPendingSemanticInputs();
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
    const turnStarted = expectTurnStarted(bundle.transport.notifications()[Symbol.asyncIterator]());
    void turnStarted.catch(() => undefined);
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Continue after the restart." }] });
    await turnStarted;
    await startupPass;
    expect(recovered).toHaveBeenCalledOnce();
    expect(order.slice(0, 2)).toEqual(["recover:exec-held-read", "semantic_tool.result"]);
    expect(order.indexOf("semantic_tool.result")).toBeLessThan(order.indexOf("turn.start"));
    const result = core.store.state.commands.find(command => command.type === "semantic_tool.result");
    expect(result).toMatchObject({ payload: { callId: "exec-held-read", operationId: "read_document" } });
    expect(result!.status).not.toBe("pending");
  } finally {
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each(["after_budget", "within_budget", "interrupted_within_budget", "persistence_failure"] as const)(
  "fences reusable suspension against late semantic completion (%s)",
  async (mode) => {
    const settles = mode === "within_budget" || mode === "interrupted_within_budget";
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-late-semantic-close-"),
    );
    const checkpoint = vi.fn();
    let core!: DurablePrpControlPlane;
    let entered!: () => void;
    let release!: () => void;
    const handlerEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    const handlerRelease = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      // Exercise a real output suffix around the held semantic callback.
      // The default 96/48-frame stress burst spends seconds on unrelated
      // durable text fsyncs before handler entry, consuming this barrier test's
      // wall-clock budget under the full suite. Stress cases retain defaults.
      codexArgs: mode === "interrupted_within_budget"
        ? fakeCodexArgs(stateDirectory, "--emit-tool-call")
        : fakeCodexArgs(
        stateDirectory, "--split-event-burst",
        "--split-event-prefix-count", "2", "--split-event-suffix-count", "2",
      ),
      stateDirectory,
      // Successful cases use the production close budget for the real
      // semantic-result, stop, drain and suspension round trips. Keep the
      // shorter deadline only for intentionally unfinishable callbacks.
      ...(settles ? {} : { closeGraceMs: 5_000 }),
      controlPlaneRegistration: async (authority) => {
        core = authority;
        await authority.start();
        return { checkpoint, release: () => undefined };
      },
    });
    const handler = vi.fn(async () => {
      entered();
      await handlerRelease;
      return { success: true, contentItems: [] };
    });
    bundle.transport.setServerRequestHandler(handler);
    try {
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      await bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "Read the task." }],
      });
      await Promise.race([
        handlerEntered,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("synthetic semantic handler was not invoked")),
            5_000,
          );
          timer.unref();
        }),
      ]);
      expect(core.semanticToolResultsSettled()).toBe(false);
      if (mode === "persistence_failure") {
        const queue = core.queueCommand.bind(core);
        vi.spyOn(core, "queueCommand").mockImplementation((type, ...args) => {
          if (type === "semantic_tool.result")
            throw new Error("synthetic result journal refused persistence");
          return queue(type, ...args);
        });
      }
      if (mode === "interrupted_within_budget") {
        await bundle.transport.request("turn/interrupt", { reason: "test-stop-during-server-write" });
        expect(core.semanticToolResultsSettled()).toBe(false);
      }
      const closing = bundle.transport.close().then(
        () => null,
        (error: unknown) => error,
      );
      if (mode !== "after_budget") {
        // close() synchronously marks the transport closed before its first
        // await; only now may the already-entered handler finish.
        release();
      }
      const closeFailure = await closing;
      expect(handler).toHaveBeenCalledTimes(1);
      if (!settles) {
        const artifact = readRunnerdArtifactBinding(
          defaultCapabilityRunnerdBinary(),
        );
        const reopened = new DurablePrpControlPlane({
          stateDirectory: join(stateDirectory, "control-plane"),
          identity: core.store.state.identity,
          expectedRunnerVersion: artifact.version,
          expectedRunnerDigest: artifact.digest,
        });
        expect(reopened.semanticToolResultsSettled()).toBe(false);
        await reopened.stop();
      }
      release();
      if (mode === "persistence_failure") {
        expect(core.semanticToolResultsSettled()).toBe(false);
        expect(
          core.store.state.commands.filter(
            (command) => command.type === "semantic_tool.result",
          ),
        ).toEqual([]);
      } else {
        await vi.waitFor(async () => {
          const control = JSON.parse(
            await readFile(
              join(stateDirectory, "control-plane", "control-plane-state.json"),
              "utf8",
            ),
          );
          const late = control.commands.filter(
            (command: { type: string }) =>
              command.type === "semantic_tool.result",
          );
          expect(late).toHaveLength(1);
          expect(late[0].payload.correlation.runId).toBe(
            control.identity.runId,
          );
          expect(late[0].status).toBe(
            settles ? "completed" : "pending",
          );
          if (settles) {
            const results = control.committedEvents.filter(
              (event: { eventType: string }) =>
                event.eventType === "semantic_tool.result",
            );
            expect(results).toHaveLength(1);
            expect(results[0].envelope.runId).toBe(control.identity.runId);
          }
        });
      }
      if (settles) {
        expect(closeFailure).toBeNull();
        expect(core.semanticToolResultsSettled()).toBe(true);
        expect(checkpoint).toHaveBeenCalledWith("settled");
      } else {
        expect(closeFailure).toBeInstanceOf(
          NativeSessionCloseUnrecoverableError,
        );
        expect(closeFailure).toHaveProperty("semanticToolsSettled", false);
        expect(closeFailure).toHaveProperty("settlement.semanticTools.pending", expect.arrayContaining([
          expect.objectContaining({ callId: expect.any(String), operationId: expect.any(String),
            sourceEventId: expect.any(String), inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]));
        expect(checkpoint).toHaveBeenCalledWith("unsettled");
        expect(checkpoint).not.toHaveBeenCalledWith("settled");
      }
    } finally {
      release();
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  25_000,
);
