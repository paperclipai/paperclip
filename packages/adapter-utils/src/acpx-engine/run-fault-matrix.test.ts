import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { runChildProcess } from "../server-utils.js";

// The composed fault matrix.
//
// Each case drives the whole ACP run and asserts the run's final settlement
// disposition report. The report is the authority on which resources the run
// acquired and how each one left the run: `finalized` (the run released it) or
// `transferred` (the run saved it for reuse). For each case the file asserts:
//
//   1. the report keys equal the acquired subset of the six resource ids;
//   2. each resource carries exactly one disposition;
//   3. the external result equals the composed baseline for that exit path.
//
// The six resource ids are: acp_runtime, staged_runtime, control_bridge,
// agent_bridge, managed_home, staging_lease. The host lane acquires only
// acp_runtime; the sandbox lane acquires the staging and transport resources too.

// Wrap the staging seam and both sandbox bridges so a test can stub them without
// changing behavior for the other tests.
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
import { settleAcpRun, type SettlementSteps } from "./settlement-sequence.js";
import { createRunResourceLedger } from "./run-resource-ledger.js";
import { LedgerStateError, type ResourceId } from "./run-contracts.js";
import type { SettlementDispositionReport } from "./run-coordinator.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-fault-"));
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

function createLocalSandboxRunner() {
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

function cancelledTurn() {
  return {
    events: (async function* () {})(),
    result: Promise.resolve({ status: "cancelled", stopReason: "cancelled" }),
    cancel: async () => {},
  };
}

// A runtime whose completed turn keeps the session handshake and turn simple.
function completedRuntime() {
  return {
    ensureSession: async () => okHandle,
    startTurn: () => completedTurn(),
    setConfigOption: async () => {},
    close: async () => {},
  } as never;
}

// A context whose only prompt-read field throws when read, so the prompt build
// fails after the session handshake and before the turn starts.
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

// Stub both sandbox bridges, so a case reaches the post-build window with live
// handles without running the real bridge transport. `stopRejects` makes the
// bridge stop reject during settlement.
function stubBridges(options: { stopRejects?: boolean } = {}) {
  const stop = options.stopRejects
    ? vi.fn(async () => {
        throw new Error("bridge stop boom");
      })
    : vi.fn(async () => {});
  vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(async () => {
    return { env: {}, stop } as never;
  });
  vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementation(async () => {
    return { agentCommand: null, stop } as never;
  });
}

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

// Seed the managed home through the staging seam and return a per-run copy-back
// so the run registers the managed_home resource. `teardownRejects` makes the
// copy-back reject during the settlement sync-back.
function managedHomeSeed(options: { teardownRejects?: boolean } = {}): AcpxEngineExecutorOptions["prepareRemoteManagedHome"] {
  return async (input) => {
    const stagedRuntime = await input.stage([]);
    return {
      stagedRuntime,
      teardown: options.teardownRejects
        ? async () => {
            throw new Error("copy-back boom");
          }
        : async () => {},
    };
  };
}

// Capture the final settlement disposition report the run records.
function captureDisposition() {
  const reports: SettlementDispositionReport[] = [];
  return {
    onSettlementDisposition: (report: SettlementDispositionReport) => {
      reports.push(report);
    },
    last(): SettlementDispositionReport | null {
      return reports.length > 0 ? reports[reports.length - 1]! : null;
    },
  };
}

// The shared per-case assertion. It proves the report keys equal the acquired
// subset, each resource carries exactly one disposition, and the transferred id
// (if any) is the only `transferred` entry.
function assertDispositionReport(
  report: SettlementDispositionReport | null,
  expected: { acquired: ResourceId[]; transferred?: ResourceId | null },
) {
  expect(report, "the run must record a disposition report").not.toBeNull();
  const records = report!.records;
  const ids = records.map((record) => record.id);
  // Each resource carries exactly one disposition (no duplicate id).
  expect(ids.length, "no resource is reported twice").toBe(new Set(ids).size);
  // The report keys equal the acquired subset of the six resource ids.
  expect(new Set(ids)).toEqual(new Set(expected.acquired));
  const transferred = expected.transferred ?? null;
  for (const record of records) {
    expect(["finalized", "transferred"]).toContain(record.disposition);
    if (record.id === transferred) {
      expect(record.disposition, `${record.id} must be transferred`).toBe("transferred");
    } else {
      expect(record.disposition, `${record.id} must be finalized`).toBe("finalized");
    }
  }
}

// The sandbox-lane resource set before the runtime is created (staging and
// transport), and after (adds the runtime). Without a managed-home seed the
// managed_home resource is absent.
const SANDBOX_PRE_RUNTIME: ResourceId[] = ["staged_runtime", "staging_lease", "control_bridge", "agent_bridge"];
const SANDBOX_WITH_RUNTIME: ResourceId[] = [...SANDBOX_PRE_RUNTIME, "acp_runtime"];
const SANDBOX_WITH_MANAGED_HOME: ResourceId[] = [
  "staged_runtime",
  "managed_home",
  "staging_lease",
  "control_bridge",
  "agent_bridge",
  "acp_runtime",
];

describe("composed ACPX run fault matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Case 1 — a build failure throws before the ledger acquires any resource.
  it("case_01_build_failure_throws_and_acquires_nothing", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    vi.mocked(prepareAdapterExecutionTargetRuntime).mockImplementationOnce(async () => {
      throw new Error("staging boom");
    });
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => completedRuntime(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    await expect(
      execute({ runId: "fault-build", ...remoteArgs(stateDir, localCwd, executionTarget) } as never),
    ).rejects.toThrow("staging boom");

    assertDispositionReport(capture.last(), { acquired: [] });
  });

  // Case 2 — a partial bridge failure throws; the staged entry and the lease are
  // finalized (the rollback removed the borrowed staged entry).
  it("case_02_partial_bridge_failure_finalizes_staged_and_lease", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const capture = captureDisposition();
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
      createRuntime: () => completedRuntime(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    await expect(
      execute({ runId: "fault-bridge", ...remoteArgs(stateDir, localCwd, executionTarget) } as never),
    ).rejects.toThrow("paperclip bridge boom");

    assertDispositionReport(capture.last(), { acquired: ["staged_runtime", "staging_lease"] });
  });

  // Case 3 — a runtime-create failure settles the staging and transport resources.
  // The runtime never enters the ledger.
  it("case_03_runtime_create_failure_finalizes_staging_and_transport", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => {
        throw new Error("createRuntime boom");
      },
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-create",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("create_runtime");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_PRE_RUNTIME });
  });

  // Case 4 — a handshake failure closes the runtime; every resource finalizes.
  it("case_04_handshake_failure_closes_runtime", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => {
            throw new Error("ensureSession boom");
          },
          startTurn: () => completedTurn(),
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-handshake",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("ensure_session");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 5 — a missing session handle closes the runtime; the result carries a
  // null clearSession and no errorMeta.
  it("case_05_missing_handle_closes_runtime_null_error", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => undefined,
          startTurn: () => completedTurn(),
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-missing-handle",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("ensure_session");
    expect(result.errorCode).toBe("acpx_runtime_error");
    expect(result.clearSession).toBeUndefined();
    expect(result.errorMeta).toBeUndefined();
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 6 — a configuration failure closes the runtime.
  it("case_06_configuration_failure_closes_runtime", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => completedTurn(),
          setConfigOption: async () => {
            throw new Error("setConfigOption boom");
          },
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-configure",
      ...remoteArgs(stateDir, localCwd, executionTarget, {
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          model: "custom-model-x",
          stateDir,
          cwd: localCwd,
        },
      }),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("configure_session");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 7 — a prompt-build failure fails the turn in the prepare phase.
  it("case_07_prompt_build_failure_finalizes_every_resource", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => completedRuntime(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-prepare",
      ...remoteArgs(stateDir, localCwd, executionTarget, { context: throwingHandoffContext() }),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("prepare_turn");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 8 — a resume retry runs ensureSession twice but registers the runtime
  // once, so the acquired set has no doubled resource.
  it("case_08_resume_retry_does_not_double_resources", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });
    const config = { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd };

    // A first clean host run mints the session params the second run resumes from.
    const firstExecute = createAcpxEngineExecutor({ createRuntime: () => completedRuntime() });
    const first = await firstExecute({
      runId: "fault-resume-a",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);

    // The second run resumes: the resume ensureSession fails, the fresh retry
    // succeeds. The runtime is created once, so acp_runtime registers once.
    const capture = captureDisposition();
    let created = 0;
    const secondExecute = createAcpxEngineExecutor({
      onSettlementDisposition: capture.onSettlementDisposition,
      createRuntime: () => {
        created += 1;
        return {
          ensureSession: async (session: Record<string, unknown>) => {
            if (session.resumeSessionId) throw new Error("resume session not found");
            return okHandle;
          },
          startTurn: () => completedTurn(),
          setConfigOption: async () => {},
          close: async () => {},
        } as never;
      },
    });
    const second = await secondExecute({
      runId: "fault-resume-b",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: (first as { sessionParams?: unknown }).sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(second.exitCode).toBe(0);
    // The runtime was created exactly once across the resume and the fresh retry.
    expect(created).toBe(1);
    // The host lane acquires only the runtime, and it appears once.
    assertDispositionReport(capture.last(), { acquired: ["acp_runtime"] });
  });

  // Case 9 — a turn exception finalizes every resource (the staged runtime is
  // discarded, not transferred).
  it("case_09_turn_exception_discards_staged_runtime", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-turn",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("turn");
    expect(result.errorCode).toBe("acpx_turn_failed");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 10 — a turn timeout finalizes every resource.
  it("case_10_turn_timeout_finalizes_every_resource", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    let releaseTurn: (() => void) | null = null;
    const turnCancelled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => ({
            events: (async function* () {
              await turnCancelled;
            })(),
            result: turnCancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
            cancel: async () => {
              releaseTurn?.();
            },
          }),
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-timeout",
      ...remoteArgs(stateDir, localCwd, executionTarget, {
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd, timeoutSec: 1 },
      }),
    } as never);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("acpx_timeout");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  }, 15_000);

  // Case 11 — a cancelled turn finalizes every resource.
  it("case_11_turn_cancellation_finalizes_every_resource", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => cancelledTurn(),
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-cancel",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.status).toBe("cancelled");
    assertDispositionReport(capture.last(), { acquired: SANDBOX_WITH_RUNTIME });
  });

  // Case 12 — a clean success saves the staged runtime (transferred); every other
  // resource finalizes. A managed-home seed exercises the full six-resource set.
  it("case_12_clean_success_transfers_staged_runtime", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => completedRuntime(),
      prepareRemoteManagedHome: managedHomeSeed(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-success",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.status).toBe("completed");
    assertDispositionReport(capture.last(), {
      acquired: SANDBOX_WITH_MANAGED_HOME,
      transferred: "staged_runtime",
    });
  });

  // Case 13 — a bridge stop that rejects during settlement never changes the
  // result or the report (allSettled absorbs the fault).
  it("case_13_bridge_stop_reject_does_not_change_result", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges({ stopRejects: true });
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => completedRuntime(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-bridge-stop",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.status).toBe("completed");
    assertDispositionReport(capture.last(), {
      acquired: SANDBOX_WITH_RUNTIME,
      transferred: "staged_runtime",
    });
  });

  // Case 14 — a sync-back copy-back that rejects during settlement never changes
  // the result or the report.
  it("case_14_sync_back_failure_does_not_change_result", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => completedRuntime(),
      prepareRemoteManagedHome: managedHomeSeed({ teardownRejects: true }),
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-sync-back",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.status).toBe("completed");
    assertDispositionReport(capture.last(), {
      acquired: SANDBOX_WITH_MANAGED_HOME,
      transferred: "staged_runtime",
    });
  });

  // Case 15 — a concurrent double settlement is a structural error: the second
  // claim of the ledger throws a LedgerStateError.
  it("case_15_concurrent_double_settlement_throws_ledger_state_error", async () => {
    const ledger = createRunResourceLedger();
    ledger.register({
      id: "acp_runtime",
      payload: { runtime: {}, sessionHandle: {}, childProcessPid: null } as never,
      scope: "per_run",
    });
    const noopSteps: SettlementSteps = {
      reuseCandidate: () => null,
      endSession: () => {},
      settleReuse: () => {},
      stopTransport: () => {},
      syncBack: () => {},
      releaseStagingLease: () => {},
      recordError: () => {},
    };

    // The first settlement claims the ledger and produces the report.
    const report = await settleAcpRun(ledger, null, noopSteps);
    assertDispositionReport(report, { acquired: ["acp_runtime"] });

    // A second settlement of the same ledger is a structural error.
    await expect(settleAcpRun(ledger, null, noopSteps)).rejects.toBeInstanceOf(LedgerStateError);
  });

  // Case 16 — the host-lane credential gate. Constructed gate-passed: the runtime
  // transfers and never closes. Live host path (gate failed): the runtime closes
  // and never transfers.
  it("case_16_host_credential_gate_transfer_versus_close", async () => {
    // Constructed gate-passed condition: a host candidate with no live run-scoped
    // credential. The reuse decision saves, so the runtime transfers and endSession
    // never closes it.
    const ledger = createRunResourceLedger();
    ledger.register({
      id: "acp_runtime",
      payload: { runtime: {}, sessionHandle: {}, childProcessPid: null } as never,
      scope: "per_run",
    });
    let closed = false;
    const gatePassedSteps: SettlementSteps = {
      reuseCandidate: () => ({ kind: "host", causePermitsSave: true, liveRunScopedCredentials: [] }),
      endSession: (_slots, decision) => {
        if (decision.kind !== "save") closed = true;
      },
      settleReuse: () => {},
      stopTransport: () => {},
      syncBack: () => {},
      releaseStagingLease: () => {},
      recordError: () => {},
    };
    const gatePassedReport = await settleAcpRun(ledger, null, gatePassedSteps);
    expect(closed).toBe(false);
    assertDispositionReport(gatePassedReport, { acquired: ["acp_runtime"], transferred: "acp_runtime" });

    // Live host path: the engine populates the run-scoped credential, so the gate
    // fails, the runtime closes, and it never transfers.
    const root = await makeTempRoot();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: () => completedRuntime(),
      onSettlementDisposition: capture.onSettlementDisposition,
    });
    const result = await execute({
      runId: "fault-host-gate",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        mode: "persistent",
        warmHandleIdleMs: 60_000,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    // The live host path closes and never transfers the runtime.
    assertDispositionReport(capture.last(), { acquired: ["acp_runtime"], transferred: null });
  });

  // Case 17 — a host-lane turn failure finalizes (closes) the runtime.
  it("case_17_host_turn_failure_finalizes_runtime", async () => {
    const root = await makeTempRoot();
    const capture = captureDisposition();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          setConfigOption: async () => {},
          close: async () => {},
        }) as never,
      onSettlementDisposition: capture.onSettlementDisposition,
    });

    const result = await execute({
      runId: "fault-host-turn-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        mode: "persistent",
        warmHandleIdleMs: 60_000,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("turn");
    assertDispositionReport(capture.last(), { acquired: ["acp_runtime"], transferred: null });
  });
});

describe("composed ACPX run per-phase telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a run.phase.timing event for each lifecycle phase a clean host run reaches", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: () => completedRuntime(),
    });

    const result = await execute({
      runId: "phase-telemetry",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        events.push(event);
      },
    } as never);

    expect(result.exitCode).toBe(0);
    const phases = events
      .filter((event) => event.eventType === "run.phase.timing")
      .map((event) => String(event.payload?.phase));
    // A clean host run runs the runtime, session, prepare, turn, and settlement
    // phases. Each phase emits a phase-timing event.
    for (const phase of ["create_runtime", "ensure_session", "prepare_turn", "turn", "end_session"]) {
      expect(phases, `missing phase telemetry for ${phase}`).toContain(phase);
    }
    // Every phase-timing event carries exactly the three closed fields.
    for (const event of events.filter((entry) => entry.eventType === "run.phase.timing")) {
      expect(Object.keys(event.payload ?? {}).sort()).toEqual(["durationMs", "outcome", "phase"]);
    }
  });
});
