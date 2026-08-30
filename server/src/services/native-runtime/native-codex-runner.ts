import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { Db } from "@paperclipai/db";

import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import {
  runnerPrpCoordinator,
  type PreparedRunnerPrpSession,
} from "./runner-prp-coordinator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const RUNNER_VERSION = "paperclip-runner-v1";
const NATIVE_RUNNER_RUNTIME_ROOT_ENV = "PAPERCLIP_RUNNER_RUNTIME_ROOT";
const REMOTE_RUNNER_BINARY_ENV = "PAPERCLIP_RUNNER_REMOTE_BINARY";
const REMOTE_RUNNER_DIGEST_ENV = "PAPERCLIP_RUNNER_REMOTE_DIGEST";
const REMOTE_RUNNER_RUNTIME_ROOT_ENV = "PAPERCLIP_RUNNER_REMOTE_RUNTIME_ROOT";
const NATIVE_CODEX_SEED_FILES = ["auth.json", "config.toml"] as const;
const RUNNER_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
type NativeRunnerCancellation = (reason: string) => void;
const activeRemoteNativeRunnerCancellations = new Map<string, NativeRunnerCancellation>();

/**
 * Requests cancellation through the run-bound PRP authority. Remote runner
 * process identifiers are intentionally not treated as local operating-system
 * PIDs by the heartbeat service.
 */
export function requestRemoteNativeRunnerCancellation(runId: string, reason: string): boolean {
  const cancel = activeRemoteNativeRunnerCancellations.get(runId);
  if (!cancel) return false;
  try {
    cancel(reason);
    return true;
  } catch {
    if (activeRemoteNativeRunnerCancellations.get(runId) === cancel) {
      activeRemoteNativeRunnerCancellations.delete(runId);
    }
    return false;
  }
}

export function queueNativeRunnerTermination(input: {
  prepared: Pick<PreparedRunnerPrpSession, "queueCommand">;
  runId: string;
  cancel: boolean;
  reason?: string;
}): void {
  if (input.cancel) {
    input.prepared.queueCommand(
      "run.cancel",
      input.reason ? { reason: input.reason } : {},
      `cancel_${input.runId}`,
    );
  }
  input.prepared.queueCommand("session.close", {}, `close_${input.runId}`);
  input.prepared.queueCommand("runner.shutdown", {}, `shutdown_${input.runId}`);
}

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
  allowRemoteHost?: string;
}): string[] {
  const args = [
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
  if (input.allowRemoteHost) {
    args.push("--allow-remote-host", input.allowRemoteHost);
  }
  return args;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

export function resolveNativeRunnerRuntimeRoot(
  configuredRoot = process.env[NATIVE_RUNNER_RUNTIME_ROOT_ENV],
): string {
  const configured = configuredRoot?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`${NATIVE_RUNNER_RUNTIME_ROOT_ENV} must be an absolute path`);
    }
    return resolve(configured);
  }
  return resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner");
}

export function resolveRemoteNativeRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): { binary: string; digest: string; runtimeRoot: string } {
  const binary = env[REMOTE_RUNNER_BINARY_ENV]?.trim() || "paperclip-runnerd";
  const digest = env[REMOTE_RUNNER_DIGEST_ENV]?.trim() ?? "";
  const runtimeRoot = env[REMOTE_RUNNER_RUNTIME_ROOT_ENV]?.trim() || "/runner-runtime";
  if (!RUNNER_DIGEST_PATTERN.test(digest)) {
    throw new Error(`${REMOTE_RUNNER_DIGEST_ENV} must be a sha256 digest`);
  }
  if (!runtimeRoot.startsWith("/") || runtimeRoot.includes("\\")) {
    throw new Error(`${REMOTE_RUNNER_RUNTIME_ROOT_ENV} must be an absolute POSIX path`);
  }
  if (binary.includes("\0") || binary.trim().length === 0) {
    throw new Error(`${REMOTE_RUNNER_BINARY_ENV} is invalid`);
  }
  return { binary, digest, runtimeRoot: posix.resolve(runtimeRoot) };
}

function assertRemoteRunnerConnectUrl(connectUrl: string): string {
  const url = new URL(connectUrl);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "ws:") {
    throw new Error("paperclip_runner_remote_connect_protocol_unsupported");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("paperclip_runner_remote_connect_url_required");
  }
  return hostname;
}

/**
 * Seed only Codex's portable authentication/configuration inputs into the
 * replica-local home. SQLite state, caches, sockets, and symlinks deliberately
 * stay behind so a network filesystem can never become Codex's runtime store.
 */
export function seedNativeCodexHome(sourceHome: string | null, targetHome: string): void {
  privateDirectory(targetHome);
  if (!sourceHome || resolve(sourceHome) === resolve(targetHome)) return;
  for (const fileName of NATIVE_CODEX_SEED_FILES) {
    try {
      const source = resolve(sourceHome, fileName);
      if (!lstatSync(source).isFile()) continue;
      const target = resolve(targetHome, fileName);
      copyFileSync(source, target);
      if (process.platform !== "win32") chmodSync(target, 0o600);
    } catch {
      // A missing or unreadable optional seed file is handled by Codex's normal
      // authentication failure path; never fall back to the remote home.
    }
  }
}

export function buildNativeRunnerEnvironment(input: {
  runtimeEnvironment: Record<string, string>;
  codexHome: string;
  bootstrapTicket: string;
  /** Local launches inherit the server process. Remote launches must omit it. */
  hostEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  return Object.fromEntries(Object.entries({
    ...(input.hostEnvironment ?? {}),
    ...input.runtimeEnvironment,
    CODEX_HOME: input.codexHome,
    PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: input.bootstrapTicket,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
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

async function waitForPromiseSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await waitForChildExit(promise.then(() => undefined, () => undefined), timeoutMs);
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
  executionTarget?: AdapterExecutionTarget | null;
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
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
}): Promise<AdapterExecutionResult> {
  const remoteTarget = input.executionTarget?.kind === "remote" ? input.executionTarget : null;
  const localRuntimeRoot = input.runtimeRoot
    ? resolve(input.runtimeRoot)
    : resolveNativeRunnerRuntimeRoot();
  const remoteConfig = remoteTarget ? resolveRemoteNativeRunnerConfig() : null;
  const binary = remoteConfig?.binary ?? input.runnerBinary ?? resolvePaperclipRunnerBinary();
  const runnerDigest = remoteConfig?.digest
    ?? `sha256:${createHash("sha256").update(readFileSync(binary)).digest("hex")}`;
  const runnerRuntimeRoot = remoteConfig?.runtimeRoot ?? localRuntimeRoot;
  const runnerStateDirectory = remoteConfig
    ? posix.resolve(runnerRuntimeRoot, "runner", input.runId)
    : resolve(runnerRuntimeRoot, "runner", input.runId);
  const sourceCodexHome = input.environment.CODEX_HOME?.trim()
    || process.env.CODEX_HOME?.trim()
    || null;
  const codexHome = remoteConfig
    ? posix.resolve(runnerRuntimeRoot, "codex", input.runId)
    : resolve(runnerRuntimeRoot, "codex", input.runId);
  privateDirectory(localRuntimeRoot);
  privateDirectory(resolve(localRuntimeRoot, "control-plane"));
  if (!remoteTarget) {
    privateDirectory(resolve(runnerRuntimeRoot, "runner"));
    privateDirectory(runnerStateDirectory);
    seedNativeCodexHome(sourceCodexHome, codexHome);
  }
  const runnerCwd = remoteTarget?.remoteCwd ?? input.cwd;

  const prepared = await runnerPrpCoordinator(input.db, {
    stateRoot: resolve(localRuntimeRoot, "control-plane"),
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
      command: input.providerLaunch?.command ?? "codex",
      args: input.providerLaunch?.args ?? ["app-server"],
      cwd: runnerCwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.resumeProviderSessionId
        ? { providerSessionId: input.resumeProviderSessionId }
        : {}),
      instructions: "",
      approvalPolicy: "never",
    },
    completionContract: input.completionContract,
  }, `prepare_${input.runId}`);
  prepared.queueCommand("session.open", {}, `open_${input.runId}`);
  prepared.queueCommand("turn.start", { text: input.prompt }, `turn_${input.runId}`);

  let allowRemoteHost: string | undefined;
  try {
    allowRemoteHost = remoteTarget
      ? assertRemoteRunnerConnectUrl(prepared.connectUrl)
      : undefined;
  } catch (error) {
    await prepared.release();
    throw error;
  }
  const runnerArguments = buildNativeRunnerArguments({
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
    allowRemoteHost,
  });
  const runnerEnvironment = buildNativeRunnerEnvironment({
    runtimeEnvironment: input.environment,
    codexHome,
    bootstrapTicket: prepared.bootstrapTicket,
    ...(remoteTarget ? {} : { hostEnvironment: process.env }),
  });

  if (remoteTarget) {
    if (activeRemoteNativeRunnerCancellations.has(input.runId)) {
      await prepared.release();
      throw new Error("paperclip_runner_remote_cancellation_already_registered");
    }
    const remoteProcess = runAdapterExecutionTargetProcess(
      input.runId,
      remoteTarget,
      binary,
      runnerArguments,
      {
        cwd: runnerCwd,
        env: runnerEnvironment,
        timeoutSec: Math.max(1, Math.ceil(input.timeoutMs / 1_000)),
        graceSec: 5,
        onLog: input.onLog,
      },
    );
    let terminationQueued = false;
    const queueTermination = (cancel: boolean, reason?: string) => {
      if (terminationQueued) return;
      terminationQueued = true;
      queueNativeRunnerTermination({
        prepared,
        runId: input.runId,
        cancel,
        reason,
      });
    };
    const cancelRemoteRunner: NativeRunnerCancellation = (reason) => {
      queueTermination(true, reason);
    };
    activeRemoteNativeRunnerCancellations.set(input.runId, cancelRemoteRunner);
    try {
      const completed = await Promise.race([
        prepared.waitForTerminal(input.timeoutMs),
        remoteProcess.then(async (result) => {
          const recovered = await prepared.waitForTerminal(2_000).catch(() => null);
          if (recovered) return recovered;
          throw new Error(
            `paperclip_runner_process_exited: code=${result.exitCode ?? "null"} signal=${result.signal ?? "null"}`,
          );
        }),
      ]);
      queueTermination(false);
      if (!await waitForPromiseSettlement(remoteProcess, 5_000)) {
        throw new Error("paperclip_runner_remote_shutdown_timeout");
      }
      await remoteProcess;
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
      if (activeRemoteNativeRunnerCancellations.get(input.runId) === cancelRemoteRunner) {
        activeRemoteNativeRunnerCancellations.delete(input.runId);
      }
      queueTermination(false);
      await waitForPromiseSettlement(remoteProcess, 5_000).catch(() => false);
      await prepared.release();
    }
  }

  const child = spawn(binary, runnerArguments, {
    cwd: input.cwd,
    detached: process.platform !== "win32",
    env: {
      ...runnerEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  child.stdout?.on("data", (chunk: Buffer) => {
    void input.onLog("stdout", chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    void input.onLog("stderr", chunk.toString("utf8"));
  });

  try {
    if (!child.pid) throw new Error("paperclip_runner_process_not_started");
    await input.onSpawn({
      pid: child.pid,
      processGroupId: process.platform === "win32" ? null : child.pid,
      startedAt: new Date().toISOString(),
    });
    const completed = await Promise.race([
      prepared.waitForTerminal(input.timeoutMs),
      exit.then(async ({ code, signal }) => {
        const recovered = await prepared.waitForTerminal(2_000).catch(() => null);
        if (recovered) return recovered;
        throw new Error(
          `paperclip_runner_process_exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }),
    ]);
    prepared.queueCommand("session.close", {}, `close_${input.runId}`);
    prepared.queueCommand("runner.shutdown", {}, `shutdown_${input.runId}`);
    await stopChild(child, exit, true);

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
    await stopChild(child, exit).catch(() => undefined);
    await prepared.release();
  }
}
