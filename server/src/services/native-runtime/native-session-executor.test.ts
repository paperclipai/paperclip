import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatRuns,
  heartbeatRunEvents,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import {
  acpxRuntimeSessionDirectoryName,
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
  validatePrpStructuredRunResult,
  validatePrpEvent,
  type NativeExecutionInputV1,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nativeSha256 } from "./canonical.js";
import * as noLaunchProofModule from "./native-maintenance-no-launch.js";
import {
  NativeSessionCleanupQuarantinedError,
  NativeProviderTerminalFailure,
  NativeSessionProtocolIntegrityError,
} from "../../vendor/paperclip-runner/index.js";
import * as issueServiceModule from "../issues.js";
import {
  createNativeHarnessBackupStamp,
  verifyNativeHarnessBackupStamp,
} from "./native-harness-backup-stamp.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { buildNativeHeartbeatPreparationSpans } from "./native-run-trace.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";

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
  acpxPermissionMode?: "approve-all" | "approve-reads" | "deny-all";
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
  resolveRunnerBinary: vi.fn(() => "/tmp/paperclip-runnerd"),
  release: null as null | (() => void),
}));

vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../vendor/paperclip-runner/index.js")
  >()),
  createNativeSessionBackend: state.createBackend,
  createRunnerdCodexTransport: state.createTransport,
  executeNativeSession: state.execute,
  settleRetainedRunnerdSession: state.cleanup,
  retainedRunnerdMaintenanceIsIdle: state.maintenanceIdle,
  completeRetainedNativeSessionCleanup: state.retireCleanup,
  parsePaperclipQuestionSet: (value: unknown) => value,
}));

vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@paperclipai/adapter-codex-local/server")
  >()),
  copyBackCodexAuth: state.copyBackCodexAuth,
}));

vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
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
  buildNativeHarnessBackupManifest,
  cancelNativeSession,
  closeWarmNativeSessionsForEnvironment,
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
  nativePreProviderRetryAfterCleanupStateIsSafe,
  reconcileRetainedNativeSessionCleanup,
  retainedNativeCleanupJournalMatches,
  nativeProviderUsageLimitFromEvent,
  nativeSessionFailureSourceCode,
  nativeSessionRecoveryProjection,
  nativeGovernedWaitResult,
  nativeConversationReplyResult,
  nativeToolsRefreshWaitResult,
  parseRemoteExecutableCandidate,
  buildRemoteCodexLauncherCommand,
  mayUsePreinstalledRunnerArtifact,
  nativeUsageCostUsd,
  normalizeNativeUsage,
  parseRemoteRunnerProcessIdentity,
  readRemoteProviderPackManifest,
  providerSessionIdentityFromDurableProviderState,
  providerSessionIdentityTransitionIsAllowed,
  providerPlanMarkdown,
  remoteCheckpointIncompleteFailure,
  resolveRemoteRunnerTransportMode,
  renewNativeSessionExecutionLease,
  runtimeInputLifecycleMetric,
  runtimeQuestionFallbackFromEvent,
  resolveNativeRuntimeRequest,
  resolveNativeHarnessPersistenceProfile,
  runnerdStateProvesIncompleteBootstrap,
  semanticProviderPlanMarkdown,
  sha256DirectoryTree,
  stageRemoteRunnerDirectory,
  steerNativeSession,
  syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackup,
  shouldRestoreNativeHarnessBackupIntoSandbox,
} from "./native-session-executor.js";

beforeEach(() => {
  state.resolveCurrentWakeCommentsBinding.mockReset().mockResolvedValue(null);
  state.assertCurrentWakeCommentsRead.mockReset().mockResolvedValue(undefined);
});

describe("remote runner process supervision", () => {
  it("detaches runnerd from the provider RPC and monitors its durable identity", async () => {
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
  });

  it("terminates a detached runner when its process identity cannot be adopted", async () => {
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
              exitCode: 3,
              signal: null,
              timedOut: false,
              stdout: "",
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
        codex: "0.153.4",
        opencode: "1.18.29",
        acpx: "0.13.1",
        claudeAcp: "0.73.0",
        codexAcp: "1.6.2",
      },
      target: { platform: "linux", architecture: "x64" },
      runnerSourceRevision: "1".repeat(40),
      distDigest: sha256DirectoryTree(join(root, "dist")),
      bridgeDigest: "",
      acpxProfileDigests: {
        claude:
          "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
        codex:
          "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3",
      },
      artifacts: {
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
      "1.18.29",
    );
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
      ).toThrow("runner_harness_state_mismatch");
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

describe("remote provider checkpoint restores", () => {
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
      await writeFile(join(installation, "version.txt"), "codex-cli 0.153.4\n");
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
        ).toBe("codex-cli 0.153.4\n--version\nargument with 'quotes'\n");
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
    prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
  };

  it("accepts the current contract with the required transport", () => {
    expect(() =>
      assertRemoteRunnerBuildMetadata(current, "listen_ws"),
    ).not.toThrow();
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
                input: semanticInput,
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
      errorCode: "adapter_failed",
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
        "wrong_semantic_input",
        "wrong_contract",
        "wrong_turn",
        "missing_result_command",
        "bad_identity_hash",
        "foreign_semantic_scope",
        "wrong_provider_account",
      ].includes(mode);
      const succeeds = [
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
      payload: {},
    };

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
              : [];
      const query = {
        then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
        where: () => query,
        for: () => query,
        limit: () => Promise.resolve(rows),
      };
      return query;
    },
  });
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return { returning: async () => [values] };
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
  } | null;
  failResultJsonUpdateAt?: number;
  ownershipHeld?: boolean;
}) {
  const initialRun = {
    id: execution.binding.runId,
    agentId: execution.binding.agentId,
    companyId: execution.binding.companyId,
    nativeIssueId: execution.binding.issueId,
    runtimeMode: "native",
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

describe("native startup restart detachment", () => {
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
      options.onSession?.({
        capabilities,
        snapshot,
        resolveRuntimeRequest,
        cancel: vi.fn(),
      });
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

describe("native warm session supervision", () => {
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
      ...scenario,
    })),
  )(
    "verifies a live warm owner before refreshing run authority (broker: $firstBroker -> $secondBroker, projectless: $projectless, local: $local, auth: $firstMode -> $secondMode, network: $firstNetwork -> $secondNetwork, checkpoint: $checkpointContract)",
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
    }) => {
      const replacesProvider =
        firstBroker ||
        secondBroker ||
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
          } else {
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
          runnerExecutionTarget: remoteTarget,
        });
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

  it("replaces an idle warm provider session when its pinned permission mode changes", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstSession = { close: firstClose };
    const secondSession = { close: secondClose };
    const base = {
      ...execution,
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
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
        driverKind: "codex_app_server" as const,
        protocolVersion: 1 as const,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
      runtimeContext: { aggregateDigest: "runtime-context" },
    } as unknown as NativeExecutionInputV1;
    const lowered = {
      ...base,
      provider: { kind: "codex", model: null, approvalPolicy: "on-request" },
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
    state.execute
      .mockReset()
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(firstSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        options.onSession?.(secondSession);
        return result;
      });

    // Filesystem work between calls can exceed the idle window on a busy host.
    // Advance that window only after proving the permission change closed it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await executePaperclipNativeSession({
        db: leaseDb(base),
        execution: base,
        runnerInstanceId: "runner",
      });
      await executePaperclipNativeSession({
        db: leaseDb(lowered),
        execution: lowered,
        runnerInstanceId: "runner",
      });
      expect(firstClose).toHaveBeenCalledWith({
        reason: "warm native session configuration changed",
      });
      expect(secondClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(secondClose).toHaveBeenCalledWith({
        reason: "warm native session idle timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native session bounded recovery", () => {
  it("does not turn an acknowledged Stop before completion into a failure or a retry", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const stop: Record<string, unknown> = {};
    state.execute.mockReset().mockImplementationOnce(async () => {
      Object.assign(stop, { cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", ...execution.binding, scope: "run", reasonCode: "cancellation_run_only",
        dispatched: true, dispatchState: "acknowledged", intentAuditId: "intent", acknowledgementAuditId: "ack",
      } });
      throw new Error("native_finalization_missing: session returned no semantic result");
    });
    state.upsertRecoveryAction.mockClear();
    await expect(executePaperclipNativeSession({
      db: leaseDb(execution, {}, stop, updates), execution, runnerInstanceId: "stop-before-completion",
    })).rejects.toThrow("native_cancellation_pending_recovery");
    expect(updates.some(update => update.table === heartbeatRuns && update.values.status === "failed")).toBe(false);
    expect(updates.some(update => update.table === nativeRunFinalizations && update.values.failureCode === "native_retry_cancelled")).toBe(true);
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

  it("rejects ACPX Pi before constructing a backend", async () => {
    const piExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-acpx-pi-rejected" },
      provider: { kind: "acpx", agent: "pi", model: "pi-model" },
      session: { ...execution.session, driverKind: "acpx_runtime" },
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();

    await expect(
      executePaperclipNativeSession({
        db: leaseDb(piExecution),
        execution: piExecution,
        runnerInstanceId: "runner",
      }),
    ).rejects.toThrow("descriptor-confined verified launch");
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
    expect(close).toHaveBeenCalledOnce();
    expect(state.copyBackCodexAuth).not.toHaveBeenCalled();
    await expect(readFile(authPath, "utf8")).resolves.toBe(auth);
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

  it("migrates a suspended prior-run authority only when its persisted execution has the same full session scope", async () => {
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
      await writeFile(
        join(legacyRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(
          durableControlPlaneState({
            runId: priorExecution.binding.runId,
            normalizedSessionId: priorExecution.session.normalizedSessionId,
            runnerInstanceId: "runner-prior-run-scope",
            environmentLeaseId: "lease-prior-run-scope",
          }),
        ),
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
      ).rejects.toThrow("runner_state_identity_mismatch");
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

  it("resumes an existing scoped authority only for the exact current run", async () => {
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
      await writeFile(
        join(scopedRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(identity)),
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

  it.each(["missing", "malformed", "unknown_schema", "mismatched"] as const)(
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
          caseName === "mismatched"
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

  it.each(["fresh", "existing_state", "symlink_parent", "wrong_identity", "connected", "pending_turn", "remote_probe_failed", "backup_present"])(
    "bootstraps only an untouched provider session in a resumed workspace lease: %s", async (scenario) => {
    const remoteCwd = join(isolatedStateDirectory, "remote");
    const runtimeRoot = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
    await mkdir(runtimeRoot, { recursive: true });
    const sessionRoot = join(runtimeRoot, "sessions", createHash("sha256").update(execution.session.normalizedSessionId!).digest("hex"));
    if (scenario === "existing_state") await mkdir(sessionRoot, { recursive: true });
    if (scenario === "symlink_parent") await symlink(isolatedStateDirectory, join(runtimeRoot, "sessions"));
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
          prpTransportModes: ["listen_ws"],
        }), stderr: "",
      };
      if (command.args?.[0] === "--version") return {
        exitCode: 0, timedOut: false, stdout: "codex-cli 0.153.4", stderr: "",
      };
      if (command.args?.[1]?.includes("base64")) return {
        exitCode: 1, timedOut: false, stdout: "", stderr: "",
      };
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    });
    const backend = await createRunnerdBackend({
      db: leaseDb(execution), execution, runnerInstanceId: "runner-new-in-retained-workspace",
      runnerIngressAuthorized: true,
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", remoteCwd, environmentId: "environment",
        leaseId: "lease-resumed", providerKey: "daytona",
        effectiveCapabilities: { runnerWebSocketIngress: true },
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "sandbox-retained" },
        runner: { execute: remoteExecute },
      } as never,
    });
    expect(backend).toBeDefined();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const options = state.createTransport.mock.calls.at(-1)![0] as RunnerTransportOptions & {
      prepareExternalRunnerState: () => Promise<void>;
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
      expect(remoteExecute.mock.calls.some(([command]) => command.args?.[1]?.includes("install -d"))).toBe(true);
      const claimCommand = remoteExecute.mock.calls.find(([command]) => command.args?.[2] === "paperclip-runner-claim-unstarted-session")![0];
      expect((await lstat(sessionRoot)).mode & 0o777).toBe(0o700);
      // The exact same claim cannot silently reopen an existing partial root.
      expect(() => execFileSync("sh", claimCommand.args!, { stdio: "pipe" })).toThrow();
    } else {
      await expect(options.prepareExternalRunnerState()).rejects.toThrow("runner_harness_state_mismatch");
      expect(remoteExecute.mock.calls.some(([command]) => command.args?.[1]?.includes("install -d"))).toBe(false);
    }
  });

  it("uses the image's shared Codex without uploading or installing artifacts", async () => {
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
          stdout = "codex-cli 0.153.4";
        } else if (script.includes("command -v paperclip-runnerd")) {
          stdout = "/usr/local/bin/paperclip-runnerd\n";
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
    await expect(transport.controlPlaneRegistration({})).rejects.toThrow(
      "reached-preinstalled-codex-verification",
    );
    expect(syncIn).not.toHaveBeenCalled();
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
    "requires the build-owned provider pack before launching remote %s",
    async (providerKind, provider, driverKind) => {
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
      ).rejects.toThrow(
        "runner_remote_provider_artifact_incompatible: configure PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH",
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
