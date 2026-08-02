import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SshRemoteExecutionSpec } from "./ssh.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeAsset,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import {
  buildRemoteExecutionSessionIdentity,
  prepareRemoteManagedRuntime,
  remoteExecutionSessionMatches,
} from "./remote-managed-runtime.js";
import type {
  AdditionalSourceStagingFailure,
  SandboxAdditionalSource,
} from "./sandbox-managed-runtime.js";
export type {
  AdditionalSourceStagingFailure,
  SandboxAdditionalSource,
} from "./sandbox-managed-runtime.js";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
  syncRemoteTextFileWithHashSkip,
} from "./sandbox-callback-bridge.js";
import {
  createSandboxRunLogTailFactory,
  type SandboxRunLogTailFactory,
} from "./sandbox-run-log-stream.js";
import { createSshCommandManagedRuntimeRunner, parseSshRemoteExecutionSpec, runSshCommand, shellQuote } from "./ssh.js";
import {
  ensureCommandResolvable,
  resolveCommandForLogs,
  runChildProcess,
  type RunProcessResult,
  type TerminalResultCleanupOptions,
} from "./server-utils.js";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import type { RuntimeProgressSink, RuntimeStatusSink } from "./runtime-progress.js";
import type { LocalProcessSandboxOptions } from "./local-process-sandbox.js";

export type { RuntimeProgressSink } from "./runtime-progress.js";

export type AdapterWorkspaceRealizationMode = "copy" | "in_place";

export interface AdapterWorkspacePathAlias {
  path: string;
  target: string;
}

export interface AdapterWorkspaceRealization {
  mode: AdapterWorkspaceRealizationMode;
  authoritativeRoot: string;
  pathAliases: AdapterWorkspacePathAlias[];
  outboundRestorePaths: string[];
}

interface AdapterExecutionTargetWorkspaceMetadata {
  workspaceRealization?: AdapterWorkspaceRealization | null;
}

export interface AdapterLocalExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "local";
  environmentId?: string | null;
  leaseId?: string | null;
}

export interface AdapterSshExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "remote";
  transport: "ssh";
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  spec: SshRemoteExecutionSpec;
}

export interface AdapterSandboxExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "remote";
  transport: "sandbox";
  providerKey?: string | null;
  shellCommand?: "bash" | "sh" | null;
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
  runner?: CommandManagedRuntimeRunner;
  /**
   * Sandbox-backed adapter runs stream the agent CLI's stdout/stderr
   * incrementally via a log-tail loop beside the callback bridge instead of
   * waiting for the batched provider result. Streaming is ON by default;
   * set to `false` to explicitly opt out back to batch-at-end delivery.
   */
  streamRunLogs?: boolean | null;
}

export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterSshExecutionTarget
  | AdapterSandboxExecutionTarget;

export type AdapterRemoteExecutionSpec = SshRemoteExecutionSpec;

// The adapter-facing managed-runtime asset type. Aliased to the sandbox/command
// asset descriptor so the per-asset lifecycle contributions (`provision` /
// `restore`) declared on the sandbox core are load-bearing all the way from the
// adapter call site through to the sandbox runtime. The SSH transport consumes
// the subset of fields it understands and ignores the rest.
export type AdapterManagedRuntimeAsset = CommandManagedRuntimeAsset;

export interface PreparedAdapterExecutionTargetRuntime {
  target: AdapterExecutionTarget;
  workspaceRemoteDir: string | null;
  runtimeRootDir: string | null;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. Empty for a local target or when no
   * additional sources were requested.
   */
  additionalSourceDirs: Record<string, string>;
  /**
   * Each additional (referenced) project whose staging failed, paired with the
   * failure message. Empty for a local target, for a transport that does not
   * stage referenced projects, or when every requested project staged.
   */
  additionalSourceFailures: AdditionalSourceStagingFailure[];
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

export interface AdapterExecutionTargetProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onRuntimeProgress?: RuntimeStatusSink;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  terminalResultCleanup?: TerminalResultCleanupOptions;
  /**
   * Sandbox-only: factory from the Paperclip bridge handle that streams the
   * CLI's stdout/stderr during the run. When provided, the batched provider
   * onLog is suppressed and incremental chunks flow through `onLog` instead.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  localProcessSandbox?: LocalProcessSandboxOptions | null;
}

export interface AdapterExecutionTargetShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface AdapterExecutionTargetPaperclipBridgeHandle {
  env: Record<string, string>;
  /**
   * Present when the sandbox target opted into run-log streaming
   * (`streamRunLogs`). Create one handle per CLI attempt and pass it to
   * `runAdapterExecutionTargetProcess` via `options.runLogTail`.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  stop(): Promise<void>;
}

export interface AdapterExecutionTargetProcessSessionBridgeHandle {
  agentCommand: string;
  stop(): Promise<void>;
}

export { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

// 4-hour wall-clock backstop for sandbox-backed adapter runs. This is a
// last-resort kill switch, not the primary hang detector: genuinely hung runs
// are caught much earlier by the adapters' output-inactivity monitors (e.g.
// codex-local's 7-minute monitor). The value intentionally matches the
// recovery watchdog's ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS (4h) in
// server/src/services/recovery/service.ts so healthy long runs are never
// killed by the adapter before the watchdog would even consider them stuck.
export const DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC = 14_400;

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringMeta(parsed: Record<string, unknown>, key: string): string | null {
  return readString(parsed[key]);
}

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

function resolveDefaultPaperclipApiUrl(): string {
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  // 3100 matches the default Paperclip dev server port when the runtime does not provide one.
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  return `http://${runtimeHost}:${runtimePort}`;
}

function isBridgeDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PAPERCLIP_BRIDGE_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isAdapterExecutionTargetInstance(value: unknown): value is AdapterExecutionTarget {
  const parsed = parseObject(value);
  if (parsed.kind === "local") return true;
  if (parsed.kind !== "remote") return false;
  if (parsed.transport === "ssh") return parseSshRemoteExecutionSpec(parseObject(parsed.spec)) !== null;
  if (parsed.transport !== "sandbox") return false;
  return readStringMeta(parsed, "remoteCwd") !== null;
}

export function adapterExecutionTargetToRemoteSpec(
  target: AdapterExecutionTarget | null | undefined,
): AdapterRemoteExecutionSpec | null {
  return target?.kind === "remote" && target.transport === "ssh" ? target.spec : null;
}

export function adapterExecutionTargetIsRemote(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function adapterExecutionTargetUsesManagedHome(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox";
}

export function adapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  localCwd: string,
): string {
  return target?.kind === "remote" ? target.remoteCwd : localCwd;
}

export function overrideAdapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  remoteCwd: string | null | undefined,
): AdapterExecutionTarget | null | undefined {
  const nextRemoteCwd = remoteCwd?.trim();
  if (!target || target.kind !== "remote" || !nextRemoteCwd) {
    return target;
  }
  if (target.remoteCwd === nextRemoteCwd) {
    return target;
  }
  if (target.transport === "ssh") {
    return {
      ...target,
      remoteCwd: nextRemoteCwd,
      spec: {
        ...target.spec,
        remoteCwd: nextRemoteCwd,
      },
    };
  }
  return {
    ...target,
    remoteCwd: nextRemoteCwd,
  };
}

export function resolveAdapterExecutionTargetCwd(
  target: AdapterExecutionTarget | null | undefined,
  configuredCwd: string | null | undefined,
  localFallbackCwd: string,
): string {
  if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) {
    return configuredCwd;
  }
  return adapterExecutionTargetRemoteCwd(target, localFallbackCwd);
}

export function adapterExecutionTargetUsesPaperclipBridge(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function describeAdapterExecutionTarget(
  target: AdapterExecutionTarget | null | undefined,
): string {
  if (!target || target.kind === "local") return "local environment";
  if (target.transport === "ssh") {
    return `SSH environment ${target.spec.username}@${target.spec.host}:${target.spec.port}`;
  }
  return `sandbox environment${target.providerKey ? ` (${target.providerKey})` : ""}`;
}

export type AdapterExecutionTargetTimeoutSource =
  | "configured"
  | "sandbox_default"
  | "unlimited";

export interface AdapterExecutionTargetTimeoutResolution {
  /** Resolved wall-clock timeout in seconds; 0 means no adapter timeout. */
  timeoutSec: number;
  /** Which knob produced the resolved value, for logs and error messages. */
  source: AdapterExecutionTargetTimeoutSource;
}

export function resolveAdapterExecutionTargetTimeout(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): AdapterExecutionTargetTimeoutResolution {
  if (typeof configuredTimeoutSec === "number" && Number.isFinite(configuredTimeoutSec)) {
    // Preserve fractional (sub-second) configured values instead of flooring:
    // adapters historically honored e.g. timeoutSec=0.5, and flooring would
    // silently turn it into "no timeout".
    if (configuredTimeoutSec > 0) {
      return { timeoutSec: configuredTimeoutSec, source: "configured" };
    }
    // A negative timeoutSec is the explicit "no adapter wall-clock timeout"
    // opt-out, honored even on sandbox targets. Zero cannot carry that
    // meaning: the adapter config UI persists the schema default of 0 for
    // untouched fields, so timeoutSec=0 in stored config does not signal
    // operator intent and falls through to target defaults below.
    if (configuredTimeoutSec < 0) {
      return { timeoutSec: 0, source: "configured" };
    }
  }
  // Local and SSH adapters preserve the historical "0 means no adapter
  // timeout" behavior. Sandbox-backed runs execute through provider RPCs
  // that usually apply their own shorter command defaults, so request an
  // explicit longer timeout for full adapter runs when the adapter leaves
  // timeoutSec unset.
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return { timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC, source: "sandbox_default" };
  }
  return { timeoutSec: 0, source: "unlimited" };
}

export function resolveAdapterExecutionTargetTimeoutSec(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): number {
  return resolveAdapterExecutionTargetTimeout(target, configuredTimeoutSec).timeoutSec;
}

function describeAdapterExecutionTimeoutSource(
  source: AdapterExecutionTargetTimeoutSource,
): string {
  switch (source) {
    case "configured":
      return "configured via adapterConfig.timeoutSec";
    case "sandbox_default":
      return "sandbox default";
    case "unlimited":
      return "no adapter wall-clock timeout";
  }
}

/**
 * Self-describing error message for when the adapter wall-clock execution
 * timeout kills a run. Names the timer that fired and the knob that controls
 * it so run failures never surface as a bare "Timed out".
 */
export function formatAdapterExecutionTimeoutErrorMessage(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  return (
    `Run exceeded the adapter execution timeout ` +
    `(timeoutSec=${resolution.timeoutSec}, ${describeAdapterExecutionTimeoutSource(resolution.source)}). ` +
    `Set adapterConfig.timeoutSec to raise it.`
  );
}

/**
 * One-line start-of-run statement of the effective wall-clock timeout and its
 * source. Callers prefix with `[paperclip] ` and append a newline.
 */
export function formatAdapterExecutionTimeoutStartLogLine(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  if (resolution.timeoutSec <= 0) {
    if (resolution.source === "configured") {
      return (
        "Adapter execution timeout: none " +
        "(explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one)."
      );
    }
    return (
      "Adapter execution timeout: none " +
      "(no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one)."
    );
  }
  return (
    `Adapter execution timeout: timeoutSec=${resolution.timeoutSec} ` +
    `(${describeAdapterExecutionTimeoutSource(resolution.source)}; set adapterConfig.timeoutSec to override).`
  );
}

function requireSandboxRunner(target: AdapterSandboxExecutionTarget): CommandManagedRuntimeRunner {
  if (target.runner) return target.runner;
  throw new Error(
    "Sandbox execution target is missing its provider runtime runner. Sandbox commands must execute through the environment runtime.",
  );
}

function preferredSandboxShell(target: AdapterSandboxExecutionTarget): "bash" | "sh" {
  return preferredShellForSandbox(target.shellCommand);
}

type AdapterCommandCapableExecutionTarget = AdapterSshExecutionTarget | AdapterSandboxExecutionTarget;

function adapterExecutionTargetCommandRunner(target: AdapterCommandCapableExecutionTarget): CommandManagedRuntimeRunner {
  if (target.transport === "ssh") {
    return createSshCommandManagedRuntimeRunner({
      spec: target.spec,
      defaultCwd: target.remoteCwd,
      maxBufferBytes: DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES * 4,
    });
  }
  return requireSandboxRunner(target);
}

function adapterExecutionTargetShellCommand(target: AdapterCommandCapableExecutionTarget): "bash" | "sh" {
  return target.transport === "ssh" ? "sh" : preferredSandboxShell(target);
}

function adapterExecutionTargetTimeoutMs(
  target: AdapterCommandCapableExecutionTarget,
): number | null | undefined {
  return target.transport === "sandbox" ? target.timeoutMs : undefined;
}

export async function ensureAdapterExecutionTargetCommandResolvable(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { installCommand?: string | null; timeoutSec?: number | null } = {},
) {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    await ensureSandboxCommandResolvable(
      command,
      target,
      options.installCommand?.trim() || null,
      options.timeoutSec,
    );
    return;
  }
  await ensureCommandResolvable(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

async function probeSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
): Promise<{ resolved: boolean; timedOut: boolean; stderr: string }> {
  const runner = requireSandboxRunner(target);
  const probeScript = `command -v ${shellQuote(command)}`;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", probeScript],
    cwd: target.remoteCwd,
    timeoutMs: target.timeoutMs ?? 15_000,
  });
  return {
    resolved: !result.timedOut && (result.exitCode ?? 1) === 0,
    timedOut: result.timedOut,
    stderr: result.stderr.trim(),
  };
}

async function ensureSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
  installCommand: string | null,
  timeoutSec?: number | null,
): Promise<void> {
  // Probe whether the binary is resolvable inside the sandbox. We previously
  // short-circuited this for sandbox targets, which let the caller report a
  // success message even when the CLI was missing from the image. Now we run
  // a real `command -v` through the same runner the hello probe will use, so
  // the first step honestly reflects whether the binary is on PATH. The
  // sandbox provider is responsible for sourcing login profiles (e2b mirrors
  // SSH's buildSshSpawnTarget) so this and the hello probe agree on PATH.
  let probe = await probeSandboxCommandResolvable(command, target);
  if (probe.resolved) return;
  if (probe.timedOut) {
    throw new Error(`Timed out checking command "${command}" on sandbox target.`);
  }

  // If the caller supplied an install command, attempt the install once via
  // the sandbox runner (which the sandbox provider wraps in a login shell)
  // and re-probe before reporting failure. This lets fresh sandbox leases
  // bring up the CLI before the resolvability gate, mirroring the test path.
  let installFailureDetail: string | null = null;
  if (installCommand) {
    const runner = requireSandboxRunner(target);
    const installTimeoutMs =
      typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
        ? Math.floor(timeoutSec * 1000)
        : target.timeoutMs ?? 300_000;
    try {
      const installResult = await runner.execute({
        command: "sh",
        args: shellCommandArgs(installCommand),
        cwd: target.remoteCwd,
        timeoutMs: installTimeoutMs,
      });
      if (installResult.timedOut) {
        installFailureDetail = `install command timed out: ${installCommand}`;
      } else if ((installResult.exitCode ?? 0) !== 0) {
        const tail = (text: string) =>
          text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-2).join(" | ").slice(0, 240);
        const reason = tail(installResult.stderr || installResult.stdout) || `exit ${installResult.exitCode ?? "?"}`;
        installFailureDetail = `install command exited ${installResult.exitCode ?? "?"}: ${reason}`;
      }
    } catch (err) {
      installFailureDetail = `install command threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    probe = await probeSandboxCommandResolvable(command, target);
    if (probe.resolved) return;
    if (probe.timedOut) {
      throw new Error(`Timed out checking command "${command}" on sandbox target.`);
    }
  }

  const probeStderr = probe.stderr.length > 0 ? ` probe stderr: ${probe.stderr}` : "";
  const installDetail = installFailureDetail ? `; ${installFailureDetail}` : "";
  throw new Error(
    `Command "${command}" is not installed or not on PATH in the sandbox environment${installDetail}.${probeStderr}`,
  );
}

export async function resolveAdapterExecutionTargetCommandForLogs(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return `sandbox://${target.providerKey ?? "provider"}/${target.leaseId ?? "lease"}/${target.remoteCwd} :: ${command}`;
  }
  return await resolveCommandForLogs(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetProcess(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  args: string[],
  options: AdapterExecutionTargetProcessOptions,
): Promise<RunProcessResult> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    const runner = requireSandboxRunner(target);
    const env = sanitizeRemoteExecutionEnv(options.env);
    await options.onRuntimeProgress?.({
      phase: "adapter_startup",
      message: "Starting adapter in sandbox",
    });
    const runLogTail = options.runLogTail?.create() ?? null;
    let execCommand = command;
    let execArgs = args;
    if (runLogTail) {
      ({ command: execCommand, args: execArgs } = runLogTail.wrapCommand(command, args));
      runLogTail.start(options.onLog);
    }
    try {
      const result = await runner.execute({
        command: execCommand,
        args: execArgs,
        cwd: target.remoteCwd,
        env,
        stdin: options.stdin,
        timeoutMs: options.timeoutSec > 0 ? options.timeoutSec * 1000 : target.timeoutMs ?? undefined,
        // The tail loop already streams incremental chunks; suppress the
        // runner's end-of-run batched onLog to avoid duplicate log bytes.
        onLog: runLogTail ? undefined : options.onLog,
        onSpawn: options.onSpawn
          ? async (meta) => options.onSpawn?.({ ...meta, processGroupId: null })
          : undefined,
      });
      if (runLogTail) {
        await runLogTail.finish({ stdout: result.stdout, stderr: result.stderr });
      }
      return result;
    } catch (error) {
      if (runLogTail) {
        await runLogTail.abort();
      }
      throw error;
    }
  }

  const env =
    target?.kind === "remote" && target.transport === "ssh"
      ? sanitizeRemoteExecutionEnv(options.env)
      : options.env;

  return await runChildProcess(runId, command, args, {
    cwd: options.cwd,
    env,
    stdin: options.stdin,
    timeoutSec: options.timeoutSec,
    graceSec: options.graceSec,
    onLog: options.onLog,
    onSpawn: options.onSpawn,
    terminalResultCleanup: options.terminalResultCleanup,
    localProcessSandbox: target?.kind === "local" || !target ? options.localProcessSandbox : null,
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetShellCommand(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<RunProcessResult> {
  const onLog = options.onLog ?? (async () => {});
  if (target?.kind === "remote") {
    const startedAt = new Date().toISOString();
    const env = sanitizeRemoteExecutionEnv(options.env);
    if (target.transport === "ssh") {
      try {
        // Pass the raw command — `runSshCommand` owns profile sourcing and
        // the outer shell wrapper. Wrapping again here would nest a second
        // shell after the explicit `env KEY=VAL` overrides, re-sourcing
        // login profiles AFTER the override and silently undoing any
        // identity var (NVM_DIR / PATH / etc.) that a profile re-exports.
        const result = await runSshCommand(target.spec, command, {
          env,
          timeoutMs: (options.timeoutSec ?? 15) * 1000,
        });
        if (result.stdout) await onLog("stdout", result.stdout);
        if (result.stderr) await onLog("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const timedOutError = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          signal?: string | null;
        };
        const stdout = timedOutError.stdout ?? "";
        const stderr = timedOutError.stderr ?? "";
        if (typeof timedOutError.code === "number") {
          if (stdout) await onLog("stdout", stdout);
          if (stderr) await onLog("stderr", stderr);
          return {
            exitCode: timedOutError.code,
            signal: timedOutError.signal ?? null,
            timedOut: false,
            stdout,
            stderr,
            pid: null,
            startedAt,
          };
        }
        if (timedOutError.code !== "ETIMEDOUT") {
          throw error;
        }
        if (stdout) await onLog("stdout", stdout);
        if (stderr) await onLog("stderr", stderr);
        return {
          exitCode: null,
          signal: timedOutError.signal ?? null,
          timedOut: true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    }

    const shellCommand = preferredSandboxShell(target);
    return await requireSandboxRunner(target).execute({
      command: shellCommand,
      args: shellCommandArgs(command),
      cwd: target.remoteCwd,
      env,
      timeoutMs: (options.timeoutSec ?? 15) * 1000,
      onLog,
    });
  }

  return await runAdapterExecutionTargetProcess(
    runId,
    target,
    "sh",
    ["-lc", command],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: options.timeoutSec ?? 15,
      graceSec: options.graceSec ?? 5,
      onLog,
    },
  );
}

export interface AdapterSandboxInstallCommandCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  hint?: string;
}

// Best-effort run of an adapter-supplied install command on a sandbox target
// before the resolvability + hello probe. Returns null for non-sandbox
// targets so callers can no-op. Returns a structured check otherwise — never
// throws — so the rest of the test still runs and reports the post-install
// state honestly. Caller pushes the check into its result array; the test
// report shows whether install was attempted and what came back.
export async function maybeRunSandboxInstallCommand(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  installCommand: string;
  /** When provided, skip the install if `command -v <detectCommand>` succeeds. */
  detectCommand?: string | null;
  env?: Record<string, string>;
  timeoutSec?: number;
}): Promise<AdapterSandboxInstallCommandCheck | null> {
  const { target, adapterKey, installCommand } = input;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    return null;
  }
  const trimmed = installCommand.trim();
  if (trimmed.length === 0) return null;

  const code = `${adapterKey}_install_command_run`;

  // Skip install when the binary is already on PATH. Avoids running
  // network-dependent installers (e.g. `curl ... | bash`) on every test
  // probe when the CLI is preinstalled on the lease/template.
  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    try {
      const probe = await runAdapterExecutionTargetShellCommand(
        input.runId,
        target,
        `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
        {
          cwd: target.remoteCwd,
          env: input.env ?? {},
          timeoutSec: 30,
          graceSec: 5,
        },
      );
      if (!probe.timedOut && probe.exitCode === 0) {
        return {
          code,
          level: "info",
          message: `${detectCommand} already on PATH; skipped install.`,
        };
      }
    } catch {
      // Fall through to actually running the install — failure to probe
      // is not a reason to skip the install gate.
    }
  }

  let result;
  try {
    result = await runAdapterExecutionTargetShellCommand(input.runId, target, trimmed, {
      cwd: target.remoteCwd,
      env: input.env ?? {},
      timeoutSec: input.timeoutSec ?? 240,
      graceSec: 10,
    });
  } catch (err) {
    return {
      code,
      level: "warn",
      message: "Install command threw before completion.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const tail = (text: string) =>
    text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join(" | ").slice(0, 480);
  if (result.timedOut) {
    return {
      code,
      level: "warn",
      message: `Install command timed out: ${trimmed}`,
      detail: tail(result.stderr || result.stdout),
    };
  }
  if ((result.exitCode ?? 1) === 0) {
    return {
      code,
      level: "info",
      message: `Install command ran: ${trimmed}`,
      ...(tail(result.stdout) ? { detail: tail(result.stdout) } : {}),
    };
  }
  return {
    code,
    level: "warn",
    message: `Install command exited ${result.exitCode}: ${trimmed}`,
    detail: tail(result.stderr || result.stdout),
  };
}

export async function readAdapterExecutionTargetHomeDir(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  options: AdapterExecutionTargetShellOptions,
): Promise<string | null> {
  const result = await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    'printf %s "$HOME"',
    options,
  );
  const homeDir = result.stdout.trim();
  return homeDir.length > 0 ? homeDir : null;
}

export async function ensureAdapterExecutionTargetRuntimeCommandInstalled(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  installCommand?: string | null;
  detectCommand?: string | null;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: AdapterExecutionTargetShellOptions["onLog"];
}): Promise<void> {
  const installCommand = input.installCommand?.trim();
  if (!installCommand || input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return;
  }

  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    const probe = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!probe.timedOut && probe.exitCode === 0) {
      return;
    }
  }

  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    installCommand,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
      onLog: input.onLog,
    },
  );

  // A failed or timed-out install is not necessarily fatal: the CLI may already
  // be on PATH from a previous lease's install, the template image, or another
  // path entry. Re-run the detect probe (when one is configured) so a transient
  // install failure does not abort the agent run when the binary is reachable.
  const installFailed = result.timedOut || (result.exitCode ?? 0) !== 0;
  if (!installFailed) {
    return;
  }
  if (detectCommand) {
    const recheck = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!recheck.timedOut && recheck.exitCode === 0) {
      if (input.onLog) {
        const reason = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"}`;
        await input.onLog(
          "stderr",
          `[paperclip] Install command ${reason} (${installCommand}) but ${detectCommand} is on PATH; continuing.\n`,
        );
      }
      return;
    }
  }

  if (result.timedOut) {
    throw new Error(`Timed out while installing the adapter runtime command via: ${installCommand}`);
  }
  throw new Error(`Failed to install the adapter runtime command via: ${installCommand}`);
}

export async function ensureAdapterExecutionTargetFile(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  filePath: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && : > ${shellQuote(filePath)}`,
    options,
  );
}

/**
 * Ensure a working directory exists (and is a directory) on the execution target.
 *
 * For local targets this delegates to the local `ensureAbsoluteDirectory` helper
 * (Node fs). For remote (SSH/sandbox) targets it shells out and runs
 * `mkdir -p` (when allowed) followed by a `[ -d ]` check so the result reflects
 * the directory state inside the environment, not on the Paperclip host.
 *
 * Throws an Error with a human-readable message on failure.
 */
export async function ensureAdapterExecutionTargetDirectory(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  options: AdapterExecutionTargetShellOptions & { createIfMissing?: boolean },
): Promise<void> {
  const createIfMissing = options.createIfMissing ?? false;

  if (!target || target.kind === "local") {
    const { ensureAbsoluteDirectory } = await import("./server-utils.js");
    await ensureAbsoluteDirectory(cwd, { createIfMissing });
    return;
  }

  // Remote (SSH or sandbox): both expect POSIX absolute paths inside the env.
  if (!cwd.startsWith("/")) {
    throw new Error(`Working directory must be an absolute POSIX path on the remote target: "${cwd}"`);
  }

  const quoted = shellQuote(cwd);
  const script = createIfMissing
    ? `mkdir -p ${quoted} && [ -d ${quoted} ]`
    : `[ -d ${quoted} ]`;

  const result = await runAdapterExecutionTargetShellCommand(runId, target, script, {
    cwd: target.kind === "remote" ? target.remoteCwd : cwd,
    env: options.env,
    timeoutSec: options.timeoutSec ?? 15,
    graceSec: options.graceSec ?? 5,
    onLog: options.onLog,
  });

  if (result.timedOut) {
    throw new Error(`Timed out checking working directory on remote target: "${cwd}"`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    if (createIfMissing) {
      throw new Error(
        `Could not create working directory "${cwd}" on remote target${detail ? `: ${detail}` : "."}`,
      );
    }
    throw new Error(
      `Working directory does not exist on remote target: "${cwd}"${detail ? ` (${detail})` : ""}`,
    );
  }
}

export function adapterExecutionTargetSessionIdentity(
  target: AdapterExecutionTarget | null | undefined,
): Record<string, unknown> | null {
  if (!target || target.kind === "local") return null;
  if (target.transport === "ssh") return buildRemoteExecutionSessionIdentity(target.spec);
  return {
    transport: "sandbox",
    providerKey: target.providerKey ?? null,
    environmentId: target.environmentId ?? null,
    leaseId: target.leaseId ?? null,
    remoteCwd: target.remoteCwd,
  };
}

export function adapterExecutionTargetSessionMatches(
  saved: unknown,
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  if (!target || target.kind === "local") {
    return Object.keys(parseObject(saved)).length === 0;
  }
  if (target.transport === "ssh") return remoteExecutionSessionMatches(saved, target.spec);
  const current = adapterExecutionTargetSessionIdentity(target);
  const parsedSaved = parseObject(saved);
  return (
    readStringMeta(parsedSaved, "transport") === current?.transport &&
    readStringMeta(parsedSaved, "providerKey") === current?.providerKey &&
    readStringMeta(parsedSaved, "environmentId") === current?.environmentId &&
    readStringMeta(parsedSaved, "leaseId") === current?.leaseId &&
    readStringMeta(parsedSaved, "remoteCwd") === current?.remoteCwd
  );
}

export function parseAdapterExecutionTarget(value: unknown): AdapterExecutionTarget | null {
  const parsed = parseObject(value);
  const kind = readStringMeta(parsed, "kind");

  if (kind === "local") {
    return {
      kind: "local",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "ssh") {
    const spec = parseSshRemoteExecutionSpec(parseObject(parsed.spec));
    if (!spec) return null;
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd: spec.remoteCwd,
      spec,
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "sandbox") {
    const remoteCwd = readStringMeta(parsed, "remoteCwd");
    if (!remoteCwd) return null;
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: readStringMeta(parsed, "providerKey"),
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd,
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : null,
      streamRunLogs: typeof parsed.streamRunLogs === "boolean" ? parsed.streamRunLogs : null,
    };
  }

  return null;
}

export function adapterExecutionTargetFromRemoteExecution(
  remoteExecution: unknown,
  metadata: Pick<AdapterLocalExecutionTarget, "environmentId" | "leaseId"> = {},
): AdapterExecutionTarget | null {
  const parsed = parseObject(remoteExecution);
  const ssh = parseSshRemoteExecutionSpec(parsed);
  if (ssh) {
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: metadata.environmentId ?? null,
      leaseId: metadata.leaseId ?? null,
      remoteCwd: ssh.remoteCwd,
      spec: ssh,
    };
  }

  return null;
}

export function readAdapterExecutionTarget(input: {
  executionTarget?: unknown;
  legacyRemoteExecution?: unknown;
}): AdapterExecutionTarget | null {
  if (isAdapterExecutionTargetInstance(input.executionTarget)) {
    return input.executionTarget;
  }
  return (
    parseAdapterExecutionTarget(input.executionTarget) ??
    adapterExecutionTargetFromRemoteExecution(input.legacyRemoteExecution)
  );
}

export async function prepareAdapterExecutionTargetRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  workspaceLocalDir: string;
  timeoutSec?: number;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: AdapterManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage into the sandbox as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  installCommand?: string | null;
  /** When provided alongside `installCommand`, skip the install if the binary is already on PATH. */
  detectCommand?: string | null;
  // Optional progress sink for the workspace/asset upload. The returned
  // `restoreWorkspace(onProgress?)` accepts its own sink for teardown. Both are
  // forwarded down to the transport so the sandbox/SSH children can attach byte
  // counters without further changes here.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  const target = input.target ?? { kind: "local" as const };
  if (target.kind === "local") {
    return {
      target,
      workspaceRemoteDir: null,
      runtimeRootDir: null,
      assetDirs: {},
      additionalSourceDirs: {},
      additionalSourceFailures: [],
      restoreWorkspace: async () => {},
    };
  }

  if (target.transport === "ssh") {
    const prepared = await prepareRemoteManagedRuntime({
      spec: target.spec,
      runId: input.runId,
      adapterKey: input.adapterKey,
      workspaceLocalDir: input.workspaceLocalDir,
      workspaceRemoteDir: input.workspaceRemoteDir,
      syncWorkspace: input.syncWorkspace,
      assets: input.assets,
      additionalSources: input.additionalSources,
      onProgress: input.onProgress,
    });
    return {
      target,
      workspaceRemoteDir: prepared.workspaceRemoteDir,
      runtimeRootDir: prepared.runtimeRootDir,
      assetDirs: prepared.assetDirs,
      additionalSourceDirs: prepared.additionalSourceDirs,
      // The SSH transport does not stage referenced projects (it is out of scope), so it never
      // reports a per-project staging failure.
      additionalSourceFailures: [],
      restoreWorkspace: prepared.restoreWorkspace,
    };
  }

  const prepared = await prepareCommandManagedRuntime({
    runner: requireSandboxRunner(target),
    spec: {
      providerKey: target.providerKey,
      shellCommand: target.shellCommand,
      leaseId: target.leaseId,
      remoteCwd: target.remoteCwd,
      timeoutMs:
        input.timeoutSec && input.timeoutSec > 0
          ? input.timeoutSec * 1000
          : target.timeoutMs,
    },
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir: input.workspaceRemoteDir,
    syncWorkspace: input.syncWorkspace,
    workspaceExclude: input.workspaceExclude,
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
    additionalSources: input.additionalSources,
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    onProgress: input.onProgress,
    onRuntimeProgress: input.onRuntimeProgress,
  });
  return {
    target,
    workspaceRemoteDir: prepared.workspaceRemoteDir,
    runtimeRootDir: prepared.runtimeRootDir,
    assetDirs: prepared.assetDirs,
    additionalSourceDirs: prepared.additionalSourceDirs,
    additionalSourceFailures: prepared.additionalSourceFailures,
    restoreWorkspace: prepared.restoreWorkspace,
  };
}

export function runtimeAssetDir(
  prepared: Pick<PreparedAdapterExecutionTargetRuntime, "assetDirs">,
  key: string,
  fallbackRemoteCwd: string,
): string {
  return prepared.assetDirs[key] ?? path.posix.join(fallbackRemoteCwd, ".paperclip-runtime", key);
}

function buildBridgeResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified"]) {
    const value = response.headers.get(key);
    if (value && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

function buildBridgeForwardUrl(baseUrl: string, request: { path: string; query: string }): URL {
  const url = new URL(request.path, baseUrl);
  const query = request.query.trim();
  url.search = query.startsWith("?") ? query.slice(1) : query;
  return url;
}

function bridgeResponseBodyLimitError(maxBodyBytes: number): Error {
  return new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
}

async function readBridgeForwardResponseBody(response: Response, maxBodyBytes: number): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength) {
    const contentLength = Number.parseInt(rawContentLength, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

const PROCESS_SESSION_PROXY_SCRIPT = "paperclip-process-session-proxy.mjs";
const PROCESS_SESSION_REMOTE_SCRIPT = "paperclip-process-session-remote.mjs";
const PROCESS_SESSION_AUTH_TIMEOUT_MS = 5_000;
const PROCESS_SESSION_STOP_NATURAL_GRACE_STEPS = 10;
const PROCESS_SESSION_STOP_TERM_GRACE_STEPS = 40;
const PROCESS_SESSION_STOP_KILL_GRACE_STEPS = 40;
const PROCESS_SESSION_STOP_MAX_ATTEMPTS = 2;

type RemoteProcessSessionState = {
  version: 1;
  sessionId: string;
  bridgePid: number;
  childPid: number | null;
  childProcessGroupId: number | null;
};

function parseRemoteProcessSessionState(raw: string, expectedSessionId: string): RemoteProcessSessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    throw new Error(
      `Sandbox ACP process session bridge wrote invalid state JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sandbox ACP process session bridge wrote an invalid state payload.");
  }
  const state = parsed as Record<string, unknown>;
  const bridgePid = typeof state.bridgePid === "number" && Number.isInteger(state.bridgePid) && state.bridgePid > 0
    ? state.bridgePid
    : null;
  const childPid = typeof state.childPid === "number" && Number.isInteger(state.childPid) && state.childPid > 0
    ? state.childPid
    : null;
  const childProcessGroupId =
    typeof state.childProcessGroupId === "number"
      && Number.isInteger(state.childProcessGroupId)
      && state.childProcessGroupId > 0
      ? state.childProcessGroupId
      : null;
  if (state.version !== 1 || state.sessionId !== expectedSessionId || bridgePid === null) {
    throw new Error("Sandbox ACP process session bridge state did not match the launched session.");
  }
  return {
    version: 1,
    sessionId: expectedSessionId,
    bridgePid,
    childPid,
    childProcessGroupId,
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function splitJsonLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\n/);
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

async function writeProcessSessionProxyScript(dir: string, port: number, token: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const proxyPath = path.join(dir, PROCESS_SESSION_PROXY_SCRIPT);
  await fs.writeFile(proxyPath, getProcessSessionProxySource({ port, token }), { mode: 0o700 });
  return proxyPath;
}

// Content-hash-skip the process-session remote script write, mirroring the
// sandbox callback bridge entrypoint sha256 gate. The script is a static
// Paperclip-authored `.mjs` that only changes when the build changes, so on a
// warm start (same sandbox, script already present) the single sha-gate exec
// skips the ~3-exec base64 upload entirely. `syncRemoteTextFileWithHashSkip`
// fails loud on a check error rather than silently re-uploading.
async function syncProcessSessionRemoteScript(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  remoteScriptDir: string;
  remoteScriptPath: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ uploaded: boolean }> {
  const { uploaded } = await syncRemoteTextFileWithHashSkip({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    remoteDir: input.remoteScriptDir,
    remotePath: input.remoteScriptPath,
    body: getProcessSessionRemoteSource(),
    label: "Process session remote script",
    action: "sync process session remote script",
    lockDir: path.posix.join(input.remoteScriptDir, ".paperclip-process-session-script.lock"),
    timeoutMs: input.timeoutMs,
    shellCommand: input.shellCommand,
  });
  return { uploaded };
}

async function readRemoteJsonFiles(input: {
  client: ReturnType<typeof createCommandManagedSandboxCallbackBridgeQueueClient>;
  dir: string;
}): Promise<Array<{ name: string; body: string }>> {
  const names = await input.client.listJsonFiles(input.dir);
  const out: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    const filePath = path.posix.join(input.dir, name);
    const body = await input.client.readTextFile(filePath);
    await input.client.remove(filePath).catch(() => undefined);
    out.push({ name, body });
  }
  return out;
}

async function waitForLocalServerListen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Process session bridge did not expose a TCP port.");
  }
  return address.port;
}

export async function startAdapterExecutionTargetProcessSessionBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  command: string;
  args: string[];
  cwd: string;
  // The launch env is consumed ONLY when building the base64 `commandPayload`
  // below — never during the env-INDEPENDENT dir/script setup. Accepting a
  // resolver (in addition to a plain object) lets a caller overlap that setup
  // with other work — e.g. starting the paperclip callback bridge — and hand the
  // merged env in right before the launch.
  env: Record<string, string> | (() => Promise<Record<string, string>>);
  timeoutSec?: number | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<AdapterExecutionTargetProcessSessionBridgeHandle | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const runner = requireSandboxRunner(target);
  const shellCommand = preferredSandboxShell(target);
  const timeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : target.timeoutMs ?? undefined;
  const bridgeRuntimeDir = path.posix.join(
    input.runtimeRootDir?.trim() || path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey),
    "process-sessions",
  );
  const sessionId = randomUUID();
  const sessionDir = path.posix.join(bridgeRuntimeDir, sessionId);
  const stdinDir = path.posix.join(sessionDir, "stdin");
  const eventsDir = path.posix.join(sessionDir, "events");
  const stateFile = path.posix.join(sessionDir, "process-state.json");
  const remoteScriptPath = path.posix.join(bridgeRuntimeDir, PROCESS_SESSION_REMOTE_SCRIPT);
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({
    runner,
    remoteCwd: target.remoteCwd,
    timeoutMs,
    shellCommand,
  });
  const cleanupTimeoutMs = Math.max(10_000, Math.min(timeoutMs ?? 15_000, 30_000));
  const rollbackRemoteLaunch = async () => {
    const sessionEnvMarker = `PAPERCLIP_PROCESS_SESSION_ID=${sessionId}`;
    const rollbackResult = await runner.execute({
      command: shellCommand,
      args: shellCommandArgs(
        [
          `session_env_marker=${shellQuote(sessionEnvMarker)}`,
          "pid_is_zombie() {",
          "  pid=\"$1\"",
          "  [ -r \"/proc/$pid/stat\" ] || return 1",
          "  stat_line=$(cat \"/proc/$pid/stat\" 2>/dev/null) || return 1",
          "  stat_tail=${stat_line##*) }",
          "  set -- $stat_tail",
          "  [ \"${1:-}\" = \"Z\" ]",
          "}",
          "pid_group() {",
          "  pid=\"$1\"",
          "  [ -r \"/proc/$pid/stat\" ] || return 1",
          "  stat_line=$(cat \"/proc/$pid/stat\" 2>/dev/null) || return 1",
          "  stat_tail=${stat_line##*) }",
          "  set -- $stat_tail",
          "  printf '%s\\n' \"${3:-0}\"",
          "}",
          "pid_has_session_marker() {",
          "  pid=\"$1\"",
          "  [ -r \"/proc/$pid/environ\" ] || return 1",
          "  tr '\\000' '\\n' < \"/proc/$pid/environ\" | grep -Fqx \"$session_env_marker\"",
          "}",
          "session_processes_alive() {",
          "  for environ_path in /proc/[0-9]*/environ; do",
          "    [ -r \"$environ_path\" ] || continue",
          "    pid=${environ_path#/proc/}",
          "    pid=${pid%/environ}",
          "    if pid_has_session_marker \"$pid\" && ! pid_is_zombie \"$pid\"; then return 0; fi",
          "  done",
          "  return 1",
          "}",
          "signal_session_processes() {",
          "  signal=\"$1\"",
          "  for environ_path in /proc/[0-9]*/environ; do",
          "    [ -r \"$environ_path\" ] || continue",
          "    pid=${environ_path#/proc/}",
          "    pid=${pid%/environ}",
          "    pid_has_session_marker \"$pid\" || continue",
          "    group_id=$(pid_group \"$pid\" 2>/dev/null || printf '0\\n')",
          "    if [ \"$group_id\" = \"$pid\" ]; then",
          "      kill \"-$signal\" -- \"-$group_id\" 2>/dev/null || true",
          "    else",
          "      kill \"-$signal\" \"$pid\" 2>/dev/null || true",
          "    fi",
          "  done",
          "}",
          "wait_for_session_exit() {",
          "  limit=\"$1\"",
          "  i=0",
          "  while session_processes_alive && [ \"$i\" -lt \"$limit\" ]; do",
          "    i=$((i + 1))",
          "    sleep 0.05",
          "  done",
          "  ! session_processes_alive",
          "}",
          "if [ ! -d /proc ]; then",
          "  echo \"Cannot verify sandbox ACP process identities without /proc.\" >&2",
          "  exit 1",
          "fi",
          "signal_session_processes TERM",
          `if ! wait_for_session_exit ${PROCESS_SESSION_STOP_TERM_GRACE_STEPS}; then`,
          "  signal_session_processes KILL",
          `  wait_for_session_exit ${PROCESS_SESSION_STOP_KILL_GRACE_STEPS} || true`,
          "fi",
          "if session_processes_alive; then",
          "  echo \"Sandbox ACP process session remained alive after launch rollback.\" >&2",
          "  exit 1",
          "fi",
        ].join("\n"),
      ),
      cwd: target.remoteCwd,
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
      timeoutMs: cleanupTimeoutMs,
    });
    if (rollbackResult.timedOut || (rollbackResult.exitCode ?? 1) !== 0) {
      throw new Error(
        `Failed to roll back sandbox ACP process session launch: ${rollbackResult.stderr || rollbackResult.stdout || "remote cleanup failed"}`,
      );
    }
    await client.remove(sessionDir).catch(() => undefined);
  };
  const throwAfterLaunchRollback = async (launchError: unknown): Promise<never> => {
    try {
      await rollbackRemoteLaunch();
    } catch (rollbackError) {
      throw new AggregateError(
        [launchError, rollbackError],
        "Sandbox ACP process session launch failed and its remote rollback could not be confirmed.",
      );
    }
    throw launchError;
  };

  // The launch exec below re-creates stdinDir and eventsDir with one `mkdir -p`,
  // and the remote script also creates them on start. No reader touches the two
  // directories before the launch exec runs, so upfront makeDir execs are redundant.
  await syncProcessSessionRemoteScript({
    runner,
    remoteCwd: target.remoteCwd,
    remoteScriptDir: bridgeRuntimeDir,
    remoteScriptPath,
    timeoutMs,
    shellCommand,
  });

  // Resolve the launch env AFTER the env-independent setup above, so a caller
  // can defer it until an upstream dependency (e.g. the paperclip bridge's env)
  // is ready without blocking the dir/script setup.
  const launchEnv = typeof input.env === "function" ? await input.env() : input.env;
  const commandPayload = Buffer.from(JSON.stringify({
    command: input.command,
    args: input.args,
    cwd: input.cwd || target.remoteCwd,
    env: sanitizeRemoteExecutionEnv(launchEnv),
  }), "utf8").toString("base64");

  await onLog("stdout", `[paperclip] Starting ACP process session bridge in sandbox (${target.providerKey ?? "provider"}).\n`);
  let startResult: RunProcessResult;
  try {
    startResult = await runner.execute({
      command: shellCommand,
      args: shellCommandArgs(
        [
          `mkdir -p ${shellQuote(stdinDir)} ${shellQuote(eventsDir)}`,
          `rm -f ${shellQuote(stateFile)}`,
          `PAPERCLIP_PROCESS_SESSION_DIR=${shellQuote(sessionDir)} ` +
            `PAPERCLIP_PROCESS_SESSION_ID=${shellQuote(sessionId)} ` +
            `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=${shellQuote(commandPayload)} ` +
            `nohup node ${shellQuote(remoteScriptPath)} >/dev/null 2>&1 < /dev/null &`,
          "bridge_pid=$!",
          "i=0",
          `while [ "$i" -lt 100 ] && [ ! -s ${shellQuote(stateFile)} ]; do`,
          "  if ! kill -0 \"$bridge_pid\" 2>/dev/null; then",
          "    echo \"Sandbox ACP process session bridge exited before writing process state.\" >&2",
          "    exit 1",
          "  fi",
          "  i=$((i + 1))",
          "  sleep 0.05",
          "done",
          `if [ ! -s ${shellQuote(stateFile)} ]; then`,
          "  echo \"Timed out waiting for sandbox ACP process session bridge state.\" >&2",
          "  exit 1",
          "fi",
          `cat ${shellQuote(stateFile)}`,
        ].join("\n"),
      ),
      cwd: target.remoteCwd,
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
      timeoutMs,
    });
  } catch (error) {
    return await throwAfterLaunchRollback(error);
  }
  if (startResult.timedOut || (startResult.exitCode ?? 1) !== 0) {
    return await throwAfterLaunchRollback(
      new Error(`Failed to start sandbox ACP process session bridge: ${startResult.stderr || startResult.stdout}`),
    );
  }
  let remoteState: RemoteProcessSessionState;
  try {
    remoteState = parseRemoteProcessSessionState(startResult.stdout, sessionId);
  } catch (error) {
    return await throwAfterLaunchRollback(error);
  }

  let socket: net.Socket | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let stdinSeq = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  const pendingRemoteEvents: Array<{
    type?: string;
    stream?: "stdout" | "stderr";
    data?: string;
    code?: number | null;
    signal?: string | null;
    message?: string;
  }> = [];
  const token = createSandboxCallbackBridgeToken(18);
  let proxyDir: string;
  try {
    proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-proxy-"));
  } catch (error) {
    return await throwAfterLaunchRollback(error);
  }

  const writeRemoteEventToSocket = (event: (typeof pendingRemoteEvents)[number]) => {
    if (!socket) return false;
    socket.write(jsonLine(event));
    if (event.type === "exit") {
      stopping = true;
      socket.end();
    } else if (event.type === "error") {
      stopping = true;
      socket.destroy();
    }
    return true;
  };

  const deliverRemoteEvent = (event: (typeof pendingRemoteEvents)[number]) => {
    if (socket) {
      writeRemoteEventToSocket(event);
      return;
    }
    pendingRemoteEvents.push(event);
    if (event.type === "exit" || event.type === "error") {
      stopping = true;
    }
  };

  const flushPendingRemoteEvents = () => {
    if (!socket) return;
    while (pendingRemoteEvents.length > 0 && socket) {
      const event = pendingRemoteEvents.shift();
      if (event) writeRemoteEventToSocket(event);
    }
  };

  const liveSockets = new Set<net.Socket>();
  const server = net.createServer((nextSocket) => {
    liveSockets.add(nextSocket);
    nextSocket.setEncoding("utf8");
    nextSocket.on("error", () => undefined);
    let connectionBuffer = "";
    let authenticated = false;
    // Connections own the session (and receive buffered process output) only
    // after presenting the bridge token; idle unauthenticated peers are dropped.
    const authTimer = setTimeout(() => {
      if (!authenticated) nextSocket.destroy();
    }, PROCESS_SESSION_AUTH_TIMEOUT_MS);
    authTimer.unref?.();
    nextSocket.on("close", () => {
      clearTimeout(authTimer);
      liveSockets.delete(nextSocket);
    });
    nextSocket.on("data", (chunk) => {
      connectionBuffer += chunk;
      const split = splitJsonLines(connectionBuffer);
      connectionBuffer = split.rest;
      for (const line of split.lines) {
        if (!line.trim()) continue;
        let message: { token?: string; type?: string; data?: string };
        try {
          message = JSON.parse(line) as { token?: string; type?: string; data?: string };
        } catch {
          nextSocket.destroy();
          return;
        }
        if (message.token !== token) {
          nextSocket.destroy();
          return;
        }
        if (!authenticated) {
          if (socket) {
            nextSocket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          socket = nextSocket;
          flushPendingRemoteEvents();
        }
        void (async () => {
          if (message.type === "stdin" && typeof message.data === "string") {
            stdinSeq += 1;
            const name = `${String(stdinSeq).padStart(12, "0")}.json`;
            await client.writeTextFile(path.posix.join(stdinDir, name), jsonLine({ type: "stdin", data: message.data }));
          } else if (message.type === "stdinEnd") {
            stdinSeq += 1;
            const name = `${String(stdinSeq).padStart(12, "0")}.json`;
            await client.writeTextFile(path.posix.join(stdinDir, name), jsonLine({ type: "stdinEnd" }));
          }
        })().catch((error) => {
          nextSocket.write(jsonLine({ type: "error", message: error instanceof Error ? error.message : String(error) }));
          nextSocket.destroy();
        });
      }
    });
  });

  const poll = async () => {
    if (stopping) return;
    try {
      const events = await readRemoteJsonFiles({ client, dir: eventsDir });
      for (const event of events) {
        const parsed = JSON.parse(event.body) as {
          type?: string;
          stream?: "stdout" | "stderr";
          data?: string;
          code?: number | null;
          signal?: string | null;
          message?: string;
        };
        deliverRemoteEvent(parsed);
        if (parsed.type === "exit" || parsed.type === "error") return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await onLog("stderr", `[paperclip] ACP process session bridge poll failed: ${message}\n`);
      deliverRemoteEvent({ type: "error", message });
      return;
    } finally {
      if (!stopping) {
        pollTimer = setTimeout(() => void poll(), 100);
        pollTimer.unref?.();
      }
    }
  };

  let agentCommand: string;
  try {
    const port = await waitForLocalServerListen(server);
    agentCommand = await writeProcessSessionProxyScript(proxyDir, port, token);
  } catch (error) {
    stopping = true;
    for (const liveSocket of liveSockets) liveSocket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => undefined);
    return await throwAfterLaunchRollback(error);
  }
  pollTimer = setTimeout(() => void poll(), 100);
  pollTimer.unref?.();

  const stopRemoteSession = async () => {
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    for (const liveSocket of liveSockets) liveSocket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);

    stdinSeq += 1;
    await client.writeTextFile(
      path.posix.join(stdinDir, `${String(stdinSeq).padStart(12, "0")}.json`),
      jsonLine({ type: "stdinEnd" }),
    ).catch(() => undefined);

    const bridgePid = String(remoteState.bridgePid);
    const childPid = String(remoteState.childPid ?? 0);
    const childProcessGroupId = String(remoteState.childProcessGroupId ?? 0);
    const sessionEnvMarker = `PAPERCLIP_PROCESS_SESSION_ID=${sessionId}`;
    const stopTimeoutMs = Math.max(10_000, Math.min(timeoutMs ?? 15_000, 30_000));
    let remoteStopped = false;
    try {
      const stopResult = await runner.execute({
        command: shellCommand,
        args: shellCommandArgs(
          [
            `bridge_pid=${shellQuote(bridgePid)}`,
            `child_pid=${shellQuote(childPid)}`,
            `child_group_id=${shellQuote(childProcessGroupId)}`,
            `session_env_marker=${shellQuote(sessionEnvMarker)}`,
            "pid_exists() {",
            "  [ \"$1\" -gt 0 ] 2>/dev/null || return 1",
            "  if [ -d /proc ]; then [ -d \"/proc/$1\" ]; else kill -0 \"$1\" 2>/dev/null; fi",
            "}",
            "pid_is_zombie() {",
            "  pid=\"$1\"",
            "  [ -r \"/proc/$pid/stat\" ] || return 1",
            "  stat_line=$(cat \"/proc/$pid/stat\" 2>/dev/null) || return 1",
            "  stat_tail=${stat_line##*) }",
            "  set -- $stat_tail",
            "  [ \"${1:-}\" = \"Z\" ]",
            "}",
            "pid_active() { pid_exists \"$1\" && ! pid_is_zombie \"$1\"; }",
            "pid_in_group() {",
            "  pid=\"$1\"",
            "  expected_group=\"$2\"",
            "  [ -r \"/proc/$pid/stat\" ] || return 1",
            "  stat_line=$(cat \"/proc/$pid/stat\" 2>/dev/null) || return 1",
            "  stat_tail=${stat_line##*) }",
            "  set -- $stat_tail",
            "  [ \"${3:-}\" = \"$expected_group\" ]",
            "}",
            "group_has_active_members() {",
            "  group_id=\"$1\"",
            "  [ \"$group_id\" -gt 0 ] 2>/dev/null || return 1",
            "  if [ -d /proc ]; then",
            "    for stat_path in /proc/[0-9]*/stat; do",
            "      [ -r \"$stat_path\" ] || continue",
            "      candidate_pid=${stat_path#/proc/}",
            "      candidate_pid=${candidate_pid%/stat}",
            "      if pid_in_group \"$candidate_pid\" \"$group_id\" && ! pid_is_zombie \"$candidate_pid\"; then",
            "        return 0",
            "      fi",
            "    done",
            "    return 1",
            "  fi",
            "  kill -0 -- \"-$group_id\" 2>/dev/null",
            "}",
            "pid_has_session_marker() {",
            "  pid=\"$1\"",
            "  if [ -r \"/proc/$pid/environ\" ]; then",
            "    tr '\\000' '\\n' < \"/proc/$pid/environ\" | grep -Fqx \"$session_env_marker\"",
            "    return $?",
            "  fi",
            "  return 1",
            "}",
            "pid_matches_session() {",
            "  pid=\"$1\"",
            "  pid_active \"$pid\" || return 1",
            "  if [ -d /proc ]; then pid_has_session_marker \"$pid\"; else return 1; fi",
            "}",
            "pid_identity_conflict() {",
            "  pid=\"$1\"",
            "  pid_active \"$pid\" && ! pid_matches_session \"$pid\" && pid_active \"$pid\"",
            "}",
            "group_matches_session() {",
            "  group_id=\"$1\"",
            "  group_has_active_members \"$group_id\" || return 1",
            "  if pid_exists \"$child_pid\" && pid_is_zombie \"$child_pid\" && pid_in_group \"$child_pid\" \"$group_id\"; then",
            "    return 0",
            "  fi",
            "  if [ -d /proc ]; then",
            "    for stat_path in /proc/[0-9]*/stat; do",
            "      [ -r \"$stat_path\" ] || continue",
            "      candidate_pid=${stat_path#/proc/}",
            "      candidate_pid=${candidate_pid%/stat}",
            "      if pid_in_group \"$candidate_pid\" \"$group_id\" && pid_active \"$candidate_pid\" && pid_has_session_marker \"$candidate_pid\"; then",
            "        return 0",
            "      fi",
            "    done",
            "    return 1",
            "  fi",
            "  return 1",
            "}",
            "group_identity_conflict() {",
            "  group_id=\"$1\"",
            "  group_has_active_members \"$group_id\" && ! group_matches_session \"$group_id\" && group_has_active_members \"$group_id\"",
            "}",
            "bridge_alive() { pid_matches_session \"$bridge_pid\"; }",
            "child_alive() {",
            "  if [ \"$child_group_id\" -gt 0 ] 2>/dev/null; then",
            "    group_matches_session \"$child_group_id\"",
            "  else",
            "    pid_matches_session \"$child_pid\"",
            "  fi",
            "}",
            "session_alive() { bridge_alive || child_alive; }",
            "session_identity_conflict() {",
            "  pid_identity_conflict \"$bridge_pid\" && return 0",
            "  if [ \"$child_group_id\" -gt 0 ] 2>/dev/null; then",
            "    group_identity_conflict \"$child_group_id\"",
            "  else",
            "    pid_identity_conflict \"$child_pid\"",
            "  fi",
            "}",
            "wait_for_exit() {",
            "  limit=\"$1\"",
            "  i=0",
            "  while session_alive && [ \"$i\" -lt \"$limit\" ]; do",
            "    i=$((i + 1))",
            "    sleep 0.05",
            "  done",
            "  ! session_alive",
            "}",
            `if ! wait_for_exit ${PROCESS_SESSION_STOP_NATURAL_GRACE_STEPS}; then`,
            "  if child_alive; then",
            "    if [ \"$child_group_id\" -gt 0 ] 2>/dev/null; then",
            "      kill -TERM -- \"-$child_group_id\" 2>/dev/null || true",
            "    else",
            "      kill -TERM \"$child_pid\" 2>/dev/null || true",
            "    fi",
            "  fi",
            "  if bridge_alive; then kill -TERM \"$bridge_pid\" 2>/dev/null || true; fi",
            `  if ! wait_for_exit ${PROCESS_SESSION_STOP_TERM_GRACE_STEPS}; then`,
            "    if child_alive; then",
            "      if [ \"$child_group_id\" -gt 0 ] 2>/dev/null; then",
            "        kill -KILL -- \"-$child_group_id\" 2>/dev/null || true",
            "      else",
            "        kill -KILL \"$child_pid\" 2>/dev/null || true",
            "      fi",
            "    fi",
            "    if bridge_alive; then kill -KILL \"$bridge_pid\" 2>/dev/null || true; fi",
            `    wait_for_exit ${PROCESS_SESSION_STOP_KILL_GRACE_STEPS} || true`,
            "  fi",
            "fi",
            "if session_alive; then",
            "  echo \"Sandbox ACP process session bridge or child remained alive after SIGKILL.\" >&2",
            "  exit 1",
            "fi",
            "if session_identity_conflict; then",
            "  echo \"Refusing to signal a reused or unverifiable sandbox ACP process identity.\" >&2",
            "  exit 1",
            "fi",
          ].join("\n"),
        ),
        cwd: target.remoteCwd,
        env: {
          PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
        },
        timeoutMs: stopTimeoutMs,
      });
      if (stopResult.timedOut || (stopResult.exitCode ?? 1) !== 0) {
        throw new Error(
          `Failed to stop sandbox ACP process session bridge: ${stopResult.stderr || stopResult.stdout || "remote cleanup failed"}`,
        );
      }
      remoteStopped = true;
    } finally {
      // The stdin marker directory is the remote bridge's control plane. Keep
      // it intact unless the persisted bridge/child identities are confirmed
      // dead, otherwise removing it strands pollStdin in a permanent empty loop.
      if (remoteStopped) {
        await client.remove(sessionDir).catch(() => undefined);
      }
      await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return {
    agentCommand,
    stop: async () => {
      if (!stopPromise) {
        stopPromise = (async () => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= PROCESS_SESSION_STOP_MAX_ATTEMPTS; attempt += 1) {
            try {
              await stopRemoteSession();
              return;
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError;
        })();
      }
      try {
        await stopPromise;
      } catch (error) {
        // A later teardown attempt must be able to retry a transient runner
        // failure. The remote control directory remains intact on failure.
        stopPromise = null;
        throw error;
      }
    },
  };
}

function getProcessSessionProxySource(input: { port: number; token: string }): string {
  return `#!/usr/bin/env node
import net from "node:net";

const socket = net.createConnection({ host: "127.0.0.1", port: ${input.port} });
const token = ${JSON.stringify(input.token)};
let buffer = "";
let exiting = false;

function send(message) {
  socket.write(JSON.stringify({ token, ...message }) + "\\n");
}

socket.on("connect", () => send({ type: "hello" }));
process.stdin.on("data", (chunk) => send({ type: "stdin", data: Buffer.from(chunk).toString("base64") }));
process.stdin.on("end", () => send({ type: "stdinEnd" }));
process.stdin.resume();

socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split(/\\n/);
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "data") {
      const out = Buffer.from(message.data || "", "base64");
      (message.stream === "stderr" ? process.stderr : process.stdout).write(out);
    } else if (message.type === "error") {
      process.stderr.write(String(message.message || "Process session bridge failed.") + "\\n");
      exiting = true;
      process.exitCode = 1;
      socket.end();
    } else if (message.type === "exit") {
      exiting = true;
      process.exitCode = typeof message.code === "number" ? message.code : 1;
      socket.end();
    }
  }
});
socket.on("close", () => {
  if (!exiting) process.exit(1);
});
`;
}

function getProcessSessionRemoteSource(): string {
  return `import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;
const sessionId = process.env.PAPERCLIP_PROCESS_SESSION_ID;
const commandPayload = process.env.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;
if (!sessionDir || !sessionId || !commandPayload) throw new Error("Missing process session bridge env.");

const stdinDir = path.posix.join(sessionDir, "stdin");
const eventsDir = path.posix.join(sessionDir, "events");
const stateFile = path.posix.join(sessionDir, "process-state.json");
let seq = 0;
let stdinClosed = false;
let childClosed = false;
let forceKillTimer = null;

const config = JSON.parse(Buffer.from(commandPayload, "base64").toString("utf8"));
await fs.mkdir(stdinDir, { recursive: true });
await fs.mkdir(eventsDir, { recursive: true });

let writeChain = Promise.resolve();

function writeEvent(event) {
  seq += 1;
  const file = path.posix.join(eventsDir, String(seq).padStart(12, "0") + ".json");
  const write = writeChain.then(async () => {
    await fs.writeFile(file + ".tmp", JSON.stringify(event) + "\\n", "utf8");
    await fs.rename(file + ".tmp", file);
  });
  writeChain = write.catch(() => undefined);
  return write;
}

const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
  cwd: config.cwd || process.cwd(),
  env: { ...process.env, ...(config.env || {}), PAPERCLIP_PROCESS_SESSION_ID: sessionId },
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});
const childPid = typeof child.pid === "number" ? child.pid : null;
const childProcessGroupId = process.platform !== "win32" ? childPid : null;
const stateWrite = fs
  .writeFile(
    stateFile + ".tmp",
    JSON.stringify({
      version: 1,
      sessionId,
      bridgePid: process.pid,
      childPid,
      childProcessGroupId,
    }) + "\\n",
    "utf8",
  )
  .then(() => fs.rename(stateFile + ".tmp", stateFile));

function signalChildTree(signal) {
  if (!childPid || childClosed) return;
  try {
    process.kill(childProcessGroupId ? -childProcessGroupId : childPid, signal);
  } catch {
    // Child/process-group exit races are expected during bounded cleanup.
  }
}

function beginShutdown() {
  stdinClosed = true;
  if (!child.stdin.destroyed) child.stdin.end();
  signalChildTree("SIGTERM");
  if (!childClosed && !forceKillTimer) {
    forceKillTimer = setTimeout(() => signalChildTree("SIGKILL"), 1000);
    forceKillTimer.unref?.();
  }
}

child.stdout.on("data", (chunk) => void writeEvent({ type: "data", stream: "stdout", data: Buffer.from(chunk).toString("base64") }));
child.stderr.on("data", (chunk) => void writeEvent({ type: "data", stream: "stderr", data: Buffer.from(chunk).toString("base64") }));
child.on("error", (error) => {
  childClosed = true;
  stdinClosed = true;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  void writeEvent({ type: "error", message: error.message });
});
// "close" (not "exit") so stdout/stderr fully drain before the exit event;
// the write chain then guarantees the exit file lands after every data file.
child.on("close", (code, signal) => {
  childClosed = true;
  stdinClosed = true;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  void writeEvent({ type: "exit", code, signal });
});
process.on("SIGTERM", beginShutdown);
process.on("SIGINT", beginShutdown);

async function pollStdin() {
  while (!stdinClosed && !childClosed) {
    const entries = (await fs.readdir(stdinDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      const file = path.posix.join(stdinDir, name);
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.type === "stdin" && typeof message.data === "string") {
        if (!childClosed && !child.stdin.destroyed) child.stdin.write(Buffer.from(message.data, "base64"));
      } else if (message.type === "stdinEnd") {
        stdinClosed = true;
        if (!child.stdin.destroyed) child.stdin.end();
        break;
      }
    }
    if (!stdinClosed && !childClosed) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

await stateWrite;
if (!childClosed) {
  void pollStdin().catch((error) => {
    stdinClosed = true;
    void writeEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
    beginShutdown();
  });
}
`;
}

export async function startAdapterExecutionTargetPaperclipBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  timeoutSec?: number | null;
  hostApiToken: string | null | undefined;
  hostApiUrl?: string | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  maxBodyBytes?: number | null;
}): Promise<AdapterExecutionTargetPaperclipBridgeHandle | null> {
  if (!adapterExecutionTargetUsesPaperclipBridge(input.target)) {
    return null;
  }
  if (!input.target || input.target.kind !== "remote") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const hostApiToken = input.hostApiToken?.trim() ?? "";
  if (hostApiToken.length === 0) {
    throw new Error("Sandbox bridge mode requires a host-side Paperclip API token.");
  }

  const runtimeRootDir =
    input.runtimeRootDir?.trim().length
      ? input.runtimeRootDir.trim()
      : path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey);
  const bridgeRuntimeDir = path.posix.join(runtimeRootDir, "paperclip-bridge");
  const queueDir = path.posix.join(bridgeRuntimeDir, "queue");
  const assetRemoteDir = path.posix.join(bridgeRuntimeDir, "server");
  const bridgeToken = createSandboxCallbackBridgeToken();
  const maxBodyBytes =
    typeof input.maxBodyBytes === "number" && Number.isFinite(input.maxBodyBytes) && input.maxBodyBytes > 0
      ? Math.trunc(input.maxBodyBytes)
      : DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const hostApiUrl =
    input.hostApiUrl?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    resolveDefaultPaperclipApiUrl();
  const shellCommand = adapterExecutionTargetShellCommand(target);
  const runner = adapterExecutionTargetCommandRunner(target);
  const bridgeTimeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : adapterExecutionTargetTimeoutMs(target);

  await onLog(
    "stdout",
    `[paperclip] Starting sandbox callback bridge for ${input.adapterKey} in ${bridgeRuntimeDir}.\n`,
  );

  const bridgeAsset = await createSandboxCallbackBridgeAsset();
  let server: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | null = null;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | null = null;
  try {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: target.remoteCwd,
      timeoutMs: bridgeTimeoutMs,
      shellCommand,
    });
    // PAPERCLIP_BRIDGE_DEBUG opts into verbose stdout logs of every bridge
    // proxy request/response. The query string is logged verbatim, so callers
    // who pass auth tokens or other sensitive values as query parameters
    // should be aware those values appear in the host process's stdout when
    // this flag is enabled. Only intended for active debugging in trusted
    // environments.
    const bridgeDebugEnabled = isBridgeDebugEnabled(process.env);
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      maxBodyBytes,
      handleRequest: async (request) => {
        const method = request.method.trim().toUpperCase() || "GET";
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value.trim().length === 0) continue;
          headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${hostApiToken}`);
        headers.set("x-paperclip-run-id", input.runId);
        const response = await fetch(buildBridgeForwardUrl(hostApiUrl, request), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
          signal: AbortSignal.timeout(30_000),
        });
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy response ${response.status} for ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        return {
          status: response.status,
          headers: buildBridgeResponseHeaders(response),
          body: await readBridgeForwardResponseBody(response, maxBodyBytes),
        };
      },
    });
    server = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: target.remoteCwd,
      assetRemoteDir,
      queueDir,
      bridgeToken,
      bridgeAsset,
      timeoutMs: bridgeTimeoutMs,
      maxBodyBytes,
      shellCommand,
    });
  } catch (error) {
    await Promise.allSettled([
      server?.stop(),
      worker?.stop(),
      bridgeAsset.cleanup(),
    ]);
    throw error;
  }

  let runLogTail: SandboxRunLogTailFactory | null = null;
  if (target.transport === "sandbox" && target.streamRunLogs !== false) {
    runLogTail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: target.remoteCwd,
      logsDir: sandboxCallbackBridgeDirectories(queueDir).logsDir,
      shellCommand,
    });
    await onLog("stdout", "[paperclip] Sandbox run log streaming enabled for this run.\n");
  }

  return {
    env: {
      PAPERCLIP_API_URL: server.baseUrl,
      PAPERCLIP_API_KEY: bridgeToken,
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
    },
    runLogTail,
    stop: async () => {
      await Promise.allSettled([
        server?.stop(),
      ]);
      await Promise.allSettled([
        worker?.stop(),
        bridgeAsset.cleanup(),
      ]);
    },
  };
}
