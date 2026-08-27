import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";

import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { runnerPrpCoordinator } from "./runner-prp-coordinator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const RUNNER_VERSION = "paperclip-runner-v1";
const MAX_RUNNER_RESTARTS = 3;
const PROVIDER_GUARDIAN_SCRIPT = [
  "IFS= read -r ready || exit 0",
  '[ "$ready" = "start" ] || exit 0',
  '"$@" >/dev/null &',
  "provider_pid=$!",
  "printf '%s\\n' \"$provider_pid\"",
  'wait "$provider_pid" || true',
  "while :; do sleep 3600; done",
].join("\n");

function executableName(): string {
  return process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
}

export function resolvePaperclipRunnerBinary(
  configuredPath = process.env.PAPERCLIP_RUNNER_BINARY,
): string {
  const candidates = [
    configuredPath,
    resolve(moduleDirectory, "../../vendor/paperclip-runner/bin", executableName()),
    resolve(moduleDirectory, "../../../../packages/paperclip-runner/dist/bin", executableName()),
    resolve(
      moduleDirectory,
      "../../../../packages/paperclip-runner/runner/target/release",
      executableName(),
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  if (configuredPath && !isAbsolute(configuredPath)) {
    throw new Error("PAPERCLIP_RUNNER_BINARY must be an absolute path");
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK));
      return candidate;
    } catch {
      // Continue through the fixed production and workspace locations.
    }
  }
  throw new Error(
    "paperclip_runner_binary_missing: build @paperclipai/paperclip-runner or set PAPERCLIP_RUNNER_BINARY",
  );
}

function resolveCodexUnixProxy(): string {
  const candidates = [
    resolve(moduleDirectory, "../../vendor/paperclip-runner/cli/codex-app-server-unix-proxy.js"),
    resolve(
      moduleDirectory,
      "../../../../packages/paperclip-runner/dist/cli/codex-app-server-unix-proxy.js",
    ),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue through packaged and workspace locations.
    }
  }
  throw new Error("paperclip_runner_codex_proxy_missing: build @paperclipai/paperclip-runner");
}

export function buildNativeRunnerArguments(input: {
  connectUrl: string;
  stateDirectory: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
  runnerDigest: string;
  maxRuntimeMs: number;
}): string[] {
  return [
    "--connect-url", input.connectUrl,
    "--state-dir", input.stateDirectory,
    "--runner-id", input.runnerInstanceId,
    "--environment-lease-id", input.environmentLeaseId,
    "--run-id", input.runId,
    "--session-id", input.normalizedSessionId,
    "--turn-id", input.turnId,
    "--item-id", input.itemId,
    "--runner-version", RUNNER_VERSION,
    "--runner-digest", input.runnerDigest,
    "--max-runtime-ms", String(input.maxRuntimeMs),
  ];
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForChildExit(exit: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startGuardedProvider(input: {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  onOwnerSpawn?: (meta: {
    pid: number;
    processGroupId: number;
    startedAt: string;
    ownerToken: string;
  }) => Promise<void>;
}): Promise<{
  guardian: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  providerPid: number;
}> {
  if (process.platform === "win32") {
    throw new Error("codex_app_server_guardian_unsupported_platform");
  }
  const ownerToken = randomUUID();
  const guardian = spawn(
    "/bin/sh",
    ["-c", PROVIDER_GUARDIAN_SCRIPT, "paperclip-codex-provider", input.command, ...input.args],
    {
      cwd: input.cwd,
      detached: true,
      env: {
        ...process.env,
        ...input.environment,
        PAPERCLIP_PROVIDER_OWNER_TOKEN: ownerToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exit = waitForExit(guardian);
  try {
    if (!guardian.pid) throw new Error("codex_app_server_guardian_not_started");
    const ownerStartedAt = await readProcessStartedAt(guardian.pid);
    if (!ownerStartedAt) throw new Error("codex_app_server_guardian_identity_unavailable");
    await input.onOwnerSpawn?.({
      pid: guardian.pid,
      processGroupId: guardian.pid,
      startedAt: ownerStartedAt,
      ownerToken,
    });

    let buffer = "";
    const providerPid = await new Promise<number>((resolvePid, rejectPid) => {
      const timeout = setTimeout(() => {
        cleanup();
        rejectPid(new Error("codex_app_server_guardian_start_timeout"));
      }, 10_000);
      timeout.unref();
      const cleanup = () => {
        clearTimeout(timeout);
        guardian.stdout?.off("data", onData);
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const parsedPid = Number.parseInt(buffer.slice(0, newline).trim(), 10);
        cleanup();
        if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
          rejectPid(new Error("codex_app_server_guardian_invalid_provider_pid"));
          return;
        }
        resolvePid(parsedPid);
      };
      guardian.stdout?.on("data", onData);
      void exit.then(({ code, signal }) => {
        cleanup();
        rejectPid(
          new Error(`codex_app_server_guardian_exited: code=${code ?? "null"} signal=${signal ?? "null"}`),
        );
      }, rejectPid);
      guardian.stdin?.end("start\n");
    });
    return { guardian, exit, providerPid };
  } catch (error) {
    guardian.stdin?.destroy();
    await stopChild(guardian, exit).catch(() => undefined);
    throw error;
  }
}

function signalRunnerProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

async function stopChild(
  child: ChildProcess,
  exit: Promise<unknown>,
  allowGracefulExit = false,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (allowGracefulExit && await waitForChildExit(exit, 5_000)) return;
  signalRunnerProcessGroup(child, "SIGTERM");
  if (await waitForChildExit(exit, 5_000)) return;
  if (child.exitCode === null && child.signalCode === null) {
    signalRunnerProcessGroup(child, "SIGKILL");
  }
}

export async function executeNativeCodexRunner(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  prompt: string;
  model: string | null;
  resumeProviderSessionId: string | null;
  completionContract: { revision: string; criterionIds: string[] };
  timeoutMs: number;
  environment: Record<string, string>;
  /** Internal test seam; production always resolves the packaged binary. */
  runnerBinary?: string;
  /** Internal test seam; production always uses the instance runtime root. */
  runtimeRoot?: string;
  /** Internal conformance seam; production always launches `codex app-server`. */
  providerLaunch?: {
    command: string;
    args: string[];
    providerVersion?: string;
  };
  /** Internal restart-test seam. Production semantic dispatch does not pause. */
  onSemanticToolInputCommitted?: (input: {
    readonly callId: string;
    readonly operationId: string;
  }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Internal qualification seam for recording the shared Codex server identity. */
  onProviderSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Persists the provider guardian before it is allowed to launch Codex. */
  onProviderOwnerSpawn?: (meta: {
    pid: number;
    processGroupId: number;
    startedAt: string;
    ownerToken: string;
  }) => Promise<void>;
  /** Clears durable provider ownership after the shared server has stopped. */
  onProviderExit?: () => Promise<void>;
}): Promise<AdapterExecutionResult> {
  const binary = input.runnerBinary ?? resolvePaperclipRunnerBinary();
  const runnerDigest = `sha256:${createHash("sha256").update(readFileSync(binary)).digest("hex")}`;
  const runtimeRoot = input.runtimeRoot
    ? resolve(input.runtimeRoot)
    : resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner");
  const runnerStateDirectory = resolve(runtimeRoot, "runner", input.runId);
  privateDirectory(runtimeRoot);
  privateDirectory(resolve(runtimeRoot, "control-plane"));
  privateDirectory(resolve(runtimeRoot, "runner"));
  privateDirectory(runnerStateDirectory);
  const useSharedCodexServer = input.providerLaunch === undefined;
  const socketBase = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
  const sharedCodexSocketDirectory = useSharedCodexServer
    ? await mkdtemp(resolve(socketBase, "pc-codex-"))
    : null;
  if (sharedCodexSocketDirectory) privateDirectory(sharedCodexSocketDirectory);
  const sharedCodexSocket = sharedCodexSocketDirectory
    ? resolve(sharedCodexSocketDirectory, "c.sock")
    : "";
  const providerCommand = input.providerLaunch?.command ?? process.execPath;
  const providerArgs = input.providerLaunch?.args
    ?? [resolveCodexUnixProxy(), "--socket", sharedCodexSocket];

  const prepared = await runnerPrpCoordinator(input.db, {
    stateRoot: resolve(runtimeRoot, "control-plane"),
    onSemanticToolInputCommitted: input.onSemanticToolInputCommitted,
  }).prepare({
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    agentId: input.agentId,
    runnerInstanceId: input.runnerInstanceId,
    environmentLeaseId: input.environmentLeaseId,
    normalizedSessionId: input.normalizedSessionId,
    turnId: input.turnId,
    itemId: input.itemId,
    runnerVersion: RUNNER_VERSION,
    runnerDigest,
  });

  prepared.queueCommand("run.prepare", {
    provider: {
      provider: "codex",
      driver: "codex_app_server",
      providerVersion: input.providerLaunch?.providerVersion ?? "codex-app-server-v1",
      command: providerCommand,
      args: providerArgs,
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.resumeProviderSessionId
        ? { providerSessionId: input.resumeProviderSessionId }
        : {}),
      instructions: "",
      approvalPolicy: "never",
    },
    semanticTools: prepared.semanticTools,
    completionContract: input.completionContract,
  }, `prepare_${input.runId}`);
  prepared.queueCommand("session.open", {}, `open_${input.runId}`);
  prepared.queueCommand("turn.start", { text: input.prompt }, `turn_${input.runId}`);

  let activeChild: ChildProcess | null = null;
  let activeExit: Promise<unknown> | null = null;
  let sharedCodexServer: ChildProcess | null = null;
  let sharedCodexExit: Promise<unknown> | null = null;
  try {
    if (useSharedCodexServer) {
      let startupError: Error | null = null;
      let stderr = "";
      const guardedProvider = await startGuardedProvider({
        command: "codex",
        args: ["app-server", "--listen", `unix://${sharedCodexSocket}`],
        cwd: input.cwd,
        environment: input.environment,
        onOwnerSpawn: input.onProviderOwnerSpawn,
      });
      sharedCodexServer = guardedProvider.guardian;
      sharedCodexExit = guardedProvider.exit;
      sharedCodexServer.once("error", (error) => {
        startupError = error;
      });
      sharedCodexServer.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-16_384);
      });
      const providerStartedAt = await readProcessStartedAt(guardedProvider.providerPid);
      if (!providerStartedAt) {
        throw new Error("codex_app_server_process_identity_unavailable");
      }
      await input.onProviderSpawn?.({
        pid: guardedProvider.providerPid,
        processGroupId: sharedCodexServer.pid ?? null,
        startedAt: providerStartedAt,
      });
      const startupDeadline = Date.now() + 10_000;
      while (
        !existsSync(sharedCodexSocket)
        && startupError === null
        && sharedCodexServer.exitCode === null
        && Date.now() < startupDeadline
      ) {
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 20);
          timer.unref();
        });
      }
      if (!existsSync(sharedCodexSocket)) {
        throw new Error(
          `codex_app_server_socket_missing: ${(startupError as Error | null)?.message ?? stderr.trim()}`,
        );
      }
    }
    const terminal = prepared.waitForTerminal(input.timeoutMs);
    let bootstrapTicket = prepared.bootstrapTicket;
    let restartCount = 0;
    let completed: Awaited<typeof terminal> | null = null;
    while (completed === null) {
      const child = spawn(binary, buildNativeRunnerArguments({
        connectUrl: prepared.connectUrl,
        stateDirectory: runnerStateDirectory,
        runnerInstanceId: input.runnerInstanceId,
        environmentLeaseId: input.environmentLeaseId,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        turnId: input.turnId,
        itemId: input.itemId,
        runnerDigest,
        maxRuntimeMs: input.timeoutMs,
      }), {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          ...input.environment,
          PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: bootstrapTicket,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exit = waitForExit(child);
      activeChild = child;
      activeExit = exit;
      child.stdout?.on("data", (chunk: Buffer) => {
        void input.onLog("stdout", chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        void input.onLog("stderr", chunk.toString("utf8"));
      });
      if (!child.pid) throw new Error("paperclip_runner_process_not_started");
      await input.onSpawn({
        pid: child.pid,
        processGroupId: process.platform === "win32" ? null : child.pid,
        startedAt: new Date().toISOString(),
      });
      const outcome = await Promise.race([
        terminal.then((value) => ({ kind: "terminal" as const, value })),
        exit.then((value) => ({ kind: "exit" as const, value })),
      ]);
      if (outcome.kind === "terminal") {
        completed = outcome.value;
        break;
      }
      activeChild = null;
      activeExit = null;
      const afterExit = await Promise.race([
        terminal.then((value) => ({ kind: "terminal" as const, value })),
        new Promise<{ kind: "restart" }>((resolveRestart) => {
          const timer = setTimeout(() => resolveRestart({ kind: "restart" }), 250);
          timer.unref();
        }),
      ]);
      if (afterExit.kind === "terminal") {
        completed = afterExit.value;
        break;
      }
      if (restartCount >= MAX_RUNNER_RESTARTS) {
        throw new Error(
          `paperclip_runner_process_exited: code=${outcome.value.code ?? "null"} signal=${outcome.value.signal ?? "null"}`,
        );
      }
      restartCount += 1;
      bootstrapTicket = prepared.issueBootstrapTicket();
    }
    if (completed === null) throw new Error("paperclip_runner_terminal_missing");
    prepared.queueCommand("session.close", {}, `close_${input.runId}`);
    prepared.queueCommand("runner.shutdown", {}, `shutdown_${input.runId}`);
    if (activeChild && activeExit) {
      await stopChild(activeChild, activeExit, true);
    }

    const succeeded = completed.terminal.runTerminalState === "succeeded";
    return {
      exitCode: succeeded ? 0 : 1,
      signal: null,
      timedOut: false,
      ...(succeeded ? {} : {
        errorCode: "paperclip_runner_provider_failed",
        errorMessage: completed.result.summary,
      }),
      provider: "codex",
      model: input.model,
      sessionParams: {
        sessionId: completed.providerSessionId ?? input.normalizedSessionId,
      },
      sessionDisplayId: completed.providerSessionId ?? input.normalizedSessionId,
      resultJson: {
        nativeRunner: {
          result: completed.result,
          terminal: completed.terminal,
        },
      },
      summary: completed.result.summary,
    };
  } finally {
    if (activeChild && activeExit) {
      await stopChild(activeChild, activeExit).catch(() => undefined);
    }
    if (sharedCodexServer && sharedCodexExit) {
      await stopChild(sharedCodexServer, sharedCodexExit).catch(() => undefined);
    }
    await input.onProviderExit?.().catch(() => undefined);
    await prepared.release();
    if (sharedCodexSocketDirectory) {
      await rm(sharedCodexSocketDirectory, { recursive: true, force: true });
    }
  }
}
