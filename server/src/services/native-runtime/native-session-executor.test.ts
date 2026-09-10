import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  chmod,
  lstat,
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import {
  acpxRuntimeSessionDirectoryName,
  type NativeExecutionInputV1,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import { createHash, randomUUID } from "node:crypto";
import {
  createNativeHarnessBackupStamp,
  verifyNativeHarnessBackupStamp,
} from "./native-harness-backup-stamp.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

type BackendFactoryOptions = {
  environment?: NodeJS.ProcessEnv;
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
  closeWarmNativeSessionsForEnvironment,
  closeIdleSandboxNativeSessionsForShutdown,
  createGovernedWaitEventObservation,
  createRemoteRunnerProcessLauncher,
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
  buildRemoteCodexLauncherCommand,
  mayUsePreinstalledRunnerArtifact,
  nativeUsageCostUsd,
  normalizeNativeUsage,
  parseRemoteRunnerProcessIdentity,
  readRemoteProviderPackManifest,
  buildRemoteProviderPackVerificationScript,
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
  stageRemoteRunnerFile,
  steerNativeSession,
  syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackup,
  shouldRestoreNativeHarnessBackupIntoSandbox,
} from "./native-session-executor.js";

describe("remote runner process supervision", () => {
  it.each([false, true])("supervises detached runnerd and observes signal failures (%s)", async (signalFails) => {
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
          if (signalFails) throw new Error("Sandbox state change in progress");
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
    const onLog = vi.fn(async () => undefined);
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
    expect(handle.startedAt).toBe("2026-09-06T00:00:00.000Z");

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
    if (signalFails) {
      await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith(
        "stderr", expect.stringContaining("Failed to signal sandbox runner: Sandbox state change in progress"),
      ));
    }
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
  it("normalizes app and sandbox build layouts in the standard server test lane", () => {
    execFileSync(process.execPath, ["--test", fileURLToPath(new URL(
      "../../../../packages/paperclip-runner/scripts/provider-pack-layout.test.mjs", import.meta.url,
    ))], { stdio: "pipe" });
  });

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
        claudeAcp: "0.70.0",
        codexAcp: "1.6.2",
        pi: "0.84.2",
        piAcp: "0.0.33",
      },
      target: { platform: process.platform, architecture: process.arch },
      runnerSourceRevision: "1".repeat(40),
      distDigest: sha256DirectoryTree(join(root, "dist")),
      bridgeDigest: "",
      acpxProfileDigests: {
        pi: "sha256:24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc",
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
      "1.18.29",
    );
    // Execute the exact source sent to the sandbox, not a mock of its verdict.
    const expectedManifest = readRemoteProviderPackManifest(root);
    const expectedArgument = Buffer.from(canonical(expectedManifest)).toString("base64");
    const verifyRemote = () => spawnSync(process.execPath, [
      "-e", buildRemoteProviderPackVerificationScript(), root, expectedArgument,
    ], { encoding: "utf8" });
    for (const [pkg, version] of Object.entries({
      acpx: payload.pins.acpx,
      "@agentclientprotocol/claude-agent-acp": payload.pins.claudeAcp,
      "@agentclientprotocol/codex-acp": payload.pins.codexAcp,
      "opencode-ai": payload.pins.opencode,
    })) {
      await mkdir(join(root, "node_modules", pkg), { recursive: true });
      await writeFile(join(root, "node_modules", pkg, "package.json"), JSON.stringify({ version }));
    }
    expect(verifyRemote().status).toBe(0);
    payload.runnerSourceRevision = "2".repeat(40);
    await writeManifest();
    expect(verifyRemote().status).toBe(0); // Revision-only provenance allows image reuse.

    // Exercise the production selection branch too: a different revision with
    // verified identical bytes must link the installed pack without syncIn.
    payload.runnerSourceRevision = "1".repeat(40);
    await writeManifest();
    const syncIn = vi.fn(async () => { throw new Error("unexpected-provider-pack-upload"); });
    const logs: string[] = [];
    const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
      let stdout = "";
      const script = command.args?.[1] ?? "";
      if (command.args?.[0] === "--build-metadata") {
        stdout = JSON.stringify({
          schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
          packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
          capabilities: ["codex.warm-attachment.passive-notices.v1"], prpTransportModes: ["listen_ws"],
        });
      } else if (script.includes("command -v paperclip-runnerd")) {
        stdout = "/opt/paperclip-runner/bin/paperclip-runnerd\n";
      } else if (script.includes("for candidate in /opt/paperclip-runner/provider-pack")) {
        stdout = "/opt/paperclip-runner/provider-pack\n";
      } else if (command.args?.[0] === "-e") {
        const verified = spawnSync(process.execPath, ["-e", script, root, command.args![3]!], { encoding: "utf8" });
        return { exitCode: verified.status, signal: null, timedOut: false, stdout: verified.stdout, stderr: verified.stderr };
      } else if (command.command.endsWith("/node_modules/.bin/opencode") && command.args?.[0] === "--version") {
        stdout = payload.pins.opencode;
      } else if (!script.includes("ln -s")) {
        throw new Error("after-provider-pack-verification");
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
    });
    const providerExecution = {
      ...execution,
      provider: { kind: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
      session: { ...execution.session, normalizedSessionId: `revision-only-${randomUUID()}`, driverKind: "opencode_server" },
    } as NativeExecutionInputV1;
    await createRunnerdBackend({
      db: leaseDb(providerExecution), execution: providerExecution,
      runnerInstanceId: "runner-revision-only-provider-pack", runnerIngressAuthorized: true,
      runnerRemoteProviderPackPath: root,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      runnerExecutionTarget: {
        kind: "remote", transport: "sandbox", remoteCwd: "/workspace", environmentId: "environment",
        leaseId: "lease", providerKey: "daytona", effectiveCapabilities: { runnerWebSocketIngress: true },
        runner: { execute: remoteExecute, syncIn },
      } as never,
    });
    payload.runnerSourceRevision = "2".repeat(40);
    await writeManifest();
    state.createTransport.mockClear();
    state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
    const transport = state.createTransport.mock.calls[0]![0] as RunnerTransportOptions & {
      controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
    };
    await expect(transport.controlPlaneRegistration({})).rejects.toThrow();
    expect(logs.join("")).toContain("using content-matched provider pack");
    expect(syncIn).not.toHaveBeenCalled();
    const revisionManifest = JSON.parse(await readFile(join(root, "provider-pack.json"), "utf8"));
    await writeFile(join(root, "provider-pack.json"), JSON.stringify({ ...revisionManifest, digest: `sha256:${"0".repeat(64)}` }));
    expect(verifyRemote().stderr).toContain("manifest digest mismatch");
    await writeManifest();
    for (const [relativePath, bytes] of [
      ["node_modules/node/bin/node", node],
      ["pnpm-lock.yaml", lockfile],
      ["dist/cli/acpx-runtime-sidecar.cjs", sidecar],
    ]) {
      await writeFile(join(root, relativePath), "tampered bytes");
      expect(verifyRemote().status).not.toBe(0);
      await writeFile(join(root, relativePath), bytes);
    }
    await writeFile(join(root, "dist", "extra-runtime.js"), "unexpected runtime code");
    expect(verifyRemote().stderr).toContain("dist tree digest mismatch");
    await rm(join(root, "dist", "extra-runtime.js"));
    for (const change of [
      (value: typeof payload) => { value.pins.opencode = "0.0.0"; },
      (value: typeof payload) => { value.target.architecture = "unexpected" as typeof process.arch; },
      (value: typeof payload) => { value.artifacts.nodeCommand = { ...value.artifacts.productionLock }; },
    ]) {
      const changed = structuredClone(payload);
      change(changed);
      await writeFile(join(root, "provider-pack.json"), JSON.stringify({
        schema: expectedManifest.schema,
        digest: digest(canonical(changed)), payload: changed,
      }));
      expect(verifyRemote().stderr).toContain("manifest content mismatch");
    }
    await writeManifest();
    await writeFile(join(root, "node_modules", "acpx", "package.json"), JSON.stringify({ version: "0.0.0" }));
    expect(verifyRemote().stderr).toContain("acpx version mismatch");
    await writeFile(join(root, "node_modules", "acpx", "package.json"), JSON.stringify({ version: payload.pins.acpx }));
    expect(verifyRemote().status).toBe(0);

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

describe("atomic remote runner replacement", () => {
  for (const useSyncIn of [true, false]) {
    it(`replaces an old launcher symlink without writing through it (${useSyncIn ? "provider" : "shell"})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runner-replace-"));
      try {
        const sourcePath = join(root, "new runner's bytes");
        const imageBinary = join(root, "image-runner");
        const targetPath = join(root, "paperclip-runnerd");
        await writeFile(sourcePath, "fixed runner");
        await writeFile(imageBinary, "old image runner");
        await symlink(imageBinary, targetPath);
        const runner = {
          execute: async (command: { command: string; args?: string[]; stdin?: string }) => {
            const stdout = execFileSync(command.command, command.args ?? [], { input: command.stdin, encoding: "utf8" });
            return { exitCode: 0, stdout, stderr: "" };
          },
          ...(useSyncIn ? { syncIn: async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string; mode: number }> }>) => {
            const file = operations[0]!.files[0]!;
            expect(file.targetPath).not.toBe(targetPath);
            await writeFile(file.targetPath, await readFile(file.sourcePath));
            await chmod(file.targetPath, file.mode);
          } } : {}),
        };
        await stageRemoteRunnerFile({ target: {} as never, runner: runner as never, sourcePath, targetPath, mode: 0o755 });
        expect(await readFile(targetPath, "utf8")).toBe("fixed runner");
        expect((await lstat(targetPath)).isSymbolicLink()).toBe(false);
        expect((await lstat(targetPath)).mode & 0o777).toBe(0o755);
        expect(await readFile(imageBinary, "utf8")).toBe("old image runner");
        expect((await readdir(root)).filter(name => name.includes(".upload-"))).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }

  it("retains the existing launcher when a provider upload is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-interrupted-"));
    try {
      const targetPath = join(root, "paperclip-runnerd");
      await writeFile(targetPath, "recoverable old runner");
      const runner = {
        syncIn: async (operations: Array<{ files: Array<{ targetPath: string }> }>) => {
          await writeFile(operations[0]!.files[0]!.targetPath, "partial upload");
          throw new Error("upload interrupted");
        },
        execute: async (command: { command: string; args?: string[] }) => {
          execFileSync(command.command, command.args ?? []);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      await expect(stageRemoteRunnerFile({ target: {} as never, runner: runner as never, sourcePath: "unused", targetPath, mode: 0o755 })).rejects.toThrow("upload interrupted");
      expect(await readFile(targetPath, "utf8")).toBe("recoverable old runner");
      expect(await readdir(root)).toEqual(["paperclip-runnerd"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish through a launcher symlink to a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-directory-link-"));
    try {
      const directory = join(root, "unrelated");
      const targetPath = join(root, "paperclip-runnerd");
      const sourcePath = join(root, "candidate");
      await mkdir(directory); await symlink(directory, targetPath); await writeFile(sourcePath, "runner");
      const runner = { execute: async (command: { command: string; args?: string[]; stdin?: string }) => {
        try { execFileSync(command.command, command.args ?? [], { input: command.stdin }); return { exitCode: 0, stdout: "", stderr: "" }; }
        catch { return { exitCode: 1, stdout: "", stderr: "failed" }; }
      } };
      await expect(stageRemoteRunnerFile({ target: {} as never, runner: runner as never, sourcePath, targetPath, mode: 0o755 })).rejects.toThrow("runner_remote_staging_failed");
      expect(await readdir(directory)).toEqual([]);
      expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
      expect((await readdir(root)).filter(name => name.includes(".upload-"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      const shim = '#!/bin/sh\ncat "$(dirname "$0")/version.txt"\nprintf "%s\\n" "$@"\n';
      await writeFile(source, shim, { mode: 0o755 });
      await writeFile(join(installation, "version.txt"), "codex-cli 0.153.4\n");
      // Existing deployments may already have the old symlink. Never write
      // through it into the shared installation while upgrading the launcher.
      await symlink(source, target);
      for (let pass = 0; pass < 2; pass++) {
        execFileSync("sh", ["-c", buildRemoteCodexLauncherCommand(source, target)]);
        expect(execFileSync(target, ["--version", "argument with 'quotes'"], { encoding: "utf8" }))
          .toBe("codex-cli 0.153.4\n--version\nargument with 'quotes'\n");
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
    capabilities: ["codex.warm-attachment.passive-notices.v1"],
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

  it("rejects preinstalled binaries that lack safe passive-notice attachment", () => {
    for (const capabilities of [undefined, [], ["unrelated"]]) {
      expect(() => assertRemoteRunnerBuildMetadata({ ...current, capabilities }, "listen_ws"))
        .toThrow("runner_remote_capability_missing:codex.warm-attachment.passive-notices.v1");
    }
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
  writes: Array<{ table: unknown; values: Record<string, unknown> }> = [],
  loseCancellationLease = false,
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
      writes.push({ table, values });
      return {
        where: () => {
          const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
            returning: () => Promise<Array<{ runId: string }>>;
          };
          result.returning = () => Promise.resolve(
            loseCancellationLease && values.nextAttemptAt === null && values.leaseOwner === null
              ? [] : [{ runId: coordinator.runId }],
          );
          return result;
        },
      };
    },
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
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: async () =>
        table === heartbeatRuns
          ? [{ runnerProfileJson: { sessionCheckpoint: { providerSessionId: "provider" } } }]
          : [],
      }) }),
    }),
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

  it.each([
    { dispatchState: "pending", leaseLost: false },
    { dispatchState: "acknowledged", leaseLost: false },
    { dispatchState: "pending", leaseLost: true },
    { dispatchState: "acknowledged", leaseLost: true },
  ])(
    "fences recovery for $dispatchState cancellation during a provider turn (leaseLost=$leaseLost)",
    async ({ dispatchState, leaseLost }) => {
      const resultJson: Record<string, unknown> = {};
      const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
      state.execute.mockImplementationOnce(async (options) => {
        options.onSession?.({ cancel: state.cancel });
        // The claim saw no cancellation. The durable intent arrives while the
        // provider is running, before its interruption surfaces as a failure.
        resultJson.nativeCancellation = {
          schema: "paperclip.native-cancellation.v1",
          scope: "run",
          companyId: execution.binding.companyId,
          runId: execution.binding.runId,
          issueId: execution.binding.issueId,
          dispatchState,
        };
        options.onSession?.(null);
        throw new Error("native_finalization_missing: session returned no semantic result");
      });
      const failure = await executePaperclipNativeSession({
        db: leaseDb(execution, {}, resultJson, writes, leaseLost),
        execution,
        runnerInstanceId: "runner",
      }).catch((error: unknown) => error);
      expect(writes.some(({ values }) => values.phase === "retryable_failure")).toBe(false);
      expect(writes.some(({ values }) => values.errorCode === "native_session_interrupted")).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(leaseLost ? "native_session_lease_lost" : "native_cancellation_pending_recovery");
      expect(writes).toContainEqual({
        table: nativeRunFinalizations,
        values: expect.objectContaining({ leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null }),
      });
    },
  );

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
  it.each([
    { transport: "sandbox", busy: false, fail: false },
    { transport: "sandbox", busy: true, fail: false },
    { transport: "sandbox", busy: false, fail: true },
    { transport: "ssh", busy: false, fail: false },
    { transport: "local", busy: false, fail: false },
  ] as const)("shutdown parks only idle sandbox sessions: $transport busy=$busy fail=$fail", async ({ transport, busy, fail }) => {
    const id = `shutdown-${transport}-${busy}-${fail}`;
    const close = vi.fn(async () => {
      if (fail) throw new Error("checkpoint unavailable");
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const warmExecution = {
      ...execution,
      binding: { ...execution.binding, runId: id, executionWorkspaceId: id },
      session: {
        ...execution.session,
        normalizedSessionId: id,
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 100 },
      },
    } as NativeExecutionInputV1;
    state.execute.mockReset().mockImplementationOnce(async (options) => {
      options.onSession?.({ close });
      if (busy) await held;
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: id, normalizedSessionId: id, providerSessionId: id,
        driverKind: "test", driverVersion: "1", nativeEventCount: 1,
        highestContiguousSourceSeq: 1, usage: null,
      };
    });
    const running = executePaperclipNativeSession({
      db: leaseDb(warmExecution), execution: warmExecution, runnerInstanceId: id,
      runnerExecutionTarget: transport === "local" ? undefined : transport === "sandbox" ? {
        kind: "remote", transport: "sandbox", environmentId: id, remoteCwd: `/tmp/${id}`,
      } : {
        kind: "remote", transport: "ssh", environmentId: id, remoteCwd: `/tmp/${id}`,
        spec: {
          host: "runner.internal", port: 22, username: "runner",
          remoteWorkspacePath: `/tmp/${id}`, remoteCwd: `/tmp/${id}`,
          privateKey: null, knownHosts: null, strictHostKeyChecking: true,
        },
      },
    });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    if (!busy) await running;
    try {
      const result = await closeIdleSandboxNativeSessionsForShutdown({ reason: "server shutdown" });
      if (transport === "sandbox" && !busy) {
        expect(close).toHaveBeenCalledExactlyOnceWith({ reason: "server shutdown" });
        expect(result[fail ? "failed" : "closed"]).toBeGreaterThanOrEqual(1);
        await closeIdleSandboxNativeSessionsForShutdown({ reason: "duplicate shutdown" });
        expect(close).toHaveBeenCalledOnce();
      } else {
        expect(close).not.toHaveBeenCalled();
        if (busy) expect(result.busy).toBeGreaterThanOrEqual(1);
      }
    } finally {
      release();
      await running;
      // Unselected sessions retain their existing idle-close behavior.
      await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 1_000 });
    }
  });

  it("closes an idle warm session before its remote environment is destroyed", async () => {
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
      options.onSession?.({ close });
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
    await expect(
      closeWarmNativeSessionsForEnvironment({
        environmentId: "environment-warm-delete",
        reason: "environment deleted",
      }),
    ).resolves.toEqual({ closed: 1, busy: 0, failed: 0 });
    expect(close).toHaveBeenCalledExactlyOnceWith({
      reason: "environment deleted",
    });
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
        expect(options.semanticResultTerminalGraceMs).toBe(30_000);
        options.onSession?.(sharedSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        expect(options.existingSession).toBe(sharedSession);
        expect(options.semanticResultTerminalGraceMs).toBe(30_000);
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

  it.each([false, true])("verifies a live warm owner before refreshing run authority (broker: %s)", async (useBroker) => {
    const stateBase = await mkdtemp(
      join(tmpdir(), "paperclip-runnerd-warm-authority-"),
    );
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    process.env.PAPERCLIP_HOME = stateBase;
    const firstClose = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);
    const firstSession = { close: firstClose };
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
        lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 500 },
      },
    } as NativeExecutionInputV1;
    const second = {
      ...first,
      binding: { ...first.binding, runId: "run-runnerd-warm-second" },
    } as NativeExecutionInputV1;
    const remoteTarget = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      environmentId: "environment-runnerd-warm-authority",
      remoteCwd: "/home/daytona/paperclip-workspace",
      runner: { execute: vi.fn() },
    } as never;
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
        });
        options.onSession?.(firstSession);
        return result;
      })
      .mockImplementationOnce(async (options) => {
        if (useBroker) {
          expect(options.existingSession).toBeUndefined();
          expect(options.persistedSession?.providerSessionId).toBe("provider-runnerd-warm");
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
        runnerEnvironment: useBroker ? { PAPERCLIP_GITHUB_BROKER_TOKEN: "first-run-capability" } : undefined,
        runnerInstanceId: "runner-runnerd-warm",
        useRunnerd: true,
        runnerExecutionTarget: remoteTarget,
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
      await writeFile(
        join(durableRoot, "control-plane", "control-plane-state.json"),
        JSON.stringify(durableControlPlaneState(durableIdentity)),
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
        onEvent,
        execution: second,
        runnerEnvironment: useBroker ? { PAPERCLIP_GITHUB_BROKER_TOKEN: "second-run-capability" } : undefined,
        runnerInstanceId: "runner-runnerd-warm",
        useRunnerd: true,
        runnerExecutionTarget: remoteTarget,
      });
      if (useBroker) {
        expect(onEvent).toHaveBeenCalledWith({
          eventType: "native.session.process_rotation",
          stream: "system",
          level: "info",
          message: "Native process rotated for the next run",
          payload: {
            reason: "run_scoped_github_capability",
            previousRunId: first.binding.runId,
            runId: second.binding.runId,
            companyId: second.binding.companyId,
            agentId: second.binding.agentId,
            nativeSessionId: second.session.normalizedSessionId,
            runnerInstanceId: "runner-runnerd-warm",
          },
        });
        expect(JSON.stringify(onEvent.mock.calls)).not.toContain("run-capability");
        expect(firstClose).toHaveBeenCalledOnce();
        expect(firstClose).toHaveBeenCalledWith({ reason: "warm native session configuration changed" });
      } else {
        expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
          eventType: "native.session.process_rotation",
        }));
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

  it("rejects ACPX Pi without the verified runner before constructing a backend", async () => {
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

  it("admits ACPX Pi through the production verified-runner entry point", async () => {
    const piExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-acpx-pi-verified" },
      provider: { kind: "acpx", agent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731", permissionMode: "approve-all" },
      session: { ...execution.session, normalizedSessionId: "verified-pi-session", driverKind: "acpx_runtime" },
    } as unknown as NativeExecutionInputV1;
    state.createBackend.mockClear();
    state.createTransport.mockClear();
    state.execute.mockReset().mockResolvedValue({
      result: { summary: "completed" }, terminal: { runTerminalState: "succeeded" },
      turnId: "turn", normalizedSessionId: "verified-pi-session", providerSessionId: null,
      driverKind: "acpx_runtime", driverVersion: "1", nativeEventCount: 1,
      highestContiguousSourceSeq: 1,
    });
    await executePaperclipNativeSession({
      db: leaseDb(piExecution), execution: piExecution,
      runnerInstanceId: "verified-pi-runner", useRunnerd: true,
    });
    expect(state.createBackend).toHaveBeenCalledWith(piExecution, expect.objectContaining({
      codexTransportFactory: expect.any(Function),
    }));
    state.createBackend.mock.calls[0]![1].codexTransportFactory!();
    expect(state.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      provider: "acpx", acpxAgent: "pi",
    }));
    expect(state.execute).toHaveBeenCalledOnce();
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
    expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({
      requireSessionCloseBeforeReturn: true,
    }));
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

  it.each([0, 5 * 1024 * 1024])("migrates a suspended prior-run authority with %i bytes of journal data only within its full session scope", async (journalBytes) => {
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
          {
            ...durableControlPlaneState({
              runId: priorExecution.binding.runId,
              normalizedSessionId: priorExecution.session.normalizedSessionId,
              runnerInstanceId: "runner-prior-run-scope",
              environmentLeaseId: "lease-prior-run-scope",
            }),
            journalData: "x".repeat(journalBytes),
          },
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

  it.each(["live", "suspended", "mismatched", "unavailable"] as const)("verifies remote restart authority without requiring a host runner copy (%s)", async (scenario) => {
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-remote-restart-"));
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    const identity = { runId: execution.binding.runId, normalizedSessionId: execution.session.normalizedSessionId,
      runnerInstanceId: "remote-restart-runner", environmentLeaseId: "remote-restart-lease" };
    const execute = vi.fn(async (input: { command: string; args: string[] }) => {
      expect(input.command).toBe("node");
      const request = JSON.parse(input.args[2]!);
      if (scenario === "unavailable") throw new Error("provider unavailable");
      return { exitCode: 0, timedOut: false, stdout: JSON.stringify({
        identity: { ...identity, ...(scenario === "mismatched" ? { runId: "other-run" } : {}) },
        stateDirectory: request.stateDirectory, lifecycle: scenario === "suspended" ? "suspended" : "ready",
        alive: scenario !== "suspended", process: { pid: 4321, startedAt: "2026-09-10T00:00:00.000Z", nonce: "ec0e1ae3-0614-44fc-a352-bb03d89134d7", startTicks: "13579" },
      }) };
    });
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/home/daytona/repos/project", providerKey: "daytona", runner: { execute } } as never;
    try {
      state.createBackend.mockClear(); state.createTransport.mockClear();
      await createRunnerdBackend({ db: leaseDb(execution), execution, runnerInstanceId: identity.runnerInstanceId });
      state.createBackend.mock.calls[0]![1].codexTransportFactory!();
      const root = state.createTransport.mock.calls[0]![0].stateDirectory!;
      await mkdir(join(root, "control-plane"), { recursive: true });
      const controlPlanePath = join(root, "control-plane", "control-plane-state.json");
      const original = JSON.stringify(durableControlPlaneState(identity));
      await writeFile(controlPlanePath, original);
      state.createBackend.mockClear(); state.createTransport.mockClear();
      const resumed = createRunnerdBackend({ db: leaseDb(execution), execution, runnerInstanceId: identity.runnerInstanceId,
        runnerExecutionTarget: target, restartRecovery: {
          kind: "reconcile_remote_runner", runId: execution.binding.runId, leaseOwner: "controller-owner",
          controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
        } });
      if (scenario === "unavailable" || scenario === "mismatched") {
        await expect(resumed).rejects.toThrow();
        expect(state.createBackend).not.toHaveBeenCalled();
      } else {
        await expect(resumed).resolves.toBeDefined();
        state.createBackend.mock.calls[0]![1].codexTransportFactory!();
        const options = state.createTransport.mock.calls[0]![0] as RunnerTransportOptions & { adoptExistingRunner?: { pid: number } };
        expect(options.prpIdentity).toMatchObject({ runId: identity.runId, runnerInstanceId: identity.runnerInstanceId });
        expect(options.adoptExistingRunner?.pid).toBe(scenario === "live" ? 4321 : undefined);
      }
      expect(await readFile(controlPlanePath, "utf8")).toBe(original);
      await expect(access(join(stateBase, "quarantine"))).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
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

  it.each(["missing", "malformed", "unknown_schema", "mismatched", "oversized"] as const)(
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
                      normalizedSessionId: caseName === "oversized"
                        ? scopedExecution.session.normalizedSessionId
                        : "session-owned-by-another-scope",
                      runnerInstanceId: `runner-${caseName}-scoped-state`,
                      environmentLeaseId: scopedExecution.binding.executionWorkspaceId,
                    }),
                  ),
          );
        }
        if (caseName === "oversized") {
          // Valid JSON beyond the bound: without the size guard this exact
          // identity and ready runner would otherwise be accepted.
          const padding = " ".repeat(1024 * 1024);
          for (let i = 0; i < 64; i++) {
            await appendFile(join(scopedRoot, "control-plane", "control-plane-state.json"), padding);
          }
          await mkdir(join(scopedRoot, "runner"), { recursive: true });
          await writeFile(join(scopedRoot, "runner", "runner-state.json"), JSON.stringify(
            durableRunnerState({
              runId: scopedExecution.binding.runId,
              normalizedSessionId: scopedExecution.session.normalizedSessionId,
              runnerInstanceId: `runner-${caseName}-scoped-state`,
              environmentLeaseId: scopedExecution.binding.executionWorkspaceId,
            }, "ready"),
          ));
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

  it("starts sandbox sessions in the scoped home while preserving the primary workspace", async () => {
    const remoteCwd = "/home/daytona/repos/main";
    const home = "/home/daytona";
    const remoteExecution = {
      ...execution,
      binding: { ...execution.binding, runId: "run-scoped-home-test" },
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
        normalizedSessionId: "scoped-home-session",
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
        kind: "remote", transport: "sandbox", remoteCwd, workFolderHome: home,
        environmentId: "environment", leaseId: "lease", providerKey: "daytona",
        runner: { execute: vi.fn(), syncIn: vi.fn() },
      } as never,
      runnerPublicUrl: "wss://paperclip.example.test",
    });

    expect(state.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ cwd: home }),
      }),
      expect.objectContaining({
        workingDirectoryAuthority: "remote_runner",
      }),
    );
    expect(state.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          workspace: expect.objectContaining({ cwd: home }),
        }),
      }),
    );
    expect(state.createBackend.mock.calls[0]![1].environment).toEqual(expect.objectContaining({
      HOME: home, CODEX_HOME: `${home}/.codex`, PAPERCLIP_WORKSPACE_CWD: remoteCwd,
      PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
    }));
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
            capabilities: ["codex.warm-attachment.passive-notices.v1"],
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
        } else if (!script.includes("ln -sfn") && !script.includes("paperclip_codex_launcher_tmp")) {
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

  it.each(["missing", "incompatible"])(
    "stages the server-resolved artifact when the image runner is %s",
    async (imageRunner) => {
      const artifact = join(isolatedStateDirectory, "vendored-runnerd");
      await writeFile(artifact, "server-owned runner bytes", { mode: 0o700 });
      state.resolveRunnerBinary.mockReturnValueOnce(artifact);
      const syncIn = vi.fn(async () => { throw new Error("observed-runner-upload"); });
      const remoteExecute = vi.fn(async (command: { command: string; args?: string[] }) => {
        const script = command.args?.[1] ?? "";
        let stdout = "";
        if (script.includes("command -v paperclip-runnerd")) {
          stdout = imageRunner === "missing" ? "" : "/usr/local/bin/paperclip-runnerd\n";
        } else if (command.args?.[0] === "--build-metadata") {
          stdout = "{}"; // An incompatible image must fall back to the app artifact.
        } else if (script === "uname -s; uname -m") {
          const os = process.platform === "darwin" ? "Darwin" : "Linux";
          const arch = process.arch === "x64" ? "x86_64" : "aarch64";
          stdout = `${os}\n${arch}\n`;
        }
        return { exitCode: 0, signal: null, timedOut: false, stderr: "", stdout };
      });
      await createRunnerdBackend({
        db: leaseDb(execution), execution, runnerInstanceId: "runner-vendored-artifact",
        runnerIngressAuthorized: true,
        runnerExecutionTarget: {
          kind: "remote", transport: "sandbox", remoteCwd: "/workspace",
          environmentId: "environment", leaseId: "lease", providerKey: "daytona",
          effectiveCapabilities: { runnerWebSocketIngress: true },
          runner: { execute: remoteExecute, syncIn },
        } as never,
      });
      state.createTransport.mockClear();
      state.createBackend.mock.calls.at(-1)![1].codexTransportFactory!();
      const transport = state.createTransport.mock.calls[0]![0] as RunnerTransportOptions & {
        controlPlaneRegistration: (authority: unknown) => Promise<unknown>;
      };
      expect(transport.runnerBinary).toBe(artifact);
      await expect(transport.controlPlaneRegistration({})).rejects.toThrow("observed-runner-upload");
      expect(syncIn).toHaveBeenCalledWith([
        expect.objectContaining({ files: [expect.objectContaining({ sourcePath: artifact, kind: "file", mode: 0o700 })] }),
      ]);
    },
  );

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
