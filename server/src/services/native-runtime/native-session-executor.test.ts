import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type {
  NativeExecutionInputV1,
  PrpEvent,
} from "@paperclipai/paperclip-runner";
import { createHash } from "node:crypto";
import {
  createNativeHarnessBackupStamp,
  verifyNativeHarnessBackupStamp,
} from "./native-harness-backup-stamp.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

type BackendFactoryOptions = {
  runnerInstanceId?: string;
  acpxRuntimeDirectory?: string;
  workingDirectoryAuthority?: "local_filesystem" | "remote_runner";
  codexTransportFactory?: () => unknown;
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
  createTransport: vi.fn((_options: RunnerTransportOptions) => ({
    transport: {},
  })),
  createBackend: vi.fn(
    (_input: NativeExecutionInputV1, _options: BackendFactoryOptions) => ({
      kind: "test",
    }),
  ),
  cancel: vi.fn(),
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
  parsePaperclipQuestionSet: (value: unknown) => value,
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

vi.mock("../activity-log.js", () => ({
  persistActivity: state.persistActivity,
  publishActivity: state.publishActivity,
}));

vi.mock("./native-codex-runner.js", () => ({
  resolvePaperclipRunnerBinary: state.resolveRunnerBinary,
}));

import {
  continuingPendingInteractionIds,
  buildNativeProviderEnvironment,
  buildNativeHarnessBackupManifest,
  cancelNativeSession,
  createGovernedWaitEventObservation,
  createRunnerdBackend,
  executePaperclipNativeSession,
  getNativeSessionSteeringState,
  NativeSessionSteeringError,
  assertRemoteRunnerBuildMetadata,
  nativeSessionFailureDisposition,
  nativeSessionFailureSourceCode,
  nativeSessionRecoveryProjection,
  nativeGovernedWaitResult,
  parseRemoteExecutableCandidate,
  mayUsePreinstalledRunnerArtifact,
  nativeUsageCostUsd,
  normalizeNativeUsage,
  readRemoteProviderPackManifest,
  providerSessionIdentityTransitionIsAllowed,
  providerPlanMarkdown,
  resolveRemoteRunnerTransportMode,
  renewNativeSessionExecutionLease,
  runtimeInputLifecycleMetric,
  runtimeQuestionFallbackFromEvent,
  resolveNativeRuntimeRequest,
  resolveNativeHarnessPersistenceProfile,
  semanticProviderPlanMarkdown,
  sha256DirectoryTree,
  stageRemoteRunnerDirectory,
  steerNativeSession,
  syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackup,
  shouldRestoreNativeHarnessBackupIntoSandbox,
} from "./native-session-executor.js";

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
        codex: "0.148.0",
        opencode: "1.18.17",
        acpx: "0.13.1",
        claudeAcp: "0.70.0",
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
          "sha256:7a923b3829884d3cabcc9659d22cace3f86813e7bfffc90974b10140a45bc400",
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
      "1.18.17",
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
      excludeTopLevelEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
    });
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
      const sessionRoot = join(
        stateBase,
        createHash("sha256").update("native-session").digest("hex"),
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
        normalizedSessionId: "native-session",
        runnerInstanceId: "runner-1",
        completedAt: manifest.completedAt,
      });

      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-1")).toBe(true);
      expect(verifyNativeHarnessBackupStamp(stamp, "sandbox-2")).toBe(false);
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
      excludeTopLevelEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
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

  it("rejects non-top-level checkpoint exclusions", async () => {
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
        excludeTopLevelEntries: ["../outside"],
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
        excludeTopLevelEntries: ["tmp", ".tmp", "auth.json", "config.toml"],
      });

      expect(syncIn).toHaveBeenCalledOnce();
    } finally {
      await rm(sourcePath, { recursive: true, force: true });
    }
  });
});

describe("remote preinstalled executable discovery", () => {
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

describe("native governed waits", () => {
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
  const update = () => ({
    set: () => ({
      where: () => {
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          returning: () => Promise<Array<{ runId: string }>>;
        };
        result.returning = () =>
          Promise.resolve([{ runId: coordinator.runId }]);
        return result;
      },
    }),
  });
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          for: () => ({
            limit: () =>
              Promise.resolve([
                table === nativeRunFinalizations
                  ? coordinator
                  : {
                      agentId: boundExecution.binding.agentId,
                      companyId: boundExecution.binding.companyId,
                      nativeIssueId: boundExecution.binding.issueId,
                      resultJson: runResultJson,
                      runtimeMode: "native",
                    },
              ]),
          }),
        }),
      }),
    }),
    update,
  };
  return {
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
}) {
  const initialRun = {
    id: execution.binding.runId,
    agentId: execution.binding.agentId,
    companyId: execution.binding.companyId,
    nativeIssueId: execution.binding.issueId,
    runtimeMode: "native",
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
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
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
      { timeout: 500 },
    );
  });

  it("rehydrates a runnerd warm session from its checkpoint under a fresh run authority", async () => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-runnerd-warm-authority-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    process.env.PAPERCLIP_HOME = stateBase;
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstSession = { close: firstClose };
    const secondSession = { close: secondClose };
    const first = {
      ...execution,
      binding: {
        ...execution.binding,
        runId: "run-runnerd-warm-first",
        executionWorkspaceId: "workspace-runnerd-warm",
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
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 20 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...first,
      binding: { ...first.binding, runId: "run-runnerd-warm-second" },
    } as NativeExecutionInputV1;
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
        });
        options.onSession?.(firstSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBeUndefined();
        expect(options.persistedSession).toEqual(
          expect.objectContaining({
            identity: expect.objectContaining({
              runId: second.binding.runId,
              sessionId: second.session.normalizedSessionId,
            }),
            providerSessionId: "provider-runnerd-warm",
          }),
        );
        options.onSession?.(secondSession);
        return result;
      });

    try {
      await executePaperclipNativeSession({
        db: leaseDb(first),
        execution: first,
        runnerInstanceId: "runner-runnerd-warm",
        useRunnerd: true,
      });
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
      await mkdir(join(durableRoot, "runner"), { recursive: true });
      await writeFile(
        join(durableRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(durableIdentity)),
      );
      await writeFile(
        join(durableRoot, "runner", "runner-state.json"),
        JSON.stringify(durableRunnerState(durableIdentity, "suspended")),
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
        runnerInstanceId: "runner-runnerd-warm",
        useRunnerd: true,
      });
      expect(firstClose).toHaveBeenCalledWith({
        reason: "warm native session authority epoch rotated",
      });
      await vi.waitFor(() => expect(secondClose).toHaveBeenCalled(), {
        timeout: 500,
      });
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
  });

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
    await vi.waitFor(
      () =>
        expect(secondClose).toHaveBeenCalledWith({
          reason: "warm native session idle timeout",
        }),
      { timeout: 500 },
    );
  });
});

describe("native session bounded recovery", () => {
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
  });

  it("retries the same run twice and stops at the third failed attempt", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
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
  });

  it("escalates exhausted result-less sessions to board review instead of leaving the provider as its own owner", () => {
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
      issueStatus: "in_review",
      recoveryOwner: { kind: "board" },
      recoveryActionOwnerType: "board",
      recoveryActionOwnerAgentId: null,
      recoveryActionCause: "native_session_retry_exhausted",
      supersedeOnIdentityChange: true,
    });
  });
});

describe("native process ownership", () => {
  it("forwards the app-server PID and process group through the production backend seam", async () => {
    const processMetadata = {
      pid: 42_001,
      processGroupId: 42_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    };
    const onSpawn = vi.fn(async () => undefined);
    state.createBackend.mockClear();
    state.execute.mockReset().mockImplementation(async (options) => {
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
    state.createBackend.mockImplementationOnce((_input, options) => ({
      kind: "test",
      onSpawn: options.onSpawn,
    }));

    await executePaperclipNativeSession({
      db: leaseDb(),
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

  it("uses the native execution workspace as the local provider containment root", async () => {
    state.createBackend.mockClear();
    await createRunnerdBackend({
      db: leaseDb(execution),
      execution,
      runnerInstanceId: "runner-local-workspace",
      runnerEnvironment: {
        HOME: "/home/runner",
        PAPERCLIP_WORKSPACE_CWD: "/untrusted/configured-workspace",
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
      await expect(firstOptions.dynamicToolHandler!({})).rejects.toThrow(
        "native_tool_authority_epoch_revoked",
      );
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
    expect(state.createTransport.mock.calls[0]![0].runnerBinary).not.toBe(
      `${remoteCwd}/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd`,
    );
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
    await createRunnerdBackend({
      db: leaseDb(acpxExecution),
      execution: acpxExecution,
      runnerInstanceId: "runner",
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
