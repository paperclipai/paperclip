// Characterization baselines for ACP run settlement/teardown. These tests PIN
// the current behavior of the engine's teardown orchestration (Layer A), the
// `restoreWorkspace` internal order plus native-sync selection (Layer B), and
// the per-adapter sync-back registration seam (Layer C). They never change
// production code; each expectation records what the code does today.
//
// The harness top (imports, the execution-target mock, `makeTempRoot`, the local
// sandbox runner, `buildRuntime`, `runExecutor`) is copied from
// `execute.test.ts` (lines 1-336) so this file drives the same engine the same
// way. The teardown helpers (`stubBridges`, `throwingHandoffContext`,
// `completedTurn`, `throwingTurn`, `setupRemoteSandbox`, `remoteArgs`) mirror the
// F2/F3 describes in `execute.test.ts` (~:2602, ~:4858).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import {
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations. A runner-backed sandbox test
// exercises them end-to-end against a local runner, while a teardown test can
// override just the bridges with stop spies. (Copied from execute.test.ts.)
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
import {
  mirrorDirectory,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "../sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);
const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
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
      return {
        backendSessionId: "backend-session",
        agentSessionId: "agent-session",
        runtimeSessionName: "runtime-session",
      };
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
    createRuntime: (createOptions) => {
      runtimeOptions.push(createOptions as unknown as Record<string, unknown>);
      return buildRuntime(
        ({ key, value }) => configOptions.push({ key, value }),
        (input) => sessionInputs.push(input),
      ) as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1" },
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

// ---------------------------------------------------------------------------
// Shared teardown-test helpers (mirror execute.test.ts F3 describe, ~:4858).
// ---------------------------------------------------------------------------

const okHandle = {
  backendSessionId: "backend-session",
  agentSessionId: "agent-session",
  runtimeSessionName: "runtime-session",
};

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
  return { paperclipStops, processStops, anyStopped };
}

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

// ===========================================================================
// Layer A — engine teardown orchestration.
// ===========================================================================
describe("ACP settlement — Layer A: engine teardown orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("test_clean_completed_remote_teardown_runs_bridge_stop_then_sync_back_then_lease_release", async () => {
    // cleanupRemoteBridges (execute.ts:2306-2326) fixes the sub-order for a clean
    // exit: stop both bridges (allSettled) → run the managed-home sync-back
    // (remoteManagedHomeTeardown) → release the per-session staging lease LAST in
    // a finally. Record the order through spies threaded into the stubbed bridges
    // and the seam teardown, and read the still-held lease during the sync-back.
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const order: string[] = [];
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(async () => ({
      env: {},
      stop: vi.fn(async () => {
        order.push("bridge-stop");
      }),
    }) as never);
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementation(async () => ({
      agentCommand: null,
      stop: vi.fn(async () => {
        order.push("bridge-stop");
      }),
    }) as never);

    const stagingLocks = new Map<string, Promise<unknown>>();
    let leaseSizeDuringSyncBack = -1;
    const execute = createAcpxEngineExecutor({
      stagingLocks,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          close: vi.fn(async () => {}),
        }) as never,
      prepareRemoteManagedHome: async (input) => {
        const stagedRuntime = await input.stage([]);
        return {
          stagedRuntime,
          teardown: async () => {
            order.push("sync-back");
            // The lease is still held while the sync-back runs; it releases only
            // afterward, in the cleanupRemoteBridges finally.
            leaseSizeDuringSyncBack = stagingLocks.size;
            return { ok: true };
          },
        };
      },
    });

    const result = await execute({
      runId: "clean-order",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(0);
    // Both bridge stops precede the sync-back; the sync-back is the last recorded
    // step before the lease release.
    expect(order).toEqual(["bridge-stop", "bridge-stop", "sync-back"]);
    // The lease was still held during the sync-back...
    expect(leaseSizeDuringSyncBack).toBe(1);
    // ...and released last, so the lock map never strands the next run.
    expect(stagingLocks.size).toBe(0);
  });

  it("test_clean_persistent_local_run_closes_and_relaunches_amendment_b", async () => {
    // Amendment B: a clean persistent local turn closes the runtime instead of
    // warm-saving it. The host-lane reuse candidate carries the run-minted API key,
    // which is never revoked, so the credential gate fails and the settlement
    // discards (close-and-relaunch).
    const root = await makeTempRoot();
    const closeSpy = vi.fn(async () => {});
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          setConfigOption: async () => {},
          close: closeSpy,
        }) as never,
    });

    const result = await execute({
      runId: "warm-save",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        mode: "persistent",
        // A long idle window so the scheduled cleanup timer cannot fire during the
        // assertions and evict the warm handle. The warm-save decision only needs
        // warmIdleMs>0. The test clears the timer below, so it never outlives the
        // test.
        warmHandleIdleMs: 60_000,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    // The runtime closed and relaunched: one close, no warm entry.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(warmHandles.size).toBe(0);
  });

  it("test_completed_non_persistent_local_run_closes_runtime_once", async () => {
    // The default (non-persistent) completed turn closes the runtime with the
    // clean-completion reason (execute.ts:3922-3926).
    const root = await makeTempRoot();
    const closeSpy = vi.fn(async () => {});
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          close: closeSpy,
        }) as never,
    });

    const result = await execute({
      runId: "clean-close",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((closeSpy.mock.calls[0]! as unknown[])[0]).toMatchObject({
      reason: "paperclip completed turn cleanup",
      discardPersistentState: false,
    });
  });

  it("test_pre_turn_failure_after_handle_closes_runtime_except_create_runtime", async () => {
    // Once a runtime handle exists, every pre-turn failure closes the runtime —
    // missing handle (execute.ts:3633, synthesized handle), configure_session
    // (:3716), prepare_turn (:4016) — EXCEPT create_runtime, where no runtime was
    // ever constructed (:3662-3697). Each path returns a settled error with its
    // phase. (The handshake close path needs a handle obtained first via the warm
    // hit — pinned separately below, mirroring the F2 test.)
    const scenarios: Array<{
      name: string;
      phase: string;
      expectClose: boolean;
      // Builds the engine `createRuntime` given the shared close spy. The
      // create_runtime scenario ignores the spy and throws before a runtime exists.
      makeCreateRuntime: (close: () => Promise<void>) => AcpxEngineExecutorOptions["createRuntime"];
      config: Record<string, unknown>;
      context: Record<string, unknown>;
    }> = [
      {
        name: "missing_handle",
        phase: "ensure_session",
        expectClose: true,
        makeCreateRuntime: (close) => () =>
          ({
            ensureSession: async () => undefined,
            startTurn: () => completedTurn(),
            close,
          }) as never,
        config: {},
        context: {},
      },
      {
        name: "configure_session",
        phase: "configure_session",
        expectClose: true,
        makeCreateRuntime: (close) => () =>
          ({
            ensureSession: async () => okHandle,
            // A configured model on a non-claude/non-codex agent yields one session
            // config option; a throwing setConfigOption drives the configure failure.
            setConfigOption: async () => {
              throw new Error("config boom");
            },
            startTurn: () => completedTurn(),
            close,
          }) as never,
        config: { model: "custom-model-x" },
        context: {},
      },
      {
        name: "prepare_turn",
        phase: "prepare_turn",
        expectClose: true,
        makeCreateRuntime: (close) => () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            close,
          }) as never,
        config: {},
        context: throwingHandoffContext(),
      },
      {
        name: "create_runtime",
        phase: "create_runtime",
        expectClose: false,
        makeCreateRuntime: () => () => {
          throw new Error("createRuntime boom");
        },
        config: {},
        context: {},
      },
    ];

    for (const scenario of scenarios) {
      const root = await makeTempRoot();
      const closeSpy = vi.fn(async () => {});
      const execute = createAcpxEngineExecutor({
        createRuntime: scenario.makeCreateRuntime(closeSpy),
      });

      const result = await execute({
        runId: `preturn-${scenario.name}`,
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          ...scenario.config,
        },
        context: scenario.context,
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode, `${scenario.name} exit`).toBe(1);
      expect(result.resultJson?.phase, `${scenario.name} phase`).toBe(scenario.phase);
      if (scenario.expectClose) {
        expect(closeSpy, `${scenario.name} closes the runtime`).toHaveBeenCalledTimes(1);
      } else {
        // create_runtime failed before a runtime existed, so there is nothing to close.
        expect(closeSpy, `${scenario.name} never constructs a runtime`).not.toHaveBeenCalled();
      }
    }
  });

  it("test_handshake_failure_on_second_run_closes_the_recreated_runtime", async () => {
    // Amendment B: the first clean persistent turn closes and relaunches instead of
    // warm-saving, so the second run finds no warm handle. The second run re-creates
    // the runtime and fails while persisting process identity (onSpawn throws); the
    // handshake failure closes the re-created runtime. The host-lane warm-hit
    // teardown path itself is characterized by the composed fault matrix.
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const startedAt = "2026-01-01T00:00:00.000Z";
    const closeSpy = vi.fn(async () => {});
    let created = 0;
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        created += 1;
        const opts = options as {
          onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
        };
        return {
          ensureSession: async () => {
            await opts.onAgentSpawn?.({ pid: 4242, startedAt });
            return okHandle;
          },
          startTurn: () => completedTurn(),
          close: closeSpy,
        } as never;
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
      runId: "warm-handshake-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);
    // Amendment B: no warm entry survives the first clean persistent turn.
    expect(warmHandles.size).toBe(0);
    expect(created).toBe(1);

    const second = await execute({
      runId: "warm-handshake-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {
        throw new Error("onSpawn boom");
      },
    } as never);

    // The second run re-created the runtime (no warm reuse) and closed it on the
    // failure, reporting the ensure_session phase. Both runtimes closed.
    expect(created).toBe(2);
    expect(second.exitCode).toBe(1);
    expect(second.resultJson?.phase).toBe("ensure_session");
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(warmHandles.size).toBe(0);
  });

  it("test_terminal_close_reason_and_discard_persistent_state_per_outcome", async () => {
    // The terminal block (execute.ts:3869-3928) closes with an outcome-specific
    // reason and discards persistent state only on cancel/timeout.
    const cases: Array<{
      status: "completed" | "failed" | "cancelled";
      reason: string;
      discard: boolean;
      exitCode: number;
    }> = [
      { status: "completed", reason: "paperclip completed turn cleanup", discard: false, exitCode: 0 },
      { status: "failed", reason: "paperclip turn failed", discard: false, exitCode: 1 },
      { status: "cancelled", reason: "paperclip turn cancelled", discard: true, exitCode: 1 },
    ];

    for (const testCase of cases) {
      const root = await makeTempRoot();
      const closeSpy = vi.fn(async () => {});
      const execute = createAcpxEngineExecutor({
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => ({
              events: (async function* () {
                yield { type: "done", stopReason: "end_turn" };
              })(),
              result:
                testCase.status === "failed"
                  ? Promise.resolve({ status: "failed", error: new Error("turn boom") })
                  : testCase.status === "cancelled"
                    ? Promise.resolve({ status: "cancelled", stopReason: "cancelled" })
                    : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
              cancel: async () => {},
            }),
            close: closeSpy,
          }) as never,
      });

      const result = await execute({
        runId: `terminal-${testCase.status}`,
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode, `${testCase.status} exit`).toBe(testCase.exitCode);
      expect(closeSpy, `${testCase.status} closes once`).toHaveBeenCalledTimes(1);
      expect((closeSpy.mock.calls[0]! as unknown[])[0], `${testCase.status} close args`).toMatchObject({
        reason: testCase.reason,
        discardPersistentState: testCase.discard,
      });
    }
  });

  it("test_teardown_continues_after_one_step_fails_and_records_it", async () => {
    // Corrected F3 policy (execute.ts:3374-3393): a failing teardown step is
    // recorded and swallowed; later steps still run and the lease still releases.
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { paperclipStops, processStops, anyStopped } = stubBridges();
    const stagingLocks = new Map<string, Promise<unknown>>();
    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      stagingLocks,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {
            throw new Error("close boom");
          },
        }) as never,
    });

    const result = await execute({
      runId: "td-continue",
      ...remoteArgs(stateDir, localCwd, executionTarget, {
        onLog: async (stream: "stdout" | "stderr", text: string) => {
          logs.push({ stream, text });
        },
      }),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(anyStopped(paperclipStops)).toBe(true);
    expect(anyStopped(processStops)).toBe(true);
    expect(stagingLocks.size).toBe(0);
    expect(
      logs.some(
        (entry) =>
          entry.stream === "stderr" && entry.text.includes('teardown step "runtime-close" failed'),
      ),
    ).toBe(true);
  });

  it("test_teardown_failure_does_not_change_external_result", async () => {
    // A teardown fault never leaks into the external result; the exit cause (the
    // turn failure) stands (execute.ts F3 policy).
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {
            throw new Error("close boom");
          },
        }) as never,
    });

    const result = await execute({
      runId: "td-result",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("turn");
    expect(result.errorCode).toBe("acpx_turn_failed");
    expect(result.errorMessage).toContain("turn upstream boom");
    expect(result.errorMessage).not.toContain("close boom");
  });
});

// ===========================================================================
// Layer B — restoreWorkspace internal order + native-sync selection.
// ===========================================================================

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// A filesystem-backed managed-runtime client with the non-native base64-tar
// FALLBACK `syncIn` (mirrors sandbox-managed-runtime.test.ts `makeFilesystemClient`
// / `attachFallbackSyncIn`). `runCommands` records every `run` so a test can prove
// which restore transfer path the orchestrator took. When `withNativeSyncOut` is
// set, a native `syncOut` is attached so the client advertises BOTH directions.
function makeFsClient(options: {
  runCommands?: string[];
  syncOutCalls?: { count: number };
  withNativeSyncOut?: boolean;
}): SandboxManagedRuntimeClient {
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => {
      await fs.mkdir(remotePath, { recursive: true });
    },
    writeFile: async (remotePath, bytes) => {
      await fs.mkdir(path.dirname(remotePath), { recursive: true });
      await fs.writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await fs.readFile(remotePath),
    listFiles: async (remotePath) => {
      const entries = await fs.readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    },
    remove: async (remotePath) => {
      await fs.rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      options.runCommands?.push(command);
      await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
    },
  };
  client.syncIn = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
    const resultOperations: SandboxSyncResult["operations"] = [];
    for (const operation of operations) {
      let filesTransferred = 0;
      let bytesTransferred = 0;
      for (const mapping of operation.files) {
        const bytes = await fs.readFile(mapping.sourcePath);
        await client.makeDir(path.posix.dirname(mapping.targetPath));
        await client.writeFile(mapping.targetPath, toArrayBuffer(bytes));
        filesTransferred += 1;
        bytesTransferred += bytes.byteLength;
      }
      for (const command of operation.postUploadCommands ?? []) {
        await client.run(command.command, { timeoutMs: command.timeoutMs ?? 30_000 });
      }
      resultOperations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
    }
    return { operations: resultOperations };
  };
  if (options.withNativeSyncOut) {
    // Native outbound: materialize the sandbox workspace tree directly into the
    // host destination (a directory file mapping), never through the tarball run.
    client.syncOut = async (operations: SandboxSyncOperation[]): Promise<SandboxSyncResult> => {
      if (options.syncOutCalls) options.syncOutCalls.count += 1;
      const resultOperations: SandboxSyncResult["operations"] = [];
      for (const operation of operations) {
        for (const mapping of operation.files) {
          await fs.mkdir(mapping.targetPath, { recursive: true });
          await mirrorDirectory(mapping.sourcePath, mapping.targetPath);
        }
        resultOperations.push({ operationId: operation.operationId, filesTransferred: 1, bytesTransferred: 0 });
      }
      return { operations: resultOperations };
    };
  }
  return client;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

describe("ACP settlement — Layer B: restoreWorkspace order + native-sync selection", () => {
  it("test_non_git_workspace_restore_phase_order_and_preserve_absent_via_tarball_fallback", async () => {
    // Model on sandbox-managed-runtime.test.ts "syncs workspace and assets through
    // a provider-neutral sandbox client" (~:342). A client that exposes only the
    // fallback `syncIn` (no `syncOut`) drives the remote-tarball restore transfer
    // (sandbox-managed-runtime.ts:1192-1218) and the finalize ordering.
    const root = await makeTempRoot();
    const localWorkspaceDir = path.join(root, "local-workspace");
    const remoteWorkspaceDir = path.join(root, "remote-workspace");
    await fs.mkdir(path.join(localWorkspaceDir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");
    await fs.writeFile(path.join(localWorkspaceDir, ".claude", "settings.json"), '{"local":true}\n', "utf8");

    const runCommands: string[] = [];
    const client = makeFsClient({ runCommands });
    // A fallback-only client never advertises native outbound.
    expect(client.syncOut).toBeUndefined();

    const runtimeStatuses: string[] = [];
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      workspaceExclude: [".claude"],
      preserveAbsentOnRestore: [".claude"],
      onRuntimeProgress: async (status) => {
        runtimeStatuses.push(`${status.phase}:${status.message}`);
      },
    });

    // Staging excluded the host-managed `.claude` from the sandbox.
    await expect(
      fs.readFile(path.join(remoteWorkspaceDir, ".claude", "settings.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await fs.writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "sync back\n", "utf8");
    await prepared.restoreWorkspace();

    // Sync-back applied the remote edits; the preserved-absent `.claude` stayed.
    await expect(fs.readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe(
      "remote workspace\n",
    );
    await expect(fs.readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe(
      "sync back\n",
    );
    await expect(
      fs.readFile(path.join(localWorkspaceDir, ".claude", "settings.json"), "utf8"),
    ).resolves.toBe('{"local":true}\n');

    // The fallback restore built the remote workspace-download tarball via `run`.
    expect(runCommands.some((command) => command.includes("workspace-download.tar"))).toBe(true);
    // Phase order: config_sync (staging) → restore → finalize (finalize last).
    expect(runtimeStatuses).toEqual(
      expect.arrayContaining([
        "config_sync:Syncing workspace to environment",
        "restore:Restoring workspace from environment",
        "finalize:Finalizing workspace",
      ]),
    );
    expect(runtimeStatuses.at(-1)).toBe("finalize:Finalizing workspace");
  });

  it("test_git_backed_workspace_restore_phase_order", async () => {
    // Model on sandbox-managed-runtime.test.ts "syncs git-backed workspaces through
    // a shallow standalone clone…" (~:441). A git workspace adds the git_sync and
    // export phases around the same config_sync/restore/finalize spine.
    const root = await makeTempRoot();
    const sourceRepoDir = path.join(root, "source-repo");
    const localWorkspaceDir = path.join(root, "local-worktree");
    const remoteWorkspaceDir = path.join(root, "remote-workspace");

    await fs.mkdir(sourceRepoDir, { recursive: true });
    await git(sourceRepoDir, ["init"]);
    await git(sourceRepoDir, ["checkout", "-b", "main"]);
    await git(sourceRepoDir, ["config", "user.name", "Paperclip Test"]);
    await git(sourceRepoDir, ["config", "user.email", "test@paperclip.dev"]);
    await fs.writeFile(path.join(sourceRepoDir, "tracked.txt"), "base\n", "utf8");
    await git(sourceRepoDir, ["add", "tracked.txt"]);
    await git(sourceRepoDir, ["commit", "-m", "base"]);
    await git(sourceRepoDir, ["worktree", "add", "-b", "work", localWorkspaceDir, "HEAD"]);
    await fs.writeFile(path.join(localWorkspaceDir, "tracked.txt"), "dirty local\n", "utf8");

    const client = makeFsClient({});
    const phases: string[] = [];
    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
      onRuntimeProgress: async (status) => {
        phases.push(status.phase);
      },
    });

    // The sandbox holds a real git worktree seeded from the host history.
    expect((await git(remoteWorkspaceDir, ["rev-list", "--count", "HEAD"]))).toBe("1");
    await git(remoteWorkspaceDir, ["config", "user.name", "Paperclip Sandbox"]);
    await git(remoteWorkspaceDir, ["config", "user.email", "sandbox@paperclip.dev"]);
    await git(remoteWorkspaceDir, ["add", "-A"]);
    await git(remoteWorkspaceDir, ["commit", "-m", "sandbox update"]);
    await fs.writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "from sandbox\n", "utf8");

    await prepared.restoreWorkspace();

    // The sandbox commit imported back onto the host worktree.
    expect(await git(localWorkspaceDir, ["log", "-1", "--pretty=%s"])).toBe("sandbox update");
    await expect(fs.readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe(
      "from sandbox\n",
    );
    expect(phases).toEqual(
      expect.arrayContaining(["git_sync", "config_sync", "export", "restore", "finalize"]),
    );
    expect(phases.at(-1)).toBe("finalize");
  });

  it("test_native_syncOut_client_restores_through_native_transfer_not_tarball", async () => {
    // The consumer reads `nativeSyncOut = typeof client.syncOut === "function"`
    // (sandbox-managed-runtime.ts:775) and branches at :1163: with both directions
    // native it uses `client.syncOut`, never the workspace-download tarball.
    const root = await makeTempRoot();
    const localWorkspaceDir = path.join(root, "local-workspace");
    const remoteWorkspaceDir = path.join(root, "remote-workspace");
    await fs.mkdir(localWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(localWorkspaceDir, "README.md"), "local workspace\n", "utf8");

    const runCommands: string[] = [];
    const syncOutCalls = { count: 0 };
    const client = makeFsClient({ runCommands, syncOutCalls, withNativeSyncOut: true });
    // With both directions the client advertises native outbound.
    expect(client.syncOut).toBeTypeOf("function");

    const prepared = await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "test-adapter",
      client,
      workspaceLocalDir: localWorkspaceDir,
    });

    await fs.writeFile(path.join(remoteWorkspaceDir, "README.md"), "remote workspace\n", "utf8");
    await fs.writeFile(path.join(remoteWorkspaceDir, "remote-only.txt"), "native sync\n", "utf8");
    await prepared.restoreWorkspace();

    // The native outbound transfer ran and applied the remote edits...
    expect(syncOutCalls.count).toBeGreaterThanOrEqual(1);
    await expect(fs.readFile(path.join(localWorkspaceDir, "README.md"), "utf8")).resolves.toBe(
      "remote workspace\n",
    );
    await expect(fs.readFile(path.join(localWorkspaceDir, "remote-only.txt"), "utf8")).resolves.toBe(
      "native sync\n",
    );
    // ...and the tarball fallback was NOT used.
    expect(runCommands.some((command) => command.includes("workspace-download.tar"))).toBe(false);
  });
});

// ===========================================================================
// Layer C — sync-back registration at the engine seam.
//
// The three real adapters each register a restoreWorkspace-backed teardown via
// their managed-home seam: codex packages/adapters/codex-local/src/server/acp.ts
// (teardown ~:239-258, wired by withCodexAcpDefaults ~:277); claude
// packages/adapters/claude-local/src/server/acp.ts (registerWorkspaceSyncBack
// ~:201-215, wired by withClaudeAcpDefaults ~:292); gemini
// packages/adapters/gemini-local/src/server/acp.ts (registerWorkspaceSyncBack
// ~:163-177, wired by withGeminiAcpDefaults ~:249). Those adapter packages are
// NOT dependencies of adapter-utils and resolve only to the canonical app
// checkout (not this worktree), and the plugin-sdk env-sync-negotiation helpers
// (definePlugin/startWorkerRpcHost) are not public exports — importing them from
// an adapter-utils test is infeasible/fragile. So this pins the adapter-agnostic
// sync-back at the engine seam: `prepareRemoteManagedHome` returns a `teardown`
// (the same shape each adapter registers), and the engine fires it exactly once
// on the exit/cleanup path (mirrors execute.test.ts
// test_remote_seam_teardown_fires_once_on_exit :2556).
// ===========================================================================
describe("ACP settlement — Layer C: per-adapter sync-back teardown fires once at the engine seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("test_engine_fires_each_adapter_named_sync_back_teardown_exactly_once", async () => {
    for (const adapter of ["codex", "claude", "gemini"] as const) {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      let teardownCalls = 0;
      await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        {
          authToken: "real-run-jwt",
          executionTarget,
          // The seam stands in for `${adapter}`'s registerWorkspaceSyncBack: it
          // returns a teardown that would call stagedRuntime.restoreWorkspace(...).
          prepareRemoteManagedHome: async (input) => {
            const stagedRuntime = await input.stage([]);
            return {
              stagedRuntime,
              teardown: async () => {
                teardownCalls += 1;
                return { ok: true };
              },
            };
          },
        },
      );

      expect(teardownCalls, `${adapter} sync-back teardown fires exactly once`).toBe(1);
    }
  });
});
