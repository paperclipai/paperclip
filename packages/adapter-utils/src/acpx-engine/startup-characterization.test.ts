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

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations. This copies the execute.test.ts
// harness verbatim so a startup test asserts the exact staging args and bridge
// hand-off the engine threads without changing any real behavior.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(actual.startAdapterExecutionTargetPaperclipBridge),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(actual.startAdapterExecutionTargetProcessSessionBridge),
  };
});
import { createAcpxEngineExecutor, type AcpxEngineExecutorOptions } from "./execute.js";
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

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

void pathExists;

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

// The staging-seam describe helper from execute.test.ts (~:2152). It builds a
// runner-backed remote target: the local runner extracts the staged tar into
// `remoteCwd`, so the run really ships the HOST worktree into the sandbox.
async function setupRemoteSandbox() {
  const root = await makeTempRoot();
  const stateDir = path.join(root, "state");
  const localCwd = path.join(root, "worktree");
  const remoteCwd = path.join(root, "remote-workspace");
  await fs.mkdir(localCwd, { recursive: true });
  await fs.mkdir(remoteCwd, { recursive: true });
  // A file present only in the HOST worktree proves the workspace is shipped
  // into the sandbox: the local runner extracts the staged tar into remoteCwd.
  await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
  const runner = createLocalSandboxRunner();
  const executionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "fake-plugin",
    remoteCwd,
    runner,
  };
  return { root, stateDir, localCwd, remoteCwd, executionTarget };
}

// Read the `configFingerprint` off a settled run result.
function fpOf(result: { sessionParams?: unknown }): string | undefined {
  return (result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;
}

const okHandle = {
  backendSessionId: "backend-session",
  agentSessionId: "agent-session",
  runtimeSessionName: "runtime-session",
};

function completedTurn() {
  return {
    events: (async function* () {
      yield { type: "done", stopReason: "end_turn" };
    })(),
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    cancel: async () => {},
  };
}

describe("ACPX engine startup characterization", () => {
  // Item 1 + 8: the remote launch env and its finalization point.
  describe("remote launch environment values", () => {
    beforeEach(() => vi.clearAllMocks());

    it("mints the bridge launch env into the process-session command payload", async () => {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      // Decode the process-session LAUNCH payload (the base64 command blob). The
      // in-sandbox process env rides there, not in the exec's own `env`.
      let launchPayload: Record<string, unknown> | null = null;
      (executionTarget as { runner: unknown }).runner = createLocalSandboxRunner((input) => {
        if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") {
          const script = input.args?.[1] ?? "";
          const match = script.match(/PAPERCLIP_PROCESS_SESSION_COMMAND_B64='([^']+)'/);
          if (match) {
            launchPayload = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as Record<
              string,
              unknown
            >;
          }
        }
      });

      await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        { authToken: "real-run-jwt", executionTarget },
      );

      // The launch payload carries the MERGED paperclip bridge env: the queue
      // transport mode, a loopback bridge base URL, and a minted bridge token.
      const payloadEnv = ((launchPayload as Record<string, unknown> | null)?.env ?? {}) as Record<
        string,
        unknown
      >;
      expect(payloadEnv).toMatchObject({ PAPERCLIP_API_BRIDGE_MODE: "queue_v1" });
      expect(String(payloadEnv.PAPERCLIP_API_URL ?? "")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // The minted bridge token is present and is NOT the host run JWT.
      expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
      expect(payloadEnv.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
    });

    it("finalizes the launch env at the bridge merge: the process env carries the merged bridge values", async () => {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      // Capture the launch payload AND the bridge-channel exec's own `env`.
      let launchPayload: Record<string, unknown> | null = null;
      let bridgeExecEnv: Record<string, string> | undefined;
      (executionTarget as { runner: unknown }).runner = createLocalSandboxRunner((input) => {
        if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") {
          bridgeExecEnv = input.env;
          const script = input.args?.[1] ?? "";
          const match = script.match(/PAPERCLIP_PROCESS_SESSION_COMMAND_B64='([^']+)'/);
          if (match) {
            launchPayload = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as Record<
              string,
              unknown
            >;
          }
        }
      });

      await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        { authToken: "real-run-jwt", executionTarget },
      );

      // The launch payload is the finalized carrier of the process env. It already
      // holds the merged bridge values at the point the run emits it, so no later
      // write mutates the process env after the bridge merge.
      const payloadEnv = ((launchPayload as Record<string, unknown> | null)?.env ?? {}) as Record<
        string,
        unknown
      >;
      expect(payloadEnv.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
      expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
      // The bridge-channel exec's OWN env is the sandbox transport channel, not the
      // agent process env: it does not carry the minted agent bridge key. This pins
      // that the merged agent env lives only in the finalized launch payload.
      expect(bridgeExecEnv?.PAPERCLIP_SANDBOX_EXEC_CHANNEL).toBe("bridge");
      expect(bridgeExecEnv?.PAPERCLIP_API_KEY).toBeUndefined();
    });
  });

  // Item 2: the 17 fingerprint fields folded into `configFingerprint`, and the
  // outer session key form that embeds it.
  describe("session fingerprint and session key", () => {
    beforeEach(() => vi.clearAllMocks());

    it("forms the session key as paperclip:company:agent:taskKey:fingerprint and embeds the fingerprint", async () => {
      const root = await makeTempRoot();
      const { result } = await runExecutor({
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        cwd: path.join(root, "workspace"),
      });

      const fp = fpOf(result);
      expect(fp).toBeTypeOf("string");
      expect(fp).toBeTruthy();
      // No taskId/issueId/workspaceId in the default context, so taskKey is "default".
      const sessionKey = (result.sessionParams as { sessionKey?: string }).sessionKey;
      expect(sessionKey).toBe(`paperclip:company-1:agent-1:default:${fp}`);
    });

    it("keeps the fingerprint stable across two identical runs and a same-config new wake", async () => {
      const root = await makeTempRoot();
      const baseConfig = {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        cwd: path.join(root, "workspace"),
      };
      const first = await runExecutor(baseConfig, {
        context: { taskId: "issue-1", wakeReason: "issue_assigned" },
      });
      const identical = await runExecutor(baseConfig, {
        context: { taskId: "issue-1", wakeReason: "issue_assigned" },
      });
      // A fresh heartbeat with a different wake reason but the same config env.
      const newWake = await runExecutor(baseConfig, {
        context: { taskId: "issue-1", wakeReason: "comment", wakeCommentId: "c-9" },
      });

      expect(fpOf(first.result)).toBeTruthy();
      expect(fpOf(identical.result)).toBe(fpOf(first.result));
      // Per-wake PAPERCLIP_* churn does not reset the session fingerprint.
      expect(fpOf(newWake.result)).toBe(fpOf(first.result));
    });

    it("busts the fingerprint when any representative folded dimension changes", async () => {
      const root = await makeTempRoot();
      const cwd = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      const context = { context: { taskId: "issue-1", wakeReason: "issue_assigned" } };
      const base = { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd };

      const baseFp = fpOf((await runExecutor(base, context)).result);
      expect(baseFp).toBeTruthy();

      // Each edit changes exactly one folded dimension and must bust the fingerprint.
      // agentCommand.
      expect(fpOf((await runExecutor({ ...base, agentCommand: "node ./other-acp.js" }, context)).result)).not.toBe(baseFp);
      // cwd.
      expect(fpOf((await runExecutor({ ...base, cwd: path.join(root, "other-cwd") }, context)).result)).not.toBe(baseFp);
      // requestedModel.
      expect(fpOf((await runExecutor({ ...base, model: "some-model" }, context)).result)).not.toBe(baseFp);
      // requestedThinkingEffort.
      expect(fpOf((await runExecutor({ ...base, thinkingEffort: "high" }, context)).result)).not.toBe(baseFp);
      // mode.
      expect(fpOf((await runExecutor({ ...base, mode: "oneshot" }, context)).result)).not.toBe(baseFp);
      // adapterEnvHash (a resolved adapter env value).
      expect(fpOf((await runExecutor({ ...base, env: { FOO: "bar" } }, context)).result)).not.toBe(baseFp);
      // mcpServers identity (injected runtime MCP set).
      expect(
        fpOf(
          (
            await runExecutor(base, {
              ...context,
              runtimeMcp: {
                getServers: () => [
                  { name: "github", url: "https://x.test/mcp", connectionId: "c-1", token: "t-1" },
                ],
              },
            })
          ).result,
        ),
      ).not.toBe(baseFp);
      // secretManifestHash.
      expect(
        fpOf(
          (
            await runExecutor(base, {
              ...context,
              context: {
                taskId: "issue-1",
                wakeReason: "issue_assigned",
                paperclipSecrets: {
                  manifest: [
                    {
                      configPath: "env.API_TOKEN",
                      envKey: "API_TOKEN",
                      secretId: "secret-1",
                      bindingId: "binding-1",
                      secretKey: "api-token",
                      version: 1,
                      provider: "local_encrypted",
                    },
                  ],
                },
              },
            })
          ).result,
        ),
      ).not.toBe(baseFp);
      // additionalSourcesIdentity (referenced-project set).
      expect(
        fpOf(
          (
            await runExecutor(base, {
              ...context,
              context: {
                taskId: "issue-1",
                wakeReason: "issue_assigned",
                paperclipWorkspace: {
                  cwd,
                  realization: {
                    additional: [
                      {
                        path: "/host/project-a",
                        projectId: "a",
                        projectWorkspaceId: "ws-a",
                        repoUrl: "https://example.test/a.git",
                        repoRef: "ref-a-1",
                      },
                    ],
                  },
                },
              },
            })
          ).result,
        ),
      ).not.toBe(baseFp);

      // fastMode folds only for codex, so pin it with a codex-vs-codex pair.
      const codexBase = { agent: "codex", agentCommand: "node ./fake-acp.js", stateDir, cwd };
      const codexFp = fpOf((await runExecutor(codexBase, context)).result);
      expect(fpOf((await runExecutor({ ...codexBase, fastMode: true }, context)).result)).not.toBe(codexFp);
    });
  });

  // Item 3: the staging seam call, its arguments, and its order (workspace then
  // assets, serial). Modeled on the PR-1 staging-seam tests.
  describe("staging seam calls, arguments, and order", () => {
    beforeEach(() => vi.clearAllMocks());

    it("stages the host workspace with no assets, exactly once, before the process launch", async () => {
      const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
      const { sessionInputs, events } = await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        { authToken: "real-run-jwt", executionTarget },
      );

      // The staging seam crossed exactly once.
      expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
      const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
      // The HOST worktree is shipped first; no per-adapter home asset in this lane.
      expect(stageArgs.workspaceLocalDir).toBe(localCwd);
      expect(stageArgs.assets ?? []).toEqual([]);
      expect(stageArgs.installCommand ?? null).toBeNull();
      expect(stageArgs.target).toMatchObject({ kind: "remote", transport: "sandbox" });

      // The workspace really landed in the sandbox workspace dir.
      await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
      // A per-step timing event proves the sync ran inside its timed boundary.
      const stageEvent = events.find(
        (event) => event.eventType === "run.startup.step" && event.payload?.step === "stage.sync",
      );
      expect(stageEvent).toBeTruthy();
      // And session/new binds to the in-sandbox workspace cwd the seam returned.
      expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
    });

    it("threads a managed-home asset through the same seam after the workspace", async () => {
      const { root, stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      const managedHomeDir = path.join(root, "managed-home");
      await fs.mkdir(managedHomeDir, { recursive: true });
      await fs.writeFile(path.join(managedHomeDir, "config.json"), "{}", "utf8");

      await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        {
          authToken: "real-run-jwt",
          executionTarget,
          prepareRemoteManagedHome: async (input) => {
            const stagedRuntime = await input.stage([
              { key: "home", localDir: managedHomeDir, followSymlinks: true },
            ]);
            return { stagedRuntime };
          },
        },
      );

      // The seam's home asset is threaded through the SAME staging seam, keyed by
      // the workspace-local dir. Workspace ships first; the asset rides alongside it.
      const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
      expect(stageArgs.workspaceLocalDir).toBe(localCwd);
      expect(stageArgs.assets).toEqual([
        { key: "home", localDir: managedHomeDir, followSymlinks: true },
      ]);
    });
  });

  // Item 4: the two-bridge overlap and the ACP-initialization ordering.
  describe("two-bridge overlap and ACP initialization order", () => {
    beforeEach(() => vi.clearAllMocks());

    it("defers the process bridge env, shares one runtimeRootDir, and runs session/new on the sandbox cwd", async () => {
      const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
      const { sessionInputs, runtimeOptions } = await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        { authToken: "real-run-jwt", executionTarget },
      );

      // The process-session bridge receives its launch env as a DEFERRED thunk, the
      // seam that lets its env-independent setup overlap the paperclip bridge start.
      const processArgs = vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls[0]![0];
      expect(typeof processArgs.env).toBe("function");

      // Both bridges receive the SAME real (non-null) runtimeRootDir from staging.
      const paperclipArgs = vi.mocked(startAdapterExecutionTargetPaperclipBridge).mock.calls[0]![0];
      expect(paperclipArgs.runtimeRootDir).toBeTruthy();
      expect(String(paperclipArgs.runtimeRootDir)).toContain(".paperclip-runtime");
      expect(processArgs.runtimeRootDir).toBe(paperclipArgs.runtimeRootDir);

      // The ACP runtime + session/new both bind to the in-sandbox workspace cwd,
      // which the run resolves only after the bridges bring the sandbox up.
      expect(runtimeOptions[0]?.cwd).toBe(remoteCwd);
      expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
      expect(sessionInputs[0]?.cwd).not.toBe(localCwd);
    });
  });

  // Item 5 + 6: every startup exit path, its result phase, and the cleanup-call
  // set (bridges stop / lease releases / runtime closes).
  describe("startup exit paths and cleanup", () => {
    beforeEach(() => vi.clearAllMocks());

    it("create_runtime failure: settles an error result, stops both bridges, releases the lease", async () => {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      const paperclipStop = vi.fn(async () => {});
      const processStop = vi.fn(async () => {});
      vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(
        async () => ({ env: {}, stop: paperclipStop }) as never,
      );
      vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
        async () => ({ agentCommand: null, stop: processStop }) as never,
      );
      const stagingLocks = new Map<string, Promise<unknown>>();
      const execute = createAcpxEngineExecutor({
        stagingLocks,
        warmHandles: new Map(),
        stagedRuntimes: new Map(),
        createRuntime: () => {
          throw new Error("createRuntime boom");
        },
      });

      const result = await execute({
        runId: "run-create-fail-remote",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        context: {},
        authToken: "real-run-jwt",
        executionTarget,
        onLog: async () => {},
        onMeta: async () => {},
        onEvent: async () => {},
      } as never);

      // The post-build runtime-creation failure returns a settled error result.
      expect(result.exitCode).toBe(1);
      expect(result.resultJson?.phase).toBe("create_runtime");
      // Both live bridges stop exactly once and the per-session lease releases.
      expect(paperclipStop).toHaveBeenCalledTimes(1);
      expect(processStop).toHaveBeenCalledTimes(1);
      expect(stagingLocks.size).toBe(0);
    });

    it("partial-bridge failure: throws and stops the concurrently-started bridge exactly once", async () => {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      const stop = vi.fn(async () => {});
      vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(async () => {
        throw new Error("paperclip bridge boom");
      });
      vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
        async () => ({ agentCommand: null, stop }) as never,
      );

      const execute = createAcpxEngineExecutor({
        createRuntime: () => buildRuntime() as never,
      });

      // A partial bridge failure inside buildRuntime is one of the only two throw
      // paths, so the run rethrows instead of settling a result.
      await expect(
        execute({
          runId: "run-bridge-fail",
          agent: { id: "agent-1", companyId: "company-1" },
          runtime: {},
          config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
          context: {},
          authToken: "real-run-jwt",
          executionTarget,
          onLog: async () => {},
          onMeta: async () => {},
          onEvent: async () => {},
        } as never),
      ).rejects.toThrow("paperclip bridge boom");

      // The concurrently-started process-session bridge was stopped exactly once.
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("cold ensure_session throw: ensure_session error, and the runtime closes (the cold-handshake leak is fixed)", async () => {
      const root = await makeTempRoot();
      const closeSpy = vi.fn(async () => {});
      const execute = createAcpxEngineExecutor({
        createRuntime: () =>
          ({
            ensureSession: async () => {
              throw new Error("ensureSession boom");
            },
            startTurn: () => completedTurn(),
            close: closeSpy,
          }) as never,
      });

      const result = await execute({
        runId: "handshake-fail",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode).toBe(1);
      expect(result.resultJson?.phase).toBe("ensure_session");
      // The runtime enters the ledger the moment it is created, so a cold
      // `ensureSession` throw (before any handle exists) still closes it through the
      // settlement `endSession` step. This closes the former cold-handshake leak.
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("missing session handle: ensure_session error and the minimal runtime closes", async () => {
      const root = await makeTempRoot();
      const closeSpy = vi.fn(async () => {});
      const execute = createAcpxEngineExecutor({
        createRuntime: () =>
          ({
            // A runtime that returns no session handle drives the missing-handle path.
            ensureSession: async () => undefined,
            startTurn: () => completedTurn(),
            close: closeSpy,
          }) as never,
      });

      const result = await execute({
        runId: "missing-handle",
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
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("configure_session failure: configure_session error and the runtime closes", async () => {
      const root = await makeTempRoot();
      const closeSpy = vi.fn(async () => {});
      const execute = createAcpxEngineExecutor({
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            // Gemini model/effort drive a session config option; a throwing setter
            // fails the configure_session phase after the handshake succeeds.
            setConfigOption: async () => {
              throw new Error("setConfigOption boom");
            },
            startTurn: () => completedTurn(),
            close: closeSpy,
          }) as never,
      });

      const result = await execute({
        runId: "configure-fail",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "gemini",
          model: "gemini-2.5-pro",
          thinkingEffort: "high",
          stateDir: path.join(root, "state"),
        },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode).toBe(1);
      expect(result.resultJson?.phase).toBe("configure_session");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("persistent host failure: the first run closes and relaunches, so a failing second run re-creates and closes", async () => {
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
          const opts = options as AcpRuntimeOptions & {
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
        runId: "warm-1",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config,
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
      } as never);
      expect(first.exitCode).toBe(0);
      // Amendment B: the first clean persistent turn closes and relaunches instead
      // of warm-saving the runtime, so no warm handle survives.
      expect(warmHandles.size).toBe(0);
      expect(created).toBe(1);

      // The second run finds no warm handle, so it re-creates the runtime and fails
      // while persisting process identity during ensure_session.
      const second = await execute({
        runId: "warm-2",
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

      // The second run built runtime #2 (no warm reuse), closed it on the failure,
      // and reported the ensure_session phase. Both runtimes closed (one per run).
      expect(created).toBe(2);
      expect(second.exitCode).toBe(1);
      expect(second.resultJson?.phase).toBe("ensure_session");
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(warmHandles.size).toBe(0);
    });
  });

  // Item 7: the per-lane resource set.
  describe("per-lane resource set", () => {
    beforeEach(() => vi.clearAllMocks());

    it("local lane: crosses no staging seam, starts no bridge, keeps session/new on the host cwd", async () => {
      const root = await makeTempRoot();
      const localCwd = path.join(root, "worktree");
      await fs.mkdir(localCwd, { recursive: true });
      const { sessionInputs, runtimeOptions } = await runExecutor({
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        cwd: localCwd,
      });

      expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).not.toHaveBeenCalled();
      expect(vi.mocked(startAdapterExecutionTargetPaperclipBridge)).not.toHaveBeenCalled();
      expect(vi.mocked(startAdapterExecutionTargetProcessSessionBridge)).not.toHaveBeenCalled();
      expect(sessionInputs[0]?.cwd).toBe(localCwd);
      expect(runtimeOptions[0]?.cwd).toBe(localCwd);
    });

    it("persistent host lane: closes and relaunches the handle, so a second run re-creates the runtime", async () => {
      const root = await makeTempRoot();
      const stateDir = path.join(root, "state");
      let created = 0;
      const warmHandles = new Map();
      const execute = createAcpxEngineExecutor({
        warmHandles,
        createRuntime: () => {
          created += 1;
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
      const base = {
        agent: { id: "agent-1", companyId: "company-1" },
        config,
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
      };

      const first = await execute({ runId: "host-warm-1", runtime: {}, ...base } as never);
      const second = await execute({
        runId: "host-warm-2",
        runtime: { sessionParams: first.sessionParams },
        ...base,
      } as never);

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      // Amendment B: the host lane never warm-saves a live runtime (the run-minted
      // API key is never revoked), so the first run closes and relaunches. No warm
      // handle survives, so the second run re-creates runtime #2.
      expect(created).toBe(2);
      expect(warmHandles.size).toBe(0);
    });

    it("remote process-session lane: does NOT warm-save the handle, so a second run re-creates the runtime", async () => {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      let created = 0;
      const ensureInputs: Array<Record<string, unknown>> = [];
      const warmHandles = new Map();
      const execute = createAcpxEngineExecutor({
        warmHandles,
        stagedRuntimes: new Map(),
        stagingLocks: new Map(),
        createRuntime: () => {
          created += 1;
          return buildRuntime(undefined, (input) => ensureInputs.push(input)) as never;
        },
      });
      const base = {
        agent: { id: "agent-1", companyId: "company-1" },
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir,
          cwd: localCwd,
          mode: "persistent",
          warmHandleIdleMs: 60_000,
        },
        context: {},
        authToken: "real-run-jwt",
        executionTarget,
        onLog: async () => {},
        onMeta: async () => {},
        onEvent: async () => {},
      };

      const first = await execute({ runId: "remote-warm-1", runtime: {}, ...base } as never);
      const second = await execute({
        runId: "remote-warm-2",
        runtime: { sessionParams: first.sessionParams },
        ...base,
      } as never);

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      // The remote process-session lane never keeps the handle warm, so the second
      // run re-creates the runtime and runs a fresh handshake instead of reusing one.
      expect(created).toBe(2);
      expect(warmHandles.size).toBe(0);
      expect(ensureInputs).toHaveLength(2);
    });
  });
});
