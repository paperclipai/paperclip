import { compareAndSealRetiredComputerCheckpoint, retiredComputerCheckpointIsSettled, retireUnlaunchedComputerAttempt, nativeSessionBootstrapTimeoutMs } from "./native-session-executor.js";
import { prepareHeartbeatGitHubLaunchers } from "../heartbeat-github-launchers.js";
import { gunzipSync } from "node:zlib";
import { configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import {
  heartbeatRuns,
  environmentLeases,
  heartbeatRunEvents,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import {
  CURSOR_DISTRIBUTION_PINS,
  QUALIFIED_ACPX_PROFILES,
  acpxRuntimeSessionDirectoryName,
  resolveAcpxRuntimeRoot,
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
  validatePrpStructuredRunResult,
  validatePrpEvent,
  parseNativeExecutionInput,
  type NativeExecutionInputV1,
  type NativeExecutionInputV3,
  type NativeExecutionInput,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nativeSha256 } from "./canonical.js";
import { agentDirectoryWorkingCopyService } from "../agent-directory-working-copies.js";
import { probeAgentDirectory } from "../agent-directory-probe.js";
import { AGENT_FILES_CONTRACT } from "../agent-file-store.js";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { agentInstructionWorkingCopies } from "@paperclipai/db";
import * as noLaunchProofModule from "./native-maintenance-no-launch.js";
import {
  NativeSessionCleanupQuarantinedError,
  NativeProviderTerminalFailure,
  NativeSessionProtocolIntegrityError,
} from "../../vendor/paperclip-runner/index.js";
import * as issueServiceModule from "../issues.js";
import { NativePermissionDeclinedError } from "./native-permission-decline.js";
import { resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";
import {
  createNativeHarnessBackupStamp,
  verifyNativeHarnessBackupStamp,
} from "./native-harness-backup-stamp.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import * as nativeSessionResume from "./native-session-resume.js";
import { buildNativeHeartbeatPreparationSpans } from "./native-run-trace.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const computerRetirement = vi.hoisted(() => ({ isRetired: vi.fn() }));
vi.mock("../../modules/computers/index.js", () => ({ computerService: () => computerRetirement }));

const githubAccess = vi.hoisted(() => ({
  activate: vi.fn((_binding: { runId: string }) => vi.fn()),
  stop: vi.fn(async () => undefined),
  create: vi.fn(),
}));
vi.mock("./native-github-access.js", () => ({
  createNativeGitHubAccess: githubAccess.create,
}));

type BackendFactoryOptions = {
  runnerInstanceId?: string;
  acpxRuntimeDirectory?: string;
  workingDirectoryAuthority?: "local_filesystem" | "remote_runner";
  codexTransportFactory?: (recoveryContext?: {
    persistedSession?: {
      driverSessionId: string;
      providerSessionId?: string | null;
      activeTurnId?: string | null;
    };
  }) => unknown;
  dynamicToolHandler?: (call: unknown) => Promise<unknown>;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
};

type RunnerTransportOptions = {
  acpxRuntimeDirectory?: string;
  adoptExistingRunner?: { pid: number; isAlive: () => Promise<boolean> | boolean };
  stateDirectory?: string;
  runnerBinary?: string;
  prpIdentity?: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
  };
  provider?: "codex" | "opencode" | "acpx";
  opencodePermissionMode?: "allow" | "ask" | "deny";
  acpxAgent?: "claude" | "codex";
  acpxPermissionMode?: "approve-all" | "approve-paperclip" | "approve-reads" | "deny-all";
  resumeActiveTurnId?: string | null;
  resumeProviderSession?: {
    driverSessionId: string;
    providerSessionId?: string | null;
    activeTurnId?: string | null;
  };
  archiveExternalRunnerState?: (input: {
    archiveKey: string;
    priorIdentity: {
      runnerInstanceId: string;
      environmentLeaseId: string;
      runId: string;
      normalizedSessionId: string;
      turnId: string;
      itemId: string;
    };
  }) => Promise<Record<string, unknown>>;
};

const durableControlPlaneState = (identity: Record<string, unknown>) => ({
  schema: "paperclip.runner.durable.control-plane-state.v1",
  identity,
});
const durableRunnerState = (
  identity: Record<string, unknown>,
  lifecycle: string,
) => ({
  schema: "paperclip.runner.durable.state.v1",
  ...identity,
  lifecycle,
});

const state = vi.hoisted(() => ({
  createAssignedMcpTools: vi.fn(),
  execute: vi.fn(),
  cleanup: vi.fn(),
  retireCleanup: vi.fn(),
  maintenanceIdle: vi.fn(() => true),
  createTransport: vi.fn((_options: RunnerTransportOptions) => ({
    transport: {},
  })),
  createBackend: vi.fn(
    (_input: NativeExecutionInputV1, _options: BackendFactoryOptions) => ({
      kind: "test",
    }),
  ),
  cancel: vi.fn(),
  copyBackCodexAuth: vi.fn(async () => "kept-host"),
  toolAuthorityDefinitions: vi.fn(
    async (_binding: Record<string, unknown>) => [],
  ),
  toolAuthorityExecute: vi.fn(),
  persistActivity: vi.fn(async (_db: unknown, input: { action: string }) => ({
    activity: {
      id:
        input.action === "native.cancellation_intent_recorded"
          ? "native-cancellation-audit"
          : "native-cancellation-ack-audit",
    },
    publication: {
      companyId: "company",
      payload: { action: input.action },
      pluginEvent: null,
    },
  })),
  publishActivity: vi.fn(),
  upsertRecoveryAction: vi.fn(async () => ({})),
  stageNativeRunnerWakeAttachments: vi.fn(
    async (): Promise<{
      attachments: Array<Record<string, unknown>>;
      cleanup: () => Promise<void>;
    }> => ({
      attachments: [],
      cleanup: vi.fn(async () => undefined),
    }),
  ),
  renderNativeRunnerStagedAttachmentPrompt: vi.fn(() => ""),
  resolveCurrentWakeCommentsBinding: vi.fn(
    async (): Promise<Record<string, unknown> | null> => null,
  ),
  assertCurrentWakeCommentsRead: vi.fn(async () => undefined),
  bundledPackManifestPath: null as string | null,
  bundledRunnerBinary: null as string | null,
  resolveRunnerBinary: vi.fn(() => "/tmp/paperclip-runnerd"),
  release: null as null | (() => void),
}));

const accountingEvents = vi.hoisted(() => ({ committed: undefined as undefined | ((event: PrpEvent) => Promise<void>), duplicate: undefined as undefined | ((event: PrpEvent) => Promise<void>) }));
vi.mock("./paperclip-control-plane-port.js", async importOriginal => {
  const original = await importOriginal<typeof import("./paperclip-control-plane-port.js")>();
  return { ...original, PaperclipControlPlanePort: class extends original.PaperclipControlPlanePort {
    constructor(...args: ConstructorParameters<typeof original.PaperclipControlPlanePort>) {
      super(...args);
      accountingEvents.committed = args[2]?.onCommittedEvent;
      accountingEvents.duplicate = args[2]?.onDuplicateEvent;
    }
  } };
});

const grokCopyBack = vi.hoisted(() => vi.fn(async (_input: { readSandboxAuth: () => Promise<Buffer>; hostHomeDir: string }) => undefined));
vi.mock("@paperclipai/adapter-grok-local/server", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-grok-local/server")>(),
  copyBackGrokAuth: grokCopyBack,
}));

vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../vendor/paperclip-runner/index.js")
  >();
  return {
    ...original,
    bundledRemoteProviderPackManifestPath: () => state.bundledPackManifestPath ?? original.bundledRemoteProviderPackManifestPath(),
    bundledRemoteRunnerBinary: () => state.bundledRunnerBinary ?? original.bundledRemoteRunnerBinary(),
    createNativeSessionBackend: state.createBackend,
    createRunnerdCodexTransport: state.createTransport,
    executeNativeSession: state.execute,
    settleRetainedRunnerdSession: state.cleanup,
    retainedRunnerdMaintenanceIsIdle: state.maintenanceIdle,
    completeRetainedNativeSessionCleanup: state.retireCleanup,
    parsePaperclipQuestionSet: (value: unknown) => value,
  };
});

vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@paperclipai/adapter-codex-local/server")
  >()),
  copyBackCodexAuth: state.copyBackCodexAuth,
}));

vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    close() {}
    readonly binding: Record<string, unknown>;

    constructor(_db: unknown, binding: Record<string, unknown>) {
      this.binding = binding;
    }

    async definitions() {
      return state.toolAuthorityDefinitions(this.binding);
    }

    async execute(call: unknown) {
      return state.toolAuthorityExecute(this.binding, call);
    }
  },
}));

vi.mock("./assigned-mcp-tools.js", () => ({
  createAssignedMcpTools: state.createAssignedMcpTools,
  getAssignedMcpGateway: () => ({}),
}));

vi.mock("./native-runner-file-handoff.js", () => ({
  stageNativeRunnerWakeAttachments: state.stageNativeRunnerWakeAttachments,
  renderNativeRunnerStagedAttachmentPrompt:
    state.renderNativeRunnerStagedAttachmentPrompt,
}));

vi.mock("./current-wake-comments.js", () => ({
  resolveCurrentWakeCommentsBinding: state.resolveCurrentWakeCommentsBinding,
  assertCurrentWakeCommentsRead: state.assertCurrentWakeCommentsRead,
}));

vi.mock("../activity-log.js", () => ({
  persistActivity: state.persistActivity,
  publishActivity: state.publishActivity,
}));

vi.mock("../issue-recovery-actions.js", () => ({
  issueRecoveryActionService: () => ({
    upsertSourceScoped: state.upsertRecoveryAction,
  }),
}));

vi.mock("./native-codex-runner.js", () => ({
  resolvePaperclipRunnerBinary: state.resolveRunnerBinary,
}));

import {
  continuingPendingInteractionIds,
  buildNativeProviderEnvironment,
  resolveNativeProviderEnvironment,
  buildNativeHarnessBackupManifest,
  cancelNativeSession,
  closeWarmNativeSessionsForEnvironment,
  closeWarmNativeSessionsForRun,
  claimWarmNativeInstructionCopy,
  nativeSessionWorkspaceScope,
  reserveWarmNativeInstructionDirectory,
  closeIdleWarmNativeSessionsForRestart,
  createGovernedWaitEventObservation,
  createRemoteRunnerProcessLauncher,
  createRunnerdBackend,
  executePaperclipNativeSession,
  detachNativeSessionsForRestart,
  NativeControllerDetachedForRestartError,
  getNativeSessionSteeringState,
  NativeSessionSteeringError,
  assertRemoteRunnerBuildMetadata,
  nativeSessionFailureDisposition,
  nativeFailedRunRetryStateIsSafe,
  verifyStoppedNativeSessionForContinuation,
  nativePreProviderRetryAfterCleanupStateIsSafe,
  reconcileRetainedNativeSessionCleanup,
  retainedNativeCleanupJournalMatches,
  nativeProviderUsageLimitFromEvent,
  nativeSessionFailureSourceCode,
  nativeProviderRecoveryEvidence,
  verifyPriorRunnerdStateForSessionScope,
  nativeSessionRecoveryProjection,
  nativeGovernedWaitResult,
  nativeConversationReplyResult,
  nativeToolsRefreshWaitResult,
  parseRemoteExecutableCandidate,
  buildRemoteCodexLauncherCommand,
  mayUsePreinstalledRunnerArtifact,
  nativeUsageCostUsd,
  nativeUsageBiller,
  normalizeNativeUsage,
  resolveNativeBilling,
  parseRemoteRunnerProcessIdentity,
  REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
  verifyRemoteRunnerReattachment,
  readRemoteProviderPackManifest,
  readBundledRemoteProviderPackManifest,
  providerSessionIdentityFromDurableProviderState,
  durableProviderCheckpointFailureReason,
  providerSessionIdentityTransitionIsAllowed,
  providerPlanMarkdown,
  remoteCheckpointIncompleteFailure,
  resolveRemoteRunnerTransportMode,
  renewNativeSessionExecutionLease,
  runtimeInputLifecycleMetric,
  firstMeaningfulAgentEventKind,
  runtimeQuestionFallbackFromEvent,
  resolveNativeRuntimeRequest,
  resolveNativeHarnessPersistenceProfile,
  runnerdStateProvesIncompleteBootstrap,
  semanticProviderPlanMarkdown,
  sha256DirectoryTree,
  stageRemoteRunnerDirectory,
  stageRemoteRunnerFile,
  nativeComputerToolForExecution,
  steerNativeSession,
  syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackup,
  shouldRestoreNativeHarnessBackupIntoSandbox,
  remoteRunnerStorageRoots,
} from "./native-session-executor.js";

beforeEach(() => {
  state.bundledPackManifestPath = null;
  state.bundledRunnerBinary = null;
  state.createAssignedMcpTools.mockReset();
  state.resolveRunnerBinary.mockReset().mockReturnValue("/tmp/paperclip-runnerd");
  state.resolveCurrentWakeCommentsBinding.mockReset().mockResolvedValue(null);
  state.assertCurrentWakeCommentsRead.mockReset().mockResolvedValue(undefined);
});

describe("first meaningful native agent event", () => {
  const event = (eventType: string, payload: Record<string, unknown>) =>
    ({ eventType, payload }) as PrpEvent;

  it("accepts nonempty assistant and reasoning deltas", () => {
    expect(
      firstMeaningfulAgentEventKind(
        event("item.delta", { kind: "agentMessage", text: "first token" }),
      ),
    ).toBe("agentMessage");
    expect(
      firstMeaningfulAgentEventKind(
        event("item.delta", { kind: "reasoning", delta: "thinking" }),
      ),
    ).toBe("reasoning");
  });

  it("accepts real tool starts and preserves qualified item events", () => {
    expect(
      firstMeaningfulAgentEventKind(
        event("tool.execution.started", {
          executionId: "tool-1",
          name: "Terminal",
        }),
      ),
    ).toBe("toolCall");
    expect(
      firstMeaningfulAgentEventKind(
        event("item.started", { kind: "dynamicToolCall" }),
      ),
    ).toBe("dynamicToolCall");
    expect(
      firstMeaningfulAgentEventKind(
        event("item.completed", { kind: "agentMessage" }),
      ),
    ).toBe("agentMessage");
  });

  it("counts a generic tool announcement without a display name", () => {
    expect(firstMeaningfulAgentEventKind(event("tool.execution.started", { executionId: "tool-1", name: null }))).toBe("toolCall");
  });

  it("ignores empty deltas and usage, status, or metadata events", () => {
    for (const candidate of [
      event("item.delta", { kind: "agentMessage", text: " " }),
      event("item.delta", { kind: "reasoning", delta: "" }),
      event("item.delta", { kind: "usage", text: "tokens" }),
      event("turn.started", { kind: "agentMessage", text: "message" }),
      event("tool.execution.started", { name: "Terminal" }),
    ]) expect(firstMeaningfulAgentEventKind(candidate)).toBeNull();
  });
});

describe("remote controller restart adoption", () => {
  const identity = {
    runId: "run",
    normalizedSessionId: "session",
    runnerInstanceId: "runner",
    environmentLeaseId: "lease",
    turnId: "turn",
    itemId: "item",
  };
  const claim = {
    kind: "reattach_remote_runner" as const,
    runId: "run",
    leaseOwner: "controller",
    controllerGeneration: 2,
    providerAttempt: 1,
    restartKind: "graceful" as const,
    recoveryRequestId: null,
    remote: { providerLeaseId: "sandbox", remoteCwd: "/workspace" },
  };
  function fixture(overrides: Record<string, unknown> = {}) {
    const execute = vi.fn(async (request: { args: string[] }) => {
      const script = request.args[1];
      const stdout = script.includes("base64")
        ? Buffer.from(
            JSON.stringify({ ...identity, lifecycle: "running", ...overrides }),
          ).toString("base64")
        : script.includes("cat --")
          ? "nonce\n123\n2026-09-19T10:00:00.000Z\nrunner\nlinux:abcd-1234:100\n"
          : "";
      return { stdout, stderr: "", exitCode: 0, timedOut: false };
    });
    const target = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      remoteCwd: "/workspace",
      providerKey: "daytona",
      leaseId: "lease",
      sandboxLeaseAcquisition: {
        outcome: "resumed" as const,
        providerLeaseId: "sandbox",
      },
      runner: { execute },
    };
    return { execute, target };
  }
  it("requires the exact durable computer owner generation and port on restart", async () => {
    const { execute, target: sandbox } = fixture();
    const { sandboxLeaseAcquisition, ...common } = sandbox;
    const inspectProcess = vi.fn(async () => ({ running: true, claim: { nonce: "process-claim" } }));
    const target = { ...common, transport: "computer", listenerPort: 45101,
      fileAuthority: { kind: "remote-persistent", root: "/workspace", placementId: "workspace", agentHome: "/home/user/agent" },
      resourceAuthority: { kind: "computer-owner", computerId: "computer", ownerId: "owner", generation: 7 }, inspectProcess };
    const computerClaim = { ...claim, remote: { ...claim.remote, providerLeaseId: "owner",
      computerOwner: { computerId: "computer", ownerId: "owner", generation: 7, listenerPort: 45101 } } };
    const adopted = await verifyRemoteRunnerReattachment({ claim: computerClaim, target: target as never,
      identity, runId: "run", normalizedSessionId: "session" });
    expect(adopted.pid).toBe(123);
    const storage = remoteRunnerStorageRoots(target as never, "session");
    expect(execute.mock.calls[0]![0].args.join(" ")).toContain(`${storage.sessionRoot}/runner/runner-state.json`);
    expect(execute.mock.calls.some(([request]) => request.args.includes(`${storage.sessionRoot}/runner/runner-process.identity`))).toBe(true);
    expect(inspectProcess).toHaveBeenCalledOnce();
    const readCount = execute.mock.calls.length;
    await expect(verifyRemoteRunnerReattachment({ claim: { ...computerClaim, remote: {
      ...computerClaim.remote, computerOwner: { ...computerClaim.remote.computerOwner, generation: 6 } } }, target: target as never,
      identity, runId: "run", normalizedSessionId: "session" })).rejects.toThrow("computer_process_recovery_mismatch");
    expect(execute).toHaveBeenCalledTimes(readCount);
    await expect(verifyRemoteRunnerReattachment({ claim: { ...computerClaim, remote: {
      ...computerClaim.remote, computerOwner: { ...computerClaim.remote.computerOwner, listenerPort: 45102 } } }, target: target as never,
      identity, runId: "run", normalizedSessionId: "session" })).rejects.toThrow("computer_process_recovery_mismatch");
  });

  it("adopts the exact live sandbox process without spawning or copying state", async () => {
    const { execute, target } = fixture();
    const adopted = await verifyRemoteRunnerReattachment({
      claim,
      target: target as never,
      identity,
      runId: "run",
      normalizedSessionId: "session",
    });
    expect(adopted.pid).toBe(123);
    expect(await adopted.isAlive()).toBe(true);
    expect(
      execute.mock.calls.every(
        ([request]) => !request.args.join(" ").match(/nohup|mkdir|rm -|mv -/),
      ),
    ).toBe(true);
    execute.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 4,
      timedOut: false,
    });
    expect(await adopted.isAlive()).toBe(false);
  });
  it.each([
    "runId",
    "normalizedSessionId",
    "runnerInstanceId",
    "environmentLeaseId",
    "turnId",
    "itemId",
  ])("rejects a changed remote %s", async (field) => {
    const { execute, target } = fixture({ [field]: "different" });
    await expect(
      verifyRemoteRunnerReattachment({
        claim,
        target: target as never,
        identity,
        runId: "run",
        normalizedSessionId: "session",
      }),
    ).rejects.toThrow("runner_remote_recovery_identity_mismatch");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("wires remote adoption when only controller state survived on the host", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-remote-reattach-"),
    );
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const current = {
      ...execution,
      binding: { ...execution.binding, runId: "run" },
      session: { ...execution.session, normalizedSessionId: "session" },
    };
    const { target } = fixture();
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(current),
        execution: current,
        runnerInstanceId: "runner",
        runnerExecutionTarget: target as never,
      });
      state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
      const root = state.createTransport.mock.calls.at(-1)![0].stateDirectory!;
      await mkdir(join(root, "control-plane"), { recursive: true });
      await writeFile(
        join(root, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
      );
      await createRunnerdBackend({
        db: leaseDb(current),
        execution: current,
        runnerInstanceId: "runner",
        runnerExecutionTarget: target as never,
        restartRecovery: claim,
      });
      state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
      expect(
        state.createTransport.mock.calls.at(-1)![0].adoptExistingRunner?.pid,
      ).toBe(123);
      expect(await readdir(root)).toContain("control-plane");
      expect(await readdir(root)).not.toContain("runner");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(stateBase, { recursive: true, force: true });
    }
  });
  it("rejects a replaced sandbox before reading or mutating it", async () => {
    const { execute, target } = fixture();
    target.sandboxLeaseAcquisition.providerLeaseId = "replacement";
    await expect(
      verifyRemoteRunnerReattachment({
        claim,
        target: target as never,
        identity,
        runId: "run",
        normalizedSessionId: "session",
      }),
    ).rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a marker that cannot prove its process generation", async () => {
    const { target, execute } = fixture();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async request => request.args[2] === "paperclip-runner-recovery-identity"
      ? { stdout: "nonce\n123\n2026-09-19T10:00:00.000Z\nrunner\n", stderr: "", exitCode: 0, timedOut: false }
      : original(request));
    await expect(verifyRemoteRunnerReattachment({ claim, target: target as never, identity, runId: "run", normalizedSessionId: "session" }))
      .rejects.toThrow("runner_remote_process_identity_unavailable");
  });
  it.each(["start ticks", "boot identity"])("rejects PID reuse after the live %s changes", async (change) => {
    const root = await mkdtemp(join(tmpdir(), "remote-generation-"));
    const proc = join(root, "proc");
    const markerPath = join(root, "runner-process.identity");
    const pid = process.pid;
    const marker = `nonce\n${pid}\n2026-09-19T10:00:00.000Z\nrunner\nlinux:abcd-1234:100\n`;
    const stat = (ticks: number) => `${pid} (runner (child)) ${["S", ...Array(18).fill("0"), ticks].join(" ")}\n`;
    const { target, execute } = fixture();
    const original = execute.getMockImplementation()!;
    try {
      await mkdir(join(proc, String(pid)), { recursive: true });
      await mkdir(join(proc, "sys/kernel/random"), { recursive: true });
      await writeFile(join(proc, String(pid), "stat"), stat(100));
      await writeFile(join(proc, String(pid), "cmdline"), "runner\0--runner-id\0runner\0");
      await writeFile(join(proc, "sys/kernel/random/boot_id"), "abcd-1234\n");
      await writeFile(markerPath, marker);
      execute.mockImplementation(async request => {
        if (request.args[2] === "paperclip-runner-recovery-identity") {
          return { stdout: marker, stderr: "", exitCode: 0, timedOut: false };
        }
        if (request.args[2] !== "paperclip-runner-recovery-check") return original(request);
        // Run the actual ownership shell against controlled Linux proc files.
        // kill -0 still checks a real live PID; only its generation changes.
        const args = [...request.args];
        args[1] = args[1].replaceAll("/proc/", `${proc}/`);
        args[3] = markerPath;
        let exitCode = 0;
        try { execFileSync("sh", args, { stdio: "pipe" }); } catch { exitCode = 4; }
        return { stdout: "", stderr: "", exitCode, timedOut: false };
      });
      const adopted = await verifyRemoteRunnerReattachment({ claim, target: target as never, identity, runId: "run", normalizedSessionId: "session" });
      expect(await adopted.isAlive()).toBe(true);
      if (change === "start ticks") await writeFile(join(proc, String(pid), "stat"), stat(101));
      else await writeFile(join(proc, "sys/kernel/random/boot_id"), "abcd-5678\n");
      expect(await adopted.isAlive()).toBe(false);
      await expect(verifyRemoteRunnerReattachment({ claim, target: target as never, identity, runId: "run", normalizedSessionId: "session" }))
        .rejects.toThrow("runner_remote_process_identity_unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a stale process marker", async () => {
    const { execute, target } = fixture();
    execute
      .mockResolvedValueOnce({
        stdout: Buffer.from(JSON.stringify(identity)).toString("base64"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        stdout: "nonce\n123\n2026-09-19T10:00:00Z\nother-runner\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    await expect(
      verifyRemoteRunnerReattachment({
        claim,
        target: target as never,
        identity,
        runId: "run",
        normalizedSessionId: "session",
      }),
    ).rejects.toThrow("runner_remote_process_identity_unavailable");
  });
});


describe("remote runner launch fingerprint compatibility", () => {
  it.each([true, false])("launches with the guaranteed Node runtime when boot identity is available: %s", async (hasBootIdentity) => {
    const root = await mkdtemp(join(tmpdir(), "remote-launch-generation-"));
    try {
      // The mocked proc stat is independent of the launch shell's PID.
      await mkdir(join(root, "sys/kernel/random"), { recursive: true });
      await writeFile(join(root, "stat"), `123 (runner) ${["S", ...Array(18).fill("0"), 1234].join(" ")}\n`);
      if (hasBootIdentity) await writeFile(join(root, "sys/kernel/random/boot_id"), "abcd-1234\n");
      const script = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT
        .replaceAll('"/proc/"+process.argv[1]+"/stat"', JSON.stringify(`${root}/stat`))
        .replaceAll("/proc/sys/kernel/random/boot_id", `${root}/sys/kernel/random/boot_id`);
      // Node is part of the remote runtime contract; awk is not required.
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink(process.execPath, join(bin, "node"));
      for (const name of ["mkdir", "chmod", "date", "mv"]) await symlink(execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(), join(bin, name));
      const marker = join(root, "identity");
      const result = execFileSync("/bin/sh", ["-c", script, "launch", marker, "nonce", "runner", join(root, "diagnostics"), "/bin/sh", "-c", "printf launched"], { env: { ...process.env, PATH: bin }, encoding: "utf8" });
      expect(result).toBe("launched");
      const lines = (await readFile(marker, "utf8")).split("\n");
      expect(lines[4]).toBe(hasBootIdentity ? "linux:abcd-1234:1234" : "");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("persistent computer runtime storage", () => {
  it("isolates agents and sessions sharing one project while keeping warm roots stable", () => {
    const target = (agent: string) => ({ kind: "remote", transport: "computer", remoteCwd: "/shared/project",
      fileAuthority: { kind: "remote-persistent", root: "/shared/project", placementId: "shared", agentHome: `/home/user/paperclip/company/agents/${agent}` },
    } as never);
    const a = remoteRunnerStorageRoots(target("a"), "session-1");
    const b = remoteRunnerStorageRoots(target("b"), "session-1");
    expect(a.runtimeRoot).not.toBe(b.runtimeRoot);
    expect(a.runtimeRoot).toContain("/agents/a/.paperclip-runtime/");
    expect(a.sessionRoot).toBe(a.runtimeRoot);
    expect(remoteRunnerStorageRoots(target("a"), "session-1")).toEqual(a);
    expect(remoteRunnerStorageRoots(target("a"), "session-2").runtimeRoot).not.toBe(a.runtimeRoot);
    expect((target("a") as { remoteCwd: string }).remoteCwd).toBe("/shared/project");
    expect(() => remoteRunnerStorageRoots({ kind: "remote", transport: "computer", remoteCwd: "/shared/project" } as never, "session")).toThrow("runner_remote_storage_home_missing");
  });
  it("preserves existing sandbox runtime and session paths", () => {
    const roots = remoteRunnerStorageRoots({ kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } as never, "session-1");
    expect(roots.runtimeRoot).toBe("/workspace/.paperclip-runtime/paperclip-runner");
    expect(roots.sessionRoot).toBe(`${roots.runtimeRoot}/sessions/${createHash("sha256").update("session-1").digest("hex")}`);
  });
});

describe("remote runner process supervision", () => {
  it("admits a valid computer identity when the supervised RPC takes longer than two seconds", async () => {
    vi.useFakeTimers();
    try {
      let nonce = "";
      const launch = vi.fn(async (request: { args: string[] }) => { nonce = request.args[4]!; });
      const execute = vi.fn(async (request: { args: string[]; timeoutMs?: number }) => {
        const label = request.args[2];
        const result = { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" };
        if (label === "paperclip-runner-process-identity") {
          const elapsed = Math.min(3_000, request.timeoutMs ?? 0);
          await new Promise(resolve => setTimeout(resolve, elapsed));
          return { ...result, timedOut: elapsed < 3_000,
            stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\ncomputer-runner\nlinux:abcd-1234:100\n` };
        }
        if (label === "paperclip-runner-monitor") return { ...result, exitCode: 3 };
        if (label === "paperclip-runner-diagnostics") return result;
        return { ...result, stdout: Buffer.from("{}").toString("base64") };
      });
      const onSpawn = vi.fn();
      const launcher = createRemoteRunnerProcessLauncher({
        target: { kind: "remote", transport: "computer", remoteCwd: "/home/user/project", launch } as never,
        runner: { execute } as never, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/state/identity",
        stateDirectory: "/runtime/state", diagnosticsDirectory: "/runtime/logs", runnerInstanceId: "computer-runner", onSpawn,
      });
      const handle = launcher({ command: "/controller/runnerd", args: ["--runner-id", "computer-runner"], cwd: "/controller", environment: {} });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(onSpawn).toHaveBeenCalledExactlyOnceWith({ pid: 4321, processGroupId: null, startedAt: "2026-09-06T00:00:00.000Z" });
      await expect(handle.completion).resolves.toMatchObject({ code: null });
      expect(execute.mock.calls.filter(([request]) => request.args[2] === "paperclip-runner-process-identity")).toHaveLength(1);
      expect(execute.mock.calls.some(([request]) => request.args[2] === "paperclip-runner-identity-failure-cleanup")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(["timeout", "ssh_failure", "rejected_rpc"] as const)(
    "keeps the admitted process after a transient %s monitor failure", async failure => {
      vi.useFakeTimers();
      try {
        let nonce = "";
        let polls = 0;
        const launch = vi.fn(async (request: { args: string[] }) => { nonce = request.args[4]!; });
        const execute = vi.fn(async (request: { args: string[] }) => {
          const label = request.args[2];
          const result = { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" };
          if (label === "paperclip-runner-process-identity") return { ...result,
            stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\ncomputer-runner\nlinux:abcd-1234:100\n` };
          if (label === "paperclip-runner-monitor") {
            polls += 1;
            if (polls === 1) {
              if (failure === "rejected_rpc") throw new Error("SSH connection reset");
              return { ...result, exitCode: failure === "timeout" ? 3 : 255, timedOut: failure === "timeout" };
            }
            return { ...result, exitCode: polls === 3 ? 4 : 0 };
          }
          if (label === "paperclip-runner-diagnostics") return result;
          return { ...result, stdout: Buffer.from("{}").toString("base64") };
        });
        const launcher = createRemoteRunnerProcessLauncher({
          target: { kind: "remote", transport: "computer", remoteCwd: "/home/user/project", launch } as never,
          runner: { execute } as never, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/state/identity",
          stateDirectory: "/runtime/state", diagnosticsDirectory: "/runtime/logs", runnerInstanceId: "computer-runner",
        });
        const handle = launcher({ command: "/controller/runnerd", args: ["--runner-id", "computer-runner"], cwd: "/controller", environment: {} });
        let settled = false;
        void handle.completion.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(1_100);
        expect(polls).toBe(2);
        expect(settled).toBe(false);
        expect(launch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(handle.completion).resolves.toMatchObject({ stderr: "runner_remote_process_identity_mismatch" });
        expect(polls).toBe(3);
      } finally { vi.useRealTimers(); }
    },
  );

  it("bounds inconclusive process monitoring without claiming the process exited", async () => {
    vi.useFakeTimers();
    try {
      let nonce = "";
      const launch = vi.fn(async (request: { args: string[] }) => { nonce = request.args[4]!; });
      const execute = vi.fn(async (request: { args: string[] }) => ({
        exitCode: request.args[2] === "paperclip-runner-monitor" ? 255 : 0,
        timedOut: false, signal: null, stderr: "",
        stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\ncomputer-runner\nlinux:abcd-1234:100\n`,
      }));
      const launcher = createRemoteRunnerProcessLauncher({
        target: { kind: "remote", transport: "computer", remoteCwd: "/home/user/project", launch } as never,
        runner: { execute } as never, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/state/identity",
        stateDirectory: "/runtime/state", diagnosticsDirectory: "/runtime/logs", runnerInstanceId: "computer-runner",
      });
      const handle = launcher({ command: "/controller/runnerd", args: ["--runner-id", "computer-runner"], cwd: "/controller", environment: {} });
      const completion = expect(handle.completion).rejects.toThrow("runner_remote_process_monitor_unavailable exitCode=255 timedOut=false");
      await vi.advanceTimersByTimeAsync(2_100);
      await completion;
      expect(launch).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("launches a computer runner through owned process admission, never detached shell allocation", async () => {
    let nonce = "";
    const launch = vi.fn(async (request: { args: string[] }) => { nonce = request.args[4]!; return {}; });
    const execute = vi.fn(async (request: { args: string[] }) => {
      const label = request.args[2];
      return { exitCode: label === "paperclip-runner-monitor" ? 3 : 0, timedOut: false, signal: null,
        stdout: label === "paperclip-runner-process-identity" ? `${nonce}\n4321\n2026-09-06T00:00:00.000Z\ncomputer-runner\nlinux:abcd-1234:100\n`
          : label === "paperclip-runner-diagnostics" ? "stopped" : Buffer.from('{}').toString('base64'), stderr: "" };
    });
    const launcher = createRemoteRunnerProcessLauncher({
      target: { kind: "remote", transport: "computer", remoteCwd: "/home/user/project", launch } as never,
      runner: { execute } as never, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/state/identity",
      stateDirectory: "/runtime/state", diagnosticsDirectory: "/runtime/logs", runnerInstanceId: "computer-runner",
    });
    const handle = launcher({ command: "/controller/runnerd", args: ["--runner-id", "computer-runner"], cwd: "/controller", environment: {} });
    await handle.completion;
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0].args).toContain("/runtime/runnerd");
    expect(launch.mock.calls[0]![0].args[1]).not.toContain("nohup");
    expect(execute.mock.calls.every(([request]) => request.args[2] !== "paperclip-runner-launch")).toBe(true);
    expect(handle.child.pid).toBe(4321);
  });

  it.each(["delivered", "sandbox_missing", "logging_failed"] as const)(
    "detaches runnerd and contains asynchronous signal failures (%s)", async (signalOutcome) => {
    let launchNonce = "";
    const execute = vi.fn(
      async (input: {
        command?: string;
        args?: string[];
        timeoutMs?: number;
        useSession?: boolean;
        bypassSession?: boolean;
      }) => {
        const label = input.args?.[2];
        if (label === "paperclip-runner-launch") {
          launchNonce = input.args?.[4] ?? "";
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        }
        if (label === "paperclip-runner-process-identity") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: `${launchNonce}\n4321\n2026-09-06T00:00:00.000Z\nrunner-remote\n`,
            stderr: "",
          };
        }
        if (label === "paperclip-runner-monitor") {
          return {
            exitCode: 3,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        }
        if (label === "paperclip-runner-diagnostics") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "paperclip-runnerd: provider transport closed",
            stderr: "",
          };
        }
        if (input.command === "sh" && input.args?.[1]?.includes("base64")) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: Buffer.from(
              JSON.stringify({
                lifecycle: "ready",
                diagnostics: ["last durable diagnostic"],
              }),
            ).toString("base64"),
            stderr: "",
          };
        }
        if (label === "paperclip-runner-signal") {
          if (signalOutcome !== "delivered") throw new Error("Sandbox with ID test-deleted-sandbox not found");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        }
        throw new Error(`unexpected remote command: ${label ?? "missing"}`);
      },
    );
    const onSpawn = vi.fn(async () => undefined);
    const onLog = vi.fn(async () => {
      if (signalOutcome === "logging_failed") throw new Error("Run log already closed");
    });
    const launcher = createRemoteRunnerProcessLauncher({
      target: {
        kind: "remote",
        transport: "sandbox",
        environmentId: "environment-remote",
        leaseId: "lease-remote",
        remoteCwd: "/workspace",
      },
      runner: { execute } as never,
      remoteBinary: "/runtime/paperclip-runnerd",
      processIdentityPath: "/runtime/runner-process.identity",
      stateDirectory: "/runtime",
      diagnosticsDirectory: "/runtime/diagnostics",
      runnerInstanceId: "runner-remote",
      onSpawn,
      onLog,
    });

    const handle = launcher({
      command: "/controller/paperclip-runnerd",
      args: ["--runner-id", "runner-remote"],
      cwd: "/controller",
      environment: {},
    });
    await expect(handle.completion).resolves.toMatchObject({
      code: null,
      stderr: "paperclip-runnerd: provider transport closed",
    });

    const launch = execute.mock.calls.find(
      ([input]) => input.args?.[2] === "paperclip-runner-launch",
    )?.[0];
    expect(launch).toMatchObject({
      timeoutMs: 20_000,
      bypassSession: true,
    });
    expect(launch?.useSession).toBeUndefined();
    expect(launch?.args?.[1]).toContain("nohup setsid");
    expect(launch?.args?.[6]).toContain('"$$"');
    expect(launch?.args?.[6]).toContain('exec "$@"');
    expect(launch?.args?.[7]).toBe("/runtime/diagnostics");
    expect(launch?.args).toContain("/runtime/diagnostics");
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith({
      pid: 4321,
      processGroupId: null,
      startedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(handle.child.pid).toBe(4321);

    expect(handle.child.kill("SIGKILL")).toBe(true);
    await vi.waitFor(() =>
      expect(
        execute.mock.calls.some(
          ([input]) =>
            input.args?.[2] === "paperclip-runner-signal" &&
            input.args?.[1]?.includes('kill -KILL "$expected_pid"'),
        ),
      ).toBe(true),
    );
    if (signalOutcome !== "delivered") {
      await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith(
        "stderr", "Remote runner signal failed; process termination is not confirmed.\n",
      ));
      // Let rejected logging callbacks settle too. Neither failure may escape
      // this fire-and-forget Node child-process-compatible kill boundary.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      expect(onLog).not.toHaveBeenCalled();
    }
    expect(handle.child.exitCode).toBeNull();
  });

  it.each(["missing marker", "missing fingerprint"])("terminates a detached runner with %s before admitting managed work", async kind => {
    vi.useFakeTimers();
    try {
      let launchNonce = "";
      const execute = vi.fn(
        async (input: { command?: string; args?: string[] }) => {
          const label = input.args?.[2];
          if (label === "paperclip-runner-launch") {
            launchNonce = input.args?.[4] ?? "";
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
            };
          }
          if (label === "paperclip-runner-process-identity") {
            return {
              exitCode: kind === "missing fingerprint" ? 0 : 3,
              signal: null,
              timedOut: false,
              stdout: kind === "missing fingerprint" ? `${launchNonce}\n4321\n2026-09-06T00:00:00.000Z\nrunner-remote\n` : "",
              stderr: "",
            };
          }
          if (label === "paperclip-runner-identity-failure-cleanup") {
            expect(input.args?.[4]).toBe(launchNonce);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
            };
          }
          throw new Error(`unexpected remote command: ${label ?? "missing"}`);
        },
      );
      const launcher = createRemoteRunnerProcessLauncher({
        target: {
          kind: "remote",
          transport: "sandbox",
          environmentId: "environment-remote",
          leaseId: "lease-remote",
          remoteCwd: "/workspace",
        },
        runner: { execute } as never,
        remoteBinary: "/runtime/paperclip-runnerd",
        processIdentityPath: "/runtime/runner-process.identity",
        stateDirectory: "/runtime",
        diagnosticsDirectory: "/runtime/diagnostics",
        runnerInstanceId: "runner-remote",
        requireProcessStartFingerprint: true,
      });

      const handle = launcher({
        command: "/controller/paperclip-runnerd",
        args: ["--runner-id", "runner-remote"],
        cwd: "/controller",
        environment: {},
      });
      const completion = expect(handle.completion).rejects.toThrow(
        "runner_remote_process_identity_unavailable",
      );
      await vi.advanceTimersByTimeAsync(20_100);
      await completion;

      const cleanup = execute.mock.calls.find(
        ([call]) =>
          call.args?.[2] === "paperclip-runner-identity-failure-cleanup",
      )?.[0];
      expect(cleanup).toMatchObject({
        bypassSession: true,
        timeoutMs: 20_000,
      });
      expect(cleanup?.args?.[1]).toContain('test "$nonce" = "$expected_nonce"');
      expect(cleanup?.args?.[1]).toContain('grep -Fqx -- "--runner-id"');
      expect(cleanup?.args?.[1]).toContain('kill -TERM -- "$signal_target"');
      expect(cleanup?.args?.[1]).toContain('kill -KILL -- "$signal_target"');
      expect(cleanup?.args?.[1]?.indexOf("rm -f --")).toBeGreaterThan(
        cleanup?.args?.[1]?.indexOf('kill -0 "$pid" 2>/dev/null && exit 5') ??
          Number.MAX_SAFE_INTEGER,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cleanup failure when a detached runner cannot be safely identified", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(
        async (input: { command?: string; args?: string[] }) => {
          const label = input.args?.[2];
          return {
            exitCode:
              label === "paperclip-runner-launch"
                ? 0
                : label === "paperclip-runner-process-identity"
                  ? 3
                  : label === "paperclip-runner-identity-failure-cleanup"
                    ? 4
                    : 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        },
      );
      const launcher = createRemoteRunnerProcessLauncher({
        target: {
          kind: "remote",
          transport: "sandbox",
          environmentId: "environment-remote",
          leaseId: "lease-remote",
          remoteCwd: "/workspace",
        },
        runner: { execute } as never,
        remoteBinary: "/runtime/paperclip-runnerd",
        processIdentityPath: "/runtime/runner-process.identity",
        stateDirectory: "/runtime",
        diagnosticsDirectory: "/runtime/diagnostics",
        runnerInstanceId: "runner-remote",
      });

      const handle = launcher({
        command: "/controller/paperclip-runnerd",
        args: ["--runner-id", "runner-remote"],
        cwd: "/controller",
        environment: {},
      });
      const completion = expect(handle.completion).rejects.toThrow(
        "runner_remote_process_identity_unavailable_cleanup_failed",
      );
      await vi.advanceTimersByTimeAsync(20_100);
      await completion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native incomplete-bootstrap evidence", () => {
  it("requires zero connections, zero events, and only untouched bootstrap commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-bootstrap-evidence-"));
    const controlPlaneRoot = join(root, "control-plane");
    await mkdir(controlPlaneRoot, { recursive: true });
    const statePath = join(controlPlaneRoot, "control-plane-state.json");
    const base = {
      schema: "paperclip.runner.durable.control-plane-state.v1",
      connectionCount: 0,
      committedEvents: [],
      commands: [
        { type: "run.prepare", status: "pending" },
        { type: "session.open", status: "pending" },
      ],
    };
    try {
      await writeFile(statePath, JSON.stringify(base));
      expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(true);

      for (const ambiguous of [
        { ...base, connectionCount: 1 },
        { ...base, committedEvents: [{ eventType: "harness.ready" }] },
        {
          ...base,
          commands: [{ type: "session.open", status: "completed" }],
        },
        {
          ...base,
          commands: [{ type: "turn.start", status: "pending" }],
        },
      ]) {
        await writeFile(statePath, JSON.stringify(ambiguous));
        expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("native provider usage normalization", () => {
  it.each([
    {}, { inputTokens: 1 }, { outputTokens: 1 },
    { inputTokens: 0, outputTokens: -1 }, { inputTokens: 0.5, outputTokens: 1 },
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 },
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: -1 },
  ])("does not invent complete native counters from %j", runDelta => {
    expect(normalizeNativeUsage({ runDelta, total: { inputTokens: 100, outputTokens: 10 } }, { inputIncludesCacheReads: true })).toBeUndefined();
  });
  it("does not use a cumulative price or protocol-default zero for an incomplete delta", () => {
    expect(nativeUsageCostUsd({ runDelta: { inputTokens: 10, outputTokens: 1 }, providerCostUsd: 100 })).toBeUndefined();
    expect(nativeUsageCostUsd({ runDelta: { providerCostUsd: 0 } })).toBeUndefined();
  });
  it.each([["cursor", "cursor"], ["copilot", "github"], ["pi", "openrouter"]] as const)("keeps %s cost unknown and attributes its actual biller", (agent, biller) => {
    const provider = { kind: "acpx", agent, model: "exact-model" } as NativeExecutionInput["provider"];
    expect(nativeUsageBiller(provider)).toBe(biller);
    const usage = { runDelta: { inputTokens: 100, outputTokens: 12, providerCostUsd: 0 }, cumulative: { providerCostUsd: 0.44 } };
    expect(nativeUsageCostUsd(usage, provider)).toBeUndefined();
    expect(normalizeNativeUsage(usage)).toMatchObject({ inputTokens: 100, outputTokens: 12 });
  });

  it("retains cache writes and avoids counting Codex cache hits twice", () => {
    expect(normalizeNativeUsage({ runDelta: { inputTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 5, outputTokens: 10 } }, { inputIncludesCacheReads: true }))
      .toEqual({ inputTokens: 20, cachedInputTokens: 100, cacheWriteTokens: 5, outputTokens: 10 });
  });
  it("does not treat a protocol-default price as free usage", () => {
    expect(nativeUsageCostUsd({ runDelta: { inputTokens: 20, outputTokens: 10, providerCostUsd: 0 } })).toBeUndefined();
  });
  it("reports the actual runtime billing identity", () => {
    expect(resolveNativeBilling({ kind: "opencode", model: "openrouter/deepseek/test", permissionMode: "allow" }))
      .toEqual({ provider: "deepseek", biller: "openrouter", billingType: "unknown" });
    expect(resolveNativeBilling({ kind: "acpx", agent: "claude", model: "claude-test", permissionMode: "approve-all",
      profile: { driverKind: "acpx_runtime", protocolVersion: 1, acpxVersion: "0.13.1", agent: "claude", agentProfileVersion: 1,
        agentServerPackage: "@zed-industries/claude-agent-acp", agentServerVersion: "1", agentRuntimePackage: null,
        agentRuntimeVersion: null, commandDigest: "fixture" },
    }, { ANTHROPIC_API_KEY: "test" }))
      .toEqual({ provider: "anthropic", biller: "anthropic", billingType: "metered_api" });
  });

  it("prefers the adjusted turn price to cumulative session prices", () => {
    expect(nativeUsageCostUsd({ providerCostUsd: 10, runDelta: { inputTokens: 10, providerCostUsd: 2, cacheAdjustedCostUsd: 1 } })).toBe(1);
  });
  it.each(["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_BASE_URL"])("does not price native or managed proxy traffic as direct OpenAI using %s", key => {
    const provider = { kind: "codex", model: "gpt-6-astra" } as Parameters<typeof resolveNativeBilling>[0];
    expect(resolveNativeBilling(provider, { OPENAI_API_KEY: "fixture", [key]: "https://proxy.example/v1" }).biller).toBe("unknown");
    expect(resolveNativeBilling(provider, { [key]: "https://proxy.example/v1" }, { provider: "openai", biller: "openai", billingType: "metered_api" }).biller).toBe("unknown");
    expect(resolveNativeBilling(provider, {}, { provider: "openai", biller: "openai", billingType: "metered_api" })).toMatchObject({ biller: "openai", billingType: "metered_api" });
  });

  it("reads remote runner run-delta tokens and provider cost", () => {
    const usage = {
      total: {
        inputTokens: 20_000,
        outputTokens: 500,
        cacheReadTokens: 8_000,
        providerCostUsd: 0.12,
      },
      runDelta: {
        inputTokens: 4_200,
        outputTokens: 180,
        cacheReadTokens: 1_500,
        providerCostUsd: 0.031,
      },
    };
    expect(normalizeNativeUsage(usage)).toEqual({
      inputTokens: 4_200,
      outputTokens: 180,
      cachedInputTokens: 1_500,
    });
    expect(nativeUsageCostUsd(usage)).toBe(0.031);
  });

  it("reads ACPX cumulative usage and a USD cost object", () => {
    const usage = {
      cumulative: {
        inputTokens: 3_000,
        outputTokens: 240,
        cachedReadTokens: 900,
      },
      cost: { amount: 0.044, currency: "USD" },
    };
    expect(normalizeNativeUsage(usage)).toEqual({
      inputTokens: 3_000,
      outputTokens: 240,
      cachedInputTokens: 900,
    });
    expect(nativeUsageCostUsd(usage)).toBe(0.044);
  });

  it("does not treat a non-USD ACPX amount as dollars", () => {
    expect(
      nativeUsageCostUsd({ cost: { amount: 1.25, currency: "EUR" } }),
    ).toBeUndefined();
  });
});

describe("remote provider pack manifest", () => {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };

  it.each(["opencode", "cursor"] as const)("uses the bundled Linux image authority for remote %s without controller overrides", async provider => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-bundled-image-"));
    const digest = "sha256:" + "a".repeat(64);
    const artifacts = Object.fromEntries(Object.entries({
      grokLauncher: "dist/providers/grok/launcher.cjs", nodeCommand: "node_modules/node/bin/node",
      productionLock: "pnpm-lock.yaml", opencodeCommand: "node_modules/.bin/opencode",
      opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
      opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
    }).map(([key, path]) => [key, { path, sha256: digest }]));
    const payload = {
      target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: "a".repeat(40),
      pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion,
        opencode: "1.18.34", acpx: "0.13.1", grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion,
        claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion },
      acpxProfileDigests: Object.fromEntries(["grok", "claude", "codex"].map(agent =>
        [agent, QUALIFIED_ACPX_PROFILES[agent as "grok" | "claude" | "codex"].commandDigest])),
      distDigest: digest, artifacts,
      bridgeDigest: "sha256:" + createHash("sha256").update(digest + "\n" + digest + "\n" + digest).digest("hex"),
    };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: "sha256:" + createHash("sha256").update(canonical(payload)).digest("hex") };
    state.bundledPackManifestPath = join(root, "provider-pack.json");
    state.bundledRunnerBinary = join(root, "linux-paperclip-runnerd");
    await writeFile(state.bundledPackManifestPath, JSON.stringify(manifest));
    await writeFile(state.bundledRunnerBinary, "verified Linux daemon fixture");
    const remoteExecution = { ...execution, provider: provider === "opencode"
      ? { kind: "opencode", model: null } : { kind: "acpx", agent: "cursor", model: null },
      session: { ...execution.session, driverKind: provider === "opencode" ? "opencode_server" : "acpx_runtime" },
    } as unknown as NativeExecutionInputV1;
    const syncIn = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: { command: string; args?: string[] }) => {
      if (command.args?.[0] === "--build-metadata") throw new Error("reached-staged-Linux-daemon-verification");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    });
    try {
      await createRunnerdBackend({ db: leaseDb(remoteExecution), execution: remoteExecution,
        runnerInstanceId: "bundled-image-runner", runnerIngressAuthorized: true,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace",
          environmentId: "environment", leaseId: "lease", providerKey: "daytona",
          effectiveCapabilities: { runnerWebSocketIngress: true }, runner: { execute, syncIn } } as never });
      state.createTransport.mockClear();
      state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
      const transport = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
        controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
      };
      expect(transport.runnerBinary).toBe(state.bundledRunnerBinary);
      await expect(transport.controlPlaneRegistration({})).rejects.toThrow("reached-staged-Linux-daemon-verification");
      expect(syncIn).toHaveBeenCalledWith([expect.objectContaining({ files: [expect.objectContaining({
        sourcePath: state.bundledRunnerBinary, targetPath: "/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd",
      })] })]);
      expect(execute.mock.calls.some(([call]) => call.args?.[1] === "uname -s; uname -m")).toBe(false);
    } finally {
      state.bundledPackManifestPath = null; state.bundledRunnerBinary = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a fully digested pack and rejects artifact tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-provider-pack-"));
    await mkdir(join(root, "dist", "cli"), { recursive: true });
    await mkdir(join(root, "node_modules", "node", "bin"), { recursive: true });
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(root, "node_modules", "opencode-ai", "bin"), {
      recursive: true,
    });
    const proxy = "export const proxy = true;\n";
    const sidecar = "export const sidecar = true;\n";
    const node = "provider-node\n";
    const lockfile = "lockfileVersion: '9.0'\n";
    const opencodeCommand = "#!/bin/sh\n";
    const opencodeExecutable = "opencode-binary\n";
    const grokLauncher = "grok-binary\n";
    await mkdir(join(root, "dist/providers/grok"), { recursive: true });
    await writeFile(join(root, "dist/providers/grok/launcher.cjs"), grokLauncher);
    await writeFile(
      join(root, "dist", "cli", "opencode-app-server-proxy.cjs"),
      proxy,
    );
    await writeFile(
      join(root, "dist", "cli", "acpx-runtime-sidecar.cjs"),
      sidecar,
    );
    await writeFile(join(root, "node_modules", "node", "bin", "node"), node);
    await writeFile(join(root, "pnpm-lock.yaml"), lockfile);
    await writeFile(
      join(root, "node_modules", ".bin", "opencode"),
      opencodeCommand,
    );
    await writeFile(
      join(root, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      opencodeExecutable,
    );
    const digest = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const proxySha = `sha256:${createHash("sha256").update(proxy).digest("hex")}`;
    const sidecarSha = `sha256:${createHash("sha256").update(sidecar).digest("hex")}`;
    const payload = {
      pins: {
        nodeMinimum: "24.11.0",
        codex: "0.160.0",
        opencode: "1.18.34",
        acpx: "0.13.1",
        claudeAcp: "0.73.0",
        codexAcp: "1.6.2",
        grok: "1.0.13",
      },
      target: { platform: "linux", architecture: "x64" },
      runnerSourceRevision: "1".repeat(40),
      distDigest: sha256DirectoryTree(join(root, "dist")),
      bridgeDigest: "",
      acpxProfileDigests: {
        grok: "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55",
        claude:
          "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
        codex:
          "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3",
      },
      artifacts: {
        grokLauncher: { path: "dist/providers/grok/launcher.cjs", sha256: digest(grokLauncher) },
        nodeCommand: {
          path: "node_modules/node/bin/node",
          sha256: digest(node),
        },
        productionLock: { path: "pnpm-lock.yaml", sha256: digest(lockfile) },
        opencodeCommand: {
          path: "node_modules/.bin/opencode",
          sha256: digest(opencodeCommand),
        },
        opencodeExecutable: {
          path: "node_modules/opencode-ai/bin/opencode.exe",
          sha256: digest(opencodeExecutable),
        },
        opencodeProxy: {
          path: "dist/cli/opencode-app-server-proxy.cjs",
          sha256: proxySha,
        },
        acpxSidecar: {
          path: "dist/cli/acpx-runtime-sidecar.cjs",
          sha256: sidecarSha,
        },
      },
    };
    payload.bridgeDigest = `sha256:${createHash("sha256")
      .update(proxySha)
      .update("\n")
      .update(sidecarSha)
      .update("\n")
      .update(payload.distDigest)
      .digest("hex")}`;
    const writeManifest = async () =>
      writeFile(
        join(root, "provider-pack.json"),
        JSON.stringify({
          schema: "paperclip-runner/remote-provider-pack/v1",
          digest: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`,
          payload,
        }),
      );
    await writeManifest();
    expect(readRemoteProviderPackManifest(root).payload.pins.opencode).toBe(
      "1.18.34",
    );
    const cursorPath = "provider-assets/cursor/linux-x64";
    await mkdir(join(root, cursorPath), { recursive: true });
    await writeFile(join(root, cursorPath, "runtime"), "pinned Cursor runtime");
    const cursor = { version: QUALIFIED_ACPX_PROFILES.cursor.agentServerVersion, profileDigest: QUALIFIED_ACPX_PROFILES.cursor.commandDigest,
      closureDigest: `sha256:${CURSOR_DISTRIBUTION_PINS["linux-x64"].closureSha256}`, qualification: "qualified", path: cursorPath,
      sha256: sha256DirectoryTree(join(root, cursorPath)) };
    Object.assign(payload, { providers: { cursor } });
    await writeManifest();
    expect(readRemoteProviderPackManifest(root).payload.providers?.cursor?.version).toBe(QUALIFIED_ACPX_PROFILES.cursor.agentServerVersion);
    const releaseMetadata = await mkdtemp(join(tmpdir(), "paperclip-image-identity-"));
    const manifestPath = join(releaseMetadata, "provider-pack.json");
    await cp(join(root, "provider-pack.json"), manifestPath);
    expect(readBundledRemoteProviderPackManifest(manifestPath).digest).toBe(readRemoteProviderPackManifest(root).digest);
    // Rehashing an internally valid old pack must not admit a different release.
    for (const field of ["version", "profileDigest", "closureDigest"] as const) {
      const previous = cursor[field];
      Object.assign(cursor, { [field]: field === "version" ? "older-cursor" : digest(`old-${field}`) });
      await writeManifest(); await cp(join(root, "provider-pack.json"), manifestPath);
      expect(() => readRemoteProviderPackManifest(root)).toThrow("Cursor profile or closure");
      expect(() => readBundledRemoteProviderPackManifest(manifestPath)).toThrow("Cursor profile or closure");
      Object.assign(cursor, { [field]: previous });
    }
    await writeManifest(); await cp(join(root, "provider-pack.json"), manifestPath);
    // A metadata-only release identity is never accepted as a host asset tree.
    expect(() => readRemoteProviderPackManifest(releaseMetadata)).toThrow();
    const originalTarget = payload.target;
    payload.target = { platform: "darwin", architecture: "arm64" };
    await writeManifest(); await cp(join(root, "provider-pack.json"), manifestPath);
    expect(() => readBundledRemoteProviderPackManifest(manifestPath)).toThrow();
    payload.target = originalTarget; await writeManifest();
    await rm(releaseMetadata, { recursive: true, force: true });
    await writeFile(join(root, cursorPath, "runtime"), "substitute Cursor runtime");
    expect(() => readRemoteProviderPackManifest(root)).toThrow("asset tree digest mismatch");
    await writeFile(join(root, cursorPath, "runtime"), "pinned Cursor runtime");
    const candidatePath = "provider-assets/pi/linux-x64";
    await mkdir(join(root, candidatePath), { recursive: true });
    await writeFile(join(root, candidatePath, "runtime"), "pinned runtime");
    const candidates = { pi: { version: "1.0.0", profileDigest: digest("profile"),
      closureDigest: digest("closure"), qualification: "qualified", path: candidatePath,
      sha256: sha256DirectoryTree(join(root, candidatePath)) } };
    Object.assign(payload, { candidateProviders: candidates });
    await writeManifest();
    expect(readRemoteProviderPackManifest(root).payload.candidateProviders?.pi?.qualification).toBe("qualified");
    // The normal pack builder publishes Pi in both inventories. A Pi image
    // must pass the same reader used by real remote runtime preparation.
    Object.assign(payload, { providers: { cursor, pi: candidates.pi } });
    await writeManifest();
    expect(readRemoteProviderPackManifest(root).payload.providers?.pi?.qualification).toBe("qualified");
    await mkdir(releaseMetadata, { recursive: true });
    await cp(join(root, "provider-pack.json"), manifestPath);
    expect(readBundledRemoteProviderPackManifest(manifestPath).payload.providers?.pi?.qualification).toBe("qualified");
    Object.assign(payload, { providers: { cursor } });
    await rm(releaseMetadata, { recursive: true, force: true });
    await writeManifest();
    await writeFile(join(root, candidatePath, "runtime"), "substitute runtime");
    expect(() => readRemoteProviderPackManifest(root)).toThrow("candidate asset tree digest mismatch");
    await writeFile(join(root, candidatePath, "runtime"), "pinned runtime");
    candidates.pi.qualification = "pending";
    await writeManifest();
    expect(() => readRemoteProviderPackManifest(root)).toThrow("invalid candidate identity");
    candidates.pi.qualification = "qualified";
    for (const invalid of [{ path: "../outside" }, { qualification: "unknown" }]) {
      const original = { ...candidates.pi };
      Object.assign(candidates.pi, invalid);
      await writeManifest();
      expect(() => readRemoteProviderPackManifest(root)).toThrow("invalid candidate identity");
      candidates.pi = original;
    }
    for (const provider of ["cursor", "copilot"]) {
      Object.assign(candidates, { [provider]: { ...candidates.pi, path: `provider-assets/${provider}/linux-x64` } });
      await writeManifest();
      expect(() => readRemoteProviderPackManifest(root)).toThrow(provider === "cursor" ? "Cursor profile or closure does not match this release" : "invalid candidate identity");
      delete (candidates as Record<string, unknown>)[provider];
    }
    await writeManifest();
    for (const [artifactName, substituteName] of [
      ["nodeCommand", "productionLock"],
      ["opencodeExecutable", "opencodeCommand"],
      ["opencodeProxy", "acpxSidecar"],
      ["acpxSidecar", "opencodeProxy"],
    ] as const) {
      const original = payload.artifacts[artifactName];
      payload.artifacts[artifactName] = {
        ...payload.artifacts[substituteName],
      };
      await writeManifest();
      expect(() => readRemoteProviderPackManifest(root)).toThrow(
        /path must be/,
      );
      payload.artifacts[artifactName] = original;
    }
    await writeManifest();
    await writeFile(
      join(root, "dist", "cli", "opencode-app-server-proxy.cjs"),
      "tampered\n",
    );
    expect(() => readRemoteProviderPackManifest(root)).toThrow(
      "OpenCode proxy digest mismatch",
    );
    await writeFile(
      join(root, "dist", "cli", "opencode-app-server-proxy.cjs"),
      proxy,
    );
    await writeFile(
      join(root, "dist", "cli", "transitive-runtime.js"),
      "changed transitive module\n",
    );
    expect(() => readRemoteProviderPackManifest(root)).toThrow(
      "provider dist tree digest mismatch",
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("provider pack read diagnostics", () => {
  it.each([
    ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"],
    ["EIO", "io_error"],
  ])("reports %s without exposing the underlying filesystem message", (code, reason) => {
    const root = join(tmpdir(), "private-provider-pack");
    const manifestPath = join(root, "provider-pack.json");
    const cause = Object.assign(new Error(`${code}: cannot read ${manifestPath}`), {
      code,
      path: manifestPath,
    });
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw cause; });
    let failure: Error | undefined;
    try { readRemoteProviderPackManifest(root); } catch (error) { failure = error as Error; }
    expect(readFileSync).toHaveBeenLastCalledWith(manifestPath, "utf8");
    expect(failure?.message).toBe(`runner_remote_provider_artifact_incompatible: provider-pack.json is unreadable (${reason})`);
    expect(failure?.message).not.toContain(root);
    expect(failure?.message).not.toContain(code);
    expect(failure?.cause).toBe(cause);
  });

  it("classifies a JSON null manifest as incompatible instead of a TypeError", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-null-pack-"));
    try {
      await writeFile(join(root, "provider-pack.json"), "null");
      expect(() => readRemoteProviderPackManifest(root)).toThrow(
        "runner_remote_provider_artifact_incompatible: provider pack pins or source revision do not match",
      );
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["missing", "invalid_json", "invalid_path_type"])("reports %s without putting the path in the terminal message", async (reason) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-private-pack-"));
    try {
      const manifestPath = join(root, "provider-pack.json");
      if (reason === "invalid_json") await writeFile(manifestPath, "{ private-invalid-json");
      if (reason === "invalid_path_type") await mkdir(manifestPath);
      let failure: Error | undefined;
      try { readRemoteProviderPackManifest(root); } catch (error) { failure = error as Error; }
      expect(failure?.message).toBe(`runner_remote_provider_artifact_incompatible: provider-pack.json is unreadable (${reason})`);
      expect(failure?.message).not.toContain(root);
      expect(failure?.message).not.toContain("private-invalid-json");
      expect(failure?.cause).toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("native harness persistence profiles", () => {
  const profile = (provider: Record<string, unknown>, driverKind: string) =>
    resolveNativeHarnessPersistenceProfile({
      provider,
      session: {
        driverKind,
        normalizedSessionId: "session",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
    } as unknown as NativeExecutionInputV1);

  it.each([
    ["codex", { kind: "codex" }, "codex_app_server", ["runner", "codex-home"]],
    [
      "opencode",
      { kind: "opencode" },
      "opencode_server",
      ["runner", "opencode"],
    ],
    [
      "acpx pi",
      { kind: "acpx", agent: "pi" },
      "acpx_runtime",
      ["runner", "acpx"],
    ],
    [
      "acpx claude",
      { kind: "acpx", agent: "claude" },
      "acpx_runtime",
      ["runner", "acpx"],
    ],
    [
      "acpx codex",
      { kind: "acpx", agent: "codex" },
      "acpx_runtime",
      ["runner", "acpx"],
    ],
  ])(
    "declares the complete %s recovery state",
    (_name, provider, driver, directories) => {
      expect(
        profile(
          provider as Record<string, unknown>,
          driver as string,
        ).directories.map((directory) => directory.name),
      ).toEqual(directories);
    },
  );

  it("excludes disposable Codex scratch trees and launch-time credentials", () => {
    const codex = profile({ kind: "codex" }, "codex_app_server");
    expect(
      codex.directories.find((directory) => directory.name === "codex-home"),
    ).toMatchObject({
      excludeEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
    });
  });

  it("excludes only nested Codex launch state from ACPX recovery", () => {
    const acpx = profile({ kind: "acpx", agent: "codex" }, "acpx_runtime");
    const sessionDirectory = acpxRuntimeSessionDirectoryName("session");
    expect(
      acpx.directories.find((directory) => directory.name === "acpx"),
    ).toMatchObject({
      excludeEntries: [
        `acpx/${sessionDirectory}/codex-home/tmp`,
        `acpx/${sessionDirectory}/codex-home/.tmp`,
        `acpx/${sessionDirectory}/codex-home/auth.json`,
        `acpx/${sessionDirectory}/codex-home/config.toml`,
      ],
    });
    expect(
      profile(
        { kind: "acpx", agent: "claude" },
        "acpx_runtime",
      ).directories.find((directory) => directory.name === "acpx"),
    ).toMatchObject({ excludeEntries: [] });
  });
});

describe("verified native harness backups", () => {
  const backupExecution = {
    provider: { kind: "codex", model: "gpt-5.6-sol", approvalPolicy: "never" },
    binding: {
      companyId: "company",
      runId: "run",
      issueId: "issue",
      agentId: "agent",
      executionWorkspaceId: "workspace",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: "https://example.test/repo.git",
      repoRef: "main",
      branchName: "paperclip/test",
    },
    session: {
      normalizedSessionId: "native-session",
      driverKind: "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
  } as unknown as NativeExecutionInputV1;

  const acpxIdentity = (suffix: string) => ({
    providerSessionId: `record-${suffix}`,
    providerBackendSessionId: `backend-${suffix}`,
    providerSessionIdentity: {
      kind: "acpx",
      normalizedSessionId: "native-session",
      acpxRecordId: `record-${suffix}`,
      backendSessionId: `backend-${suffix}`,
      agentSessionId: `agent-session-${suffix}`,
      profileDigest: "sha256:profile",
      workspaceDigest: "sha256:workspace",
      requestedModel: "claude-sonnet-5",
      effectiveModel: "claude-sonnet-5",
      permissionMode: "approve-all",
    },
  });

  it("allows only identity-stable ACPX rotation after a governed interaction", () => {
    const execution = {
      ...backupExecution,
      provider: {
        kind: "acpx",
        agent: "claude",
        model: "claude-sonnet-5",
      },
      session: {
        ...backupExecution.session,
        driverKind: "acpx_runtime",
      },
      interactionResponses: [{ interactionId: "interaction-1" }],
    } as unknown as NativeExecutionInputV1;
    const previous = acpxIdentity("previous");
    const current = acpxIdentity("current");

    expect(
      providerSessionIdentityTransitionIsAllowed({
        execution,
        previous,
        current,
      }),
    ).toBe(true);
    expect(
      providerSessionIdentityTransitionIsAllowed({
        execution: {
          ...execution,
          interactionResponses: [],
        } as unknown as NativeExecutionInputV1,
        previous,
        current,
      }),
    ).toBe(false);
    expect(
      providerSessionIdentityTransitionIsAllowed({
        execution,
        previous,
        current: {
          ...current,
          providerSessionIdentity: {
            ...current.providerSessionIdentity,
            workspaceDigest: "sha256:different-workspace",
          },
        },
      }),
    ).toBe(false);
    expect(
      providerSessionIdentityTransitionIsAllowed({
        execution,
        previous,
        current: {
          ...current,
          providerBackendSessionId: "unbound-backend",
        },
      }),
    ).toBe(false);
  });

  it("binds Cursor mode across governed and identical recovery identities", () => {
    const execution = {
      ...backupExecution,
      provider: { kind: "acpx", agent: "cursor", model: "explicit-model", mode: "plan" },
      interactionResponses: [{ interactionId: "interaction-1" }],
    } as unknown as NativeExecutionInputV1;
    const identity = (suffix: string, mode: unknown) => {
      const value = acpxIdentity(suffix);
      return { ...value, providerSessionIdentity: { ...value.providerSessionIdentity, mode } };
    };
    const previous = identity("previous", "plan");
    const current = identity("current", "plan");
    expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current })).toBe(true);
    expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current: previous })).toBe(true);
    for (const mode of [undefined, null, "agent", "ask", "autopilot"]) {
      const wrong = identity("wrong", mode);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current: wrong })).toBe(false);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous: wrong, current })).toBe(false);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous: wrong, current: wrong })).toBe(false);
    }
    for (const provider of [
      { kind: "acpx", agent: "cursor", model: "explicit-model" },
      { kind: "acpx", agent: "copilot", model: "explicit-model" },
    ]) {
      expect(providerSessionIdentityTransitionIsAllowed({
        execution: { ...execution, provider } as unknown as NativeExecutionInputV1, previous, current,
      })).toBe(false);
    }
  });

  it("binds Pi thinking across governed and identical recovery identities", () => {
    const execution = {
      ...backupExecution,
      provider: { kind: "acpx", agent: "pi", model: "explicit-model", piThinkingLevel: "low" },
      interactionResponses: [{ interactionId: "interaction-1" }],
    } as unknown as NativeExecutionInputV1;
    const identity = (suffix: string, piThinkingLevel: unknown) => {
      const value = acpxIdentity(suffix);
      return { ...value, providerSessionIdentity: { ...value.providerSessionIdentity, piThinkingLevel } };
    };
    const previous = identity("previous", "low");
    const current = identity("current", "low");
    expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current })).toBe(true);
    expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current: previous })).toBe(true);
    for (const mode of [undefined, null, "high", "max", "medium"]) {
      const wrong = identity("wrong", mode);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous, current: wrong })).toBe(false);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous: wrong, current })).toBe(false);
      expect(providerSessionIdentityTransitionIsAllowed({ execution, previous: wrong, current: wrong })).toBe(false);
    }
    for (const provider of [
      { kind: "acpx", agent: "pi", model: "explicit-model" },
      { kind: "acpx", agent: "copilot", model: "explicit-model" },
      { kind: "acpx", agent: "copilot", model: "explicit-model", piThinkingLevel: "low" },
    ]) {
      expect(providerSessionIdentityTransitionIsAllowed({
        execution: { ...execution, provider } as unknown as NativeExecutionInputV1, previous, current,
      })).toBe(false);
    }
  });

  it("restores a verified continuation into an intentionally fresh non-reusable sandbox", () => {
    expect(
      shouldRestoreNativeHarnessBackupIntoSandbox({
        acquisitionOutcome: "created",
        reusableLeaseConfigured: false,
        backupAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldRestoreNativeHarnessBackupIntoSandbox({
        acquisitionOutcome: "created",
        reusableLeaseConfigured: true,
        backupAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldRestoreNativeHarnessBackupIntoSandbox({
        acquisitionOutcome: "created",
        reusableLeaseConfigured: false,
        backupAvailable: false,
      }),
    ).toBe(false);
  });

  it("accepts a complete digest-matched backup and rejects corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-harness-backup-"));
    try {
      const current = join(root, "failover-backups", "current");
      await mkdir(join(current, "runner"), { recursive: true });
      await mkdir(join(current, "codex-home", "sessions"), { recursive: true });
      await writeFile(
        join(current, "runner", "runner-state.json"),
        "runner-state",
      );
      await writeFile(
        join(current, "codex-home", "sessions", "thread.jsonl"),
        "thread-state",
      );
      const manifest = buildNativeHarnessBackupManifest({
        backupRoot: current,
        execution: backupExecution,
        runnerInstanceId: "runner-1",
        providerSessionIdentity: {
          providerSessionId: "thread-1",
          providerBackendSessionId: "session-1",
          providerSessionIdentity: null,
        },
        sourceProviderLeaseId: "sandbox-1",
        completedAt: "2026-08-26T00:00:00.000Z",
      });
      await writeFile(join(current, "manifest.json"), JSON.stringify(manifest));

      expect(
        verifyNativeHarnessBackup({
          root,
          execution: backupExecution,
          runnerInstanceId: "runner-1",
        }),
      ).toMatchObject({
        root: current,
        manifest: {
          sourceProviderLeaseId: "sandbox-1",
          directories: [
            expect.objectContaining({ name: "runner" }),
            expect.objectContaining({ name: "codex-home" }),
          ],
        },
      });

      const continuationExecution = {
        ...backupExecution,
        binding: {
          ...backupExecution.binding,
          runId: "run-2",
          executionWorkspaceId: "run-2",
        },
      } as NativeExecutionInputV1;
      expect(
        verifyNativeHarnessBackup({
          root,
          execution: continuationExecution,
          runnerInstanceId: "runner-1",
        }),
      ).not.toBeNull();

      await writeFile(
        join(current, "codex-home", "sessions", "thread.jsonl"),
        "corrupt",
      );
      expect(
        verifyNativeHarnessBackup({
          root,
          execution: backupExecution,
          runnerInstanceId: "runner-1",
        }),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a backup whose provider identity or harness contract changed", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-harness-backup-identity-"),
    );
    try {
      const current = join(root, "failover-backups", "current");
      await mkdir(join(current, "runner"), { recursive: true });
      await mkdir(join(current, "codex-home"), { recursive: true });
      await writeFile(
        join(current, "runner", "runner-state.json"),
        "runner-state",
      );
      expect(() =>
        buildNativeHarnessBackupManifest({
          backupRoot: current,
          execution: backupExecution,
          runnerInstanceId: "runner-1",
          providerSessionIdentity: {
            providerSessionId: null,
            providerBackendSessionId: null,
            providerSessionIdentity: null,
          },
          sourceProviderLeaseId: "sandbox-1",
        }),
      ).toThrow("runner_harness_state_mismatch: backup_provider_identity_missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies the lease stamp and all backup directory digests before replacement", async () => {
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-harness-stamp-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    try {
      const sessionScopeId = "native-session-scope-v2";
      const sessionRoot = join(
        stateBase,
        createHash("sha256").update(sessionScopeId).digest("hex"),
      );
      const current = join(sessionRoot, "failover-backups", "current");
      await mkdir(join(current, "runner"), { recursive: true });
      await mkdir(join(current, "codex-home", "sessions"), { recursive: true });
      await writeFile(
        join(current, "runner", "runner-state.json"),
        "runner-state",
      );
      await writeFile(
        join(current, "codex-home", "sessions", "thread.jsonl"),
        "thread-state",
      );
      const manifest = buildNativeHarnessBackupManifest({
        backupRoot: current,
        execution: backupExecution,
        runnerInstanceId: "runner-1",
        providerSessionIdentity: {
          providerSessionId: "thread-1",
          providerBackendSessionId: "session-1",
          providerSessionIdentity: null,
        },
        sourceProviderLeaseId: "sandbox-1",
      });
      const manifestPath = join(current, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({
        manifestPath,
        sessionScopeId,
        authorizedProviderLeaseId: "sandbox-1",
        normalizedSessionId: "native-session",
        runnerInstanceId: "runner-1",
        completedAt: manifest.completedAt,
      });

      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-1")).toBe(true);
      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-2")).toBe(false);
      const reboundStamp = createNativeHarnessBackupStamp({
        manifestPath,
        sessionScopeId,
        authorizedProviderLeaseId: "sandbox-2",
        normalizedSessionId: "native-session",
        runnerInstanceId: "runner-1",
        completedAt: manifest.completedAt,
      });
      expect(verifyNativeHarnessBackupStamp(reboundStamp, "sandbox-2")).toBe(
        true,
      );
      await writeFile(join(current, "runner", "runner-state.json"), "corrupt");
      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-1")).toBe(false);
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("rejects a digest-valid legacy stamp for remote lease authorization", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-legacy-harness-stamp-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    try {
      const legacyRoot = join(
        stateBase,
        createHash("sha256").update("native-session").digest("hex"),
        "failover-backups",
        "current",
      );
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      await mkdir(join(legacyRoot, "codex-home", "sessions"), {
        recursive: true,
      });
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        "runner-state",
      );
      await writeFile(
        join(legacyRoot, "codex-home", "sessions", "thread.jsonl"),
        "thread-state",
      );
      const manifest = buildNativeHarnessBackupManifest({
        backupRoot: legacyRoot,
        execution: backupExecution,
        runnerInstanceId: "runner-1",
        providerSessionIdentity: {
          providerSessionId: "thread-1",
          providerBackendSessionId: "session-1",
          providerSessionIdentity: null,
        },
        sourceProviderLeaseId: "sandbox-1",
      });
      const manifestBytes = JSON.stringify(manifest);
      await writeFile(join(legacyRoot, "manifest.json"), manifestBytes);

      expect(
        verifyNativeHarnessBackupStamp(
          {
            schema: "paperclip.native-harness-backup-stamp.v1",
            normalizedSessionId: "native-session",
            runnerInstanceId: "runner-1",
            manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
            completedAt: manifest.completedAt,
          },
          "sandbox-1",
        ),
      ).toBe(false);
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });
});

describe("split durable provider checkpoint identity", () => {
  const execution = (provider: Record<string, unknown>, driverKind: string) =>
    ({
      provider,
      binding: {
        companyId: "company",
        runId: "run",
        issueId: "issue",
        agentId: "agent",
        executionWorkspaceId: "workspace",
      },
      workspace: { cwd: "/workspace" },
      session: {
        normalizedSessionId: "native-session",
        driverKind,
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
    }) as unknown as NativeExecutionInputV1;

  it.each(["agent", "plan", "ask", "architect"] as const)("requires both persisted provider mode bindings for %s recovery", mode => {
    const profileDigest = `sha256:${"a".repeat(64)}`;
    const input = execution({ kind: "acpx", agent: "cursor", model: "explicit-model", permissionMode: "approve-all", mode: mode }, "acpx_runtime");
    const identity = {
      kind: "acpx", normalizedSessionId: "native-session", acpxRecordId: "record",
      backendSessionId: "backend", agentSessionId: "agent-session", profileDigest,
      workspaceDigest: `sha256:${"b".repeat(64)}`, requestedModel: "explicit-model",
      effectiveModel: "explicit-model", permissionMode: "approve-all", mode: mode,
      providerLifetimeFenceCandidates: [53001, 53002, 53003],
    };
    const state = {
      schema: "paperclip.runner.acpx-provider-state.v3", lifecycle: "suspended",
      activeTurnId: null, providerExitUnconfirmed: false,
      descriptor: { kind: "acpx", provider: "acpx", driver: "acpx_runtime", agent: "cursor",
        model: "explicit-model", commandDigest: profileDigest, normalizedSessionId: "native-session", mode: mode },
      identity,
    };
    expect(providerSessionIdentityFromDurableProviderState({ execution: input, providerState: state })).toMatchObject({ providerSessionIdentity: identity });
    for (const field of ["descriptor", "identity"] as const) {
      for (const wrong of [undefined, mode === "agent" ? "plan" : "agent"]) {
        const changed = structuredClone(state);
        (changed[field] as Record<string, unknown>).mode = wrong;
        expect(providerSessionIdentityFromDurableProviderState({ execution: input, providerState: changed })).toEqual({ providerSessionId: null, providerBackendSessionId: null, providerSessionIdentity: null });
        expect(durableProviderCheckpointFailureReason(input, changed)).toBe("mode_binding");
      }
    }
    const unsettled = { ...state, providerExitUnconfirmed: true, privateProviderData: "secret-canary" };
    expect(providerSessionIdentityFromDurableProviderState({ execution: input, providerState: unsettled }).providerSessionIdentity).toBeNull();
    expect(durableProviderCheckpointFailureReason(input, unsettled)).toBe("provider_exit_unconfirmed");
  });

  it("reads ACPX identity from its provider-owned state after suspension", () => {
    const profileDigest = `sha256:${"a".repeat(64)}`;
    const identity = {
      kind: "acpx",
      normalizedSessionId: "native-session",
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-session-1",
      profileDigest,
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      requestedModel: "claude-sonnet-5",
      effectiveModel: "claude-sonnet-5",
      permissionMode: "approve-all",
      providerLifetimeFenceCandidates: [53001, 53002, 53003],
    };
    expect(
      providerSessionIdentityFromDurableProviderState({
        execution: execution(
          {
            kind: "acpx",
            agent: "claude",
            model: "claude-sonnet-5",
            permissionMode: "approve-all",
          },
          "acpx_runtime",
        ),
        providerState: {
          schema: "paperclip.runner.acpx-provider-state.v3",
          lifecycle: "suspended",
          activeTurnId: null,
          providerExitUnconfirmed: false,
          descriptor: {
            kind: "acpx",
            provider: "acpx",
            driver: "acpx_runtime",
            agent: "claude",
            model: "claude-sonnet-5",
            commandDigest: profileDigest,
            normalizedSessionId: "native-session",
          },
          identity,
        },
      }),
    ).toEqual({
      providerSessionId: "record-1",
      providerBackendSessionId: "backend-1",
      providerSessionIdentity: identity,
    });
  });

  it("requires the exact observed Cursor mode in suspended descriptor and identity", () => {
    const profileDigest = `sha256:${"a".repeat(64)}`;
    const input = execution({ kind: "acpx", agent: "cursor", model: "explicit-model", permissionMode: "deny-all", mode: "plan" }, "acpx_runtime");
    const providerState = {
      schema: "paperclip.runner.acpx-provider-state.v3", lifecycle: "suspended", activeTurnId: null, providerExitUnconfirmed: false,
      descriptor: { kind: "acpx", provider: "acpx", driver: "acpx_runtime", agent: "cursor", model: "explicit-model", commandDigest: profileDigest, normalizedSessionId: "native-session", mode: "plan" },
      identity: { kind: "acpx", normalizedSessionId: "native-session", acpxRecordId: "record-1", backendSessionId: "backend-1", agentSessionId: "agent-1", profileDigest,
        workspaceDigest: `sha256:${"b".repeat(64)}`, requestedModel: "explicit-model", effectiveModel: "explicit-model", permissionMode: "deny-all", mode: "plan", providerLifetimeFenceCandidates: [53001, 53002, 53003] },
    };
    const read = (state: unknown, candidate = input) => providerSessionIdentityFromDurableProviderState({ execution: candidate, providerState: state });
    expect(read(providerState).providerSessionIdentity).toEqual(providerState.identity);
    for (const mode of [undefined, null, "agent", "ask", "autopilot"]) {
      expect(read({ ...providerState, identity: { ...providerState.identity, mode } }).providerSessionIdentity).toBeNull();
      expect(read({ ...providerState, descriptor: { ...providerState.descriptor, mode } }).providerSessionIdentity).toBeNull();
      expect(read(providerState, execution({ ...input.provider, mode }, "acpx_runtime")).providerSessionIdentity).toBeNull();
    }
    const foreign = { ...providerState, descriptor: { ...providerState.descriptor, agent: "copilot" } };
    expect(read(foreign, execution({ ...input.provider, agent: "copilot", mode: undefined }, "acpx_runtime")).providerSessionIdentity).toBeNull();
    expect(read(foreign, execution({ ...input.provider, agent: "copilot", mode: "plan" }, "acpx_runtime")).providerSessionIdentity).toEqual(providerState.identity);
  });

  it.each([
    ["codex", "codex_app_server"],
    ["opencode", "opencode_server"],
  ] as const)(
    "reads %s identity from the split Codex-provider state",
    (provider, driverKind) => {
      expect(
        providerSessionIdentityFromDurableProviderState({
          execution: execution({ kind: provider }, driverKind),
          providerState: {
            schema: "paperclip.runner.codex-provider-state.v1",
            lifecycle: "prepared",
            config: { provider, driver: driverKind },
            threadId: "driver-session-1",
            providerSessionId: "provider-session-1",
            activeProviderTurnId: null,
            ambiguousTurnStartPending: false,
          },
        }),
      ).toEqual({
        providerSessionId: "driver-session-1",
        providerBackendSessionId: "provider-session-1",
        providerSessionIdentity: null,
      });
    },
  );

  it("rejects active or scope-conflicting provider state", () => {
    const profileDigest = `sha256:${"a".repeat(64)}`;
    const acpxExecution = execution(
      {
        kind: "acpx",
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-all",
      },
      "acpx_runtime",
    );
    for (const providerState of [
      {
        schema: "paperclip.runner.acpx-provider-state.v3",
        lifecycle: "turn_active",
        activeTurnId: "turn-1",
        providerExitUnconfirmed: false,
        descriptor: {
          kind: "acpx",
          provider: "acpx",
          driver: "acpx_runtime",
          agent: "claude",
          model: "claude-sonnet-5",
          commandDigest: profileDigest,
          normalizedSessionId: "native-session",
        },
        identity: {
          kind: "acpx",
          normalizedSessionId: "native-session",
          acpxRecordId: "record-1",
          backendSessionId: "backend-1",
          agentSessionId: "agent-session-1",
          profileDigest,
          workspaceDigest: `sha256:${"b".repeat(64)}`,
          requestedModel: "claude-sonnet-5",
          effectiveModel: "claude-sonnet-5",
          permissionMode: "approve-all",
          providerLifetimeFenceCandidates: [53001, 53002, 53003],
        },
      },
      {
        schema: "paperclip.runner.acpx-provider-state.v3",
        lifecycle: "suspended",
        activeTurnId: null,
        providerExitUnconfirmed: false,
        descriptor: {
          kind: "acpx",
          provider: "acpx",
          driver: "acpx_runtime",
          agent: "claude",
          model: "claude-sonnet-5",
          commandDigest: profileDigest,
          normalizedSessionId: "other-session",
        },
        identity: {
          kind: "acpx",
          normalizedSessionId: "other-session",
          acpxRecordId: "record-1",
          backendSessionId: "backend-1",
          agentSessionId: "agent-session-1",
          profileDigest,
          workspaceDigest: `sha256:${"b".repeat(64)}`,
          requestedModel: "claude-sonnet-5",
          effectiveModel: "claude-sonnet-5",
          permissionMode: "approve-all",
          providerLifetimeFenceCandidates: [53001, 53002, 53003],
        },
      },
    ]) {
      expect(
        providerSessionIdentityFromDurableProviderState({
          execution: acpxExecution,
          providerState,
        }),
      ).toEqual({
        providerSessionId: null,
        providerBackendSessionId: null,
        providerSessionIdentity: null,
      });
    }
  });

  it.each(["claude_managed", "aws_agentcore"] as const)(
    "reads %s identity from managed provider state",
    (provider) => {
      expect(
        providerSessionIdentityFromDurableProviderState({
          execution: execution({ kind: provider }, `${provider}_driver`),
          providerState: {
            schema: "paperclip.runner.managed-provider-state.v1",
            lifecycle: "suspended",
            normalizedSessionId: "native-session",
            descriptor: { kind: provider, config: {} },
            providerSessionId: "managed-session-1",
            activeTurnId: null,
          },
        }),
      ).toEqual({
        providerSessionId: "managed-session-1",
        providerBackendSessionId: "managed-session-1",
        providerSessionIdentity: null,
      });
    },
  );
});

describe("remote provider checkpoint snapshots", () => {
  it("excludes Grok credentials and diagnostic logs from real checkpoint copies while retaining sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-checkpoint-"));
    try {
      const source = join(root, "source");
      const target = join(root, "backup");
      const sessionDirectory = acpxRuntimeSessionDirectoryName("session");
      const relativeHome = join("acpx", sessionDirectory, "grok-home");
      const home = join(source, relativeHome);
      await mkdir(join(home, "logs"), { recursive: true });
      await mkdir(join(home, "sessions"));
      await writeFile(join(home, "logs", "unified.jsonl"), "AUTH_SENTINEL");
      await writeFile(join(home, "auth.json"), "AUTH_SENTINEL");
      await writeFile(join(home, "auth-refresh.json"), "AUTH_SENTINEL");
      await writeFile(join(home, "sessions", "session.json"), "resume-state");
      const profile = resolveNativeHarnessPersistenceProfile({
        provider: { kind: "acpx", agent: "grok" },
        session: { normalizedSessionId: "session", driverKind: "acpx_runtime" },
      } as unknown as NativeExecutionInputV1);
      const execute = async ({ command, args }: { command: string; args: string[] }) => ({
        exitCode: 0, timedOut: false, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "",
      });
      const syncOut = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
        for (const operation of operations) for (const file of operation.files)
          await cp(file.sourcePath, file.targetPath, { recursive: true });
      };
      await syncRemoteRunnerDirectoryOut({ runner: { execute, syncOut } as never,
        sourcePath: source, targetPath: target, mode: 0o700,
        excludeEntries: profile.directories.find(directory => directory.name === "acpx")!.excludeEntries });
      for (const entry of ["auth.json", "auth-refresh.json", "logs"])
        await expect(access(join(target, relativeHome, entry))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(target, relativeHome, "sessions", "session.json"), "utf8")).toBe("resume-state");
      expect(await readFile(join(home, "logs", "unified.jsonl"), "utf8")).toBe("AUTH_SENTINEL");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("excludes Codex scratch and credential state without mutating the live provider home", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
      });
    const syncOut = vi.fn(
      async (
        _operations: Array<{
          files: Array<{
            sourcePath: string;
            targetPath: string;
            kind: "file" | "directory";
            mode?: number;
          }>;
        }>,
      ) => undefined,
    );

    await syncRemoteRunnerDirectoryOut({
      runner: { execute, syncOut } as never,
      sourcePath: "/remote/session/filesystem/codex-home",
      targetPath: "/tmp/paperclip-checkpoint-test-codex-home",
      mode: 0o700,
      excludeEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
    });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ["-c", "test -d '/remote/session/filesystem/codex-home'"],
      }),
    );
    const snapshotCommand = String(execute.mock.calls[1]?.[0]?.args?.[1]);
    expect(snapshotCommand).toContain("'--exclude=./tmp'");
    expect(snapshotCommand).toContain("'--exclude=./.tmp'");
    expect(snapshotCommand).toContain("'--exclude=./auth.json'");
    expect(snapshotCommand).toContain("'--exclude=./config.toml'");
    expect(snapshotCommand).toContain(
      "-C '/remote/session/filesystem/codex-home'",
    );
    expect(snapshotCommand).not.toContain(
      "rm -rf -- '/remote/session/filesystem/codex-home'",
    );

    const batch = syncOut.mock.calls[0]?.[0]?.[0];
    expect(batch?.files[0]).toMatchObject({
      sourcePath: expect.stringMatching(
        /^\/remote\/session\/filesystem\/\.paperclip-checkpoint-/,
      ),
      targetPath: "/tmp/paperclip-checkpoint-test-codex-home",
      kind: "directory",
      mode: 0o700,
    });
    expect(String(execute.mock.calls[2]?.[0]?.args?.[1])).toMatch(
      /^rm -rf -- '\/remote\/session\/filesystem\/\.paperclip-checkpoint-/,
    );
  });

  it("omits nested ACPX-Codex scratch aliases without widening the exclusion", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
    const syncOut = vi.fn(async () => undefined);
    const sessionDirectory = acpxRuntimeSessionDirectoryName("session");
    const excluded = [
      `acpx/${sessionDirectory}/codex-home/tmp`,
      `acpx/${sessionDirectory}/codex-home/.tmp`,
      `acpx/${sessionDirectory}/codex-home/auth.json`,
      `acpx/${sessionDirectory}/codex-home/config.toml`,
    ];

    await syncRemoteRunnerDirectoryOut({
      runner: { execute, syncOut } as never,
      sourcePath: "/remote/session/filesystem/acpx",
      targetPath: "/tmp/paperclip-checkpoint-test-acpx",
      mode: 0o700,
      excludeEntries: excluded,
    });

    const snapshotCommand = String(execute.mock.calls[1]?.[0]?.args?.[1]);
    for (const entry of excluded) {
      expect(snapshotCommand).toContain(`'--exclude=./${entry}'`);
    }
    expect(snapshotCommand).not.toContain("--exclude=./acpx-state");
    expect(snapshotCommand).not.toContain("--exclude=./codex-home");
    expect(syncOut).toHaveBeenCalledOnce();
  });

  it("rejects unsafe relative checkpoint exclusions", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
    await expect(
      syncRemoteRunnerDirectoryOut({
        runner: { execute, syncOut: vi.fn() } as never,
        sourcePath: "/remote/codex-home",
        targetPath: "/tmp/paperclip-checkpoint-invalid-codex-home",
        mode: 0o700,
        excludeEntries: ["../outside"],
      }),
    ).rejects.toThrow("runner_remote_checkpoint_exclusion_invalid");
  });

  it("rejects unsafe fallback archives without replacing durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-checkpoint-unsafe-"));
    const archiveSource = join(root, "archive-source");
    const targetPath = join(root, "durable-target");
    try {
      await mkdir(archiveSource, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "preserved.txt"), "preserved");
      await symlink("/etc/passwd", join(archiveSource, "host-secret"));
      const archive = execFileSync(
        "tar",
        ["-czf", "-", "-C", archiveSource, "."],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          timedOut: false,
          stdout: archive.toString("base64"),
          stderr: "",
        });

      await expect(
        syncRemoteRunnerDirectoryOut({
          runner: { execute } as never,
          sourcePath: "/remote/codex-home",
          targetPath,
          mode: 0o700,
        }),
      ).rejects.toThrow("runner_remote_checkpoint_archive_unsafe_entry");
      await expect(
        access(join(targetPath, "preserved.txt")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("computer tool execution authority", () => {
  it.each(["standard", "planning", "ask"] as const)("only installs mutation-capable desktop tools for standard work (%s)", (workMode) => {
    const tool = { command: "cua-driver", args: ["mcp"] };
    const target = { kind: "remote", transport: "computer", computerTool: tool } as never;
    const input = { task: { workMode }, executionMode: "default" } as NativeExecutionInput;
    expect(nativeComputerToolForExecution(input, target)).toBe(workMode === "standard" ? tool : undefined);
    expect(nativeComputerToolForExecution({ ...input, executionMode: "plan" } as NativeExecutionInput, target)).toBeUndefined();
    expect(nativeComputerToolForExecution(input, { kind: "remote", transport: "sandbox" } as never)).toBeUndefined();
  });
});

describe("remote provider checkpoint restores", () => {
  it("budgets artifact upload time and retains redacted staging diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-file-"));
    const sourcePath = join(root, "runner");
    await writeFile(sourcePath, "fixture binary");
    const execute = vi.fn(async () => ({ exitCode: 255, timedOut: true,
      stdout: "", stderr: "Host key verification failed; Bearer abcdefghijkl" }));
    try {
      const stage = stageRemoteRunnerFile({
        target: { kind: "remote", transport: "computer" } as never,
        runner: { execute } as never, sourcePath, targetPath: "/private/runner", mode: 0o700,
      });
      await expect(stage).rejects.toThrow("exit=255 timedOut=true Host key verification failed");
      await expect(stage).rejects.not.toThrow("abcdefghijkl");
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 180_000 }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("uploads a binary in bounded chunks and preserves the installed binary on corruption=%s", async (corrupt) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-large-file-"));
    const sourcePath = join(root, "source");
    const targetPath = join(root, "remote runner's binary");
    const bytes = randomBytes(9 * 1024 * 1024 + 17);
    await writeFile(sourcePath, bytes);
    await writeFile(targetPath, "previous verified binary");
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
    const execute = vi.fn(async (request: { command: string; args: string[]; stdin?: string }) => {
      expect(request.stdin?.length ?? 0).toBeLessThanOrEqual(Math.ceil(4 * 1024 * 1024 / 3) * 4);
      if (request.stdin) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 3) releaseFirstBatch();
      }
      try {
        if (request.stdin) await firstBatch;
        const stdin = corrupt && request.stdin ? Buffer.from("corrupt").toString("base64") : request.stdin;
        execFileSync(request.command, request.args, { input: stdin });
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      } finally { if (request.stdin) inFlight--; }
    });
    try {
      const stage = stageRemoteRunnerFile({
        target: { kind: "remote", transport: "computer" } as never,
        runner: { execute } as never, sourcePath, targetPath, mode: 0o700,
      });
      if (corrupt) {
        await expect(stage).rejects.toThrow();
        expect(await readFile(targetPath, "utf8")).toBe("previous verified binary");
      } else {
        await stage;
        expect((await readFile(targetPath)).equals(bytes)).toBe(true);
        expect((await lstat(targetPath)).mode & 0o777).toBe(0o700);
      }
      expect(maxInFlight).toBe(3);
      expect((await readdir(root)).some((name) => name.includes(".upload-"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("shares eight upload slots across concurrent artifact transfers", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-upload-slots-"));
    const sourcePath = join(root, "source");
    await writeFile(sourcePath, randomBytes(20 * 1024 * 1024));
    let active = 0;
    let peak = 0;
    let releaseFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
    const execute = vi.fn(async (request: { command: string; args: string[]; stdin?: string }) => {
      if (request.stdin) {
        active++;
        peak = Math.max(peak, active);
        if (active === 8) releaseFirstBatch();
      }
      try {
        if (request.stdin) await firstBatch;
        execFileSync(request.command, request.args, { input: request.stdin });
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      } finally { if (request.stdin) active--; }
    });
    try {
      await Promise.all(["one", "two"].map(target => stageRemoteRunnerFile({
        target: { kind: "remote", transport: "computer" } as never,
        runner: { execute } as never, sourcePath, targetPath: join(root, target), mode: 0o700,
      })));
      expect(peak).toBe(8);
      expect(active).toBe(0);
      expect((await readFile(join(root, "one"))).equals(await readFile(join(root, "two")))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([{ sizeMiB: 0, corrupt: false }, { sizeMiB: 65, corrupt: false }, { sizeMiB: 0, corrupt: true }])("stages a $sizeMiB MiB provider pack through a command-only computer runner (corrupt=$corrupt)", async ({ sizeMiB, corrupt }) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-computer-pack-"));
    const sourcePath = join(root, "source");
    const targetPath = join(root, "remote pack's files");
    const manifest = JSON.stringify({ artifactDigest: "exact-release-digest" });
    try {
      await mkdir(join(sourcePath, "bin"), { recursive: true });
      await writeFile(join(sourcePath, "provider-pack.json"), manifest);
      await writeFile(join(sourcePath, "bin", "provider"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      if (process.platform === "darwin") {
        execFileSync("xattr", ["-w", "com.apple.metadata:paperclip-test", "fixture", join(sourcePath, "bin", "provider")]);
      }
      const chunk = randomBytes(1024 * 1024);
      const expectedDigest = createHash("sha256");
      const payload = await open(join(sourcePath, "payload.bin"), "w");
      try {
        for (let index = 0; index < sizeMiB; index++) {
          await payload.write(chunk);
          expectedDigest.update(chunk);
        }
      } finally { await payload.close(); }
      const execute = vi.fn(async (request: { command: string; args: string[]; stdin?: string }) => {
        expect(request.stdin?.length ?? 0).toBeLessThanOrEqual(Math.ceil(4 * 1024 * 1024 / 3) * 4);
        const stdin = corrupt && request.stdin
          ? Buffer.from(request.stdin, "base64").subarray(0, 32).toString("base64")
          : request.stdin;
        execFileSync(request.command, request.args, { input: stdin });
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      });
      const runner = { execute };
      const onProgress = vi.fn(async (_completed: number, _total: number) => undefined);
      const staging = stageRemoteRunnerDirectory({
        target: { kind: "remote", transport: "computer", remoteCwd: root, runner } as never,
        runner: runner as never,
        sourcePath,
        targetPath,
        mode: 0o700,
        onProgress,
      });
      if (corrupt) {
        await expect(staging).rejects.toThrow();
        await expect(access(targetPath)).rejects.toThrow();
        expect((await readdir(root)).some((name) => name.includes(".upload-"))).toBe(false);
        return;
      }
      await staging;
      expect(onProgress.mock.calls[0]![0]).toBe(0);
      expect(onProgress.mock.calls.at(-1)![0]).toBe(onProgress.mock.calls.at(-1)![1]);
      expect(await readFile(join(targetPath, "provider-pack.json"), "utf8")).toBe(manifest);
      expect((await lstat(join(targetPath, "bin", "provider"))).mode & 0o100).toBe(0o100);
      expect((await lstat(targetPath)).mode & 0o777).toBe(0o700);
      const actualDigest = execFileSync("shasum", ["-a", "256", join(targetPath, "payload.bin")], { encoding: "utf8" }).split(" ")[0];
      expect(actualDigest).toBe(expectedDigest.digest("hex"));
      const uploads = execute.mock.calls.filter(([request]) => request.stdin);
      expect(uploads).toHaveLength(sizeMiB ? 17 : 1);
      if (sizeMiB === 0) {
        const tarBytes = gunzipSync(Buffer.from(uploads[0]![0].stdin!, "base64"));
        expect(tarBytes.includes(Buffer.from("/._provider"))).toBe(false);
      }
      expect(execute.mock.calls[0]![0]).toMatchObject({ bypassSession: true });
      expect((await readdir(root)).some((name) => name.includes(".upload-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not upload excluded Codex scratch trees or credentials", async () => {
    const sourcePath = await mkdtemp(
      join(tmpdir(), "paperclip-codex-restore-source-"),
    );
    try {
      await mkdir(join(sourcePath, "sessions"), { recursive: true });
      await mkdir(join(sourcePath, ".tmp"), { recursive: true });
      await writeFile(
        join(sourcePath, "sessions", "thread.jsonl"),
        "durable session",
      );
      await writeFile(
        join(sourcePath, ".tmp", "scratch.bin"),
        "disposable scratch",
      );
      await writeFile(join(sourcePath, "auth.json"), "credential");
      await writeFile(join(sourcePath, "config.toml"), "bearer token");
      const syncIn = vi.fn(
        async (
          operations: Array<{
            files: Array<{ sourcePath: string }>;
          }>,
        ) => {
          const stagedPath = operations[0]!.files[0]!.sourcePath;
          expect(stagedPath).not.toBe(sourcePath);
          await expect(
            access(join(stagedPath, "sessions", "thread.jsonl")),
          ).resolves.toBeUndefined();
          await expect(
            access(join(stagedPath, ".tmp", "scratch.bin")),
          ).rejects.toThrow();
          await expect(access(join(stagedPath, "auth.json"))).rejects.toThrow();
          await expect(
            access(join(stagedPath, "config.toml")),
          ).rejects.toThrow();
        },
      );

      await stageRemoteRunnerDirectory({
        target: {
          kind: "remote",
          transport: "provider",
          remoteCwd: "/remote",
          runner: { syncIn } as never,
        } as never,
        runner: { syncIn } as never,
        sourcePath,
        targetPath: "/remote/codex-home",
        mode: 0o700,
        excludeEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
      });

      expect(syncIn).toHaveBeenCalledOnce();
    } finally {
      await rm(sourcePath, { recursive: true, force: true });
    }
  });
});

describe("remote preinstalled executable discovery", () => {
  it("stages a relative-path CLI shim without changing its installation or losing arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-shim-"));
    try {
      const installation = join(root, "image install's bin");
      const target = join(root, "workspace", "bin", "codex");
      const source = join(installation, "codex");
      await mkdir(installation, { recursive: true });
      await mkdir(join(root, "workspace", "bin"), { recursive: true });
      const shim =
        '#!/bin/sh\ncat "$(dirname "$0")/version.txt"\nprintf "%s\\n" "$@"\n';
      await writeFile(source, shim, { mode: 0o755 });
      await writeFile(join(installation, "version.txt"), "codex-cli 0.160.0\n");
      // Existing deployments may already have the old symlink. Never write
      // through it into the shared installation while upgrading the launcher.
      await symlink(source, target);
      for (let pass = 0; pass < 2; pass++) {
        execFileSync("sh", [
          "-c",
          buildRemoteCodexLauncherCommand(source, target),
        ]);
        expect(
          execFileSync(target, ["--version", "argument with 'quotes'"], {
            encoding: "utf8",
          }),
        ).toBe("codex-cli 0.160.0\n--version\nargument with 'quotes'\n");
        expect(await readFile(source, "utf8")).toBe(shim);
      }
      expect(await readdir(join(root, "workspace", "bin"))).toEqual(["codex"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts one normalized absolute executable path", () => {
    expect(
      parseRemoteExecutableCandidate(
        "/home/daytona/.local/bin/paperclip-runnerd\n",
      ),
    ).toBe("/home/daytona/.local/bin/paperclip-runnerd");
  });

  it.each([
    "paperclip-runnerd\n",
    "/safe/path\n/unexpected/second-line\n",
    "/safe/path with spaces\n",
    "/safe/path;touch-bad\n",
  ])("rejects ambiguous or shell-active output: %j", (stdout) => {
    expect(parseRemoteExecutableCandidate(stdout)).toBeNull();
  });

  it("does not accept a merely contract-compatible runnerd when a build-owned artifact is configured", () => {
    expect(
      mayUsePreinstalledRunnerArtifact("/artifacts/paperclip-runnerd"),
    ).toBe(false);
    expect(mayUsePreinstalledRunnerArtifact("  ")).toBe(true);
    expect(mayUsePreinstalledRunnerArtifact(undefined)).toBe(true);
  });
});

describe("remote runner build metadata", () => {
  it("accepts only an exact remote runner process identity marker", () => {
    const expected = {
      nonce: "launch-nonce",
      runnerInstanceId: "runner-remote-process",
    };
    expect(
      parseRemoteRunnerProcessIdentity(
        "launch-nonce\n4102\n2026-09-06T04:20:30.123Z\nrunner-remote-process\n",
        expected,
      ),
    ).toEqual({
      pid: 4102,
      startedAt: "2026-09-06T04:20:30.123Z",
    });
    expect(
      parseRemoteRunnerProcessIdentity(
        "stale-nonce\n4102\n2026-09-06T04:20:30.123Z\nrunner-remote-process\n",
        expected,
      ),
    ).toBeNull();
    expect(
      parseRemoteRunnerProcessIdentity(
        "launch-nonce\n4102\n2026-09-06T04:20:30.123Z\nwrong-runner\n",
        expected,
      ),
    ).toBeNull();
    expect(
      parseRemoteRunnerProcessIdentity(
        "launch-nonce\nnot-a-pid\n2026-09-06T04:20:30.123Z\nrunner-remote-process\n",
        expected,
      ),
    ).toBeNull();
  });

  const current = {
    schema: "paperclip-runner/runnerd-build-metadata/v1",
    binaryName: "paperclip-runnerd",
    packageName: "@paperclipai/paperclip-runner",
    binaryContractVersion: 2,
    durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
    prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
  };

  it("accepts the current contract with the required transport", () => {
    expect(() =>
      assertRemoteRunnerBuildMetadata(current, "listen_ws"),
    ).not.toThrow();
  });

  it("requires an explicit Dot bridge capability only for remote Dot execution", () => {
    expect(() => assertRemoteRunnerBuildMetadata(current, "listen_ws", "openai_dot_mcp"))
      .toThrow("runner_remote_dot_capability_missing");
    expect(() => assertRemoteRunnerBuildMetadata({ ...current, externalProviderCapabilities: ["openai_dot_mcp"] },
      "listen_ws", "openai_dot_mcp")).not.toThrow();
    expect(() => assertRemoteRunnerBuildMetadata(current, "listen_ws")).not.toThrow();
  });

  it("fails before dispatch when a preinstalled runner uses the stale contract", () => {
    expect(() =>
      assertRemoteRunnerBuildMetadata(
        {
          ...current,
          binaryContractVersion: 1,
        },
        "listen_ws",
      ),
    ).toThrow("runner_remote_artifact_contract_incompatible");
  });

  it.each([undefined, [], ["unlimited_runtime"], ["connection_lease_renewal"]])(
    "rejects a contract-v2 image without current durable session capabilities: %j",
    (durableSessionCapabilities) => {
      expect(() => assertRemoteRunnerBuildMetadata({ ...current, durableSessionCapabilities }, "listen_ws"))
        .toThrow("runner_remote_session_capability_missing:");
    },
  );

  it("requires the selected transport without falling through", () => {
    expect(() =>
      assertRemoteRunnerBuildMetadata(
        {
          ...current,
          prpTransportModes: ["dial_wss"],
        },
        "listen_ws",
      ),
    ).toThrow("runner_remote_transport_capability_missing:listen_ws");
  });
});

describe("remote runner transport authorization", () => {
  const ingressTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/workspace",
    leaseId: "lease-1",
    effectiveCapabilities: { runnerWebSocketIngress: true },
  } as const;

  it("fails before selecting sandbox ingress for an unauthorized run", () => {
    expect(() =>
      resolveRemoteRunnerTransportMode({
        target: ingressTarget as never,
        runnerIngressAuthorized: false,
      }),
    ).toThrow("runner_ingress_unavailable");
  });

  it("selects sandbox ingress for a resolved native run", () => {
    expect(
      resolveRemoteRunnerTransportMode({
        target: ingressTarget as never,
        runnerIngressAuthorized: true,
      }),
    ).toBe("listen_ws");
  });
});

describe("required remote checkpoint completion", () => {
  it.each(["unavailable", "not_suspended"] as const)(
    "fails a settled runner when its checkpoint is %s",
    (incompleteReason) => {
      expect(
        remoteCheckpointIncompleteFailure("settled", incompleteReason),
      ).toMatchObject({
        message: `runner_remote_checkpoint_incomplete: exact suspended harness state unavailable (${incompleteReason})`,
      });
    },
  );

  it("preserves the original startup error for a runner that never settled", () => {
    expect(
      remoteCheckpointIncompleteFailure("unsettled", "unavailable"),
    ).toBeNull();
  });
});

describe("runtime question fallback", () => {
  const questionSet = {
    schema: "paperclip.question_set.v1" as const,
    title: "Configure deployment",
    description: "These answers are required before work can continue.",
    submitLabel: "Continue",
    questions: [
      {
        id: "region",
        prompt: "Which region?",
        required: true,
        answerMode: "single_select" as const,
        options: [
          { id: "us", label: "US" },
          { id: "eu", label: "Europe" },
        ],
      },
      {
        id: "replicas",
        prompt: "How many replicas?",
        required: true,
        answerMode: "text" as const,
        textValidation: { inputType: "integer" as const, minimum: 1 },
      },
    ],
  };

  it.each(["provider_process_lost", "durable_handoff"])(
    "materializes one idempotent durable interaction after %s",
    (reason) => {
      const fallback = runtimeQuestionFallbackFromEvent({
        eventType: "runtime_request.expired",
        runId: "00000000-0000-4000-8000-000000000001",
        payload: {
          requestId: "elicitation-1",
          requestKind: "runtime",
          requestType: "input",
          reason,
          replayAllowed: false,
          request: {
            schema: "paperclip.runtime_request.v2",
            requestKind: "runtime",
            requestId: "elicitation-1",
            type: "input",
            status: "pending",
            prompt: "Configure deployment",
            turnId: "turn-1",
            itemId: "item-1",
            input: questionSet,
          },
        },
      });
      expect(fallback).toMatchObject({
        kind: "ask_user_questions",
        idempotencyKey:
          "runtime-input-durable:v1:00000000-0000-4000-8000-000000000001:elicitation-1",
        sourceRunId: "00000000-0000-4000-8000-000000000001",
        continuationPolicy: "wake_assignee",
        payload: {
          runtimeRequestId: "elicitation-1",
          questionSet,
          supersedeOnUserComment: false,
          questions: [
            {
              id: "region",
              selectionMode: "single",
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "Europe" },
              ],
            },
            {
              id: "replicas",
              selectionMode: "single",
              options: [{ id: "__paperclip_text__", freeText: true }],
            },
          ],
        },
      });
    },
  );

  it.each([
    ["runtime_request.resolved", "provider_process_lost", false],
    ["runtime_request.cancelled", "provider_process_lost", false],
    ["runtime_request.expired", "explicit_cancellation", false],
    ["runtime_request.expired", "provider_process_lost", true],
  ])(
    "does not fall back for %s / %s / replay=%s",
    (eventType, reason, replayAllowed) => {
      expect(
        runtimeQuestionFallbackFromEvent({
          eventType: eventType as never,
          runId: "00000000-0000-4000-8000-000000000001",
          payload: {
            reason,
            replayAllowed,
            request: {
              schema: "paperclip.runtime_request.v2",
              requestKind: "runtime",
              requestId: "elicitation-1",
              type: "input",
              status: "pending",
              turnId: "turn-1",
              itemId: "item-1",
              input: questionSet,
            },
          },
        }),
      ).toBeNull();
    },
  );

  it("emits content-free lifecycle metric dimensions", () => {
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.created",
        payload: {
          request: {
            type: "input",
            requestId: "input-1",
            origin: { adapter: "codex-app-server" },
            input: questionSet,
          },
        },
      }),
    ).toEqual({
      outcome: "normalized",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.expired",
        payload: {
          requestId: "input-1",
          requestType: "input",
          reason: "durable_handoff",
          adapter: "codex-app-server",
        },
      }),
    ).toEqual({
      outcome: "durable_handoff",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
    expect(
      runtimeInputLifecycleMetric({
        eventType: "runtime_request.expired",
        payload: {
          requestId: "input-1",
          requestType: "input",
          reason: "provider_process_lost",
          adapter: "codex-app-server",
        },
      }),
    ).toEqual({
      outcome: "provider_loss_handoff",
      adapter: "codex-app-server",
      requestId: "input-1",
    });
  });
});

describe("native provider bootstrap environment", () => {
  it.each(["pi", "cursor", "copilot"] as const)("does not promote ambient %s credentials when bindings are omitted", agent => {
    const provider = { kind: "acpx", agent } as NativeExecutionInput["provider"];
    const host = { PATH: "/host/bin", HOME: "/host/home", OPENROUTER_API_KEY: "ambient-pi",
      CURSOR_API_KEY: "ambient-cursor", CURSOR_AUTH_TOKEN: "ambient-cursor-login", COPILOT_GITHUB_TOKEN: "ambient-copilot",
      PAPERCLIP_ACPX_CREDENTIAL_BINDING: "ambient-forged-binding" };
    expect(resolveNativeProviderEnvironment(provider, undefined, host)).toEqual({ PATH: "/host/bin", HOME: "/host/home" });
    const explicit = { COPILOT_GITHUB_TOKEN: "explicit-company-binding" };
    expect(resolveNativeProviderEnvironment(provider, explicit, host)).toBe(explicit);
  });

  it("preserves existing qualified and legacy missing-environment behavior", () => {
    const host = { OPENAI_API_KEY: "existing-host-key", OPENROUTER_API_KEY: "existing-opencode-key" };
    for (const provider of [{ kind: "codex" }, { kind: "opencode" }, { kind: "acpx", agent: "codex" }, { kind: "acpx", agent: "claude" }]) {
      expect(resolveNativeProviderEnvironment(provider as NativeExecutionInput["provider"], undefined, host)).toBe(host);
    }
  });

  it("inherits the host executable and credential-home context", () => {
    expect(
      buildNativeProviderEnvironment(
        {},
        {
          PATH: "/opt/homebrew/bin:/usr/bin",
          HOME: "/Users/runner",
          CODEX_HOME: "/Users/runner/.codex",
          PAPERCLIP_INTERNAL_SECRET: "must-not-leak",
        },
      ),
    ).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/runner",
      CODEX_HOME: "/Users/runner/.codex",
    });
  });

  it("lets explicitly configured agent env override host defaults", () => {
    expect(
      buildNativeProviderEnvironment(
        {
          PATH: "/agent/bin",
          OPENAI_API_KEY: "configured-provider-key",
        },
        {
          PATH: "/host/bin",
          HOME: "/Users/runner",
        },
      ),
    ).toEqual({
      PATH: "/agent/bin",
      HOME: "/Users/runner",
      OPENAI_API_KEY: "configured-provider-key",
    });
  });

  it("pins the server-assigned workspace over configured environment input", () => {
    expect(
      buildNativeProviderEnvironment(
        {
          PAPERCLIP_WORKSPACE_CWD: "/untrusted/configured-workspace",
        },
        { HOME: "/Users/runner" },
        "/Users/runner/.paperclip/instances/default/workspaces/agent-1",
      ),
    ).toEqual({
      HOME: "/Users/runner",
      PAPERCLIP_WORKSPACE_CWD:
        "/Users/runner/.paperclip/instances/default/workspaces/agent-1",
    });
  });
});

const execution = {
  schema: "paperclip.native-execution-input.v1",
  provider: { kind: "codex", model: null },
  binding: {
    companyId: "company",
    runId: "run-native-cancel",
    issueId: "issue",
    agentId: "agent",
    executionWorkspaceId: "workspace",
  },
  task: {
    identifier: "PAP-NATIVE",
    title: "Exercise the native session",
    description: null,
    prompt: "Complete the native session test task.",
    workMode: "standard",
  },
  workspace: {
    cwd: "/tmp/paperclip-native-session-test",
    repoUrl: null,
    repoRef: null,
    branchName: null,
  },
  session: {
    normalizedSessionId: "session-native-cancel",
    driverKind: "codex_app_server",
    protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
  completionContract: {
    id: "contract",
    sha256: "sha",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Exercise the native session.",
      criteria: [{ id: "objective", requirement: "The session completes." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
} as NativeExecutionInputV1;

describe("retained native cleanup activation", () => {
  it.each([
    "settled",
    "provider_transport_failed",
    "canonical_source",
    "canonical_live_owner",
    "canonical_foreign_owner",
    "canonical_existing_quarantine",
    "canonical_prior_epoch",
    "canonical_prior_maintenance",
    "canonical_lease_loss",
    "canonical_source_changed",
    "canonical_home_changed",
    "canonical_inode_changed",
    "canonical_archive_occupied",
    "canonical_claim_commit_failure",
    "canonical_archive_commit_failure",
    "canonical_claim_commit_stalled",
    "canonical_archive_commit_stalled",
    "canonical_after_archive_replacement",
    "canonical_prepared_original",
    "canonical_prepared_archived",
    "canonical_archived_recorded",
    "canonical_prepared_bad_hash",
    "canonical_prepared_bad_inode",
    "provider_home",
    "home_paginated",
    "home_history_mismatch",
    "home_unknown_history",
    "home_index_trigger",
    "home_mixed_case_index_trigger",
    "home_cascading_foreign_key",
    "home_selected_reverted_rollout",
    "home_changed_index",
    "home_symlink",
    "home_oversized",
    "home_foreign_path",
    "home_stale_foreign_path",
    "home_wrong_thread",
    "home_unknown_db",
    "home_changed_source",
    "home_changed_staging",
    "home_changed_during_commit",
    "home_duplicate_rollout",
    "live_owner",
    "foreign_event",
    "maintenance_failure",
    "epoch_commit_failure",
    "activation_commit_failure",
    "activation_commit_stalled",
    "empty_root",
    "nonempty_root",
    "changed_empty_root",
    "replaced_empty_root",
    "distinct_provider_account",
    "wrong_provider_account",
    "wrong_result_digest",
    "digest_only_command",
    "wrong_command_digest",
    "conflicting_command_digest",
    "wrong_semantic_input",
    "wrong_contract",
    "wrong_turn",
    "missing_result_command",
    "bad_identity_hash",
    "foreign_semantic_scope",
    "legacy_copy",
    "legacy_changed_copy",
    "legacy_busy_copy",
    "legacy_bad_proof",
    "legacy_extra_attempt",
    "legacy_activation",
  ])("preserves exact original evidence for %s", async (mode) => {
    const directory = await mkdtemp(
      join(tmpdir(), "paperclip-maintenance-activation-"),
    );
    let providerHomeDatabase: DatabaseSync | undefined;
    const preservedHomeFiles = [
      "sessions/rollout-exact-thread.jsonl",
      "state_5.sqlite",
      "state_5.sqlite-wal",
      "state_5.sqlite-shm",
      "traces/provider.log",
      "auth.json",
      "config.toml",
    ];
    let preservedHomeBytes: Buffer[] | null = null;
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = directory;
    const canonical = (value: unknown): string =>
      value && typeof value === "object" && !Array.isArray(value)
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
            .join(",")}}`
        : JSON.stringify(value);
    const key = createHash("sha256")
      .update(
        canonical({
          schema: "paperclip.native-session-scope.v2",
          companyId: execution.binding.companyId,
          agentId: execution.binding.agentId,
          workspace: {
            kind: "managed",
            executionWorkspaceId: execution.binding.executionWorkspaceId,
          },
          provider: {
            driverKind: execution.session.driverKind,
            identity: { kind: "codex" },
          },
          normalizedSessionId: execution.session.normalizedSessionId,
        }),
      )
      .digest("hex");
    const root = join(directory, key);
    let quarantine = join(
      directory,
      "quarantine",
      `${key}.identity_indeterminate.fixture`,
    );
    const legacyDirectory = join(directory, `${key}.cleanup-prior`);
    const legacy = mode.startsWith("legacy_");
    const canonicalSource = mode.startsWith("canonical_");
    const proofSpy = vi.spyOn(
      noLaunchProofModule,
      "verifyRetainedMaintenanceNoLaunch",
    );
    state.maintenanceIdle
      .mockReset()
      .mockReturnValue(mode !== "legacy_busy_copy");
    const identity = {
      runId: execution.binding.runId,
      runnerInstanceId: "runner-cleanup",
      environmentLeaseId: "lease-cleanup",
      normalizedSessionId: execution.session.normalizedSessionId,
      turnId: "turn-cleanup",
      itemId: "item-cleanup",
    };
    const providerAccountSessionId = [
      "distinct_provider_account",
      "wrong_provider_account",
    ].includes(mode)
      ? "exact-account"
      : "exact-thread";
    const event = {
      schema: "paperclip.prp.event.v1",
      schemaVersion: 1,
      sourceKind: "runner",
      sourceSeq: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      turnId: identity.turnId,
      itemId: identity.itemId,
      sourceEventId: "original-provider-identity",
      sourceInstanceId: identity.runnerInstanceId,
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId,
      eventType: "session.resumed",
      payload: {
        providerSessionId: "exact-thread",
        providerAccountSessionId,
        processId: 99_999_998,
      },
    };
    const normalizedIdentity = {
      ...event,
      sourceEventId: `${identity.runnerInstanceId}:${identity.runId}:1`,
      priority: 1,
      ...(mode === "foreign_event" ? { runId: "foreign" } : {}),
      payload: {
        driverSessionId: "exact-thread",
        providerSessionId:
          mode === "wrong_provider_account"
            ? "foreign-account"
            : providerAccountSessionId,
        context: {},
      },
    };
    const identityRow = {
      eventType: event.eventType,
      sourceInstanceId: identity.runnerInstanceId,
      sourceEventId: normalizedIdentity.sourceEventId,
      sourceSeq: 1,
      payload: { prpEvent: normalizedIdentity },
      sourcePayloadSha256:
        mode === "bad_identity_hash" ? "bad" : nativeSha256(normalizedIdentity),
    };
    const semanticResult = nativeGovernedWaitResult({
      interaction: { id: "answered", title: "Next response", summary: null },
      completionContract: execution.completionContract.contract,
    });
    const validatedResult = validatePrpStructuredRunResult(semanticResult);
    expect(validatedResult.ok).toBe(true);
    const accepted = {
      schemaStatus: "accepted",
      resultJson: {
        result: validatedResult.result,
        terminal: {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: "yielded",
        },
      },
      turnId: "provider-turn",
      canonicalSha256: "",
      serverFingerprint: "",
    };
    accepted.canonicalSha256 = `sha256:${nativeSha256({ ...accepted.resultJson, turnId: accepted.turnId })}`;
    accepted.serverFingerprint = `sha256:${nativeSha256({ runId: identity.runId, completionContractSha256: "sha", canonicalSha256: accepted.canonicalSha256 })}`;
    if (mode === "wrong_result_digest") accepted.canonicalSha256 = "wrong";
    const correlation = {
      runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId!,
      turnId:
        mode === "foreign_semantic_scope" ? "another-turn" : identity.turnId,
      itemId: identity.itemId,
    };
    const semanticInput =
      mode === "wrong_semantic_input"
        ? { ...semanticResult, summary: "Different accepted request" }
        : semanticResult;
    const semantic = {
      ...createPrpSemanticToolInputEnvelope({
        callId: "finish-call",
        operationId: "paperclip_finish",
        correlation,
        content: semanticInput,
      }),
      input: semanticInput,
    };
    const rawInput = {
      ...event,
      sourceEventId: "raw-finish-input",
      sourceSeq: 3,
      eventType: "semantic_tool.input",
      turnId: correlation.turnId,
      payload: { semantic_tool: semantic },
    };
    const rawResult = {
      ...event,
      sourceEventId: "raw-finish-result",
      sourceSeq: 4,
      eventType: "semantic_tool.result",
      turnId: correlation.turnId,
      payload: {
        semantic_tool: createPrpSemanticToolResultEnvelope({
          callId: "finish-call",
          operationId: "paperclip_finish",
          correlation,
          content: semanticInput,
          outcome: "succeeded",
          code: "semantic_tool_succeeded",
          operationReceiptId: "operation_finish-call",
          retryable: false,
          authorizationBoundary: "active_task",
        }),
      },
    };
    const commands = [
      {
        type: "run.attach",
        status: "completed",
        payload: {
          completionContract: {
            revision:
              mode === "wrong_contract"
                ? "wrong"
                : execution.completionContract.contract.revision,
            criterionIds: execution.completionContract.contract.criteria.map(
              (criterion) => criterion.id,
            ),
          },
        },
      },
      {
        type: "turn.start",
        status: "completed",
        result: {
          result: {
            providerTurnId: mode === "wrong_turn" ? "wrong" : "provider-turn",
          },
        },
      },
      ...(mode === "missing_result_command"
        ? []
        : [
            {
              type: "semantic_tool.result",
              status: "completed",
              payload: {
                callId: semantic.callId,
                operationId: semantic.operationId,
                ...(mode === "digest_only_command" || mode === "wrong_command_digest"
                  ? { inputDigest: mode === "wrong_command_digest" ? "wrong" : nativeSha256(semanticInput) }
                  : { input: semanticInput, ...(mode === "conflicting_command_digest" ? { inputDigest: "wrong" } : {}) }),
                correlation,
                sourceEventId: rawInput.sourceEventId,
                sourceEventType: rawInput.eventType,
                isError: false,
              },
              result: { result: { callId: semantic.callId } },
            },
          ]),
    ];
    const run = {
      id: identity.runId,
      ...execution.binding,
      runtimeMode: "native",
      status: "succeeded",
      nativeIssueId: execution.binding.issueId,
      nativeSessionId: identity.normalizedSessionId,
      runnerInstanceId: identity.runnerInstanceId,
      finishedAt: new Date(),
      processPid: mode.endsWith("live_owner") ? process.pid : 99_999_999,
      processGroupId: mode.endsWith("live_owner") ? process.pid : 99_999_999,
      completionContractId: "contract",
      completionContractSha256: "sha",
      errorCode: mode === "provider_transport_failed" ? "provider_transport_failed" : "adapter_failed",
      error:
        "provider_transport_failed: runner did not durably suspend before checkpoint",
      runnerProfileJson: {
        nativeExecutionInput: execution,
        nativeToolContractFingerprint:
          nativeToolContractFingerprintForTarget("local"),
      },
    };
    const coordinator: Record<string, unknown> = {
      runId: run.id,
      phase: "committed",
      resultId: "result",
      assessmentId: "assessment",
      decisionId: "decision",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      recoveryHistory: [],
    };
    let transactionOpen = false;
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((release) => {
      releaseCommit = release;
    });
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const rows =
            table === heartbeatRuns
              ? [run]
              : table === nativeRunFinalizations
                ? mode === "canonical_lease_loss" &&
                  coordinator.leaseOwner === "another-owner"
                  ? []
                  : [coordinator]
                : table === nativeRunResults
                  ? [accepted]
                  : table === heartbeatRunEvents
                    ? [identityRow]
                    : [];
          const query = {
            where: () => query,
            for: () => query,
            limit: async () => rows,
          };
          return query;
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            Object.assign(coordinator, values);
            return Object.assign(Promise.resolve([]), {
              returning: async () => {
                const prepared = (
                  values.recoveryHistory as
                    Array<Record<string, unknown>> | undefined
                )?.at(-1);
                if (
                  mode === "home_changed_staging" &&
                  prepared?.phase === "activation_prepared"
                )
                  await writeFile(
                    join(
                      directory,
                      String(prepared.stagingName),
                      "codex-home/sessions/rollout-exact-thread.jsonl",
                    ),
                    "changed-staging\n",
                  );
                return [{ runId: run.id }];
              },
            });
          },
        }),
      }),
      transaction: async (operation: (tx: Db) => Promise<unknown>) => {
        transactionOpen = true;
        const before = structuredClone(coordinator);
        try {
          const result = await operation(db as unknown as Db);
          const latest = (
            coordinator.recoveryHistory as Array<Record<string, unknown>>
          ).at(-1);
          if (
            latest?.kind === "native_cleanup_source_archive" &&
            latest.phase === "prepared"
          ) {
            if (mode === "canonical_lease_loss")
              coordinator.leaseOwner = "another-owner";
            if (mode === "canonical_source_changed")
              await writeFile(join(root, "runner/runner-state.json"), "{}");
            if (mode === "canonical_home_changed")
              await writeFile(
                join(root, "codex-home/sessions/rollout-exact-thread.jsonl"),
                "changed\n",
              );
            if (mode === "canonical_inode_changed") {
              await rename(root, `${root}.replaced`);
              quarantine = `${root}.replaced`;
              await mkdir(root);
              await writeFile(join(root, "foreign-owner"), "preserved");
            }
            if (mode === "canonical_archive_occupied") {
              const occupied = join(
                directory,
                "quarantine",
                String(latest.archiveName),
              );
              await mkdir(occupied);
              await writeFile(join(occupied, "foreign-owner"), "preserved");
            }
            if (mode === "canonical_claim_commit_failure")
              throw new Error("injected source claim commit failure");
            if (mode === "canonical_claim_commit_stalled") await commitGate;
          }
          if (
            latest?.kind === "native_cleanup_source_archive" &&
            latest.phase === "archived"
          ) {
            if (mode === "canonical_archive_commit_failure")
              throw new Error("injected archive commit failure");
            if (mode === "canonical_after_archive_replacement") {
              await mkdir(root);
              await writeFile(join(root, "foreign-owner"), "preserved");
            }
            if (mode === "canonical_archive_commit_stalled") await commitGate;
          }
          if (
            mode === "home_changed_during_commit" &&
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase === "settled"
          )
            await writeFile(
              join(root, "codex-home/sessions/rollout-exact-thread.jsonl"),
              "changed-after-activation\n",
            );
          if (
            mode === "epoch_commit_failure" &&
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase === "spawned"
          )
            throw new Error("injected epoch commit failure");
          if (
            mode === "activation_commit_stalled" &&
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase === "settled"
          )
            await commitGate;
          if (
            mode === "activation_commit_failure" &&
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase === "settled"
          ) {
            throw new Error("injected commit failure");
          }
          return result;
        } catch (error) {
          Object.assign(coordinator, before);
          throw error;
        } finally {
          transactionOpen = false;
        }
      },
    };
    try {
      if (
        [
          "empty_root",
          "nonempty_root",
          "changed_empty_root",
          "replaced_empty_root",
        ].includes(mode)
      ) {
        await mkdir(root);
        if (mode === "nonempty_root")
          await writeFile(join(root, "existing-owner"), "preserved");
      }
      await mkdir(join(quarantine, "runner"), { recursive: true });
      await mkdir(join(quarantine, "control-plane"), { recursive: true });
      const source = [
        [
          "control-plane/control-plane-state.json",
          {
            ...durableControlPlaneState(identity),
            commands,
            committedEvents: [
              event,
              {
                ...event,
                sourceEventId: "raw-turn",
                sourceSeq: 2,
                eventType: "turn.accepted",
                payload: {
                  providerSessionId: "exact-thread",
                  providerTurnId: "provider-turn",
                },
              },
              rawInput,
              rawResult,
            ].map((payload) => ({ envelope: { payload } })),
          },
        ],
        ["runner/runner-state.json", durableRunnerState(identity, "ready")],
        [
          "runner/codex-provider-state.json",
          {
            lifecycle: "turn_active",
            threadId: "exact-thread",
            config: {
              provider: "codex",
              command: "codex",
              cwd: execution.workspace.cwd,
            },
          },
        ],
      ] as const;
      expect(validatePrpEvent(rawInput).ok).toBe(true);
      expect(validatePrpEvent(rawResult).ok).toBe(true);
      expect(
        retainedNativeCleanupJournalMatches({
          run,
          execution,
          accepted,
          control: source[0][1],
          providerSessionId: "exact-thread",
          providerAccountSessionId,
          persistedEvents: [identityRow],
        }),
      ).toBe(
        ![
          "foreign_event",
          "wrong_result_digest",
          "wrong_command_digest",
          "conflicting_command_digest",
          "wrong_semantic_input",
          "wrong_contract",
          "wrong_turn",
          "missing_result_command",
          "bad_identity_hash",
          "foreign_semantic_scope",
          "wrong_provider_account",
        ].includes(mode),
      );
      for (const [file, data] of source)
        await writeFile(join(quarantine, file), JSON.stringify(data));
      await mkdir(join(quarantine, "codex-home/sessions"), {
        recursive: true,
      });
      await writeFile(
        join(quarantine, "codex-home/sessions/rollout-exact-thread.jsonl"),
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "exact-thread",
            history_mode: mode === "home_paginated" ? "paginated" : "legacy",
          },
        }) + "\n",
      );
      providerHomeDatabase = new DatabaseSync(
        join(quarantine, "codex-home/state_5.sqlite"),
      );
      providerHomeDatabase.exec(
        `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ${mode === "home_mixed_case_index_trigger" ? "Threads" : "threads"} (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL)`,
      );
      providerHomeDatabase
        .prepare("INSERT INTO threads VALUES (?, ?, ?)")
        .run(
          "exact-thread",
          join(root, "codex-home/sessions/rollout-exact-thread.jsonl"),
          mode === "home_paginated" ? "paginated" : "legacy",
        );
      providerHomeDatabase
        .prepare("INSERT INTO threads VALUES (?, ?, ?)")
        .run(
          "unrelated-thread",
          "/unrelated/immutable-rollout.jsonl",
          "paginated",
        );
      if (mode === "home_history_mismatch")
        providerHomeDatabase
          .prepare(
            "UPDATE threads SET history_mode = 'paginated' WHERE id = 'exact-thread'",
          )
          .run();
      if (mode === "home_unknown_history")
        providerHomeDatabase
          .prepare(
            "UPDATE threads SET history_mode = 'future-mode' WHERE id = 'exact-thread'",
          )
          .run();
      if (mode === "home_index_trigger")
        providerHomeDatabase.exec(
          "CREATE TRIGGER unexpected_relocation AFTER UPDATE ON threads BEGIN UPDATE threads SET history_mode = 'changed' WHERE id = 'unrelated-thread'; END",
        );
      if (mode === "home_mixed_case_index_trigger")
        providerHomeDatabase.exec(
          "CREATE TRIGGER unexpected_relocation AFTER UPDATE ON Threads BEGIN UPDATE threads SET history_mode = 'changed' WHERE id = 'unrelated-thread'; END",
        );
      if (mode === "home_cascading_foreign_key") {
        providerHomeDatabase.exec(
          "CREATE UNIQUE INDEX selected_rollout ON threads(rollout_path); CREATE TABLE related_selection (selected_path TEXT REFERENCES Threads(rollout_path) ON UPDATE CASCADE)",
        );
        providerHomeDatabase
          .prepare("INSERT INTO related_selection VALUES (?)")
          .run(join(root, "codex-home/sessions/rollout-exact-thread.jsonl"));
      }
      if (mode === "home_selected_reverted_rollout") {
        await writeFile(
          join(
            quarantine,
            "codex-home/sessions/rollout-different-rollout-id.jsonl",
          ),
          JSON.stringify({
            type: "session_meta",
            payload: { id: "exact-thread", history_mode: "legacy" },
          }) + "\n",
        );
        providerHomeDatabase
          .prepare(
            "UPDATE threads SET rollout_path = ? WHERE id = 'exact-thread'",
          )
          .run(
            join(
              root,
              "codex-home/sessions/rollout-different-rollout-id.jsonl",
            ),
          );
      }
      if (mode === "home_symlink")
        await symlink(
          join(directory, "outside-home"),
          join(quarantine, "codex-home/foreign-link"),
        );
      if (mode === "home_oversized") {
        await writeFile(join(quarantine, "codex-home/oversized"), "");
        await truncate(
          join(quarantine, "codex-home/oversized"),
          64 * 1024 * 1024 + 1,
        );
      }
      if (mode === "home_foreign_path")
        providerHomeDatabase
          .prepare("UPDATE threads SET rollout_path = ?")
          .run(
            join(quarantine, "codex-home/sessions/rollout-exact-thread.jsonl"),
          );
      if (mode === "home_stale_foreign_path")
        providerHomeDatabase
          .prepare("UPDATE threads SET rollout_path = ?")
          .run(
            join(
              directory,
              "foreign-missing-home/sessions/rollout-exact-thread.jsonl",
            ),
          );
      if (mode === "home_wrong_thread")
        await writeFile(
          join(quarantine, "codex-home/sessions/rollout-exact-thread.jsonl"),
          JSON.stringify({
            type: "session_meta",
            payload: { id: "foreign-thread" },
          }) + "\n",
        );
      if (mode === "home_unknown_db")
        await writeFile(
          join(quarantine, "codex-home/state_99.sqlite"),
          "unsupported-version",
        );
      if (mode === "home_duplicate_rollout")
        await writeFile(
          join(quarantine, "codex-home/sessions/duplicate-exact-thread.jsonl"),
          JSON.stringify({
            type: "session_meta",
            payload: { id: "exact-thread" },
          }) + "\n",
        );
      if (mode === "provider_home") {
        await mkdir(join(quarantine, "codex-home/traces"));
        await writeFile(
          join(quarantine, "codex-home/traces/provider.log"),
          "retained-provider-trace\n",
        );
        await writeFile(
          join(quarantine, "codex-home/auth.json"),
          "MUST-NOT-COPY",
        );
        await writeFile(
          join(quarantine, "codex-home/config.toml"),
          "MUST-NOT-COPY",
        );
        preservedHomeBytes = await Promise.all(
          preservedHomeFiles.map((file) =>
            readFile(join(quarantine, "codex-home", file)),
          ),
        );
      }
      let legacyBytes: string[] | null = null;
      if (legacy) {
        // This suite isolates filesystem/lease orchestration. The real pure
        // producer proof and raw runner composition have separate canaries.
        await mkdir(join(legacyDirectory, "runner"), { recursive: true });
        await mkdir(join(legacyDirectory, "control-plane"));
        legacyBytes = source.map(([, value]) =>
          JSON.stringify({ ...value, failedCopyFixture: true }),
        );
        for (let index = 0; index < source.length; index++)
          await writeFile(
            join(legacyDirectory, source[index]![0]),
            legacyBytes[index]!,
          );
        coordinator.recoveryHistory = [
          {
            kind: "native_cleanup_maintenance",
            version: 1,
            phase: "started",
            requestId: "native-cleanup:prior",
          },
          {
            kind: "native_cleanup_maintenance",
            version: 1,
            phase: "operator_required",
            requestId: "native-cleanup:prior",
          },
        ];
        if (mode === "legacy_extra_attempt")
          await mkdir(join(directory, `${key}.cleanup-other`));
        if (mode === "legacy_activation")
          await writeFile(
            join(legacyDirectory, "cleanup-activation.json"),
            "{}",
          );
        proofSpy.mockImplementation((input) =>
          mode === "legacy_bad_proof"
            ? null
            : {
                kind: "codex_pre_spawn_terminal_latch_v1",
                requestId: input.requestId,
                originalFingerprint: input.original.fingerprint,
                attemptedFingerprint: input.attempted.fingerprint,
              },
        );
      }
      if (mode === "canonical_foreign_owner")
        await writeFile(
          join(quarantine, source[0][0]),
          JSON.stringify({
            ...source[0][1],
            identity: { ...identity, runId: "foreign-run" },
          }),
        );
      const original = await Promise.all(
        source.map(([file]) => readFile(join(quarantine, file), "utf8")),
      );
      if (canonicalSource) {
        await rename(quarantine, root);
        quarantine = root;
        if (mode === "canonical_existing_quarantine")
          await mkdir(
            join(
              directory,
              "quarantine",
              `${key}.identity_indeterminate.foreign`,
            ),
          );
        if (mode === "canonical_prior_epoch")
          coordinator.recoveryHistory = [
            {
              kind: "native_cleanup_runner_epoch",
              phase: "spawned",
              epoch: 1,
              pid: 88736,
            },
          ];
        if (mode === "canonical_prior_maintenance")
          coordinator.recoveryHistory = [
            { kind: "native_cleanup_maintenance", phase: "started" },
            { kind: "native_cleanup_maintenance", phase: "operator_required" },
          ];
        if (
          mode.startsWith("canonical_prepared_") ||
          mode === "canonical_archived_recorded"
        ) {
          const metadata = await lstat(root);
          const entries: Array<Record<string, unknown>> = [];
          const home = join(root, "codex-home");
          const visit = async (relative: string) => {
            const path = join(home, relative),
              stat = await lstat(path);
            entries.push({
              path: relative,
              directory: stat.isDirectory(),
              size: stat.isDirectory() ? 0 : stat.size,
              ...(!stat.isDirectory()
                ? {
                    sha256: createHash("sha256")
                      .update(await readFile(path))
                      .digest("hex"),
                  }
                : {}),
            });
            if (stat.isDirectory())
              for (const name of (await readdir(path)).sort()) {
                if (
                  !relative &&
                  ["tmp", ".tmp", "auth.json", "config.toml"].includes(name)
                )
                  continue;
                await visit(relative ? `${relative}/${name}` : name);
              }
          };
          await visit("");
          const prepared = {
            kind: "native_cleanup_source_archive",
            version: 1,
            phase: "prepared",
            requestId: "native-cleanup:prepared-fixture",
            companyId: run.companyId,
            agentId: run.agentId,
            runId: run.id,
            nativeSessionId: run.nativeSessionId,
            runnerInstanceId: run.runnerInstanceId,
            stateKey: key,
            archiveName: `${key}.identity_indeterminate.cleanup.prepared-fixture`,
            rootIdentity: {
              device: metadata.dev,
              inode: mode === "canonical_prepared_bad_inode" ? 1 : metadata.ino,
              mode: metadata.mode,
            },
            sourceFingerprint:
              mode === "canonical_prepared_bad_hash"
                ? "a".repeat(64)
                : createHash("sha256")
                    .update(
                      JSON.stringify(
                        original.map((bytes) =>
                          createHash("sha256").update(bytes).digest("hex"),
                        ),
                      ),
                    )
                    .digest("hex"),
            providerHomeFingerprint: nativeSha256(entries),
          };
          coordinator.recoveryHistory = [prepared];
          if (
            [
              "canonical_prepared_archived",
              "canonical_archived_recorded",
            ].includes(mode)
          ) {
            quarantine = join(directory, "quarantine", prepared.archiveName);
            await rename(root, quarantine);
          }
          if (mode === "canonical_archived_recorded")
            (coordinator.recoveryHistory as unknown[]).push({
              ...prepared,
              phase: "archived",
            });
          // A fresh process must not interpret either side of the rename as
          // permission to create another provider before archival settles.
          await expect(
            createRunnerdBackend({
              db: db as unknown as Db,
              execution,
              runnerInstanceId: "successor-runner",
            }),
          ).rejects.toBeInstanceOf(NativeSessionCleanupQuarantinedError);
        }
      }
      state.cleanup.mockReset();
      state.retireCleanup.mockReset();
      state.cleanup.mockImplementation(async (input) => {
        if (canonicalSource) {
          const archived = (
            coordinator.recoveryHistory as Array<Record<string, unknown>>
          ).find(
            (entry) =>
              entry.kind === "native_cleanup_source_archive" &&
              entry.phase === "archived",
          )!;
          expect(archived).toBeDefined();
          quarantine = join(
            directory,
            "quarantine",
            String(archived.archiveName),
          );
          await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            await Promise.all(
              source.map(([file]) => readFile(join(quarantine, file), "utf8")),
            ),
          ).toEqual(original);
        }
        await input.authorize();
        if (mode === "home_paginated") {
          // Codex 0.153.4's thread-store resolver deliberately does not scan
          // for a paginated thread when its selected SQLite path is absent.
          const copied = new DatabaseSync(
            join(input.stateDirectory, "codex-home/state_5.sqlite"),
            { readOnly: true },
          );
          try {
            const selected = copied
              .prepare(
                "SELECT rollout_path, history_mode FROM threads WHERE id = ?",
              )
              .get("exact-thread")!;
            expect(selected.history_mode).toBe("paginated");
            expect(selected.rollout_path).toBe(
              join(
                input.stateDirectory,
                "codex-home/sessions/rollout-exact-thread.jsonl",
              ),
            );
            await access(String(selected.rollout_path));
          } finally {
            copied.close();
          }
        }
        if (mode === "home_changed_index") {
          const copied = new DatabaseSync(
            join(input.stateDirectory, "codex-home/state_5.sqlite"),
          );
          try {
            copied
              .prepare(
                "UPDATE threads SET rollout_path = '/foreign/selected.jsonl' WHERE id = 'exact-thread'",
              )
              .run();
          } finally {
            copied.close();
          }
        }
        if (mode === "home_changed_source") {
          await writeFile(
            join(quarantine, "codex-home/sessions/rollout-exact-thread.jsonl"),
            "changed-source\n",
          );
          await input.authorize();
        }
        if (mode === "provider_home") {
          for (const file of [
            "sessions/rollout-exact-thread.jsonl",
            "traces/provider.log",
          ])
            expect(
              await readFile(join(input.stateDirectory, "codex-home", file)),
            ).toEqual(await readFile(join(quarantine, "codex-home", file)));
          for (const file of ["auth.json", "config.toml"])
            await expect(
              access(join(input.stateDirectory, "codex-home", file)),
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (legacy) {
          expect(input.stateDirectory).not.toBe(legacyDirectory);
          expect(
            await Promise.all(
              source.map(([file]) =>
                readFile(join(input.stateDirectory, file), "utf8"),
              ),
            ),
          ).toEqual(legacyBytes);
          expect(proofSpy).toHaveBeenCalledOnce();
          expect(proofSpy.mock.calls[0]![0]).toMatchObject({
            companyId: run.companyId,
            agentId: run.agentId,
            identity,
            requestId: "native-cleanup:prior",
          });
          if (mode === "legacy_changed_copy") {
            await writeFile(join(legacyDirectory, source[0][0]), "{}");
            await input.authorize();
          }
        }
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
            -1,
          ),
        ).toMatchObject({
          phase: "staged",
          stagingName: input.stateDirectory.split("/").at(-1),
        });
        const epoch = {
          schema: "paperclip.native_cleanup_runner_epoch.v1",
          requestId: input.requestId,
          epoch: 0,
          launchId: "fixture-launch",
          stateDirectory: input.stateDirectory,
          initialFingerprint: input.sourceFingerprint,
          runnerArtifact: {
            path: "/fixture/runnerd",
            version: "fixture",
            digest: "fixture-digest",
          },
        };
        await input.recordEpoch({ ...epoch, phase: "launch_intent" });
        await input.recordEpoch({
          ...epoch,
          phase: "spawned",
          pid: 31337,
          processGroupId: 31337,
          processStartedAt: "2026-09-08T00:00:00.000Z",
          spawnedAt: "2026-09-08T00:00:00.100Z",
        });
        await input.recordEpoch({
          ...epoch,
          phase: "retired",
          pid: 31337,
          processGroupId: 31337,
          processStartedAt: "2026-09-08T00:00:00.000Z",
          spawnedAt: "2026-09-08T00:00:00.100Z",
          exitCode: 0,
          exitSignal: null,
          processGroupAbsent: true,
          retiredAt: "2026-09-08T00:00:01.000Z",
          finalFingerprint: "fixture-settled",
        });
        if (mode === "changed_empty_root") {
          await writeFile(join(root, "late-owner"), "preserved");
          await input.authorize();
        }
        if (mode === "replaced_empty_root") {
          await rename(root, `${root}.original-empty`);
          await mkdir(root);
          await input.authorize();
        }
        if (mode === "maintenance_failure")
          throw new Error("injected unproven owner");
        return { ...input, settledFingerprint: "verified-fixture-fingerprint" };
      });
      state.retireCleanup.mockImplementation(() => {
        expect(transactionOpen).toBe(false);
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(-1)
            ?.phase,
        ).toBe("settled");
        return 1;
      });
      const pendingOutcome = reconcileRetainedNativeSessionCleanup(
        db as unknown as Db,
        { companyId: run.companyId, runId: run.id },
      );
      if (
        [
          "canonical_claim_commit_stalled",
          "canonical_archive_commit_stalled",
        ].includes(mode)
      ) {
        await vi.waitFor(() =>
          expect(
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase,
          ).toBe(
            mode === "canonical_claim_commit_stalled" ? "prepared" : "archived",
          ),
        );
        expect(state.cleanup).not.toHaveBeenCalled();
        await expect(
          createRunnerdBackend({
            db: db as unknown as Db,
            execution,
            runnerInstanceId: "successor-runner",
          }),
        ).rejects.toThrow("native_session_supervisor_busy");
        releaseCommit();
      }
      if (mode === "activation_commit_stalled") {
        await vi.waitFor(() =>
          expect(
            (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(
              -1,
            )?.phase,
          ).toBe("settled"),
        );
        expect(state.retireCleanup).not.toHaveBeenCalled();
        await expect(
          createRunnerdBackend({
            db: db as unknown as Db,
            execution,
            runnerInstanceId: "successor-runner",
          }),
        ).rejects.toThrow("native_session_supervisor_busy");
        releaseCommit();
      }
      const outcome = await pendingOutcome;
      if (canonicalSource) {
        const prepared = (
          coordinator.recoveryHistory as Array<Record<string, unknown>>
        ).find(
          (entry) =>
            entry.kind === "native_cleanup_source_archive" &&
            entry.phase === "prepared",
        );
        if (prepared) {
          const archived = join(
            directory,
            "quarantine",
            String(prepared.archiveName),
          );
          if (
            await access(join(archived, source[0][0])).then(
              () => true,
              () => false,
            )
          )
            quarantine = archived;
        }
      }
      if (mode === "settled") {
        const cleanupEnvironment = state.cleanup.mock.calls[0]![0].environment;
        expect(cleanupEnvironment).toEqual(
          buildNativeProviderEnvironment(
            {},
            process.env,
            execution.workspace.cwd,
          ),
        );
        expect(cleanupEnvironment).not.toHaveProperty("OPENAI_API_KEY");
        expect(cleanupEnvironment).not.toHaveProperty("CODEX_API_KEY");
      }
      const ineligible = [
        "canonical_live_owner",
        "canonical_foreign_owner",
        "canonical_existing_quarantine",
        "canonical_prior_epoch",
        "canonical_prior_maintenance",
        "canonical_claim_commit_failure",
        "canonical_prepared_bad_hash",
        "canonical_prepared_bad_inode",
        "home_symlink",
        "home_oversized",
        "legacy_busy_copy",
        "legacy_bad_proof",
        "legacy_extra_attempt",
        "legacy_activation",
        "live_owner",
        "foreign_event",
        "nonempty_root",
        "wrong_result_digest",
        "wrong_command_digest",
        "conflicting_command_digest",
        "wrong_semantic_input",
        "wrong_contract",
        "wrong_turn",
        "missing_result_command",
        "bad_identity_hash",
        "foreign_semantic_scope",
        "wrong_provider_account",
      ].includes(mode);
      const succeeds = [
        "digest_only_command",
        "home_paginated",
        "canonical_source",
        "canonical_claim_commit_stalled",
        "canonical_archive_commit_stalled",
        "canonical_prepared_original",
        "canonical_prepared_archived",
        "canonical_archived_recorded",
        "provider_home",
        "legacy_copy",
        "settled",
        "provider_transport_failed",
        "activation_commit_stalled",
        "empty_root",
        "distinct_provider_account",
      ].includes(mode);
      expect(outcome.status).toBe(
        succeeds
          ? "settled"
          : ineligible
            ? "not_eligible"
            : "operator_required",
      );
      expect(
        await Promise.all(
          source.map(([file]) => readFile(join(quarantine, file), "utf8")),
        ),
      ).toEqual(
        mode === "canonical_source_changed"
          ? [original[0], "{}", original[2]]
          : original,
      );
      if (preservedHomeBytes)
        expect(
          await Promise.all(
            preservedHomeFiles.map((file) =>
              readFile(join(quarantine, "codex-home", file)),
            ),
          ),
        ).toEqual(preservedHomeBytes);
      const deniedBeforeLaunch = [
        "canonical_lease_loss",
        "canonical_source_changed",
        "canonical_home_changed",
        "canonical_inode_changed",
        "canonical_archive_occupied",
        "canonical_archive_commit_failure",
        "canonical_after_archive_replacement",
        "home_foreign_path",
        "home_stale_foreign_path",
        "home_wrong_thread",
        "home_unknown_db",
        "home_duplicate_rollout",
        "home_history_mismatch",
        "home_unknown_history",
        "home_index_trigger",
        "home_mixed_case_index_trigger",
        "home_cascading_foreign_key",
        "home_selected_reverted_rollout",
      ].includes(mode);
      expect(state.cleanup).toHaveBeenCalledTimes(
        ineligible || deniedBeforeLaunch ? 0 : 1,
      );
      expect(state.retireCleanup).toHaveBeenCalledTimes(succeeds ? 1 : 0);
      expect(coordinator.phase).toBe("committed");
      expect(coordinator.resultId).toBe("result");
      if (mode === "canonical_lease_loss") {
        await access(join(root, source[0][0]));
        expect(await readdir(join(directory, "quarantine"))).toEqual([]);
      }
      if (
        [
          "canonical_inode_changed",
          "canonical_after_archive_replacement",
        ].includes(mode)
      )
        expect(await readFile(join(root, "foreign-owner"), "utf8")).toBe(
          "preserved",
        );
      if (mode === "canonical_archive_occupied") {
        const prepared = (
          coordinator.recoveryHistory as Array<Record<string, unknown>>
        )[0]!;
        expect(
          await readFile(
            join(
              directory,
              "quarantine",
              String(prepared.archiveName),
              "foreign-owner",
            ),
            "utf8",
          ),
        ).toBe("preserved");
      }
      if (mode === "canonical_prior_epoch")
        expect(coordinator.recoveryHistory).toEqual([
          {
            kind: "native_cleanup_runner_epoch",
            phase: "spawned",
            epoch: 1,
            pid: 88736,
          },
        ]);
      if (
        canonicalSource &&
        !succeeds &&
        mode !== "canonical_lease_loss" &&
        (coordinator.recoveryHistory as Array<Record<string, unknown>>).some(
          (entry) =>
            entry.kind === "native_cleanup_source_archive" &&
            entry.phase === "prepared",
        )
      )
        await expect(
          createRunnerdBackend({
            db: db as unknown as Db,
            execution,
            runnerInstanceId: "successor-runner",
          }),
        ).rejects.toBeInstanceOf(NativeSessionCleanupQuarantinedError);
      if (mode === "empty_root") {
        const prepared = (
          coordinator.recoveryHistory as Array<Record<string, unknown>>
        ).find((entry) => entry.phase === "activation_prepared")!;
        expect(typeof prepared.emptyRootArchive).toBe("string");
        expect(
          await readdir(join(directory, String(prepared.emptyRootArchive))),
        ).toEqual([]);
      }
      if (mode === "nonempty_root")
        expect(await readFile(join(root, "existing-owner"), "utf8")).toBe(
          "preserved",
        );
      if (mode === "changed_empty_root")
        expect(await readFile(join(root, "late-owner"), "utf8")).toBe(
          "preserved",
        );
      if (mode === "replaced_empty_root") {
        expect(await readdir(root)).toEqual([]);
        expect(await readdir(`${root}.original-empty`)).toEqual([]);
      }
      if (succeeds) {
        await access(root);
        const activatedIndex = new DatabaseSync(
          join(root, "codex-home/state_5.sqlite"),
          { readOnly: true },
        );
        try {
          expect(
            activatedIndex
              .prepare("SELECT * FROM threads WHERE id = ?")
              .get("exact-thread"),
          ).toEqual({
            id: "exact-thread",
            rollout_path: join(
              root,
              "codex-home/sessions/rollout-exact-thread.jsonl",
            ),
            history_mode: mode === "home_paginated" ? "paginated" : "legacy",
          });
          expect(
            activatedIndex
              .prepare("SELECT * FROM threads WHERE id = ?")
              .get("unrelated-thread"),
          ).toEqual({
            id: "unrelated-thread",
            rollout_path: "/unrelated/immutable-rollout.jsonl",
            history_mode: "paginated",
          });
        } finally {
          activatedIndex.close();
        }
        const history = coordinator.recoveryHistory as Array<
          Record<string, unknown>
        >;
        const prepared = history.find(
          (entry) => entry.phase === "activation_prepared",
        )!;
        expect(prepared.settledProviderHomeFingerprint).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(history.at(-1)?.settledProviderHomeFingerprint).toBe(
          prepared.settledProviderHomeFingerprint,
        );
        if (legacy) {
          expect(
            await Promise.all(
              source.map(([file]) =>
                readFile(join(legacyDirectory, file), "utf8"),
              ),
            ),
          ).toEqual(legacyBytes);
          expect(
            (coordinator.recoveryHistory as Array<Record<string, unknown>>)[2],
          ).toMatchObject({
            copiedFromRequestId: "native-cleanup:prior",
            copiedFromStagingName: `${key}.cleanup-prior`,
          });
        }
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>)
            .filter((entry) => entry.kind !== "native_cleanup_source_archive")
            .slice(legacy ? 2 : 0)
            .map((entry) => entry.phase),
        ).toEqual([
          "started",
          "staged",
          "launch_intent",
          "spawned",
          "retired",
          "activation_prepared",
          "settled",
        ]);
      } else if (mode === "home_changed_staging") {
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(-1)
            ?.phase,
        ).toBe("operator_required");
      } else if (mode === "home_changed_during_commit") {
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(-1)
            ?.phase,
        ).toBe("settled");
        await access(join(root, "cleanup-activation.json"));
        await expect(
          createRunnerdBackend({
            db: db as unknown as Db,
            execution,
            runnerInstanceId: "successor-runner",
          }),
        ).rejects.toBeInstanceOf(NativeSessionCleanupQuarantinedError);
      } else if (mode === "activation_commit_failure") {
        // Simulate a fresh caller after the in-memory reservation ended.
        // The canonical directory must not look reusable without its
        // committed settlement receipt, and must not be quarantined again.
        await expect(
          createRunnerdBackend({
            db: db as unknown as Db,
            execution,
            runnerInstanceId: "successor-runner",
          }),
        ).rejects.toBeInstanceOf(NativeSessionCleanupQuarantinedError);
        await access(root);
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).map(
            (entry) => entry.phase,
          ),
        ).toEqual([
          "started",
          "staged",
          "launch_intent",
          "spawned",
          "retired",
          "activation_prepared",
          "operator_required",
        ]);
      } else if (mode === "epoch_commit_failure") {
        expect(
          (coordinator.recoveryHistory as Array<Record<string, unknown>>).map(
            (entry) => entry.phase,
          ),
        ).toEqual(["started", "staged", "launch_intent", "operator_required"]);
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      providerHomeDatabase?.close();
      proofSpy.mockRestore();
      state.maintenanceIdle.mockReset().mockReturnValue(true);
      releaseCommit();
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("stopped native conversation physical cleanup", () => {
  it.each(["codex", "acpx"].flatMap(provider => [
    "stopped", "provider_alive", "worker_alive", "missing_receipt", "wrong_receipt", "new_launch",
    "foreign_run", "foreign_company", "foreign_runner", "remote", "unreleased", "changed_state", "changed_pid", "symlink", "startup_intent", "pending_identity", "wrong_schema", "replacement", "replacement_alive", "agent_alive", "checkpoint_owner_alive", "diagnostic_owner_alive", "normalized_session_receipt",
  ].map(mode => ({ provider, mode }))))("$provider $mode", async ({ provider, mode }) => {
    const base = await mkdtemp(join(tmpdir(), "native-conversation-cleanup-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    const input = parseNativeExecutionInput({ ...execution,
      provider: provider === "codex" ? execution.provider : { kind: "acpx", agent: "claude", model: "claude-sonnet-5", permissionPolicy: "interactive",
        profile: { driverKind: "acpx_runtime", protocolVersion: 1, acpxVersion: "0.13.1", agent: "claude", agentProfileVersion: 1,
          agentServerPackage: "@zed-industries/claude-agent-acp", agentServerVersion: "1", agentRuntimePackage: null,
          agentRuntimeVersion: null, commandDigest: "fixture" } },
      session: { ...execution.session, driverKind: provider === "codex" ? "codex_app_server" : "acpx_runtime" },
    });
    const canonical = (value: any): string => value && typeof value === "object" && !Array.isArray(value)
      ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value);
    const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
    const providerScope = input.provider.kind === "acpx" ? { kind: "acpx", agent: input.provider.agent, profile: input.provider.profile } : { kind: "codex" };
    const root = join(base, hash({ schema: "paperclip.native-session-scope.v2", companyId: input.binding.companyId,
      agentId: input.binding.agentId, workspace: { kind: "managed", executionWorkspaceId: input.binding.executionWorkspaceId },
      provider: { driverKind: input.session.driverKind, identity: providerScope }, normalizedSessionId: input.session.normalizedSessionId }));
    const identity = { runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId,
      runnerInstanceId: "runner-crashed", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq: 1,
      sourceEventId: "provider-identity", sourceInstanceId: identity.runnerInstanceId, runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId, turnId: identity.turnId, itemId: identity.itemId,
      priority: 0, emittedAt: new Date().toISOString(), eventType: "session.started",
      payload: { providerDescriptor: { agentProcessId: mode === "agent_alive" ? process.pid : 99_999_996 }, providerSessionId: "provider-session", processId: mode === "provider_alive" ? process.pid : 99_999_998 } };
    const replacement = { ...event, sourceSeq: 2, sourceEventId: "replacement", eventType: "session.reconciled",
      payload: { ...event.payload, processId: mode === "replacement_alive" ? process.pid : 99_999_997, previousProcessId: event.payload.processId } };
    const providerEvents = mode.startsWith("replacement") ? [event, replacement] : [event];
    if (mode === "diagnostic_owner_alive") providerEvents.push({ ...event, eventType: "harness.diagnostic",
      payload: { providerMethod: "acpx/process", role: "acp_agent", pid: process.pid } } as unknown as typeof event);
    const providerState = { schema: mode === "wrong_schema" ? "unknown" : `paperclip.runner.${provider}-provider-state.${provider === "codex" ? "v1" : "v3"}`, lifecycle: "turn_active",
      ...(mode === "startup_intent" ? { startupAttempt: { phase: "intent" } } : {}),
      ...(mode === "pending_identity" ? { pendingEvents: [{ eventType: "session.started" }] } : {}),
    };
    const normalizedEvent = mode === "normalized_session_receipt" ? { ...event, turnId: undefined, itemId: undefined } : event;
    const receipt = { sourceEventId: `${identity.runnerInstanceId}:${identity.runId}:1`,
      sourcePayloadSha256: mode === "wrong_receipt" ? "wrong" : hash(normalizedEvent), payload: { prpEvent: normalizedEvent } };
    const stop = { eventType: mode === "new_launch" ? "native.process_start_requested" : "native.local_process_stopped",
      payload: { processPid: mode === "worker_alive" ? process.pid : 99_999_999, processGroupId: mode === "worker_alive" ? process.pid : 99_999_999 } };
    let queryIndex = 0;
    const db = { select() { const rows = [
      [{ provider: mode === "remote" ? "daytona" : "local", releasedAt: mode === "unreleased" ? null : new Date() }],
      [stop], mode === "missing_receipt" ? [] : [receipt, ...(mode.startsWith("replacement") ? [{ ...receipt, sourceEventId: `${identity.runnerInstanceId}:${identity.runId}:2`, sourcePayloadSha256: hash(replacement), payload: { prpEvent: replacement } }] : [])],
    ][queryIndex++] ?? [];
      const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: () => q,
        then: Promise.resolve(rows).then.bind(Promise.resolve(rows)) }; return q;
    } } as unknown as Db;
    const run = { id: input.binding.runId, companyId: mode === "foreign_company" ? "foreign" : input.binding.companyId,
      agentId: input.binding.agentId, nativeIssueId: input.binding.issueId, runtimeMode: "native", status: "failed", finishedAt: new Date(),
      nativeSessionId: input.session.normalizedSessionId, runnerInstanceId: mode === "foreign_runner" ? "foreign" : identity.runnerInstanceId,
      runnerProfileJson: { sessionCheckpoint: { process: { codexPid: mode === "checkpoint_owner_alive" ? process.pid : null } }, nativeExecutionInput: input, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local") } } as unknown as typeof heartbeatRuns.$inferSelect;
    try {
      await mkdir(join(root, "runner"), { recursive: true });
      await mkdir(join(root, "control-plane"), { recursive: true });
      const runnerPath = join(root, "runner/runner-state.json");
      await writeFile(join(root, "control-plane/control-plane-state.json"), JSON.stringify({ ...durableControlPlaneState(identity), committedEvents: providerEvents.map(payload => ({ envelope: { payload } })) }));
      await writeFile(runnerPath, JSON.stringify(durableRunnerState({ ...identity, ...(mode === "foreign_run" ? { runId: "foreign" } : {}) }, "ready")));
      await writeFile(join(root, `runner/${provider}-provider-state.json`), JSON.stringify(providerState));
      if (mode === "symlink") { await rename(runnerPath, join(base, "external")); await symlink(join(base, "external"), runnerPath); }
      const proof = await verifyStoppedNativeSessionForContinuation(db, run);
      if (["stopped", "changed_state", "changed_pid", "replacement", "normalized_session_receipt"].includes(mode)) {
        expect(proof).not.toBeNull();
        if (mode === "changed_state") await writeFile(runnerPath, "{}");
        const kill = mode === "changed_pid" ? vi.spyOn(process, "kill").mockReturnValue(true) : null;
        try { expect(proof!.retire()).toBe(["stopped", "replacement", "normalized_session_receipt"].includes(mode)); } finally { kill?.mockRestore(); }
        expect(await readFile(join(root, `runner/${provider}-provider-state.json`), "utf8")).toBe(JSON.stringify(providerState));
      } else expect(proof).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("explicit failed native retry physical evidence", () => {
  it.each([
    "suspended",
    "distinct_account",
    "null_account",
    "wrong_account",
    "missing_account",
    "missing_thread",
    "ready",
    "wrong_run",
    "wrong_runner",
    "wrong_thread",
    "active_provider",
    "ambiguous_provider",
    "live_pid",
    "symlink",
    "bootstrap",
    "quarantined_bootstrap",
    "unacknowledged_output",
    "pending_provider_event",
    "pending_tool",
    "unselected_result",
  ])("observes %s without mutating the retained root", async (kind) => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-failed-retry-state-"),
    );
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const canonical = (value: unknown): string =>
      value && typeof value === "object" && !Array.isArray(value)
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
            .join(",")}}`
        : JSON.stringify(value);
    const key = createHash("sha256")
      .update(
        canonical({
          schema: "paperclip.native-session-scope.v2",
          companyId: execution.binding.companyId,
          agentId: execution.binding.agentId,
          workspace: {
            kind: "managed",
            executionWorkspaceId: execution.binding.executionWorkspaceId,
          },
          provider: {
            driverKind: execution.session.driverKind,
            identity: { kind: "codex" },
          },
          normalizedSessionId: execution.session.normalizedSessionId,
        }),
      )
      .digest("hex");
    const root = join(stateBase, key);
    const bootstrap = kind.includes("bootstrap");
    const providerAccount = kind === "null_account" ? null : "backend-account";
    const expectedAccount =
      kind === "wrong_account"
        ? "another-account"
        : kind === "missing_account"
          ? null
          : providerAccount;
    const expectedThread =
      kind === "wrong_thread"
        ? "different-thread"
        : kind === "missing_thread"
          ? ""
          : "exact-thread";
    const retryable = [
      "suspended",
      "distinct_account",
      "null_account",
    ].includes(kind);
    try {
      const identity = {
        runId: execution.binding.runId,
        runnerInstanceId: "runner-retry",
        environmentLeaseId: "lease-retry",
        normalizedSessionId: execution.session.normalizedSessionId,
      };
      if (!bootstrap) {
        await mkdir(join(root, "control-plane"), { recursive: true });
        await mkdir(join(root, "runner"), { recursive: true });
        await writeFile(
          join(root, "control-plane", "control-plane-state.json"),
          JSON.stringify(durableControlPlaneState(identity)),
        );
        const runnerPath = join(root, "runner", "runner-state.json");
        const runner = {
          ...durableRunnerState(
            {
              ...identity,
              ...(kind === "wrong_run" ? { runId: "another-run" } : {}),
            },
            kind === "ready" ? "ready" : "suspended",
          ),
          outbox: kind === "unacknowledged_output" ? [{}] : [],
        };
        if (kind === "symlink") {
          await writeFile(
            join(stateBase, "outside-state.json"),
            JSON.stringify(runner),
          );
          await symlink(join(stateBase, "outside-state.json"), runnerPath);
        } else await writeFile(runnerPath, JSON.stringify(runner));
        await writeFile(
          join(root, "runner", "codex-provider-state.json"),
          JSON.stringify({
            schema: "paperclip.runner.codex-provider-state.v1",
            lifecycle: "prepared",
            threadId: "exact-thread",
            providerSessionId: providerAccount,
            activeProviderTurnId:
              kind === "active_provider" ? "old-turn" : null,
            ambiguousTurnStartPending: kind === "ambiguous_provider",
            config: { provider: "codex", driver: "codex_app_server" },
            pendingEvents: kind === "pending_provider_event" ? [{}] : [],
            queuedEvents: [],
            toolBridge: {
              pending: kind === "pending_tool" ? { call: {} } : {},
            },
            activeProviderResultFingerprint:
              kind === "unselected_result" ? "sha256:uncommitted-result" : null,
          }),
        );
      } else if (kind === "quarantined_bootstrap") {
        await mkdir(
          join(
            stateBase,
            "quarantine",
            `${key}.identity_indeterminate.retained`,
          ),
          { recursive: true },
        );
      }
      const before = await readdir(stateBase);
      const retryInput = {
        execution,
        ...execution.binding,
        nativeSessionId: execution.session.normalizedSessionId!,
        runnerInstanceId:
          kind === "wrong_runner" ? "another-runner" : "runner-retry",
        processPid: kind === "live_pid" ? process.pid : null,
        providerSessionId: expectedThread,
        providerBackendSessionId: expectedAccount,
        processGroupId: null,
        recoveryMode: bootstrap
          ? ("bootstrap_retry" as const)
          : ("exact_checkpoint_resume" as const),
        allowVerifiedBackup: false,
      };
      expect
        .soft(nativeFailedRunRetryStateIsSafe(retryInput))
        .toBe(retryable || kind === "bootstrap");
      if (!bootstrap && kind !== "symlink") {
        const files = [
          "control-plane/control-plane-state.json",
          "runner/runner-state.json",
          "runner/codex-provider-state.json",
        ];
        const bytes = await Promise.all(
          files.map((file) => readFile(join(root, file))),
        );
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              bytes.map((value) =>
                createHash("sha256").update(value).digest("hex"),
              ),
            ),
          )
          .digest("hex");
        const receipt = {
          kind: "native_cleanup_maintenance",
          version: 1,
          phase: "settled",
          requestId: "exact-cleanup",
          nativeSessionId: execution.session.normalizedSessionId,
          runnerInstanceId: "runner-retry",
          providerSessionId: "exact-thread",
          sourceFingerprint: "a".repeat(64),
          settledFingerprint: fingerprint,
        };
        const input = {
          failedExecution: {
            ...execution,
            binding: { ...execution.binding, runId: "failed-before-provider" },
          },
          retiredExecution: execution,
          ...execution.binding,
          failedRunId: "failed-before-provider",
          retiredRunId: execution.binding.runId,
          nativeSessionId: execution.session.normalizedSessionId!,
          runnerInstanceId:
            kind === "wrong_runner" ? "foreign-runner" : "runner-retry",
          providerSessionId: expectedThread,
          providerBackendSessionId: expectedAccount,
          processPid: kind === "live_pid" ? process.pid : 99_999_999,
          processGroupId: 99_999_999,
          receipt,
        };
        expect(nativePreProviderRetryAfterCleanupStateIsSafe(input)).toBe(
          retryable,
        );
        expect(
          nativePreProviderRetryAfterCleanupStateIsSafe({
            ...input,
            receipt: { ...receipt, settledFingerprint: "changed" },
          }),
        ).toBe(false);
        expect(
          nativePreProviderRetryAfterCleanupStateIsSafe({
            ...input,
            receipt: { ...receipt, sourceFingerprint: undefined },
          }),
        ).toBe(false);
        expect(
          nativePreProviderRetryAfterCleanupStateIsSafe({
            ...input,
            receipt: { ...receipt, requestId: "" },
          }),
        ).toBe(false);
      }
      expect(await readdir(stateBase)).toEqual(before);
      if (!bootstrap)
        expect(
          await access(join(root, "control-plane", "control-plane-state.json")),
        ).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(stateBase, { recursive: true, force: true });
    }
  });
});

describe("provider plan synchronization", () => {
  it("prefers the provider's completed Markdown when it is available", () => {
    expect(
      providerPlanMarkdown({
        markdown: "# Release plan\n\n1. Prepare\n2. Deploy",
        explanation: "This fallback must not replace the completed plan.",
        steps: [{ body: "Fallback", status: "pending" }],
      }),
    ).toBe("# Release plan\n\n1. Prepare\n2. Deploy");
  });

  it("extracts a completed plan from the semantic result artifact", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "<proposed_plan>\n# Health check\n\n1. Add endpoint\n2. Verify it\n</proposed_plan>",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add endpoint\n2. Verify it");
  });

  it("decodes the native provider's compact plan reference into readable Markdown", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:health-check-endpoint-v1#1-register-GET-health-return-200-json-status-ok;2-add-API-tests",
          },
        ],
      }),
    ).toBe(
      [
        "# Health check endpoint",
        "",
        "1. Register GET /health return 200 JSON status ok",
        "2. Add API tests",
      ].join("\n"),
    );
  });

  it("decodes a task-scoped native plan URI", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-plan://DOT-13/health-check#1-add-GET-health;2-add-tests",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add GET /health\n2. Add tests");
  });

  it("retains readable Markdown embedded after a native provider plan reference", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:DOT-14-health-check-v1\n1. Add `GET /health`.\n2. Add tests.",
          },
        ],
      }),
    ).toBe("# Health check\n\n1. Add `GET /health`.\n2. Add tests.");
  });

  it("normalizes a plain numbered native provider plan", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "1. Add GET /health. | 2. Add tests. | 3. Document it.",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. Add GET /health.\n2. Add tests.\n3. Document it.");
  });

  it("normalizes a task-labelled inline numbered plan", () => {
    expect(
      semanticProviderPlanMarkdown({
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "DOT-16 plan: (1) add GET /health; (2) add tests; (3) document it.",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("uses an explicitly numbered semantic summary when the artifact is opaque", () => {
    expect(
      semanticProviderPlanMarkdown({
        summary:
          "Native provider plan completed: 1) add GET /health; 2) add tests; 3) document it.",
        artifacts: [
          {
            kind: "native_provider_plan",
            ref: "native-provider-plan:DOT-18:health-check",
          },
        ],
      }),
    ).toBe("# Plan\n\n1. add GET /health\n2. add tests\n3. document it.");
  });

  it("renders a bounded Markdown checklist without embedding provenance", () => {
    const markdown = providerPlanMarkdown({
      explanation: "Release safely",
      steps: [
        { body: "Prepare", status: "completed" },
        { body: "Deploy", status: "in_progress" },
        { body: "Verify", status: "blocked" },
      ],
      runId: "must-not-appear",
      providerThreadId: "native-secret",
    });
    expect(markdown).toBe(
      [
        "Release safely",
        "",
        "- [x] Prepare",
        "- [ ] Deploy _(in progress)_",
        "- [ ] Verify _(blocked)_",
      ].join("\n"),
    );
    expect(markdown).not.toContain("must-not-appear");
    expect(markdown).not.toContain("native-secret");
  });
});

describe("native conversation replies", () => {
  const reply: PrpEvent = {
    schema: "paperclip.prp.event.v1", sourceInstanceId: "runner-1",
    sourceEventId: "runner-1:run-1:8", sourceSeq: 8, sourceKind: "runner",
    runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1",
    eventType: "item.completed", schemaVersion: 1, priority: 1,
    emittedAt: "2026-09-11T18:00:00.000Z",
    payload: { kind: "agentMessage", channel: "final", text: "Which project should own this?" },
  };
  const terminal = { ...reply, sourceEventId: "runner-1:run-1:9", sourceSeq: 9,
    eventType: "turn.completed", payload: { status: "completed" } } as PrpEvent;
  const input = { conversation: true, replyEvent: reply, terminalEvent: terminal,
    completionContract: { revision: "1", objective: "Ongoing conversation",
      criteria: [{ id: "objective", requirement: "Help the user" }] } };

  it("yields an evidenced completed reply without claiming execution completion", () => {
    expect(nativeConversationReplyResult(input)).toMatchObject({
      reportedWorkDisposition: "yielded", summary: "Which project should own this?",
      completionClaim: { objectiveSatisfied: false, criteria: [{ status: "unknown" }] },
      evidence: [{ ref: "run-event:runner-1:run-1:8" }],
      continuation: { kind: "response_wake" }, attentionRequests: [],
    });
  });

  it.each(["turn.failed", "turn.cancelled", "turn.interrupted"])(
    "does not reinterpret a %s provider turn as a chat reply", (eventType) => {
      expect(nativeConversationReplyResult({ ...input,
        terminalEvent: { ...terminal, eventType } as PrpEvent })).toBeNull();
    },
  );

  it("keeps ordinary execution tasks and absent or unfinished replies fail-closed", () => {
    expect(nativeConversationReplyResult({ ...input, conversation: false })).toBeNull();
    expect(nativeConversationReplyResult({ ...input, replyEvent: null })).toBeNull();
    for (const payload of [
      { kind: "agentMessage", channel: "progress", text: "Still working" },
      { kind: "agentMessage", channel: "final", text: " " },
      { kind: "toolCall", channel: "final", text: "Tool result" },
    ]) expect(nativeConversationReplyResult({ ...input, replyEvent: { ...reply, payload } })).toBeNull();
  });

  it.each(["runId", "turnId", "normalizedSessionId"] as const)(
    "rejects a final message from another %s", (key) => {
      expect(nativeConversationReplyResult({ ...input,
        replyEvent: { ...reply, [key]: "old-authority" } })).toBeNull();
    },
  );
});

describe("native governed waits", () => {
  it("yields to an existing tools-refresh wake without claiming completion or a human interaction", () => {
    const result = nativeToolsRefreshWaitResult({
      wakeId: "wake-1",
      key: "connection-intent:tools:run-1:digest",
      completionContract: {
        revision: "4",
        objective: "Read the archive",
        criteria: [{ id: "read", requirement: "Read the archive" }],
      },
    });
    expect(result.completionClaim).toMatchObject({
      contractRevision: "4",
      objectiveSatisfied: false,
    });
    expect(result.artifacts).toEqual([]);
    expect(result.continuation).toMatchObject({
      kind: "same_agent",
      idempotencyKey: "connection-intent:tools:run-1:digest",
    });
    expect(result.evidence).toEqual([{ ref: "wakeup:wake-1" }]);
  });

  it("turns a durable pending interaction into a response-wake result", () => {
    expect(
      nativeGovernedWaitResult({
        interaction: {
          id: "interaction-1",
          title: "Choose an output format",
          summary: null,
        },
        completionContract: {
          revision: "contract-v3",
          objective: "Create the requested output",
          criteria: [{ id: "objective", requirement: "The output is created" }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary: "Waiting for Choose an output format.",
        completionClaim: expect.objectContaining({
          contractRevision: "contract-v3",
          objectiveSatisfied: false,
          criteria: [
            {
              criterionId: "objective",
              status: "unknown",
              evidenceRefs: ["interaction:interaction-1"],
            },
          ],
        }),
        evidence: [{ ref: "interaction:interaction-1" }],
        attentionRequests: [],
        continuation: {
          kind: "response_wake",
          summary:
            "Resume from the resolved interaction response without repeating prior work.",
          idempotencyKey: "interaction-response:interaction-1",
        },
      }),
    );
  });

  it("keeps an authority-checked partial item-verdict interaction as the wait target", () => {
    const partial = structuredClone(execution);
    partial.interactionResponses = [
      {
        interactionId: "interaction-partial",
        kind: "request_item_verdicts",
        response: {
          status: "pending",
          result: {
            version: 1,
            complete: false,
            items: [{ id: "alpha", verdict: "approve" }],
          },
        },
      },
    ];
    expect(continuingPendingInteractionIds(partial)).toEqual([
      "interaction-partial",
    ]);

    partial.interactionResponses[0]!.response.status = "answered";
    expect(continuingPendingInteractionIds(partial)).toEqual([]);
  });

  it("consumes an exact replay observation once without leaking stale state", async () => {
    const waitResult = nativeGovernedWaitResult({
      interaction: {
        id: "interaction-replayed",
        title: "Approve the replayed operation",
        summary: null,
      },
      completionContract: {
        revision: "contract-v3",
        objective: "Complete the approved operation",
        criteria: [{ id: "objective", requirement: "Complete it" }],
      },
    });
    const observation = createGovernedWaitEventObservation(
      async () => waitResult,
    );
    const replayedEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1" as const,
      sourceInstanceId: "runner-recovered",
      sourceEventId: "runner-recovered:item:7",
      sourceSeq: 7,
      sourceKind: "runner" as const,
      runId: "run-recovered",
      normalizedSessionId: "session-recovered",
      turnId: "turn-recovered",
      eventType: "item.completed" as const,
      schemaVersion: 1,
      priority: 0 as const,
      emittedAt: "2026-08-31T00:00:00.000Z",
      payload: { kind: "dynamicToolCall" },
    };

    // The durable fallback preserves the question after provider loss, but
    // cannot turn that lost execution into a successful governed wait.
    const providerLost = { ...replayedEvent, eventType: "runtime_request.expired" as const,
      payload: { reason: "provider_process_lost", replayAllowed: false } };
    const lostObservation = createGovernedWaitEventObservation(async () => waitResult);
    await lostObservation.observe(providerLost, true);
    expect(lostObservation.consume(providerLost)).toBeNull();
    await lostObservation.observe(replayedEvent, true);
    expect(lostObservation.consume(replayedEvent)).toBeNull();

    // The event consumer can lag the provider: a commentary event emitted
    // before the tool began may be processed after its approval exists in DB.
    // It is not proof that the approval-creating tool response has settled.
    const commentary = { ...replayedEvent, payload: { kind: "agentMessage", channel: "progress", text: "I am invoking the connected tool." } };
    await observation.observe(commentary, true);
    expect(observation.consume(commentary)).toBeNull();

    // A failed tool is terminal too, even when its error event omits kind.
    // It must not block the later approval tool from parking this run.
    await observation.observe({ ...replayedEvent, eventType: "item.started", itemId: "failed-command", payload: { kind: "commandExecution" } }, false);
    await observation.observe({ ...replayedEvent, eventType: "item.failed", itemId: "failed-command", payload: { error: "Command exited with status 1" } }, false);

    // A usage event must not park while the card-creation response is held.
    await observation.observe({ ...replayedEvent, eventType: "item.started", itemId: "approval-tool" }, false);
    const usage = { ...replayedEvent, payload: { kind: "usage" } };
    await observation.observe(usage, true);
    expect(observation.consume(usage)).toBeNull();
    const other = { ...replayedEvent, itemId: "other-tool" };
    await observation.observe(other, true);
    expect(observation.consume(other)).toBeNull();
    await observation.observe({ ...replayedEvent, itemId: "approval-tool" }, true);
    expect(observation.consume({ ...replayedEvent, itemId: "approval-tool" })).toEqual(waitResult);

    await observation.observe(replayedEvent, true);
    expect(observation.consume(replayedEvent)).toEqual(waitResult);
    expect(observation.consume(replayedEvent)).toBeNull();

    await observation.observe(replayedEvent, true);
    expect(
      observation.consume({
        ...replayedEvent,
        sourceEventId: "runner-recovered:item:8",
        sourceSeq: 8,
      }),
    ).toBeNull();
    expect(observation.consume(replayedEvent)).toBeNull();

    let resolveLookup!: (value: typeof waitResult) => void;
    const delayedObservation = createGovernedWaitEventObservation(
      () =>
        new Promise<typeof waitResult>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const observing = delayedObservation.observe(replayedEvent, true);
    expect(delayedObservation.consume(replayedEvent)).toBeNull();
    resolveLookup(waitResult);
    await observing;
    expect(delayedObservation.consume(replayedEvent)).toBeNull();
  });
});

type LeaseCoordinator = {
  runId: string;
  companyId: string;
  issueId: string;
  phase: string;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  resultId: string | null;
};

function leaseDb(
  boundExecution: NativeExecutionInputV1 = execution,
  coordinatorOverrides: Partial<LeaseCoordinator> = {},
  runResultJson: Record<string, unknown> = {},
  updates: Array<{ table: unknown; values: Record<string, unknown> }> = [],
  runnerProfileJson: Record<string, unknown> = {},
  runStatus = "running",
  priorAccountingEvents: PrpEvent[] = [],
): Db {
  const coordinator: LeaseCoordinator = {
    runId: boundExecution.binding.runId,
    companyId: boundExecution.binding.companyId,
    issueId: boundExecution.binding.issueId,
    phase: "observed",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultId: null,
    ...coordinatorOverrides,
  };
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      return {
        where: () => {
          updates.push({ table, values });
          const result = Promise.resolve([]) as unknown as Promise<
            unknown[]
          > & {
            returning: () => Promise<Array<{ runId: string }>>;
          };
          result.returning = () =>
            Promise.resolve([{ runId: coordinator.runId, nextEventSeq: 2 }]);
          return result;
        },
      };
    },
  });
  const select = () => ({
    from: (table: unknown) => {
      const rows =
        table === nativeRunFinalizations
          ? [coordinator]
          : table === heartbeatRuns
            ? [
                {
                  id: boundExecution.binding.runId,
                  agentId: boundExecution.binding.agentId,
                  companyId: boundExecution.binding.companyId,
                  nativeIssueId: boundExecution.binding.issueId,
                  resultJson: runResultJson,
                  runnerProfileJson,
                  runtimeMode: "native",
                  status: runStatus,
                },
              ]
            : table === issues
              ? [
                  {
                    id: boundExecution.binding.issueId,
                    companyId: boundExecution.binding.companyId,
                    assigneeAgentId: boundExecution.binding.agentId,
                    status: "in_progress",
                    executionRunId: boundExecution.binding.runId,
                    checkoutRunId: null,
                  },
                ]
              : table === heartbeatRunEvents
                ? priorAccountingEvents.map((event, seq) => ({ seq, eventType: event.eventType, sourceSeq: event.sourceSeq, payload: { prpEvent: event } }))
                : [];
      const query = {
        then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
        where: () => query,
        orderBy: () => query,
        for: () => query,
        limit: () => query,
      };
      return query;
    },
  });
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      const query = { returning: async () => [values], onConflictDoUpdate: () => query, onConflictDoNothing: () => query,
        then: Promise.resolve([values]).then.bind(Promise.resolve([values])) };
      return query;
    },
  });
  const tx = {
    insert,
    execute: async () => [],
    select,
    update,
  };
  return {
    insert,
    select,
    transaction: async (operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
    update,
  } as unknown as Db;
}

function cancellationDb(options?: {
  coordinator?: {
    runId: string;
    assessmentId: string | null;
    decisionId?: string | null;
    phase?: string;
    failureCode?: string | null;
  } | null;
  status?: string;
  failResultJsonUpdateAt?: number;
  ownershipHeld?: boolean;
  resultJson?: Record<string, unknown>;
}) {
  const initialRun = {
    id: execution.binding.runId,
    agentId: execution.binding.agentId,
    companyId: execution.binding.companyId,
    nativeIssueId: execution.binding.issueId,
    runtimeMode: "native",
    status: options?.status ?? "running",
    ...(options?.ownershipHeld
      ? {
          status: "running",
          nativePhase: "terminal_failure",
          errorCode: "native_execution_ownership_unverified",
        }
      : {}),
    contextSnapshot: { issueId: "untrusted-context-issue" },
    resultJson: { staleSnapshot: true },
  };
  let currentResultJson: Record<string, unknown> = {
    durableReceipt: { operationId: "operation-1" },
    ...options?.resultJson,
  };
  const issue = {
    status: "in_progress",
    statusVersion: 3,
    lastStatusDecisionId: null,
  };
  const coordinator =
    options && "coordinator" in options
      ? options.coordinator
      : { runId: execution.binding.runId, assessmentId: null };
  let forUpdateCount = 0;
  let resultJsonUpdateCount = 0;
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const rows =
        table === heartbeatRuns
          ? [{ ...initialRun, resultJson: currentResultJson }]
          : table === issues
            ? [issue]
            : table === nativeRunFinalizations && coordinator
              ? [coordinator]
              : [];
      const result = Promise.resolve(rows);
      type Query = {
        where: () => Query;
        for: () => Query;
        limit: () => Promise<typeof rows>;
      };
      const query = {} as Query;
      Object.assign(query, {
        where: () => query,
        for: () => {
          forUpdateCount += 1;
          return query;
        },
        limit: () => result,
      });
      return query;
    },
  }));
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updates.push({ table, values });
        if (table === nativeRunFinalizations && coordinator) Object.assign(coordinator, values);
        const updatesResultJson = "resultJson" in values;
        if (updatesResultJson) resultJsonUpdateCount += 1;
        const shouldFail =
          updatesResultJson &&
          resultJsonUpdateCount === options?.failResultJsonUpdateAt;
        if (updatesResultJson && !shouldFail) {
          currentResultJson = values.resultJson as Record<string, unknown>;
        }
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          returning: () => Promise<Array<{ id: string }>>;
        };
        result.returning = () =>
          shouldFail
            ? Promise.reject(new Error("post_dispatch_db_failure"))
            : Promise.resolve([{ id: execution.binding.runId }]);
        return result;
      },
    }),
  }));
  const tx = { select, update };
  const db = {
    select,
    update,
    transaction: async (operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
  } as unknown as Db;
  return {
    db,
    updates,
    getForUpdateCount: () => forUpdateCount,
    getResultJson: () => currentResultJson,
    getResultJsonUpdateCount: () => resultJsonUpdateCount,
    tx,
  };
}

describe("native startup cancellation fence", () => {
  it.each(["startupCancellation", "nativeCancellation"])("does not submit a turn when %s arrives during session opening", async (marker) => {
    const resultJson: Record<string, unknown> = {};
    const cancel = vi.fn(() => ({ cleanup: Promise.resolve() }));
    const submit = vi.fn();
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      // The coordinator claim succeeded, but Stop won before the session handle
      // was published. This is the gap exercised by the live stop/new eval.
      resultJson[marker] = marker === "startupCancellation"
        ? { requestedAt: new Date().toISOString() }
        : { scope: "run", dispatchState: "acknowledged" };
      try {
        await options.onSession({ cancel });
        submit();
      } finally {
        await options.onSession(null);
      }
      throw new Error("provider should not have been submitted");
    });
    await expect(executePaperclipNativeSession({
      db: leaseDb(execution, {}, resultJson), execution, runnerInstanceId: "startup-stop",
    })).rejects.toThrow("native_cancellation_pending_recovery");
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("native startup restart detachment", () => {
  it("waits for a checkpointed governed settlement before relinquishing its controller", async () => {
    const restarting = structuredClone(execution);
    restarting.binding.runId = "restart-governed-settlement";
    let release!: () => void, announce!: () => void;
    const accounting = new Promise<void>(resolve => { release = resolve; });
    const checkpointed = new Promise<void>(resolve => { announce = resolve; });
    const detach = vi.fn(async () => undefined);
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession({ detachControllerForRestart: detach });
      await options.onCheckpoint({ governedWait: { sourceEvent: { turnId: "settling-turn" } } });
      announce();
      await accounting;
      await options.onSession(null);
      throw new Error("settlement test complete");
    });
    const outcome = executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting, runnerInstanceId: "runner" }).catch(error => error);
    await checkpointed;
    const detached = detachNativeSessionsForRestart([restarting.binding.runId]);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(detach).not.toHaveBeenCalled();
      release();
      await outcome;
      expect(await detached).toMatchObject({ inactiveRunIds: [restarting.binding.runId] });
      expect(detach).not.toHaveBeenCalled();
    } finally { release(); await outcome; await detached; }
  });
  it("bounds governed settlement without allowing the detached controller to publish success", async () => {
    const restarting = structuredClone(execution);
    restarting.binding.runId = "restart-governed-settlement-timeout";
    let release!: () => void, announce!: () => void;
    const accounting = new Promise<void>(resolve => { release = resolve; });
    const checkpointed = new Promise<void>(resolve => { announce = resolve; });
    const detach = vi.fn(async () => undefined);
    const onUsage = vi.fn(async () => undefined);
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession({ detachControllerForRestart: detach });
      await options.onCheckpoint({ governedWait: { sourceEvent: { turnId: "settling-turn" } } });
      announce(); await accounting;
      await options.onSession(null);
      return { result: {}, terminal: { runTerminalState: "succeeded" }, usage: null };
    });
    const outcome = executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting, runnerInstanceId: "runner", onUsage }).catch(error => error);
    await checkpointed;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const detaching = detachNativeSessionsForRestart([restarting.binding.runId]);
    try {
      await vi.advanceTimersByTimeAsync(19_999);
      expect(detach).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await detaching).toMatchObject({ detachedRunIds: [restarting.binding.runId] });
      release();
      expect(await outcome).toBeInstanceOf(NativeControllerDetachedForRestartError);
      expect(onUsage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); release(); await outcome; await detaching; }
  });
  it("waits for in-flight runner startup and its detach acknowledgement before shutdown returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-startup-detach-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = root;
    const restarting = structuredClone(execution);
    restarting.binding.runId = "restart-inflight-bootstrap";
    restarting.session.normalizedSessionId = "restart-inflight-session";
    let open!: () => void, started!: () => void, acknowledge!: () => void;
    const opening = new Promise<void>(resolve => { open = resolve; });
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const detached = vi.fn();
    const detach = vi.fn(async () => { await acknowledgement; });
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      started();
      await opening;
      await options.onSession({ detachControllerForRestart: detach });
      await options.onSession(null);
      throw new Error("detachment closed the old event stream");
    });
    const running = executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting, runnerInstanceId: "runner", useRunnerd: true });
    const outcome = running.catch(error => error);
    let detaching: Promise<unknown> | undefined;
    try {
      await admitted;
      detaching = detachNativeSessionsForRestart([restarting.binding.runId]).then(detached);
      await new Promise(resolve => setImmediate(resolve));
      expect(detached).not.toHaveBeenCalled();
      open();
      await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
      expect(detached).not.toHaveBeenCalled();
      acknowledge();
      await detaching;
      expect(detached).toHaveBeenCalledWith(expect.objectContaining({ detachedRunIds: [restarting.binding.runId] }));
      expect(await outcome).toBeInstanceOf(NativeControllerDetachedForRestartError);
    } finally {
      open(); acknowledge();
      await outcome;
      await detaching;
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a governed completion returned successfully by an already detached controller", async () => {
    const restarting = structuredClone(execution);
    restarting.binding.runId = "restart-successful-old-consumer";
    const detach = vi.fn(async () => undefined);
    const onUsage = vi.fn(async () => undefined);
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession({ detachControllerForRestart: detach });
      await detachNativeSessionsForRestart([restarting.binding.runId]);
      await options.onSession(null);
      return { result: {},
        terminal: { runTerminalState: "succeeded" }, usage: null };
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting,
      runnerInstanceId: "runner", onUsage })).rejects.toBeInstanceOf(NativeControllerDetachedForRestartError);
    expect(detach).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles failed startup without claiming detachment (deadline exceeded: %s)", async (exceedDeadline) => {
    const root = await mkdtemp(join(tmpdir(), "native-startup-failure-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = root;
    const restarting = structuredClone(execution);
    restarting.binding.runId = `restart-failed-bootstrap-${exceedDeadline}`;
    restarting.session.normalizedSessionId = `restart-failed-session-${exceedDeadline}`;
    let release!: () => void, started!: () => void;
    const opening = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { started = resolve; });
    state.execute.mockReset().mockImplementationOnce(async () => {
      started();
      await opening;
      throw new Error("bootstrap failed before session publication");
    });
    const outcome = executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting, runnerInstanceId: "runner", useRunnerd: true }).catch(error => error);
    try {
      await admitted;
      if (exceedDeadline) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const detached = detachNativeSessionsForRestart([restarting.binding.runId]).catch(error => error);
      if (exceedDeadline) {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await detached).toMatchObject({ message: "native_restart_startup_not_ready" });
        vi.useRealTimers();
      } else {
        release();
        expect(await detached).toMatchObject({ detachedRunIds: [], inactiveRunIds: [restarting.binding.runId] });
      }
    } finally {
      vi.useRealTimers();
      release();
      await outcome;
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("remembers shutdown while the session is still opening and detaches its late publication", async () => {
    const restarting = structuredClone(execution);
    restarting.binding.runId = "restart-during-session-open";
    const detach = vi.fn(async () => undefined);
    await expect(detachNativeSessionsForRestart([restarting.binding.runId])).resolves.toMatchObject({ inactiveRunIds: [restarting.binding.runId] });
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      await options.onSession({ detachControllerForRestart: detach });
      expect(detach).toHaveBeenCalledOnce();
      await options.onSession(null);
      throw new Error("detachment closed the old event stream");
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(restarting), execution: restarting, runnerInstanceId: "runner" })).rejects.toBeInstanceOf(NativeControllerDetachedForRestartError);
  });
});

describe("native terminal-turn accounting", () => {
  it.each([false, true])("prices only complete direct Claude API turn accounting (%s)", async complete => {
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const { priceAnthropicReceipt } = await import("../anthropic-pricing.js");
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const counts = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 20, providerCostUsd: 0 };
    state.execute.mockReset().mockImplementationOnce(async () => {
      const notification = rehydrateRunnerdUsageNotification({ provider: "acpx", cumulative: { ...counts, providerCostUsd: 10 }, runDelta: counts, runDeltaAvailable: complete }, "session", "turn");
      await accountingEvents.committed!({ eventType: "item.completed", turnId: "turn", payload: { kind: "usage", usage: notification.tokenUsage } } as unknown as PrpEvent);
      await accountingEvents.committed!({ eventType: "turn.interrupted", turnId: "turn", payload: {} } as unknown as PrpEvent);
      return { result: { summary: "Waiting for approval" }, terminal: { runTerminalState: "succeeded" }, turnId: "turn", normalizedSessionId: "session", providerSessionId: null, driverKind: "acpx_runtime", driverVersion: "1", nativeEventCount: 2, highestContiguousSourceSeq: 2, usage: null };
    });
    await executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind: "acpx", agent: "claude", model: "claude-sonnet-5" } } as NativeExecutionInput, runnerInstanceId: "runner", runnerEnvironment: { ANTHROPIC_API_KEY: "fixture" }, onUsage });
    const receipt = onUsage.mock.calls.at(-1)![0];
    const priced = priceAnthropicReceipt(receipt);
    if (complete) expect(priced).toMatchObject({ complete: true, costStatus: "estimated", costUsdExact: "0.000150000" });
    else expect(priced).toMatchObject({ complete: false, costStatus: "unpriced", costUsd: null });
  });
  it.each(["claude", "codex"].flatMap(agent => [false, true].flatMap(restart =>
    [false, true].flatMap(partialFirst => [false, true].map(zeroFirst => ({ agent, restart, partialFirst, zeroFirst }))),
  )))("accumulates ACPX turns for $agent (restart: $restart, partial: $partialFirst, zero first: $zeroFirst)", async ({ agent, restart, partialFirst, zeroFirst }) => {
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const event = (eventType: string, turnId: string, sourceSeq: number, payload: object = {}) => ({
      eventType, turnId, sourceSeq, sourceInstanceId: "provider", emittedAt: new Date().toISOString(), payload,
    }) as unknown as PrpEvent;
    const usage = (turnId: string, inputTokens: number, outputTokens: number, complete: boolean) => ({
      kind: "usage", usage: rehydrateRunnerdUsageNotification({ provider: "acpx", runDeltaAvailable: complete,
        cumulative: { inputTokens: 0, outputTokens: 0, providerCostUsd: 10 },
        runDelta: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 },
      }, "session", turnId).tokenUsage,
    });
    const first = [event("turn.started", "first", 1), event("item.completed", "first", 2, usage("first", zeroFirst ? 0 : 12, zeroFirst ? 0 : 4, !partialFirst)), event("turn.failed", "first", 3)];
    const second = [event("turn.started", "second", 4), event("item.completed", "second", 5, usage("second", 20, 6, true)), event("turn.completed", "second", 6)];
    state.execute.mockReset().mockImplementationOnce(async () => {
      for (const entry of [...(restart ? [] : first), ...second]) await accountingEvents.committed!(entry);
      for (const entry of [...first, ...second]) await accountingEvents.duplicate!(entry);
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" }, turnId: "second",
        normalizedSessionId: "session", providerSessionId: null, driverKind: "acpx_runtime", driverVersion: "1",
        nativeEventCount: 6, highestContiguousSourceSeq: 6, usage: null };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(execution, {}, {}, [], {}, "running", restart ? first : []),
      execution: { ...execution, provider: { kind: "acpx", agent, model: agent === "codex" ? "gpt-6-astra" : "claude-sonnet-4-6" } } as NativeExecutionInput,
      runnerInstanceId: "runner", runnerEnvironment: { OPENAI_API_KEY: "fixture" }, onUsage });
    expect(result).toMatchObject({ usageComplete: !partialFirst,
      usage: { inputTokens: partialFirst || zeroFirst ? 20 : 32, outputTokens: partialFirst || zeroFirst ? 6 : 10 } });
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: !partialFirst }));
    if (partialFirst) expect(result.costStatus).toBe("unpriced");
    if (zeroFirst && !partialFirst) {
      expect(result.costUsdExact).toBeUndefined();
      expect(result.costUsd).toBeNull();
    }
    if (agent === "codex" && !partialFirst) {
      const { priceCodexReceipt } = await import("../codex-pricing.js");
      const priced = priceCodexReceipt(onUsage.mock.calls.at(-1)![0]);
      expect(priced.costStatus).toBe("estimated");
      expect(Number(priced.costUsdExact)).toBeCloseTo(zeroFirst ? 0.0005 : 0.00082, 9);
    }
  });

  it.each(["claude", "codex"].flatMap(agent =>
    ["missing", "partial", "complete_zero", "later_partial", "recovered"].map(scenario => ({ agent, scenario })),
  ))("honors runner completeness for ACPX $agent ($scenario)", async ({ agent, scenario }) => {
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const complete = ["complete_zero", "recovered"].includes(scenario);
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 };
    const full = { ...zero, inputTokens: 12, outputTokens: 4 };
    const reports = scenario === "complete_zero" ? [{ runDelta: zero, runDeltaAvailable: true }]
      : scenario === "later_partial" ? [{ runDelta: full, runDeltaAvailable: true }, { runDelta: zero, runDeltaAvailable: false }]
      : scenario === "recovered" ? [{ runDelta: zero, runDeltaAvailable: false }, { runDelta: full, runDeltaAvailable: true }]
      : [{ runDelta: scenario === "partial" ? { ...zero, inputTokens: 12 } : zero, runDeltaAvailable: false }];
    state.execute.mockReset().mockImplementationOnce(async () => {
      for (const observe of [accountingEvents.committed!, accountingEvents.duplicate!]) {
        for (const report of reports) {
          const notification = rehydrateRunnerdUsageNotification({ provider: "acpx", cumulative: { ...full, providerCostUsd: 10 }, ...report }, "session", "turn");
          await observe({ eventType: "item.completed", turnId: "turn", payload: { kind: "usage", usage: notification.tokenUsage } } as unknown as PrpEvent);
        }
        await observe({ eventType: "turn.completed", turnId: "turn", payload: {} } as unknown as PrpEvent);
        expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete }));
        if (!complete) expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ costUsd: null, costStatus: "unpriced" }));
      }
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" }, turnId: "turn",
        normalizedSessionId: "session", providerSessionId: null, driverKind: "acpx_runtime", driverVersion: "1", nativeEventCount: 2, highestContiguousSourceSeq: 2,
        usage: { runDelta: full, runDeltaComplete: true } };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution,
      provider: { kind: "acpx", agent, model: agent === "codex" ? "gpt-6-astra" : "claude-sonnet-4-6" } } as NativeExecutionInput,
      runnerInstanceId: "runner", onUsage });
    expect(result).toMatchObject({ usageComplete: complete });
    if (!complete) expect(result).toMatchObject({ costUsd: null, costStatus: "unpriced" });
    else expect(result.usage).toMatchObject({ inputTokens: scenario === "complete_zero" ? 0 : 12, outputTokens: scenario === "complete_zero" ? 0 : 4 });
  });

  it.each([0, 0.25])("keeps interrupted AgentCore accounting pending despite cumulative cost %s", async providerCostUsd => {
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const total = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd };
    const notification = rehydrateRunnerdUsageNotification({ provider: "aws_agentcore", cumulative: total, runDelta: null, runDeltaAvailable: false }, "session", "turn");
    state.execute.mockReset().mockImplementationOnce(async () => {
      for (const observe of [accountingEvents.committed!, accountingEvents.duplicate!]) {
        await observe({ eventType: "item.completed", turnId: "turn", payload: { kind: "usage", usage: notification.tokenUsage } } as unknown as PrpEvent);
        await observe({ eventType: "turn.interrupted", turnId: "turn", payload: {} } as unknown as PrpEvent);
        expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false, costStatus: "unpriced" }));
      }
      return { result: { summary: "interrupted" }, terminal: { runTerminalState: "cancelled" }, turnId: "turn",
        normalizedSessionId: "session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 2, highestContiguousSourceSeq: 2, usage: { total } };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind: "aws_agentcore", model: "managed-model", agentCoreProfile: { profileId: "agentcore-test" } } } as unknown as NativeExecutionInput, runnerInstanceId: "runner", onUsage });
    expect(result).toMatchObject({ usageComplete: false, costStatus: "unpriced", billingType: "metered_api" });
  });

  it.each(["claude_managed", "aws_agentcore"] as const)("settles fresh runner receipts for %s and preserves estimated pricing", async kind => {
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const total = { inputTokens: 121, outputTokens: 18, cacheReadTokens: 33, cacheWriteTokens: 15, providerCostUsd: 1.25 };
    const delta = { inputTokens: 21, outputTokens: 8, cacheReadTokens: 13, cacheWriteTokens: 5, providerCostUsd: 0.25 };
    const notification = rehydrateRunnerdUsageNotification({ provider: kind, cumulative: total, runDelta: delta, runDeltaAvailable: true }, "session", "turn");
    state.execute.mockReset().mockImplementationOnce(async () => {
      for (const observe of [accountingEvents.committed!, accountingEvents.duplicate!]) {
        await observe({ eventType: "item.completed", turnId: "turn", payload: { kind: "usage", usage: notification.tokenUsage } } as unknown as PrpEvent);
        await observe({ eventType: "turn.completed", turnId: "turn", payload: {} } as unknown as PrpEvent);
        expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true, costUsd: 0.25,
          costStatus: kind === "aws_agentcore" ? "estimated" : undefined,
          usage: { inputTokens: 26, outputTokens: 8, cachedInputTokens: 13, cacheWriteTokens: 5 } }));
      }
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" },
        turnId: "turn", normalizedSessionId: "session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 2, highestContiguousSourceSeq: 2, usage: { total } };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind, model: "managed-model", managedProfile: { profileId: "managed-test" }, agentCoreProfile: { profileId: "agentcore-test" } } } as unknown as NativeExecutionInput, runnerInstanceId: "runner", onUsage });
    expect(result).toMatchObject({ usageComplete: true, costUsd: 0.25, billingType: "metered_api", costStatus: kind === "aws_agentcore" ? "estimated" : undefined });
  });

  it.each([
    { provider: "codex", restart: false }, { provider: "codex", restart: true },
    { provider: "opencode", restart: false }, { provider: "opencode", restart: true },
  ] as const)("preserves earlier turns for $provider (restart: $restart)", async ({ provider, restart }) => {
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const event = (eventType: string, turnId: string, sourceSeq: number, payload: object = {}) => ({
      eventType, turnId, sourceSeq, sourceInstanceId: "provider", emittedAt: new Date().toISOString(), payload,
    }) as unknown as PrpEvent;
    const first = [event("turn.started", "first", 1), event("item.completed", "first", 2, { kind: "usage", usage: {
      runDelta: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 2, providerCostUsd: 0.25 },
    } }), event("turn.failed", "first", 3)];
    const second = [event("turn.started", "second", 4), event("item.completed", "second", 5, { kind: "usage", usage: {
      runDelta: { inputTokens: 20, cacheReadTokens: 6, cacheWriteTokens: 2, outputTokens: 4, providerCostUsd: 0.5 },
    } }), event("turn.completed", "second", 6)];
    state.execute.mockReset().mockImplementationOnce(async () => {
      for (const entry of [...(restart ? [] : first), ...second]) await accountingEvents.committed!(entry);
      for (const entry of provider === "opencode" ? [...first, ...second] : second) await accountingEvents.duplicate!(entry);
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" }, turnId: "second",
        normalizedSessionId: "session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 6,
        highestContiguousSourceSeq: 6, usage: null };
    });
    const result = await executePaperclipNativeSession({
      db: leaseDb(execution, {}, {}, [], {}, "running", restart ? first : []),
      execution: { ...execution, provider: { kind: provider, model: provider === "opencode" ? "openai/test" : "gpt-6-astra" } } as NativeExecutionInput,
      runnerInstanceId: "runner", onUsage,
    });
    const usage = provider === "opencode"
      ? { inputTokens: 33, cachedInputTokens: 9, cacheWriteTokens: 3, outputTokens: 6 }
      : { inputTokens: 14, cachedInputTokens: 6, cacheWriteTokens: 2, outputTokens: 4 };
    expect(result).toMatchObject({ usageComplete: true, costUsd: provider === "opencode" ? 0.75 : 0.5, usage });
    if (provider === "opencode") expect(result.costUsdExact).toBe("0.750000000");
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true, costUsd: result.costUsd, usage }));
  });

  it.each(["missing_usage", "partial_usage", "missing_terminal", "unknown_price", "late_update"] as const)("keeps OpenCode retry accounting conservative (%s)", async scenario => {
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    let seq = 0;
    const emit = (eventType: string, turnId: string, payload: object = {}) => accountingEvents.committed!({
      eventType, turnId, sourceSeq: ++seq, sourceInstanceId: "provider", emittedAt: new Date().toISOString(), payload,
    } as unknown as PrpEvent);
    const usage = (inputTokens: number, outputTokens: number | undefined, providerCostUsd: number | undefined) => ({
      kind: "usage", usage: { runDelta: { inputTokens, outputTokens, providerCostUsd } },
    });
    state.execute.mockReset().mockImplementationOnce(async () => {
      await emit("turn.started", "first");
      if (scenario !== "missing_usage") await emit("item.completed", "first",
        usage(10, scenario === "partial_usage" ? undefined : 2, scenario === "unknown_price" ? undefined : 0.25));
      if (scenario !== "missing_terminal") await emit("turn.failed", "first");
      await emit("turn.started", "second");
      expect(onUsage.mock.calls.at(-1)![0].complete).toBe(false);
      await emit("item.completed", "second", usage(20, 4, 0.5));
      await emit("turn.completed", "second");
      if (scenario === "late_update") await emit("item.completed", "first", usage(12, 4, 0.35));
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" }, turnId: "second",
        normalizedSessionId: "session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: seq,
        highestContiguousSourceSeq: seq, usage: null };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(),
      execution: { ...execution, provider: { kind: "opencode", model: "openai/test" } } as NativeExecutionInput,
      runnerInstanceId: "runner", onUsage });
    const complete = ["unknown_price", "late_update"].includes(scenario);
    const cost = ["missing_usage", "unknown_price"].includes(scenario) ? 0.5 : scenario === "late_update" ? 0.85 : 0.75;
    expect(result).toMatchObject({ usageComplete: complete, costUsd: cost });
    expect(result.costStatus).toBe(scenario === "late_update" ? undefined : "unpriced");
    expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ complete, costUsd: cost, costStatus: result.costStatus });
    if (scenario === "late_update") expect(result.usage).toMatchObject({ inputTokens: 32, outputTokens: 8 });
  });

  it.each(["committed", "duplicate"] as const)("saves completed usage before returning to result commitment (%s)", async mode => {
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const failure = new Error("stopped after result commit, before executor returns");
    state.execute.mockReset().mockImplementationOnce(async () => {
      const observe = accountingEvents[mode]!;
      await observe({ eventType: "item.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: { runDelta: { inputTokens: 120, cacheReadTokens: 100, outputTokens: 10, providerCostUsd: 0.25 } } } } as unknown as PrpEvent);
      await observe({ eventType: "turn.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { status: "completed" } } as unknown as PrpEvent);
      // The runtime cannot call completeRun until appendEvent has returned.
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true, costUsd: 0.25, usage: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 } }));
      throw failure;
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind: "codex", model: "gpt-6-astra" } } as NativeExecutionInput, runnerInstanceId: "runner", onUsage })).rejects.toBe(failure);
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true }));
  });
  it("clears provisional unpriced status when direct database persistence receives complete usage", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    state.execute.mockReset().mockImplementationOnce(async () => {
      await accountingEvents.committed!({ eventType: "item.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: { runDelta: { inputTokens: 10, outputTokens: 2, providerCostUsd: 0.25 } } } } as unknown as PrpEvent);
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" },
        turnId: "turn", normalizedSessionId: "session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await executePaperclipNativeSession({ db: leaseDb(execution, {}, {}, updates), execution, runnerInstanceId: "runner" });
    const dialect = new PgDialect();
    const writes = updates.filter(update => update.values.usageJson).map(update =>
      JSON.parse(dialect.sqlToQuery(update.values.usageJson as SQL).params[0] as string) as Record<string, unknown>);
    expect(writes[0]).toMatchObject({ accountingReceiptReady: false, costStatus: "unpriced" });
    // Apply the same JSON merge as the database: omitted keys retain the old value.
    expect(Object.assign({}, ...writes)).toMatchObject({ accountingReceiptReady: true, costStatus: null, costUsd: 0.25 });
  });

  it.each(["stale_warm_zero", "partial", "fresh", "fresh_zero", "new_turn", "later_partial", "merged_partial"])("requires fresh complete usage at native completion (%s)", async scenario => {
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const usage = { inputTokens: 120, cacheReadTokens: 100, outputTokens: 10, providerCostUsd: 0 };
    const runDelta = scenario === "partial" ? { inputTokens: 120 } : scenario === "fresh_zero" ? { inputTokens: 0, outputTokens: 0 } : usage;
    state.execute.mockReset().mockImplementationOnce(async () => {
      if (scenario !== "stale_warm_zero") await accountingEvents.committed!({ eventType: "item.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: { runDelta, runDeltaComplete: scenario !== "merged_partial" } } } as unknown as PrpEvent);
      if (scenario === "new_turn") await accountingEvents.committed!({ eventType: "turn.started", turnId: "next-turn", emittedAt: new Date().toISOString(), payload: {} } as unknown as PrpEvent);
      if (scenario === "later_partial") await accountingEvents.committed!({ eventType: "item.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: { runDelta: { inputTokens: 130 } } } } as unknown as PrpEvent);
      await accountingEvents.committed!({ eventType: "turn.completed", turnId: scenario === "new_turn" ? "next-turn" : "turn", emittedAt: new Date().toISOString(), payload: {} } as unknown as PrpEvent);
      if (!["fresh", "fresh_zero"].includes(scenario)) expect(onUsage.mock.calls.every(([receipt]) => !receipt.complete)).toBe(true);
      return { result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" },
        turnId: scenario === "new_turn" ? "next-turn" : "turn", normalizedSessionId: "session",
        providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
        usage: { runDelta: scenario === "stale_warm_zero" ? { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 } : runDelta },
      };
    });
    const result = await executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind: "codex", model: "gpt-6-astra" } } as NativeExecutionInput, runnerInstanceId: "runner", runnerEnvironment: { OPENAI_API_KEY: "fixture" }, onUsage });
    const complete = ["fresh", "fresh_zero"].includes(scenario);
    expect(result.usageComplete).toBe(complete);
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete }));
    if (!complete) {
      expect(result.costStatus).toBe("unpriced");
      expect(result.costUsd).toBeNull();
      expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ costUsd: null, costStatus: "unpriced" });
    }
  });
  beforeEach(() => vi.spyOn(issueServiceModule, "issueService").mockReturnValue({ update: vi.fn(async () => ({ status: "blocked", statusVersion: 1 })) } as unknown as ReturnType<typeof issueServiceModule.issueService>));
  afterEach(() => vi.restoreAllMocks());
  it.each(["turn.failed", "turn.cancelled", "turn.interrupted", "missing_terminal", "session_total", "empty_usage", "different_turn"])("preserves run usage for %s without certifying incomplete evidence", async (scenario) => {
    const onUsage = vi.fn(async (_receipt: import("@paperclipai/adapter-utils").AdapterUsageCheckpoint) => {});
    const failure = new Error("provider_transport_failed: no semantic result");
    state.execute.mockReset().mockImplementationOnce(async () => {
      const usage = { inputTokens: 120, cacheReadTokens: 100, outputTokens: 10, providerCostUsd: 0.25 };
      await accountingEvents.committed!({ eventType: "item.completed", turnId: "turn", emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: scenario === "session_total" ? { total: usage } : { runDelta: scenario === "empty_usage" ? { requests: 1 } : usage } } } as unknown as PrpEvent);
      if (scenario !== "missing_terminal") await accountingEvents.committed!({ eventType: scenario.startsWith("turn.") ? scenario : "turn.failed", turnId: scenario === "different_turn" ? "another-turn" : "turn", emittedAt: new Date().toISOString(), payload: { status: "failed" } } as unknown as PrpEvent);
      throw failure;
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(), execution: { ...execution, provider: { kind: "codex", model: "gpt-6-astra" } } as NativeExecutionInput, runnerInstanceId: "runner", onUsage })).rejects.toBe(failure);
    if (scenario === "session_total") expect(onUsage).not.toHaveBeenCalled();
    else if (scenario === "empty_usage") expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false, usage: undefined, costUsd: null, costStatus: "unpriced" }));
    else {
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: scenario.startsWith("turn."), costUsd: 0.25, usageBasis: "per_run", usage: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10 } }));
      expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ complete: false });
    }
  });
});

describe("native resumed preparation timing", () => {
  it("keeps answered-question ingress at the run root rather than charging it to preparation", async () => {
    const answeredAtMs = Date.now();
    const events: AdapterRuntimeEvent[] = [];
    state.execute.mockReset().mockResolvedValueOnce({
      result: { summary: "cancelled" },
      terminal: { runTerminalState: "cancelled" },
      turnId: "turn",
      normalizedSessionId: "session",
      providerSessionId: null,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(answeredAtMs + 100);
    try {
      await executePaperclipNativeSession({
        db: leaseDb(),
        execution,
        runnerInstanceId: "runner",
        preparationSpans: [
          {
            name: "question_response.to_run_created",
            startedAtMs: answeredAtMs,
            endedAtMs: answeredAtMs + 50,
          },
          ...buildNativeHeartbeatPreparationSpans({
            runCreatedAtMs: answeredAtMs + 50,
            runStartedAtMs: answeredAtMs + 60,
            attemptStartedAtMs: answeredAtMs + 70,
            environmentAcquireStartedAtMs: answeredAtMs + 80,
            environmentRealizeEndedAtMs: answeredAtMs + 90,
            nativeDispatchAtMs: answeredAtMs + 95,
          }),
        ],
        onEvent: async (event) => {
          events.push(event);
        },
      });
    } finally {
      clock.mockRestore();
    }
    const payloadFor = (span: string) =>
      events.find((event) => event.payload?.span === span)?.payload;
    expect(payloadFor("question_response.to_run_created")).toMatchObject({
      parentSpan: "task.run",
      durationMs: 50,
      startOffsetMs: 0,
    });
    expect(payloadFor("task.prepare")).toMatchObject({
      durationMs: 30,
      startOffsetMs: 70,
    });
    expect(payloadFor("task.run.measured")).toMatchObject({ durationMs: 100 });
  });

  it("uses attempt-local preparation in the executor without truncating run elapsed time", async () => {
    const attemptStartedAtMs = Date.now();
    const runStartedAtMs = attemptStartedAtMs - 983_000;
    const events: AdapterRuntimeEvent[] = [];
    state.execute.mockReset().mockResolvedValueOnce({
      result: { summary: "cancelled" },
      terminal: { runTerminalState: "cancelled" },
      turnId: "turn",
      normalizedSessionId: "session",
      providerSessionId: null,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
    });
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(attemptStartedAtMs + 50);
    try {
      await executePaperclipNativeSession({
        db: leaseDb(),
        execution,
        runnerInstanceId: "runner",
        preparationSpans: buildNativeHeartbeatPreparationSpans({
          runCreatedAtMs: runStartedAtMs - 1_000,
          runStartedAtMs,
          attemptStartedAtMs,
          environmentAcquireStartedAtMs: attemptStartedAtMs + 20,
          environmentRealizeEndedAtMs: attemptStartedAtMs + 30,
          nativeDispatchAtMs: attemptStartedAtMs + 40,
        }),
        onEvent: async (event) => {
          events.push(event);
        },
      });
    } finally {
      clock.mockRestore();
    }
    const payloadFor = (name: string) =>
      events.find((event) => event.payload?.span === name)?.payload;
    expect(payloadFor("heartbeat.prepare_before_environment")).toMatchObject({
      durationMs: 20,
    });
    expect(payloadFor("task.prepare")).toMatchObject({
      durationMs: 50,
      startOffsetMs: 984_000,
    });
    expect(payloadFor("heartbeat.queue")).toMatchObject({
      durationMs: 1_000,
      startOffsetMs: 0,
    });
    expect(payloadFor("task.run.measured")).toMatchObject({
      durationMs: 984_050,
    });
  });
});

describe("native session cancellation", () => {
  beforeEach(() => {
    state.cancel.mockReset().mockReturnValue({ cleanup: Promise.resolve() });
    state.persistActivity.mockClear();
    state.publishActivity.mockClear();
    state.release = null;
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ cancel: state.cancel });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      options.onSession?.(null);
      return {
        result: { summary: "cancelled" },
        terminal: { runTerminalState: "cancelled" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it.each([
    { useRunnerd: true, durableIntentVisible: false },
    { useRunnerd: false, durableIntentVisible: false },
    { useRunnerd: true, durableIntentVisible: true },
    { useRunnerd: false, durableIntentVisible: true },
  ])("waits for an in-flight startup handle before acknowledging Stop (runnerd=$useRunnerd, durable intent=$durableIntentVisible)", async ({ useRunnerd, durableIntentVisible }) => {
    const root = await mkdtemp(join(tmpdir(), "native-startup-stop-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = root;
    let open!: () => void, started!: () => void, finish!: () => void;
    const opening = new Promise<void>(resolve => { open = resolve; });
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const submitTurn = vi.fn();
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      started();
      await opening;
      await options.onSession({ cancel: state.cancel });
      submitTurn();
      await finished;
      await options.onSession(null);
      return {
        result: { summary: "cancelled" }, terminal: { runTerminalState: "cancelled" },
        turnId: "turn", normalizedSessionId: "session", providerSessionId: null,
        driverKind: "test", driverVersion: "1", nativeEventCount: 0,
        highestContiguousSourceSeq: 0,
      };
    });
    const runResultJson: Record<string, unknown> = {};
    const running = executePaperclipNativeSession({
      db: leaseDb(execution, {}, runResultJson), execution, runnerInstanceId: "runner", useRunnerd,
    });
    const outcome = running.catch(error => error);
    const persistence = cancellationDb();
    let stopping: ReturnType<typeof cancelNativeSession> | undefined;
    let acknowledged = false;
    try {
      await admitted;
      await expect(executePaperclipNativeSession({
        db: leaseDb(), execution, runnerInstanceId: "duplicate-runner", useRunnerd,
      })).rejects.toThrow("native_session_supervisor_busy");
      stopping = cancelNativeSession(execution.binding.runId, "operator Stop during startup", {
        db: persistence.db, scope: "run",
      });
      void stopping.then(() => { acknowledged = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(persistence.getResultJson().nativeCancellation).toMatchObject({ dispatchState: "pending" });
      // Production execution sees the same durable Stop intent as its API caller.
      // Exercise that read as well as the in-memory startup handoff.
      if (durableIntentVisible) Object.assign(runResultJson, persistence.getResultJson());
      open();
      await expect(stopping).resolves.toMatchObject({ dispatched: true });
      expect(state.cancel).toHaveBeenCalledOnce();
      expect(persistence.getResultJson().nativeCancellation).toMatchObject({
        dispatchState: "acknowledged", dispatched: true,
      });
      finish();
      await outcome;
      expect(submitTurn).not.toHaveBeenCalled();
    } finally {
      open(); finish();
      await outcome;
      await stopping;
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("fences a late startup even when Stop reaches its acknowledgement deadline (runnerd=%s)", async (useRunnerd) => {
    const root = await mkdtemp(join(tmpdir(), "native-late-startup-stop-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = root;
    let open!: () => void, started!: () => void;
    const opening = new Promise<void>(resolve => { open = resolve; });
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const submitTurn = vi.fn();
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      started(); await opening;
      await options.onSession({ cancel: state.cancel });
      submitTurn();
      throw new Error("a stopped startup must not reach prompt submission");
    });
    const outcome = executePaperclipNativeSession({ db: leaseDb(), execution, runnerInstanceId: "runner", useRunnerd }).catch(error => error);
    const persistence = cancellationDb();
    try {
      await admitted;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopping = cancelNativeSession(execution.binding.runId, "operator Stop", { db: persistence.db, scope: "run" }).catch(error => error);
      // Let the durable intent commit before advancing the startup deadline.
      await new Promise(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await stopping).toMatchObject({ name: "NativeCancellationPendingRecoveryError" });
      expect(persistence.getResultJson().nativeCancellation).toMatchObject({ dispatchState: "pending" });
      vi.useRealTimers();
      open(); await outcome;
      expect(state.cancel).toHaveBeenCalledOnce();
      expect(submitTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers(); open(); await outcome;
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes control-plane cancellation to the active normalized session and removes the handle", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).resolves.toBe(true);
    await expect(
      cancelNativeSession(execution.binding.runId, "duplicate budget stop"),
    ).resolves.toBe(true);
    expect(state.cancel).toHaveBeenCalledWith({
      reason: "budget hard stop",
      signal: expect.any(AbortSignal),
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
    await expect(
      cancelNativeSession(execution.binding.runId, "late cancel"),
    ).resolves.toBe(false);
  });

  it("allows cancellation to be retried when the session dispatch fails", async () => {
    state.cancel.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).rejects.toThrow("transport unavailable");
    await expect(
      cancelNativeSession(execution.binding.runId, "retry budget stop"),
    ).resolves.toBe(true);
    expect(state.cancel).toHaveBeenNthCalledWith(2, {
      reason: "retry budget stop",
      signal: expect.any(AbortSignal),
    });

    state.release?.();
    await running;
  });

  it("observes cleanup failure after cancellation authority is committed", async () => {
    state.cancel.mockImplementationOnce(() => ({
      cleanup: Promise.reject(new Error("provider cleanup failed")),
    }));
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop"),
    ).resolves.toBe(true);

    state.release?.();
    await running;
  });

  it("binds cancellation to nativeIssueId and merges metadata under a row lock", async () => {
    const persistence = cancellationDb();

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: false,
      decision: expect.any(Object),
      auditId: "native-cancellation-audit",
    });

    expect(persistence.getForUpdateCount()).toBe(2);
    const cancellationUpdate = persistence.updates
      .filter((entry) => "resultJson" in entry.values)
      .at(-1);
    expect(cancellationUpdate?.values.resultJson).toMatchObject({
      durableReceipt: { operationId: "operation-1" },
      nativeCancellation: {
        schema: "paperclip.native-cancellation.v1",
        dispatchState: "acknowledged",
        scope: "run",
        dispatched: false,
        intentAuditId: "native-cancellation-audit",
        acknowledgementAuditId: "native-cancellation-ack-audit",
      },
    });
    expect(state.persistActivity).toHaveBeenCalledWith(
      persistence.tx,
      expect.objectContaining({
        companyId: execution.binding.companyId,
        issueId: execution.binding.issueId,
        runId: execution.binding.runId,
      }),
    );
    expect(state.publishActivity).toHaveBeenCalledTimes(2);
  });

  it.each(["terminal_failure", "observed", "committed"])("rejects retry phase %s that changed after caller reservation, before any native effect", async phase => {
    const id = "11111111-1111-4111-8111-111111111111";
    const persistence = cancellationDb({ status: "failed",
      coordinator: { runId: execution.binding.runId, assessmentId: null, phase, failureCode: "board_recovery" },
      resultJson: { startupCancellation: { cancellationRequestId: id, retryCancellation: true } } });
    await expect(cancelNativeSession(execution.binding.runId, "operator Stop", { db: persistence.db,
      scope: "run", cancellationRequestId: id })).rejects.toMatchObject({ status: 409, message: "Native retry is no longer cancellable" });
    expect(persistence.updates).toEqual([]);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.persistActivity).not.toHaveBeenCalled();
  });

  it("does not mistake a recovered running attempt for the failed retry that reserved Stop", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const persistence = cancellationDb({ status: "running",
      coordinator: { runId: execution.binding.runId, assessmentId: null, phase: "observed" },
      resultJson: { startupCancellation: { cancellationRequestId: id, retryCancellation: true } } });
    await expect(cancelNativeSession(execution.binding.runId, "operator Stop", { db: persistence.db,
      scope: "run", cancellationRequestId: id })).rejects.toMatchObject({ status: 409 });
    expect(persistence.updates).toEqual([]);
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("fences a failed retry at dispatch and preserves the same audited intent on replay", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const persistence = cancellationDb({ status: "failed",
      coordinator: { runId: execution.binding.runId, assessmentId: null, phase: "retryable_failure" },
      resultJson: { startupCancellation: { cancellationRequestId: id, retryCancellation: true } } });
    const first = await cancelNativeSession(execution.binding.runId, "operator Stop", { db: persistence.db, scope: "run", cancellationRequestId: id });
    expect(persistence.updates).toContainEqual(expect.objectContaining({ table: nativeRunFinalizations,
      values: expect.objectContaining({ phase: "terminal_failure", failureCode: "native_retry_cancelled", nextAttemptAt: null }) }));
    const writes = persistence.getResultJsonUpdateCount();
    await expect(cancelNativeSession(execution.binding.runId, "retry Stop", { db: persistence.db,
      scope: "run", cancellationRequestId: id })).resolves.toMatchObject({ auditId: first.auditId });
    expect(persistence.getResultJsonUpdateCount()).toBe(writes);
  });

  it("uses the reserved caller UUID and permits same-intent and default retries", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const persistence = cancellationDb({ resultJson: { startupCancellation: { cancellationRequestId: id } } });
    await cancelNativeSession(execution.binding.runId, "operator Stop", { db: persistence.db, scope: "run", cancellationRequestId: id });
    expect(persistence.getResultJson().nativeCancellation).toMatchObject({ intentId: `native-cancellation:${id}` });
    const writes = persistence.getResultJsonUpdateCount();
    await cancelNativeSession(execution.binding.runId, "same request", { db: persistence.db, scope: "run", cancellationRequestId: id });
    await cancelNativeSession(execution.binding.runId, "default retry", { db: persistence.db, scope: "run" });
    expect(persistence.getResultJsonUpdateCount()).toBe(writes);
    await expect(cancelNativeSession(execution.binding.runId, "foreign caller", {
      db: persistence.db, scope: "run", cancellationRequestId: "22222222-2222-4222-8222-222222222222",
    })).rejects.toMatchObject({ status: 409 });
    expect(persistence.getResultJsonUpdateCount()).toBe(writes);
  });

  it.each([{}, { startupCancellation: { requestedAt: "prior" } },
    { startupCancellation: { cancellationRequestId: "other" } },
    { startupCancellation: { cancellationRequestId: "11111111-1111-4111-8111-111111111111" }, nativeCancellation: { intentId: "foreign" } },
  ])("rejects missing or raced caller ownership under the intent lock: %j", async resultJson => {
    const persistence = cancellationDb({ resultJson });
    await expect(cancelNativeSession(execution.binding.runId, "operator Stop", {
      db: persistence.db, scope: "run", cancellationRequestId: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ status: 409 });
    expect(persistence.getForUpdateCount()).toBe(1);
    expect(persistence.updates).toEqual([]);
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("recovers a post-dispatch persistence failure without cancelling the provider twice", async () => {
    const persistence = cancellationDb({ failResultJsonUpdateAt: 2 });
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).rejects.toThrow("post_dispatch_db_failure");
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJson()).toMatchObject({
      nativeCancellation: {
        dispatchState: "pending",
        dispatched: false,
        intentAuditId: "native-cancellation-audit",
      },
    });

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: true,
      auditId: "native-cancellation-audit",
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJsonUpdateCount()).toBe(3);
    expect(persistence.getResultJson()).toMatchObject({
      nativeCancellation: {
        dispatchState: "acknowledged",
        dispatched: true,
        intentAuditId: "native-cancellation-audit",
        acknowledgementAuditId: "native-cancellation-ack-audit",
      },
    });
    expect(
      state.persistActivity.mock.calls.filter(
        ([, input]) =>
          (input as { action?: string }).action ===
          "native.cancellation_intent_recorded",
      ),
    ).toHaveLength(1);
    const persistedActivities = state.persistActivity.mock.calls.length;
    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).resolves.toMatchObject({
      dispatched: true,
      auditId: "native-cancellation-audit",
    });
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(persistence.getResultJsonUpdateCount()).toBe(3);
    expect(state.persistActivity).toHaveBeenCalledTimes(persistedActivities);

    state.release?.();
    await running;
  });

  it("fails closed when the persisted native binding has no coordinator", async () => {
    const persistence = cancellationDb({ coordinator: null });

    await expect(
      cancelNativeSession(execution.binding.runId, "budget hard stop", {
        db: persistence.db,
        scope: "run",
      }),
    ).rejects.toThrow("native_cancellation_coordinator_missing");
    expect(persistence.updates).toEqual([]);
    expect(state.persistActivity).not.toHaveBeenCalled();
  });

  it("does not acknowledge an unverified retained runner as cancelled without an authenticated session", async () => {
    const persistence = cancellationDb({ ownershipHeld: true });
    await expect(
      cancelNativeSession(
        execution.binding.runId,
        "Task closed while waiting",
        {
          db: persistence.db,
          scope: "run",
        },
      ),
    ).rejects.toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
    expect(persistence.updates).toEqual([]);
    expect(state.persistActivity).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});

describe("native session execution lease fencing", () => {
  it("renews only when the exact fenced owner remains current", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ runId: "run-lease" }])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Db;
    const input = {
      db,
      runId: "run-lease",
      companyId: "company-lease",
      issueId: "issue-lease",
      leaseOwner: "owner-lease",
      attempt: 4,
      leaseTtlMs: 60_000,
    };

    await expect(
      renewNativeSessionExecutionLease(input),
    ).resolves.toBeUndefined();
    await expect(renewNativeSessionExecutionLease(input)).rejects.toThrow(
      "native_session_lease_lost",
    );
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it("does not reacquire a provider after a durable result exists", async () => {
    state.execute.mockClear();
    state.createBackend.mockClear();
    state.createTransport.mockClear();

    await expect(
      executePaperclipNativeSession({
        db: leaseDb(execution, {
          phase: "workspace_finalizing",
          resultId: "native-result-1",
        }),
        execution,
        runnerInstanceId: "runner",
      }),
    ).rejects.toThrow("native_result_pending_finalization");
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.createBackend).not.toHaveBeenCalled();
    expect(state.createTransport).not.toHaveBeenCalled();
  });

  it.each(["pending", "acknowledged"] as const)(
    "does not reacquire a provider while durable cancellation is %s",
    async (dispatchState) => {
      state.execute.mockClear();
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        executePaperclipNativeSession({
          db: leaseDb(
            execution,
            {},
            {
              nativeCancellation: {
                schema: "paperclip.native-cancellation.v1",
                intentId: "native-cancellation:intent-1",
                intentAuditId: "native-cancellation-audit",
                companyId: execution.binding.companyId,
                runId: execution.binding.runId,
                issueId: execution.binding.issueId,
                scope: "run",
                reasonCode: "cancellation_run_only",
                effects: ["release_run_resources"],
                dispatchState,
                dispatched: dispatchState === "acknowledged",
                decisionId: null,
              },
            },
          ),
          execution,
          runnerInstanceId: "runner",
        }),
      ).rejects.toThrow("native_cancellation_pending_recovery");
      expect(state.execute).not.toHaveBeenCalled();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    },
  );
});

describe("native runtime request resolution", () => {
  const capabilities = vi.fn();
  const snapshot = vi.fn();
  const resolveRuntimeRequest = vi.fn();

  beforeEach(() => {
    state.release = null;
    capabilities.mockReset().mockResolvedValue({
      runtimeRequestResolution: true,
    });
    snapshot.mockReset().mockResolvedValue({ activeTurnId: "provider-turn-1" });
    resolveRuntimeRequest.mockReset().mockResolvedValue(undefined);
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.onSession?.({
        capabilities,
        snapshot,
        resolveRuntimeRequest,
        cancel: vi.fn(),
      });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      await options.onSession?.(null);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("revalidates lifecycle after provider reads and blocks stale dispatch", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const authorizeBeforeDispatch = vi.fn(async () => {
      expect(capabilities).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledTimes(1);
      throw new Error("runtime_request_no_longer_pending");
    });

    await expect(
      resolveNativeRuntimeRequest({
        runId: execution.binding.runId,
        requestId: "runtime-request-1",
        turnId: "provider-turn-1",
        resolution: { action: "decline" },
        authorizeBeforeDispatch,
      }),
    ).rejects.toThrow("runtime_request_no_longer_pending");
    expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeRequest).not.toHaveBeenCalled();

    state.release?.();
    await running;
  });

  it("atomically joins duplicate responses and rejects a concurrent conflict", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizeBeforeDispatch = vi.fn(() => authorization);
    const first = resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-concurrent",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch,
    });
    await vi.waitFor(() =>
      expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1),
    );
    const duplicate = resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-concurrent",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch,
    });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

    await expect(
      resolveNativeRuntimeRequest({
        runId: execution.binding.runId,
        requestId: "runtime-request-concurrent",
        turnId: "provider-turn-1",
        resolution: { action: "cancel" },
        authorizeBeforeDispatch,
      }),
    ).rejects.toMatchObject({
      code: "runtime_request_resolution_conflict",
    });
    expect(authorizeBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeRequest).not.toHaveBeenCalled();

    releaseAuthorization();
    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(duplicateResult.commandId).toBe(firstResult.commandId);
    expect(resolveRuntimeRequest).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
  });

  it("clears completed response reservations when the session tears down", async () => {
    const firstSession = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const first = await resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-reused",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch: vi.fn().mockResolvedValue(undefined),
    });
    state.release?.();
    await firstSession;

    state.release = null;
    const secondSession = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    const second = await resolveNativeRuntimeRequest({
      runId: execution.binding.runId,
      requestId: "runtime-request-reused",
      turnId: "provider-turn-1",
      resolution: { action: "decline" },
      authorizeBeforeDispatch: vi.fn().mockResolvedValue(undefined),
    });

    expect(second.commandId).not.toBe(first.commandId);
    expect(resolveRuntimeRequest).toHaveBeenCalledTimes(2);
    (state.release as (() => void) | null)?.();
    await secondSession;
  });
});

describe("native session same-turn steering", () => {
  const capabilities = vi.fn();
  const snapshot = vi.fn();
  const steer = vi.fn();

  beforeEach(() => {
    state.release = null;
    capabilities.mockReset().mockResolvedValue({ steering: true });
    snapshot.mockReset().mockResolvedValue({ activeTurnId: "provider-turn-1" });
    steer.mockReset().mockResolvedValue(undefined);
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ capabilities, snapshot, steer, cancel: vi.fn() });
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      options.onSession?.(null);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  async function startActiveSession() {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
    return { running };
  }

  it("correlates the queued comment with the active provider turn acknowledgement", async () => {
    const { running } = await startActiveSession();

    await expect(
      getNativeSessionSteeringState(execution.binding.runId),
    ).resolves.toEqual({
      disposition: "available",
      activeTurnId: "provider-turn-1",
    });
    await expect(
      steerNativeSession({
        runId: execution.binding.runId,
        message: "Check mobile overflow first.",
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({ turnId: "provider-turn-1" });
    expect(steer).toHaveBeenCalledWith({
      turnId: "provider-turn-1",
      message: { role: "user", text: "Check mobile overflow first." },
      correlationId: "queued-comment-1",
    });

    state.release?.();
    await running;
  });

  it.each([
    {
      label: "unsupported provider",
      prepare: () => capabilities.mockResolvedValue({ steering: false }),
      code: "steering_unsupported",
    },
    {
      label: "stale turn",
      prepare: () => snapshot.mockResolvedValue({ activeTurnId: null }),
      code: "steering_stale_turn",
    },
    {
      label: "provider rejection",
      prepare: () => steer.mockRejectedValue(new Error("request rejected")),
      code: "steering_rejected",
    },
  ])("keeps $label retryable with a stable code", async ({ prepare, code }) => {
    prepare();
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Retryable steering",
      correlationId: "queued-comment-error",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe(code);

    state.release?.();
    await running;
  });

  it("bounds the provider acknowledgement wait", async () => {
    steer.mockReturnValue(new Promise(() => undefined));
    const { running } = await startActiveSession();

    const error = await steerNativeSession({
      runId: execution.binding.runId,
      message: "Do not wait forever",
      correlationId: "queued-comment-timeout",
      timeoutMs: 5,
    }).catch((value) => value);
    expect(error).toBeInstanceOf(NativeSessionSteeringError);
    expect(error.code).toBe("steering_timeout");

    state.release?.();
    await running;
  });
});

describe("bounded stopped instruction collection", () => {
  it.each([
    { scenario: "deferred", attempts: [0], nextAttemptAt: null, expectedCalls: 1 },
    { scenario: "no progress", attempts: [0, 0], nextAttemptAt: new Date(0), expectedCalls: 2 },
    { scenario: "regressed counter", attempts: [1, 0], nextAttemptAt: new Date(0), expectedCalls: 2 },
    { scenario: "progressing counter", attempts: [0, 1, 2], nextAttemptAt: new Date(0), expectedCalls: 3 },
    { scenario: "exhausted", attempts: [3], nextAttemptAt: new Date(0), expectedCalls: 1 },
  ])("finishes pending collection without inventing attempts: $scenario", async ({ attempts, nextAttemptAt, expectedCalls }) => {
    const { collectStoppedInstructionCopyWithRetries } = await import("../agent-instruction-working-copies.js");
    const collect = vi.fn(async () => {
      const index = collect.mock.calls.length - 1;
      if (index >= attempts.length) throw new Error("collector invoked beyond bounded progress");
      return { state: "pending_collection", attempts: attempts[index]!, nextAttemptAt };
    });
    expect(await collectStoppedInstructionCopyWithRetries(collect)).toEqual({ state: "pending_collection", attempts: attempts.at(-1), nextAttemptAt });
    expect(collect).toHaveBeenCalledTimes(expectedCalls);
  });
  it("returns completed or absent copies and propagates collection errors", async () => {
    const { collectStoppedInstructionCopyWithRetries } = await import("../agent-instruction-working-copies.js");
    const result = { state: "saved", attempts: 1, nextAttemptAt: null };
    const saved = vi.fn(async () => result), absent = vi.fn(async () => null);
    expect(await collectStoppedInstructionCopyWithRetries(saved)).toBe(result);
    expect(await collectStoppedInstructionCopyWithRetries(absent)).toBeNull();
    expect(saved).toHaveBeenCalledOnce(); expect(absent).toHaveBeenCalledOnce();
    await expect(collectStoppedInstructionCopyWithRetries(async () => { throw new Error("collection failed"); })).rejects.toThrow("collection failed");
  });
});

describe("native warm session supervision", () => {
  it.each(["collect", "close-failure", "stopped", "destroyed", "missing-lease", "foreign-run", "foreign-environment", "deleted-environment", "claim-edit", "claim-add", "claim-remove", "claim-remove-entry", "claim-canonical", "claim-config", "claim-uncertain"])("composes remote warm ownership with real DB successor leases and current-run collection: %s", async ending => {
    const tables = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    const { randomUUID } = await import("node:crypto");
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const executeCommand = promisify(execFile);
    const { startEmbeddedPostgresTestDatabase } = await import("../../__tests__/helpers/embedded-postgres.js");
    const { agentInstructionWorkingCopyService } = await import("../agent-instruction-working-copies.js");
    const { buildNativeRuntimeContext } = await import("./runtime-context.js");
    const { prepareNativeHeartbeatRun } = await import("./prepare-native-run.js");
    const { buildNativeCompletionContract } = await import("./completion-contracts.js");
    const home = await realpath(await mkdtemp(join(tmpdir(), "warm-remote-db-")));
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    const database = await startEmbeddedPostgresTestDatabase("warm-remote-db-");
    const db = tables.createDb(database.connectionString);
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), environmentId = randomUUID(), issueId = randomUUID();
    const { resolveManagedInstructionsRoot } = await import("../agent-instructions.js");
    const canonical = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Warm remote", adapterConfig: {} }), remoteCwd = join(home, "remote");
    let currentLease = "", failCleanup = false, failProbe = false, closed = false;
    const commands: Array<{ leaseId: string; command: string }> = [];
    const commandRunner = (leaseId: string): import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner => ({ execute: async input => {
      expect(leaseId).toBe(currentLease); // The replaced collector must never execute.
      commands.push({ leaseId, command: `${input.command} ${(input.args ?? []).join(" ")}` });
      if (failProbe) {
        failProbe = false;
        expect(commands.at(-1)!.command).toContain("Agent directory probe deadline");
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "injected uncertain observation", pid: null, startedAt: new Date().toISOString() };
      }
      if (failCleanup && commands.at(-1)!.command.includes("rm -rf --")) {
        failCleanup = false;
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "injected cleanup failure", pid: null, startedAt: new Date().toISOString() };
      }
      const env = { PATH: process.env.PATH, ...input.env }, args = [...(input.args ?? [])];
      if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
        Object.assign(env, { PAPERCLIP_TEST_STDIN: input.stdin });
        args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
      }
      const result = await executeCommand(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return { exitCode: 0, signal: null, timedOut: false, ...result, pid: null, startedAt: new Date().toISOString() };
    } });
    let copies = agentInstructionWorkingCopyService(db);
    const agent = { id: agentId, companyId, name: "Warm remote", adapterConfig: {
      instructionsBundleMode: "managed", instructionsRootPath: canonical, instructionsEntryFile: "AGENTS.md" } };
    let active: Awaited<ReturnType<typeof copies.prepare>>;
    const session = { close: vi.fn(async () => { closed = true; }) };
    state.execute.mockReset().mockImplementation(async options => {
      await options.onSession?.(session);
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
        turnId: "warm-turn", normalizedSessionId: environmentId, providerSessionId: environmentId,
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    let bodyFailure: unknown;
    try {
      await db.insert(tables.companies).values({ id: companyId, name: "Warm tests", issuePrefix: "WARM" });
      await db.insert(tables.authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(tables.agents).values(agent);
      await db.insert(tables.companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }, { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" }]);
      await db.insert(tables.principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
      await db.insert(tables.environments).values({ id: environmentId, name: "Owned fake remote", driver: "sandbox" });
      const [issue] = await db.insert(tables.issues).values({ id: issueId, companyId, title: "Warm remote", status: "in_progress", assigneeAgentId: agentId }).returning();
      await mkdir(canonical, { recursive: true }); await mkdir(remoteCwd);
      await writeFile(join(canonical, "AGENTS.md"), "Retain this exact directory.\n");
      await writeFile(join(canonical, "optional-memory.txt"), "Optional memory\n");
      let prior: NativeExecutionInputV3 | undefined;
      let originalRoot = "", materializationRunId = "";
      for (let turn = 0; turn < 3; turn++) {
        const runId = randomUUID();
        if (currentLease) {
          await db.update(tables.environmentLeases).set({ status: "expired", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(tables.environmentLeases.id, currentLease));
          await db.update(tables.heartbeatRuns).set({ status: "succeeded" }).where(eq(tables.heartbeatRuns.id, prior!.binding.runId));
        }
        currentLease = randomUUID();
        const [run] = await db.insert(tables.heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId,
          status: "running", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: environmentId, runnerInstanceId: environmentId,
          contextSnapshot: { issueId } }).returning();
        await db.insert(tables.nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
        await db.update(tables.issues).set({ executionRunId: runId }).where(eq(tables.issues.id, issueId));
        await db.insert(tables.environmentLeases).values({ id: currentLease, companyId, environmentId, heartbeatRunId: runId,
          provider: "daytona", providerLeaseId: "same-owned-allocation", leasePolicy: "reuse_by_environment", metadata: { remoteCwd } });
        // Match the production preparation seam and existing native DB tests:
        // pin the issue's completion contract and durable run/lease identities.
        await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: currentLease });
        const [contract] = await db.select().from(tables.completionContracts).where(eq(tables.completionContracts.issueId, issueId));
        const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", environmentId, leaseId: currentLease, remoteCwd, runner: commandRunner(currentLease) };
        const current: NativeExecutionInputV3 = { ...execution, schema: "paperclip.native-execution-input.v3",
          executionMode: "default", planningContext: null, runtimeContext: nativeRuntimeContextFixture(),
          completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
            contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) }, binding: { companyId, agentId, issueId, runId, executionWorkspaceId: runId },
          workspace: { cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null },
          session: { ...execution.session, normalizedSessionId: environmentId, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } } };
        const preparationKey = turn === 1 && ending === "claim-config" ? "changed-config" : "same-config";
        let retiredReceipt: Record<string, unknown> | null = null;
        const capability = () => ({ runId, preparationKey, hasChanges: () => copies.hasChanges({ companyId, runId, target }),
          collectStopped: async () => { expect(closed).toBe(true); retiredReceipt = (await copies.get(companyId, runId))?.receipt ?? null;
            const { collectStoppedInstructionCopyWithRetries } = await import("../agent-instruction-working-copies.js");
            await collectStoppedInstructionCopyWithRetries(() => copies.collectStopped({ companyId, runId, target }));
          }, retirementFailed: async () => { await copies.reportRetirementUnconfirmed(companyId, runId); } });
        let release: (() => Promise<void>) | null = null;
        if (prior) {
          // Same environment is insufficient: reject a different physical allocation.
          await db.update(tables.environmentLeases).set({ providerLeaseId: "foreign-allocation" }).where(eq(tables.environmentLeases.id, currentLease));
          const before = commands.length;
          expect(await copies.adopt({ companyId, agentId, runId, previousRunId: prior.binding.runId, target, cwd: remoteCwd })).toBeNull();
          expect(commands).toHaveLength(before);
          await db.update(tables.environmentLeases).set({ providerLeaseId: "same-owned-allocation" }).where(eq(tables.environmentLeases.id, currentLease));
          if (ending === "claim-edit") await writeFile(join(originalRoot, "AGENTS.md"), "Remote edit before next claim\n");
          if (ending === "claim-add") await writeFile(join(originalRoot, "memory.txt"), "Remote addition before next claim\n");
          if (ending === "claim-remove") await rm(join(originalRoot, "optional-memory.txt"));
          if (ending === "claim-remove-entry") await rm(join(originalRoot, "AGENTS.md"));
          if (ending === "claim-canonical") await writeFile(join(canonical, "AGENTS.md"), "Canonical edit before next claim\n");
          if (["claim-edit", "claim-add", "claim-remove", "claim-remove-entry", "claim-canonical"].includes(ending)) {
            // Ordinary adoption remains unchanged-only and cannot alias this owner.
            expect(await copies.adopt({ companyId, agentId, runId, previousRunId: prior.binding.runId, target, cwd: remoteCwd })).toBeNull();
            expect((await copies.get(companyId, prior.binding.runId))?.receipt?.retainedByRunId).toBeUndefined();
          }
          failProbe = ending === "claim-uncertain";
          release = await claimWarmNativeInstructionCopy({ priorExecution: prior, companyId, agentId, executionWorkspaceId: runId,
            workspace: current.workspace, environmentId, runId, preparationKey, adopt: async previousRunId => {
              active = await copies.adopt({ companyId, agentId, runId, previousRunId, target, cwd: remoteCwd, allowRetirementHandoff: true });
              return active ? capability() : null;
            } });
          if (ending.startsWith("claim-")) {
            expect(release).toBeNull();
            expect(session.close).toHaveBeenCalledOnce();
            expect(state.execute).toHaveBeenCalledOnce(); // No reuse was admitted.
            if (ending !== "claim-config") expect(retiredReceipt).toMatchObject({ retirementRequired: true });
            expect(retiredReceipt).toMatchObject({ materializationRunId, cleanup: { leaseId: currentLease, remoteCwd } });
            expect((await copies.get(companyId, runId))?.processStoppedAt).toBeInstanceOf(Date);
            const compact = (await copies.get(companyId, runId))!.receipt;
            expect(compact).toMatchObject({ materializationRunId, cleanupPending: false });
            expect(compact?.baseline).toBeUndefined();
            await expect(access(originalRoot)).rejects.toMatchObject({ code: "ENOENT" });
            if (ending === "claim-edit") expect(await readFile(join(canonical, "AGENTS.md"), "utf8")).toBe("Remote edit before next claim\n");
            if (ending === "claim-add") expect(await readFile(join(canonical, "memory.txt"), "utf8")).toBe("Remote addition before next claim\n");
            if (ending === "claim-remove") await expect(access(join(canonical, "optional-memory.txt"))).rejects.toMatchObject({ code: "ENOENT" });
            if (ending === "claim-remove-entry") {
              expect((await copies.get(companyId, runId))!).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED" });
              expect(await readFile(join(canonical, "AGENTS.md"), "utf8")).toBe("Retain this exact directory.\n");
            }
            if (ending === "claim-canonical") expect(await readFile(join(canonical, "AGENTS.md"), "utf8")).toBe("Canonical edit before next claim\n");
            // Heartbeat rematerializes only after the successor proved retirement.
            active = await copies.prepare({ companyId, agentId, runId, target, cwd: remoteCwd });
            expect(active).toMatchObject({ state: "prepared", executionRoot: originalRoot, processStoppedAt: null });
            expect(active!.receipt?.retirementRequired).toBeUndefined();
            expect(await copies.hasChanges({ companyId, runId, target })).toBe(false);
            await copies.reportUnavailable(companyId, prior.binding.runId);
            await copies.release(companyId, prior.binding.runId);
            expect((await lstat(originalRoot)).isDirectory()).toBe(true);
            await copies.collectStopped({ companyId, runId, target });
            return;
          }
          expect(release).toBeTypeOf("function");
          await copies.reportUnavailable(companyId, prior.binding.runId);
          await copies.release(companyId, prior.binding.runId);
          expect(active!.receipt).toMatchObject({ materializationRunId, cleanup: { leaseId: currentLease, remoteCwd } });
        } else {
          active = await copies.prepare({ companyId, agentId, runId, target, cwd: remoteCwd });
          originalRoot = active!.executionRoot; materializationRunId = runId;
        }
        expect(active!.executionRoot).toBe(originalRoot);
        current.runtimeContext = await buildNativeRuntimeContext({ db, agent, runId, runtimeConfig: {}, runtimeSkillEntries: [],
          instructionWorkingCopy: { rootPath: active!.executionRoot, entryPath: "AGENTS.md", kind: "agent_files" } });
        expect(current.runtimeContext.instructions.workingCopy?.rootPath).toBe(originalRoot);
        await executePaperclipNativeSession({ db, execution: current, runnerInstanceId: environmentId, runnerExecutionTarget: target, instructionWorkingCopy: capability() });
        if (prior) expect(state.execute.mock.calls.at(-1)?.[0].existingSession).toBe(session);
        expect(closed).toBe(false);
        await release?.(); expect(closed).toBe(false);
        prior = current;
      }
      // A write after the live unchanged probe is still collected on retirement.
      await writeFile(join(originalRoot, "late-memory.txt"), "Latest owner's remote bytes");
      if (["missing-lease", "foreign-run", "foreign-environment", "deleted-environment"].includes(ending)) {
        if (ending === "missing-lease") await db.delete(tables.environmentLeases).where(eq(tables.environmentLeases.id, currentLease));
        if (ending === "foreign-run") await db.update(tables.environmentLeases).set({ heartbeatRunId: materializationRunId }).where(eq(tables.environmentLeases.id, currentLease));
        if (ending === "foreign-environment") {
          const other = randomUUID(); await db.insert(tables.environments).values({ id: other, name: "Other", driver: "sandbox" });
          await db.update(tables.environmentLeases).set({ environmentId: other }).where(eq(tables.environmentLeases.id, currentLease));
        }
        if (ending === "deleted-environment") await db.delete(tables.environments).where(eq(tables.environments.id, environmentId));
        const before = commands.length;
        await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "lease identity changed" });
        expect(commands).toHaveLength(before);
        const pending = (await copies.get(companyId, prior!.binding.runId))!;
        expect(pending.state).toBe("pending_collection");
        expect(pending.receipt?.baseline).toBeDefined();
        expect(await readFile(join(originalRoot, "late-memory.txt"), "utf8")).toBe("Latest owner's remote bytes");
        return;
      }
      if (ending === "close-failure") {
        session.close.mockImplementationOnce(async () => { throw new Error("owned close not yet confirmed"); });
        const before = commands.length;
        expect(await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "first retirement" })).toMatchObject({ failed: 1 });
        await copies.reportUnavailable(companyId, prior!.binding.runId);
        await copies.reportUnavailable(companyId, materializationRunId);
        await copies.release(companyId, prior!.binding.runId);
        await copies.release(companyId, materializationRunId);
        expect(await copies.get(companyId, prior!.binding.runId)).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED", processStoppedAt: null });
        expect(commands).toHaveLength(before);
        expect(await readFile(join(originalRoot, "late-memory.txt"), "utf8")).toBe("Latest owner's remote bytes");
        expect(await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "verified later retirement" })).toMatchObject({ closed: 1, failed: 0 });
        expect(await copies.get(companyId, prior!.binding.runId)).toMatchObject({ state: "saved", receipt: { cleanupPending: false } });
        expect(await readFile(join(canonical, "late-memory.txt"), "utf8")).toBe("Latest owner's remote bytes");
        await expect(access(originalRoot)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (ending !== "collect") {
        const { remoteTerminationReceipt } = await import("../remote-execution-termination.js");
        const [lease] = await db.select().from(tables.environmentLeases).where(eq(tables.environmentLeases.id, currentLease));
        await db.update(tables.environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
          metadata: { ...lease!.metadata, remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: ending }) } }).where(eq(tables.environmentLeases.id, currentLease));
        await db.update(tables.heartbeatRuns).set({ status: "succeeded" }).where(eq(tables.heartbeatRuns.id, prior!.binding.runId));
        const before = commands.length;
        await copies.recoverStopped(); // The original remote collector is still cached.
        expect(commands).toHaveLength(before);
        const recovered = (await copies.get(companyId, prior!.binding.runId))!;
        expect(recovered.state).toBe(ending === "destroyed" ? "unavailable" : "pending_collection");
        await expect(access(join(canonical, "late-memory.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        if (ending === "stopped") {
          expect(await readFile(join(originalRoot, "late-memory.txt"), "utf8")).toBe("Latest owner's remote bytes");
          expect(recovered.receipt?.baseline).toBeDefined();
          await copies.collectStopped({ companyId, runId: prior!.binding.runId });
          await copies.release(companyId, prior!.binding.runId);
          expect(commands).toHaveLength(before);
        } else await expect(access(active!.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "already terminated owner" });
        expect(commands).toHaveLength(before);
        return;
      }
      failCleanup = true;
      await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "test retirement" });
      expect(session.close).toHaveBeenCalledOnce();
      expect(await readFile(join(canonical, "late-memory.txt"), "utf8")).toBe("Latest owner's remote bytes");
      const saved = (await copies.get(companyId, prior!.binding.runId))!;
      expect(saved).toMatchObject({ state: "saved", receipt: { cleanupPending: true, materializationRunId, cleanup: { leaseId: currentLease } } });
      const cleanup = vi.fn(async input => {
        expect(input.lease.id).toBe(currentLease);
        expect(input.lease.heartbeatRunId).toBe(prior!.binding.runId);
        return commandRunner(currentLease).execute(input);
      });
      copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute: cleanup } as never });
      await db.update(tables.agentInstructionWorkingCopies).set({ nextAttemptAt: null }).where(eq(tables.agentInstructionWorkingCopies.runId, prior!.binding.runId));
      await copies.recoverCaptured();
      expect(cleanup).toHaveBeenCalledOnce();
      await expect(access(originalRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await copies.get(companyId, prior!.binding.runId))!.receipt?.cleanupPending).toBe(false);
    } catch (error) { bodyFailure = error; throw error; }
    finally {
      const cleanupFailures: unknown[] = [];
      try { await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "test cleanup" }); } catch (error) { cleanupFailures.push(error); }
      try { await database.cleanup(); } catch (error) { cleanupFailures.push(error); }
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
      try {
        const writable = async (directory: string): Promise<void> => {
          await chmod(directory, 0o700);
          for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(directory, entry.name));
        };
        await writable(home); await rm(home, { recursive: true, force: true });
      } catch (error) { cleanupFailures.push(error); }
      if (cleanupFailures.length) throw new AggregateError([...(bodyFailure ? [bodyFailure] : []), ...cleanupFailures], "Warm DB test body/cleanup failure");
    }
  }, 90_000);

  it.each(["idle", "edit", "add", "remove", "projectless"])("retains the actual agent_files copy across warm turns, then retires for %s", async ending => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "warm-agent-files-")));
    const localRoot = join(root, "run", "live");
    await mkdir(localRoot, { recursive: true });
    await writeFile(join(localRoot, "AGENTS.md"), "Keep the registered directory.\n");
    const snapshot = await captureDirectorySnapshot(localRoot);
    let row = { companyId: execution.binding.companyId, agentId: execution.binding.agentId,
      runId: "warm-real-agent-files", localRoot, executionRoot: localRoot, location: "local",
      entryFile: "AGENTS.md", state: "prepared", attempts: 0, processStoppedAt: null,
      baseRevisionId: null, candidateBase64: null, candidateHash: null, errorCode: null, errorMessage: null, nextAttemptAt: null,
      responsibleUserId: "test-user", createdAt: new Date(), updatedAt: new Date(),
      baseHash: directorySnapshotSha256(snapshot), receipt: { schema: AGENT_FILES_CONTRACT, baseline: serializeDirectorySnapshot(snapshot), materializationIdentity: probeAgentDirectory(localRoot).identity },
    } as typeof agentInstructionWorkingCopies.$inferSelect;
    const copies = agentDirectoryWorkingCopyService({} as Db, async () => row,
      async (_prior, values) => (row = { ...row, ...values } as typeof row));
    const order: string[] = [];
    const close = vi.fn(async () => { order.push("closed"); });
    const collectStopped = async () => {
      order.push("collected");
      expect(close).toHaveBeenCalledOnce();
      // The real DB service suite verifies changed-file persistence. Here the
      // fake backend proves stop precedes granting its collection callback.
      if (ending === "idle" || ending === "projectless") await copies.collectStopped(row);
    };
    const identity = "warm-real-agent-files";
    const warmExecution = { ...execution, binding: { ...execution.binding, runId: identity, executionWorkspaceId: ending === "projectless" ? identity : `${identity}-workspace` },
      session: { ...execution.session, normalizedSessionId: identity, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    const session = { close };
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.onSession?.(session);
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
        turnId: identity, normalizedSessionId: identity, providerSessionId: identity,
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    try {
      await executePaperclipNativeSession({ db: leaseDb(warmExecution), execution: warmExecution,
        runnerInstanceId: identity, runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId: identity, remoteCwd: `/tmp/${identity}` },
        instructionWorkingCopy: { runId: identity, root: localRoot, preparationKey: "same-preparation", hasChanges: () => copies.hasChanges(row), collectStopped } });
      expect(close).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(await readFile(join(localRoot, "AGENTS.md"), "utf8")).toContain("registered");
      const second = { ...warmExecution, binding: { ...warmExecution.binding, runId: `${identity}-second`,
        ...(ending === "projectless" ? { executionWorkspaceId: `${identity}-second` } : {}) } };
      expect(nativeSessionWorkspaceScope(second)).toEqual(nativeSessionWorkspaceScope(warmExecution));
      const currentCopy = { runId: second.binding.runId, root: localRoot, preparationKey: "same-preparation", hasChanges: () => copies.hasChanges(row), collectStopped };
      if (ending === "projectless") {
        const adopt = vi.fn(async () => currentCopy);
        for (const changed of [
          { ...second.workspace, cwd: "/different" }, { ...second.workspace, repoUrl: "https://example.test/other" },
          { ...second.workspace, repoRef: "other" }, { ...second.workspace, branchName: "other" },
        ]) expect(await claimWarmNativeInstructionCopy({ priorExecution: warmExecution,
          companyId: second.binding.companyId, agentId: second.binding.agentId, executionWorkspaceId: second.binding.runId,
          workspace: changed, environmentId: identity, runId: second.binding.runId, preparationKey: "same-preparation", adopt })).toBeNull();
        expect(await claimWarmNativeInstructionCopy({ priorExecution: warmExecution,
          companyId: second.binding.companyId, agentId: second.binding.agentId, executionWorkspaceId: "managed-workspace",
          workspace: second.workspace, environmentId: identity, runId: second.binding.runId, preparationKey: "same-preparation", adopt })).toBeNull();
        expect(adopt).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      }
      const release = await claimWarmNativeInstructionCopy({ priorExecution: warmExecution,
        companyId: warmExecution.binding.companyId, agentId: warmExecution.binding.agentId,
        executionWorkspaceId: second.binding.executionWorkspaceId, workspace: second.workspace,
        environmentId: identity, runId: second.binding.runId, preparationKey: "same-preparation",
        adopt: async () => currentCopy });
      expect(release).toBeTypeOf("function");
      await executePaperclipNativeSession({ db: leaseDb(second), execution: second, runnerInstanceId: identity,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId: identity, remoteCwd: `/tmp/${identity}` },
        instructionWorkingCopy: currentCopy });
      expect(state.execute.mock.calls.at(-1)?.[0].existingSession).toBe(session);
      expect(close).not.toHaveBeenCalled();
      expect(row.executionRoot).toBe(localRoot);
      await release?.(); // Consumed preparation cannot retire the retained owner.
      expect(close).not.toHaveBeenCalled();
      if (ending === "idle" || ending === "projectless") {
        await closeWarmNativeSessionsForEnvironment({ environmentId: identity, reason: "idle retirement" });
        await expect(access(localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        if (ending === "edit") await writeFile(join(localRoot, "AGENTS.md"), "Changed instructions");
        if (ending === "add") await writeFile(join(localRoot, "memory.txt"), "New memory");
        if (ending === "remove") await rm(join(localRoot, "AGENTS.md"));
        const adopt = vi.fn(async () => ({ ...currentCopy, runId: `${identity}-third` }));
        expect(await claimWarmNativeInstructionCopy({ priorExecution: second,
          companyId: second.binding.companyId, agentId: second.binding.agentId,
          executionWorkspaceId: second.binding.executionWorkspaceId, workspace: second.workspace,
          environmentId: identity, runId: `${identity}-third`, preparationKey: "same-preparation", adopt })).toBeNull();
        expect(adopt).toHaveBeenCalledOnce();
      }
      expect(order).toEqual(["closed", "collected"]);
    } finally {
      await closeWarmNativeSessionsForEnvironment({ environmentId: identity, reason: "test cleanup" });
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["final-config", "changed-root", "late-edit", "close-failure", "abandon", "concurrent", "foreign-company", "foreign-workspace"])("fences owned instruction preparation: %s", async scenario => {
    const identity = `warm-copy-${scenario}`;
    const order: string[] = [];
    let allowClose = scenario !== "close-failure";
    const session = { close: vi.fn(async () => { order.push("close"); if (!allowClose) throw new Error("retirement unconfirmed"); }) };
    const retirementFailed = vi.fn(async () => {});
    let lateEdit = false;
    const copy = { runId: identity, root: `/tmp/${identity}/instructions`, preparationKey: "key", hasChanges: async () => lateEdit,
      collectStopped: vi.fn(async () => { order.push("collect"); }), retirementFailed };
    const first = { ...execution, binding: { ...execution.binding, runId: identity, executionWorkspaceId: `${identity}-workspace` },
      session: { ...execution.session, normalizedSessionId: identity, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId: identity, remoteCwd: `/tmp/${identity}` };
    state.execute.mockReset().mockImplementation(async options => {
      await options.onSession?.(session);
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
        turnId: identity, normalizedSessionId: identity, providerSessionId: identity,
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const second = { ...first, binding: { ...first.binding, runId: `${identity}-second` } };
    const current = { ...copy, runId: second.binding.runId,
      ...(scenario === "changed-root" ? { root: `/tmp/${identity}/other-instructions` } : {}) };
    const adopt = vi.fn(async () => current);
    const claim = { priorExecution: first, companyId: first.binding.companyId, agentId: first.binding.agentId,
      executionWorkspaceId: first.binding.executionWorkspaceId, workspace: first.workspace, environmentId: identity,
      runId: second.binding.runId, preparationKey: "key", adopt };
    try {
      await executePaperclipNativeSession({ db: leaseDb(first), execution: first, runnerInstanceId: identity, runnerExecutionTarget: target, instructionWorkingCopy: copy });
      if (scenario.startsWith("foreign")) {
        expect(await claimWarmNativeInstructionCopy({ ...claim,
          ...(scenario === "foreign-company" ? { companyId: "other" } : { executionWorkspaceId: "other" }) })).toBeNull();
        expect(adopt).not.toHaveBeenCalled(); expect(session.close).not.toHaveBeenCalled();
      } else {
        const release = await claimWarmNativeInstructionCopy(claim);
        if (scenario === "concurrent") await expect(claimWarmNativeInstructionCopy({ ...claim, runId: "competitor" })).rejects.toThrow("busy");
        if (scenario === "final-config" || scenario === "changed-root" || scenario === "late-edit") {
          lateEdit = scenario === "late-edit";
          const changed = scenario !== "final-config" ? second : { ...second, session: { ...second.session, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 99_000 } } };
          await expect(executePaperclipNativeSession({ db: leaseDb(changed), execution: changed, runnerInstanceId: identity,
            runnerExecutionTarget: target, instructionWorkingCopy: current })).rejects.toThrow(scenario === "late-edit"
              ? "native_instruction_preparation_copy_changed" : "native_instruction_preparation_configuration_changed");
          expect(state.execute).toHaveBeenCalledOnce();
        }
        if (scenario === "close-failure") {
          await expect(release!()).rejects.toThrow("retirement unconfirmed");
          expect(retirementFailed).toHaveBeenCalledOnce();
          expect(copy.collectStopped).not.toHaveBeenCalled();
          expect(order).toEqual(["close"]);
        } else {
          await release?.();
          expect(order).toEqual(["close", "collect"]);
        }
      }
    } finally { allowClose = true; await closeWarmNativeSessionsForEnvironment({ environmentId: identity, reason: "test cleanup" }); }
  });

  it.each(["config", "reset", "changed", "unavailable", "auth", "wrong-capability", "retirement-failure"])("hands off collection before probing or retiring a warm owner: %s", async scenario => {
    const identity = `warm-successor-${scenario}`, order: string[] = [];
    let allowClose = scenario !== "retirement-failure";
    const session = { close: vi.fn(async () => { order.push("stop"); if (!allowClose) throw new Error("stop unconfirmed"); }) };
    const priorCopy = { runId: identity, preparationKey: "before", hasChanges: vi.fn(async () => false),
      collectStopped: vi.fn(async () => { order.push("prior-pending"); }), retirementFailed: vi.fn(async () => {}) };
    const first = { ...execution, binding: { ...execution.binding, runId: identity, executionWorkspaceId: `${identity}-workspace` },
      session: { ...execution.session, normalizedSessionId: identity, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
    const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId: identity, remoteCwd: `/tmp/${identity}` };
    state.execute.mockReset().mockImplementation(async options => {
      await options.onSession?.(session);
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: identity,
        normalizedSessionId: identity, providerSessionId: identity, driverKind: "test", driverVersion: "1",
        nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const current = { runId: `${identity}-next`, preparationKey: scenario === "config" ? "after" : "before",
      hasChanges: vi.fn(async () => { order.push("current-probe"); return true; }),
      collectStopped: vi.fn(async () => { order.push("current-collect"); }), retirementFailed: vi.fn(async () => {}) };
    const adopt = vi.fn(async () => {
      order.push("handoff");
      if (scenario === "auth") throw new Error("authorization denied");
      if (scenario === "unavailable") return null;
      return scenario === "wrong-capability" ? { ...current, runId: "foreign" } : current;
    });
    try {
      await executePaperclipNativeSession({ db: leaseDb(first), execution: first, runnerInstanceId: identity, runnerExecutionTarget: target, instructionWorkingCopy: priorCopy });
      priorCopy.hasChanges.mockClear();
      const claiming = claimWarmNativeInstructionCopy({ priorExecution: first, companyId: first.binding.companyId, agentId: first.binding.agentId,
        executionWorkspaceId: first.binding.executionWorkspaceId, workspace: first.workspace, environmentId: identity,
        runId: current.runId, preparationKey: current.preparationKey, forceRetirement: scenario === "reset", adopt });
      if (["unavailable", "auth", "wrong-capability", "retirement-failure"].includes(scenario)) {
        await expect(claiming).rejects.toThrow(({ unavailable: "handoff_unavailable", auth: "authorization denied",
          "wrong-capability": "handoff_mismatch", "retirement-failure": "stop unconfirmed" } as Record<string, string>)[scenario]);
      } else expect(await claiming).toBeNull();
      expect(priorCopy.hasChanges).not.toHaveBeenCalled();
      expect(state.execute).toHaveBeenCalledOnce();
      if (["unavailable", "auth", "wrong-capability"].includes(scenario)) {
        expect(order).toEqual(["handoff", "stop", "prior-pending"]);
        expect(current.collectStopped).not.toHaveBeenCalled();
      } else {
        expect(priorCopy.collectStopped).not.toHaveBeenCalled();
        expect(order).toEqual(["handoff", ...(["config", "reset"].includes(scenario) ? [] : ["current-probe"]), "stop", ...(scenario === "retirement-failure" ? [] : ["current-collect"])]);
        if (scenario === "retirement-failure") {
          expect(current.retirementFailed).toHaveBeenCalledOnce();
          expect(current.collectStopped).not.toHaveBeenCalled();
        }
      }
    } finally { allowClose = true; await closeWarmNativeSessionsForEnvironment({ environmentId: identity, reason: "test cleanup" }); }
  });

  it.each([
    { change: "addition", before: {}, after: { CUSTOM_TOKEN: "first" }, replaced: true },
    { change: "rotation", before: { CUSTOM_TOKEN: "first" }, after: { CUSTOM_TOKEN: "second" }, replaced: true },
    { change: "removal", before: { CUSTOM_TOKEN: "first" }, after: {}, replaced: true },
    { change: "unchanged values", before: { CUSTOM_TOKEN: "first", FLAG: "on" }, after: { FLAG: "on", CUSTOM_TOKEN: "first" }, replaced: false },
  ])("applies configured environment $change on the next warm turn", async ({ change, before, after, replaced }) => {
    const name = `warm-task-env-${change}`;
    const current = { ...execution,
      binding: { ...execution.binding, runId: `${name}-one`, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 } },
    } as NativeExecutionInputV1;
    const first = { close: vi.fn(async () => undefined) };
    const second = { close: vi.fn(async () => undefined) };
    const result = { result: { summary: "done" }, terminal: { runTerminalState: "succeeded" },
      turnId: name, normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
      nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    state.execute.mockReset()
      .mockImplementationOnce(async options => { await options.onSession?.(first); return result; })
      .mockImplementationOnce(async options => {
        expect(options.existingSession).toBe(replaced ? undefined : first);
        await options.onSession?.(replaced ? second : first);
        return result;
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name,
        runnerEnvironment: configuredEnvironmentProjection(before) });
      const next = { ...current, binding: { ...current.binding, runId: `${name}-two` } };
      await executePaperclipNativeSession({ db: leaseDb(next), execution: next, runnerInstanceId: name,
        runnerEnvironment: configuredEnvironmentProjection(after) });
      expect(first.close).toHaveBeenCalledTimes(replaced ? 1 : 0);
      if (replaced) expect(first.close).toHaveBeenCalledWith({ reason: "warm native session configuration changed" });
      await vi.advanceTimersByTimeAsync(20);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { runTerminalState: "failed", managedFiles: true },
    { runTerminalState: "cancelled", managedFiles: true },
    { runTerminalState: "failed", managedFiles: false },
    { runTerminalState: "cancelled", managedFiles: false },
  ] as const)("retires a structured $runTerminalState turn before its reusable sandbox stops (managed files: $managedFiles)", async ({ runTerminalState, managedFiles }) => {
    const name = `warm-terminal-${runTerminalState}-${managedFiles}`;
    const current = { ...execution,
      binding: { ...execution.binding, runId: `${name}-one`, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId: name,
      remoteCwd: `/tmp/${name}`, sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: name } };
    let sandboxStopped = false;
    const close = vi.fn(async () => {
      if (sandboxStopped) throw new Error(`Daytona sandbox lease ${name} is no longer active.`);
    });
    const collectStopped = vi.fn(async () => undefined);
    const checkpointWarm = vi.fn(async () => true);
    const copy = { runId: current.binding.runId, root: `/tmp/${name}/home`, collectStopped, checkpointWarm, hasChanges: vi.fn() };
    const terminalResult = { result: { summary: "provider stopped" }, terminal: { runTerminalState },
      turnId: name, normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
      nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.({ close });
      return terminalResult;
    });
    try {
      const result = await executePaperclipNativeSession({ db: leaseDb(current), execution: current,
        runnerInstanceId: name, runnerExecutionTarget: target, ...(managedFiles ? { instructionWorkingCopy: copy } : {}) });
      expect(result.exitCode).toBe(1);
      // Heartbeat stops failed/cancelled sandboxes after the native executor
      // returns. Their sessions must already be retired and files collected.
      expect(close).toHaveBeenCalledOnce();
      expect(collectStopped).toHaveBeenCalledTimes(managedFiles ? 1 : 0);
      if (managedFiles) expect(close.mock.invocationCallOrder[0]).toBeLessThan(collectStopped.mock.invocationCallOrder[0]!);
      expect(checkpointWarm).toHaveBeenCalledTimes(managedFiles ? 1 : 0);
      if (managedFiles) expect(checkpointWarm.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
      sandboxStopped = true;
      expect(await reserveWarmNativeInstructionDirectory({ companyId: current.binding.companyId,
        agentId: current.binding.agentId, previousRunId: current.binding.runId, runId: `${name}-two`,
        target, canReuse: async () => true })).toBeNull();
      // A corrected credential rotates the native identity on the next run.
      // It must not try to close the stopped prior owner again at startup.
      const next = { ...current, binding: { ...current.binding, runId: `${name}-two` },
        session: { ...current.session, normalizedSessionId: `${name}-replacement` } };
      state.execute.mockImplementationOnce(async options => {
        expect(options.existingSession).toBeUndefined();
        return { ...terminalResult, terminal: { runTerminalState: "succeeded" } };
      });
      await expect(executePaperclipNativeSession({ db: leaseDb(next), execution: next,
        runnerInstanceId: `${name}-two`, runnerExecutionTarget: target })).resolves.toMatchObject({ exitCode: 0 });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      sandboxStopped = false;
      await closeWarmNativeSessionsForEnvironment({ environmentId: name, reason: "test cleanup" });
    }
  });

  it.each(["failed", "cancelled"] as const)("checkpoints managed edits before retiring a %s session whose close rejects", async (runTerminalState) => {
    const name = `warm-terminal-close-fails-${runTerminalState}`;
    const current = { ...execution,
      binding: { ...execution.binding, runId: name, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    let canonicalNote = "original";
    const checkpointWarm = vi.fn(async () => { canonicalNote = "edited during failed turn"; return true; });
    const close = vi.fn(async () => { throw new Error("provider shutdown failed"); });
    const collectStopped = vi.fn(async () => undefined);
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.({ close });
      return { result: { summary: "provider failed" }, terminal: { runTerminalState },
        turnId: name, normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
        nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name,
      instructionWorkingCopy: { runId: name, root: `/tmp/${name}`, checkpointWarm, collectStopped, hasChanges: vi.fn() },
    })).resolves.toMatchObject({ exitCode: 1 });
    expect(checkpointWarm).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(checkpointWarm.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(canonicalNote).toBe("edited during failed turn");
    // Failed close is not proof that the process stopped. The preceding warm
    // checkpoint preserves the edits without calling stopped-only collection.
    expect(collectStopped).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)("retires a %s session even if its warm checkpoint rejects", async (runTerminalState) => {
    const name = `warm-checkpoint-rejects-${runTerminalState}`;
    const current = { ...execution,
      binding: { ...execution.binding, runId: name, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    const close = vi.fn(async () => undefined);
    const collectStopped = vi.fn(async () => undefined);
    const failure = new Error("instruction-save receipt failed");
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.({ close });
      return { result: { summary: "provider failed" }, terminal: { runTerminalState },
        turnId: name, normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
        nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name,
      instructionWorkingCopy: { runId: name, root: `/tmp/${name}`, collectStopped, hasChanges: vi.fn(),
        checkpointWarm: async () => { throw failure; } },
    })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(collectStopped).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(collectStopped.mock.invocationCallOrder[0]!);
    expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 0, busy: 0, failed: 0 });
  });

  it.each(["failed", "cancelled"] as const)("collects edits written during %s provider shutdown after the warm checkpoint", async (runTerminalState) => {
    const name = `warm-shutdown-edits-${runTerminalState}`;
    const current = { ...execution,
      binding: { ...execution.binding, runId: name, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    let remoteNote = "before shutdown";
    let canonicalNote = "original";
    const checkpointWarm = vi.fn(async () => { canonicalNote = remoteNote; return true; });
    const close = vi.fn(async () => { remoteNote += "\nafter shutdown"; });
    const collectStopped = vi.fn(async () => { canonicalNote = remoteNote; });
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.({ close });
      return { result: { summary: "provider failed" }, terminal: { runTerminalState },
        turnId: name, normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
        nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await expect(executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name,
      instructionWorkingCopy: { runId: name, root: `/tmp/${name}`, checkpointWarm, collectStopped, hasChanges: vi.fn() },
    })).resolves.toMatchObject({ exitCode: 1 });
    expect(checkpointWarm).toHaveBeenCalledOnce();
    expect(collectStopped).toHaveBeenCalledOnce();
    expect(checkpointWarm.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(collectStopped.mock.invocationCallOrder[0]!);
    expect(canonicalNote).toBe("before shutdown\nafter shutdown");
  });

  it("retains durable computer owners before ack and closes only the requested run", async () => {
    const owners: Array<{ runId: string; close: ReturnType<typeof vi.fn>; retainWarm: ReturnType<typeof vi.fn>; retire: ReturnType<typeof vi.fn> }> = [];
    for (const suffix of ["a", "b"]) {
      const name = `computer-owner-${suffix}`;
      const current = { ...execution, binding: { ...execution.binding, runId: name, agentId: name, executionWorkspaceId: name },
        session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
      const close = vi.fn(async () => undefined), retainWarm = vi.fn(async () => undefined), retire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => { await options?.beforeStop?.(); return true; });
      const target = { kind: "remote" as const, transport: "computer" as const, environmentId: "shared-computer",
        remoteCwd: `/home/user/${name}`, listenerPort: suffix === "a" ? 45001 : 45002,
        resourceAuthority: { kind: "computer-owner", computerId: "computer", ownerId: name, generation: 1 },
        fileAuthority: { kind: "remote-persistent", placementId: name, root: `/home/user/${name}`, agentHome: `/home/user/${name}/home` },
        retainWarm, retire, inspectProcess: async () => ({ running: true, claim: {} }), launch: async () => ({}),
        computerTool: { command: "cua-driver", args: ["mcp"] } };
      state.execute.mockReset().mockImplementationOnce(async options => {
        await options.onSession?.({ close });
        return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: name,
          normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
          nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
      });
      await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name, runnerExecutionTarget: target as never });
      expect(retainWarm).toHaveBeenCalledWith(60_000);
      expect(retire).not.toHaveBeenCalled();
      owners.push({ runId: name, close, retainWarm, retire });
    }
    const result = await closeWarmNativeSessionsForRun({ runId: owners[0]!.runId, reason: "cancel exact task" });
    expect(result.closed).toBe(1);
    expect(owners[0]!.close).toHaveBeenCalledOnce();
    expect(owners[0]!.retire).toHaveBeenCalledOnce();
    expect(owners[0]!.retire.mock.invocationCallOrder[0]).toBeLessThan(owners[0]!.close.mock.invocationCallOrder[0]!);
    expect(owners[1]!.close).not.toHaveBeenCalled();
    expect(owners[1]!.retire).not.toHaveBeenCalled();
    await closeWarmNativeSessionsForRun({ runId: owners[1]!.runId, reason: "fixture cleanup" });
  });

  it.each(["model", "credential", "tools", "read-only"])("replaces a computer warm runner after %s configuration admits a fresh owner", async (change) => {
    const name = `computer-config-change-${change}`;
    const current = { ...execution, binding: { ...execution.binding, runId: `${name}-one`, agentId: name, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
    const firstClose = vi.fn(async () => undefined), secondClose = vi.fn(async () => undefined);
    const firstRetire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => { await options?.beforeStop?.(); return true; }), secondRetire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => { await options?.beforeStop?.(); return true; });
    const target = { kind: "remote", transport: "computer", environmentId: name, remoteCwd: `/home/user/${name}`,
      resourceAuthority: { kind: "computer-owner", computerId: name, ownerId: "prior-owner", generation: 1 },
      retainWarm: vi.fn(async () => undefined), retire: firstRetire };
    const result = { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: name,
      normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1", nativeEventCount: 1,
      highestContiguousSourceSeq: 1, usage: null };
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.({ close: firstClose }); return result;
    }).mockImplementationOnce(async options => {
      expect(options.existingSession).toBeUndefined();
      expect(secondRetire).not.toHaveBeenCalled();
      await options.onSession?.({ close: secondClose }); return result;
    });
    await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name, runnerExecutionTarget: target as never,
      managedAiCredentialIdentity: "credential-before" });
    const next = { ...current, binding: { ...current.binding, runId: `${name}-two` }, provider: change === "model" ? { ...current.provider, model: "changed-model" } : current.provider,
      task: { ...current.task, workMode: change === "read-only" ? "ask" : "standard" } } as NativeExecutionInputV1;
    await executePaperclipNativeSession({ db: leaseDb(next), execution: next, runnerInstanceId: name,
      managedAiCredentialIdentity: change === "credential" ? "credential-after" : "credential-before",
      refreshTools: change === "tools",
      runnerExecutionTarget: { ...target, resourceAuthority: { ...target.resourceAuthority, ownerId: "fresh-owner" }, retire: secondRetire } as never });
    expect(firstRetire).toHaveBeenCalledOnce();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondRetire).not.toHaveBeenCalled();
    await closeWarmNativeSessionsForRun({ runId: next.binding.runId, reason: "fixture cleanup" });
    expect(secondRetire).toHaveBeenCalledOnce();
  });

  it("keeps a computer transport alive when its old idle timer loses to warm admission", async () => {
    const name = "computer-idle-admission-race";
    const current = { ...execution, binding: { ...execution.binding, runId: `${name}-one`, agentId: name, executionWorkspaceId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
    const close = vi.fn(async () => undefined);
    const detachControllerForRestart = vi.fn(async () => undefined);
    const session = { close, detachControllerForRestart };
    let generation = 1;
    const retire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => { if (generation !== 1) return false; await options?.beforeStop?.(); return true; });
    const target = { kind: "remote", transport: "computer", environmentId: name, remoteCwd: `/home/user/${name}`,
      resourceAuthority: { kind: "computer-owner", computerId: name, ownerId: name, generation: 1 },
      retainWarm: vi.fn(async () => undefined), retire };
    const result = { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: name,
      normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1",
      nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    state.execute.mockReset().mockImplementationOnce(async options => {
      await options.onSession?.(session); return result;
    }).mockImplementationOnce(async options => {
      expect(options.existingSession).toBe(session);
      await options.onSession?.(session); return result;
    });
    const environmentForRun = async (runId: string) => (await prepareHeartbeatGitHubLaunchers({
      native: true, githubConfigured: false, agentId: name, runId, target: target as never,
      cwd: target.remoteCwd, env: {}, brokerUrl: "http://127.0.0.1:3104",
      createBrokerToken: () => { throw new Error("Anonymous computer must not mint per-run authority"); },
    }, async (input) => input.env)).env;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name, runnerExecutionTarget: target as never,
        runnerEnvironment: await environmentForRun(current.binding.runId) });
      generation = 2; // The durable admission committed before local reservation.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(retire).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(detachControllerForRestart).not.toHaveBeenCalled();
      const next = { ...current, binding: { ...current.binding, runId: `${name}-two` } };
      const nextRetire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => { await options?.beforeStop?.(); return true; });
      await executePaperclipNativeSession({ db: leaseDb(next), execution: next, runnerInstanceId: name,
        runnerEnvironment: await environmentForRun(next.binding.runId),
        runnerExecutionTarget: { ...target, resourceAuthority: { ...target.resourceAuthority, generation: 2 }, retire: nextRetire } as never });
      await closeWarmNativeSessionsForRun({ runId: next.binding.runId, reason: "fixture cleanup" });
      expect(nextRetire).toHaveBeenCalledOnce();
      expect(detachControllerForRestart).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  describe("managed directory warm checkpoints", () => {
    const result = { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
      turnId: "turn", normalizedSessionId: "managed", providerSessionId: "provider", driverKind: "test", driverVersion: "1",
      nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    async function start(name: string, checkpoint = true) {
      const current = { ...execution, binding: { ...execution.binding, runId: `${name}-one`, executionWorkspaceId: name },
        session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
      const close = vi.fn(async () => undefined);
      const session = { close };
      const collectStopped = vi.fn(async () => undefined);
      const checkpointWarm = vi.fn(async () => checkpoint);
      const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId: name, remoteCwd: `/tmp/${name}`, sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: name } };
      const copy = { runId: current.binding.runId, root: `/tmp/${name}/home`, collectStopped, checkpointWarm, hasChanges: vi.fn(async () => true) };
      state.execute.mockReset().mockImplementationOnce(async options => { await options.onSession?.(session); return result; });
      const run = (next: NativeExecutionInputV1, nextCopy = copy) => executePaperclipNativeSession({
        db: leaseDb(next), execution: next, runnerInstanceId: name, runnerExecutionTarget: target, instructionWorkingCopy: nextCopy });
      await run(current);
      const reserve = (canReuse: () => Promise<boolean>, nextTarget = target) => reserveWarmNativeInstructionDirectory({
        companyId: current.binding.companyId, agentId: current.binding.agentId, previousRunId: current.binding.runId,
        runId: `${name}-two`, target: nextTarget, canReuse });
      return { current, copy, close, session, target, run, reserve };
    }
    afterEach(async () => { await closeIdleWarmNativeSessionsForRestart(); });

    it("saves each turn while retaining the provider and collects only the latest directory owner at retirement", async () => {
      const f = await start("managed-retained");
      expect(f.copy.checkpointWarm).toHaveBeenCalledOnce();
      expect(f.copy.hasChanges).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      const reservation = await f.reserve(async () => true);
      expect(reservation?.reuseRunId).toBe(f.current.binding.runId);
      const secondCopy = { ...f.copy, runId: "managed-retained-two", collectStopped: vi.fn(async () => undefined) };
      reservation!.adopt(secondCopy.root, secondCopy.collectStopped);
      state.execute.mockImplementationOnce(async options => {
        expect(options.existingSession).toBe(f.session);
        await options.onSession?.(f.session); return result;
      });
      await f.run({ ...f.current, binding: { ...f.current.binding, runId: secondCopy.runId } }, secondCopy);
      await reservation!.release();
      expect(f.close).not.toHaveBeenCalled();
      expect(f.copy.checkpointWarm).toHaveBeenCalledTimes(2);
      await closeWarmNativeSessionsForEnvironment({ environmentId: f.target.environmentId, reason: "test retirement" });
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.copy.collectStopped).not.toHaveBeenCalled();
      expect(secondCopy.collectStopped).toHaveBeenCalledOnce();
    });

    it("stops before collecting when a checkpoint cannot stabilize", async () => {
      const f = await start("managed-fallback", false);
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.copy.collectStopped).toHaveBeenCalledOnce();
      expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.copy.collectStopped.mock.invocationCallOrder[0]!);
    });

    it.each(["canonical-edit", "replaced-environment", "authorization-error"])("retires before admission for %s", async reason => {
      const f = await start(`managed-${reason}`);
      const validation = vi.fn(async () => { if (reason === "authorization-error") throw new Error("authorization revoked"); return reason !== "canonical-edit"; });
      const attempt = f.reserve(validation, reason === "replaced-environment" ? { ...f.target, remoteCwd: "/different" } : f.target);
      if (reason === "authorization-error") await expect(attempt).rejects.toThrow("authorization revoked");
      else expect(await attempt).toBeNull();
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.copy.collectStopped).toHaveBeenCalledOnce();
      if (reason === "replaced-environment") expect(validation).not.toHaveBeenCalled();
    });

    it("retains failed containment for retry and forbids warm reuse until it succeeds", async () => {
      const f = await start("managed-stop-failure");
      f.close.mockRejectedValueOnce(new Error("containment failed"));
      await expect(f.reserve(async () => false)).rejects.toThrow("containment failed");
      expect(f.copy.collectStopped).not.toHaveBeenCalled();
      const canReuse = vi.fn(async () => true);
      expect(await f.reserve(canReuse)).toBeNull();
      expect(canReuse).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.copy.collectStopped).toHaveBeenCalledOnce();
    });
    it("cleans up the successor if preparation fails after directory handoff", async () => {
      const f = await start("managed-failed-preparation");
      const reservation = await f.reserve(async () => true);
      const collectSuccessor = vi.fn(async () => undefined);
      reservation!.adopt(f.copy.root, collectSuccessor);
      await reservation!.release();
      await reservation!.release();
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.copy.collectStopped).not.toHaveBeenCalled();
      expect(collectSuccessor).toHaveBeenCalledOnce();
    });

    it("preserves a handed-off directory when configuration rotates the old provider", async () => {
      const f = await start("managed-policy-rotation");
      const reservation = await f.reserve(async () => true);
      const nextCopy = { ...f.copy, runId: "managed-policy-rotation-two", collectStopped: vi.fn(async () => undefined) };
      reservation!.adopt(nextCopy.root, nextCopy.collectStopped);
      const replacement = { close: vi.fn(async () => undefined) };
      state.execute.mockImplementationOnce(async options => {
        expect(options.existingSession).toBeUndefined();
        expect(f.close).toHaveBeenCalledOnce();
        expect(nextCopy.collectStopped).not.toHaveBeenCalled();
        await options.onSession?.(replacement); return result;
      });
      await f.run({ ...f.current, binding: { ...f.current.binding, runId: nextCopy.runId },
        session: { ...f.current.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 120_000 } } }, nextCopy);
      await reservation!.release();
      expect(nextCopy.collectStopped).not.toHaveBeenCalled();
      await closeWarmNativeSessionsForEnvironment({ environmentId: f.target.environmentId, reason: "test" });
      expect(nextCopy.collectStopped).toHaveBeenCalledOnce();
    });
    it("cannot reuse a provider with a different registered directory", async () => {
      const f = await start("managed-root-replaced");
      state.execute.mockImplementationOnce(async options => { expect(options.existingSession).toBeUndefined(); return result; });
      await f.run({ ...f.current, binding: { ...f.current.binding, runId: "managed-root-two" } }, { ...f.copy, root: "/new/home" });
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.copy.collectStopped).toHaveBeenCalledOnce();
    });
  });
  it.each([
    { changed: false, closeFails: false },
    { changed: true, closeFails: false },
    { changed: true, closeFails: true },
  ])("collects changed instructions only after the owned warm provider stops (changed=$changed, close fails=$closeFails)", async ({ changed, closeFails }) => {
    const identity = `instruction-close-${changed}-${closeFails}`;
    let releaseClose!: () => void;
    const closed = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closed; if (closeFails) throw new Error("instruction provider close failed"); });
    const collectStopped = vi.fn(async () => {});
    const hasChanges = vi.fn(async () => changed);
    const warmExecution = { ...execution,
      binding: { ...execution.binding, runId: identity, executionWorkspaceId: identity },
      session: { ...execution.session, normalizedSessionId: identity, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
    } as NativeExecutionInputV1;
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      expect(options.requireSessionCloseBeforeReturn).toBe(true);
      expect(options.onSessionClosed).toBe(collectStopped);
      await options.onSession?.({ close });
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
        turnId: identity, normalizedSessionId: identity, providerSessionId: identity,
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const running = executePaperclipNativeSession({ db: leaseDb(warmExecution), execution: warmExecution,
      runnerInstanceId: identity, runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId: identity, remoteCwd: `/tmp/${identity}` },
      instructionWorkingCopy: { hasChanges, collectStopped } });
    const observed = running.then(() => null, error => error);
    try {
      if (changed) {
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(collectStopped).not.toHaveBeenCalled();
        releaseClose();
        const error = await observed;
        if (closeFails) {
          expect(error?.message).toBe("instruction provider close failed");
          expect(collectStopped).not.toHaveBeenCalled();
        } else {
          expect(error).toBeNull();
          expect(collectStopped).toHaveBeenCalledOnce();
        }
      } else {
        expect(await observed).toBeNull();
        expect(close).not.toHaveBeenCalled();
        expect(collectStopped).not.toHaveBeenCalled();
      }
    } finally {
      releaseClose();
      await closeWarmNativeSessionsForEnvironment({ environmentId: identity, reason: "test cleanup" });
    }
  });

  describe("warm session identity transitions", () => {
    let previousHome: string | undefined;
    let isolatedHome: string;
    beforeEach(async () => {
      previousHome = process.env.PAPERCLIP_HOME;
      isolatedHome = await mkdtemp(join(tmpdir(), "native-identity-transition-"));
      process.env.PAPERCLIP_HOME = isolatedHome;
    });
    afterEach(async () => {
      await closeIdleWarmNativeSessionsForRestart();
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      await rm(isolatedHome, { recursive: true, force: true });
    });
    const result = {
      result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
      turnId: "turn", normalizedSessionId: "old", providerSessionId: "provider",
      driverKind: "test", driverVersion: "1", nativeEventCount: 1,
      highestContiguousSourceSeq: 1, usage: null,
    };
    function fixture(name: string) {
      const base = {
        ...execution,
        binding: { ...execution.binding, runId: `${name}-first`, executionWorkspaceId: name },
        session: { ...execution.session, normalizedSessionId: `${name}-old`,
          lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } },
      } as NativeExecutionInputV1;
      const next = { ...base, binding: { ...base.binding, runId: `${name}-second` },
        session: { ...base.session, normalizedSessionId: `${name}-new` } };
      const run = (input: NativeExecutionInputV1) => executePaperclipNativeSession({
        db: leaseDb(input), execution: input, runnerInstanceId: "runner",
      });
      return { base, next, run };
    }

    it("replaces an older warm process before the first turn with cryptographic identity", async () => {
      const { base } = fixture("identity-key-upgrade");
      const next = { ...base, binding: { ...base.binding, runId: "identity-key-next" } };
      const close = vi.fn(async () => undefined);
      state.execute.mockReset().mockImplementationOnce(async options => {
        options.onSession?.({ close }); return result;
      }).mockImplementationOnce(async options => {
        expect(close).toHaveBeenCalledWith({ reason: "warm native session configuration changed" });
        expect(options.existingSession).toBeUndefined();
        return result;
      });
      await executePaperclipNativeSession({ db: leaseDb(base), execution: base, runnerInstanceId: "runner" });
      await executePaperclipNativeSession({ db: leaseDb(next), execution: next, runnerInstanceId: "runner",
        runnerEnvironment: { PAPERCLIP_AGENT_KEY_ID: "sha256:identity-key" } });
      expect(state.execute).toHaveBeenCalledTimes(2);
    });

    it("awaits prior idle ownership retirement before launching the accepted-plan session", async () => {
      const { base, next, run } = fixture("identity-handoff");
      let finishClose!: () => void;
      const close = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve; }));
      state.execute.mockReset().mockImplementationOnce(async options => {
        options.onSession?.({ close }); return result;
      }).mockImplementationOnce(async options => {
        expect(close).toHaveBeenCalledOnce();
        expect(options.existingSession).toBeUndefined();
        return result;
      });
      await run(base);
      const replacement = run(next);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(state.execute).toHaveBeenCalledTimes(1);
      await expect(run({ ...next, binding: { ...next.binding, runId: "racing-new-session" } }))
        .rejects.toThrow("native_session_supervisor_busy");
      finishClose();
      await replacement;
      expect(close).toHaveBeenCalledWith({ reason: "warm native session identity changed" });
      expect(state.execute).toHaveBeenCalledTimes(2);
    });

    it("does not retire an active turn when a new session identity arrives", async () => {
      const { base, next, run } = fixture("identity-active");
      let finish!: () => void;
      const close = vi.fn(async () => undefined);
      state.execute.mockReset().mockImplementationOnce(async options => {
        options.onSession?.({ close });
        await new Promise<void>(resolve => { finish = resolve; });
        return result;
      });
      const active = run(base);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await expect(run(next)).rejects.toThrow("native_session_supervisor_busy");
      expect(close).not.toHaveBeenCalled();
      finish(); await active;
      await closeIdleWarmNativeSessionsForRestart();
    });

    it("retains failed retirement for retry and never launches over an uncontained owner", async () => {
      const { base, next, run } = fixture("identity-close-failure");
      const close = vi.fn().mockRejectedValueOnce(new Error("containment unavailable")).mockResolvedValue(undefined);
      state.execute.mockReset().mockImplementationOnce(async options => {
        options.onSession?.({ close }); return result;
      }).mockResolvedValue(result);
      await run(base);
      await expect(run(next)).rejects.toThrow("containment unavailable");
      expect(state.execute).toHaveBeenCalledTimes(1);
      await run(next);
      expect(close).toHaveBeenCalledTimes(2);
      expect(state.execute).toHaveBeenCalledTimes(2);
    });

    it.each(["companyId", "agentId", "issueId", "executionWorkspaceId"] as const)(
      "does not retire an unrelated %s owner", async field => {
        const { base, next, run } = fixture(`identity-isolation-${field}`);
        const close = vi.fn(async () => undefined);
        state.execute.mockReset().mockImplementationOnce(async options => {
          options.onSession?.({ close }); return result;
        }).mockResolvedValue(result);
        await run(base);
        await run({ ...next, binding: { ...next.binding, [field]: `different-${field}` } });
        expect(close).not.toHaveBeenCalled();
        await closeIdleWarmNativeSessionsForRestart();
      },
    );
  });

  it.each([true, false])(
    "uses provider turn completion without a semantic-result cutoff: chat=%s",
    async (conversationMode) => {
      state.execute.mockReset().mockImplementationOnce(async (options) => {
        // The provider must finish streaming its reply after task tools return.
        // A semantic-result grace timer would truncate that output.
        expect(options).not.toHaveProperty("semanticResultTerminalGraceMs");
        return {
          result: { summary: "Reply completed" },
          terminal: { runTerminalState: "succeeded" },
          turnId: "turn-grace",
          normalizedSessionId: execution.session.normalizedSessionId,
          providerSessionId: "provider-grace",
          driverKind: "test",
          driverVersion: "1",
          nativeEventCount: 1,
          highestContiguousSourceSeq: 1,
        };
      });
      await executePaperclipNativeSession({
        db: leaseDb(),
        execution,
        runnerInstanceId: "runner",
        conversationMode,
      });
    },
  );

  it("persists agent-created goal continuity before a per-turn runner settles", async () => {
    const goalCheckpoint = {
      identity: { runId: execution.binding.runId, sessionId: "session" },
      sessionId: "driver-goal-session",
      providerSessionId: "provider-goal-session",
      goal: { objective: "Keep verifying", status: "active" },
    };
    const onGoalCheckpoint = vi.fn(async () => undefined);
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      await options.onCheckpoint(goalCheckpoint);
      expect(onGoalCheckpoint).toHaveBeenCalledWith(goalCheckpoint);
      return {
        result: { summary: "goal paused" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "provider-turn-1",
        normalizedSessionId: "session",
        providerSessionId: goalCheckpoint.providerSessionId,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
    await expect(
      executePaperclipNativeSession({
        db: leaseDb(),
        execution,
        runnerInstanceId: "runner",
        onGoalCheckpoint,
      }),
    ).resolves.toMatchObject({ sessionId: "session" });
    expect(onGoalCheckpoint).toHaveBeenCalledOnce();
  });

  it.each(["environment deletion", "controller restart"])("closes an idle warm session before %s", async (shutdownKind) => {
    const close = vi.fn(async () => undefined);
    const warmExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-warm-environment-delete",
        executionWorkspaceId: "workspace-warm-environment-delete",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-warm-environment-delete",
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      },
    } as NativeExecutionInputV1;
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      await options.onSession?.({ close });
      await expect(closeWarmNativeSessionsForEnvironment({
        environmentId: "environment-warm-delete",
        reason: "environment deleted",
      })).resolves.toMatchObject({ busy: 1 });
      expect(close).not.toHaveBeenCalled();
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn-warm-environment-delete",
        normalizedSessionId: warmExecution.session.normalizedSessionId,
        providerSessionId: "provider-warm-environment-delete",
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
        usage: null,
      };
    });

    await executePaperclipNativeSession({
      db: leaseDb(warmExecution),
      execution: warmExecution,
      runnerInstanceId: "runner-warm-environment-delete",
      runnerExecutionTarget: {
        kind: "remote",
        transport: "sandbox",
        environmentId: "environment-warm-delete",
        remoteCwd: "/tmp/warm-environment-delete",
      },
    });

    await expect(
      closeWarmNativeSessionsForEnvironment({
        environmentId: "other-environment",
        reason: "environment deleted",
      }),
    ).resolves.toEqual({ closed: 0, busy: 0, failed: 0 });
    const closeResult = shutdownKind === "controller restart"
      ? closeIdleWarmNativeSessionsForRestart()
      : closeWarmNativeSessionsForEnvironment({
        environmentId: "environment-warm-delete",
        reason: "environment deleted",
      });
    await expect(closeResult).resolves.toMatchObject({ closed: 1, failed: 0 });
    expect(close).toHaveBeenCalledExactlyOnceWith({
      reason: shutdownKind === "controller restart" ? "controller restart" : "environment deleted",
    });
  });

  it.each(["checkpoint first", "turn first"])("serializes restart checkpoint and turn admission: %s", async (order) => {
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-close-race-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = stateBase;
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const close = vi.fn(() => closing);
    try {
      const first = {
        ...execution,
        binding: {
          ...execution.binding,
          runId: "run-close-race-first",
          executionWorkspaceId: "workspace-close-race",
        },
        session: {
          ...execution.session,
          normalizedSessionId: "session-close-race",
          lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
        },
      } as NativeExecutionInputV1;
      const result = {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn-close-race",
        normalizedSessionId: first.session.normalizedSessionId,
        providerSessionId: "provider-close-race",
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
        usage: null,
      };
      state.execute.mockReset().mockImplementationOnce(async (options) => {
        await options.onSession?.({ close });
        return result;
      });
      await executePaperclipNativeSession({
        db: leaseDb(first), execution: first,
        runnerInstanceId: "runner-close-race", useRunnerd: true,
      });
      const second = { ...first, binding: { ...first.binding, runId: "run-close-race-second" } };
      const reachedAdmission = new Error("test reached post-checkpoint admission");
      state.stageNativeRunnerWakeAttachments.mockClear();
      state.stageNativeRunnerWakeAttachments.mockImplementationOnce(async () => {
        if (order === "turn first") {
          await expect(closeIdleWarmNativeSessionsForRestart()).resolves.toMatchObject({ closed: 0, busy: 1 });
          expect(close).not.toHaveBeenCalled();
        }
        throw reachedAdmission;
      });
      const shutdown = order === "checkpoint first" ? closeIdleWarmNativeSessionsForRestart() : undefined;
      if (shutdown) await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      const continuation = executePaperclipNativeSession({
        db: leaseDb(second), execution: second,
        runnerInstanceId: "runner-close-race", useRunnerd: true,
      }).catch((error) => error);
      try {
        if (order === "checkpoint first") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(state.stageNativeRunnerWakeAttachments).not.toHaveBeenCalled();
        } else {
          expect(await continuation).toBe(reachedAdmission);
        }
        expect(state.execute).toHaveBeenCalledOnce();
      } finally {
        finishClose();
        await shutdown;
        expect(await continuation).toBe(reachedAdmission);
      }
      expect(state.stageNativeRunnerWakeAttachments).toHaveBeenCalledOnce();
    } finally {
      finishClose();
      await closeIdleWarmNativeSessionsForRestart();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([false, true])("checkpoints a busy warm session on release after the restart sweep: checkpoint fails=%s", async (checkpointFails) => {
    const checkpointError = new Error("restart checkpoint failed");
    let finishCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve, reject) => {
      finishCheckpoint = checkpointFails ? () => reject(checkpointError) : resolve;
    });
    const close = vi.fn(async () => checkpoint);
    const warmExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-warm-restart-release",
        executionWorkspaceId: "workspace-warm-restart-release",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-warm-restart-release",
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      },
    } as NativeExecutionInputV1;
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      await options.onSession?.({ close });
      await expect(closeIdleWarmNativeSessionsForRestart()).resolves.toMatchObject({ busy: 1 });
      expect(close).not.toHaveBeenCalled();
      // The active turn can finish after the shutdown sweep has passed it.
      return {
        result: { summary: "completed during shutdown" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn-warm-restart-release",
        normalizedSessionId: warmExecution.session.normalizedSessionId,
        providerSessionId: "provider-warm-restart-release",
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
        usage: null,
      };
    });
    let settled = false;
    const running = executePaperclipNativeSession({
      db: leaseDb(warmExecution),
      execution: warmExecution,
      runnerInstanceId: "runner-warm-restart-release",
    }).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith({ reason: "controller restart" }));
      expect(settled).toBe(false);
    } finally {
      finishCheckpoint();
      if (checkpointFails) await expect(running).rejects.toBe(checkpointError);
      else await running;
    }
    await expect(closeIdleWarmNativeSessionsForRestart()).resolves.toEqual({ closed: 0, busy: 0, failed: 0 });
  });

  it("preserves the active turn when a warm checkpoint resumes the same run", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-warm-same-run-recovery-"),
    );
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = stateBase;
    const activeRun = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-warm-same-run-recovery",
        executionWorkspaceId: "workspace-warm-same-run-recovery",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-warm-same-run-recovery",
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const checkpoint = {
      identity: {
        runId: activeRun.binding.runId,
        sessionId: activeRun.session.normalizedSessionId,
        companyId: activeRun.binding.companyId,
        issueId: activeRun.binding.issueId,
        agentId: activeRun.binding.agentId,
      },
      sessionId: activeRun.session.normalizedSessionId,
      driverSessionId: "driver-warm-same-run-recovery",
      providerSessionId: "provider-warm-same-run-recovery",
      activeTurnId: "provider-turn-warm-same-run-recovery",
      semanticResult: null,
      terminal: null,
      terminalTurns: [],
      pendingRuntimeRequests: [],
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: checkpoint.activeTurnId,
      normalizedSessionId: activeRun.session.normalizedSessionId,
      providerSessionId: checkpoint.providerSessionId,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    const firstClose = vi.fn(async () => undefined);
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        await options.onCheckpoint?.(checkpoint);
        options.onSession?.({ close: firstClose });
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.persistedSession).toEqual(
          expect.objectContaining({
            identity: checkpoint.identity,
            driverSessionId: checkpoint.driverSessionId,
            providerSessionId: checkpoint.providerSessionId,
            activeTurnId: checkpoint.activeTurnId,
          }),
        );
        return result;
      });

    try {
      await executePaperclipNativeSession({
        db: leaseDb(activeRun),
        execution: activeRun,
        runnerInstanceId: "runner-warm-same-run-recovery",
      });
      await vi.waitFor(() => expect(firstClose).toHaveBeenCalled(), {
        timeout: 500,
      });
      await expect(
        executePaperclipNativeSession({
          db: leaseDb(activeRun),
          execution: activeRun,
          runnerInstanceId: "runner-warm-same-run-recovery",
        }),
      ).resolves.toBeDefined();
    } finally {
      if (previousPaperclipHome === undefined) {
        delete process.env.PAPERCLIP_HOME;
      } else {
        process.env.PAPERCLIP_HOME = previousPaperclipHome;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("reuses one session across distinct governed runs and closes it after idle expiry", async () => {
    const close = vi.fn(async () => undefined);
    const sharedSession = { close };
    const base = {
      ...execution,
      binding: {
        ...execution.binding,
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "session-warm-native",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 1_000 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...base,
      binding: { ...base.binding, runId: "run-native-warm-second" },
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session-warm-native",
      providerSessionId: "provider-warm-native",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(sharedSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBe(sharedSession);
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(base),
      execution: base,
      runnerInstanceId: "runner",
    });
    await executePaperclipNativeSession({
      db: leaseDb(second),
      execution: second,
      runnerInstanceId: "runner",
    });
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(
      () =>
        expect(close).toHaveBeenCalledWith({
          reason: "warm native session idle timeout",
        }),
      { timeout: 2_000 },
    );
  });

  it("does not offer a quarantined warm session to the next run", async () => {
    const close = vi.fn(async () => undefined);
    const quarantinedSession = { close };
    const first = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-native-warm-quarantined-first",
        executionWorkspaceId: "workspace-native-warm-quarantined",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-native-warm-quarantined",
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...first,
      binding: {
        ...first.binding,
        runId: "run-native-warm-quarantined-second",
      },
    } as NativeExecutionInputV1;
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: first.session.normalizedSessionId,
      providerSessionId: "provider-native-warm-quarantined",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(quarantinedSession);
        options.onSession?.(null);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(first),
      execution: first,
      runnerInstanceId: "runner-native-warm-quarantined",
    });
    await executePaperclipNativeSession({
      db: leaseDb(second),
      execution: second,
      runnerInstanceId: "runner-native-warm-quarantined",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it.each(
    [
      ...[false, true].flatMap((local) => [true, false].map(brokerReady => ({
        firstBroker: true, secondBroker: true, projectless: false, local, brokerReady,
        firstMode: "managed", secondMode: "managed", managedGitHub: true,
      }))),
      ...[
        { firstBroker: false, secondBroker: false },
        { firstBroker: false, secondBroker: true },
        { firstBroker: true, secondBroker: true },
        { firstBroker: true, secondBroker: false },
      ].flatMap((transition) =>
        [false, true].flatMap((projectless) =>
          [false, true].map((local) => ({
            ...transition,
            projectless,
            local,
            firstMode: "host",
            secondMode: "host",
          })),
        ),
      ),
      ...["host", "managed"].flatMap((firstMode) =>
        [false, true].map((local) => ({
          firstBroker: false,
          secondBroker: false,
          projectless: false,
          local,
          firstMode,
          secondMode: firstMode === "host" ? "managed" : "host",
        })),
      ),
      ...[false, true].flatMap((local) => [
        {
          firstBroker: false,
          secondBroker: false,
          projectless: false,
          local,
          firstMode: "host",
          secondMode: "host",
          firstNetwork: "enabled",
          secondNetwork: "disabled",
        },
        {
          firstBroker: false,
          secondBroker: false,
          projectless: false,
          local,
          firstMode: "managed",
          secondMode: "managed",
          firstNetwork: "disabled",
          secondNetwork: "enabled",
        },
      ]),
      ...[false, true].flatMap((local) =>
        ["missing", "wrong_target"].map((checkpointContract) => ({
          firstBroker: false,
          secondBroker: true,
          projectless: true,
          local,
          firstMode: "host",
          secondMode: "host",
          checkpointContract,
        })),
      ),
    ].map((scenario) => ({
      firstNetwork: "disabled",
      secondNetwork: "disabled",
      checkpointContract: "valid",
      managedGitHub: false,
      brokerReady: true,
      ...scenario,
    })),
  )(
    "verifies a live warm owner before refreshing run authority (broker: $firstBroker -> $secondBroker, projectless: $projectless, local: $local, auth: $firstMode -> $secondMode, network: $firstNetwork -> $secondNetwork, checkpoint: $checkpointContract, managed access: $managedGitHub, broker ready: $brokerReady)",
    async ({
      firstBroker,
      secondBroker,
      projectless,
      local,
      firstMode,
      secondMode,
      firstNetwork,
      secondNetwork,
      checkpointContract,
      managedGitHub,
      brokerReady,
    }) => {
      githubAccess.create.mockReset().mockResolvedValue({
        env: { PAPERCLIP_GITHUB_BROKER_TOKEN: "stable-session-capability" },
        ready: brokerReady,
        activate: githubAccess.activate.mockReset().mockImplementation(() => vi.fn()),
        stop: githubAccess.stop.mockReset().mockResolvedValue(undefined),
      });
      const replacesProvider =
        !brokerReady ||
        (!managedGitHub && (firstBroker || secondBroker)) ||
        firstMode !== secondMode ||
        firstNetwork !== secondNetwork;
      const stateBase = await mkdtemp(
        join(tmpdir(), "paperclip-runnerd-warm-authority-"),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      const previousPaperclipHome = process.env.PAPERCLIP_HOME;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      process.env.PAPERCLIP_HOME = stateBase;
      const firstClose = vi.fn(async () => undefined);
      const firstSession = { close: firstClose };
      const first = {
        ...execution,
        binding: {
          ...execution.binding,
          runId: "run-runnerd-warm-first",
          executionWorkspaceId: projectless
            ? "run-runnerd-warm-first"
            : "workspace-runnerd-warm",
        },
        workspace: {
          cwd: "/tmp/runnerd-warm-authority",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: "session-runnerd-warm-authority",
          driverKind: "codex_app_server" as const,
          protocolVersion: 1 as const,
          lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 500 },
        },
      } as NativeExecutionInputV1;
      const second = {
        ...first,
        binding: {
          ...first.binding,
          runId: "run-runnerd-warm-second",
          executionWorkspaceId: projectless
            ? "run-runnerd-warm-second"
            : first.binding.executionWorkspaceId,
        },
      } as NativeExecutionInputV1;
      const remoteTarget = (
        local
          ? {
              kind: "local" as const,
              environmentId: "environment-runnerd-warm-authority",
            }
          : {
              kind: "remote" as const,
              transport: "sandbox" as const,
              environmentId: "environment-runnerd-warm-authority",
              remoteCwd: "/home/daytona/paperclip-workspace",
              runner: { execute: vi.fn() },
            }
      ) as never;
      const result = {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: first.session.normalizedSessionId,
        providerSessionId: "provider-runnerd-warm",
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
        usage: null,
      };
      state.execute
        .mockReset()
        .mockImplementationOnce(async (options) => {
          expect(options.existingSession).toBeUndefined();
          await options.onCheckpoint?.({
            identity: {
              runId: first.binding.runId,
              sessionId: first.session.normalizedSessionId,
              companyId: first.binding.companyId,
              issueId: first.binding.issueId,
              agentId: first.binding.agentId,
            },
            providerSessionId: "provider-runnerd-warm",
            activeTurnId: "provider-turn-runnerd-warm-first",
            semanticResult: { summary: "Only the previous run's result" },
            terminal: { runTerminalState: "succeeded" },
          });
          options.onSession?.(firstSession);
          return result;
        })
        .mockImplementationOnce(async (options) => {
          if (replacesProvider) {
            expect(options.existingSession).toBeUndefined();
            if (checkpointContract === "valid") {
              expect(options.persistedSession?.providerSessionId).toBe(
                "provider-runnerd-warm",
              );
              expect(options.persistedSession?.semanticResult).toBeNull();
              expect(options.persistedSession?.terminal).toBeNull();
              expect(options.persistedSession?.activeTurnId).toBeNull();
            } else {
              // Legacy workspace compatibility cannot manufacture proof of
              // the current tool contract or move proof across local/remote.
              // A rejected persisted checkpoint is explicitly null, unlike
              // the undefined value when a live owner is reused without a load.
              expect(options.persistedSession).toBeNull();
            }
          } else if (!managedGitHub) {
            expect(options.existingSession).toBe(firstSession);
            expect(options.persistedSession).toBeUndefined();
          }
          return result;
        });

      try {
        await executePaperclipNativeSession({
          db: leaseDb(first),
          execution: first,
          runnerEnvironment: {
            PAPERCLIP_GITHUB_AUTH_MODE: firstMode,
            PAPERCLIP_RUNNER_NETWORK_ACCESS: firstNetwork,
            ...(firstBroker
              ? { PAPERCLIP_GITHUB_BROKER_TOKEN: "first-run-capability" }
              : {}),
          },
          runnerInstanceId: "runner-runnerd-warm",
          useRunnerd: true,
          managedGitHub,
          runnerExecutionTarget: remoteTarget,
        });
        if (projectless && replacesProvider) {
          // Also prove an upgrade can resume the old per-run workspace digest
          // without importing the previous heartbeat's result or turn authority.
          const checkpointFile = (
            await readdir(stateBase, { recursive: true })
          ).find(
            (path) =>
              path.includes("paperclip-runner/sessions/") &&
              path.endsWith(".json"),
          );
          expect(checkpointFile).toBeDefined();
          const checkpointPath = join(stateBase, checkpointFile!);
          const envelope = JSON.parse(await readFile(checkpointPath, "utf8"));
          envelope.configDigest = `sha256:${createHash("sha256")
            .update(
              JSON.stringify({
                companyId: first.binding.companyId,
                normalizedSessionId: first.session.normalizedSessionId,
                executionLocation: {
                  executionKind: "local_process",
                  workspaceId: first.binding.executionWorkspaceId,
                  cwd: first.workspace.cwd,
                },
                provider: first.provider,
                driverKind: first.session.driverKind,
                lifecyclePolicy: first.session.lifecyclePolicy,
                workMode: first.task.workMode,
                executionMode: "default",
                runtimeContextDigest: null,
                nativeToolContractFingerprint:
                  checkpointContract === "missing"
                    ? undefined
                    : nativeToolContractFingerprintForTarget(
                        (checkpointContract === "wrong_target" ? !local : local)
                          ? "local"
                          : "remote",
                      ),
                runtimeContract: nativeSessionResume.nativeRuntimeContractForProvider(first.provider),
              }),
            )
            .digest("hex")}`;
          await writeFile(checkpointPath, JSON.stringify(envelope));
        }
        const scopedRoots = (await readdir(stateBase, { withFileTypes: true }))
          .filter(
            (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
          )
          .map((entry) => join(stateBase, entry.name));
        expect(scopedRoots).toHaveLength(1);
        const durableRoot = scopedRoots[0]!;
        const durableIdentity = {
          runId: first.binding.runId,
          normalizedSessionId: first.session.normalizedSessionId,
          runnerInstanceId: "runner-runnerd-warm",
          environmentLeaseId: first.binding.executionWorkspaceId,
        };
        await mkdir(join(durableRoot, "control-plane"), { recursive: true });
        await writeFile(
          join(durableRoot, "control-plane", "control-plane-state.json"),
          JSON.stringify(durableControlPlaneState(durableIdentity)),
        );
        await mkdir(join(durableRoot, "runner"), { recursive: true });
        await writeFile(
          join(durableRoot, "runner", "runner-state.json"),
          JSON.stringify(durableRunnerState(durableIdentity, "ready")),
        );
        const continuationDb = {
          ...leaseDb(second),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      status: "succeeded",
                      runnerProfileJson: { nativeExecutionInput: first },
                    },
                  ]),
              }),
            }),
          }),
        } as unknown as Db;
        await executePaperclipNativeSession({
          db: continuationDb,
          execution: second,
          runnerEnvironment: {
            PAPERCLIP_GITHUB_AUTH_MODE: secondMode,
            PAPERCLIP_RUNNER_NETWORK_ACCESS: secondNetwork,
            ...(secondBroker
              ? { PAPERCLIP_GITHUB_BROKER_TOKEN: "second-run-capability" }
              : {}),
          },
          runnerInstanceId: "runner-runnerd-warm",
          useRunnerd: true,
          managedGitHub,
          runnerExecutionTarget: remoteTarget,
        });
        if (managedGitHub) {
          expect(state.execute.mock.calls[1]?.[0].existingSession).toBe(brokerReady ? firstSession : undefined);
          expect(githubAccess.create).toHaveBeenCalledTimes(brokerReady ? 1 : 2);
          expect(githubAccess.activate.mock.calls.map(([binding]) => binding.runId))
            .toEqual([first.binding.runId, second.binding.runId]);
          // Replacement fixture publishes no new provider handle: both the old
          // owner and the unclaimed replacement broker must be cleaned up.
          expect(githubAccess.stop).toHaveBeenCalledTimes(brokerReady ? 0 : 2);
          for (const activation of githubAccess.activate.mock.results) {
            expect(activation.value).toHaveBeenCalledOnce();
          }
        }
        if (replacesProvider) {
          expect(firstClose).toHaveBeenCalledOnce();
          expect(firstClose).toHaveBeenCalledWith({
            reason: "warm native session configuration changed",
          });
        } else {
          expect(firstClose).not.toHaveBeenCalled();
          await vi.waitFor(
            () =>
              expect(firstClose).toHaveBeenCalledWith({
                reason: "warm native session idle timeout",
              }),
            {
              timeout: 1_500,
            },
          );
          if (managedGitHub) expect(githubAccess.stop).toHaveBeenCalledOnce();
        }
      } finally {
        if (previousStateDirectory === undefined) {
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        } else {
          process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        }
        if (previousPaperclipHome === undefined) {
          delete process.env.PAPERCLIP_HOME;
        } else {
          process.env.PAPERCLIP_HOME = previousPaperclipHome;
        }
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it("does not replace a different company's warm session with the same normalized id", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const base = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-warm-first",
        runId: "run-warm-first",
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native-company-isolation",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "shared-company-warm-session",
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...base,
      binding: {
        ...base.binding,
        companyId: "company-warm-second",
        runId: "run-warm-second",
      },
    };
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "shared-company-warm-session",
      providerSessionId: "provider-warm-native",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.({ close: firstClose });
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.({ close: secondClose });
        return result;
      });

    await executePaperclipNativeSession({
      db: leaseDb(base),
      execution: base,
      runnerInstanceId: "runner-first",
    });
    await executePaperclipNativeSession({
      db: leaseDb(second),
      execution: second,
      runnerInstanceId: "runner-second",
    });
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalled(), {
      timeout: 500,
    });
    await vi.waitFor(() => expect(secondClose).toHaveBeenCalled(), {
      timeout: 500,
    });
    expect(firstClose).toHaveBeenCalledWith({
      reason: "warm native session idle timeout",
    });
    expect(secondClose).toHaveBeenCalledWith({
      reason: "warm native session idle timeout",
    });
  });

  it.each(["permission", "managed credential", "ACPX runtime contract", "unchanged Codex runtime contract"])("checks warm owner compatibility for %s", async (change) => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstSession = { close: firstClose };
    const secondSession = { close: secondClose };
    const base = {
      ...execution,
      schema: "paperclip.native-execution-input.v4",
      provider: change === "ACPX runtime contract"
        ? { kind: "acpx", agent: "claude", model: "claude-sonnet-5", permissionMode: "approve-all" }
        : { kind: "codex", model: null, approvalPolicy: "never" },
      binding: {
        ...execution.binding,
        runId: "run-permission-never",
        executionWorkspaceId: "workspace",
      },
      workspace: {
        cwd: "/tmp/warm-native-permission",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "session-warm-permission",
        driverKind: change === "ACPX runtime contract" ? "acpx_runtime" as const : "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
      runtimeContext: { aggregateDigest: "runtime-context" },
    } as unknown as NativeExecutionInputV1;
    const lowered = {
      ...base,
      provider: change === "permission" ? { kind: "codex", model: null, approvalPolicy: "on-request" } : base.provider,
      binding: { ...base.binding, runId: "run-permission-on-request" },
    } as NativeExecutionInputV1;
    const result = {
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session-warm-permission",
      providerSessionId: "provider-warm-permission",
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    };
    const runtimeChange = change === "ACPX runtime contract" || change === "unchanged Codex runtime contract";
    const keepsOwner = change === "unchanged Codex runtime contract";
    const currentRuntimeContract = nativeSessionResume.nativeRuntimeContractForProvider(base.provider);
    const contract = runtimeChange
      ? vi.spyOn(nativeSessionResume, "nativeRuntimeContractForProvider").mockReturnValue(undefined)
      : undefined;
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(firstSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBe(keepsOwner ? firstSession : undefined);
        if (!keepsOwner) options.onSession?.(secondSession);
        return result;
      });

    // Filesystem work between calls can exceed the idle window on a busy host.
    // Advance that window only after proving the permission change closed it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await executePaperclipNativeSession({
        db: leaseDb(base),
        execution: base,
        managedAiCredentialIdentity: "first-identity",
        runnerInstanceId: "runner",
      });
      contract?.mockReturnValue(currentRuntimeContract);
      await executePaperclipNativeSession({
        db: leaseDb(lowered),
        execution: lowered,
        managedAiCredentialIdentity: change === "managed credential" ? "second-identity" : "first-identity",
        runnerInstanceId: "runner",
      });
      if (keepsOwner) expect(firstClose).not.toHaveBeenCalled();
      else expect(firstClose).toHaveBeenCalledWith({ reason: "warm native session configuration changed" });
      expect(secondClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(keepsOwner ? firstClose : secondClose).toHaveBeenCalledWith({
        reason: "warm native session idle timeout",
      });
    } finally {
      contract?.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("native session bounded recovery", () => {
  it("blocks a denied Cursor task and gives recovery to the operator without another provider attempt", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const failure = new NativePermissionDeclinedError();
    state.execute.mockReset().mockRejectedValueOnce(failure);
    state.upsertRecoveryAction.mockReset().mockResolvedValue({});
    const updateIssue = vi.fn(async () => ({ status: "blocked", statusVersion: 7 }));
    const service = vi.spyOn(issueServiceModule, "issueService").mockReturnValue({ update: updateIssue } as unknown as ReturnType<typeof issueServiceModule.issueService>);
    try {
    await expect(executePaperclipNativeSession({ db: leaseDb(execution, {}, {}, updates), execution, runnerInstanceId: "runner" })).rejects.toBe(failure);
    expect(updates.find(update => update.table === nativeRunFinalizations && update.values.phase === "terminal_failure")?.values).toMatchObject({
      failureCode: "native_permission_declined", nextAttemptAt: null,
      failureDetail: { recoverable: false, nextAction: expect.stringContaining("Automatic recovery is stopped") },
    });
    expect(updateIssue).toHaveBeenCalledWith(execution.binding.issueId, { status: "blocked" }, expect.anything());
    expect(state.upsertRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({ cause: "native_permission_declined", ownerType: "board", wakePolicy: null }));
    expect(state.execute).toHaveBeenCalledTimes(1);
    } finally { service.mockRestore(); }
  });
  it.each([["operator", "missing-result"], ["reassignment", "missing-result"], ["operator", "permission-declined"], ["reassignment", "permission-declined"]])("does not turn an acknowledged %s Stop before %s completion into a failure or a retry", async (source, failureKind) => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const stop: Record<string, unknown> = {};
    state.execute.mockReset().mockImplementationOnce(async () => {
      Object.assign(stop, { ...(source === "operator"
        ? { cancelledByActorType: "user", cancelledByUserId: "board" }
        : { reassignmentStopRequested: true }), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", ...execution.binding, scope: "run", reasonCode: "cancellation_run_only",
        dispatched: true, dispatchState: "acknowledged", intentAuditId: "intent", acknowledgementAuditId: "ack",
      } });
      throw failureKind === "permission-declined" ? new NativePermissionDeclinedError() : new Error("native_finalization_missing: session returned no semantic result");
    });
    state.upsertRecoveryAction.mockClear();
    await expect(executePaperclipNativeSession({
      db: leaseDb(execution, {}, stop, updates), execution, runnerInstanceId: "stop-before-completion",
    })).rejects.toThrow("native_cancellation_pending_recovery");
    expect(updates.some(update => update.table === heartbeatRuns && update.values.status === "failed")).toBe(false);
    expect(updates.some(update => update.table === nativeRunFinalizations && update.values.failureCode === "native_retry_cancelled")).toBe(true);
    expect(state.upsertRecoveryAction).not.toHaveBeenCalled();
  });

  it.each(["pending", "acknowledged"])("preserves a %s Stop when cancellation wins before the first turn", async (dispatchState) => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const stop: Record<string, unknown> = {};
    state.execute.mockReset().mockImplementationOnce(async () => {
      Object.assign(stop, { nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", ...execution.binding,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState,
        dispatched: true, intentAuditId: "intent", acknowledgementAuditId: "ack",
      } });
      throw new Error("native_session_cancelled");
    });
    state.upsertRecoveryAction.mockClear();
    await expect(executePaperclipNativeSession({
      db: leaseDb(execution, {}, stop, updates), execution, runnerInstanceId: "stop-before-first-turn",
    })).rejects.toThrow("native_cancellation_pending_recovery");
    expect(updates.some(update => update.table === heartbeatRuns && update.values.status === "failed")).toBe(false);
    expect(state.upsertRecoveryAction).not.toHaveBeenCalled();
  });

  it("keeps typed integrity failure permanent even if a wrapper changes its message", () => {
    const failure = new NativeSessionProtocolIntegrityError(
      "semantic_input_digest_mismatch",
    );
    failure.message = "provider_transport_failed: later cleanup failed";
    const code = nativeSessionFailureSourceCode(failure);
    expect(code).toBe("native_event_replay_conflict");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure",
      failureCode: code,
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureSourceCode(
        Object.assign(new Error("ordinary disconnect"), {
          code: failure.code,
          recovery: failure.recovery,
        }),
      ),
    ).toBe("native_session_interrupted");
  });

  it.each([
    { checkpointExists: false, ancillaryFailure: null },
    { checkpointExists: true, ancillaryFailure: null },
    { checkpointExists: false, ancillaryFailure: "log" },
    { checkpointExists: true, ancillaryFailure: "log" },
    { checkpointExists: false, ancillaryFailure: "recovery_write" },
    { checkpointExists: true, ancillaryFailure: "recovery_write" },
  ] as const)(
    "preserves integrity failure without retrying the provider (%j)",
    async ({ checkpointExists, ancillaryFailure }) => {
      const updates: Array<{
        table: unknown;
        values: Record<string, unknown>;
      }> = [];
      const failure = new NativeSessionProtocolIntegrityError(
        "semantic_input_digest_mismatch",
      );
      state.execute.mockReset().mockRejectedValueOnce(failure);
      state.upsertRecoveryAction.mockReset().mockResolvedValue({});
      const secondaryFailure = new Error(
        "temporary diagnostic storage failure",
      );
      const onLog = vi.fn(async (_stream: string, chunk: string) => {
        if (
          ancillaryFailure === "log" &&
          chunk.includes("native session execution failed:")
        ) {
          throw secondaryFailure;
        }
      });
      const db = leaseDb(
        execution,
        {},
        {},
        updates,
        checkpointExists
          ? {
              sessionCheckpoint: {
                providerSessionId: "provider-existing",
              },
            }
          : {},
      );
      const transact = db.transaction.bind(db);
      const recoveryWriteAttempt = vi.fn();
      db.transaction = (async (operation) => {
        if (state.execute.mock.calls.length > 0) {
          recoveryWriteAttempt();
          if (ancillaryFailure === "recovery_write") throw secondaryFailure;
        }
        return transact(operation);
      }) as typeof db.transaction;
      const updateIssue = vi.fn(async () => null);
      const service = vi
        .spyOn(issueServiceModule, "issueService")
        .mockReturnValue({ update: updateIssue } as unknown as ReturnType<
          typeof issueServiceModule.issueService
        >);
      try {
        await expect(
          executePaperclipNativeSession({
            db,
            execution,
            runnerInstanceId: "runner",
            onLog,
          }),
        ).rejects.toBe(failure);
        expect(recoveryWriteAttempt).toHaveBeenCalledOnce();
        expect(state.execute).toHaveBeenCalledOnce();
        if (ancillaryFailure === "recovery_write") {
          // The failed transaction cannot manufacture a persisted recovery or
          // change task state, but its error must not permit a provider retry.
          expect(
            updates.some((entry) => entry.values.phase === "terminal_failure"),
          ).toBe(false);
          expect(state.upsertRecoveryAction).not.toHaveBeenCalled();
          expect(updateIssue).not.toHaveBeenCalled();
          expect(
            nativeSessionFailureDisposition(
              1,
              new Date(),
              nativeSessionFailureSourceCode(failure),
            ),
          ).toMatchObject({
            phase: "terminal_failure",
            nextAttemptAt: null,
          });
          return;
        }
        expect(
          updates.find(
            (entry) =>
              entry.table === nativeRunFinalizations &&
              entry.values.phase === "terminal_failure",
          )?.values,
        ).toMatchObject({
          failureCode: "native_event_replay_conflict",
          nextAttemptAt: null,
          failureDetail: {
            originalFailureCode: "native_event_replay_conflict",
            recoveryMode: checkpointExists
              ? "exact_checkpoint_resume"
              : "ambiguous_state",
            nextAction: expect.stringContaining(
              checkpointExists
                ? "automatic recovery is stopped"
                : "replacement provider session is forbidden",
            ),
          },
        });
        expect(state.upsertRecoveryAction).toHaveBeenCalledWith(
          expect.objectContaining({
            cause: "native_event_replay_conflict",
            ownerType: "board",
            wakePolicy: null,
          }),
        );
        expect(updateIssue).toHaveBeenCalledWith(
          execution.binding.issueId,
          { status: "blocked" },
          expect.anything(),
        );
      } finally {
        service.mockRestore();
      }
    },
  );

  it("makes only typed operator-required cleanup quarantine terminal on the first attempt", () => {
    const code = nativeSessionFailureSourceCode(
      new NativeSessionCleanupQuarantinedError(),
    );
    expect(code).toBe("native_session_cleanup_quarantined");
    const disposition = nativeSessionFailureDisposition(1, new Date(), code);
    expect(disposition).toEqual({
      phase: "terminal_failure",
      failureCode: code,
      nextAttemptAt: null,
    });
    expect(
      nativeSessionRecoveryProjection({ ...disposition, agentId: "agent" }),
    ).toMatchObject({
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerAgentId: null,
    });
  });

  it.each([
    new Error(
      "native_session_cleanup_quarantined: prior session cleanup exceeded the admission grace",
    ),
    new Error(
      "native_session_cleanup_quarantined: prior session cleanup remains incomplete",
    ),
    Object.assign(new Error("cleanup still running"), {
      code: "native_session_cleanup_quarantined",
      recovery: "operator_required",
    }),
  ])("keeps untyped cleanup failure retryable (%s)", (error) => {
    const code = nativeSessionFailureSourceCode(error);
    expect(code).toBe("native_session_interrupted");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toMatchObject({
      phase: "retryable_failure",
      nextAttemptAt: expect.any(Date),
    });
  });

  it.each(["full", "truncated"])("redacts %s identity from native failure writes, logs, and rethrown errors", async (mode) => {
    const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyBody = privateKeyPem.split("\n")[1];
    const failure = new Error(`native provider failed: ${mode === "full" ? privateKeyPem : privateKeyPem.slice(0, 64)}`);
    void failure.stack; // Also cover stacks materialized before the catch boundary.
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const logs: string[] = [];
    state.execute.mockReset().mockRejectedValueOnce(failure);
    state.upsertRecoveryAction.mockReset().mockResolvedValue({});
    const service = vi.spyOn(issueServiceModule, "issueService").mockReturnValue({
      update: vi.fn(async () => ({ status: "blocked", statusVersion: 1 })),
    } as unknown as ReturnType<typeof issueServiceModule.issueService>);
    try {
      await expect(executePaperclipNativeSession({
        db: leaseDb(execution, {}, {}, updates), execution, runnerInstanceId: "runner",
        runnerEnvironment: { PAPERCLIP_AGENT_PRIVATE_KEY: privateKeyPem },
        onLog: async (_stream, text) => { logs.push(text); },
      })).rejects.toBe(failure);
      expect(updates.some(entry => entry.table === nativeRunFinalizations && entry.values.failureDetail)).toBe(true);
      for (const output of [inspect(updates.map(entry => entry.values), { depth: null }), logs.join(""), failure.message, failure.stack!]) {
        expect(output).not.toContain(keyBody.slice(0, 24));
        expect(output).toContain("***REDACTED***");
      }
    } finally {
      service.mockRestore();
    }
  });

  it("persists actionable operator recovery without an automatic cleanup wake", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const failure = new NativeSessionCleanupQuarantinedError();
    state.execute.mockReset().mockRejectedValueOnce(failure);
    state.upsertRecoveryAction.mockReset().mockResolvedValue({});
    const updateIssue = vi.fn(async () => ({ status: "blocked", statusVersion: 7 }));
    const service = vi
      .spyOn(issueServiceModule, "issueService")
      .mockReturnValue({ update: updateIssue } as unknown as ReturnType<
        typeof issueServiceModule.issueService
      >);
    try {
      await expect(
        executePaperclipNativeSession({
          db: leaseDb(execution, {}, {}, updates),
          execution,
          runnerInstanceId: "runner",
        }),
      ).rejects.toBe(failure);
      expect(
        updates.find(
          (entry) =>
            entry.table === nativeRunFinalizations &&
            entry.values.phase === "terminal_failure",
        )?.values,
      ).toMatchObject({
        failureCode: "native_session_cleanup_quarantined",
        nextAttemptAt: null,
        failureDetail: {
          nextAction: expect.stringContaining(
            "Clearing a task session does not resolve this quarantine",
          ),
        },
      });
      expect(state.upsertRecoveryAction).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: "native_session_cleanup_quarantined",
          evidence: expect.objectContaining({ nativeFailureBlock: { runId: execution.binding.runId, statusVersion: 7 } }),
          ownerType: "board",
          wakePolicy: null,
          nextAction: expect.stringContaining(
            "Clearing a task session does not resolve this quarantine",
          ),
        }),
      );
      expect(updateIssue).toHaveBeenCalledWith(
        execution.binding.issueId,
        { status: "blocked" },
        expect.anything(),
      );
    } finally {
      service.mockRestore();
    }
  });

  it.each(["persisted", "logging_failure", "recovery_write_failure"])(
    "signals an ownership hold instead of terminal teardown after authentication timeout (%s)",
    async (failureMode) => {
      const updates: Array<{
        table: unknown;
        values: Record<string, unknown>;
      }> = [];
      state.execute
        .mockReset()
        .mockRejectedValueOnce(
          new Error(
            "native_adopted_runner_authentication_timeout: retained runner did not authenticate",
          ),
        );
      state.upsertRecoveryAction.mockReset().mockResolvedValue({});
      if (failureMode === "recovery_write_failure") {
        state.upsertRecoveryAction.mockRejectedValueOnce(
          new Error("diagnostic_write_failed"),
        );
      }
      await expect(
        executePaperclipNativeSession({
          db: leaseDb(execution, {}, {}, updates),
          execution,
          runnerInstanceId: "runner",
          ...(failureMode === "logging_failure"
            ? {
                onLog: async () => {
                  throw new Error("log_write_failed");
                },
              }
            : {}),
        }),
      ).rejects.toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
      expect(updates.filter((entry) => entry.table === issues)).toEqual([]);
      if (failureMode !== "logging_failure") {
        expect(
          updates.find(
            (entry) =>
              entry.table === heartbeatRuns &&
              entry.values.errorCode ===
                "native_execution_ownership_unverified",
          )?.values,
        ).toMatchObject({
          nativePhase: "terminal_failure",
          errorCode: "native_execution_ownership_unverified",
        });
        expect(
          updates.find(
            (entry) =>
              entry.table === nativeRunFinalizations &&
              entry.values.phase === "terminal_failure",
          )?.values,
        ).toMatchObject({
          phase: "terminal_failure",
          recoveryState: "blocked",
          nextAttemptAt: null,
        });
        expect(state.upsertRecoveryAction).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerType: "board",
            wakePolicy: null,
          }),
        );
      }
    },
  );

  it("makes unauthenticated adopted runner recovery Board-owned without an automatic retry", () => {
    const code = nativeSessionFailureSourceCode(
      new Error(
        "native_adopted_runner_authentication_timeout: retained runner did not authenticate",
      ),
    );
    expect(code).toBe("native_adopted_runner_authentication_timeout");
    const disposition = nativeSessionFailureDisposition(1, new Date(), code);
    expect(disposition).toEqual({
      phase: "terminal_failure",
      failureCode: "native_adopted_runner_authentication_timeout",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionRecoveryProjection({ ...disposition, agentId: "agent" }),
    ).toMatchObject({
      issueStatus: null,
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerType: "board",
      recoveryActionOwnerAgentId: null,
      recoveryActionCause: "native_adopted_runner_authentication_timeout",
    });
  });

  it("preserves stable provider and runner failure causes", () => {
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_frame_too_large: harness stdout frame exceeded 4194304 bytes",
        ),
      ),
    ).toBe("provider_frame_too_large");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "native_runner_process_exited: runnerd exited unexpectedly with code 1",
        ),
      ),
    ).toBe("native_runner_process_exited");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_transport_failed: invalid JSON-RPC"),
      ),
    ).toBe("provider_transport_failed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "planning_mode_unsupported: installed Codex app-server did not confirm plan mode",
        ),
      ),
    ).toBe("planning_mode_unsupported");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "native_event_replay_conflict: source sequence 41 contained different bytes",
        ),
      ),
    ).toBe("native_event_replay_conflict");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_process_exited: provider=codex stage=initialize exitCode=1",
        ),
      ),
    ).toBe("provider_process_exited");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_stdout_closed: provider=codex stage=initialize"),
      ),
    ).toBe("provider_stdout_closed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_process_status_failed: provider=codex stage=session.open",
        ),
      ),
    ).toBe("provider_process_status_failed");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_initialize_timeout: provider=codex stage=initialize",
        ),
      ),
    ).toBe("provider_initialize_timeout");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "provider_initialize_protocol_error: provider=codex stage=initialize",
        ),
      ),
    ).toBe("provider_initialize_protocol_error");
    expect(
      nativeSessionFailureSourceCode(
        new Error("provider_request_timeout: provider=codex stage=turn.start"),
      ),
    ).toBe("provider_request_timeout");
    expect(
      nativeSessionFailureSourceCode(
        new Error(
          "runner_remote_provider_artifact_incompatible: OpenCode version mismatch",
        ),
      ),
    ).toBe("runner_remote_provider_artifact_incompatible");
    expect(
      nativeSessionFailureSourceCode(
        new Error("native_current_wake_comments_unread"),
      ),
    ).toBe("native_current_wake_comments_unread");
    expect(
      nativeSessionFailureSourceCode(
        new Error("native_current_wake_comments_changed_after_read"),
      ),
    ).toBe("native_current_wake_comments_changed_after_read");
  });

  it.each([
    [{}, [], "bootstrap_retry"],
    [{ uncertain: true }, [], "ambiguous_state"],
    [{}, [{ eventType: "turn.started" }], "ambiguous_state"],
  ])("classifies a platform mismatch without weakening persisted recovery evidence", async (checkpoint, events, mode) => {
    const code = nativeSessionFailureSourceCode(
      new Error("runner_remote_artifact_platform_mismatch: configure the remote binary"),
    );
    expect(code).toBe("runner_remote_artifact_platform_mismatch");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toMatchObject({
      phase: "terminal_failure",
      failureCode: code,
      nextAttemptAt: null,
    });
    let reads = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => ++reads === 1
              ? [{ runnerProfileJson: { sessionCheckpoint: checkpoint } }]
              : events,
          }),
        }),
      }),
    };
    expect(await nativeProviderRecoveryEvidence({
      db: db as never, runId: "run", sourceFailureCode: code,
    })).toMatchObject({ recoveryMode: mode });
  });

  it("requires operator action without retrying an approval-required terminal", () => {
    const code = nativeSessionFailureSourceCode(
      new NativeProviderTerminalFailure("approval_required", false, "Approval required"),
    );
    expect(code).toBe("native_provider_approval_required");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure",
      failureCode: "native_provider_approval_required",
      nextAttemptAt: null,
    });
    expect(nativeSessionRecoveryProjection({
      phase: "terminal_failure", failureCode: code, agentId: "agent-1",
    })).toMatchObject({ issueStatus: "blocked", recoveryOwner: { kind: "board" } });
  });

  it("retries the same run twice and stops at the third failed attempt", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    expect(
      nativeSessionFailureSourceCode(
        new Error("native_provider_model_rejected: unknown model"),
      ),
    ).toBe("native_provider_model_rejected");
    expect(
      nativeSessionFailureDisposition(1, now, "native_provider_model_rejected"),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_provider_model_rejected",
      nextAttemptAt: null,
    });
    expect(nativeSessionFailureDisposition(1, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(2, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(3, now)).toEqual({
      phase: "terminal_failure",
      failureCode: "native_session_retry_exhausted",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureDisposition(1, now, "native_event_replay_conflict"),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_event_replay_conflict",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureDisposition(
        1,
        now,
        "runner_remote_provider_artifact_incompatible",
      ),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "runner_remote_provider_artifact_incompatible",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureDisposition(
        1,
        now,
        "native_current_wake_comments_unread",
      ),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_current_wake_comments_unread",
      nextAttemptAt: null,
    });
    expect(
      nativeSessionFailureDisposition(
        1,
        now,
        "native_current_wake_comments_changed_after_read",
      ),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_current_wake_comments_changed_after_read",
      nextAttemptAt: null,
    });
  });

  it("stops retries only for an authenticated provider usage-limit terminal", () => {
    const event = {
      sourceKind: "runner" as const,
      eventType: "turn.failed" as const,
      payload: {
        status: "failed",
        error: {
          codexErrorInfo: "usageLimitExceeded",
          message: "Private provider account details",
        },
      },
    };
    expect(nativeProviderUsageLimitFromEvent(event)).toBe(true);
    expect(
      nativeProviderUsageLimitFromEvent({
        ...event,
        eventType: "item.completed",
      }),
    ).toBe(false);
    expect(
      nativeProviderUsageLimitFromEvent({
        ...event,
        sourceKind: "control_plane",
      }),
    ).toBe(false);
    expect(
      nativeProviderUsageLimitFromEvent({
        ...event,
        payload: { status: "failed", error: { message: "usageLimitExceeded" } },
      }),
    ).toBe(false);
    expect(
      nativeSessionFailureDisposition(
        1,
        new Date(),
        "native_provider_usage_limit",
      ),
    ).toEqual({
      phase: "terminal_failure",
      failureCode: "native_provider_usage_limit",
      nextAttemptAt: null,
    });
  });

  it("blocks exhausted result-less sessions without manufacturing a human review", () => {
    expect(
      nativeSessionRecoveryProjection({
        phase: "retryable_failure",
        failureCode: "native_session_interrupted",
        agentId: "agent-low-capability",
      }),
    ).toEqual({
      exhausted: false,
      issueStatus: null,
      recoveryOwner: { kind: "agent", agentId: "agent-low-capability" },
      recoveryActionOwnerType: "agent",
      recoveryActionOwnerAgentId: "agent-low-capability",
      recoveryActionCause: "native_session_interrupted",
      supersedeOnIdentityChange: true,
    });
    expect(
      nativeSessionRecoveryProjection({
        phase: "terminal_failure",
        failureCode: "native_session_retry_exhausted",
        agentId: "agent-low-capability",
      }),
    ).toEqual({
      exhausted: true,
      issueStatus: "blocked",
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerType: "board",
      recoveryActionOwnerAgentId: null,
      recoveryActionCause: "native_session_retry_exhausted",
      supersedeOnIdentityChange: true,
    });
  });
});

describe("native process ownership", () => {
  it("checks the complete wake-comment receipt before finalizing a successful provider turn", async () => {
    const expectedBinding = {
      schema: "paperclip.current-wake-comments-binding.v1",
      companyId: execution.binding.companyId,
      issueId: execution.binding.issueId,
      runId: execution.binding.runId,
      agentId: execution.binding.agentId,
      provider: "slack",
      commentIds: ["comment-current-wake-1"],
      attachmentOmissions: [],
      bindingDigest: "current-wake-binding-digest",
    };
    state.resolveCurrentWakeCommentsBinding.mockResolvedValue(expectedBinding);
    state.execute.mockReset().mockResolvedValue({
      result: { summary: "must not become authoritative" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn-current-wake-unread",
      normalizedSessionId: "session-current-wake-unread",
      providerSessionId: null,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    });
    await executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner-current-wake-receipt",
    });
    expect(state.assertCurrentWakeCommentsRead).toHaveBeenCalledWith(
      expect.anything(),
      execution.binding,
      expectedBinding,
    );
  });

  it.each(["cancelled", "succeeded", "interrupted", "timed_out", "failed"])(
    "refuses native provider claims after the run became %s", async status => {
      const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
      state.createBackend.mockClear();
      await expect(executePaperclipNativeSession({
        db: leaseDb(execution, {}, {}, updates, {}, status), execution, runnerInstanceId: "late-startup",
      })).rejects.toThrow();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(updates.some(update => update.table === nativeRunFinalizations)).toBe(false);
      expect(updates.some(update => update.values.eventType === "native.process_start_requested")).toBe(false);
    },
  );

  it("fences a cancellation request before its terminal status commits", async () => {
    state.createBackend.mockClear();
    await expect(executePaperclipNativeSession({
      db: leaseDb(execution, {}, { startupCancellation: { requestedAt: new Date().toISOString() } }),
      execution, runnerInstanceId: "cancel-requested",
    })).rejects.toThrow();
    expect(state.createBackend).not.toHaveBeenCalled();
  });

  it("forwards the app-server PID and process group through the production backend seam", async () => {
    const processMetadata = {
      pid: 42_001,
      processGroupId: 42_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    };
    const onSpawn = vi.fn(async () => undefined);
    state.createBackend.mockClear();
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.onSessionAdmission();
      expect(updates).toContainEqual({ table: heartbeatRunEvents, values: expect.objectContaining({
        eventType: "native.process_start_requested", runId: execution.binding.runId,
      }) });
      await options.backend.onSpawn(processMetadata);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    state.createBackend.mockImplementationOnce((_input, options) => {
      expect(updates.some(update => update.values.eventType === "native.process_start_requested")).toBe(false);
      return { kind: "test", onSpawn: options.onSpawn };
    });

    await executePaperclipNativeSession({
      db: leaseDb(execution, {}, {}, updates),
      execution,
      runnerInstanceId: "runner",
      onSpawn,
    });

    expect(state.createBackend).toHaveBeenCalledWith(
      execution,
      expect.objectContaining({
        runnerInstanceId: "runner",
        onSpawn,
      }),
    );
    expect(onSpawn).toHaveBeenCalledWith(processMetadata);
  });

  it.each([
    [
      "OpenCode",
      {
        kind: "opencode",
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        permissionMode: "deny",
      },
      "opencode_server",
    ],
    [
      "Claude ACPX",
      {
        kind: "acpx",
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-all",
      },
      "acpx_runtime",
    ],
    [
      "Codex ACPX",
      {
        kind: "acpx",
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "deny-all",
      },
      "acpx_runtime",
    ],
    [
      "Pi ACPX without candidate authorization",
      { kind: "acpx", agent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731", permissionMode: "approve-reads" },
      "acpx_runtime",
    ],
  ])(
    "admits the qualified %s provider",
    async (_name, provider, driverKind) => {
      const providerExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          runId: `run-${String(provider.kind)}-${"agent" in provider ? provider.agent : "native"}`,
        },
        provider,
        session: { ...execution.session, driverKind },
      } as unknown as NativeExecutionInputV1;
      state.createBackend.mockClear();
      state.execute.mockReset().mockResolvedValue({
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind,
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      });

      await executePaperclipNativeSession({
        db: leaseDb(providerExecution),
        execution: providerExecution,
        runnerInstanceId: "runner",
      });

      expect(state.createBackend).toHaveBeenCalledWith(
        providerExecution,
        expect.any(Object),
      );
    },
  );

  it.each(["copilot"])("rejects ACPX candidate %s without host authorization before constructing a backend", async (agent) => {
    const piExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-acpx-pi-rejected" },
      provider: { kind: "acpx", agent, model: "pi-model" },
      session: { ...execution.session, driverKind: "acpx_runtime" },
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();

    await expect(
      executePaperclipNativeSession({
        db: leaseDb(piExecution),
        execution: piExecution,
        runnerInstanceId: "runner",
      }),
    ).rejects.toThrow("exact host qualification authorization");
    expect(state.createBackend).not.toHaveBeenCalled();
  });
});

describe("runnerd provider runtime wiring", () => {
  let isolatedStateDirectory: string;
  let previousStateDirectory: string | undefined;

  beforeEach(async () => {
    previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    isolatedStateDirectory = await mkdtemp(
      join(tmpdir(), "paperclip-runnerd-wiring-"),
    );
    process.env.PAPERCLIP_RUNNER_STATE_DIR = isolatedStateDirectory;
  });

  afterEach(async () => {
    if (previousStateDirectory === undefined) {
      delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    } else {
      process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    }
    await rm(isolatedStateDirectory, { recursive: true, force: true });
  });

  it.each([
    ["open", "before-close"],
    ["open", "during-close"],
    ["recover", "before-close"],
    ["recover", "during-close"],
  ] as const)("preserves managed Codex credentials after %s session detachment %s", async (mode, timing) => {
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const close = vi.fn(async () => {
      if (timing === "during-close") await closing;
    });
    const detach = vi.fn(async () => undefined);
    const rawSession = { close, detachControllerForRestart: detach };
    state.copyBackCodexAuth.mockClear();
    state.createBackend.mockReturnValueOnce({
      kind: "test",
      openSession: async () => rawSession,
      recoverSession: async () => ({ recovered: true, session: rawSession }),
    } as never);
    const backend = await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-managed-credential-detach",
      managedAiCredentialHome: join(isolatedStateDirectory, "managed-home"),
    });
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const root = state.createTransport.mock.calls.at(-1)![0].stateDirectory!;
    const authPath = join(root, "codex-home", "auth.json");
    const auth = JSON.stringify({ OPENAI_API_KEY: "fixture-managed-codex-credential" });
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(authPath, auth);
    const session = mode === "open"
      ? await backend.openSession({} as never)
      : (await backend.recoverSession!({} as never, {
          signal: new AbortController().signal,
        })).session!;

    if (timing === "before-close") {
      await session.detachControllerForRestart!();
      await session.close({ reason: "old controller finalizer" });
    } else {
      const closed = session.close({ reason: "old controller finalizer" });
      await session.detachControllerForRestart!();
      finishClose();
      await closed;
    }

    expect(detach).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(timing === "during-close" ? 1 : 0);
    expect(state.copyBackCodexAuth).not.toHaveBeenCalled();
    await expect(readFile(authPath, "utf8")).resolves.toBe(auth);
  });

  it("copies back and removes Grok credentials from the exact ACPX launch home", async () => {
    const priorHome = process.env.PAPERCLIP_HOME;
    const privateRoot = await realpath(isolatedStateDirectory);
    process.env.PAPERCLIP_HOME = privateRoot;
    const managedHome = join(privateRoot, "company-login");
    await mkdir(managedHome, { mode: 0o700 });
    await writeFile(join(managedHome, "auth.json"), "fixture-old-login", { mode: 0o600 });
    const grokExecution = { ...execution,
      provider: { kind: "acpx", agent: "grok", model: "grok-4.7", permissionMode: "deny-all" },
      session: { ...execution.session, driverKind: "acpx_runtime" },
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockReturnValueOnce({
      kind: "test", openSession: async () => ({ close: vi.fn(async () => undefined) }),
    } as never);
    try {
      const backend = await createRunnerdBackend({ db: leaseDb(grokExecution), execution: grokExecution,
        runnerInstanceId: "grok-cleanup", managedAiCredentialHome: managedHome });
      state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
      const runtimeDirectory = state.createTransport.mock.calls.at(-1)![0].acpxRuntimeDirectory!;
      await mkdir(runtimeDirectory, { recursive: true });
      // Use the runtime's real resolver, so this test cannot reproduce a
      // controller-side guess that omits the nested ACPX namespace.
      const agentHome = join(await resolveAcpxRuntimeRoot(runtimeDirectory, execution.session.normalizedSessionId!), "grok-home");
      await mkdir(agentHome, { recursive: true, mode: 0o700 });
      for (const name of ["auth.json", "auth-refresh.json", "auth-refresh.json.tmp"]) {
        await writeFile(join(agentHome, name), "fixture-refreshed-login", { mode: 0o600 });
      }
      grokCopyBack.mockReset().mockImplementationOnce(async input => {
        expect(input.hostHomeDir).toBe(managedHome);
        expect((await input.readSandboxAuth()).toString()).toBe("fixture-refreshed-login");
      });
      const session = await backend.openSession({} as never);
      await session.close({ reason: "completed" });
      expect(grokCopyBack).toHaveBeenCalledOnce();
      for (const name of ["auth.json", "auth-refresh.json", "auth-refresh.json.tmp"]) {
        await expect(access(join(agentHome, name))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = priorHome;
    }
  });

  it("still cleans up managed Codex credentials after an owned session closes", async () => {
    const close = vi.fn(async () => undefined);
    state.copyBackCodexAuth.mockClear();
    state.createBackend.mockReturnValueOnce({
      kind: "test",
      openSession: async () => ({ close }),
    } as never);
    const managedHome = join(isolatedStateDirectory, "managed-home");
    const backend = await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-managed-credential-close",
      managedAiCredentialHome: managedHome,
    });
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const root = state.createTransport.mock.calls.at(-1)![0].stateDirectory!;
    const authPath = join(root, "codex-home", "auth.json");
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(authPath, "fixture-managed-codex-credential");
    const session = await backend.openSession({} as never);

    await session.close({ reason: "completed" });
    await session.close({ reason: "repeated cleanup" });

    expect(state.copyBackCodexAuth).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostAuthPath: join(managedHome, "auth.json") }),
    );
    await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages from the authenticated run snapshot and cleans up after the provider turn", async () => {
    const cleanup = vi.fn(async () => undefined);
    state.stageNativeRunnerWakeAttachments.mockResolvedValueOnce({
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000009201",
          filename: "inbound.txt",
          contentType: "text/plain",
          byteSize: 12,
          workspaceRelativePath:
            ".paperclip-inbound/run/00000000-0000-4000-8000-000000009202",
          unavailableReason: null,
        },
      ],
      cleanup,
    });
    state.renderNativeRunnerStagedAttachmentPrompt.mockReturnValueOnce(
      "Paperclip native attachment access: staged.",
    );
    state.execute.mockReset().mockResolvedValueOnce({
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn-attachment-cleanup",
      normalizedSessionId: "session-attachment-cleanup",
      providerSessionId: null,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
      usage: null,
    });
    const stagedExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-runnerd-attachment-cleanup",
      },
      task: {
        ...execution.task,
        prompt: "Inspect the current user input.",
      },
    } as NativeExecutionInputV1;

    await expect(
      executePaperclipNativeSession({
        db: leaseDb(stagedExecution),
        execution: stagedExecution,
        runnerInstanceId: "runner-attachment-cleanup",
        useRunnerd: true,
      }),
    ).resolves.toBeDefined();

    expect(state.stageNativeRunnerWakeAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          companyId: stagedExecution.binding.companyId,
          issueId: stagedExecution.binding.issueId,
          runId: stagedExecution.binding.runId,
          agentId: stagedExecution.binding.agentId,
          executionTargetKind: "local",
        }),
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    const definitionsCall = state.toolAuthorityDefinitions.mock.calls.find(
      ([binding]) => binding.runId === stagedExecution.binding.runId,
    );
    const inspectionScope = definitionsCall?.[0].chatAttachmentReadScope as
      | import("./chat-attachment-read.js").NativeChatAttachmentReadScope
      | undefined;
    expect(inspectionScope?.options.binding).toEqual(stagedExecution.binding);
    expect(() =>
      inspectionScope!.read({
        sourceCommentId: "unused",
        attachmentId: "unused",
      }),
    ).toThrow("scope_closed");
  });

  it("passes the run checkpoint active turn into restart recovery", async () => {
    state.createBackend.mockClear();
    state.createTransport.mockClear();
    await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-active-turn-recovery",
    });

    state.createTransport.mockClear();
    state.createBackend.mock.calls[0]![1].codexTransportFactory!({
      persistedSession: {
        driverSessionId: "driver-session-active-turn",
        providerSessionId: "provider-session-active-turn",
        activeTurnId: "provider-turn-active",
      },
    });

    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeActiveTurnId: "provider-turn-active",
        resumeProviderSession: expect.objectContaining({
          driverSessionId: "driver-session-active-turn",
          providerSessionId: "provider-session-active-turn",
          activeTurnId: "provider-turn-active",
        }),
      }),
    );
  });

  it("rejects overlapping runs for the same runnerd provider session scope", async () => {
    const first = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-runnerd-overlap-first",
        executionWorkspaceId: "workspace-runnerd-overlap",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-runnerd-overlap",
      },
    } as NativeExecutionInputV1;
    const second = {
      ...first,
      binding: { ...first.binding, runId: "run-runnerd-overlap-second" },
    } as NativeExecutionInputV1;
    let release!: () => void;
    state.execute.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              result: { summary: "completed" },
              terminal: { runTerminalState: "succeeded" },
              turnId: "turn",
              normalizedSessionId: first.session.normalizedSessionId,
              providerSessionId: "provider-runnerd-overlap",
              driverKind: "test",
              driverVersion: "1",
              nativeEventCount: 1,
              highestContiguousSourceSeq: 1,
              usage: null,
            });
        }),
    );

    const active = executePaperclipNativeSession({
      db: leaseDb(first),
      execution: first,
      runnerInstanceId: "runner-runnerd-overlap",
      useRunnerd: true,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // Durable local runner state must settle before releasing this scope to
    // another run, just like a remote runner's checkpoint.
    expect(state.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requireSessionCloseBeforeReturn: true,
      }),
    );
    await expect(
      executePaperclipNativeSession({
        db: leaseDb(second),
        execution: second,
        runnerInstanceId: "runner-runnerd-overlap",
        useRunnerd: true,
      }),
    ).rejects.toThrow("native_session_supervisor_busy");
    release();
    await expect(active).resolves.toBeDefined();
  });

  it("carries the verified runner and lease binding into a projectless continuation", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-runner-binding-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const prior = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-projectless-continuation",
        runId: "run-projectless-prior",
        executionWorkspaceId: "run-projectless-prior",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-projectless-continuation",
      },
    } as NativeExecutionInputV1;
    const continuation = {
      ...prior,
      binding: {
        ...prior.binding,
        runId: "run-projectless-next",
        executionWorkspaceId: "run-projectless-next",
      },
    } as NativeExecutionInputV1;
    const remoteCwd = "/home/daytona/paperclip-workspace";
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(prior),
        execution: prior,
        runnerInstanceId: "runner-projectless-stable",
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const scopedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
      await mkdir(join(scopedRoot, "runner"), { recursive: true });
      const priorIdentity = {
        runId: "run-projectless-prior",
        normalizedSessionId: continuation.session.normalizedSessionId,
        runnerInstanceId: "runner-projectless-stable",
        environmentLeaseId: "lease-projectless-stable",
      };
      await writeFile(
        join(scopedRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(priorIdentity)),
      );
      await writeFile(
        join(scopedRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(priorIdentity, "suspended")),
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      state.execute.mockReset().mockResolvedValue({
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: continuation.session.normalizedSessionId,
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      });
      const continuationDb = {
        ...leaseDb(continuation),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    status: "succeeded",
                    runnerProfileJson: { nativeExecutionInput: prior },
                  },
                ]),
            }),
          }),
        }),
      } as unknown as Db;

      await executePaperclipNativeSession({
        db: continuationDb,
        execution: continuation,
        runnerInstanceId: "runner-new-heartbeat",
        useRunnerd: true,
        runnerExecutionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd,
          spec: {
            host: "runner.internal",
            port: 22,
            username: "runner",
            remoteWorkspacePath: remoteCwd,
            remoteCwd,
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
      });
      expect(state.createBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace: expect.objectContaining({ cwd: remoteCwd }),
        }),
        expect.objectContaining({
          workingDirectoryAuthority: "remote_runner",
        }),
      );
      expect(state.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            workspace: expect.objectContaining({ cwd: remoteCwd }),
          }),
          requireSessionCloseBeforeReturn: true,
        }),
      );
      const backendOptions = state.createBackend.mock.calls[0]![1];
      backendOptions.codexTransportFactory!();
      expect(state.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          stateDirectory: scopedRoot,
          prpIdentity: expect.objectContaining({
            runnerInstanceId: "runner-projectless-stable",
            environmentLeaseId: "lease-projectless-stable",
            runId: "run-projectless-next",
          }),
        }),
      );
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([
    { PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned" },
    { PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3217/mcp/gateways/test" },
    { PAPERCLIP_NATIVE_MCP_TOKEN: "private-run-token" },
  ])("rejects partial remote assigned MCP bindings", async (runnerEnvironment) => {
    await expect(createRunnerdBackend({
      db: leaseDb(execution), execution, runnerInstanceId: "runner-partial-mcp", runnerEnvironment,
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", providerKey: "daytona",
        leaseId: "lease-partial-mcp", remoteCwd: "/home/daytona/paperclip-workspace",
        runner: { execute: vi.fn() },
      } as never,
    })).rejects.toThrow("assigned native MCP launch binding is incomplete");
    expect(state.createAssignedMcpTools).not.toHaveBeenCalled();
  });

  it("keeps assigned MCP credentials on the control plane for remote Codex", async () => {
    const assignedMcpTools = { definitions: () => [], has: () => false, execute: vi.fn() };
    state.createAssignedMcpTools.mockResolvedValueOnce(assignedMcpTools);
    state.createBackend.mockClear();
    state.createTransport.mockClear();
    state.toolAuthorityDefinitions.mockClear();
    await createRunnerdBackend({
      db: leaseDb(execution), execution, runnerInstanceId: "runner-assigned-mcp",
      runnerEnvironment: {
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3217/mcp/gateways/assigned-test",
        PAPERCLIP_NATIVE_MCP_TOKEN: "private-run-token",
      },
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", providerKey: "daytona",
        leaseId: "lease-assigned-mcp", remoteCwd: "/home/daytona/paperclip-workspace",
        runner: { execute: vi.fn() },
      } as never,
    });
    expect(state.createAssignedMcpTools).toHaveBeenCalledWith(expect.objectContaining({
      gatewayPublicId: "assigned-test", bearerToken: "private-run-token",
    }));
    expect(state.toolAuthorityDefinitions).toHaveBeenCalledWith(expect.objectContaining({ assignedMcpTools }));
    state.createBackend.mock.calls[0]![1].codexTransportFactory!();
    const options = state.createTransport.mock.calls[0]![0] as { environment: NodeJS.ProcessEnv };
    expect(options.environment.PAPERCLIP_NATIVE_MCP_NAME).toBeUndefined();
    expect(options.environment.PAPERCLIP_NATIVE_MCP_URL).toBeUndefined();
    expect(options.environment.PAPERCLIP_NATIVE_MCP_TOKEN).toBeUndefined();
  });

  it("makes remote authority archival idempotent and returns the archived state", async () => {
    const remoteExecute = vi.fn();
    const remoteTarget = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "daytona",
      leaseId: "lease-authority-archive",
      remoteCwd: "/home/daytona/paperclip-workspace",
      runner: { execute: remoteExecute },
    } as never;
    const normalizedSessionId = execution.session.normalizedSessionId;
    if (!normalizedSessionId) {
      throw new Error("fixture requires a normalized native session id");
    }
    const archiveIdentity = {
      runnerInstanceId: "runner-authority-archive",
      environmentLeaseId: "lease-authority-archive",
      runId: execution.binding.runId,
      normalizedSessionId,
      turnId: "turn-authority-archive",
      itemId: "item-authority-archive",
    };
    const archivedState = {
      schema: "paperclip.runner.durable.state.v1",
      ...archiveIdentity,
      lifecycle: "suspended",
    };
    state.createBackend.mockClear();
    state.createTransport.mockClear();
    await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: archiveIdentity.runnerInstanceId,
      runnerExecutionTarget: remoteTarget,
    });
    state.createBackend.mock.calls[0]![1].codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        externallySandboxed: true,
        environment: expect.objectContaining({
          PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
        }),
      }),
    );
    const archiveExternalRunnerState =
      state.createTransport.mock.calls[0]![0].archiveExternalRunnerState;
    expect(archiveExternalRunnerState).toBeTypeOf("function");
    remoteExecute.mockClear();
    remoteExecute.mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: Buffer.from(JSON.stringify(archivedState)).toString("base64"),
      stderr: "",
    });

    await expect(
      archiveExternalRunnerState!({
        archiveKey: "a".repeat(24),
        priorIdentity: archiveIdentity,
      }),
    ).resolves.toEqual(archivedState);
    await expect(
      archiveExternalRunnerState!({
        archiveKey: "a".repeat(24),
        priorIdentity: archiveIdentity,
      }),
    ).resolves.toEqual(archivedState);
    expect(remoteExecute).toHaveBeenCalledTimes(2);
    expect(remoteExecute.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        command: "sh",
        args: expect.arrayContaining([
          expect.stringContaining(
            'test ! -e "$1" && test ! -L "$1" && test -f "$3" && test ! -L "$3"',
          ),
        ]),
      }),
    );

    remoteExecute.mockResolvedValueOnce({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "source and archive both exist",
    });
    await expect(
      archiveExternalRunnerState!({
        archiveKey: "a".repeat(24),
        priorIdentity: archiveIdentity,
      }),
    ).rejects.toThrow("runner_remote_authority_archive_failed");
  });

  it("uses the native execution workspace as the local provider containment root", async () => {
    state.createBackend.mockClear();
    await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-local-workspace",
      runnerEnvironment: {
        HOME: "/home/runner",
        PAPERCLIP_WORKSPACE_CWD: "/untrusted/configured-workspace",
        PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
      },
    });

    const backendOptions = state.createBackend.mock.calls[0]![1];
    state.createTransport.mockClear();
    backendOptions.codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          PAPERCLIP_WORKSPACE_CWD: execution.workspace.cwd,
        }),
      }),
    );
    const localTransportOptions = state.createTransport.mock.calls[0]![0] as {
      environment: NodeJS.ProcessEnv;
    };
    expect(
      localTransportOptions.environment.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX,
    ).toBeUndefined();
  });

  it("atomically migrates legacy unscoped state only for its exact durable run identity", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-legacy-runner-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const legacyExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-legacy-state",
        runId: "run-legacy-state",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-legacy-state",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256").update("session-legacy-state").digest("hex"),
    );
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      const legacyIdentity = {
        runId: "run-legacy-state",
        normalizedSessionId: "session-legacy-state",
        runnerInstanceId: "runner-legacy-state",
        environmentLeaseId: "lease-legacy-state",
      };
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(legacyIdentity)),
      );
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(legacyIdentity, "ready")),
      );
      state.createBackend.mockClear();
      await createRunnerdBackend({
        db: leaseDb(legacyExecution),
        execution: legacyExecution,
        runnerInstanceId: "runner-legacy-state",
      });
      state.createTransport.mockClear();
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const migratedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      expect(migratedRoot).not.toBe(legacyRoot);
      await expect(access(legacyRoot)).rejects.toThrow();
      await expect(
        access(join(migratedRoot, "control-plane", "control-plane-state.json")),
      ).resolves.toBeUndefined();
      expect(state.createTransport.mock.calls[0]![0].prpIdentity).toEqual(
        expect.objectContaining({
          runnerInstanceId: "runner-legacy-state",
          environmentLeaseId: "lease-legacy-state",
          runId: "run-legacy-state",
        }),
      );
      expect(state.createTransport.mock.calls[0]![0].runnerBinary).toBe(
        "/tmp/paperclip-runnerd",
      );
      expect(state.resolveRunnerBinary).toHaveBeenCalled();

      const unrelatedExecution = {
        ...legacyExecution,
        binding: {
          ...legacyExecution.binding,
          companyId: "company-unrelated-state",
          runId: "run-unrelated-state",
        },
      } as NativeExecutionInputV1;
      await createRunnerdBackend({
        db: leaseDb(unrelatedExecution),
        execution: unrelatedExecution,
        runnerInstanceId: "runner-unrelated-state",
      });
      state.createBackend.mock.calls[1]![1].codexTransportFactory!();
      expect(state.createTransport.mock.calls[1]![0].stateDirectory).not.toBe(
        legacyRoot,
      );
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("migrates the former company/session scope into the full native session scope", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-company-session-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const legacyExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-former-scope",
        runId: "run-former-scope",
        agentId: "agent-former-scope",
        executionWorkspaceId: "workspace-former-scope",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-former-scope",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256")
        .update(
          JSON.stringify([
            legacyExecution.binding.companyId,
            legacyExecution.session.normalizedSessionId,
          ]),
        )
        .digest("hex"),
    );
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      const legacyIdentity = {
        runId: legacyExecution.binding.runId,
        normalizedSessionId: legacyExecution.session.normalizedSessionId,
        runnerInstanceId: "runner-former-scope",
        environmentLeaseId: "lease-former-scope",
      };
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(legacyIdentity)),
      );
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(legacyIdentity, "ready")),
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await createRunnerdBackend({
        db: leaseDb(legacyExecution),
        execution: legacyExecution,
        runnerInstanceId: "runner-former-scope",
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const migratedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      expect(migratedRoot).not.toBe(legacyRoot);
      await expect(access(legacyRoot)).rejects.toThrow();
      await expect(
        access(join(migratedRoot, "control-plane", "control-plane-state.json")),
      ).resolves.toBeUndefined();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([0, 2048])("migrates a suspended prior-run authority in the same full session scope with %i retained events", async (eventCount) => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-prior-run-session-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const priorExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-prior-run-scope",
        runId: "run-prior-run-scope",
        agentId: "agent-prior-run-scope",
        executionWorkspaceId: "workspace-prior-run-scope",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-prior-run-scope",
      },
    } as NativeExecutionInputV1;
    const currentExecution = {
      ...priorExecution,
      binding: {
        ...priorExecution.binding,
        runId: "run-current-run-scope",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256")
        .update(
          JSON.stringify([
            currentExecution.binding.companyId,
            currentExecution.session.normalizedSessionId,
          ]),
        )
        .digest("hex"),
    );
    const priorRunDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  status: "succeeded",
                  runnerProfileJson: {
                    nativeExecutionInput: priorExecution,
                  },
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      const identity = {
        runId: priorExecution.binding.runId,
        normalizedSessionId: priorExecution.session.normalizedSessionId,
        runnerInstanceId: "runner-prior-run-scope",
        environmentLeaseId: "lease-prior-run-scope",
      };
      const controlPlaneBytes = JSON.stringify({
        ...durableControlPlaneState(identity),
        // The identity shares a file with the retained PRP event window. A
        // verbose valid turn can exceed the old 2 MiB identity-read limit.
        committedEvents: Array.from({ length: eventCount }, (_, index) => ({
          sourceSeq: index + 1,
          sourceEventId: `event-${index + 1}`,
          eventType: "item.delta",
          priority: 1,
          envelope: {
            schema: "paperclip.prp.event.v1",
            schemaVersion: 1,
            sourceKind: "runner",
            sourceInstanceId: identity.runnerInstanceId,
            sourceEventId: `event-${index + 1}`,
            sourceSeq: index + 1,
            normalizedSessionId: identity.normalizedSessionId,
            runId: identity.runId,
            turnId: "turn-prior-run-scope",
            itemId: "item-prior-run-scope",
            eventType: "item.delta",
            priority: 1,
            emittedAt: "2026-09-24T00:00:00.000Z",
            payload: { delta: "x".repeat(1024) },
          },
          deliveryCount: 1,
          logicalEffectCount: 1,
        })),
      });
      if (eventCount > 0) expect(Buffer.byteLength(controlPlaneBytes)).toBeGreaterThan(2 * 1024 * 1024);
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        controlPlaneBytes,
      );
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        JSON.stringify(
          durableRunnerState(
            {
              runId: priorExecution.binding.runId,
              normalizedSessionId: priorExecution.session.normalizedSessionId,
              runnerInstanceId: "runner-prior-run-scope",
              environmentLeaseId: "lease-prior-run-scope",
            },
            "suspended",
          ),
        ),
      );

      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: priorRunDb,
        execution: currentExecution,
        runnerInstanceId: "runner-current-run-scope",
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const migratedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      expect(migratedRoot).not.toBe(legacyRoot);
      await expect(access(legacyRoot)).rejects.toThrow();
      // Re-enter through the canonical scoped root as ordinary continuation
      // does, not only through the legacy migration path above.
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: priorRunDb,
        execution: currentExecution,
        runnerInstanceId: "runner-current-run-scope",
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      expect(state.createTransport.mock.calls[0]![0].stateDirectory).toBe(migratedRoot);
      expect(state.createTransport.mock.calls[0]![0].prpIdentity).toEqual(
        expect.objectContaining({
          runId: currentExecution.binding.runId,
          runnerInstanceId: "runner-prior-run-scope",
          environmentLeaseId: "lease-prior-run-scope",
        }),
      );
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([
    {
      directLifecycle: null,
      backupLifecycle: "suspended",
      corrupt: false,
      accepted: true,
    },
    {
      directLifecycle: "empty",
      backupLifecycle: "suspended",
      corrupt: false,
      accepted: true,
    },
    {
      directLifecycle: "ready",
      backupLifecycle: "suspended",
      corrupt: false,
      accepted: false,
    },
    {
      directLifecycle: "malformed",
      backupLifecycle: "suspended",
      corrupt: false,
      accepted: false,
    },
    {
      directLifecycle: "nonempty",
      backupLifecycle: "suspended",
      corrupt: false,
      accepted: false,
    },
    {
      directLifecycle: null,
      backupLifecycle: "ready",
      corrupt: false,
      accepted: false,
    },
    {
      directLifecycle: null,
      backupLifecycle: "suspended",
      corrupt: true,
      accepted: false,
    },
  ] as const)(
    "uses remote prior-run backup when acceptance=$accepted direct=$directLifecycle backup=$backupLifecycle corrupt=$corrupt",
    async ({ directLifecycle, backupLifecycle, corrupt, accepted }) => {
      const stateBase = await mkdtemp(
        join(tmpdir(), "paperclip-remote-prior-run-state-"),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      const priorExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          companyId: "company-remote-prior-scope",
          runId: "run-remote-prior-scope",
          agentId: "agent-remote-prior-scope",
          executionWorkspaceId: "workspace-remote-prior-scope",
        },
        session: {
          ...execution.session,
          normalizedSessionId: "session-remote-prior-scope",
        },
      } as NativeExecutionInputV1;
      const currentExecution = {
        ...priorExecution,
        binding: {
          ...priorExecution.binding,
          runId: "run-current-remote-scope",
        },
      } as NativeExecutionInputV1;
      const priorRunDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    status: "succeeded",
                    runnerProfileJson: {
                      nativeExecutionInput: priorExecution,
                    },
                  },
                ]),
            }),
          }),
        }),
      } as unknown as Db;
      const remoteTarget = {
        kind: "remote" as const,
        transport: "sandbox" as const,
        providerKey: "daytona",
        leaseId: "environment-lease-remote-prior-scope",
        remoteCwd: "/home/daytona/paperclip-workspace",
        runner: {
          execute: vi.fn(),
        },
      } as never;
      const identity = {
        runId: priorExecution.binding.runId,
        normalizedSessionId: priorExecution.session.normalizedSessionId,
        runnerInstanceId: "runner-remote-prior-scope",
        environmentLeaseId: "lease-remote-prior-scope",
      };
      try {
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await createRunnerdBackend({
          db: leaseDb(priorExecution),
          execution: priorExecution,
          runnerInstanceId: identity.runnerInstanceId,
          runnerExecutionTarget: remoteTarget,
        });
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const scopedRoot =
          state.createTransport.mock.calls[0]![0].stateDirectory!;
        await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
        await writeFile(
          join(scopedRoot, "control-plane", "control-plane-state.json"),
          JSON.stringify(durableControlPlaneState(identity)),
        );
        if (directLifecycle === "empty") {
          // Remote transports before the externally-owned-state fix left an
          // empty local placeholder beside the controller state. It is not an
          // authority record and must not mask a verified remote backup.
          await mkdir(join(scopedRoot, "runner"), { recursive: true });
        } else if (directLifecycle === "nonempty") {
          await mkdir(join(scopedRoot, "runner"), { recursive: true });
          await writeFile(
            join(scopedRoot, "runner", "unexpected-state.json"),
            "{}",
          );
        } else if (directLifecycle !== null) {
          await mkdir(join(scopedRoot, "runner"), { recursive: true });
          await writeFile(
            join(scopedRoot, "runner", "runner-state.json"),
            JSON.stringify(
              directLifecycle === "malformed"
                ? {
                    ...durableRunnerState(identity, "suspended"),
                    runId: "conflicting-direct-run",
                  }
                : durableRunnerState(identity, directLifecycle),
            ),
          );
        }
        const backupRoot = join(scopedRoot, "failover-backups", "current");
        await mkdir(join(backupRoot, "runner"), { recursive: true });
        await mkdir(join(backupRoot, "codex-home"), { recursive: true });
        await writeFile(
          join(backupRoot, "runner", "runner-state.json"),
          JSON.stringify(durableRunnerState(identity, backupLifecycle)),
        );
        const manifest = buildNativeHarnessBackupManifest({
          backupRoot,
          execution: priorExecution,
          runnerInstanceId: identity.runnerInstanceId,
          providerSessionIdentity: {
            providerSessionId: "provider-remote-prior-scope",
            providerBackendSessionId: null,
            providerSessionIdentity: null,
          },
          sourceProviderLeaseId: "sandbox-remote-prior-scope",
        });
        await writeFile(
          join(backupRoot, "manifest.json"),
          JSON.stringify(manifest),
        );
        if (corrupt) {
          await writeFile(
            join(backupRoot, "runner", "runner-state.json"),
            JSON.stringify({
              ...durableRunnerState(identity, backupLifecycle),
              x: 1,
            }),
          );
        }
        state.createBackend.mockClear();
        state.createTransport.mockClear();

        const continuation = createRunnerdBackend({
          db: priorRunDb,
          execution: currentExecution,
          runnerInstanceId: "runner-current-remote-scope",
          runnerExecutionTarget: remoteTarget,
        });
        if (!accepted) {
          await expect(continuation).rejects.toThrow(
            "runner_state_identity_mismatch",
          );
          expect(state.createBackend).not.toHaveBeenCalled();
          return;
        }
        await expect(continuation).resolves.toBeDefined();
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        expect(state.createTransport.mock.calls[0]![0].prpIdentity).toEqual(
          expect.objectContaining({
            runId: currentExecution.binding.runId,
            runnerInstanceId: identity.runnerInstanceId,
            environmentLeaseId: identity.environmentLeaseId,
          }),
        );
      } finally {
        if (previousStateDirectory === undefined) {
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        } else {
          process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        }
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it("quarantines legacy prior-run state only after the database proves a terminal owner in the same full scope", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-legacy-terminal-unsuspended-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const priorExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-legacy-terminal-unsuspended",
        runId: "run-legacy-terminal-unsuspended",
        agentId: "agent-legacy-terminal-unsuspended",
        executionWorkspaceId: "workspace-legacy-terminal-unsuspended",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-legacy-terminal-unsuspended",
      },
    } as NativeExecutionInputV1;
    const currentExecution = {
      ...priorExecution,
      binding: {
        ...priorExecution.binding,
        runId: "run-after-legacy-terminal-unsuspended",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256")
        .update(
          JSON.stringify([
            currentExecution.binding.companyId,
            currentExecution.session.normalizedSessionId,
          ]),
        )
        .digest("hex"),
    );
    const terminalPriorRunDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  status: "succeeded",
                  runnerProfileJson: {
                    nativeExecutionInput: priorExecution,
                  },
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;
    const identity = {
      runId: priorExecution.binding.runId,
      normalizedSessionId: priorExecution.session.normalizedSessionId,
      runnerInstanceId: "runner-legacy-terminal-unsuspended",
      environmentLeaseId: "lease-legacy-terminal-unsuspended",
    };
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
      );
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(identity, "ready")),
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        createRunnerdBackend({
          db: terminalPriorRunDb,
          execution: currentExecution,
          runnerInstanceId: "runner-after-legacy-terminal-unsuspended",
        }),
      ).rejects.toThrow("runner_state_identity_mismatch");
      await expect(access(legacyRoot)).rejects.toThrow();
      const quarantineEntries = await readdir(join(stateBase, "quarantine"));
      expect(quarantineEntries).toHaveLength(1);
      expect(quarantineEntries[0]).toContain(".identity_indeterminate.");
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("rejects scoped prior-run state after restart while its heartbeat is still running", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-running-prior-run-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const priorExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-running-prior-scope",
        runId: "run-running-prior-scope",
        agentId: "agent-running-prior-scope",
        executionWorkspaceId: "workspace-running-prior-scope",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-running-prior-scope",
      },
    } as NativeExecutionInputV1;
    const currentExecution = {
      ...priorExecution,
      binding: {
        ...priorExecution.binding,
        runId: "run-after-running-prior-scope",
      },
    } as NativeExecutionInputV1;
    const runningPriorRunDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  status: "running",
                  runnerProfileJson: {
                    nativeExecutionInput: priorExecution,
                  },
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;
    const identity = {
      runId: priorExecution.binding.runId,
      normalizedSessionId: priorExecution.session.normalizedSessionId,
      runnerInstanceId: "runner-running-prior-scope",
      environmentLeaseId: "lease-running-prior-scope",
    };
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(priorExecution),
        execution: priorExecution,
        runnerInstanceId: identity.runnerInstanceId,
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const scopedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
      await mkdir(join(scopedRoot, "runner"), { recursive: true });
      await writeFile(
        join(scopedRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
      );
      await writeFile(
        join(scopedRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(identity, "suspended")),
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        createRunnerdBackend({
          db: runningPriorRunDb,
          execution: currentExecution,
          runnerInstanceId: "runner-after-running-prior-scope",
        }),
      ).rejects.toThrow("runner_state_identity_mismatch: prior_owner_active");
      await expect(access(scopedRoot)).resolves.toBeUndefined();
      await expect(access(join(stateBase, "quarantine"))).rejects.toThrow();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([
    "quarantined",
    "large control plane",
    "empty retry shell",
    "unsuspended current",
    "live runner",
    "live group",
    "missing process identity",
    "active prior run",
    "wrong checkpoint",
    "active goal",
    "active provider turn",
    "pending command",
    "multiple checkpoints",
    "corrupt current authority",
    "wrong scope",
    "provider mismatch",
    "unacknowledged events",
    "runtime request",
    "wrong company",
    "permission denied process",
    "ambiguous turn start",
    "state symlink",
    "newer provider checkpoint",
  ])(
    "automatically recovers only a proven settled local session: %s",
    async (scenario) => {
      const stateBase = await mkdtemp(
        join(tmpdir(), "paperclip-quiescent-recovery-"),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      const priorExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          runId: "recovery-prior",
          executionWorkspaceId: "recovery-workspace",
        },
        session: {
          ...execution.session,
          normalizedSessionId: "recovery-session",
        },
      } as NativeExecutionInputV1;
      const currentExecution = {
        ...priorExecution,
        binding: { ...priorExecution.binding, runId: "recovery-current" },
      };
      const identity = {
        runId: priorExecution.binding.runId,
        normalizedSessionId: priorExecution.session.normalizedSessionId,
        runnerInstanceId: "recovery-runner",
        environmentLeaseId: "recovery-lease",
        turnId: "recovery-turn",
        itemId: "recovery-item",
      };
      const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      if (scenario === "live runner" || scenario === "live group") {
        processKill.mockImplementation((pid) => {
          if (pid === (scenario === "live runner" ? 90000001 : -90000001))
            return true;
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        });
      }
      if (scenario === "permission denied process") {
        processKill.mockImplementation(() => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        });
      }
      const onLog = vi.fn(async () => {});
      const profile = {
        nativeExecutionInput:
          scenario === "wrong scope"
            ? {
                ...priorExecution,
                binding: { ...priorExecution.binding, agentId: "other-agent" },
              }
            : scenario === "provider mismatch"
              ? {
                  ...priorExecution,
                  provider: {
                    ...priorExecution.provider,
                    model: "other-model",
                  },
                }
              : priorExecution,
        sessionCheckpoint: {
          identity: {
            runId: identity.runId,
            sessionId: identity.normalizedSessionId,
            companyId:
              scenario === "wrong company"
                ? "other-company"
                : priorExecution.binding.companyId,
            agentId: priorExecution.binding.agentId,
            issueId: priorExecution.binding.issueId,
          },
          driverKind: priorExecution.session.driverKind,
          providerSessionId:
            scenario === "wrong checkpoint"
              ? "other-thread"
              : "recovery-thread",
          activeTurnId: null,
          pendingRuntimeRequests:
            scenario === "runtime request" ? [{ id: "pending" }] : [],
        },
      };
      let recoveryReads = 0;
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    status:
                      scenario === "active prior run" ? "running" : "succeeded",
                    runnerProfileJson:
                      ++recoveryReads === 2 &&
                      scenario === "newer provider checkpoint"
                        ? {
                            ...profile,
                            sessionCheckpoint: {
                              ...profile.sessionCheckpoint,
                              providerSessionId: "newer-thread",
                            },
                          }
                        : profile,
                    processPid:
                      scenario === "missing process identity" ? null : 90000001,
                    processGroupId: 90000001,
                    contextSnapshot: {
                      paperclipEnvironment: { driver: "local" },
                    },
                  },
                ]),
            }),
          }),
        }),
      } as unknown as Db;
      try {
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await createRunnerdBackend({
          db: leaseDb(priorExecution),
          execution: priorExecution,
          runnerInstanceId: identity.runnerInstanceId,
        });
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const scopedRoot =
          state.createTransport.mock.calls[0]![0].stateDirectory!;
        const quarantineRoot = join(stateBase, "quarantine");
        await mkdir(quarantineRoot, { recursive: true });
        const candidate =
          scenario === "unsuspended current"
            ? scopedRoot
            : join(
                quarantineRoot,
                `${scopedRoot.split("/").at(-1)}.identity_indeterminate.1`,
              );
        if (candidate !== scopedRoot) await rename(scopedRoot, candidate);
        const writeCandidate = async (root: string) => {
          await mkdir(join(root, "runner"), { recursive: true });
          await mkdir(join(root, "control-plane"), { recursive: true });
          await writeFile(
            join(root, "runner", "runner-state.json"),
            JSON.stringify({
              ...durableRunnerState(identity, "ready"),
              outbox:
                scenario === "unacknowledged events" ? [{ sourceSeq: 10 }] : [],
              pendingTerminalDelivery: null,
            }),
          );
          await writeFile(
            join(root, "runner", "codex-provider-state.json"),
            JSON.stringify({
              schema: "paperclip.runner.codex-provider-state.v1",
              lifecycle: "session_open",
              config: { provider: "codex", driver: "codex_app_server" },
              threadId: "recovery-thread",
              activeProviderTurnId:
                scenario === "active provider turn" ? "still-working" : null,
              ambiguousTurnStartPending: scenario === "ambiguous turn start",
              completedTurnAuthoritative: true,
              goal: scenario === "active goal" ? { status: "active" } : null,
            }),
          );
          await writeFile(
            join(root, "control-plane", "control-plane-state.json"),
            JSON.stringify({
              ...durableControlPlaneState(identity),
              commands: [
                {
                  type: "turn.start",
                  status:
                    scenario === "pending command" ? "pending" : "completed",
                },
              ],
              committedEvents: [
                ...(scenario === "large control plane"
                  ? Array.from({ length: 2048 }, () => ({
                      eventType: "item.delta",
                      envelope: { ...identity, payload: { delta: "x".repeat(8192) } },
                    }))
                  : []),
                { eventType: "run.terminal", envelope: identity },
              ],
            }),
          );
          await mkdir(join(root, "codex-home", "sessions"), {
            recursive: true,
          });
          await writeFile(
            join(root, "codex-home", "sessions", "history.jsonl"),
            "existing conversation",
          );
        };
        await writeCandidate(candidate);
        if (scenario === "state symlink") {
          await rename(
            join(candidate, "runner", "runner-state.json"),
            join(candidate, "original-state.json"),
          );
          await symlink(
            join(candidate, "original-state.json"),
            join(candidate, "runner", "runner-state.json"),
          );
        }
        if (scenario === "multiple checkpoints")
          await writeCandidate(`${candidate}.duplicate`);
        if (
          scenario === "empty retry shell" ||
          scenario === "corrupt current authority"
        )
          await mkdir(scopedRoot);
        if (scenario === "corrupt current authority")
          await writeFile(
            join(scopedRoot, "unrecognized-state"),
            "do not replace",
          );
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        const shouldRecover = [
          "quarantined",
          "large control plane",
          "empty retry shell",
          "unsuspended current",
          "active goal",
        ].includes(scenario);
        if (shouldRecover) {
          await createRunnerdBackend({
            db,
            execution: currentExecution,
            runnerInstanceId: "new-runner",
            onLog,
          });
          expect(
            JSON.parse(
              await readFile(
                join(scopedRoot, "runner", "runner-state.json"),
                "utf8",
              ),
            ).lifecycle,
          ).toBe("suspended");
          expect(
            await readFile(
              join(scopedRoot, "codex-home", "sessions", "history.jsonl"),
              "utf8",
            ),
          ).toBe("existing conversation");
          if (scenario === "active goal") {
            expect(
              JSON.parse(
                await readFile(
                  join(scopedRoot, "runner", "codex-provider-state.json"),
                  "utf8",
                ),
              ).goal,
            ).toEqual({ status: "active" });
          }
          expect(onLog).toHaveBeenCalledWith(
            "stdout",
            expect.stringContaining("Automatically recovered settled session"),
          );
        } else {
          // A quarantined checkpoint that fails verification must not be used
          // even if a new backend can initialize its otherwise empty root.
          await createRunnerdBackend({
            db,
            execution: currentExecution,
            runnerInstanceId: "new-runner",
            onLog,
          }).catch(() => {});
          expect(
            JSON.parse(
              await readFile(
                join(candidate, "runner", "runner-state.json"),
                "utf8",
              ),
            ).lifecycle,
          ).toBe("ready");
          expect(onLog).not.toHaveBeenCalled();
          expect(state.createBackend).not.toHaveBeenCalled();
        }
      } finally {
        processKill.mockRestore();
        if (previousStateDirectory === undefined)
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it("quarantines scoped prior-run state when the heartbeat is terminal but runnerd is not suspended", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-terminal-unsuspended-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const priorExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-terminal-unsuspended",
        runId: "run-terminal-unsuspended",
        agentId: "agent-terminal-unsuspended",
        executionWorkspaceId: "workspace-terminal-unsuspended",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-terminal-unsuspended",
      },
    } as NativeExecutionInputV1;
    const currentExecution = {
      ...priorExecution,
      binding: {
        ...priorExecution.binding,
        runId: "run-after-terminal-unsuspended",
      },
    } as NativeExecutionInputV1;
    const terminalPriorRunDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  status: "succeeded",
                  runnerProfileJson: {
                    nativeExecutionInput: priorExecution,
                  },
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;
    const identity = {
      runId: priorExecution.binding.runId,
      normalizedSessionId: priorExecution.session.normalizedSessionId,
      runnerInstanceId: "runner-terminal-unsuspended",
      environmentLeaseId: "lease-terminal-unsuspended",
    };
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(priorExecution),
        execution: priorExecution,
        runnerInstanceId: identity.runnerInstanceId,
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const scopedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
      await mkdir(join(scopedRoot, "runner"), { recursive: true });
      await writeFile(
        join(scopedRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
      );
      await writeFile(
        join(scopedRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(identity, "ready")),
      );
      await mkdir(join(scopedRoot, "codex-home", "sessions"), {
        recursive: true,
      });
      await mkdir(join(scopedRoot, "codex-home", "tmp"), { recursive: true });
      await mkdir(join(scopedRoot, "codex-home", ".tmp"), {
        recursive: true,
      });
      await writeFile(
        join(scopedRoot, "codex-home", "auth.json"),
        '{"OPENAI_API_KEY":"fixture-secret"}',
      );
      await writeFile(
        join(scopedRoot, "codex-home", "config.toml"),
        'bearer_token = "fixture-secret"',
      );
      await writeFile(
        join(scopedRoot, "codex-home", "tmp", "transient"),
        "transient",
      );
      await writeFile(
        join(scopedRoot, "codex-home", ".tmp", "transient"),
        "transient",
      );
      await writeFile(
        join(scopedRoot, "codex-home", "sessions", "rollout.jsonl"),
        "durable session history",
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        createRunnerdBackend({
          db: terminalPriorRunDb,
          execution: currentExecution,
          runnerInstanceId: "runner-after-terminal-unsuspended",
        }),
      ).rejects.toThrow("runner_state_identity_mismatch");
      await expect(access(scopedRoot)).rejects.toThrow();
      const quarantineEntries = await readdir(join(stateBase, "quarantine"));
      expect(quarantineEntries).toHaveLength(1);
      expect(quarantineEntries[0]).toContain(".identity_indeterminate.");
      const quarantinedRoot = join(
        stateBase,
        "quarantine",
        quarantineEntries[0]!,
      );
      for (const entry of ["tmp", ".tmp", "auth.json", "config.toml"]) {
        await expect(
          access(join(quarantinedRoot, "codex-home", entry)),
        ).rejects.toThrow();
      }
      await expect(
        access(
          join(quarantinedRoot, "codex-home", "sessions", "rollout.jsonl"),
        ),
      ).resolves.toBeUndefined();
      await expect(
        access(
          join(quarantinedRoot, "control-plane", "control-plane-state.json"),
        ),
      ).resolves.toBeUndefined();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("resumes a matching scoped authority with valid history above 64 MiB", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-current-scoped-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const currentExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-current-scoped-state",
        runId: "run-current-scoped-state",
        agentId: "agent-current-scoped-state",
        executionWorkspaceId: "workspace-current-scoped-state",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-current-scoped-state",
      },
    } as NativeExecutionInputV1;
    const identity = {
      runId: currentExecution.binding.runId,
      normalizedSessionId: currentExecution.session.normalizedSessionId,
      runnerInstanceId: "runner-current-scoped-state",
      environmentLeaseId: "lease-current-scoped-state",
    };
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(currentExecution),
        execution: currentExecution,
        runnerInstanceId: identity.runnerInstanceId,
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const scopedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
      await mkdir(join(scopedRoot, "runner"), { recursive: true });
      const controlPlaneStatePath = join(
        scopedRoot,
        "control-plane",
        "control-plane-state.json",
      );
      const stateWithHistory = JSON.stringify({
        ...durableControlPlaneState(identity),
        committedEvents: [],
      });
      const committedEventsMarker = '"committedEvents":[]';
      const eventsStart = stateWithHistory.indexOf(committedEventsMarker);
      expect(eventsStart).toBeGreaterThanOrEqual(0);
      const eventArrayStart = eventsStart + '"committedEvents":'.length;
      const historyPrefix = stateWithHistory.slice(0, eventArrayStart + 1);
      const historySuffix = stateWithHistory.slice(eventArrayStart + 2);
      const payloadBytesPerEvent = 512 * 1024;
      const eventCount = 128;
      const delta = "x".repeat(payloadBytesPerEvent);
      const event = (sourceSeq: number) => {
        const sourceEventId = `event-current-scoped-state-${sourceSeq}`;
        return JSON.stringify({
          sourceSeq,
          sourceEventId,
          eventType: "item.delta",
          priority: 1,
          envelope: {
            schema: "paperclip.prp.event.v1",
            schemaVersion: 1,
            sourceKind: "runner",
            sourceInstanceId: identity.runnerInstanceId,
            sourceEventId,
            sourceSeq,
            normalizedSessionId: identity.normalizedSessionId,
            runId: identity.runId,
            turnId: "turn-current-scoped-state",
            itemId: "item-current-scoped-state",
            eventType: "item.delta",
            priority: 1,
            emittedAt: "2026-09-30T00:00:00.000Z",
            payload: { delta },
          },
          deliveryCount: 1,
          logicalEffectCount: 1,
        });
      };
      await writeFile(controlPlaneStatePath, historyPrefix);
      const stateHandle = await open(controlPlaneStatePath, "a");
      try {
        for (let index = 0; index < eventCount; index += 1) {
          if (index > 0) await stateHandle.write(",");
          await stateHandle.write(event(index + 1));
        }
        await stateHandle.write("]");
        await stateHandle.write(historySuffix);
      } finally {
        await stateHandle.close();
      }
      expect((await lstat(controlPlaneStatePath)).size).toBeGreaterThan(
        64 * 1024 * 1024,
      );
      await writeFile(
        join(scopedRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(identity, "ready")),
      );
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        createRunnerdBackend({
          db: leaseDb(currentExecution),
          execution: currentExecution,
          runnerInstanceId: "runner-restart-placeholder",
        }),
      ).resolves.toBeDefined();
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      expect(state.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          stateDirectory: scopedRoot,
          prpIdentity: expect.objectContaining(identity),
        }),
      );
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it.each([
    "prepared",
    "awaiting_result",
    "runner_prepared",
    "schema_only",
    "malformed",
    "foreign_scope",
    "expired",
    "revoked",
  ] as const)(
    "preserves unadmitted forward warm-transition evidence (%s)",
    async (variant) => {
      const stateBase = await mkdtemp(
        join(tmpdir(), "paperclip-pending-warm-transition-"),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      const currentExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          companyId: `warm-company-${variant}`,
          runId: `warm-run-${variant}`,
          agentId: `warm-agent-${variant}`,
          executionWorkspaceId: `warm-workspace-${variant}`,
        },
        session: {
          ...execution.session,
          normalizedSessionId: `warm-session-${variant}`,
        },
      } as NativeExecutionInputV1;
      const identity = {
        runId: currentExecution.binding.runId,
        normalizedSessionId: currentExecution.session.normalizedSessionId,
        runnerInstanceId: `warm-runner-${variant}`,
        environmentLeaseId: currentExecution.binding.executionWorkspaceId,
      };
      try {
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await createRunnerdBackend({
          db: leaseDb(currentExecution),
          execution: currentExecution,
          runnerInstanceId: identity.runnerInstanceId,
        });
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const root = state.createTransport.mock.calls[0]![0].stateDirectory!;
        await mkdir(join(root, "control-plane"), { recursive: true });
        await mkdir(join(root, "runner"), { recursive: true });
        await mkdir(join(root, "codex-home"), { recursive: true });
        // These are deliberately unadmitted selectors, not an invented valid
        // receipt or a forged process-retirement claim. Even invalid/unsupported
        // forward evidence must never fall through the legacy quarantine path.
        const pending = {
          phase: variant === "awaiting_result" ? "awaiting_result" : "prepared",
          receipt: {
            schema: "paperclip.runner.warm-transition.v1",
            newIdentity: {
              ...identity,
              runId:
                variant === "foreign_scope" ? "foreign-run" : identity.runId,
            },
            leaseExpiresAtUnixMs:
              variant === "expired" ? 1 : Date.now() + 60_000,
          },
          credentialId: "unadmitted-credential",
        };
        const core =
          variant === "runner_prepared"
            ? durableControlPlaneState(identity)
            : {
                ...durableControlPlaneState(identity),
                schema:
                  "paperclip.runner.durable.control-plane-state.warm-transition.v1",
                ...(variant === "schema_only"
                  ? {}
                  : { warmTransition: pending }),
                leases: {
                  "unadmitted-credential": {
                    revokedAt:
                      variant === "revoked" ? new Date().toISOString() : null,
                  },
                },
              };
        const runner = {
          ...durableRunnerState(identity, "ready"),
          schema: "paperclip.runner.durable.state.warm-transition.v1",
          warmTransition: pending,
        };
        const coreBytes =
          variant === "malformed"
            ? '{"schema":"paperclip.runner.durable.control-plane-state.warm-transition.v1",'
            : JSON.stringify(core);
        const runnerBytes = JSON.stringify(runner);
        const corePath = join(
          root,
          "control-plane",
          "control-plane-state.json",
        );
        const runnerPath = join(root, "runner", "runner-state.json");
        const launchMaterial = join(root, "codex-home", "config.toml");
        await writeFile(corePath, coreBytes);
        await writeFile(runnerPath, runnerBytes);
        await writeFile(
          launchMaterial,
          "fixture launch material must remain untouched\n",
        );
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await expect(
          createRunnerdBackend({
            db: leaseDb(currentExecution),
            execution: currentExecution,
            runnerInstanceId: identity.runnerInstanceId,
          }),
        ).rejects.toThrow("native_runner_warm_transition_recovery_unproven");
        expect(await readFile(corePath, "utf8")).toBe(coreBytes);
        expect(await readFile(runnerPath, "utf8")).toBe(runnerBytes);
        expect(await readFile(launchMaterial, "utf8")).toBe(
          "fixture launch material must remain untouched\n",
        );
        await expect(access(join(stateBase, "quarantine"))).rejects.toThrow();
        expect(state.createBackend).not.toHaveBeenCalled();
        expect(state.createTransport).not.toHaveBeenCalled();
      } finally {
        if (previousStateDirectory === undefined)
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it.each(["unknown_schema", "unknown_lifecycle"] as const)(
    "quarantines an exact-run runner state with %s",
    async (caseName) => {
      const stateBase = await mkdtemp(
        join(tmpdir(), `paperclip-${caseName}-runner-state-`),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      const currentExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          companyId: `company-${caseName}-runner-state`,
          runId: `run-${caseName}-runner-state`,
          agentId: `agent-${caseName}-runner-state`,
          executionWorkspaceId: `workspace-${caseName}-runner-state`,
        },
        session: {
          ...execution.session,
          normalizedSessionId: `session-${caseName}-runner-state`,
        },
      } as NativeExecutionInputV1;
      const identity = {
        runId: currentExecution.binding.runId,
        normalizedSessionId: currentExecution.session.normalizedSessionId,
        runnerInstanceId: `runner-${caseName}-runner-state`,
        environmentLeaseId: currentExecution.binding.executionWorkspaceId,
      };
      try {
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await createRunnerdBackend({
          db: leaseDb(currentExecution),
          execution: currentExecution,
          runnerInstanceId: identity.runnerInstanceId,
        });
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const scopedRoot =
          state.createTransport.mock.calls[0]![0].stateDirectory!;
        await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
        await mkdir(join(scopedRoot, "runner"), { recursive: true });
        await writeFile(
          join(scopedRoot, "control-plane", "control-plane-state.json"),
          JSON.stringify(durableControlPlaneState(identity)),
        );
        const runnerState = durableRunnerState(
          identity,
          caseName === "unknown_lifecycle" ? "future_lifecycle" : "ready",
        );
        await writeFile(
          join(scopedRoot, "runner", "runner-state.json"),
          JSON.stringify(
            caseName === "unknown_schema"
              ? {
                  ...runnerState,
                  schema: "paperclip.runner.durable.state.v999",
                }
              : runnerState,
          ),
        );
        state.createBackend.mockClear();
        state.createTransport.mockClear();

        await expect(
          createRunnerdBackend({
            db: leaseDb(currentExecution),
            execution: currentExecution,
            runnerInstanceId: `runner-${caseName}-retry`,
          }),
        ).rejects.toThrow("runner_state_identity_mismatch");
        await expect(access(scopedRoot)).rejects.toThrow();
        const quarantineEntries = await readdir(join(stateBase, "quarantine"));
        expect(quarantineEntries).toHaveLength(1);
        expect(quarantineEntries[0]).toContain(".identity_indeterminate.");
        expect(state.createBackend).not.toHaveBeenCalled();
        expect(state.createTransport).not.toHaveBeenCalled();
      } finally {
        if (previousStateDirectory === undefined) {
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        } else {
          process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        }
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "missing",
    "malformed",
    "unknown_schema",
    "mismatched",
    "large_mismatched",
    "oversized",
  ] as const)(
    "fails closed on %s durable identity in an existing scoped root",
    async (caseName) => {
      const stateBase = await mkdtemp(
        join(tmpdir(), `paperclip-${caseName}-scoped-state-`),
      );
      const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      const scopedExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          companyId: `company-${caseName}-scoped-state`,
          runId: `run-${caseName}-scoped-state`,
          agentId: `agent-${caseName}-scoped-state`,
          executionWorkspaceId: `workspace-${caseName}-scoped-state`,
        },
        session: {
          ...execution.session,
          normalizedSessionId: `session-${caseName}-scoped-state`,
        },
      } as NativeExecutionInputV1;
      try {
        state.createBackend.mockClear();
        state.createTransport.mockClear();
        await createRunnerdBackend({
          db: leaseDb(scopedExecution),
          execution: scopedExecution,
          runnerInstanceId: `runner-${caseName}-scoped-state`,
        });
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const scopedRoot =
          state.createTransport.mock.calls[0]![0].stateDirectory!;
        await mkdir(join(scopedRoot, "control-plane"), { recursive: true });
        if (caseName !== "missing") {
          await writeFile(
            join(scopedRoot, "control-plane", "control-plane-state.json"),
            caseName === "malformed"
              ? "{"
              : caseName === "unknown_schema"
                ? JSON.stringify({
                    ...durableControlPlaneState({
                      runId: scopedExecution.binding.runId,
                      normalizedSessionId:
                        scopedExecution.session.normalizedSessionId,
                      runnerInstanceId: `runner-${caseName}-scoped-state`,
                      environmentLeaseId:
                        scopedExecution.binding.executionWorkspaceId,
                    }),
                    schema: "paperclip.runner.durable.control-plane-state.v999",
                  })
                : JSON.stringify(
                    durableControlPlaneState({
                      runId: scopedExecution.binding.runId,
                      normalizedSessionId: "session-owned-by-another-scope",
                      runnerInstanceId: "runner-owned-by-another-scope",
                      environmentLeaseId: "lease-owned-by-another-scope",
                    }),
                  ),
          );
        }
        if (caseName === "large_mismatched") {
          await writeFile(
            join(scopedRoot, "control-plane", "control-plane-state.json"),
            JSON.stringify({
              ...durableControlPlaneState({
                runId: scopedExecution.binding.runId,
                normalizedSessionId: "session-owned-by-another-scope",
                runnerInstanceId: "runner-owned-by-another-scope",
                environmentLeaseId: "lease-owned-by-another-scope",
              }),
              committedEvents: [
                {
                  eventType: "history",
                  payload: { text: "x".repeat(64 * 1024 * 1024 + 1) },
                },
              ],
            }),
          );
        }
        if (caseName === "oversized") {
          const identity = {
            runId: scopedExecution.binding.runId,
            normalizedSessionId: scopedExecution.session.normalizedSessionId,
            runnerInstanceId: `runner-${caseName}-scoped-state`,
            environmentLeaseId: scopedExecution.binding.executionWorkspaceId,
          };
          // Keep the file valid JSON so only the byte limit rejects it. Append
          // bounded whitespace chunks to avoid a 256 MiB test allocation.
          const statePath = join(
            scopedRoot,
            "control-plane",
            "control-plane-state.json",
          );
          const serializedState = JSON.stringify(
            durableControlPlaneState(identity),
          );
          await writeFile(
            statePath,
            serializedState,
          );
          const padding = Buffer.alloc(1024 * 1024, 0x20);
          const remainingBytes =
            256 * 1024 * 1024 + 1 - Buffer.byteLength(serializedState);
          const stateHandle = await open(statePath, "a");
          try {
            for (let remaining = remainingBytes; remaining > 0;) {
              const bytesToWrite = Math.min(remaining, padding.length);
              await stateHandle.write(padding, 0, bytesToWrite);
              remaining -= bytesToWrite;
            }
          } finally {
            await stateHandle.close();
          }
          await mkdir(join(scopedRoot, "runner"), { recursive: true });
          await writeFile(
            join(scopedRoot, "runner", "runner-state.json"),
            JSON.stringify(durableRunnerState(identity, "ready")),
          );
        }
        state.createBackend.mockClear();
        state.createTransport.mockClear();

        await expect(
          createRunnerdBackend({
            db: leaseDb(scopedExecution),
            execution: scopedExecution,
            runnerInstanceId: `runner-${caseName}-retry`,
          }),
        ).rejects.toThrow("runner_state_identity_mismatch");
        await expect(access(scopedRoot)).rejects.toThrow();
        const quarantineRoot = join(stateBase, "quarantine");
        const quarantineEntries = await readdir(quarantineRoot, {
          withFileTypes: true,
        });
        expect(quarantineEntries).toHaveLength(1);
        expect(quarantineEntries[0]!.isDirectory()).toBe(true);
        expect(quarantineEntries[0]!.name).toContain(
          caseName === "mismatched" || caseName === "large_mismatched"
            ? ".identity_mismatch."
            : ".identity_indeterminate.",
        );
        const quarantinedControlPlaneRoot = join(
          quarantineRoot,
          quarantineEntries[0]!.name,
          "control-plane",
        );
        await expect(
          access(quarantinedControlPlaneRoot),
        ).resolves.toBeUndefined();
        if (caseName !== "missing") {
          await expect(
            access(
              join(quarantinedControlPlaneRoot, "control-plane-state.json"),
            ),
          ).resolves.toBeUndefined();
        }
        expect(state.createBackend).not.toHaveBeenCalled();
        expect(state.createTransport).not.toHaveBeenCalled();
      } finally {
        if (previousStateDirectory === undefined) {
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        } else {
          process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
        }
        await rm(stateBase, { recursive: true, force: true });
      }
    },
  );

  it("does not quarantine an unsafe scoped-root symlink", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-symlink-scoped-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const scopedExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-symlink-scoped-state",
        runId: "run-symlink-scoped-state",
        agentId: "agent-symlink-scoped-state",
        executionWorkspaceId: "workspace-symlink-scoped-state",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-symlink-scoped-state",
      },
    } as NativeExecutionInputV1;
    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      await createRunnerdBackend({
        db: leaseDb(scopedExecution),
        execution: scopedExecution,
        runnerInstanceId: "runner-symlink-scoped-state",
      });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const scopedRoot =
        state.createTransport.mock.calls[0]![0].stateDirectory!;
      const symlinkTarget = join(stateBase, "symlink-target");
      await rm(scopedRoot, { recursive: true, force: true });
      await mkdir(symlinkTarget, { recursive: true });
      await writeFile(join(symlinkTarget, "must-remain"), "retained");
      await symlink(symlinkTarget, scopedRoot);
      state.createBackend.mockClear();
      state.createTransport.mockClear();

      await expect(
        createRunnerdBackend({
          db: leaseDb(scopedExecution),
          execution: scopedExecution,
          runnerInstanceId: "runner-symlink-retry",
        }),
      ).rejects.toThrow("runner_state_directory_unsafe");
      await expect(access(scopedRoot)).resolves.toBeUndefined();
      await expect(
        access(join(symlinkTarget, "must-remain")),
      ).resolves.toBeUndefined();
      await expect(access(join(stateBase, "quarantine"))).rejects.toThrow();
      expect(state.createBackend).not.toHaveBeenCalled();
      expect(state.createTransport).not.toHaveBeenCalled();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("rejects a suspended prior-run authority whose persisted execution belongs to another full session scope", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-prior-run-mismatched-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const currentExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-prior-run-mismatch",
        runId: "run-current-prior-mismatch",
        agentId: "agent-current-prior-mismatch",
        executionWorkspaceId: "workspace-prior-mismatch",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-prior-run-mismatch",
      },
    } as NativeExecutionInputV1;
    const priorExecution = {
      ...currentExecution,
      binding: {
        ...currentExecution.binding,
        runId: "run-prior-mismatched-scope",
        agentId: "agent-other-prior-mismatch",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256")
        .update(
          JSON.stringify([
            currentExecution.binding.companyId,
            currentExecution.session.normalizedSessionId,
          ]),
        )
        .digest("hex"),
    );
    const priorRunDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  status: "succeeded",
                  runnerProfileJson: {
                    nativeExecutionInput: priorExecution,
                  },
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await mkdir(join(legacyRoot, "runner"), { recursive: true });
      const identity = {
        runId: priorExecution.binding.runId,
        normalizedSessionId: currentExecution.session.normalizedSessionId,
        runnerInstanceId: "runner-prior-run-mismatch",
        environmentLeaseId: "lease-prior-run-mismatch",
      };
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
      );
      await writeFile(
        join(legacyRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(identity, "suspended")),
      );

      await expect(
        createRunnerdBackend({
          db: priorRunDb,
          execution: currentExecution,
          runnerInstanceId: "runner-current-prior-mismatch",
        }),
      ).rejects.toThrow("runner_state_identity_mismatch");
      await expect(access(legacyRoot)).resolves.toBeUndefined();
      await expect(access(join(stateBase, "quarantine"))).rejects.toThrow();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("fails closed instead of claiming a mismatched former session scope", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-mismatched-session-state-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const currentExecution = {
      ...execution,
      binding: {
        ...execution.binding,
        companyId: "company-mismatched-scope",
        runId: "run-current-scope",
        agentId: "agent-current-scope",
        executionWorkspaceId: "workspace-current-scope",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-mismatched-scope",
      },
    } as NativeExecutionInputV1;
    const legacyRoot = join(
      stateBase,
      createHash("sha256")
        .update(
          JSON.stringify([
            currentExecution.binding.companyId,
            currentExecution.session.normalizedSessionId,
          ]),
        )
        .digest("hex"),
    );
    try {
      await mkdir(join(legacyRoot, "control-plane"), { recursive: true });
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(
          durableControlPlaneState({
            runId: "run-unrelated-scope",
            normalizedSessionId: currentExecution.session.normalizedSessionId,
            runnerInstanceId: "runner-unrelated-scope",
            environmentLeaseId: "lease-unrelated-scope",
          }),
        ),
      );

      await expect(
        createRunnerdBackend({
          db: leaseDb(currentExecution),
          execution: currentExecution,
          runnerInstanceId: "runner-current-scope",
        }),
      ).rejects.toThrow("runner_state_identity_mismatch");
      await expect(access(legacyRoot)).resolves.toBeUndefined();
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("isolates durable state and tool authority for equal session ids in different companies", async () => {
    const scopedExecution = (companyId: string, runId: string) =>
      ({
        ...execution,
        schema: "paperclip.native-execution-input.v4",
        binding: {
          ...execution.binding,
          companyId,
          runId,
          executionWorkspaceId: "workspace",
        },
        task: {
          identifier: "DOT-ISOLATION",
          title: "Isolation test",
          description: null,
          prompt: "Verify session isolation.",
          workMode: "standard",
        },
        workspace: {
          cwd: "/tmp/native-session-isolation",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: "shared-normalized-session",
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
        provider: { kind: "codex", model: null, approvalPolicy: "never" },
        executionMode: "default",
        planningContext: null,
        interactionResponses: [],
        credentialBindings: [],
        runtimeContext: nativeRuntimeContextFixture(),
      }) as unknown as NativeExecutionInputV1;
    const firstExecution = scopedExecution("company-first", "run-first");
    const secondExecution = scopedExecution("company-second", "run-second");
    state.createBackend.mockClear();
    state.toolAuthorityExecute
      .mockReset()
      .mockImplementation((binding: Record<string, unknown>) =>
        Promise.resolve({ runId: binding.runId }),
      );

    await createRunnerdBackend({
      db: leaseDb(firstExecution),
      execution: firstExecution,
      runnerInstanceId: "runner-first",
    });
    await createRunnerdBackend({
      db: leaseDb(secondExecution),
      execution: secondExecution,
      runnerInstanceId: "runner-second",
    });

    const firstOptions = state.createBackend.mock.calls[0]![1];
    const secondOptions = state.createBackend.mock.calls[1]![1];
    state.createTransport.mockClear();
    firstOptions.codexTransportFactory!();
    secondOptions.codexTransportFactory!();
    expect(state.createTransport.mock.calls[0]![0].stateDirectory).not.toBe(
      state.createTransport.mock.calls[1]![0].stateDirectory,
    );
    await expect(firstOptions.dynamicToolHandler!({})).resolves.toEqual({
      runId: "run-first",
    });
    await expect(secondOptions.dynamicToolHandler!({})).resolves.toEqual({
      runId: "run-second",
    });
  });

  it("scopes local durable sessions by agent, workspace, and provider profile while reusing them across runs", async () => {
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-session-scope-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const scopedExecution = (input: {
      runId: string;
      agentId?: string;
      workspaceId?: string;
      providerKind?: "codex" | "opencode";
    }) =>
      ({
        ...execution,
        schema: "paperclip.native-execution-input.v4",
        binding: {
          ...execution.binding,
          companyId: "company-session-scope",
          runId: input.runId,
          issueId: "issue-session-scope",
          agentId: input.agentId ?? "agent-session-scope",
          executionWorkspaceId: input.workspaceId ?? "workspace-session-scope",
        },
        workspace: {
          cwd: "/tmp/native-session-scope",
          repoUrl: "https://example.test/paperclip.git",
          repoRef: "refs/heads/main",
          branchName: "main",
        },
        session: {
          normalizedSessionId: "shared-scoped-session",
          driverKind:
            input.providerKind === "opencode"
              ? "opencode_server"
              : "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
        provider:
          input.providerKind === "opencode"
            ? {
                kind: "opencode",
                model: "openrouter/deepseek/deepseek-v4-flash-0731",
                permissionMode: "ask",
              }
            : {
                kind: "codex",
                model: null,
                approvalPolicy: "never",
              },
        executionMode: "default",
        planningContext: null,
        interactionResponses: [],
        credentialBindings: [],
        runtimeContext: nativeRuntimeContextFixture(),
      }) as unknown as NativeExecutionInputV1;
    const first = scopedExecution({ runId: "run-session-scope-first" });
    const continuation = scopedExecution({
      runId: "run-session-scope-continuation",
    });
    const differentAgent = scopedExecution({
      runId: "run-session-scope-agent",
      agentId: "agent-session-scope-other",
    });
    const differentWorkspace = scopedExecution({
      runId: "run-session-scope-workspace",
      workspaceId: "workspace-session-scope-other",
    });
    const differentProviderProfile = scopedExecution({
      runId: "run-session-scope-provider",
      providerKind: "opencode",
    });

    try {
      state.createBackend.mockClear();
      state.createTransport.mockClear();
      state.toolAuthorityExecute
        .mockReset()
        .mockImplementation((binding: Record<string, unknown>) =>
          Promise.resolve({ runId: binding.runId }),
        );
      const tracedRuns: string[] = [];
      let firstScopedRoot: string | undefined;
      for (const candidate of [
        first,
        continuation,
        differentAgent,
        differentWorkspace,
        differentProviderProfile,
      ]) {
        const candidateDb =
          candidate === continuation
            ? ({
                ...leaseDb(candidate),
                select: () => ({
                  from: () => ({
                    where: () => ({
                      limit: () =>
                        Promise.resolve([
                          {
                            status: "succeeded",
                            runnerProfileJson: {
                              nativeExecutionInput: first,
                            },
                          },
                        ]),
                    }),
                  }),
                }),
              } as unknown as Db)
            : leaseDb(candidate);
        await createRunnerdBackend({
          db: candidateDb,
          execution: candidate,
          runnerInstanceId: `runner-${candidate.binding.runId}`,
          toolTrace: {
            observe() {},
            async execute(_call, work) {
              tracedRuns.push(candidate.binding.runId);
              return await work();
            },
          },
        });
        state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
        if (candidate === first) {
          firstScopedRoot =
            state.createTransport.mock.calls.at(-1)![0].stateDirectory!;
          const identity = {
            runId: first.binding.runId,
            normalizedSessionId: first.session.normalizedSessionId,
            runnerInstanceId: `runner-${first.binding.runId}`,
            environmentLeaseId: first.binding.executionWorkspaceId,
          };
          await mkdir(join(firstScopedRoot, "control-plane"), {
            recursive: true,
          });
          await mkdir(join(firstScopedRoot, "runner"), { recursive: true });
          await writeFile(
            join(firstScopedRoot, "control-plane", "control-plane-state.json"),
            JSON.stringify(durableControlPlaneState(identity)),
          );
          await writeFile(
            join(firstScopedRoot, "runner", "runner-state.json"),
            JSON.stringify(durableRunnerState(identity, "suspended")),
          );
        }
      }

      const stateDirectories = state.createTransport.mock.calls.map(
        ([options]) => options.stateDirectory,
      );
      expect(stateDirectories[1]).toBe(stateDirectories[0]);
      expect(stateDirectories[0]).toBe(firstScopedRoot);
      expect(
        new Set([
          stateDirectories[0],
          stateDirectories[2],
          stateDirectories[3],
          stateDirectories[4],
        ]).size,
      ).toBe(4);

      const firstOptions = state.createBackend.mock.calls[0]![1];
      const continuationOptions = state.createBackend.mock.calls[1]![1];
      // The retained runner backend owns one stable callback. After run.attach,
      // that callback routes through the session-scope authority registry to
      // the new run; stale provider calls are rejected earlier by runnerd's
      // turn identity boundary.
      await expect(firstOptions.dynamicToolHandler!({})).resolves.toEqual({
        runId: continuation.binding.runId,
      });
      await expect(
        continuationOptions.dynamicToolHandler!({}),
      ).resolves.toEqual({ runId: continuation.binding.runId });
      expect(tracedRuns).toEqual([continuation.binding.runId, continuation.binding.runId]);
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent first-use backend for the same provider session scope", async () => {
    const first = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-session-concurrent-first",
        executionWorkspaceId: "workspace-session-concurrent",
      },
      session: {
        ...execution.session,
        normalizedSessionId: "session-concurrent-first-use",
      },
    } as NativeExecutionInputV1;
    const second = {
      ...first,
      binding: { ...first.binding, runId: "run-session-concurrent-second" },
    } as NativeExecutionInputV1;
    let concurrentAttempt: Promise<unknown> | null = null;
    state.createBackend.mockImplementationOnce(() => {
      // Re-enter only after definitions have resolved, at the actual backend
      // construction boundary. The session claim must still be held here.
      concurrentAttempt = createRunnerdBackend({
        db: leaseDb(second),
        execution: second,
        runnerInstanceId: "runner-session-concurrent-second",
      });
      return { kind: "test" };
    });

    await expect(
      createRunnerdBackend({
        db: leaseDb(first),
        execution: first,
        runnerInstanceId: "runner-session-concurrent-first",
      }),
    ).resolves.toBeDefined();
    expect(concurrentAttempt).not.toBeNull();
    await expect(concurrentAttempt!).rejects.toThrow(
      "native_session_supervisor_busy",
    );
  });

  it("uses the remote workspace for both the runner backend and native session", async () => {
    const remoteCwd = "/home/daytona/paperclip-workspace";
    const remoteExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-remote-workspace-test" },
      task: {
        identifier: "DOT-REMOTE",
        title: "Remote workspace test",
        description: null,
        prompt: "Verify the remote workspace.",
        workMode: "standard",
      },
      workspace: {
        cwd: "/host/paperclip-workspace",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "remote-workspace-session",
        driverKind: "codex_app_server",
        protocolVersion: 2,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: {
        kind: "codex",
        model: null,
        approvalPolicy: "never",
      },
      executionMode: "default",
      planningContext: null,
      interactionResponses: [],
      credentialBindings: [],
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();
    state.execute.mockReset().mockResolvedValue({
      result: { summary: "completed" },
      terminal: { runTerminalState: "succeeded" },
      turnId: "turn",
      normalizedSessionId: "session",
      providerSessionId: null,
      driverKind: "test",
      driverVersion: "1",
      nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
    });

    await executePaperclipNativeSession({
      db: leaseDb(remoteExecution),
      execution: remoteExecution,
      runnerInstanceId: "runner",
      useRunnerd: true,
      runnerExecutionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd,
        spec: {
          host: "runner.internal",
          port: 22,
          username: "runner",
          remoteWorkspacePath: remoteCwd,
          remoteCwd,
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      runnerPublicUrl: "wss://paperclip.example.test",
    });

    expect(state.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ cwd: remoteCwd }),
      }),
      expect.objectContaining({
        workingDirectoryAuthority: "remote_runner",
      }),
    );
    expect(state.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          workspace: expect.objectContaining({ cwd: remoteCwd }),
        }),
      }),
    );
    const backendOptions = state.createBackend.mock.calls[0]![1];
    state.createTransport.mockClear();
    backendOptions.codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerBinary: "/tmp/paperclip-runnerd",
        environment: expect.objectContaining({
          PAPERCLIP_WORKSPACE_CWD: remoteCwd,
        }),
      }),
    );
    const sshTransportOptions = state.createTransport.mock.calls[0]![0] as {
      environment: NodeJS.ProcessEnv;
    };
    expect(
      sshTransportOptions.environment.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX,
    ).toBeUndefined();
    expect(state.createTransport.mock.calls[0]![0].runnerBinary).not.toBe(
      `${remoteCwd}/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd`,
    );
  });

  it("archives failover evidence with an explicitly replaced provider session", async () => {
    const remoteCwd = join(isolatedStateDirectory, "remote");
    const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
      if (command.args?.[0] === "--build-metadata") return {
        exitCode: 0, timedOut: false, stdout: JSON.stringify({
          schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
          packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
          durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
          prpTransportModes: ["listen_ws"],
        }), stderr: "",
      };
      if (command.args?.[0] === "--version") return {
        exitCode: 0, timedOut: false, stdout: "codex-cli 0.160.0", stderr: "",
      };
      if (command.args?.[1]?.includes("base64")) return {
        exitCode: 1, timedOut: false, stdout: "", stderr: "",
      };
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    });
    let prepareReplacement!: () => Promise<void>;
    const replacement = { close: vi.fn(async () => undefined) };
    const openSession = vi.fn(async () => {
      await prepareReplacement();
      return replacement;
    });
    state.createBackend.mockReturnValueOnce({ kind: "test", openSession } as never);
    const backend = await createRunnerdBackend({
      db: leaseDb(execution), execution, runnerInstanceId: "runner-replacement",
      runnerIngressAuthorized: true,
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", remoteCwd, environmentId: "environment",
        leaseId: "lease-created", providerKey: "daytona", reusableLeaseConfigured: true,
        effectiveCapabilities: { runnerWebSocketIngress: true },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "sandbox-created" },
        runner: { execute: remoteExecute, syncIn: vi.fn(async () => undefined) },
      } as never,
    });
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const options = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
      prepareExternalRunnerState: () => Promise<void>;
    };
    prepareReplacement = options.prepareExternalRunnerState;
    const root = options.stateDirectory!;
    for (const name of ["current", "previous"]) {
      await mkdir(join(root, "failover-backups", name), { recursive: true });
      await writeFile(join(root, "failover-backups", name, "manifest.json"), JSON.stringify({ priorSession: name }));
    }
    // Ambiguous ordinary recovery must still fail closed. Only the runtime's
    // explicitly admitted replacement may retire these prior-session backups.
    await expect(prepareReplacement()).rejects.toThrow("runner_harness_state_mismatch: backup_without_reusable_lease");
    await expect(backend.openReplacementSession!({
      identity: { runId: execution.binding.runId }, workingDirectory: execution.workspace.cwd,
    } as never, {} as never)).resolves.toBe(replacement);
    expect(openSession).toHaveBeenCalledOnce();
    await expect(access(join(root, "failover-backups"))).rejects.toThrow();
    const archives = await readdir(join(root, "continuity-breaks"));
    expect(archives).toHaveLength(1);
    for (const name of ["current", "previous"]) {
      expect(JSON.parse(await readFile(join(root, "continuity-breaks", archives[0]!, "failover-backups", name, "manifest.json"), "utf8")))
        .toEqual({ priorSession: name });
    }
  });

  it.each(["fresh", "existing_state", "symlink_parent", "wrong_identity", "connected", "pending_turn", "remote_probe_failed", "backup_present"])(
    "bootstraps only an untouched provider session in a resumed workspace lease: %s", async (scenario) => {
    const remoteCwd = join(isolatedStateDirectory, "remote");
    const runtimeRoot = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
    await mkdir(runtimeRoot, { recursive: true });
    const sessionRoot = join(runtimeRoot, "sessions", createHash("sha256").update(execution.session.normalizedSessionId!).digest("hex"));
    if (scenario === "existing_state") await mkdir(sessionRoot, { recursive: true });
    if (scenario === "symlink_parent") await symlink(isolatedStateDirectory, join(runtimeRoot, "sessions"));
    const syncIn = vi.fn(async () => undefined);
    const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
      if (command.args?.[2] === "paperclip-runner-claim-unstarted-session") {
        let exitCode = 1;
        if (scenario !== "remote_probe_failed") {
          try { execFileSync("sh", command.args, { stdio: "pipe" }); exitCode = 0; } catch {}
        }
        return { exitCode, timedOut: false, stdout: "", stderr: "" };
      }
      if (command.args?.[0] === "--build-metadata") return {
        exitCode: 0, timedOut: false, stdout: JSON.stringify({
          schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
          packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
          durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
          prpTransportModes: ["listen_ws"],
        }), stderr: "",
      };
      if (command.args?.[0] === "--version") return {
        exitCode: 0, timedOut: false, stdout: "codex-cli 0.160.0", stderr: "",
      };
      if (command.args?.[2] === "paperclip-runner-launch") {
        throw new Error("fixture_stop_after_launch_staging");
      }
      if (command.args?.[1]?.includes("base64")) return {
        exitCode: 1, timedOut: false, stdout: "", stderr: "",
      };
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    });
    const runtimeContext = nativeRuntimeContextFixture();
    const executionWithContext = { ...execution, runtimeContext };
    const backend = await createRunnerdBackend({
      db: leaseDb(execution), execution: executionWithContext, runnerInstanceId: "runner-new-in-retained-workspace",
      runnerIngressAuthorized: true,
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", remoteCwd, environmentId: "environment",
        leaseId: "lease-resumed", providerKey: "daytona",
        effectiveCapabilities: { runnerWebSocketIngress: true },
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "sandbox-retained" },
        runner: { execute: remoteExecute, syncIn },
      } as never,
    });
    expect(backend).toBeDefined();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const options = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
      prepareExternalRunnerState: () => Promise<void>;
      runnerProcessLauncher: ReturnType<typeof createRemoteRunnerProcessLauncher>;
    };
    await mkdir(join(options.stateDirectory!, "control-plane"), { recursive: true });
    await writeFile(join(options.stateDirectory!, "control-plane", "control-plane-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.control-plane-state.v1",
      identity: { ...options.prpIdentity, ...(scenario === "wrong_identity" ? { runId: "other-run" } : {}) },
      connectionCount: scenario === "connected" ? 1 : 0, committedEvents: [],
      commands: [{ type: "run.prepare", status: "pending" }, { type: scenario === "pending_turn" ? "turn.start" : "session.open", status: "pending" }],
    }));
    if (scenario === "backup_present") {
      await mkdir(join(options.stateDirectory!, "failover-backups", "current"), { recursive: true });
      await writeFile(join(options.stateDirectory!, "failover-backups", "current", "manifest.json"), "{}");
    }
    if (scenario === "fresh") {
      await expect(options.prepareExternalRunnerState()).resolves.toBeUndefined();
      expect(remoteExecute.mock.calls.some(([command]) => command.args?.[1]?.includes("install -d"))).toBe(false);
      expect(syncIn).not.toHaveBeenCalled();
      const claimCommand = remoteExecute.mock.calls.find(([command]) => command.args?.[2] === "paperclip-runner-claim-unstarted-session")![0];
      expect((await lstat(sessionRoot)).mode & 0o777).toBe(0o700);
      // The exact same claim cannot silently reopen an existing partial root.
      expect(() => execFileSync("sh", claimCommand.args!, { stdio: "pipe" })).toThrow();
      // Authority rotation prepares history before Codex's resume path writes
      // the current invocation's launch files. The actual launch must stage
      // those files without trying to claim/restore the session a second time.
      const home = join(options.stateDirectory!, "codex-home");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "auth.json"), "fixture-current-credential");
      await writeFile(join(home, "config.toml"), "fixture-current-config");
      await writeFile(join(options.stateDirectory!, "runtime-context.json"), JSON.stringify(runtimeContext));
      syncIn.mockClear();
      await expect(options.prepareExternalRunnerState()).resolves.toBeUndefined();
      expect(syncIn).not.toHaveBeenCalled();
      const launched = options.runnerProcessLauncher({
        command: "/controller/paperclip-runnerd", args: [], cwd: "/controller", environment: {},
      });
      await expect(launched.completion).rejects.toThrow("fixture_stop_after_launch_staging");
      for (const name of ["auth.json", "config.toml"]) {
        expect(syncIn).toHaveBeenCalledWith([expect.objectContaining({
          files: [expect.objectContaining({ sourcePath: join(home, name), kind: "file", mode: 0o600 })],
        })]);
      }
      expect(syncIn.mock.calls.flat(2).flatMap((entry: { files: Array<{ sourcePath: string }> }) => entry.files)
        .filter((file: { sourcePath: string }) => file.sourcePath === runtimeContext.instructions.bundle.rootPath)).toHaveLength(1);
      expect(syncIn).toHaveBeenCalledWith([expect.objectContaining({
        files: [expect.objectContaining({ sourcePath: join(options.stateDirectory!, "runtime-context.json"), kind: "file" })],
      })]);
      expect(remoteExecute.mock.calls.filter(([command]) => command.args?.[2] === "paperclip-runner-claim-unstarted-session")).toHaveLength(1);
    } else {
      await expect(options.prepareExternalRunnerState()).rejects.toThrow("runner_harness_state_mismatch");
      expect(remoteExecute.mock.calls.some(([command]) => command.args?.[1]?.includes("install -d"))).toBe(false);
    }
  });

  it.each([
    ...["current", "preinstalled-exact", "preinstalled-mismatch", "preinstalled-error", "preinstalled-timeout", "stale", "missing", "retained", "retained-mismatch", "retained-error", "retained-timeout", "retained-explicit"]
      .map((image) => ({ image, version: "0.160.0", compatible: true })),
    ...["0.149.0", "0.149.1", "0.153.4", "0.156.0", "0.160.1"]
      .map((version) => ({ image: "current", version, compatible: true })),
    ...["0.148.9", "0.161.0", "1.0.0", "0.160.0-alpha.1", "unknown"]
      .map((version) => ({ image: "current", version, compatible: false })),
  ])("uses shared Codex and the server-owned replacement artifact (image=$image, Codex=$version)", async ({ image, version, compatible }) => {
    const retained = image.startsWith("retained");
    const exactRetained = image === "retained" || image === "retained-explicit";
    const needsReplacement = image !== "current" && image !== "preinstalled-exact" && !exactRetained;
    // The mocked remote executes metadata probes; artifact staging only needs bytes.
    // Keep this regression independent of a locally compiled Rust runner binary.
    const controllerArtifact = join(isolatedStateDirectory, "paperclip-runnerd");
    if (needsReplacement || retained || image === "preinstalled-exact") {
      await writeFile(controllerArtifact, "fixture runner artifact");
      state.resolveRunnerBinary.mockReturnValueOnce(controllerArtifact);
    }
    const onLog = vi.fn(async () => undefined);
    const syncIn = vi.fn(async () => undefined);
    const remoteExecute = vi.fn(
      async (command: { command: string; args?: string[] }) => {
        let stdout = "";
        const script = command.args?.[1] ?? "";
        if (script.includes('sha256sum "$1"')) {
          if (image.endsWith("-error")) throw new Error("checksum unavailable");
          return {
            exitCode: 0, signal: null, timedOut: image.endsWith("-timeout"), stderr: "",
            stdout: `${createHash("sha256").update(image.endsWith("-mismatch") ? "stale artifact" : "fixture runner artifact").digest("hex")}  ${command.args?.[3]}\n`,
          };
        } else if (command.args?.[0] === "--build-metadata") {
          stdout = JSON.stringify({
            schema: "paperclip-runner/runnerd-build-metadata/v1",
            binaryName: "paperclip-runnerd",
            packageName: "@paperclipai/paperclip-runner",
            binaryContractVersion: 2,
            durableSessionCapabilities: (image === "stale" || retained) && command.command === "/usr/local/bin/paperclip-runnerd"
              ? undefined
              : ["unlimited_runtime", "connection_lease_renewal"],
            prpTransportModes: ["listen_ws"],
          });
        } else if (command.args?.[0] === "--version") {
          if (
            command.command.endsWith(
              "/.paperclip-runtime/paperclip-runner/bin/codex",
            )
          ) {
            throw new Error("reached-preinstalled-codex-verification");
          }
          stdout = `codex-cli ${version}`;
        } else if (script === "uname -s; uname -m") {
          stdout = `${process.platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "arm64" ? "arm64" : "x86_64"}\n`;
        } else if (script.includes("command -v paperclip-runnerd")) {
          stdout = image === "missing" ? "" : "/usr/local/bin/paperclip-runnerd\n";
        } else if (script.includes("command -v codex")) {
          stdout = script.includes("/opt/paperclip-runner/bin/codex")
            ? "/opt/paperclip-runner/bin/codex\n"
            : "/usr/local/bin/codex\n";
        } else if (
          !script.includes("ln -sfn") &&
          !script.includes("paperclip_codex_launcher_tmp")
        ) {
          throw new Error(`unexpected command: ${command.command}`);
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout,
        };
      },
    );
    await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-image-runtime",
      onLog,
      ...(image === "retained-explicit" ? { runnerRemoteBinaryPath: controllerArtifact } : {}),
      runnerIngressAuthorized: true,
      runnerExecutionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        environmentId: "environment",
        leaseId: "lease",
        ...(retained ? { sandboxLeaseAcquisition: { outcome: "resumed" }, reusableLeaseConfigured: true } : {}),
        providerKey: "daytona",
        effectiveCapabilities: { runnerWebSocketIngress: true },
        runner: { execute: remoteExecute, syncIn },
      } as never,
    });
    state.createTransport.mockClear();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const transport = state.createTransport.mock
      .calls[0]![0] as RunnerTransportOptions & {
      controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
    };
    await expect(transport.controlPlaneRegistration({})).rejects.toThrow(
      compatible ? "reached-preinstalled-codex-verification" : "runner_remote_provider_artifact_incompatible: supported Codex versions >=0.149.0 <0.161.0",
    );
    if (!compatible) {
      expect(syncIn).not.toHaveBeenCalled();
      expect(remoteExecute.mock.calls.some(([call]) => call.command === "npm" || call.args?.[1]?.includes("paperclip_codex_launcher_tmp"))).toBe(false);
      expect(onLog).not.toHaveBeenCalledWith("stderr", expect.stringContaining("using compatible Codex"));
      return;
    }
    if (version !== "0.160.0") {
      expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining(`using compatible Codex ${version}`));
    }
    if (needsReplacement) {
      expect(transport.runnerBinary).toBe(controllerArtifact);
      expect(syncIn).toHaveBeenCalledTimes(1);
      expect(syncIn).toHaveBeenCalledWith([expect.objectContaining({
        files: [expect.objectContaining({
          sourcePath: controllerArtifact,
          targetPath: "/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd",
        })],
      })]);
    } else {
      expect(syncIn).not.toHaveBeenCalled();
    }
    if (exactRetained) {
      expect(remoteExecute.mock.calls.some(([call]) => call.args?.[1]?.includes("command -v paperclip-runnerd"))).toBe(false);
      expect(remoteExecute).toHaveBeenCalledWith(expect.objectContaining({
        command: "/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd",
        args: ["--build-metadata"],
      }));
    }
    expect(remoteExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/opt/paperclip-runner/bin/codex",
        args: ["--version"],
      }),
    );
    expect(
      remoteExecute.mock.calls.some(([call]) => call.command === "npm"),
    ).toBe(false);
  });

  it.each([
    ...[
      { version: "0.156.0", model: "gpt-6.1-sol", floor: "0.159.0" },
      { version: "0.158.0", model: "gpt-6.1-sol", floor: "0.159.0" },
      { version: "0.156.0", model: "gpt-6-sol", floor: "0.157.0" },
      { version: "0.156.0", model: "gpt-6-luna", floor: "0.157.0" },
      { version: "0.159.0", model: "gpt-6.1-sol", floor: null },
      { version: "0.160.0", model: "gpt-6.1-sol", floor: null },
      { version: "0.157.0", model: "gpt-6-sol", floor: null },
      { version: "0.156.0", model: "gpt-5.6-sol", floor: null },
      { version: "0.156.0", model: null, floor: null },
    ].map((scenario) => ({ ...scenario, recover: false })),
    { version: "0.156.0", model: "gpt-6.1-sol", floor: null, recover: true },
    { version: "0.158.0", model: "gpt-6.1-sol", floor: null, recover: true },
  ])("verifies sandbox Codex $version against the prepared $model selection (floor=$floor, recover=$recover)", async ({ version, model, floor, recover }) => {
    // A preinstalled Codex inside the compatibility window can still be too
    // old for the configured model: the ChatGPT backend rejects every turn
    // with "not supported when using Codex with a ChatGPT account". The
    // verifier names the stale image instead of letting the run fail as an
    // account problem.
    const preparedModel = recover ? resolvePaperclipRunnerNativeProviderInput({
      backend: "codex_app_server", adapterConfig: { provider: "codex", model }, codexCliVersion: version,
    }).model : model;
    const gatedExecution = {
      ...execution,
      provider: { kind: "codex", model: preparedModel, approvalPolicy: "never" },
      binding: { ...execution.binding, runId: `run-codex-floor-${version}-${model ?? "default"}` },
    } as NativeExecutionInputV1;
    const onLog = vi.fn(async () => undefined);
    const syncIn = vi.fn(async () => undefined);
    const remoteExecute = vi.fn(
      async (command: { command: string; args?: string[] }) => {
        let stdout = "";
        const script = command.args?.[1] ?? "";
        if (command.args?.[0] === "--build-metadata") {
          stdout = JSON.stringify({
            schema: "paperclip-runner/runnerd-build-metadata/v1",
            binaryName: "paperclip-runnerd",
            packageName: "@paperclipai/paperclip-runner",
            binaryContractVersion: 2,
            durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
            prpTransportModes: ["listen_ws"],
          });
        } else if (command.args?.[0] === "--version") {
          if (command.command.endsWith("/.paperclip-runtime/paperclip-runner/bin/codex")) {
            throw new Error("reached-preinstalled-codex-verification");
          }
          stdout = `codex-cli ${version}`;
        } else if (script === "uname -s; uname -m") {
          stdout = `${process.platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "arm64" ? "arm64" : "x86_64"}\n`;
        } else if (script.includes("command -v paperclip-runnerd")) {
          stdout = "/usr/local/bin/paperclip-runnerd\n";
        } else if (script.includes("command -v codex")) {
          stdout = "/opt/paperclip-runner/bin/codex\n";
        } else if (!script.includes("ln -sfn") && !script.includes("paperclip_codex_launcher_tmp")) {
          throw new Error(`unexpected command: ${command.command}`);
        }
        return { exitCode: 0, signal: null, timedOut: false, stderr: "", stdout };
      },
    );
    await createRunnerdBackend({
      db: leaseDb(gatedExecution),
      execution: gatedExecution,
      runnerInstanceId: "runner-image-runtime",
      onLog,
      runnerIngressAuthorized: true,
      runnerExecutionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        environmentId: "environment",
        leaseId: "lease",
        providerKey: "daytona",
        effectiveCapabilities: { runnerWebSocketIngress: true },
        runner: { execute: remoteExecute, syncIn },
      } as never,
    });
    state.createTransport.mockClear();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const transport = state.createTransport.mock
      .calls[0]![0] as RunnerTransportOptions & {
      controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
    };
    if (recover) {
      expect(state.createBackend.mock.calls.at(-1)![0].provider.model).toBe(
        version === "0.158.0" ? "gpt-6-sol" : "gpt-5.6-sol",
      );
    }
    await expect(transport.controlPlaneRegistration({})).rejects.toThrow(
      floor
        ? `runner_remote_provider_artifact_incompatible: ${model} requires Codex ${floor} or newer with ChatGPT sign-in, received ${version} from the sandbox image; promote a sandbox image with Codex 0.160.0 or configure PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC=@openai/codex@0.160.0`
        : "reached-preinstalled-codex-verification",
    );
    if (floor) {
      // No npm spec is configured, so there is no fallback install; the run
      // fails before launch instead of running against the stale CLI.
      expect(remoteExecute.mock.calls.some(([call]) => call.command === "npm")).toBe(false);
      expect(remoteExecute.mock.calls.some(([call]) => call.args?.[1]?.includes("paperclip_codex_launcher_tmp"))).toBe(false);
    }
  });

  it.each([
    { owner: true, status: "succeeded", expected: "retained_warm_runner" },
    { owner: false, status: "succeeded", expected: "terminal_state_indeterminate" },
    { owner: true, status: "running", expected: "active" },
  ])("requires exact idle ownership for remote computer state ($owner, $status)", async ({ owner, status, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-remote-warm-state-"));
    const prior = execution;
    const current = { ...execution, binding: { ...execution.binding, runId: "next-computer-run" } };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [
      { status, runnerProfileJson: { nativeExecutionInput: prior } },
    ] }) }) }) } as unknown as Db;
    try {
      expect(await verifyPriorRunnerdStateForSessionScope({
        db, root, execution: current,
        identity: { runId: prior.binding.runId, normalizedSessionId: prior.session.normalizedSessionId!,
          runnerInstanceId: "computer-runner", environmentLeaseId: "computer-lease" },
        allowVerifiedBackup: false, remoteRunnerState: true, allowRetainedWarmRunner: owner,
      })).toBe(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { condition: "retired", expected: "verified" },
    { condition: "workspace-coordinate", expected: "verified" },
    { condition: "wrong-workspace-run", expected: "scope_mismatch" },
    { condition: "uncertain", expected: "terminal_state_indeterminate" },
    { condition: "stale-generation", expected: "terminal_state_indeterminate" },
    { condition: "wrong-placement", expected: "scope_mismatch" },
    { condition: "wrong-lease", expected: "scope_mismatch" },
    { condition: "active-run", expected: "active" },
    { condition: "unavailable", expected: "unavailable" },
    { condition: "corrupt-local", expected: "terminal_state_indeterminate" },
  ])("verifies remote idle retirement before a fresh same-session turn ($condition)", async ({ condition, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-computer-idle-retirement-"));
    const prior = execution;
    const current = { ...execution, binding: { ...execution.binding, runId: "after-idle" } };
    const owner = { computerId: "computer", ownerId: "retired-owner", generation: 2, listenerPort: 43127 };
    const descriptor = { kind: "remote-persistent", leaseId: "prior-lease", providerLeaseId: owner.ownerId,
      remoteCwd: "/remote/agent", computerId: owner.computerId, ownerGeneration: owner.generation,
      listenerPort: owner.listenerPort, placementId: "placement" };
    let leaseQuery: SQL | undefined;
    const workspaceCoordinate = ["workspace-coordinate", "wrong-workspace-run"].includes(condition);
    const db = { select: () => ({ from: (table: unknown) => ({ where: (query: SQL) => { if (table === environmentLeases) leaseQuery = query; return ({ limit: async () =>
      table === environmentLeases ? condition === "wrong-lease" ? [] : [{
        providerLeaseId: owner.ownerId,
        heartbeatRunId: condition === "wrong-workspace-run" ? "unrelated-run" : prior.binding.runId,
        metadata: { agentId: prior.binding.agentId, computerOwner: { ...owner, generation: 1 } },
      }] : [{ status: condition === "active-run" ? "running" : "succeeded",
        runnerProfileJson: { nativeExecutionInput: prior, nativeComputerWorkspace: descriptor } }],
    }); } }) }) } as unknown as Db;
    computerRetirement.isRetired.mockReset().mockImplementation(async ({ owner: requested }) => {
      if (condition === "unavailable") throw new Error("ledger unavailable");
      return condition !== "uncertain" && requested.generation === (condition === "stale-generation" ? 3 : 2);
    });
    const input = { db, root, execution: current, identity: { runId: prior.binding.runId,
      normalizedSessionId: prior.session.normalizedSessionId!, runnerInstanceId: "prior-runner",
      environmentLeaseId: workspaceCoordinate ? prior.binding.executionWorkspaceId : condition === "wrong-lease" ? "other-lease" : "initial-physical-lease" },
      allowVerifiedBackup: false, remoteRunnerState: true,
      runnerExecutionTarget: { kind: "remote", transport: "computer", environmentId: "environment",
        remoteCwd: "/remote/agent", resourceAuthority: { ...owner, ownerId: "successor-owner", generation: 1 },
        fileAuthority: { placementId: condition === "wrong-placement" ? "other-placement" : "placement" } } as never };
    try {
      if (condition === "corrupt-local") {
        await mkdir(join(root, "runner"));
        await writeFile(join(root, "runner", "runner-state.json"), "invalid state");
      }
      if (condition === "retired") {
        // Both live warm handoffs use their retained owner. After idle expiry,
        // the next turn must instead prove the exact generation was retired.
        for (let turn = 0; turn < 2; turn += 1) {
          expect(await verifyPriorRunnerdStateForSessionScope({ ...input, allowRetainedWarmRunner: true }))
            .toBe("retained_warm_runner");
        }
        expect(computerRetirement.isRetired).not.toHaveBeenCalled();
      }
      expect(await verifyPriorRunnerdStateForSessionScope({ ...input, allowRetainedWarmRunner: false })).toBe(expected);
      if (["retired", "workspace-coordinate", "uncertain", "stale-generation", "unavailable"].includes(condition)) {
        expect(computerRetirement.isRetired).toHaveBeenCalledExactlyOnceWith({
          companyId: current.binding.companyId, environmentId: "environment", agentId: current.binding.agentId,
          runId: prior.binding.runId, owner,
        });
      } else expect(computerRetirement.isRetired).not.toHaveBeenCalled();
      if (workspaceCoordinate) {
        const query = new PgDialect().sqlToQuery(leaseQuery!);
        expect(query.params).toContain(descriptor.leaseId);
        expect(query.params).not.toContain(prior.binding.executionWorkspaceId);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps computer checkpoints remote through close and the next session preparation", async () => {
    const remoteRoot = "/remote/persistent-agent";
    const runnerId = "persistent-computer-runner";
    const runnerState = { schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended", runnerInstanceId: runnerId,
      normalizedSessionId: execution.session.normalizedSessionId, runId: execution.binding.runId };
    const providerState = { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "session_open", threadId: "durable-thread",
      activeProviderTurnId: null, config: { provider: "codex", driver: "codex_app_server" } };
    const syncOut = vi.fn(async () => { throw new Error("persistent checkpoint must not copy back"); });
    const syncIn = vi.fn(async () => { throw new Error("persistent checkpoint must not restore host history"); });
    const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
      const script = command.args?.[1] ?? "";
      let stdout = "";
      if (command.args?.[0] === "--build-metadata") stdout = JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner",
        binaryContractVersion: 2, durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
      });
      else if (command.args?.[0] === "--version") stdout = "codex-cli 0.160.0";
      else if (script.includes("command -v paperclip-runnerd")) stdout = "/usr/bin/paperclip-runnerd\n";
      else if (script.includes("command -v codex")) stdout = "/usr/bin/codex\n";
      else if (script.includes("base64 <")) stdout = Buffer.from(JSON.stringify(script.endsWith("codex-provider-state.json'") ? providerState : runnerState)).toString("base64");
      if (script.includes("tar ")) throw new Error("persistent checkpoint must not archive");
      return { exitCode: 0, timedOut: false, signal: null, stdout, stderr: "" };
    });
    const target = { kind: "remote", transport: "computer", environmentId: "environment", leaseId: "lease", providerKey: "boat",
      remoteCwd: remoteRoot, listenerPort: 43127, effectiveCapabilities: { runnerWebSocketIngress: true },
      fileAuthority: { kind: "remote-persistent", root: remoteRoot, agentHome: remoteRoot, placementId: "placement" },
      runner: { execute: remoteExecute, syncIn, syncOut }, processRunner: { execute: remoteExecute, syncIn, syncOut },
      getRunnerIngressEndpoint: async () => ({ url: "wss://example.test/runner", close: async () => undefined }) };
    await createRunnerdBackend({ db: leaseDb(execution), execution, runnerInstanceId: runnerId,
      runnerIngressAuthorized: true, runnerExecutionTarget: target as never });
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const transport = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
      controlPlaneRegistration: (authority: unknown) => Promise<{ checkpoint: (settlement: string) => Promise<void> }>;
      prepareExternalRunnerState: () => Promise<void>;
    };
    const registration = await transport.controlPlaneRegistration({});
    await expect(registration.checkpoint("settled")).resolves.toBeUndefined();
    expect(remoteExecute.mock.calls.some(([command]) => command.args?.[1]?.endsWith("codex-provider-state.json'"))).toBe(true);
    await expect(transport.prepareExternalRunnerState()).resolves.toBeUndefined();
    expect(syncOut).not.toHaveBeenCalled(); expect(syncIn).not.toHaveBeenCalled();
    await expect(access(join(transport.stateDirectory!, "failover-backups", "current"))).rejects.toThrow();
  });

  it.each([
    { override: undefined, expected: "@openai/codex@0.160.0" },
    { override: "@openai/codex@0.159.0", expected: "@openai/codex@0.159.0" },
  ])("installs compatible computer Codex privately with override=$override", async ({ override, expected }) => {
    const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
      const script = command.args?.[1] ?? "";
      let stdout = "";
      if (command.args?.[0] === "--build-metadata") {
        stdout = JSON.stringify({
          schema: "paperclip-runner/runnerd-build-metadata/v1",
          binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner",
          binaryContractVersion: 2,
          durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
          prpTransportModes: ["listen_ws"],
        });
      } else if (command.args?.[0] === "--version") {
        if (command.command.includes("/harnesses/codex/")) throw new Error("reached-private-codex-verification");
        stdout = "codex-cli 0.162.1";
      } else if (script.includes("command -v paperclip-runnerd")) {
        stdout = "/usr/local/bin/paperclip-runnerd\n";
      } else if (script.includes("command -v codex")) {
        stdout = "/usr/local/bin/codex\n";
      }
      return { exitCode: 0, signal: null, timedOut: false, stderr: "", stdout };
    });
    await createRunnerdBackend({
      db: leaseDb(execution), execution, runnerInstanceId: "computer-codex-install",
      runnerIngressAuthorized: true, runnerRemoteCodexNpmSpec: override,
      runnerExecutionTarget: {
        kind: "remote", transport: "computer", remoteCwd: "/workspace",
        fileAuthority: { kind: "remote-persistent", root: "/workspace", placementId: "workspace", agentHome: "/home/user/agent" },
        environmentId: "environment", leaseId: "lease", providerKey: "boat",
        effectiveCapabilities: { runnerWebSocketIngress: true },
        runner: { execute: remoteExecute }, processRunner: { execute: remoteExecute },
      } as never,
    });
    state.createTransport.mockClear();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const transport = state.createTransport.mock.calls[0]![0] as RunnerTransportOptions & {
      controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
    };
    await expect(transport.controlPlaneRegistration({})).rejects.toThrow("reached-private-codex-verification");
    expect(remoteExecute).toHaveBeenCalledWith(expect.objectContaining({
      command: "npm",
      args: ["install", "--prefix", `/home/user/agent/.paperclip-runtime/paperclip-runner/sessions/${createHash("sha256").update(execution.session.normalizedSessionId ?? `session-${execution.binding.runId}`).digest("hex")}/harnesses/codex`, "--no-audit", "--no-fund", expected],
    }));
    expect(remoteExecute.mock.calls.filter(([command]) => command.command === "npm")).toHaveLength(1);
    expect(remoteExecute.mock.calls.some(([command]) => command.args?.includes("--global"))).toBe(false);
  });

  it("binds a remote launch to the configured controller-owned runner artifact", async () => {
    const remoteCwd = "/home/daytona/paperclip-workspace";
    const controllerArtifact = "/controller/artifacts/paperclip-runnerd";
    const remoteExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-remote-runner-artifact" },
      workspace: { ...execution.workspace, cwd: "/host/paperclip-workspace" },
    } as NativeExecutionInputV1;

    await createRunnerdBackend({
      db: leaseDb(remoteExecution),
      execution: remoteExecution,
      runnerInstanceId: "runner",
      runnerExecutionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd,
        spec: {
          host: "runner.internal",
          port: 22,
          username: "runner",
          remoteWorkspacePath: remoteCwd,
          remoteCwd,
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      runnerRemoteBinaryPath: controllerArtifact,
    });

    state.createTransport.mockClear();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ runnerBinary: controllerArtifact }),
    );
  });

  it.each([
    ["opencode", { kind: "opencode", model: null }, "opencode_server"],
    ["acpx", { kind: "acpx", agent: "codex", model: null }, "acpx_runtime"],
  ])(
    "requires a build-owned provider pack identity before launching remote %s",
    async (providerKind, provider, driverKind) => {
      state.bundledPackManifestPath = join(tmpdir(), randomUUID(), "provider-pack.json");
      const remoteCwd = "/home/daytona/paperclip-workspace";
      const remoteProviderExecution = {
        ...execution,
        binding: {
          ...execution.binding,
          runId: `run-remote-${providerKind}-rejected`,
        },
        session: {
          ...execution.session,
          normalizedSessionId: `remote-${providerKind}-rejected`,
          driverKind,
        },
        provider,
      } as unknown as NativeExecutionInputV1;
      state.createBackend.mockClear();

      await expect(
        createRunnerdBackend({
          db: leaseDb(remoteProviderExecution),
          execution: remoteProviderExecution,
          runnerInstanceId: "runner",
          runnerExecutionTarget: {
            kind: "remote",
            transport: "ssh",
            remoteCwd,
            spec: {
              host: "runner.internal",
              port: 22,
              username: "runner",
              remoteWorkspacePath: remoteCwd,
              remoteCwd,
              privateKey: null,
              knownHosts: null,
              strictHostKeyChecking: true,
            },
          },
        }),
      ).rejects.toThrow(providerKind === "opencode"
        ? "runner_remote_provider_artifact_incompatible: provider-pack.json is unreadable"
        : "runner_remote_provider_artifact_incompatible: configure PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH",
      );
      expect(state.createBackend).not.toHaveBeenCalled();
    },
  );

  it("passes the isolated ACPX runtime directory to the native backend factory", async () => {
    const acpxExecution = {
      ...execution,
      schema: "paperclip.native-execution-input.v4",
      task: {
        identifier: "DOT-ACPX",
        title: "ACPX task",
        description: null,
        prompt: "Complete the ACPX task.",
        workMode: "standard",
      },
      workspace: {
        cwd: "/tmp/acpx-native",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: "acpx-session",
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: {
        kind: "acpx",
        agent: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "approve-reads",
        profile: {
          driverKind: "acpx_runtime",
          protocolVersion: 1,
          acpxVersion: "0.13.1",
          agent: "codex",
          agentProfileVersion: 1,
          agentServerPackage: "@agentclientprotocol/codex-acp",
          agentServerVersion: "1.6.2",
          agentRuntimePackage: null,
          agentRuntimeVersion: null,
          commandDigest: "sha256:test",
        },
      },
      executionMode: "default",
      planningContext: null,
      interactionResponses: [],
      credentialBindings: [],
      runtimeContext: nativeRuntimeContextFixture(),
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();
    const onSpawn = vi.fn(async () => undefined);
    await createRunnerdBackend({
      db: leaseDb(acpxExecution),
      execution: acpxExecution,
      runnerInstanceId: "runner",
      onSpawn,
    });

    expect(state.createBackend).toHaveBeenCalledWith(
      acpxExecution,
      expect.objectContaining({
        acpxRuntimeDirectory: expect.stringContaining(
          "/runtime/paperclip-runner/acpx",
        ),
        acpxDynamicToolHandler: expect.any(Function),
      }),
    );
    state.createTransport.mockClear();
    state.createBackend.mock.calls[0]![1].codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "acpx",
        acpxAgent: "codex",
        acpxPermissionMode: "approve-reads",
        onSpawn,
      }),
    );
  });

  it("passes the persisted OpenCode permission mode to runnerd", async () => {
    const opencodeExecution = {
      ...execution,
      schema: "paperclip.native-execution-input.v4",
      binding: { ...execution.binding, runId: "run-opencode-permissions" },
      session: {
        ...execution.session,
        normalizedSessionId: "opencode-permissions-session",
        driverKind: "opencode_server",
      },
      provider: {
        kind: "opencode",
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        permissionMode: "deny",
      },
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();
    await createRunnerdBackend({
      db: leaseDb(opencodeExecution),
      execution: opencodeExecution,
      runnerInstanceId: "runner",
    });

    state.createTransport.mockClear();
    state.createBackend.mock.calls[0]![1].codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        opencodePermissionMode: "deny",
      }),
    );
  });
});

// Terminal wrapping must never turn an authorization/integrity failure into a safe replacement.
it.each([
  "tool_binding_mismatch",
  "thread_binding_mismatch",
  "turn_binding_mismatch",
  "conflicting_semantic_result",
  "provider_event_type_invalid",
])("keeps %s operator-owned through terminal propagation", (code) => {
  expect(
    nativeSessionFailureSourceCode(
      new NativeProviderTerminalFailure(code, false),
    ),
  ).toBe("native_event_replay_conflict");
});


describe("computer provider-pack bootstrap policy", () => {
  it.each([
    ["acpx", "computer", 1_800_000],
    ["codex", "computer", undefined],
    ["opencode", "computer", undefined],
    ["acpx", "sandbox", undefined],
    ["acpx", "ssh", undefined],
    ["acpx", "local", undefined],
  ] as const)("bounds only %s on %s", (provider, transport, expected) => {
    const target = transport === "local" ? undefined : { kind: "remote" as const, transport };
    expect(nativeSessionBootstrapTimeoutMs(provider, target)).toBe(expected);
  });
});

describe("computer idle authority transition", () => {
  function settled() {
    const identity = { runId: execution.binding.runId, normalizedSessionId: execution.session.normalizedSessionId!,
      runnerInstanceId: "prior-runner", environmentLeaseId: "prior-lease", turnId: "turn", itemId: "item" };
    const current = { ...execution, binding: { ...execution.binding, runId: "next-run" } };
    const checkpoint = { driverKind: "codex_app_server", providerSessionId: "thread", activeTurnId: null,
      pendingRuntimeRequests: [], identity: { ...execution.binding, sessionId: execution.session.normalizedSessionId } };
    return { identity, execution: current, priorExecution: execution,
      runner: { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: [], pendingTerminalDelivery: null },
      control: { identity, commands: [{ status: "completed" }], committedEvents: [{ eventType: "run.terminal", envelope: identity }] },
      provider: { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "session_open", threadId: "thread",
        config: { provider: "codex", driver: "codex_app_server" }, activeProviderTurnId: null, completedTurnAuthoritative: true },
      checkpoint, currentCheckpoint: { ...checkpoint, identity: { ...checkpoint.identity, runId: current.binding.runId } } };
  }

  it("requires a terminal provider checkpoint with matching prior and successor scope", () => {
    expect(retiredComputerCheckpointIsSettled(settled())).toBe(true);
  });
  it.each(["pending-command", "pending-event", "unsettled-provider", "wrong-run", "wrong-thread", "active-turn", "config-change", "acpx"])(
    "does not manufacture suspension from %s evidence", (condition) => {
      const input = settled();
      if (condition === "pending-command") input.control.commands[0]!.status = "pending";
      if (condition === "pending-event") (input.runner.outbox as unknown[]).push({ event: "unacked" });
      if (condition === "unsettled-provider") input.provider.completedTurnAuthoritative = false;
      if (condition === "wrong-run") input.currentCheckpoint.identity.runId = "foreign";
      if (condition === "wrong-thread") input.currentCheckpoint.providerSessionId = "foreign";
      if (condition === "active-turn") Object.assign(input.currentCheckpoint, { activeTurnId: "active" });
      if (condition === "config-change") input.execution = { ...input.execution, provider: { ...input.execution.provider, model: "changed" } };
      if (condition === "acpx") input.execution = { ...input.execution, provider: { ...input.execution.provider, kind: "acpx" } } as typeof input.execution;
      expect(retiredComputerCheckpointIsSettled(input)).toBe(false);
    });

  it.each(["unchanged", "runner-changed", "provider-changed", "symlink", "interrupted"])(
    "atomically seals only the unchanged remote bytes (%s)", async (condition) => {
      const root = await mkdtemp(join(tmpdir(), "computer-retired-cas-"));
      const runnerPath = join(root, "runner.json"), providerPath = join(root, "provider.json");
      const runnerBytes = Buffer.from(JSON.stringify(settled().runner)), providerBytes = Buffer.from(JSON.stringify(settled().provider));
      await writeFile(runnerPath, runnerBytes); await writeFile(providerPath, providerBytes);
      const runner = { execute: async (command: { command: string; args?: string[] }) => {
        if (condition === "runner-changed") await writeFile(runnerPath, JSON.stringify({ lifecycle: "active" }));
        if (condition === "provider-changed") await writeFile(providerPath, JSON.stringify({ activeTurn: "new" }));
        if (condition === "symlink") { await rm(runnerPath); await symlink(providerPath, runnerPath); }
        if (condition === "interrupted") return { exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" };
        try { return { exitCode: 0, signal: null, timedOut: false, stderr: "", stdout: execFileSync(command.command, command.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
        catch { return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "CAS refused" }; }
      } };
      try {
        const action = compareAndSealRetiredComputerCheckpoint({ runner: runner as never, runnerPath, providerPath, runnerBytes, providerBytes });
        if (condition === "unchanged") {
          await expect(action).resolves.toBeUndefined();
          expect(JSON.parse(await readFile(runnerPath, "utf8"))).toEqual({ ...settled().runner, lifecycle: "suspended" });
        } else {
          await expect(action).rejects.toThrow("runner_remote_retirement_checkpoint_cas_failed");
          expect(JSON.parse(await readFile(runnerPath, "utf8")).lifecycle).not.toBe("suspended");
        }
        expect((await readdir(root)).filter(name => name.startsWith(".retired-checkpoint-"))).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

  it.each(["unlaunched", "launched", "claimed", "unknown", "superseded"])(
    "permits same-run admission retry only after exact prelaunch retirement (%s)", async condition => {
      let active = true;
      const retire = vi.fn(async () => { if (condition === "superseded") return false; active = false; return true; });
      const inspectProcess = vi.fn(async () => {
        if (condition === "unknown") throw new Error("inspection unavailable");
        return { running: false, claim: condition === "claimed" ? { nonce: "prior-process" } : null };
      });
      const target = { kind: "remote", transport: "computer", inspectProcess, retire } as never;
      const action = retireUnlaunchedComputerAttempt(target, condition === "launched");
      if (["unknown", "superseded"].includes(condition)) await expect(action).rejects.toThrow();
      else await expect(action).resolves.toBeUndefined();
      const admitSameRun = () => { if (active) throw new Error("Computer session already has an active turn"); };
      if (condition === "unlaunched") expect(admitSameRun).not.toThrow();
      else expect(admitSameRun).toThrow("active turn");
      if (["launched", "claimed", "unknown"].includes(condition)) expect(retire).not.toHaveBeenCalled();
    });
});

describe("computer graceful idle reservation", () => {
  it.each(["codex", "acpx"])("suspends %s before retiring descendants and admits the next idle turn", async kind => {
    const name = `graceful-idle-${kind}`;
    const current = { ...execution, binding: { ...execution.binding, runId: `${name}-one`, agentId: name },
      provider: kind === "codex" ? execution.provider : { kind: "acpx", agent: "claude", model: null },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
    let phase = "active";
    let checkpoint = "ready";
    const close = vi.fn(async () => { expect(phase).toBe("retiring"); checkpoint = "suspended"; });
    const target = { kind: "remote", transport: "computer", environmentId: name, remoteCwd: "/remote/agent",
      resourceAuthority: { kind: "computer-owner", computerId: name, ownerId: name, generation: 1 },
      retainWarm: async () => { phase = "warm"; },
      retire: vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => {
        phase = "retiring";
        await options?.beforeStop?.();
        expect(checkpoint).toBe("suspended");
        phase = "retired";
        return true;
      }) };
    const result = { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: name,
      normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1", nativeEventCount: 1,
      highestContiguousSourceSeq: 1, usage: null };
    state.execute.mockReset().mockImplementationOnce(async options => { await options.onSession?.({ close }); return result; })
      .mockImplementationOnce(async options => { expect(options.existingSession).toBeUndefined(); expect(checkpoint).toBe("suspended"); return result; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name, runnerExecutionTarget: target as never });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(phase).toBe("retired"); expect(close).toHaveBeenCalledOnce();
      const next = { ...current, binding: { ...current.binding, runId: `${name}-two` } };
      await executePaperclipNativeSession({ db: leaseDb(next), execution: next, runnerInstanceId: `${name}-fresh`,
        runnerExecutionTarget: { ...target, resourceAuthority: { ...target.resourceAuthority, ownerId: "new-owner" } } as never });
    } finally { vi.useRealTimers(); }
  });

  it.each(["failed-close", "expired-reservation", "superseded"])("does not report clean close when %s", async condition => {
    const name = `graceful-${condition}`;
    const current = { ...execution, binding: { ...execution.binding, runId: name, agentId: name },
      session: { ...execution.session, normalizedSessionId: name, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } } } as NativeExecutionInputV1;
    const close = vi.fn(async () => { throw new Error("protocol close failed"); });
    const detach = vi.fn(async () => undefined);
    let retired = false;
    const retire = vi.fn(async (options?: { beforeStop?: () => Promise<void> }) => {
      if (condition === "superseded") return false;
      if (condition === "failed-close") await options?.beforeStop?.().catch(() => undefined);
      retired = true;
      return true;
    });
    state.execute.mockReset().mockImplementationOnce(async options => { await options.onSession?.({ close, detachControllerForRestart: detach });
      return { result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" }, turnId: name,
        normalizedSessionId: name, providerSessionId: name, driverKind: "test", driverVersion: "1", nativeEventCount: 1,
        highestContiguousSourceSeq: 1, usage: null }; });
    await executePaperclipNativeSession({ db: leaseDb(current), execution: current, runnerInstanceId: name,
      runnerExecutionTarget: { kind: "remote", transport: "computer", environmentId: name, remoteCwd: "/remote/agent",
        resourceAuthority: { kind: "computer-owner", computerId: name, ownerId: name, generation: 1 },
        retainWarm: async () => undefined, retire } as never });
    const result = await closeWarmNativeSessionsForRun({ runId: name, reason: "cancel exact task" });
    expect(result.failed).toBe(1);
    expect(retired).toBe(condition !== "superseded");
    if (condition === "superseded") { expect(close).not.toHaveBeenCalled(); expect(detach).not.toHaveBeenCalled(); }
    else expect(detach).toHaveBeenCalledOnce();
  });
});

describe("computer managed context snapshots", () => {
  it("stages a retry into fresh immutable references without touching earlier snapshots or provider HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-context-retry-"));
    const source = join(root, "source"), agentHome = join(root, "agent-home");
    await mkdir(source); await mkdir(agentHome);
    await writeFile(join(source, "AGENTS.md"), "snapshot instruction", { mode: 0o400 });
    await chmod(source, 0o500);
    const remoteExecute = async (command: { command: string; args?: string[]; stdin?: string }) => ({
      exitCode: 0, timedOut: false, signal: null, stderr: "",
      stdout: execFileSync(command.command, command.args, { input: command.stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
    });
    const target = { kind: "remote", transport: "computer", environmentId: "snapshot-env", remoteCwd: agentHome,
      fileAuthority: { kind: "remote-persistent", agentHome, root: agentHome, placementId: "placement" },
      runner: { execute: remoteExecute }, processRunner: { execute: remoteExecute } };
    const sourceContext = nativeRuntimeContextFixture();
    sourceContext.instructions.bundle.rootPath = source;
    const run = { ...execution, binding: { ...execution.binding, agentId: "snapshot-agent", runId: "snapshot-retry" },
      runtimeContext: sourceContext };
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    const contexts: ReturnType<typeof nativeRuntimeContextFixture>[] = [];
    const homes: string[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // Factory-only fixture has no live PRP controller; isolate its local
        // journals while retaining the exact same remote session and run.
        process.env.PAPERCLIP_RUNNER_STATE_DIR = join(root, `controller-${attempt}`);
        await createRunnerdBackend({ db: leaseDb(run), execution: run, runnerInstanceId: "snapshot-runner", runnerExecutionTarget: target as never });
        state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
        const transport = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
          runnerRuntimeContext: ReturnType<typeof nativeRuntimeContextFixture>;
        };
        contexts.push(transport.runnerRuntimeContext);
        const destination = transport.runnerRuntimeContext.instructions.bundle.rootPath;
        expect(destination).toMatch(/\/context\/snapshots\/[0-9a-f-]+\/instructions$/);
        expect(transport.runnerRuntimeContext.instructions.entryPath).toBe("AGENTS.md");
        const home = remoteRunnerStorageRoots(target as never, run.session.normalizedSessionId!).sessionRoot + "/filesystem/codex-home";
        homes.push(home);
        await mkdir(home, { recursive: true });
        if (attempt === 0) await writeFile(join(home, "provider-session"), "persistent conversation");
        await stageRemoteRunnerDirectory({ target: target as never, runner: target.runner as never, sourcePath: source, targetPath: destination, mode: 0o500 });
        expect(await readFile(join(destination, "AGENTS.md"), "utf8")).toBe("snapshot instruction");
        expect((await lstat(destination)).mode & 0o777).toBe(0o500);
        expect(await readFile(join(home, "provider-session"), "utf8")).toBe("persistent conversation");
      }
      expect(contexts[0]!.instructions.bundle.rootPath).not.toBe(contexts[1]!.instructions.bundle.rootPath);
      expect(homes[0]).toBe(homes[1]);
      expect((await lstat(contexts[0]!.instructions.bundle.rootPath)).mode & 0o777).toBe(0o500);
      expect(await readFile(join(contexts[0]!.instructions.bundle.rootPath, "AGENTS.md"), "utf8")).toBe("snapshot instruction");
    } finally {
      if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      execFileSync("chmod", ["-R", "u+w", root]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["prepare-failed", "dispatch-lost-ack"])("fences prelaunch retry at the physical launch boundary (%s)", async condition => {
    let dispatched = false;
    const retire = vi.fn(async () => true);
    const inspectProcess = vi.fn(async () => ({ running: false, claim: null }));
    const launch = vi.fn(async () => { throw new Error("lost launch acknowledgement"); });
    const target = { kind: "remote", transport: "computer", remoteCwd: "/remote", launch, retire, inspectProcess };
    const launcher = createRemoteRunnerProcessLauncher({ target: target as never, runner: { execute: vi.fn() } as never,
      remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity", stateDirectory: "/runtime/state",
      diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: "physical-launch",
      ensureArtifact: async () => { if (condition === "prepare-failed") throw new Error("read-only context staging failed"); },
      onLaunchAttempt: () => { dispatched = true; },
    });
    const handle = launcher({ command: "/controller/runnerd", args: [], cwd: "/controller", environment: {} });
    await expect(handle.completion).rejects.toThrow(condition === "prepare-failed" ? "context staging failed" : "lost launch acknowledgement");
    await retireUnlaunchedComputerAttempt(target as never, dispatched);
    if (condition === "prepare-failed") { expect(launch).not.toHaveBeenCalled(); expect(retire).toHaveBeenCalledOnce(); }
    else { expect(launch).toHaveBeenCalledOnce(); expect(inspectProcess).not.toHaveBeenCalled(); expect(retire).not.toHaveBeenCalled(); }
  });
});
