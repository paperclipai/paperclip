import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterExecutionContext, AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import {
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";

// This file is a characterization test. It pins the engine boundary's CURRENT
// behavior; it never changes production code. Each test states the observed
// contract of `executeAcpxEngine` as data, so a later refactor that alters an
// exit path's result form, its finalization set, or its warm-lane decision
// fails here.
//
// Adapter-boundary automatic CLI fallback note (File 1b): the codex, claude, and
// gemini adapters wrap this engine and fall back to their CLI lane when an
// AUTOMATIC ACP selection fails, but RETHROW when ACP was EXPLICITLY selected.
// Those three adapters live in higher packages that depend on this one, so an
// adapter-utils test cannot import them (a reverse dependency does not exist in
// package.json). That branch already has REAL coverage in each adapter package:
//   - packages/adapters/codex-local/src/server/execute.acp-fallback.test.ts
//   - packages/adapters/claude-local/src/server/execute.acp-fallback.test.ts
//   - packages/adapters/gemini-local/src/server/execute.acp-fallback.test.ts
// and each adapter's `normalizeEngine` / `resolveXxxExecutionEngineForRun`
// classification (explicit acp/cli vs automatic acp) is pinned in each
// package's acp.test.ts. This file pins the engine-level exit paths those
// adapters wrap.

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations (a runner-backed sandbox test
// exercises them end-to-end against a local runner). This lets the staging
// tests assert the exact `runtimeRootDir`/`workspaceLocalDir`/`assets` the
// engine threads without changing any real behavior for the other tests.
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

// A remote sandbox setup that stages the host worktree through the real local
// runner, so a run reaches the post-build window with live bridges and a held
// staging lease.
async function setupRemoteSandbox() {
  const root = await makeTempRoot();
  const stateDir = path.join(root, "state");
  const localCwd = path.join(root, "worktree");
  const remoteCwd = path.join(root, "remote-workspace");
  await fs.mkdir(localCwd, { recursive: true });
  await fs.mkdir(remoteCwd, { recursive: true });
  await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
  const executionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "fake-plugin",
    remoteCwd,
    runner: createLocalSandboxRunner(),
  };
  return { root, stateDir, localCwd, remoteCwd, executionTarget };
}

const okHandle = {
  backendSessionId: "backend-session",
  agentSessionId: "agent-session",
  runtimeSessionName: "runtime-session",
};

function completedTurn() {
  return {
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    cancel: async () => {},
  };
}

function throwingTurn() {
  return {
    events: (async function* () {
      throw new Error("turn upstream boom");
    })(),
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    cancel: async () => {},
  };
}

// A context whose only prompt-read field throws when read, so the prompt build
// fails after the session handshake succeeds and before the turn starts.
function throwingHandoffContext(): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  Object.defineProperty(context, "paperclipSessionHandoffMarkdown", {
    enumerable: false,
    get() {
      throw new Error("prompt build boom");
    },
  });
  return context;
}

// Stub both sandbox bridges with stop spies collected per start, so a test can
// assert the bridges stopped without running the real bridge transport.
function stubBridges() {
  const paperclipStops: Array<ReturnType<typeof vi.fn>> = [];
  const processStops: Array<ReturnType<typeof vi.fn>> = [];
  vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(async () => {
    const stop = vi.fn(async () => {});
    paperclipStops.push(stop);
    return { env: {}, stop } as never;
  });
  vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementation(async () => {
    const stop = vi.fn(async () => {});
    processStops.push(stop);
    return { agentCommand: null, stop } as never;
  });
  const anyStopped = (stops: Array<ReturnType<typeof vi.fn>>) =>
    stops.some((stop) => stop.mock.calls.length > 0);
  const stoppedCount = (stops: Array<ReturnType<typeof vi.fn>>) =>
    stops.filter((stop) => stop.mock.calls.length > 0).length;
  return { paperclipStops, processStops, anyStopped, stoppedCount };
}

function remoteArgs(
  stateDir: string,
  localCwd: string,
  executionTarget: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    agent: { id: "agent-1", companyId: "company-1" },
    runtime: {},
    config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
    context: {},
    authToken: "real-run-jwt",
    executionTarget,
    onLog: async () => {},
    onMeta: async () => {},
    onEvent: async () => {},
    ...overrides,
  };
}

describe("composed ACPX run: engine-boundary result form per exit path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns (never throws) a create_runtime error result when the post-build runtime construction fails", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () => {
        throw new Error("createRuntime boom");
      },
    });

    // The engine RETURNS a settled error result on this path; it does not throw.
    const result = await execute({
      runId: "boundary-create-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(result.resultJson?.phase).toBe("create_runtime");
    expect(result.summary).toContain("createRuntime boom");
  });

  it("returns an ensure_session error result when the handshake fails", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => {
            throw new Error("ensureSession boom");
          },
          startTurn: () => completedTurn(),
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "boundary-ensure-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("ensure_session");
  });

  it("returns a runtime-error result with no clearSession and no errorMeta when ensureSession yields no handle", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          // A runtime that returns no session handle drives the missing-handle path.
          ensureSession: async () => undefined,
          startTurn: () => completedTurn(),
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "boundary-missing-handle",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("ensure_session");
    expect(result.errorCode).toBe("acpx_runtime_error");
    // The missing-handle result carries neither clearSession nor errorMeta, unlike
    // the other pre-turn error paths.
    expect(result.clearSession).toBeUndefined();
    expect(result.errorMeta).toBeUndefined();
  });

  it("returns a configure_session error result that carries the requested session fields", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          // A custom agent with a requested model applies a session config option;
          // a throwing setConfigOption drives the configure_session failure path.
          setConfigOption: async () => {
            throw new Error("setConfigOption boom");
          },
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "boundary-configure-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        model: "custom-model-x",
        stateDir: path.join(root, "state"),
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("configure_session");
    // The configure_session result echoes the requested session identity fields.
    expect(result.resultJson).toHaveProperty("agent");
    expect(result.resultJson?.requestedModel).toBe("custom-model-x");
    expect(result.resultJson).toHaveProperty("requestedThinkingEffort");
    expect(result.resultJson).toHaveProperty("fastMode");
  });

  it("returns a prepare_turn error result when the prompt build fails before the turn starts", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "boundary-prepare-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: throwingHandoffContext(),
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("prepare_turn");
  });

  it("returns a turn error result with acpx_turn_failed when the running turn fails", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "boundary-turn-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("turn");
    expect(result.errorCode).toBe("acpx_turn_failed");
  });

  it("returns the terminal turn-success shape (the one non-error-shaped return)", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
    });

    const result = await execute({
      runId: "boundary-success",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    // A completed, non-timed-out turn returns exitCode 0, no signal, no errorCode,
    // and the session identity fields, with resultJson.status = "completed".
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe(null);
    expect(result.resultJson?.status).toBe("completed");
    expect(result.sessionId).toBe("backend-session");
    expect(result.sessionDisplayId).toBe("agent-session");
    expect(result.sessionParams).toBeTruthy();
  });

  it("THROWS (does not return) when buildRuntime fails before it settles", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    // A staging failure throws inside buildRuntime before it settles, so the engine
    // rethrows through the `if (!buildRuntimeSettled) throw err` guard. This is one
    // of exactly two engine-boundary throw paths.
    vi.mocked(prepareAdapterExecutionTargetRuntime).mockImplementationOnce(async () => {
      throw new Error("staging boom");
    });
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => buildRuntime() as never,
    });

    await expect(
      execute({
        runId: "boundary-build-throw",
        ...remoteArgs(stateDir, localCwd, executionTarget),
      } as never),
    ).rejects.toThrow("staging boom");
  });

  it("THROWS (does not return) on a partial bridge failure and stops the started sibling bridge once", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    // The paperclip bridge fails while the concurrently-started process-session
    // bridge resolves a live handle. This is the second engine-boundary throw path;
    // the abandon path must stop the started sibling so no bridge leaks.
    const stop = vi.fn(async () => {});
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(async () => {
      throw new Error("paperclip bridge boom");
    });
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
      async () => ({ agentCommand: null, stop }) as never,
    );
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => buildRuntime() as never,
    });

    await expect(
      execute({
        runId: "boundary-bridge-throw",
        ...remoteArgs(stateDir, localCwd, executionTarget),
      } as never),
    ).rejects.toThrow("paperclip bridge boom");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("composed ACPX run: finalization set fires exactly once per exit path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops both bridges once and releases the staging lease on every exit path", async () => {
    const scenarios: Array<{
      name: string;
      createRuntime: AcpxEngineExecutorOptions["createRuntime"];
      config?: Record<string, unknown>;
      context?: Record<string, unknown>;
    }> = [
      {
        name: "create_runtime",
        createRuntime: () => {
          throw new Error("createRuntime boom");
        },
      },
      {
        name: "ensure_session",
        createRuntime: () =>
          ({
            ensureSession: async () => {
              throw new Error("ensure boom");
            },
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
      },
      {
        name: "configure_session",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            setConfigOption: async () => {
              throw new Error("config boom");
            },
            close: async () => {},
          }) as never,
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", model: "custom-model-x" },
      },
      {
        name: "prepare_turn",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
        context: throwingHandoffContext(),
      },
      {
        name: "turn",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => throwingTurn(),
            close: async () => {},
          }) as never,
      },
      {
        name: "success",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
      },
    ];

    for (const scenario of scenarios) {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      const { paperclipStops, processStops, stoppedCount } = stubBridges();
      const stagingLocks = new Map<string, Promise<unknown>>();
      const execute = createAcpxEngineExecutor({
        stagingLocks,
        warmHandles: new Map(),
        stagedRuntimes: new Map(),
        createRuntime: scenario.createRuntime,
      });

      const overrides: Record<string, unknown> = {};
      if (scenario.config) {
        overrides.config = {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir,
          cwd: localCwd,
          ...scenario.config,
        };
      }
      if (scenario.context) overrides.context = scenario.context;

      await execute({
        runId: `finalize-${scenario.name}`,
        ...remoteArgs(stateDir, localCwd, executionTarget, overrides),
      } as never).catch(() => {});

      // The finalization set fires exactly once: each bridge stops once and the
      // per-session staging lease releases, so the lock map never strands the next
      // same-session run.
      expect(stoppedCount(paperclipStops), `paperclip bridge must stop once on ${scenario.name}`).toBe(1);
      expect(stoppedCount(processStops), `process-session bridge must stop once on ${scenario.name}`).toBe(1);
      expect(stagingLocks.size, `lease must release on ${scenario.name}`).toBe(0);
    }
  });

  it("does not re-run the turn teardown when the result mapping throws after the close", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { paperclipStops, processStops, stoppedCount } = stubBridges();
    let closeCount = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => ({
            events: (async function* () {
              yield { type: "done", stopReason: "end_turn" };
            })(),
            // A completed turn whose result mapping throws after the close is read.
            result: Promise.resolve({
              status: "completed",
              get stopReason(): string {
                throw new Error("mapping boom");
              },
            }),
            cancel: async () => {},
          }),
          close: async () => {
            closeCount += 1;
          },
        }) as never,
    });

    await execute({
      runId: "finalize-map-throw",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never).catch(() => {});

    // The completed turn closed the runtime once; the mapping throw did not re-run
    // the teardown through the turn catch.
    expect(closeCount).toBe(1);
    expect(stoppedCount(paperclipStops)).toBe(1);
    expect(stoppedCount(processStops)).toBe(1);
  });
});

describe("composed ACPX run: host-lane warm handle set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes and relaunches a persistent local runtime, so the next compatible run re-creates it", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let createCount = 0;
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => {
        createCount += 1;
        return buildRuntime() as never;
      },
    });
    const config = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      mode: "persistent",
      warmHandleIdleMs: 60_000,
    };

    const first = await execute({
      runId: "warm-save-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);
    // Amendment B: a persistent local completed turn closes and relaunches the
    // runtime instead of warm-saving it (the run-minted API key is never revoked).
    expect(warmHandles.size).toBe(0);
    expect(createCount).toBe(1);

    const second = await execute({
      runId: "warm-save-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(second.exitCode).toBe(0);
    // No warm runtime survived, so the compatible second run re-creates it.
    expect(createCount).toBe(2);
  });

  it("closes (does not warm-save) a completed non-persistent runtime, so the next run re-creates", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let createCount = 0;
    let closeCount = 0;
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => {
        createCount += 1;
        return {
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          setConfigOption: async () => {},
          close: async () => {
            closeCount += 1;
          },
        } as never;
      },
    });
    // No persistent mode, so the completed turn closes the runtime instead of
    // warm-saving it.
    const config = { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir };

    const first = await execute({
      runId: "warm-none-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);
    expect(warmHandles.size).toBe(0);
    expect(closeCount).toBe(1);

    const second = await execute({
      runId: "warm-none-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(second.exitCode).toBe(0);
    // No warm handle survived, so the second run constructs a fresh runtime.
    expect(createCount).toBe(2);
  });

  it("runs a fresh acp.handshake on the second run and re-creates the runtime (no warm reuse)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let createCount = 0;
    const warmHandles = new Map();
    const secondEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => {
        createCount += 1;
        return buildRuntime() as never;
      },
    });
    const config = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      mode: "persistent",
      warmHandleIdleMs: 60_000,
    };
    const first = await execute({
      runId: "warm-hit-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    await execute({
      runId: "warm-hit-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: (first as { sessionParams?: unknown }).sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        secondEvents.push(event);
      },
    } as never);

    // Amendment B: the first run closed and relaunched, so no warm handle survives.
    // The second run runs a fresh acp.handshake (outcome ok, not skipped) and
    // re-creates the runtime.
    const handshakeEvents = secondEvents.filter(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "acp.handshake",
    );
    expect(handshakeEvents).toHaveLength(1);
    expect(handshakeEvents[0]!.payload?.outcome).not.toBe("skipped");
    expect(createCount).toBe(2);
  });
});
