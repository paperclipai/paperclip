import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import {
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations. This mirrors the execute.test.ts
// harness so the turn characterization tests share the same mocked module graph.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(actual.startAdapterExecutionTargetPaperclipBridge),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(actual.startAdapterExecutionTargetProcessSessionBridge),
  };
});
import {
  createAcpxEngineExecutor,
  summarizeAcpxTurnUsage,
  type AcpxEngineExecutorOptions,
} from "./execute.js";
import { runChildProcess } from "../server-utils.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  // A remote run stages a process-session bridge whose detached event writer can
  // still be flushing a trailing event file into `.../process-sessions/<id>/events`
  // when the run's own best-effort `client.remove(sessionDir)` (which production
  // catch-wraps) has already returned. Under CI load that trailing write can land
  // between this recursive delete's directory snapshot and its `rmdir`, surfacing as
  // `ENOTEMPTY`. `maxRetries`/`retryDelay` make the cleanup ride out that window the
  // same way production tolerates it, instead of failing the just-passed test.
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

function createLocalSandboxRunner(
  onExecute?: (input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }) => void,
) {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      onExecute?.(input);
      const command = input.command === "bash" ? "/bin/bash" : input.command;
      return await runChildProcess(`acpx-sandbox-run-${counter}`, command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
}

function buildRuntime(
  onSetConfigOption?: (input: { key: string; value: string }) => void,
  onEnsureSession?: (input: Record<string, unknown>) => void,
) {
  return {
    ensureSession: async (input: Record<string, unknown>) => {
      onEnsureSession?.(input);
      return ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
      });
    },
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    setConfigOption: async (input: { key: string; value: string }) => {
      onSetConfigOption?.(input);
    },
    close: async () => {},
  };
}

async function runExecutor(
  config: Record<string, unknown>,
  options: {
    context?: Record<string, unknown>;
    executionTransport?: Record<string, unknown>;
    authToken?: string;
    executionTarget?: Record<string, unknown>;
    runtimeMcp?: AdapterRuntimeMcpAccess;
    prepareRemoteManagedHome?: AcpxEngineExecutorOptions["prepareRemoteManagedHome"];
    startupTraceContext?: AdapterExecutionContext["startupTraceContext"];
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const configOptions: Array<{ key: string; value: string }> = [];
  const sessionInputs: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const execute = createAcpxEngineExecutor({
    ...(options.prepareRemoteManagedHome
      ? { prepareRemoteManagedHome: options.prepareRemoteManagedHome }
      : {}),
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as Record<string, unknown>);
      return buildRuntime(
        ({ key, value }) => configOptions.push({ key, value }),
        (input) => sessionInputs.push(input),
      ) as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
    },
      runtime: {},
      config,
      context: options.context ?? {},
      executionTransport: options.executionTransport,
      authToken: options.authToken,
      executionTarget: options.executionTarget,
      runtimeMcp: options.runtimeMcp,
      startupTraceContext: options.startupTraceContext,
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
    onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
      events.push(event);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, events, runtimeOptions, configOptions, sessionInputs, result };
}

// A stub ACP runtime that yields a controlled event stream and terminal result.
// The tests supply the events/result/cancel behavior; the harness above only
// drives always-happy sessions, so the turn tests build their own runtime here.
function turnRuntime(input: {
  events: () => AsyncGenerator<Record<string, unknown>>;
  result: Promise<Record<string, unknown>>;
  onStartTurn?: (turnInput: Record<string, unknown>) => void;
  onCancel?: (reason: string) => void;
  onClose?: () => void;
  getStatus?: () => Promise<Record<string, unknown>>;
  onEnsureSession?: (session: Record<string, unknown>) => void;
  ensureSession?: (session: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const runtime: Record<string, unknown> = {
    ensureSession:
      input.ensureSession ??
      (async (session: Record<string, unknown>) => {
        input.onEnsureSession?.(session);
        return {
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        };
      }),
    startTurn: (turnInput: Record<string, unknown>) => {
      input.onStartTurn?.(turnInput);
      return {
        events: input.events(),
        result: input.result,
        cancel: async ({ reason }: { reason: string }) => {
          input.onCancel?.(reason);
        },
      };
    },
    close: async () => {
      input.onClose?.();
    },
  };
  if (input.getStatus) runtime.getStatus = input.getStatus;
  return runtime;
}

describe("ACPX engine turn characterization", () => {
  // The stub session handle every ensureSession returns. startTurn must receive
  // this exact handle object.
  const SESSION_HANDLE = {
    backendSessionId: "backend-session",
    agentSessionId: "agent-session",
    runtimeSessionName: "runtime-session",
  };

  it("passes exactly the six turn inputs to startTurn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let captured: Record<string, unknown> | null = null;
    let metaPrompt = "";

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          onStartTurn: (turnInput) => {
            captured = turnInput;
          },
          events: async function* () {
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });

    const result = await execute({
      runId: "run-six-inputs",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, timeoutSec: 120 },
      context: {},
      onLog: async () => {},
      onMeta: async (payload: { prompt?: string }) => {
        metaPrompt = payload.prompt ?? "";
      },
    } as never);

    expect(result.exitCode).toBe(0);
    const input = captured!;
    // The handle is the exact session handle ensureSession returned.
    expect(input.handle).toEqual(SESSION_HANDLE);
    // The text is the built run prompt, the same string reported to onMeta.
    expect(input.text).toBe(metaPrompt);
    expect(typeof input.text).toBe("string");
    expect((input.text as string).length).toBeGreaterThan(0);
    // The turn always runs in prompt mode.
    expect(input.mode).toBe("prompt");
    // The request id is the run id.
    expect(input.requestId).toBe("run-six-inputs");
    // A positive timeoutSec becomes timeoutMs in milliseconds.
    expect(input.timeoutMs).toBe(120_000);
    // The abort signal is present and not yet aborted.
    const signal = input.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    // Exactly the six documented keys are threaded.
    expect(Object.keys(input).sort()).toEqual(
      ["handle", "mode", "requestId", "signal", "text", "timeoutMs"].sort(),
    );
  });

  it("joins text_delta events into the trimmed result summary", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          events: async function* () {
            yield { type: "text_delta", text: "  Hello, ", stream: "output", tag: "agent_message_chunk" };
            yield { type: "text_delta", text: "world  ", stream: "output", tag: "agent_message_chunk" };
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });

    const result = await execute({
      runId: "run-summary",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    // The summary is the concatenation of the deltas, trimmed.
    expect(result.summary).toBe("Hello, world");
  });

  it("falls back to the stop reason for the summary when no text streams", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          events: async function* () {
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });

    const result = await execute({
      runId: "run-no-text",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    // With no streamed text, the summary is the terminal stop reason.
    expect(result.summary).toBe("end_turn");
  });

  it("pins one event sequence across the log transcript and structured event transports", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          events: async function* () {
            yield { type: "text_delta", text: "streamed hello", stream: "output", tag: "agent_message_chunk" };
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });

    const result = await execute({
      runId: "run-transports",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        events.push(event);
      },
    } as never);

    expect(result.exitCode).toBe(0);
    // Transport 1 — the stdout transcript carries the text_delta as an acpx record.
    expect(logs).toContainEqual({
      stream: "stdout",
      text: `${JSON.stringify({
        type: "acpx.text_delta",
        text: "streamed hello",
        channel: "output",
        tag: "agent_message_chunk",
      })}\n`,
    });
    // The joined text also lands in the result summary.
    expect(result.summary).toBe("streamed hello");
    // Transport 2 — the structured onEvent stream reflects the run bring-up
    // sequence as run.startup.step events, including the acp handshake.
    const steps = events.filter((event) => event.eventType === "run.startup.step");
    const stepNames = steps.map((event) => String(event.payload?.step));
    expect(stepNames).toContain("acp.handshake");
    expect(stepNames).toContain("workspace.resolve");
  });

  it("aborts a hung turn on the wall-clock timer and cancels with the timeout message", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const cancelReasons: string[] = [];
    let releaseTurn: (() => void) | null = null;
    const turnCancelled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          // The stream never yields on its own. Only the wall-clock timer's cancel
          // unblocks it, simulating a hung run.
          events: async function* () {
            await turnCancelled;
          },
          result: turnCancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
          onCancel: (reason) => {
            cancelReasons.push(reason);
            releaseTurn?.();
          },
        }) as never,
    });

    const result = await execute({
      runId: "run-timeout",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 1 },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    const expectedMessage =
      "Run exceeded the adapter execution timeout (timeoutSec=1, configured via adapterConfig.timeoutSec). " +
      "Set adapterConfig.timeoutSec to raise it.";
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorCode).toBe("acpx_timeout");
    expect(result.errorMessage).toBe(expectedMessage);
    // The cancel ran with the formatted timeout message.
    expect(cancelReasons).toContain(expectedMessage);
  }, 15_000);

  it("cancels the turn before closing the runtime when the turn throws", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const order: string[] = [];

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          // The event stream throws mid-turn, so the catch path runs teardown.
          events: async function* () {
            throw new Error("turn boom");
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          onCancel: () => order.push("cancel"),
          onClose: () => order.push("close"),
        }) as never,
    });

    const result = await execute({
      runId: "run-throw",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    // A failure after startTurn returned reports phase "turn".
    expect((result.resultJson as Record<string, unknown>)?.phase).toBe("turn");
    // Cancel runs before close, in that exact order.
    expect(order).toEqual(["cancel", "close"]);
  });

  it("retries the session resume once and never retries the turn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });
    const config = { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd };

    const ensureInputs: Array<Record<string, unknown>> = [];
    let startTurnCalls = 0;
    let resumeLogged = false;

    // A first clean run mints the session params the second run resumes from.
    const firstExecute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          onEnsureSession: (session) => ensureInputs.push(session),
          onStartTurn: () => {
            startTurnCalls += 1;
          },
          events: async function* () {
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });
    const first = await firstExecute({
      runId: "run-resume-a",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);

    // The second run resumes. Its first ensureSession (the resume) fails with a
    // resume-shaped error; the fresh retry (no resumeSessionId) succeeds.
    const secondExecute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          ensureSession: async (session: Record<string, unknown>) => {
            ensureInputs.push(session);
            if (session.resumeSessionId) {
              throw new Error("resume session not found");
            }
            return {
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            };
          },
          onStartTurn: () => {
            startTurnCalls += 1;
          },
          events: async function* () {
            yield { type: "done", stopReason: "end_turn" };
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });
    const second = await secondExecute({
      runId: "run-resume-b",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: (first as { sessionParams?: unknown }).sessionParams },
      config,
      context: {},
      onLog: async (_stream: string, text: string) => {
        if (text.includes("is unavailable; retrying with a fresh session")) resumeLogged = true;
      },
      onMeta: async () => {},
    } as never);

    expect(second.exitCode).toBe(0);
    // The first run's single ensureSession, plus the second run's resume and
    // fresh retry, make three ensureSession calls total; two on the second run.
    expect(ensureInputs).toHaveLength(3);
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
    expect(ensureInputs[2]?.resumeSessionId).toBeUndefined();
    // The turn is never retried: one startTurn per run, two across both runs.
    expect(startTurnCalls).toBe(2);
    // The engine logged the resume fallback.
    expect(resumeLogged).toBe(true);
    // The fresh retry clears the stale session for the caller.
    expect(second.clearSession).toBe(true);
  });

  it("maps a failed terminal to acpx_turn_failed and folds in the reported usage", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          events: async function* () {
            yield {
              type: "status",
              text: "usage",
              tag: "usage_update",
              cost: { amount: 0.31, currency: "USD" },
              breakdown: { inputTokens: 40, outputTokens: 700, cachedReadTokens: 60 },
            };
            yield { type: "done", stopReason: "failed" };
          },
          result: Promise.resolve({ status: "failed", error: new Error("boom") }),
        }) as never,
    });

    const result = await execute({
      runId: "run-failed",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_turn_failed");
    // The failed error message becomes the terminal stop reason and the summary.
    expect(result.summary).toBe("boom");
    expect((result.resultJson as Record<string, unknown>)?.stopReason).toBe("boom");
    // The usage math folds the usage_update event into per-run usage and cost.
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 700, cachedInputTokens: 60 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBeCloseTo(0.31);
  });

  it("computes usage the same way summarizeAcpxTurnUsage does for the event fallback", () => {
    // Pin the exported helper the turn path calls: with no getStatus snapshots the
    // event breakdown and cost drive the per-run usage.
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: null,
      eventBreakdown: { inputTokens: 40, outputTokens: 700, cachedReadTokens: 60 },
      eventCostUsd: 0.31,
    });
    expect(summary.usage).toEqual({ inputTokens: 40, outputTokens: 700, cachedInputTokens: 60 });
    expect(summary.costUsd).toBeCloseTo(0.31);
  });

  it("returns a prepare_turn error result when the prompt build throws", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let startTurnCalls = 0;
    let closes = 0;

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        turnRuntime({
          onStartTurn: () => {
            startTurnCalls += 1;
          },
          onClose: () => {
            closes += 1;
          },
          events: async function* () {},
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        }) as never,
    });

    // A throwing accessor on a field only buildPrompt reads makes the prompt build
    // fail after the session handshake succeeds but before startTurn runs.
    const context: Record<string, unknown> = {};
    Object.defineProperty(context, "paperclipSessionHandoffMarkdown", {
      enumerable: false,
      get() {
        throw new Error("prompt build boom");
      },
    });

    const result = await execute({
      runId: "run-prepare-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context,
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    // The pre-turn failure reports phase "prepare_turn".
    expect((result.resultJson as Record<string, unknown>)?.phase).toBe("prepare_turn");
    // The turn never started, and the runtime closed once.
    expect(startTurnCalls).toBe(0);
    expect(closes).toBe(1);
  });

  it("threads the same happy-path turn through the shared runExecutor harness", async () => {
    // A smoke pin on the copied harness: the always-happy buildRuntime turn exits
    // clean with the done stop reason as the summary.
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const { result } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("end_turn");
  });
});
