import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { agentSessionGoalActions, agentTaskSessions } from "@paperclipai/db";

import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { failRunnerGoalAction } from "../runner-goals.js";
import {
  createPaperclipRunnerAuthorizedToolSet,
  type PaperclipSemanticToolDefinition,
} from "../../vendor/paperclip-runner/index.js";
import { runnerPrpCoordinator } from "./runner-prp-coordinator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const RUNNER_VERSION = "paperclip-runner-v1";

interface NativeGoalControl {
  sessionId: string;
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  currentStatus: string | null;
  workingNow: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readNativeGoalControl(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  requestId: string | null;
}): Promise<NativeGoalControl | null> {
  if (!input.requestId) return null;
  const [row] = await input.db
    .select({
      sessionId: agentTaskSessions.id,
      requestId: agentSessionGoalActions.requestId,
      action: agentSessionGoalActions.action,
      payload: agentSessionGoalActions.payloadJson,
      goal: agentTaskSessions.goalJson,
      goalStatus: agentTaskSessions.goalStatus,
    })
    .from(agentSessionGoalActions)
    .innerJoin(
      agentTaskSessions,
      eq(agentTaskSessions.id, agentSessionGoalActions.sessionId),
    )
    .where(
      and(
        eq(agentSessionGoalActions.companyId, input.companyId),
        eq(agentSessionGoalActions.requestId, input.requestId),
        eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.taskKey, input.issueId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const goal = asRecord(row.goal);
  return {
    sessionId: row.sessionId,
    requestId: row.requestId,
    action: row.action,
    payload: asRecord(row.payload),
    currentStatus: row.goalStatus,
    workingNow: goal.workingNow === true,
  };
}

function nativeGoalCommands(control: NativeGoalControl): Array<{
  type: string;
  payload: Record<string, unknown>;
}> {
  if (control.action === "clear") {
    return [
      {
        type: "session.goal.clear",
        payload: { requestId: control.requestId },
      },
    ];
  }
  if (control.action === "pause") {
    return [
      {
        type: "session.goal.set",
        payload: { requestId: control.requestId, status: "paused" },
      },
    ];
  }
  if (control.action === "resume") {
    return [
      {
        type: "session.goal.set",
        payload: { requestId: control.requestId, status: "active" },
      },
    ];
  }
  const payload = {
    requestId: control.requestId,
    objective: control.payload.objective,
    ...(control.action === "edit" ? {} : { status: "active" }),
    ...(Object.prototype.hasOwnProperty.call(control.payload, "tokenBudget")
      ? { tokenBudget: control.payload.tokenBudget }
      : {}),
  };
  return control.action === "replace"
    ? [
        {
          type: "session.goal.clear",
          payload: { requestId: control.requestId },
        },
        { type: "session.goal.set", payload },
      ]
    : [{ type: "session.goal.set", payload }];
}

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
  goalControlRequestId?: string | null;
  resumeSessionGoalHeartbeat?: boolean;
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
  const goalControl = await readNativeGoalControl({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    requestId: input.goalControlRequestId ?? null,
  });
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
  const recoveryGoalRequestId = input.resumeSessionGoalHeartbeat
    ? `recovery_${input.runId}`
    : null;
  if (goalControl) {
    const commandKey = createHash("sha256").update(goalControl.requestId).digest("hex").slice(0, 20);
    nativeGoalCommands(goalControl).forEach((command, index) => {
      prepared.queueCommand(command.type, command.payload, `goal_${commandKey}_${index + 1}`);
    });
    await input.db.update(agentSessionGoalActions).set({
      status: "delivering",
      updatedAt: new Date(),
    }).where(and(
      eq(agentSessionGoalActions.sessionId, goalControl.sessionId),
      eq(agentSessionGoalActions.requestId, goalControl.requestId),
    ));
  } else if (recoveryGoalRequestId) {
    prepared.queueCommand(
      "session.goal.set",
      { requestId: recoveryGoalRequestId, status: "active" },
      `goal_${recoveryGoalRequestId}`,
    );
  } else {
    prepared.queueCommand("turn.start", { text: input.prompt }, `turn_${input.runId}`);
  }

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
    if (goalControl) {
      const commandKey = createHash("sha256").update(goalControl.requestId).digest("hex").slice(0, 20);
      const commands = nativeGoalCommands(goalControl);
      for (let index = 0; index < commands.length; index += 1) {
        await prepared.waitForCommand(`goal_${commandKey}_${index + 1}`, Math.min(input.timeoutMs, 30_000));
      }
      await prepared.waitForGoalEvent(goalControl.requestId, Math.min(input.timeoutMs, 30_000));
    } else if (recoveryGoalRequestId) {
      await prepared.waitForCommand(`goal_${recoveryGoalRequestId}`, Math.min(input.timeoutMs, 30_000));
      await prepared.waitForGoalEvent(recoveryGoalRequestId, Math.min(input.timeoutMs, 30_000));
    }
    const shouldWaitForGoalCompletion = goalControl && (
      goalControl.workingNow ||
      ["create", "replace", "resume"].includes(goalControl.action) ||
      (goalControl.action === "edit" && goalControl.currentStatus === "active")
    );
    const completion = goalControl && !shouldWaitForGoalCompletion
      ? Promise.resolve(null)
      : prepared.waitForTerminal(input.timeoutMs);
    const completed = await Promise.race([
      completion,
      exit.then(async ({ code, signal }) => {
        const recovered = goalControl && !shouldWaitForGoalCompletion
          ? null
          : await prepared.waitForTerminal(2_000).catch(() => undefined);
        if (recovered) return recovered;
        if (recovered === null && goalControl && !shouldWaitForGoalCompletion) return null;
        throw new Error(
          `paperclip_runner_process_exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }),
    ]);
    prepared.queueCommand("session.close", {}, `close_${input.runId}`);
    prepared.queueCommand("runner.shutdown", {}, `shutdown_${input.runId}`);
    await stopChild(child, exit, true);

    const succeeded = completed === null || completed.terminal.runTerminalState === "succeeded";
    if (goalControl && completed === null) {
      await input.db.update(agentSessionGoalActions).set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(agentSessionGoalActions.sessionId, goalControl.sessionId),
        eq(agentSessionGoalActions.requestId, goalControl.requestId),
      ));
    }
    return {
      exitCode: succeeded ? 0 : 1,
      signal: null,
      timedOut: false,
      ...(succeeded ? {} : {
        errorCode: "paperclip_runner_provider_failed",
        errorMessage: completed?.result.summary,
      }),
      provider: "codex",
      model: input.model,
      sessionParams: {
        sessionId: completed?.providerSessionId ?? input.normalizedSessionId,
      },
      sessionDisplayId: completed?.providerSessionId ?? input.normalizedSessionId,
      resultJson: {
        nativeRunner: {
          ...(completed ? { result: completed.result, terminal: completed.terminal } : {}),
          ...(goalControl ? {
            goalControl: {
              requestId: goalControl.requestId,
              action: goalControl.action,
              status: "completed",
            },
          } : {}),
          ...(recoveryGoalRequestId ? {
            goalHeartbeat: {
              requestId: recoveryGoalRequestId,
              status: "settled",
            },
          } : {}),
        },
      },
      summary: completed?.result.summary ?? "Agent session goal control applied.",
    };
  } catch (error) {
    if (goalControl) {
      await failRunnerGoalAction(
        input.db,
        {
          companyId: input.companyId,
          issueId: input.issueId,
          agentId: input.agentId,
          adapterType: "paperclip_runner",
        },
        goalControl.requestId,
        error instanceof Error ? error.message : "native_goal_control_failed",
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await stopChild(child, exit).catch(() => undefined);
    await prepared.release();
  }
}
