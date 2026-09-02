import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";

import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import {
  createPaperclipRunnerAuthorizedToolSet,
  type PaperclipSemanticToolDefinition,
} from "../../vendor/paperclip-runner/index.js";
import { runnerPrpCoordinator } from "./runner-prp-coordinator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const RUNNER_VERSION = "paperclip-runner-v1";

interface NativeRunnerProviderLaunch {
  readonly command: string;
  readonly args: string[];
  readonly providerVersion?: string;
}

interface NativeRunnerPrepareInput {
  readonly cwd: string;
  readonly model: string | null;
  readonly resumeProviderSessionId: string | null;
  readonly completionContract: { revision: string; criterionIds: string[] };
  readonly semanticTools: readonly PaperclipSemanticToolDefinition[];
  readonly providerLaunch?: NativeRunnerProviderLaunch;
}

export function buildNativeRunnerPreparePayload(
  input: NativeRunnerPrepareInput,
): Record<string, unknown> {
  return {
    provider: {
      kind: "codex",
      provider: "codex",
      driver: "codex_app_server",
      providerVersion: input.providerLaunch?.providerVersion ?? "codex-app-server-v1",
      command: input.providerLaunch?.command ?? "codex",
      args: input.providerLaunch?.args ?? ["app-server"],
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.resumeProviderSessionId
        ? { providerSessionId: input.resumeProviderSessionId }
        : {}),
      instructions: "",
      approvalPolicy: "never",
    },
    completionContract: input.completionContract,
    authorizedTools: createPaperclipRunnerAuthorizedToolSet(input.semanticTools),
  };
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
  providerLaunch?: NativeRunnerProviderLaunch;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
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

  const prepared = await runnerPrpCoordinator(input.db, {
    stateRoot: resolve(runtimeRoot, "control-plane"),
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

  prepared.queueCommand("run.prepare", buildNativeRunnerPreparePayload({
    cwd: input.cwd,
    model: input.model,
    resumeProviderSessionId: input.resumeProviderSessionId,
    completionContract: input.completionContract,
    semanticTools: prepared.semanticTools,
    ...(input.providerLaunch ? { providerLaunch: input.providerLaunch } : {}),
  }), `prepare_${input.runId}`);
  prepared.queueCommand("session.open", {}, `open_${input.runId}`);
  prepared.queueCommand("turn.start", { text: input.prompt }, `turn_${input.runId}`);

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
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: prepared.bootstrapTicket,
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
