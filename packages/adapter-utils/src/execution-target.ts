import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { SshRemoteExecutionSpec } from "./ssh.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedDuplexChannel,
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
export {
  resolveReferencedSourceIgnore,
} from "./sandbox-managed-runtime.js";
export type {
  AdditionalSourceStagingFailure,
  ReferencedSourceIgnoreResolution,
  SandboxAdditionalSource,
} from "./sandbox-managed-runtime.js";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT,
  SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
  syncRemoteTextFileWithHashSkip,
  syncSandboxCallbackBridgeEntrypoint,
} from "./sandbox-callback-bridge.js";
import {
  createHttp2BridgeServer,
  type Http2BridgeForwardHandler,
} from "./http2-bridge-server.js";
import {
  createSandboxRunLogTailFactory,
  type SandboxRunLogTailFactory,
} from "./sandbox-run-log-stream.js";
import {
  DEFAULT_DUPLEX_BROKER_BUDGETS,
  DUPLEX_CHANNEL_LOST_ERROR_CODE,
  isSafeBridgeMethod,
  type DuplexBrokerRunDisposition,
} from "./bridge-transport-contract.js";
import { decodeDuplexLine, DEFAULT_MAX_DUPLEX_FRAME_BYTES } from "./duplex-frame-codec.js";
import {
  createDuplexObservability,
  mapHttp2EventToDuplexLossReason,
  type DuplexFallbackReason,
  type DuplexLossReason,
  type DuplexObservabilityRecorder,
  type Http2TelemetryEventName,
} from "./duplex-observability.js";
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
import {
  runWithRuntimeParent,
  type RuntimeSpanRunner,
  type StartupSpanContext,
} from "./acpx-engine/startup-timing.js";
import type { RuntimeProgressSink, RuntimeStatusSink } from "./runtime-progress.js";
import type { LocalProcessSandboxOptions } from "./local-process-sandbox.js";

export type { RuntimeProgressSink } from "./runtime-progress.js";

export function postedIssueCommentLogMarker(method: string, requestPath: string, status: number, body: string) {
  if (method !== "POST" || !/^\/api\/issues\/[^/]+\/comments$/.test(requestPath) || status < 200 || status >= 300) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0 ? `comment id: ${parsed.id}\n` : null;
  } catch {
    return null;
  }
}

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

/**
 * Read-only snapshot of the effective execution capabilities for one
 * execution target — local, ssh, sandbox, or plugin. Each flag is the
 * resolved result of the provider's declaration, the live worker's verified
 * methods, and any narrowing from the config or lease. The host computes it
 * once and attaches it to the target; a consumer reads it but never changes
 * it, so every field is `readonly`.
 */
export interface EffectiveExecutionCapabilities {
  readonly reusableLeases: boolean;
  readonly nativeSyncIn: boolean;
  readonly nativeSyncOut: boolean;
  readonly persistentProcessSessions: boolean;
  readonly independentControlCommands: boolean;
  readonly incrementalSessionOutput: boolean;
  readonly concurrentSyncOperations: boolean;
  readonly duplexCommandStream: boolean;
}

/**
 * @deprecated Renamed to `EffectiveExecutionCapabilities`. This alias will
 * be removed in a later major release.
 */
export interface EffectiveSandboxCapabilities extends EffectiveExecutionCapabilities {}

export interface AdapterSandboxExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "remote";
  transport: "sandbox";
  providerKey?: string | null;
  /**
   * Read-only effective capability snapshot for this sandbox target. The host
   * resolves it from the provider declaration ∩ the verified worker methods ∩
   * narrowing, then attaches it here. Absent when no snapshot was resolved.
   */
  readonly effectiveCapabilities?: EffectiveExecutionCapabilities | null;
  /**
   * Per-run duplex bridge kill switch. The host stamps it on the same seam as
   * `effectiveCapabilities`. `true` selects the duplex transport only when the
   * capability `duplexCommandStream` is also `true`; any other value keeps the
   * file bridge. The value stays on the host and never enters the sandbox
   * environment. Absent means no grant.
   */
  readonly enableSandboxDuplexBridge?: boolean;
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
  /**
   * The injected duplex observability recorder for this run. The host attaches
   * it on the same seam as `runner`, so this live object stays on the host and
   * never enters the sandbox environment. The bridge binds it to the fixed
   * duplex observability surface. Absent means the safe no-op default.
   */
  duplexObservabilityRecorder?: DuplexObservabilityRecorder | null;
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
  /**
   * Sandbox-only: the atomic run-disposition settle from the Paperclip bridge
   * handle. When provided, `runAdapterExecutionTargetProcess` calls it once at
   * the clean-completion boundary of the process, synchronously and before the
   * run-log tail finishes. The call reads the disposition and marks the
   * host-observed orderly completion in one broker step, so a gateway exit
   * after the clean process completion cannot latch a false mid-run loss. A
   * control channel that died before the clean completion still fails the run
   * closed with the typed `duplex_channel_lost` code. The file bridge path
   * never sets it.
   */
  settleRunDisposition?: (() => DuplexBrokerRunDisposition) | null;
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
  /**
   * Read the terminal run disposition of the duplex control channel. It reports a
   * failure when the channel was lost before an orderly completion, and names the
   * typed loss reason. It reports a success for a healthy channel or a
   * normal-teardown loss. The file bridge path never sets it, so the method is
   * absent there. The caller reads it at the run-disposition seam to fail a run
   * whose control channel died mid-turn.
   */
  readRunDisposition?(): DuplexBrokerRunDisposition;
  /**
   * Atomically read the run disposition and mark the host-observed orderly
   * completion in one broker step. The ACP lane calls it at the terminal
   * finalization boundary for a success-eligible completion, so no `await` can
   * separate the read from the mark and a teardown loss cannot slip in between.
   * A loss that already latched keeps the failure, because the broker no-ops the
   * mark after a latched loss. The file bridge path never sets it.
   */
  settleRunDisposition?(): DuplexBrokerRunDisposition;
  /**
   * Mark the host-observed orderly completion of the agent turn on the broker's
   * ordered lifecycle. The caller marks it at the ACP terminal-finalization
   * boundary for a still-success-eligible completion, so a later teardown loss
   * cannot flip the run to a failure. A loss that already latched keeps the
   * failure, because the broker no-ops the mark after a latched loss. The file
   * bridge path never sets it, so the method is absent there.
   */
  markOrderlyCompletion?(): void;
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

// Read a serialized effective-capability snapshot back into a full record. A
// missing or non-boolean field reads as `false`, so a round-tripped target
// never grants a capability that the snapshot did not carry. Returns null when
// there is no object to read.
function parseEffectiveExecutionCapabilities(value: unknown): EffectiveExecutionCapabilities | null {
  const parsed = parseObject(value);
  if (Object.keys(parsed).length === 0) return null;
  return {
    reusableLeases: parsed.reusableLeases === true,
    nativeSyncIn: parsed.nativeSyncIn === true,
    nativeSyncOut: parsed.nativeSyncOut === true,
    persistentProcessSessions: parsed.persistentProcessSessions === true,
    independentControlCommands: parsed.independentControlCommands === true,
    incrementalSessionOutput: parsed.incrementalSessionOutput === true,
    concurrentSyncOperations: parsed.concurrentSyncOperations === true,
    duplexCommandStream: parsed.duplexCommandStream === true,
  };
}

function readStringMeta(parsed: Record<string, unknown>, key: string): string | null {
  return readString(parsed[key]);
}

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  // Preserve the wildcard bind's address family: a server bound to 0.0.0.0
  // accepts IPv4, so target the IPv4 loopback (and [::1] for ::) instead of
  // "localhost", which the resolver may map to the other family.
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (!host) return "localhost";
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

/**
 * Read the per-run duplex bridge kill switch off a target. Only a sandbox
 * target with `enableSandboxDuplexBridge` set to `true` returns `true`. Every
 * other target and every other value returns `false`, so the caller fails
 * closed to the file bridge.
 */
export function adapterExecutionTargetEnablesSandboxDuplexBridge(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return (
    target?.kind === "remote" &&
    target.transport === "sandbox" &&
    target.enableSandboxDuplexBridge === true
  );
}

/**
 * Read the injected duplex observability recorder off a target. Only a
 * sandbox target with a recorder attached returns it. Every other target
 * returns null, so the bridge falls back to the safe no-op recorder.
 */
export function adapterExecutionTargetDuplexObservabilityRecorder(
  target: AdapterExecutionTarget | null | undefined,
): DuplexObservabilityRecorder | null {
  return target?.kind === "remote" && target.transport === "sandbox"
    ? target.duplexObservabilityRecorder ?? null
    : null;
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

// Apply the run-disposition seam to one clean process result. Only a clean
// completion is success-eligible: a timed-out, signalled, or non-zero-exit
// result is already a failure, so the seam leaves it unchanged. This is the same
// success-eligibility rule the ACP lane applies. For a success-eligible result
// the seam settles the disposition in one atomic broker step: it reads the
// disposition and marks the host-observed orderly completion together, so a
// gateway exit after the clean completion cannot latch a false mid-run loss. A
// duplex control channel that died before the clean completion fails the run
// closed: the seam sets a non-zero exit code, the typed `duplex_channel_lost`
// error code, and a stderr note that names only the typed loss reason.
function applyRunDispositionSeam(
  result: RunProcessResult,
  settleRunDisposition: (() => DuplexBrokerRunDisposition) | null | undefined,
): RunProcessResult {
  const successEligible = result.exitCode === 0 && !result.timedOut && result.signal === null;
  if (!successEligible || !settleRunDisposition) return result;
  const disposition = settleRunDisposition();
  if (!disposition.failed) return result;
  const lossReason = disposition.lossReason ?? "other";
  const note = `[paperclip] The sandbox duplex control channel was lost (${lossReason}) before the run completed.\n`;
  const separator = result.stderr.length > 0 && !result.stderr.endsWith("\n") ? "\n" : "";
  return {
    ...result,
    exitCode: 1,
    errorCode: DUPLEX_CHANNEL_LOST_ERROR_CODE,
    stderr: `${result.stderr}${separator}${note}`,
  };
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
      message: "Starting adapter in environment",
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
      // Settle the duplex run disposition synchronously at the clean-completion
      // boundary, before the run-log tail finishes. The atomic settle marks the
      // host-observed orderly completion in one broker step, so a gateway exit
      // after the clean process completion cannot latch a false mid-run loss. A
      // control channel that died before this clean completion still fails the
      // run closed.
      const settled = applyRunDispositionSeam(result, options.settleRunDisposition);
      if (runLogTail) {
        await runLogTail.finish({ stdout: result.stdout, stderr: result.stderr });
      }
      return settled;
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
    const effectiveCapabilities = parseEffectiveExecutionCapabilities(parsed.effectiveCapabilities);
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: readStringMeta(parsed, "providerKey"),
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd,
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : null,
      streamRunLogs: typeof parsed.streamRunLogs === "boolean" ? parsed.streamRunLogs : null,
      // Fail closed: only the literal `true` reads as a grant. An absent field
      // or any other value parses as no grant, so a round-trip never invents one.
      enableSandboxDuplexBridge: parsed.enableSandboxDuplexBridge === true,
      ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
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
  // Optional host span runner for the workspace tarball build. Only the confined
  // sandbox lane uses it: it forwards the runner to prepareCommandManagedRuntime
  // so the host pack time rides one `pack` span under the `stage.sync` step. The
  // SSH and local lanes ignore it. The default is a no-op.
  runtimeSpan?: RuntimeSpanRunner;
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
    runtimeSpan: input.runtimeSpan,
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
  // Keep `x-paperclip-bridge-outcome` in this list. The host marks a
  // possibly-committed mutation with the `indeterminate` outcome. The in-sandbox
  // server reads that header to map the 504 to a terminal 409. If the forward
  // drops the header, the server keeps the retryable 504 and a caller that
  // retries 5xx can repeat a mutation that already committed.
  for (const key of ["content-type", "etag", "last-modified", "x-paperclip-bridge-outcome"]) {
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

/**
 * Read the forward response body into a string. The per-request `maxBodyBytes`
 * limit rejects a body larger than the configured per-request ceiling.
 *
 * This function reserves no process-wide byte budget: it enforces only the
 * one request's own ceiling. See the "Known behavior: aggregate retained
 * body bytes" section in `doc/observability.md` for the accepted aggregate
 * ceiling this leaves across every concurrent route.
 */
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
    const chunkBytes = value.byteLength;
    totalBytes += chunkBytes;
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
// The streamed variant writes its output frames to stdout, so it rides a
// separate remote path. A sandbox can hold both scripts without the content
// hash-skip gate thrashing when a run switches output mode.
const PROCESS_SESSION_REMOTE_STREAM_SCRIPT = "paperclip-process-session-remote-stream.mjs";
const PROCESS_SESSION_AUTH_TIMEOUT_MS = 5_000;
// The bounded budget `stop()` waits for the wrapper's `shutdownAck` event
// before it removes `sessionDir` unconditionally. The wrapper writes the
// acknowledgement right after it arms its own kill timer, well before its
// child actually exits, so this budget only needs to cover message delivery,
// not the child's full shutdown.
const DEFAULT_PROCESS_SESSION_SHUTDOWN_WAIT_MS = 3_000;

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
  outputToStdout?: boolean;
}): Promise<{ uploaded: boolean }> {
  const { uploaded } = await syncRemoteTextFileWithHashSkip({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    remoteDir: input.remoteScriptDir,
    remotePath: input.remoteScriptPath,
    body: getProcessSessionRemoteSource({ outputToStdout: input.outputToStdout === true }),
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

/** Span name that wraps the socket handler's one `writeTextFile` exec — one
 * outbound ACP message to the agent. */
const AGENT_SESSION_SEND_INPUT_SPAN = "sandbox.agentSession.sendInput";

/** Span name that wraps one 100 ms poll tick — `list`, then `read`+`remove` per
 * file found (`1 + 2n` execs). */
const AGENT_SESSION_POLL_OUTPUT_SPAN = "sandbox.agentSession.pollOutput";

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
  // Return the current-run parent-context token. The socket handlers and the
  // poll timer read it per unit of work and run under it, so their run-time
  // `sandbox.exec` spans parent to the live run span (`agent.turn` during the
  // turn, `task.run` otherwise). When it is absent, the work runs with an empty
  // store, exactly like the earlier `runWithoutActiveStep` behavior.
  getRuntimeParentContext?: () => StartupSpanContext | undefined;
  // Wrap each unit of run-time work in its own named span. The socket handler
  // uses it for `sandbox.agentSession.sendInput` and the poll timer for
  // `sandbox.agentSession.pollOutput`, so each unit's inner `sandbox.exec` spans
  // group under one wrapper span. When it is absent, the work runs under the run
  // parent with no wrapper span, exactly like the earlier behavior.
  runtimeSpan?: RuntimeSpanRunner;
  // Stream the agent output through the persistent session log stream instead of
  // the host output-file poll. When true, the bridge runs the wrapper as one
  // long-lived session command and reads its stdout frames from the stream, and
  // it does not start the 100 ms poll. Default OFF: the bridge keeps the poll.
  streamOutputViaSession?: boolean;
}): Promise<AdapterExecutionTargetProcessSessionBridgeHandle | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const runner = requireSandboxRunner(target);
  // Run one unit of run-time work under its named wrapper span when a span
  // runner is injected. Without a runner, run the work under the current run
  // parent, so the inner `sandbox.exec` spans parent to the live run span,
  // exactly like the earlier behavior.
  const runRuntimeWork = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    input.runtimeSpan
      ? input.runtimeSpan(name, work)
      : runWithRuntimeParent(input.getRuntimeParentContext?.(), work);
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
  // The streamed wrapper writes its frames to stdout and rides a separate remote
  // path, so a warm sandbox can hold both wrapper scripts without the content
  // hash-skip gate thrashing when a run switches output mode.
  const streamOutput = input.streamOutputViaSession === true;
  const remoteScriptPath = path.posix.join(
    bridgeRuntimeDir,
    streamOutput ? PROCESS_SESSION_REMOTE_STREAM_SCRIPT : PROCESS_SESSION_REMOTE_SCRIPT,
  );
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({
    runner,
    remoteCwd: target.remoteCwd,
    timeoutMs,
    shellCommand,
  });

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
    outputToStdout: streamOutput,
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

  // Legacy poll path: background the wrapper with `nohup` and read its output
  // event files with the host poll below. The streamed path launches the wrapper
  // as one foreground session command further down instead, so skip this.
  if (!streamOutput) {
    await onLog("stdout", `[paperclip] Starting ACP process session bridge in sandbox (${target.providerKey ?? "provider"}).\n`);
    const startResult = await runner.execute({
      command: shellCommand,
      args: shellCommandArgs(
        [
          `mkdir -p ${shellQuote(stdinDir)} ${shellQuote(eventsDir)}`,
          // I3: no numeric process identifier anywhere. Background the
          // wrapper and let it go; do not capture `$!`.
          `PAPERCLIP_PROCESS_SESSION_DIR=${shellQuote(sessionDir)} ` +
            `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=${shellQuote(commandPayload)} ` +
            `nohup node ${shellQuote(remoteScriptPath)} >/dev/null 2>&1 < /dev/null &`,
        ].join("\n"),
      ),
      cwd: target.remoteCwd,
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
      timeoutMs,
      // The wrapper launch is bridge plumbing. Keep it off the persistent
      // session so it never queues behind an in-run session command.
      bypassSession: true,
    });
    if (startResult.timedOut || (startResult.exitCode ?? 1) !== 0) {
      throw new Error(`Failed to start sandbox ACP process session bridge: ${startResult.stderr || startResult.stdout}`);
    }
  }

  let socket: net.Socket | null = null;
  let stopping = false;
  // Resolves when `stop()` tears the bridge down. The streamed `sandbox.agentProcess`
  // span races its work against this, so the span ends at teardown at the latest
  // even when the remote process lingers, and never outlives the run root span.
  let signalStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    signalStopped = resolve;
  });
  let stdinSeq = 0;
  // One promise chain per session that serializes the stdin file writes. Each
  // write is multi-exec on the command-managed client: prepare, append per 32
  // KiB, then an atomic rename. The chain makes the rename for file N finish
  // before the write for file N+1 starts, so the files land in send order.
  // Without it the writes overlap. A small later chunk can then rename ahead of
  // a big earlier chunk, so the wrapper reads the stdin bytes out of order and
  // corrupts a large prompt on the stdin path.
  let stdinWriteChain: Promise<void> = Promise.resolve();
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
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-proxy-"));
  // `stop()` waits on this promise, bounded, for the wrapper's `shutdownAck`
  // event. `deliverRemoteEvent` resolves it below and never forwards the
  // event further: it is a host-internal control ack, not part of the ACP
  // output stream. An event under `sessionDir` is untrusted telemetry: an
  // `exit` or `error` event is never treated as proof of shutdown, because
  // any process running under the sandbox can write one. Only `shutdownAck`
  // counts, and `stop()` also gives itself a dedicated reader for it below,
  // so a late `shutdownAck` still lands even after the long-lived poll has
  // stopped re-arming.
  let signalShutdownAcknowledged: () => void = () => {};
  const shutdownAcknowledged = new Promise<void>((resolve) => {
    signalShutdownAcknowledged = resolve;
  });

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
    if (event.type === "shutdownAck") {
      signalShutdownAcknowledged();
      return;
    }
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
  // Register the per-connection socket handlers with no run parent context.
  // A stdin write from a socket handler is a run-time exec, not startup work.
  // The connection can open under `task.run` and receive stdin later, during an
  // `agent.turn`. So the handler must read the current-run parent at send time,
  // not at connect time. A connect-time read captures the parent that was live
  // when the socket opened, and every later exec span parents to that stale
  // parent. The `data` handler below reads the getter per message instead.
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
        // Wrap one outbound ACP message to the agent in a
        // `sandbox.agentSession.sendInput` span, so its one `writeTextFile` exec
        // groups under one named span. The span runner reads the current-run
        // parent at send time: the live parent switches to `agent.turn` during
        // the turn and back to `task.run` after it. A message that is neither
        // `stdin` nor `stdinEnd` writes nothing, so it opens no span.
        const stdinPayload =
          message.type === "stdin" && typeof message.data === "string"
            ? { type: "stdin", data: message.data }
            : message.type === "stdinEnd"
              ? { type: "stdinEnd" }
              : null;
        if (stdinPayload) {
          stdinSeq += 1;
          const name = `${String(stdinSeq).padStart(12, "0")}.json`;
          const filePath = path.posix.join(stdinDir, name);
          // Chain this write after the previous one, so the atomic rename for
          // file N finishes before the write for file N+1 starts. Keep the
          // per-message `sandbox.agentSession.sendInput` span inside the chain.
          const write = stdinWriteChain.then(() =>
            runRuntimeWork(AGENT_SESSION_SEND_INPUT_SPAN, () =>
              client.writeTextFile(filePath, jsonLine(stdinPayload)),
            ),
          );
          // The next message chains after this write on success or failure, so a
          // failed write never blocks the chain. This mirrors the wrapper
          // `writeChain` pattern for its event files.
          stdinWriteChain = write.then(() => undefined, () => undefined);
          // Keep the failure behavior: send one error line, then destroy the socket.
          write.catch((error) => {
            nextSocket.write(jsonLine({ type: "error", message: error instanceof Error ? error.message : String(error) }));
            nextSocket.destroy();
          });
        }
      }
    });
  });

  const poll = async () => {
    if (stopping) return;
    try {
      // Read every file this tick fetched before this loop decides whether to
      // keep polling. A `shutdownAck` can land in the same batch right after
      // an `exit` event; deliver it too, so this tick never drops an
      // already-fetched (and already-removed-from-disk) event.
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await onLog("stderr", `[paperclip] ACP process session bridge poll failed: ${message}\n`);
      deliverRemoteEvent({ type: "error", message });
      return;
    } finally {
      if (!stopping) {
        schedulePoll();
      }
    }
  };

  // Schedule the long-lived poll timer. Wrap each 100 ms poll tick in a
  // `sandbox.agentSession.pollOutput` span, so the tick's `list` plus per-file
  // `read`/`remove` execs group under one named span. The poll loop reads remote
  // event files with run-time execs, not startup work, so the wrapper span and
  // its child execs parent to the live run span, not to the ended bridge step.
  // The span runner reads the run parent per tick, because the re-arm timer that
  // the poll body schedules opens a new tick span: the live parent switches to
  // `agent.turn` during the turn and back to `task.run` after it.
  const schedulePoll = () => {
    pollTimer = setTimeout(() => void runRuntimeWork(AGENT_SESSION_POLL_OUTPUT_SPAN, poll), 100);
    pollTimer.unref?.();
  };

  const port = await waitForLocalServerListen(server);
  const agentCommand = await writeProcessSessionProxyScript(proxyDir, port, token);

  if (streamOutput) {
    // Streamed output path. Run the wrapper as one long-lived session command;
    // its stdout carries newline-delimited JSON frames that reach the host
    // through the provider session log stream. Deliver each frame exactly once
    // by its monotonic `seq`, so a frame that arrives both live and in the final
    // result is not repeated. There is no host output-file poll here.
    let streamBuffer = "";
    let lastSeq = 0;
    let sawTerminal = false;
    const deliverFrame = (frame: (typeof pendingRemoteEvents)[number] & { seq?: number }) => {
      if (typeof frame.seq === "number") {
        if (frame.seq <= lastSeq) return;
        lastSeq = frame.seq;
      }
      if (frame.type === "exit" || frame.type === "error") sawTerminal = true;
      deliverRemoteEvent(frame);
    };
    const parseFrameLine = (line: string) => {
      if (!line.trim()) return;
      let frame: (typeof pendingRemoteEvents)[number] & { seq?: number };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        return;
      }
      deliverFrame(frame);
    };
    // Live delivery: buffer partial lines across stream chunks, deliver each
    // complete frame line as it arrives.
    const ingestStreamChunk = (text: string) => {
      streamBuffer += text;
      const split = splitJsonLines(streamBuffer);
      streamBuffer = split.rest;
      for (const line of split.lines) parseFrameLine(line);
    };
    // Terminal delivery (the defined fallback to the poll): the resolved result
    // carries the full wrapper stdout even when the live stream degraded to the
    // provider session-log poll. The text is complete and self-contained, so
    // re-parse it on its own; the `seq` guard drops every frame the live stream
    // already delivered. Drop any partial live line — its complete form is in the
    // full text.
    const ingestFinalText = (text: string) => {
      streamBuffer = "";
      for (const line of text.split(/\n/)) parseFrameLine(line);
    };

    const launchEnvForStream =
      typeof input.env === "function" ? await input.env() : input.env;
    const streamCommandPayload = Buffer.from(JSON.stringify({
      command: input.command,
      args: input.args,
      cwd: input.cwd || target.remoteCwd,
      env: sanitizeRemoteExecutionEnv(launchEnvForStream),
    }), "utf8").toString("base64");
    await onLog(
      "stdout",
      `[paperclip] Starting streamed ACP process session bridge in sandbox (${target.providerKey ?? "provider"}).\n`,
    );
    // Fire the long-lived command; do NOT await it here. `useSession` forces the
    // persistent session so the provider streams the wrapper stdout back through
    // `onLog`. On resolve, the terminal re-parse fills any frames the live stream
    // missed; on reject, deliver one error frame so the local proxy fails loud.
    //
    // Wrap the launch in a `sandbox.agentProcess` span. `runRuntimeWork` parents
    // it to the LIVE RUN root (`task.run` at launch time — no turn has started
    // yet), not to the ephemeral `bridge.process-session` bring-up step, and it
    // stays open for the whole process lifetime. The inner `sandbox.exec` nests
    // under it. Without the wrapper the raw exec's span inherits the ~2.28s
    // bring-up step as its parent and then dangles ~50s past it, overlapping
    // `agent.turn` — a child outliving its parent. As a run-scoped span it reads
    // instead as a resource that OVERLAPS the sibling `agent.turn`, which is the
    // correct shape (the persistent process hosts the turn; it is not a child of
    // it, and on multi-turn runs one process spans several turns). `runRuntimeWork`
    // is voided, not awaited, so bring-up never blocks on the long-lived command,
    // and it defaults to a no-op parent when no span runner is injected.
    //
    // The span is bounded to the bridge lifecycle: it ends when the command
    // settles OR when `stop()` runs, whichever comes first. `stop()` runs during
    // run teardown, before the caller ends the `task.run` root span, so the span
    // never outlives the run root even if the remote process lingers past
    // teardown (`execute` has no cancel, so a lingering process cannot be forced
    // to resolve). The command promise keeps running after the span ends so its
    // frame handlers still deliver; they no-op once `stopping` is set.
    void runRuntimeWork("sandbox.agentProcess", async () => {
      const commandSettled = (async () => {
        try {
          const result = await runner.execute({
            command: shellCommand,
            args: shellCommandArgs(`node ${shellQuote(remoteScriptPath)}`),
            cwd: target.remoteCwd,
            env: {
              PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
              PAPERCLIP_PROCESS_SESSION_COMMAND_B64: streamCommandPayload,
              PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
            },
            timeoutMs,
            useSession: true,
            onLog: async (stream, chunk) => {
              if (stream === "stdout") ingestStreamChunk(chunk);
            },
          });
          ingestFinalText(result.stdout);
          if (!sawTerminal && !stopping) {
            deliverRemoteEvent({
              type: "exit",
              code: typeof result.exitCode === "number" ? result.exitCode : null,
            });
          }
        } catch (error) {
          if (!stopping) {
            deliverRemoteEvent({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();
      await Promise.race([commandSettled, stopped]);
    });
  } else {
    schedulePoll();
  }

  // `stop()` cannot rely on the long-lived poll above to observe a late
  // `shutdownAck`: that poll stops re-arming as soon as it forwards a
  // terminal `exit`/`error` event, and `stop()` itself sets `stopping` on
  // its own first line. A normal completion's `shutdownAck` file, written a
  // moment after `exit`, can then land on disk after nobody reads the events
  // directory any more. Give `stop()` its own bounded reader that looks only
  // for `shutdownAck` and ignores every other event type, so the wait below
  // shortens on the wrapper's own proof of shutdown -- never on an `exit` or
  // `error` event, which any process running under `sessionDir` can forge.
  let stopReadingForShutdownAck = false;
  const readShutdownAckUntil = (deadlineEpochMs: number) => {
    if (stopReadingForShutdownAck) return;
    void (async () => {
      try {
        const events = await readRemoteJsonFiles({ client, dir: eventsDir });
        if (stopReadingForShutdownAck) return;
        for (const event of events) {
          try {
            const parsed = JSON.parse(event.body) as { type?: string };
            if (parsed.type === "shutdownAck") {
              signalShutdownAcknowledged();
              return;
            }
          } catch {
            // Not readable JSON yet. It is not a `shutdownAck`; ignore it.
          }
        }
      } catch {
        // Best-effort: a read failure here is not proof of anything.
      }
      if (!stopReadingForShutdownAck && Date.now() < deadlineEpochMs) {
        const timer = setTimeout(() => readShutdownAckUntil(deadlineEpochMs), 100);
        timer.unref?.();
      }
    })();
  };

  return {
    agentCommand,
    stop: async () => {
      stopping = true;
      // End the `sandbox.agentProcess` span now, before the caller ends the run
      // root span, even if the remote command has not resolved yet.
      signalStopped();
      if (pollTimer) clearTimeout(pollTimer);
      for (const liveSocket of liveSockets) liveSocket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      // Wait for every accepted stdin write before `stdinEnd`. The socket handler
      // fires each chunk write un-awaited through `stdinWriteChain`, so an earlier
      // chunk can still be pending here. Chain the `stdinEnd` write onto the same
      // per-session chain, so its file rename never finishes before an earlier
      // chunk. `stdinSeq` is stable now, because the sockets are destroyed and the
      // server is closed, so no new message can increment it.
      const stdinEndPath = path.posix.join(
        stdinDir,
        `${String(stdinSeq + 1).padStart(12, "0")}.json`,
      );
      const stdinEndWrite = stdinWriteChain.then(() =>
        client.writeTextFile(stdinEndPath, jsonLine({ type: "stdinEnd" })),
      );
      stdinWriteChain = stdinEndWrite.then(() => undefined, () => undefined);
      await stdinEndWrite.catch(() => undefined);
      // The `shutdown` control message tells the wrapper to terminate itself
      // and its own child (I3: no operating-system signal and no process
      // identifier cross this boundary — only a file-queue message does).
      // Chain it onto the same per-session write order as `stdinEnd`, so its
      // file never lands before the earlier one.
      const shutdownPath = path.posix.join(
        stdinDir,
        `${String(stdinSeq + 2).padStart(12, "0")}.json`,
      );
      const shutdownWrite = stdinWriteChain.then(() =>
        client.writeTextFile(shutdownPath, jsonLine({ type: "shutdown" })),
      );
      stdinWriteChain = shutdownWrite.then(() => undefined, () => undefined);
      await shutdownWrite.catch(() => undefined);
      // Wait a bounded budget for a hint that the wrapper stopped: only the
      // `shutdownAck` event counts; an `exit` or `error` event is untrusted
      // telemetry from inside the sandbox and never shortens this wait or
      // suppresses the warning below. `shutdownAck` itself is ALSO an
      // untrusted hint, not proof: any process that shares the sandbox can
      // write the same event under this session's event directory. It can
      // only shorten this wait and suppress the warning below; it never
      // gates, shortens, or replaces the unconditional removal further down.
      // What actually makes the wrapper's own termination deterministic is
      // the wrapper-side session-identity latch, not this event.
      let acknowledgedInTime = false;
      readShutdownAckUntil(Date.now() + DEFAULT_PROCESS_SESSION_SHUTDOWN_WAIT_MS);
      await Promise.race([
        shutdownAcknowledged.then(() => {
          acknowledgedInTime = true;
        }),
        new Promise<void>((resolve) => {
          const budgetTimer = setTimeout(resolve, DEFAULT_PROCESS_SESSION_SHUTDOWN_WAIT_MS);
          budgetTimer.unref?.();
        }),
      ]);
      stopReadingForShutdownAck = true;
      if (!acknowledgedInTime) {
        await onLog(
          "stderr",
          `[paperclip] ACP process session wrapper did not acknowledge shutdown within ${DEFAULT_PROCESS_SESSION_SHUTDOWN_WAIT_MS}ms; removing the session directory anyway.\n`,
        ).catch(() => undefined);
      }
      // Unconditional: this removal runs whether or not the wrapper
      // acknowledged, and whether or not any event (real or forged) arrived
      // under `sessionDir`. `stop()` runs during run teardown and must stay
      // non-fatal, so every step above is best-effort and this step never
      // throws.
      await client.remove(sessionDir).catch(() => undefined);
      await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => undefined);
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

export function getProcessSessionRemoteSource(input?: { outputToStdout?: boolean }): string {
  return input?.outputToStdout === true
    ? getProcessSessionRemoteStreamSource()
    : getProcessSessionRemoteEventFileSource();
}

// The shared stdin drain. Both wrappers read newline-delimited stdin messages
// from the stdin file queue and write them to the child, then end the child
// stdin on `stdinEnd`. A write to a closed child stdin only emits an `error`
// event, so the wrapper installs a no-op handler at the call site.
const PROCESS_SESSION_STDIN_POLL_TAIL = `child.stdin.on("error", () => {});

// A stdin file can appear before the host finishes the write. An empty read is
// the non-atomic-write window; a partial read makes JSON.parse throw. The
// poller must not delete a file before it validates the content. So read and
// parse each file first, and delete it only after a successful parse. The files
// sort in send order. If an earlier file is not readable yet, stop the cycle and
// keep the order: a later file (for example stdinEnd) must not run ahead of it.
// Retry the earlier file on a later cycle. After the retry limit, drop the file
// and write an error event, so a lost message fails loud, and let later files
// run.
const stdinMaxParseRetries = (() => {
  const raw = Number.parseInt(process.env.PAPERCLIP_PROCESS_SESSION_STDIN_MAX_RETRIES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();
const stdinParseRetries = new Map();
// Track the next expected sequence number. The host writes the stdin files in
// send order and pads the number to 12 digits, starting at 1. The files sort in
// send order. When the smallest present number is greater than expected, an
// earlier file has not appeared yet: a missing file, not an unreadable one. Hold
// the send order and wait for it, bounded by the same retry budget as the
// unreadable-file path. This turns a reordering into a loud error, never silent
// corruption.
let stdinExpectedSeq = 1;
let stdinGapRetries = 0;

// The bounded grace period between the SIGTERM and the SIGKILL a terminate()
// call sends. A test can override it through the environment, so a stubborn
// child does not force a slow test.
const terminateGraceMs = (() => {
  const raw = Number.parseInt(process.env.PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
})();

// I2: terminate() is the only function in this wrapper that calls
// child.kill(). No child event handler and no sibling callback calls it.
// terminate() is idempotent: a second call, or a first call after the child
// already exited on its own, does nothing beyond what already ran.
async function terminate() {
  if (terminated) return;
  terminated = true;
  shuttingDown = true;
  stdinClosed = true;
  child.stdin.end();
  // A \`false\` return means the child's process handle is already gone (the
  // child exited before this call ran). ChildProcess#kill() is handle-scoped:
  // once Node clears the handle at reap, the method call above sends no
  // signal and never falls back to a stored process identifier (I3). Treat
  // \`false\` as a no-op and do not retry through a numeric identifier.
  const sentTerm = child.kill("SIGTERM");
  if (sentTerm) {
    killTimer = setTimeout(() => {
      // Escalate on the same handle only (I2): the grace period expired, so
      // send SIGKILL through the same child handle, never a numeric
      // identifier and never a process-group signal.
      child.kill("SIGKILL");
    }, terminateGraceMs);
    killTimer.unref?.();
  }
  // This event is an untrusted latency hint, not proof. Any process that can
  // reach this session's event directory can write the same event type. It
  // can only shorten the host's shutdown wait and suppress the host's
  // timeout warning; it is never evidence that this wrapper's lifecycle
  // completed, and the host's cleanup never depends on it. The identity
  // latch below is what makes this wrapper's own termination deterministic.
  await writeEvent({ type: "shutdownAck" });
}

// A sandbox peer can delete sessionDir and stdinDir, then recreate a
// directory at the same pathname. A pathname does not prove identity: any
// process that shares the sandbox can write it. So this wrapper captures the
// OS-level identity of both paths once at startup, before the first poll
// cycle, and checks it on every later cycle.
//
// The identity is the device number, the inode number, AND the inode's own
// creation time. The device/inode pair alone is not enough: a filesystem can
// reissue the exact inode number a just-removed directory held to the very
// next directory created at the same path, with no attacker action needed
// beyond the recreate the finding already describes. The creation time does
// not have this gap: it is set fresh on every inode allocation, even when the
// allocator reissues an old inode number, so a recreated directory always
// carries a different creation time. The creation time alone is not enough
// either, on a filesystem or kernel too old to report it, so this wrapper
// keeps the device/inode pair as a second signal rather than relying on
// either alone. Ordinary use of stdinDir (the host writing and this wrapper
// deleting individual stdin files) changes that directory's OWN change time,
// but never its creation time, so the creation time is safe to latch on
// without producing a false positive on every stdin message.
//
// A filesystem or kernel that cannot report a real creation time does not
// always report a value of zero. Node fails in one of two ways, and both are
// grounded, not assumed: on Linux, when the statx() call finds no creation
// time support, the kernel leaves the field unset and Node reports 0. On a
// platform whose stat() call has no creation-time field at all, Node copies
// the change time into the creation time instead. A 0 value fails open (any
// recreated directory then matches on birthtimeMs alone), and a change-time
// copy fails closed but far too often (it would move on every stdin file
// this wrapper deletes). captureSessionIdentity() below proves the value is
// usable before it trusts it, and fails closed on both known fallbacks.
let sessionDirIdentity = null;
let stdinDirIdentity = null;
// The latch. Once set, it never clears. This replaces a counter that a
// successful read reset to zero: an attacker who recreated the directory
// before the counter reached its threshold kept the wrapper polling forever.
// A latch has no threshold to race and no reset path.
let identityLost = false;

async function statPathIdentity(candidatePath) {
  const stats = await fs.lstat(candidatePath);
  if (stats.isSymbolicLink()) {
    const error = new Error("Refusing a symbolic link on a process session control path.");
    error.code = "EPAPERCLIP_SYMLINK";
    throw error;
  }
  if (!stats.isDirectory()) {
    const error = new Error("A process session control path is not a directory.");
    error.code = "ENOTDIR";
    throw error;
  }
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function latchAndTerminate() {
  if (identityLost) return;
  identityLost = true;
  await terminate();
}

let probeSeq = 0;

// A probe file name that pollStdin() can never read as a stdin message: it
// does not end in ".json", so the ".json" filter in pollStdin() skips it if
// a poll cycle ever lists the directory during the probe's short window.
function nextProbeFileName() {
  probeSeq += 1;
  return ".paperclip-birthtime-probe-" + process.pid + "-" + probeSeq;
}

// Proves a directory's reported birthtimeMs is a real creation time, not a
// change-time copy. Creating and removing a file inside a directory changes
// that directory's OWN change time but never its true creation time, so a
// birthtimeMs that moves across the probe is a change-time copy. Returns
// null when the value is proven real. Returns a stderr-ready reason string
// on any failure (a detected copy, or a probe that cannot run at all, for
// example a permission error or a pre-created probe path): either way the
// caller must not trust the value.
//
// The open uses the "wx" flag: exclusive create, fail if the path exists.
// A sandbox peer cannot pre-create the probe path as a symbolic link and
// have this call follow it, because "wx" fails closed on an existing path
// instead of following a link to it.
//
// Cleanup checks identity, not only ownership of the initial create. This
// wrapper reads the probe file's identity, (dev, ino, ctimeMs), off the open
// file descriptor itself (fstat), not off the path, so a peer that swaps the
// path in the short gap after create cannot poison the identity this
// wrapper trusts as its own. Right before removal, this wrapper reads the
// path's identity again and removes it only when that identity still
// matches. A same-sandbox peer that deletes the probe file and creates its
// own entry at the same path in between leaves a different identity behind,
// so this wrapper leaves that entry untouched instead of removing it. This
// covers a peer's replacement file, a peer's replacement directory, and a
// peer's replacement symbolic link alike, because all three change the
// identity this wrapper reads back. The identity check includes ctimeMs,
// not only (dev, ino): a filesystem can hand this call's freed inode number
// straight back out to a peer's very next create at the same path, so
// (dev, ino) alone can match a path this call no longer owns; ctimeMs resets
// on every create, so a peer's replacement carries a different one even when
// the inode number repeats. Node's filesystem API has no call that removes a
// path only when its identity still matches an earlier read as one atomic
// step, so a gap remains between this wrapper's final identity read and the
// removal call itself. A peer that wins this gap can put any entry at the
// probe path before the removal call runs. This can include a pre-existing
// file the peer renames into place, not only a file the peer creates fresh.
// The removal call then removes whatever entry sits at the probe path at
// that moment. Two bounds still hold on that removal. The path always
// stays under dirPath. If the entry is a symbolic link, the removal call
// removes the link itself instead of following it to a different target.
// A non-recursive removal call also fails if the entry is a directory.
async function birthtimeSurvivesProbe(dirPath) {
  let before;
  try {
    before = (await fs.lstat(dirPath)).birthtimeMs;
  } catch {
    return "its reported creation time could not be read";
  }
  const probePath = path.posix.join(dirPath, nextProbeFileName());
  let handle;
  try {
    handle = await fs.open(probePath, "wx");
  } catch {
    return "its probe file could not be created exclusively (the path may already exist)";
  }
  // fstat on the open handle names the exact inode this call just created.
  // A path-based lstat here instead would be racy against a peer that swaps
  // the path in the gap between the create above and the stat: fstat has no
  // such gap, because a file descriptor keeps naming the inode it opened no
  // matter what a later swap does to the path.
  let ownedIdentity = null;
  try {
    const createdStats = await handle.stat();
    // ctimeMs guards against inode reuse; see the function comment above.
    ownedIdentity = { dev: createdStats.dev, ino: createdStats.ino, ctimeMs: createdStats.ctimeMs };
  } catch {
    ownedIdentity = null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!ownedIdentity) {
    // fstat on this call's own just-opened descriptor failed. This call then
    // has no verified identity for the probe file it created, so it must not
    // check or remove that file by path: a peer could already own the entry
    // at that path, and a path-based removal here could delete the peer's
    // entry instead of this call's own file. Fail closed right here instead
    // of falling through to the birthtime comparison below, so a failed
    // identity read can never let this probe report success.
    return "its own probe file's identity could not be read from the open file descriptor";
  }
  // The one gap the fs API cannot close: this lstat and the removal below
  // are two separate calls, not one atomic "remove if identity still
  // matches" step. A peer that wins this narrow gap can put any entry at
  // the probe path, including a pre-existing file it renames into place,
  // and the removal call below removes whatever entry is there when it
  // runs.
  const currentStats = await fs.lstat(probePath).catch(() => null);
  const stillOwned =
    currentStats !== null &&
    currentStats.dev === ownedIdentity.dev &&
    currentStats.ino === ownedIdentity.ino &&
    currentStats.ctimeMs === ownedIdentity.ctimeMs;
  if (stillOwned) {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
  let after;
  try {
    after = (await fs.lstat(dirPath)).birthtimeMs;
  } catch {
    return "its reported creation time could not be read";
  }
  return before === after ? null : "its reported creation time changed after a probe write";
}

async function refuseUnusableCreationTime(label, dirPath, reason) {
  process.stderr.write(
    "Refusing to trust the process session control path " + label + " (" + dirPath + "): " + reason +
      ". This filesystem or kernel gives no usable creation time. Terminating.\\n",
  );
  await latchAndTerminate();
}

// Runs once, before the first poll cycle, and before this wrapper captures
// the identities it later checks on every cycle. A failed capture fails
// closed: the wrapper has no verified identity to check on later cycles, so
// it terminates now instead of polling a control path it never verified.
//
// This wrapper cannot assume stats.birthtimeMs is a real creation time. Node
// can report a change-time copy as a creation time. That value fails closed
// far too aggressively (it would move on every stdin file this wrapper
// deletes), so this wrapper proves the value is not a copy with a probe before
// it trusts it, run once here, before either directory's identity is captured.
async function captureSessionIdentity() {
  try {
    const sessionProbeFailure = await birthtimeSurvivesProbe(sessionDir);
    if (sessionProbeFailure) {
      await refuseUnusableCreationTime("sessionDir", sessionDir, sessionProbeFailure);
      return;
    }
    const stdinProbeFailure = await birthtimeSurvivesProbe(stdinDir);
    if (stdinProbeFailure) {
      await refuseUnusableCreationTime("stdinDir", stdinDir, stdinProbeFailure);
      return;
    }
    const session = await statPathIdentity(sessionDir);
    const stdin = await statPathIdentity(stdinDir);
    sessionDirIdentity = session;
    stdinDirIdentity = stdin;
  } catch (error) {
    process.stderr.write(
      "Failed to capture the process session identity: " +
        (error instanceof Error ? error.message : String(error)) + ". Terminating.\\n",
    );
    await latchAndTerminate();
  }
}

// Runs on every poll cycle, before the wrapper reads stdinDir. Terminate and
// latch on any proof the control path is no longer the one this wrapper
// captured at startup (a missing path, a path that is no longer a directory,
// a symbolic link, or a directory whose identity changed), AND on every
// other lstat failure. A permission error is not transient here: a sandbox
// peer can deny search permission on the control directory without removing
// it, and treating that as transient would leave the wrapper and its child
// alive forever. The error code below only picks the stderr message, so an
// operator can still tell a removed directory from a permission error; it
// never decides whether to latch.
//
// Contrast readStdinDirNames() right below, whose catch block stays narrow
// on purpose: readdir() opens a directory descriptor, so it can fail with a
// genuinely transient error under descriptor exhaustion, and latching there
// would kill live sessions under load. lstat() opens no descriptor, and this
// function already runs before every call to readStdinDirNames(), so a
// permission error latches here before readdir() is ever reached.
async function verifySessionIdentity() {
  if (identityLost) return false;
  try {
    const session = await statPathIdentity(sessionDir);
    const stdin = await statPathIdentity(stdinDir);
    if (!sameIdentity(session, sessionDirIdentity) || !sameIdentity(stdin, stdinDirIdentity)) {
      await latchAndTerminate();
      return false;
    }
    return true;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    const reason =
      code === "ENOENT"
        ? "the control path no longer exists"
        : code === "ENOTDIR"
          ? "the control path is no longer a directory"
          : code === "EPAPERCLIP_SYMLINK"
            ? "the control path is now a symbolic link"
            : "lstat failed" + (code ? " with " + code : "");
    process.stderr.write("Latching on a lost process session identity: " + reason + ". Terminating.\\n");
    await latchAndTerminate();
    return false;
  }
}

// This catch block stays narrow on purpose: see the comment above
// verifySessionIdentity() for why a permission error here is treated as
// transient while the same error latches there.
async function readStdinDirNames() {
  if (!(await verifySessionIdentity())) return [];
  try {
    return await fs.readdir(stdinDir);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      await latchAndTerminate();
    }
    return [];
  }
}

async function pollStdin() {
  while (!shuttingDown) {
    const entries = (await readStdinDirNames()).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      if (shuttingDown) break;
      const entrySeq = Number.parseInt(name, 10);
      // Hold the send order when an earlier file has not appeared. Do not consume
      // this later file: wait for the missing file on a later cycle, bounded by
      // the retry budget. After the budget, fail loud and advance past the gap,
      // so the present file can run.
      if (Number.isFinite(entrySeq) && entrySeq > stdinExpectedSeq) {
        stdinGapRetries += 1;
        if (stdinGapRetries < stdinMaxParseRetries) {
          break;
        }
        await writeEvent({
          type: "error",
          message:
            "Advanced past missing stdin files " + stdinExpectedSeq + " to " + (entrySeq - 1) +
            " after " + stdinMaxParseRetries + " retries.",
        });
        stdinGapRetries = 0;
        stdinExpectedSeq = entrySeq;
      }
      const file = path.posix.join(stdinDir, name);
      let message;
      try {
        // Hardening (I3): open with O_NOFOLLOW where the platform defines it,
        // so a control-path symbolic link swapped in after the directory
        // check fails the read instead of following it.
        const readFlag =
          typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : "r";
        const raw = await fs.readFile(file, { encoding: "utf8", flag: readFlag });
        // An empty read means the content is not on disk yet. Treat it the same
        // as a parse failure: keep the file and retry on a later cycle.
        if (!raw) throw new Error("stdin file is empty");
        message = JSON.parse(raw);
      } catch (error) {
        const retries = (stdinParseRetries.get(name) || 0) + 1;
        if (retries >= stdinMaxParseRetries) {
          // The retry limit is reached. Drop the file and write an error event,
          // so the lost message fails loud. The file is resolved now, so let the
          // loop go on to the next entry.
          stdinParseRetries.delete(name);
          await fs.rm(file, { force: true }).catch(() => undefined);
          await writeEvent({
            type: "error",
            message:
              "Dropped unreadable stdin file after " + stdinMaxParseRetries + " retries: " + name + ": " +
              (error instanceof Error ? error.message : String(error)),
          });
          // The file is resolved (dropped). Advance the expected number and reset
          // the gap budget, then let the loop go on to the next entry.
          if (Number.isFinite(entrySeq)) stdinExpectedSeq = entrySeq + 1;
          stdinGapRetries = 0;
          continue;
        }
        // The file is not readable yet and is not past the retry limit. Keep it
        // and stop this cycle to hold the send order. A later file (for example
        // stdinEnd) must not run before this earlier file. A later cycle reads
        // from the start again.
        stdinParseRetries.set(name, retries);
        break;
      }
      // The parse succeeded, so the content is complete. Delete the file first,
      // then act on the message. A later cycle never re-reads a handled file.
      stdinParseRetries.delete(name);
      await fs.rm(file, { force: true }).catch(() => undefined);
      // The file is handled. Advance the expected number and reset the gap
      // budget, so the next expected file starts fresh.
      if (Number.isFinite(entrySeq)) stdinExpectedSeq = entrySeq + 1;
      stdinGapRetries = 0;
      if (message.type === "stdin" && typeof message.data === "string") {
        if (!stdinClosed) child.stdin.write(Buffer.from(message.data, "base64"));
      } else if (message.type === "stdinEnd") {
        stdinClosed = true;
        child.stdin.end();
        break;
      } else if (message.type === "shutdown") {
        await terminate();
        break;
      }
    }
    if (!shuttingDown) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

await captureSessionIdentity();

void pollStdin().catch((error) => void writeEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
`;

// Streamed variant: the wrapper writes each output frame as one newline-
// delimited JSON line to its stdout. The host runs this wrapper as one
// long-lived session command and reads the frames from the session log stream,
// so there is no host output-file poll. Each frame carries a monotonic `seq`,
// so the host delivers every frame exactly once whether it arrives live or in
// the final result. The wrapper exits when the child closes, so the session
// command settles and the session shell (the subshell wrap around it) survives.
function getProcessSessionRemoteStreamSource(): string {
  return `import { spawn } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;
const commandPayload = process.env.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;
if (!sessionDir || !commandPayload) throw new Error("Missing process session bridge env.");

const stdinDir = path.posix.join(sessionDir, "stdin");
let seq = 0;
let stdinClosed = false;
let shuttingDown = false;
let terminated = false;
let killTimer = null;

const config = JSON.parse(Buffer.from(commandPayload, "base64").toString("utf8"));
await fs.mkdir(stdinDir, { recursive: true });

// One newline-delimited JSON frame per event. Node keeps process.stdout writes
// ordered, and the base64 payload holds no newline, so each frame is one line.
function writeEvent(event) {
  seq += 1;
  process.stdout.write(JSON.stringify({ seq, ...event }) + "\\n");
}

// Hardening (I3): refuse a symbolic link on a control path before this
// wrapper reads or writes through it. A symbolic link here could let another
// sandbox process redirect the wrapper's file I/O outside the session tree.
async function isSymbolicLink(candidatePath) {
  try {
    const stats = await fs.lstat(candidatePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

if ((await isSymbolicLink(sessionDir)) || (await isSymbolicLink(stdinDir))) {
  await writeEvent({ type: "error", message: "Refusing a symbolic link on a process session control path." });
  process.exitCode = 1;
  process.exit(1);
}

// Hardening (I3, not containment): the wrapper's own launch env carries the
// session dir and the command payload. Scrub both keys before they reach the
// spawned child, so the child never inherits a path to its own control files.
const childEnv = { ...process.env, ...(config.env || {}) };
delete childEnv.PAPERCLIP_PROCESS_SESSION_DIR;
delete childEnv.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;

// I1: exactly one child process per emitted wrapper. Do not add a second
// tracked child handle.
const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
  cwd: config.cwd || process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => writeEvent({ type: "data", stream: "stdout", data: Buffer.from(chunk).toString("base64") }));
child.stderr.on("data", (chunk) => writeEvent({ type: "data", stream: "stderr", data: Buffer.from(chunk).toString("base64") }));
child.on("error", (error) => writeEvent({ type: "error", message: error.message }));
// "close" (not "exit") so stdout/stderr fully drain before the exit frame.
// Queue the exit frame first, then run terminate(), so the exit frame always
// lands even when the child closes on its own, with no stdinEnd and no
// shutdown message ever received. writeEvent() only queues an asynchronous
// write. terminate()'s own synchronous work (ending the child's stdin and
// sending SIGTERM) already runs in this same handler by the time the exit
// frame becomes readable on disk. terminate() is idempotent and its
// child.kill() call here is always a no-op (I2): the child's process handle
// is already gone by the time "close" fires. An error frame carries no such
// guarantee: child.on("error", ...) below does not call terminate(), and
// neither does the poll loop's own error writes, so those fire while the
// wrapper and its child are still fully alive.
child.on("close", (code, signal) => {
  writeEvent({ type: "exit", code, signal });
  process.exitCode = typeof code === "number" ? code : 1;
  void terminate();
});

${PROCESS_SESSION_STDIN_POLL_TAIL}`;
}

function getProcessSessionRemoteEventFileSource(): string {
  return `import { spawn } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;
const commandPayload = process.env.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;
if (!sessionDir || !commandPayload) throw new Error("Missing process session bridge env.");

const stdinDir = path.posix.join(sessionDir, "stdin");
const eventsDir = path.posix.join(sessionDir, "events");
let seq = 0;
let stdinClosed = false;
let shuttingDown = false;
let terminated = false;
let killTimer = null;

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

// Hardening (I3): refuse a symbolic link on a control path before this
// wrapper reads or writes through it. A symbolic link here could let another
// sandbox process redirect the wrapper's file I/O outside the session tree.
async function isSymbolicLink(candidatePath) {
  try {
    const stats = await fs.lstat(candidatePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

if ((await isSymbolicLink(sessionDir)) || (await isSymbolicLink(stdinDir))) {
  await writeEvent({ type: "error", message: "Refusing a symbolic link on a process session control path." });
  process.exitCode = 1;
  process.exit(1);
}

// Hardening (I3, not containment): the wrapper's own launch env carries the
// session dir and the command payload. Scrub both keys before they reach the
// spawned child, so the child never inherits a path to its own control files.
const childEnv = { ...process.env, ...(config.env || {}) };
delete childEnv.PAPERCLIP_PROCESS_SESSION_DIR;
delete childEnv.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;

// I1: exactly one child process per emitted wrapper. Do not add a second
// tracked child handle.
const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
  cwd: config.cwd || process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => void writeEvent({ type: "data", stream: "stdout", data: Buffer.from(chunk).toString("base64") }));
child.stderr.on("data", (chunk) => void writeEvent({ type: "data", stream: "stderr", data: Buffer.from(chunk).toString("base64") }));
child.on("error", (error) => void writeEvent({ type: "error", message: error.message }));
// "close" (not "exit") so stdout/stderr fully drain before the exit event;
// the write chain then guarantees the exit file lands after every data file.
// Queue the exit event first, then run terminate(), so the poll loop ends
// even when the child closes on its own, with no stdinEnd and no shutdown
// message ever received. writeEvent() only queues an asynchronous write.
// terminate()'s own synchronous work (ending the child's stdin and sending
// SIGTERM) already runs in this same handler by the time the exit file
// becomes readable on disk. terminate() is idempotent and its child.kill()
// call here is always a no-op (I2): the child's process handle is already
// gone by the time "close" fires. An error event carries no such guarantee:
// child.on("error", ...) below does not call terminate(), and neither does
// the poll loop's own error writes, so those fire while the wrapper and its
// child are still fully alive.
child.on("close", (code, signal) => {
  void writeEvent({ type: "exit", code, signal });
  process.exitCode = typeof code === "number" ? code : 1;
  void terminate();
});

${PROCESS_SESSION_STDIN_POLL_TAIL}`;
}

/** The default deadline for the duplex readiness handshake, in milliseconds. */
const DEFAULT_DUPLEX_READINESS_TIMEOUT_MS = 10_000;

/** The default bounded budget to close a partial duplex channel, in milliseconds. */
const DEFAULT_DUPLEX_CLEANUP_BUDGET_MS = 2_000;

/**
 * Reserve a loopback port the host assigns to the duplex gateway. The host binds
 * an ephemeral listener on `127.0.0.1`, reads the port the operating system
 * chose, then closes the listener. The number is very likely free when the
 * gateway binds it a moment later. The gateway binds exactly this port or exits
 * nonzero, so a taken port fails closed to the file bridge and never steers the
 * endpoint.
 */
async function reserveHostAssignedLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not reserve a loopback port for the duplex gateway.")));
        return;
      }
      const reserved = address.port;
      probe.close(() => resolve(reserved));
    });
  });
}

/**
 * Build the argument vector that launches the duplex gateway in the sandbox. The
 * host passes the assigned port and the per-open nonce only through the launch
 * environment, so the argument vector sets them as environment assignments in
 * front of the node command. No addressing data comes from the channel.
 *
 * The script uses `exec env NAME=value ... command`. A POSIX shell accepts an
 * environment-assignment prefix only on a plain command, never on `exec`. The
 * form `exec NAME=value command` exits with status 127. The `env` utility carries
 * the assignments, and `exec` still replaces the shell with the gateway process,
 * so the gateway keeps the process slot and the assigned environment.
 */
export function buildDuplexGatewayLaunchArgv(input: {
  shellCommand: "bash" | "sh";
  remoteEntrypoint: string;
  nodeCommand?: string | null;
  env: Record<string, string>;
}): string[] {
  const assignments = Object.entries(input.env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const script = `exec env ${assignments} ${shellQuote(nodeCommand)} ${shellQuote(input.remoteEntrypoint)}`;
  return [input.shellCommand, ...shellCommandArgs(script)];
}

/** The reason the duplex readiness handshake did not pass. */
type DuplexReadinessFailure = "protocol_contamination" | "nonce_mismatch" | "channel_exit" | "timeout";

/** The outcome of the duplex readiness handshake. */
type DuplexReadinessResult =
  | { ok: true }
  | { ok: false; reason: DuplexReadinessFailure };

/**
 * Map a readiness failure to the fixed fallback reason. Each readiness failure
 * maps to exactly one reason from the closed telemetry set, so the fallback
 * counter and the transport event carry only an approved value.
 */
function duplexReadinessFallbackReason(reason: DuplexReadinessFailure): DuplexFallbackReason {
  switch (reason) {
    case "protocol_contamination":
      return "contaminated";
    case "nonce_mismatch":
      return "ready_nonce_mismatch";
    case "timeout":
      return "ready_timeout";
    case "channel_exit":
      return "ready_invalid";
  }
}

/**
 * The fixed marker the worker manager puts in a route-busy rejection. The manager
 * defines the constant; this module matches the fixed string, because the two
 * layers ship in separate packages and share no import. The marker names the
 * process-scoped route ceiling, so it carries no route, query, body, or token.
 */
const DUPLEX_ROUTE_BUSY_ERROR_MARKER = "DUPLEX_CHANNEL_ROUTE_BUSY";

/**
 * Report whether the caught open error is a route-busy rejection. The host maps it
 * to the `route_busy` fallback stage, so a full process-scoped route ceiling never
 * folds into a generic open failure.
 */
function isDuplexRouteBusyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DUPLEX_ROUTE_BUSY_ERROR_MARKER);
}

/**
 * The cap on the pre-READY readiness buffer, in bytes. The gate reads untrusted
 * bytes before the READY line arrives, so it bounds the buffer. The cap is the
 * codec frame-size bound plus one line of margin, so a legitimate maximum-size
 * READY frame still fits. Past the cap with no newline, the stream cannot be a
 * valid READY frame, so the gate finishes with protocol contamination.
 */
const DUPLEX_READINESS_BUFFER_CAP_BYTES = DEFAULT_MAX_DUPLEX_FRAME_BYTES + 4_096;

// ---------------------------------------------------------------------------
// http2_v1: the client connection preface scan and the run disposition latch.
// ---------------------------------------------------------------------------

/**
 * The HTTP/2 client connection preface: 24 octets, `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`
 * (RFC 9113, Section 3.4). A Node `http2.performServerHandshake` call needs a
 * `Duplex` whose readable side starts at this exact sequence; one extra
 * leading byte makes the preface invalid, and the server reports a
 * `PROTOCOL_ERROR`. The server does not skip a leading byte and does not
 * search for the sequence, so the host finds the offset itself before it
 * hands the channel to the server.
 */
const HTTP2_CLIENT_CONNECTION_PREFACE = Buffer.from(
  "505249202a20485454502f322e300d0a0d0a534d0d0a0d0a",
  "hex",
);

/** The one shared empty buffer. The preface scan starts and resets its two
 * retained buffers to it. */
const HTTP2_PREFACE_EMPTY_BUFFER = Buffer.alloc(0);

// The count of bytes the preface scan's substring search examines, in bytes.
// A search that always starts from the beginning of the retained buffer
// re-examines the whole buffer on every fragment, so this count grows
// quadratically in the number of fragments. `findPrefaceFrom` instead
// resumes from where the prior search left off, so this count stays linear
// in the bytes received. A test reads this count to prove the search work
// does not regress to the quadratic shape. Production code never reads this
// count.
let http2PrefaceScanSearchUnits = 0;

// The count of bytes the pre-preface scan buffer copies while it grows its
// backing storage. A one-copy-per-fragment append copies the whole retained
// buffer on every fragment, so this count grows quadratically in the number
// of fragments. The doubling-growth approach copies only on a reallocation,
// so this count stays linear in the bytes received. A test reads this count
// to prove the growth work does not regress to the quadratic shape.
// Production code never reads this count.
let http2PrefaceScanBufferGrowthCopyUnits = 0;

// The same count as `http2PrefaceScanBufferGrowthCopyUnits`, for the
// post-preface replay buffer instead of the pre-preface scan buffer.
let http2PrefaceReplayBufferGrowthCopyUnits = 0;

/**
 * A byte buffer that grows its backing storage by doubling its capacity,
 * instead of copying the whole retained buffer on every appended fragment. A
 * sender that trickles input in many small fragments would otherwise force
 * one full copy of the whole retained buffer per fragment: with the buffer
 * growing toward its cap, that is quadratic work in the number of fragments.
 * Doubling the backing storage's capacity only when the current capacity
 * runs out reallocates and copies a logarithmic number of times, so the
 * total copy work stays linear in the bytes received. `countGrowthCopy`
 * receives the number of bytes each reallocation copies, so a test can add
 * these up and prove the growth work stays linear.
 */
function createGrowableByteBuffer(countGrowthCopy: (copiedBytes: number) => void): {
  view: () => Buffer;
  length: () => number;
  append: (chunk: Uint8Array) => void;
  reset: () => void;
} {
  let used: Buffer = HTTP2_PREFACE_EMPTY_BUFFER;
  let storage: Buffer = HTTP2_PREFACE_EMPTY_BUFFER;
  return {
    view: () => used,
    length: () => used.length,
    append: (chunk: Uint8Array): void => {
      const usedLength = used.length;
      const neededLength = usedLength + chunk.byteLength;
      if (neededLength > storage.length) {
        let nextCapacity = storage.length === 0 ? chunk.byteLength : storage.length * 2;
        while (nextCapacity < neededLength) {
          nextCapacity *= 2;
        }
        const grown = Buffer.allocUnsafe(nextCapacity);
        storage.copy(grown, 0, 0, usedLength);
        countGrowthCopy(usedLength);
        storage = grown;
      }
      storage.set(chunk, usedLength);
      used = storage.subarray(0, neededLength);
    },
    reset: (): void => {
      used = HTTP2_PREFACE_EMPTY_BUFFER;
      storage = HTTP2_PREFACE_EMPTY_BUFFER;
    },
  };
}

/**
 * Find the client connection preface in `buffer` at or after index `from`
 * and return its offset, or -1. This counts the real scan distance for a
 * test: from `from` up to the found preface's end, or to the end of the
 * buffer when it finds none. The count stays linear in the bytes received
 * when the caller advances `from` to just short of the buffer's end on every
 * miss, instead of always searching from the start of the buffer.
 */
function findPrefaceFrom(buffer: Buffer, from: number): number {
  const offset = buffer.indexOf(HTTP2_CLIENT_CONNECTION_PREFACE, from);
  const scannedTo =
    offset === -1 ? buffer.length : offset + HTTP2_CLIENT_CONNECTION_PREFACE.length;
  http2PrefaceScanSearchUnits += Math.max(scannedTo - from, 0);
  return offset;
}

/**
 * Wrap the readiness gate's broker channel so its `onData` delivers no byte
 * until the client connection preface appears, then delivers every byte from
 * the preface onward.
 *
 * The wrapped channel opens its scan window only on the bytes the readiness
 * gate already retained after it accepted the READY line (constraint: the
 * scan window opens only after the gate accepts the nonce). Nothing before
 * that line ever reaches this scan, because the gate itself discards the
 * whole pre-READY buffer on acceptance. The scan buffers at most
 * {@link DUPLEX_READINESS_BUFFER_CAP_BYTES}; past that bound with no preface
 * found, it calls `onMissing` exactly one time and stops buffering, so the
 * caller can abort the open and fall back to `queue_v1`. The function holds
 * no prologue byte count: it always scans for the fixed 24-octet sequence,
 * never a length.
 *
 * The bytes that follow the found preface, before the HTTP/2 server binds a
 * downstream listener, land in `pendingAfterPreface`. This buffer holds
 * untrusted bytes on the same footing as the scan buffer, so it carries the
 * same {@link DUPLEX_READINESS_BUFFER_CAP_BYTES} cap. A chunk that would pass
 * the cap fails closed: the function drops the buffer and stops the channel.
 * The caller reads {@link replayOverflowed} after the preface settles and, on
 * `true`, treats the open the same as a missing preface.
 */
function createHttp2PrefaceScanningChannel(
  channel: CommandManagedDuplexChannel,
  options: {
    capBytes: number;
    onFound: () => void;
    onMissing: () => void;
  },
): {
  channel: CommandManagedDuplexChannel;
  replayOverflowed: () => boolean;
  disposeScanBuffer: () => void;
} {
  // The pre-preface scan buffer. `scanBuf.append` grows its backing storage
  // by doubling, instead of copying the whole retained buffer on every
  // fragment — see {@link createGrowableByteBuffer}. `scanSearchFrom` is the
  // first index the next search must examine: `findPrefaceFrom` advances it
  // to just short of the buffer's end on every miss, so a fragmented preface
  // is found without a full rescan of the retained buffer on every fragment.
  const scanBuf = createGrowableByteBuffer((copiedBytes) => {
    http2PrefaceScanBufferGrowthCopyUnits += copiedBytes;
  });
  let scanSearchFrom = 0;
  let sawPreface = false;
  let failed = false;
  let downstream: ((chunk: Uint8Array) => void) | null = null;
  // Bytes found after the preface before a downstream listener attaches. The
  // wrapped channel replays them on attach, the same pattern the readiness
  // gate itself uses for its own post-READY replay buffer. This also grows
  // by doubling, for the same reason as `scanBuf`: fragmented post-preface
  // input must not force a full copy of the retained buffer per fragment.
  const pendingAfterPreface = createGrowableByteBuffer((copiedBytes) => {
    http2PrefaceReplayBufferGrowthCopyUnits += copiedBytes;
  });
  let replayOverflow = false;

  // Drop the pending buffer and stop the channel. The caller reads
  // `replayOverflowed()` after the preface settles and falls back the same
  // way it does for a missing preface.
  function overflowAndStop(): void {
    replayOverflow = true;
    pendingAfterPreface.reset();
    channel.stop();
  }

  function deliver(chunk: Buffer): void {
    if (downstream) {
      downstream(chunk);
      return;
    }
    if (replayOverflow) return;
    if (pendingAfterPreface.length() + chunk.byteLength > options.capBytes) {
      overflowAndStop();
      return;
    }
    pendingAfterPreface.append(chunk);
  }

  channel.onData((chunk) => {
    if (failed || replayOverflow) return;
    if (sawPreface) {
      deliver(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return;
    }
    const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Reject the chunk on its prospective length before it grows the scan
    // buffer, the same way `deliver` bounds `pendingAfterPreface`. A single
    // oversized chunk — or a chunk that tips an already-large buffer past
    // the cap — must fail closed here, before `scanBuf.append` performs the
    // allocation. Checking the cap only after the append still bounds the
    // retained buffer, but it lets one untrusted chunk force an allocation
    // as large as the chunk itself, unbounded by `capBytes`.
    if (scanBuf.length() + rawChunk.byteLength > options.capBytes) {
      failed = true;
      scanBuf.reset();
      scanSearchFrom = 0;
      options.onMissing();
      return;
    }
    scanBuf.append(rawChunk);
    const scanBuffer = scanBuf.view();
    const offset = findPrefaceFrom(scanBuffer, scanSearchFrom);
    if (offset === -1) {
      // No match yet. Resume the next search just short of the buffer's
      // end, keeping back an overlap of one octet less than the preface
      // length, so a preface split across this fragment and the next one is
      // still found. Each byte enters that overlap window a bounded number
      // of times, so the total search work stays linear in the bytes
      // received, not quadratic in the number of fragments.
      scanSearchFrom = Math.max(
        0,
        scanBuffer.length - (HTTP2_CLIENT_CONNECTION_PREFACE.length - 1),
      );
      return;
    }
    sawPreface = true;
    options.onFound();
    const fromPreface = Buffer.from(scanBuffer.subarray(offset));
    scanBuf.reset();
    scanSearchFrom = 0;
    deliver(fromPreface);
  });

  return {
    channel: {
      write: (data: Uint8Array) => channel.write(data),
      onData: (listener: (chunk: Uint8Array) => void) => {
        downstream = listener;
        if (pendingAfterPreface.length() > 0) {
          // Copy the exact retained bytes instead of handing the listener
          // the growable buffer's backing view. That backing storage can
          // run ahead of the bytes in use (the doubling growth in
          // `pendingAfterPreface.append` over-provisions it), so a raw view
          // would keep the whole over-provisioned allocation alive for as
          // long as the listener holds its reference.
          const replay = Buffer.from(pendingAfterPreface.view());
          pendingAfterPreface.reset();
          listener(replay);
        }
      },
      onExit: (listener: (exit: { exitCode: number | null }) => void) => channel.onExit(listener),
      stop: () => channel.stop(),
      close: () => channel.close(),
    },
    replayOverflowed: () => replayOverflow,
    /**
     * Drop the scan buffer, for a caller-side terminal path this function
     * itself never reaches — the bound readiness timeout elapsing while the
     * scan is still searching, with no preface found and no cap refusal of
     * its own. A call after the preface already matched, or after the cap
     * already failed the scan closed, is a no-op: both paths already reset
     * the scan buffer themselves.
     */
    disposeScanBuffer: (): void => {
      if (sawPreface || failed) return;
      failed = true;
      scanBuf.reset();
      scanSearchFrom = 0;
    },
  };
}

/** The terminal outcome of the preface scan: either the client preface
 * appeared inside the bounded readiness buffer, or it did not. */
type Http2PrefaceScanResult = "found" | "missing";

/**
 * Wait for {@link createHttp2PrefaceScanningChannel} to settle: either the
 * preface appears, or the scan passes the bound with no match, or the bound
 * readiness timeout elapses first. Reapplying the readiness timeout here
 * keeps one configured value for both the READY-line wait and this
 * immediately-following preface wait; the task adds no new timeout setting.
 * Returns the scanning channel alongside the settled result, so the caller
 * binds the HTTP/2 server to it only on a `found` result. On a `found`
 * result, the caller must still read `replayOverflowed()`: the post-preface
 * buffer can overflow its cap after the preface settles as `found` and
 * before the caller binds a downstream listener.
 */
function scanForHttp2ClientPreface(
  channel: CommandManagedDuplexChannel,
  options: { capBytes: number; timeoutMs: number },
): {
  scanned: CommandManagedDuplexChannel;
  settled: Promise<Http2PrefaceScanResult>;
  replayOverflowed: () => boolean;
} {
  let resolveSettled!: (result: Http2PrefaceScanResult) => void;
  let settledOnce = false;
  const settled = new Promise<Http2PrefaceScanResult>((resolve) => {
    resolveSettled = resolve;
  });
  // Reassigned to the real function once `createHttp2PrefaceScanningChannel`
  // returns, below. `settle` can only actually run after that point (the
  // timer fires later, and `onMissing`/`onFound` fire from inside the
  // channel's own `onData`, which registers after this call), so the
  // placeholder never runs for real.
  let disposeScanBuffer: () => void = () => {};
  const settle = (result: Http2PrefaceScanResult): void => {
    if (settledOnce) return;
    settledOnce = true;
    clearTimeout(timer);
    // The bound readiness timeout can elapse while the scan still searches,
    // with no preface found and no cap refusal of its own. That path holds
    // no other cleanup, so drop the scan buffer here. A `found` result, or a
    // `missing` result the scan itself already failed closed, is a no-op
    // inside `disposeScanBuffer`.
    if (result === "missing") disposeScanBuffer();
    resolveSettled(result);
  };
  const timer = setTimeout(() => settle("missing"), options.timeoutMs);
  timer.unref?.();
  const scan = createHttp2PrefaceScanningChannel(channel, {
    capBytes: options.capBytes,
    onFound: () => settle("found"),
    onMissing: () => settle("missing"),
  });
  disposeScanBuffer = scan.disposeScanBuffer;
  return { scanned: scan.channel, settled, replayOverflowed: scan.replayOverflowed };
}

/**
 * Test-only surface for {@link scanForHttp2ClientPreface}. A test drives the
 * post-preface replay cap across every terminal path without the whole
 * bridge. Production code never reads this export.
 */
export const __http2PrefaceScanTesting = {
  scanForHttp2ClientPreface: (
    channel: CommandManagedDuplexChannel,
    options: { capBytes: number; timeoutMs: number },
  ) => scanForHttp2ClientPreface(channel, options),
  readScanSearchUnits: (): number => http2PrefaceScanSearchUnits,
  resetScanSearchUnits: (): void => {
    http2PrefaceScanSearchUnits = 0;
  },
  readScanBufferGrowthCopyUnits: (): number => http2PrefaceScanBufferGrowthCopyUnits,
  resetScanBufferGrowthCopyUnits: (): void => {
    http2PrefaceScanBufferGrowthCopyUnits = 0;
  },
  readReplayBufferGrowthCopyUnits: (): number => http2PrefaceReplayBufferGrowthCopyUnits,
  resetReplayBufferGrowthCopyUnits: (): void => {
    http2PrefaceReplayBufferGrowthCopyUnits = 0;
  },
};

/**
 * The terminal run disposition for the `http2_v1` path, in the same shape as
 * {@link DuplexBrokerRunDisposition}. A `failed` disposition means a terminal
 * loss ordered before an orderly completion, so the run must not report
 * success.
 */
interface Http2RunDispositionLatch {
  readonly disposition: DuplexBrokerRunDisposition;
  /**
   * Record a terminal loss. Returns `true` when the call flipped the
   * disposition to failed; returns `false` when a loss or an orderly
   * completion already latched, so the run already has its terminal result.
   * The first recorded loss latches — a later call never overrides it.
   */
  recordLoss(reason: DuplexLossReason): boolean;
  /** Mark the host-observed orderly completion of the agent turn. A loss that
   * already latched keeps the failure. */
  markOrderlyCompletion(): void;
  /** Atomically mark the orderly completion and read the disposition. */
  settleRunDisposition(): DuplexBrokerRunDisposition;
}

function createHttp2RunDispositionLatch(): Http2RunDispositionLatch {
  let lossOrdered = false;
  let lossReason: DuplexLossReason | null = null;
  let completionOrdered = false;
  const markOrderlyCompletion = (): void => {
    if (completionOrdered || lossOrdered) return;
    completionOrdered = true;
  };
  return {
    get disposition(): DuplexBrokerRunDisposition {
      return { failed: lossOrdered, lossReason };
    },
    recordLoss(reason: DuplexLossReason): boolean {
      if (lossOrdered || completionOrdered) return false;
      lossOrdered = true;
      lossReason = reason;
      return true;
    },
    markOrderlyCompletion,
    settleRunDisposition(): DuplexBrokerRunDisposition {
      markOrderlyCompletion();
      return { failed: lossOrdered, lossReason };
    },
  };
}

/**
 * Create the run-log directory on the sandbox before the tail starts. The file
 * bridge worker creates this directory on the file path. The duplex path starts
 * no worker, so the host creates the directory here. The tail then reads a real
 * directory from its first tick.
 *
 * This step is best effort. The broker already serves the duplex transport when
 * the host reaches it, and the tail wrap command runs its own `mkdir -p` as a
 * backstop. So a create failure must not tear down a working duplex transport;
 * the host swallows it and still builds the tail. The log line names no raw
 * error, so no raw error rides a log line here.
 */
async function ensureSandboxRunLogDirectory(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  logsDir: string;
  shellCommand: "bash" | "sh";
  timeoutMs: number | null | undefined;
}): Promise<void> {
  try {
    await input.runner.execute({
      command: input.shellCommand,
      args: shellCommandArgs(`mkdir -p ${shellQuote(input.logsDir)}`),
      cwd: input.remoteCwd,
      timeoutMs: input.timeoutMs ?? undefined,
    });
  } catch {
    // Best effort: the tail wrap command creates the directory before it writes.
  }
}

/**
 * The duplex readiness gate. The gate owns the single data listener and the
 * single exit listener of the channel while the host waits for a valid READY
 * frame. It resolves the handshake, then hands the channel to the broker.
 *
 * The gate authenticates readiness with the nonce and the strict READY schema,
 * not with the line position. A PTY channel echoes the launch wrapper line before
 * it sets raw mode, so the first line is often not the READY frame. The gate skips
 * each pre-READY line that does not decode as a READY frame, then accepts the first
 * line that decodes as a READY frame with the matching nonce. A line that decodes
 * as a READY frame with a wrong nonce fails the handshake with a nonce mismatch. An
 * early exit or a timeout also fails the handshake. The gate never dispatches a
 * request; the broker does that after readiness passes.
 *
 * The skipped bytes stay in the capped buffer, so the O(1) cap and the readiness
 * timeout still bound the wait. The gate enforces the cap on every pre-READY path
 * and before it decodes a candidate line, so an over-cap prefix never reaches READY
 * acceptance. The cap check has priority over READY acceptance on every path.
 */
// The count of the pre-READY newline-scan work, in bytes. Each search adds the
// number of bytes it can read. A test reads this count to prove the scan work
// stays linear in the bytes received. Production code never reads this count.
let duplexReadinessNewlineScanUnits = 0;

// The count of bytes `appendReadinessBytes` copies while it grows the pre-READY
// buffer's backing storage. A one-copy-per-fragment approach copies the whole
// retained buffer on every fragment, so this count grows quadratically in the
// number of fragments. The doubling-growth approach copies only on a
// reallocation, so this count stays linear in the bytes received. A test reads
// this count to prove the growth work does not regress to the quadratic shape.
// Production code never reads this count.
let duplexReadinessBufferGrowthCopyUnits = 0;

/** The newline byte. The readiness buffer is a byte buffer, not a string. */
const READINESS_NEWLINE_BYTE = 0x0a;
/** The opening-brace byte. The bracketed-paste retry scans for it, not a string. */
const READINESS_OPEN_BRACE_BYTE = 0x7b;
/** The one shared empty buffer. The gate starts and resets `buffer` to it. */
const READINESS_EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Find the first newline in `buffer` at or after index `from` and return its
 * index, or -1. `Buffer#indexOf` reads the bytes from `from` up to the newline
 * it finds, or to the end of the buffer when it finds none. This helper counts
 * that real scan distance for a test. The count stays linear in the bytes
 * received when the caller advances `from` past each newline it consumes.
 */
function findNewlineFrom(buffer: Buffer, from: number): number {
  const newlineIndex = buffer.indexOf(READINESS_NEWLINE_BYTE, from);
  const scanned = newlineIndex === -1 ? buffer.length - from : newlineIndex - from + 1;
  duplexReadinessNewlineScanUnits += scanned;
  return newlineIndex;
}

/**
 * Test-only surface for the pre-READY readiness gate. A test reads the scan
 * count to prove the newline search work stays linear in the bytes received.
 * Production code does not use this object.
 */
export const __duplexReadinessTesting = {
  readNewlineScanUnits: (): number => duplexReadinessNewlineScanUnits,
  resetNewlineScanUnits: (): void => {
    duplexReadinessNewlineScanUnits = 0;
  },
  readBufferGrowthCopyUnits: (): number => duplexReadinessBufferGrowthCopyUnits,
  resetBufferGrowthCopyUnits: (): void => {
    duplexReadinessBufferGrowthCopyUnits = 0;
  },
  // Build one readiness gate over a supplied channel, so a test can drive the
  // readiness-replay cap lifecycle across every terminal path without the whole
  // bridge. Production code never reads this factory.
  createReadinessGate: (channel: CommandManagedDuplexChannel, options: { nonce: string; timeoutMs: number }) =>
    createDuplexReadinessGate(channel, options),
};

interface DuplexReadinessGate {
  /** Resolves with the handshake outcome. It never rejects. */
  readonly ready: Promise<DuplexReadinessResult>;
  /**
   * The channel view the broker consumes after readiness passes. It replays the
   * bytes that followed the READY frame, then forwards each later chunk and the
   * exit. The gate keeps one real data listener, so the broker never double-binds
   * the channel.
   */
  readonly brokerChannel: CommandManagedDuplexChannel;
  /**
   * Report whether a post-READY pre-bind chunk tipped the pending replay buffer
   * past {@link DUPLEX_READINESS_BUFFER_CAP_BYTES}. On such an overflow the gate
   * drops the pending replay buffer and stops the channel. The caller reads this
   * after `ready` resolves `ok`, and before it binds the broker.
   */
  replayOverflowed(): boolean;
  /**
   * Drop the pending replay buffer. The caller runs this on a terminal path that
   * abandons the pending replay without a broker handoff: a readiness failure, a
   * replay overflow, or a broker-construction failure. The normal handoff already
   * drops the buffer inside `brokerChannel.onData`, so a later call here is a
   * no-op.
   */
  disposePendingReplay(): void;
  /**
   * Test-only. Report the length of the retained pre-READY buffer, in bytes. A
   * test reads this to prove the gate drops the pre-READY buffer on READY
   * acceptance, so the process does not retain the sandbox-controlled prefix.
   * Production code does not read this.
   */
  retainedReadinessBufferLength(): number;
}

function createDuplexReadinessGate(
  channel: CommandManagedDuplexChannel,
  options: {
    nonce: string;
    timeoutMs: number;
  },
): DuplexReadinessGate {
  let settled = false;
  let readyOk = false;
  // The gate sets this when a post-READY pre-bind chunk tips the pending replay
  // buffer past the cap. On that overflow the gate drops the pending buffer and
  // stops the channel. The caller reads it through `replayOverflowed` and selects
  // the file bridge.
  let replayOverflow = false;
  // The raw bytes the host reads before the READY frame completes. `buffer` is
  // append-only and always a zero-copy view over the used prefix of `storage`,
  // so the O(1) cap check on `buffer.length` stays valid.
  let buffer: Buffer = READINESS_EMPTY_BUFFER;
  // The backing storage for `buffer`. `appendReadinessBytes` grows this by
  // doubling its capacity, instead of copying the whole retained buffer on
  // every fragment. See `appendReadinessBytes` for why this bounds the total
  // copy work.
  let storage: Buffer = READINESS_EMPTY_BUFFER;
  // The start index of the current line in `buffer`. A leading blank line
  // advances this cursor past its newline without a buffer copy.
  let lineStart = 0;
  // The next index to search for a newline. The gate scans from here, so each
  // byte is read at most one time for the newline search.
  let scanFrom = 0;

  /**
   * Append `chunk` to the pre-READY buffer without copying the bytes already
   * retained. A sender that trickles the handshake in many small fragments
   * (a slow socket, a byte-at-a-time PTY echo) would otherwise force one full
   * copy of the whole retained buffer per fragment: with `buffer` growing
   * toward the {@link DUPLEX_READINESS_BUFFER_CAP_BYTES} cap, that is
   * quadratic work in the number of fragments. This instead grows `storage`
   * by doubling its capacity only when the current capacity runs out, so the
   * backing store reallocates and copies a logarithmic number of times, and
   * each append copies only the incoming chunk. The used length still reads
   * in O(1) through `buffer.length`, so every cap check and slice below stays
   * unchanged.
   */
  function appendReadinessBytes(chunk: Uint8Array): void {
    const usedLength = buffer.length;
    const neededLength = usedLength + chunk.byteLength;
    if (neededLength > storage.length) {
      let nextCapacity = storage.length === 0 ? chunk.byteLength : storage.length * 2;
      while (nextCapacity < neededLength) {
        nextCapacity *= 2;
      }
      const grown = Buffer.allocUnsafe(nextCapacity);
      storage.copy(grown, 0, 0, usedLength);
      duplexReadinessBufferGrowthCopyUnits += usedLength;
      storage = grown;
    }
    storage.set(chunk, usedLength);
    buffer = storage.subarray(0, neededLength);
  }
  // The bytes that followed the READY frame, held until the broker binds.
  let pending: Uint8Array = READINESS_EMPTY_BUFFER;
  // The exit that arrived after READY but before the broker bound, if any.
  let pendingExit: { exitCode: number | null } | null = null;
  let dataSink: ((chunk: Uint8Array) => void) | null = null;
  let exitSink: ((exit: { exitCode: number | null }) => void) | null = null;
  let resolveReady!: (result: DuplexReadinessResult) => void;
  const ready = new Promise<DuplexReadinessResult>((resolve) => {
    resolveReady = resolve;
  });

  const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), options.timeoutMs);
  timer.unref?.();

  function finish(result: DuplexReadinessResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (result.ok) readyOk = true;
    resolveReady(result);
  }

  channel.onData((chunk) => {
    if (dataSink) {
      dataSink(chunk);
      return;
    }
    if (readyOk) {
      // READY already passed; hold the bytes until the broker binds. Bound this
      // buffer directly against {@link DUPLEX_READINESS_BUFFER_CAP_BYTES}, the
      // same way the preface-scan gate's own post-preface replay buffer bounds
      // itself: a worker that keeps sending bytes after READY, faster than the
      // broker can bind, cannot grow this buffer past the cap. A chunk that
      // would pass the cap fails closed: the gate drops the pending buffer,
      // stops the channel, and sets the overflow flag. The caller reads the
      // flag and selects the file bridge, because `ready` already resolved
      // before this synchronous post-READY chunk arrived.
      if (pending.length + chunk.byteLength > DUPLEX_READINESS_BUFFER_CAP_BYTES) {
        replayOverflow = true;
        pending = READINESS_EMPTY_BUFFER;
        channel.stop();
        return;
      }
      // Copy a first chunk instead of aliasing the caller's `Uint8Array`, so a
      // channel that reuses its delivered buffer across calls cannot corrupt the
      // bytes this gate holds for the broker replay.
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      return;
    }
    if (settled) {
      // The handshake already failed. The channel is untrusted and can keep
      // sending bytes until the host closes it. Drop them, so a failed handshake
      // never grows the buffer after the gate settles.
      return;
    }
    // Append the new bytes and continue the newline search from `scanFrom`, the
    // first index not yet examined. Each byte is read at most one time for the
    // search, and `appendReadinessBytes` copies at most the incoming chunk, so
    // the total work stays linear in the bytes received, not in the number of
    // fragments they arrive in.
    appendReadinessBytes(chunk);
    for (;;) {
      const newlineIndex = findNewlineFrom(buffer, scanFrom);
      if (newlineIndex === -1) {
        // No complete line yet. The whole buffer up to the end is now scanned.
        scanFrom = buffer.length;
        // The gate reads untrusted bytes, so bound the pre-READY buffer. Past
        // the cap with no complete READY line, the stream cannot be a valid
        // READY frame, so finish with protocol contamination. The retained
        // skipped lines count against the cap; that is acceptable and fail-closed.
        //
        // `buffer` is a byte buffer, so `buffer.length` is the exact byte count,
        // read in O(1).
        if (buffer.length > DUPLEX_READINESS_BUFFER_CAP_BYTES) {
          finish({ ok: false, reason: "protocol_contamination" });
        }
        return;
      }
      if (newlineIndex === lineStart) {
        // Skip a blank line, the same as the frame decoder. Advance the line-start
        // cursor past the newline without a buffer copy, then search the next line
        // from the position after the newline. Enforce the cap after the advance,
        // so a blank-line flood past the cap fails closed before READY acceptance.
        lineStart = newlineIndex + 1;
        scanFrom = newlineIndex + 1;
        if (lineStart > DUPLEX_READINESS_BUFFER_CAP_BYTES) {
          finish({ ok: false, reason: "protocol_contamination" });
          return;
        }
        continue;
      }
      // A complete non-blank candidate line spans `[lineStart, newlineIndex)`.
      // Enforce the cap on the line's end offset before the decode, so an over-cap
      // prefix never reaches READY acceptance on a completed line.
      if (newlineIndex + 1 > DUPLEX_READINESS_BUFFER_CAP_BYTES) {
        finish({ ok: false, reason: "protocol_contamination" });
        return;
      }
      // Slice only the single candidate line for the decode.
      const line = buffer.slice(lineStart, newlineIndex);
      let decoded = decodeDuplexLine(line);
      if (!decoded.ok) {
        // The whole line did not decode. A terminal can put bytes in front of the
        // gateway's first frame on the same line, with no newline between them: a
        // shell with bracketed paste enabled writes its disable sequence and a
        // bare carriage return (`ESC [ ? 2 0 0 4 l CR`) immediately before the
        // child's first output. So retry the decode from the first `{` in the
        // line, which is where a frame can start.
        //
        // This does not weaken the handshake. The retry still runs the same
        // strict decode over the remainder of the line, and readiness still
        // authenticates on the nonce below, so a prefix cannot forge a frame or
        // smuggle a second one — it can only be discarded.
        const braceIndex = line.indexOf(READINESS_OPEN_BRACE_BYTE);
        if (braceIndex > 0) {
          decoded = decodeDuplexLine(line.slice(braceIndex));
        }
      }
      if (decoded.ok && decoded.frame.type === "ready") {
        // A line that decodes as a READY frame authenticates by the nonce. A wrong
        // nonce fails the handshake; the matching nonce passes it.
        if (decoded.frame.nonce !== options.nonce) {
          finish({ ok: false, reason: "nonce_mismatch" });
          return;
        }
        // The bytes that follow the READY line become the replay buffer for the
        // broker.
        //
        // Copy the suffix instead of slicing it off `buffer`. `buffer` is a view
        // over `storage`, and `storage`'s capacity can run ahead of the bytes in
        // use (the doubling growth in `appendReadinessBytes` over-provisions it).
        // A slice would keep that whole over-provisioned allocation alive for as
        // long as the broker replay holds its reference. The copy is exactly
        // `suffix.length` bytes, one time, not a per-fragment cost.
        const suffix = Buffer.from(buffer.subarray(newlineIndex + 1));
        // Drop the original pre-READY buffer and its backing storage now. The
        // gate keeps only the retained suffix as `pending`. This clear also
        // covers the broker handoff and the replay disposal. Both run later and
        // read no buffer bytes.
        buffer = READINESS_EMPTY_BUFFER;
        storage = READINESS_EMPTY_BUFFER;
        pending = suffix;
        finish({ ok: true });
        return;
      }
      // The line does not decode as a READY frame. A PTY echo line or any other
      // pre-READY noise reaches here. Skip it and keep scanning; the nonce and the
      // strict schema, not the line position, authenticate readiness. Enforce the
      // cap after the advance, so a noise-line flood past the cap fails closed.
      lineStart = newlineIndex + 1;
      scanFrom = newlineIndex + 1;
      if (lineStart > DUPLEX_READINESS_BUFFER_CAP_BYTES) {
        finish({ ok: false, reason: "protocol_contamination" });
        return;
      }
    }
  });

  channel.onExit((exit) => {
    if (exitSink) {
      exitSink(exit);
      return;
    }
    if (readyOk) {
      // The channel exited after READY but before the broker bound. Hold the
      // exit so the broker still learns of the loss.
      pendingExit = exit;
      return;
    }
    finish({ ok: false, reason: "channel_exit" });
  });

  const brokerChannel: CommandManagedDuplexChannel = {
    write: (data: Uint8Array) => channel.write(data),
    onData: (listener: (chunk: Uint8Array) => void) => {
      dataSink = listener;
      if (pending.length > 0) {
        const replay = pending;
        pending = READINESS_EMPTY_BUFFER;
        listener(replay);
        return;
      }
    },
    onExit: (listener: (exit: { exitCode: number | null }) => void) => {
      exitSink = listener;
      if (pendingExit) {
        const exit = pendingExit;
        pendingExit = null;
        listener(exit);
      }
    },
    stop: () => channel.stop(),
    close: () => channel.close(),
  };

  return {
    ready,
    brokerChannel,
    replayOverflowed: () => replayOverflow,
    disposePendingReplay: () => {
      pending = READINESS_EMPTY_BUFFER;
    },
    retainedReadinessBufferLength: () => buffer.length,
  };
}

/**
 * Close a partial duplex channel inside a bounded budget, then stop the child.
 * The host runs this on any readiness failure, so a failed duplex attempt leaves
 * no live provider session before the fallback to the file bridge.
 */
async function closeDuplexChannelWithinBudget(
  channel: CommandManagedDuplexChannel,
  budgetMs: number,
): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    });
    await Promise.race([channel.close().catch(() => undefined), budget]);
    if (timer !== undefined) clearTimeout(timer);
  } catch {
    // Best effort: the stop below still removes the child.
  } finally {
    try {
      channel.stop();
    } catch {
      // The channel is already gone; nothing more to do.
    }
  }
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
  // The deadline for one forward call, in milliseconds. This is the inner budget
  // of the duplex broker's nested budget set. The default is the forward budget
  // in `DEFAULT_DUPLEX_BROKER_BUDGETS` (30 s), so the current behavior does not
  // change when the caller sets no option.
  forwardTimeoutMs?: number | null;
  // The first strict gate for the duplex transport. The host selects duplex only
  // when this is exactly `true` and the resolved capability
  // `duplexCommandStream` is exactly `true`. Any other value of either gate
  // selects the file bridge. The caller reads this from the experimental instance
  // setting `enableSandboxDuplexBridge`. The default is the file bridge.
  // HTTP/2 is the preferred transport. `queue_v1` is the soft-deprecated fallback.
  enableSandboxDuplexBridge?: boolean | null;
  // The deadline for the duplex readiness handshake, in milliseconds. On a
  // timeout the host closes the partial channel and selects the file bridge. The
  // default is `DEFAULT_DUPLEX_READINESS_TIMEOUT_MS`.
  duplexReadinessTimeoutMs?: number | null;
  // Return the current-run parent-context token. The factory threads it into the
  // callback bridge worker, which reads it per request so each request
  // `sandbox.exec` span parents to the live run span. When it is absent, the
  // request work runs with an empty store, exactly like the earlier behavior.
  getRuntimeParentContext?: () => StartupSpanContext | undefined;
  // Wrap each callback request in a `sandbox.callbackBridge.relayRequest` span.
  // The factory threads it into the worker, which uses it per request so each
  // request's execs group under one wrapper span. When it is absent, the request
  // work runs under the run parent with no wrapper span.
  runtimeSpan?: RuntimeSpanRunner;
  // The injected recorder for the fixed duplex observability surface. The factory
  // binds it to a provider-scoped telemetry facade, which records the channel-open
  // span, the request span, the guarded counters, and the transport event. The
  // default is a no-op recorder, so the surface stays inert until the host injects
  // a real recorder.
  duplexObservabilityRecorder?: DuplexObservabilityRecorder | null;
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
  // The forward budget for one relayed request. It stays at the broker's default
  // forward budget (30 s) when the caller sets no option, so current behavior
  // does not change.
  const forwardTimeoutMs = input.forwardTimeoutMs ?? DEFAULT_DUPLEX_BROKER_BUDGETS.forwardTimeoutMs;

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
  // The bridge worker runs inside the same process that serves the Paperclip
  // API, so forwarded sandbox calls must target the LOCAL listen origin. The
  // PAPERCLIP_RUNTIME_API_URL / PAPERCLIP_API_URL exports now prefer a
  // configured public base URL, which is the origin browsers and external
  // agents use; routing this in-process loopback hop through the network edge
  // breaks deployments whose public origin sits behind a session-gated proxy
  // (every forwarded agent API call is rejected at the edge). Server boot
  // exports PAPERCLIP_LISTEN_HOST / PAPERCLIP_LISTEN_PORT before any run
  // executes, and resolveDefaultPaperclipApiUrl() maps wildcard listen hosts
  // to the loopback address of the same family (0.0.0.0 -> 127.0.0.1,
  // :: -> [::1]), so the fallback is always loopback-reachable.
  // input.hostApiUrl stays available as an explicit override seam.
  const hostApiUrl = input.hostApiUrl?.trim() || resolveDefaultPaperclipApiUrl();
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

  // The provider-scoped telemetry facade for the fixed duplex observability
  // surface. It maps the raw provider key through the allowlist one time, so no
  // raw plugin key reaches a span, a counter, or the event. The default recorder
  // is a no-op, so the facade is inert until the host injects a real recorder.
  const duplexProviderKey =
    "providerKey" in target ? target.providerKey ?? undefined : undefined;
  const duplexObservability = createDuplexObservability({
    recorder: input.duplexObservabilityRecorder ?? undefined,
    providerKey: duplexProviderKey,
    // http2_v1 is the one active non-file transport now; every non-file
    // record this facade produces stamps the `http2` transport value.
    transport: "http2",
  });

  // PAPERCLIP_BRIDGE_DEBUG opts into verbose stdout logs of every bridge proxy
  // request/response. The query string is logged verbatim, so callers who pass
  // auth tokens or other sensitive values as query parameters should be aware
  // those values appear in the host process's stdout when this flag is enabled.
  // Only intended for active debugging in trusted environments.
  const bridgeDebugEnabled = isBridgeDebugEnabled(process.env);

  // One forward of a relayed sandbox request onto the existing Paperclip API
  // path. The forward applies the real host token and the signed run id, so the
  // token replacement and the run attribution stay in one place for both the
  // file bridge and the duplex broker. The sandbox request carries only the
  // bridge token; the real agent token never leaves the host.
  const forwardBridgeRequest = async (
    request: {
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      /** The file bridge passes the whole request body here as one string. */
      body?: string;
    },
    signal?: AbortSignal,
    options?: {
      suppressDebugLog?: boolean;
    },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const method = request.method.trim().toUpperCase() || "GET";
    // The per-request debug log prints the method, the path, and the query. The
    // duplex path suppresses it, so no route or query rides a log line there. The
    // file path keeps the existing behavior.
    const emitDebugLog = bridgeDebugEnabled && options?.suppressDebugLog !== true;
    if (emitDebugLog) {
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
    // Abort the forward when the caller aborts the request (its per-iteration
    // timeout or watchdog fired, or the broker's forward budget ended), or after
    // the forward budget here, whichever comes first.
    const timeoutSignal = AbortSignal.timeout(forwardTimeoutMs);
    const forwardSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    // Build the request-body init. A GET or a HEAD carries no body. The file
    // bridge passes the whole body as one string.
    const forwardInit: RequestInit = {
      method,
      headers,
      signal: forwardSignal,
    };
    if (method !== "GET" && method !== "HEAD" && typeof request.body === "string") {
      forwardInit.body = request.body;
    }
    const response = await fetch(buildBridgeForwardUrl(hostApiUrl, request), forwardInit);
    if (emitDebugLog) {
      await onLog(
        "stdout",
        `[paperclip] Bridge proxy response ${response.status} for ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
      );
    }
    // The host delivered response headers, so the response-body read starts after
    // the host processed the request. A later response-body read failure (a body
    // over the size limit, or a stream read error) needs a classification by
    // method safety. A safe method (GET, HEAD, OPTIONS, TRACE) never changes host
    // state, so a retry cannot double-apply a mutation and the failure stays
    // retryable. A mutating or otherwise unsafe method may have committed on the
    // host, so a retryable status is unsafe: it makes the caller repeat the
    // request with a new request id outside the broker deduplication set, and the
    // host applies the mutation twice. For an unsafe method the code returns a
    // non-retryable 504 and marks the outcome indeterminate, exactly like an
    // aborted in-flight forward. The in-sandbox server maps the indeterminate 504
    // to a non-retryable 409 for both the file bridge and the duplex broker.
    let responseBody: string;
    try {
      responseBody = await readBridgeForwardResponseBody(response, maxBodyBytes);
    } catch (error) {
      if (isSafeBridgeMethod(method)) {
        // The method is safe, so a retry cannot double-apply a mutation. Return a
        // retryable 502 with no indeterminate marker, so the gateway passes it
        // through as a retryable status.
        return {
          status: 502,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      return {
        status: 504,
        headers: {
          "content-type": "application/json",
          "x-paperclip-bridge-outcome": "indeterminate",
        },
        body: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          outcome: "indeterminate",
          retryable: false,
        }),
      };
    }
    const commentMarker = postedIssueCommentLogMarker(method, request.path, response.status, responseBody);
    if (commentMarker) await onLog("stdout", commentMarker);
    return {
      status: response.status,
      headers: buildBridgeResponseHeaders(response),
      body: responseBody,
    };
  };

  // Two strict gates guard the duplex transport. Select duplex only when the
  // experimental setting is exactly `true`, the resolved capability
  // `duplexCommandStream` is exactly `true`, and the runner exposes the duplex
  // channel. Any other value of either gate selects the file bridge below.
  // HTTP/2 is the preferred transport. `queue_v1` is the soft-deprecated fallback.
  const duplexRequested = input.enableSandboxDuplexBridge === true;
  const capabilityGranted =
    "effectiveCapabilities" in target &&
    target.effectiveCapabilities?.duplexCommandStream === true;
  const openDuplexChannel = runner.openDuplexChannel?.bind(runner);
  // Record the pre-attempt fallback for a file-bridge selection that opens no
  // channel. `gate_off` marks the kill switch off; `capability_absent` marks the
  // capability or the runner method absent. A later channel-open failure records
  // its own fallback through the channel-open attempt below.
  if (!duplexRequested) {
    duplexObservability.recordFallback("gate_off");
  } else if (!capabilityGranted || typeof openDuplexChannel !== "function") {
    duplexObservability.recordFallback("capability_absent");
  }
  if (duplexRequested && capabilityGranted && typeof openDuplexChannel === "function") {
    // Begin the channel-open attempt. The block reports exactly one terminal:
    // `ready` on success, or `fallback(reason)` on an open or a readiness failure.
    const duplexChannelOpen = duplexObservability.startChannelOpen();
    const readinessTimeoutMs =
      typeof input.duplexReadinessTimeoutMs === "number" &&
      Number.isFinite(input.duplexReadinessTimeoutMs) &&
      input.duplexReadinessTimeoutMs > 0
        ? Math.trunc(input.duplexReadinessTimeoutMs)
        : DEFAULT_DUPLEX_READINESS_TIMEOUT_MS;

    // The host assigns the loopback port before it opens the channel. It passes
    // the port and one random per-open nonce to the gateway only through the
    // launch environment. It builds the sandbox-facing origin from its own
    // stored port. No field of any channel frame contributes to the endpoint.
    //
    // Provider-boundary rationale (a security-review condition): the Daytona SDK
    // surface the plugin uses (`sandbox.process` sessions, PTY, and exec;
    // `sandbox.fs`) exposes no listener identity that the provider control plane
    // binds to a launched process. No channel-supplied address can be attested,
    // so this design uses zero channel-supplied addressing data. The only actor
    // that can pre-bind the host-assigned loopback port before the agent starts
    // is the provider itself, which already delivers the agent launch
    // environment. The gateway bind-or-exit contract fails closed. This is an
    // accepted provider-untrusted residual, not endpoint authentication: the
    // nonce is a liveness signal, because a compromised channel can read the
    // launch environment; the endpoint stays safe because it never derives from
    // the channel.
    const assignedPort = await reserveHostAssignedLoopbackPort();
    const nonce = randomBytes(16).toString("hex");
    const sandboxOrigin = `http://127.0.0.1:${assignedPort}`;

    let channel: CommandManagedDuplexChannel | null = null;
    // The open runs two stages under one try: the entrypoint sync, then the
    // channel open. The stage names the exact open-failure outcome in the catch.
    let openStage: "entrypoint_sync" | "channel_open" = "entrypoint_sync";
    try {
      const assetSync = await syncSandboxCallbackBridgeEntrypoint({
        runner,
        remoteCwd: target.remoteCwd,
        assetRemoteDir,
        bridgeAsset,
        timeoutMs: bridgeTimeoutMs,
        shellCommand,
      });
      const gatewayEnv: Record<string, string> = {
        PAPERCLIP_API_BRIDGE_MODE: SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE,
        PAPERCLIP_BRIDGE_TOKEN: bridgeToken,
        PAPERCLIP_BRIDGE_HOST: "127.0.0.1",
        PAPERCLIP_BRIDGE_PORT: String(assignedPort),
        PAPERCLIP_BRIDGE_NONCE: nonce,
        PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(maxBodyBytes),
      };
      const command = buildDuplexGatewayLaunchArgv({
        shellCommand,
        remoteEntrypoint: assetSync.remoteEntrypoint,
        env: gatewayEnv,
      });
      openStage = "channel_open";
      channel = await openDuplexChannel({ command });
    } catch (error) {
      // The channel never opened, so no request could carry the bridge token.
      // The open call is the last statement of the try, so `channel` is still
      // null here; there is nothing to close. Fall through to the file bridge
      // below. Bind and keep the caught error, so the fallback names the exact
      // open-failure stage: a full process-scoped route ceiling is `route_busy`;
      // otherwise the stage is the entrypoint sync or the channel open. The log
      // line names only the fixed stage enum, so no raw provider error rides a log
      // line on the duplex path.
      const reason: DuplexFallbackReason = isDuplexRouteBusyError(error)
        ? "route_busy"
        : openStage === "entrypoint_sync"
          ? "entrypoint_sync_failed"
          : "channel_open_failed";
      duplexChannelOpen.fallback(reason);
      await onLog(
        "stderr",
        `[paperclip] Could not open the sandbox duplex channel (${reason}). Using the file bridge.\n`,
      );
      channel = null;
    }

    if (channel) {
      const gate = createDuplexReadinessGate(channel, {
        nonce,
        timeoutMs: readinessTimeoutMs,
      });
      const readiness = await gate.ready;
      if (!readiness.ok) {
        // Fail closed. Close the partial channel inside a bounded budget, then
        // select the file bridge. The broker never started, so no request that
        // carries the bridge token reached the channel or any endpoint. The reason
        // is a fixed enum, so it rides the log line and the fallback telemetry
        // with no raw value.
        gate.disposePendingReplay();
        await closeDuplexChannelWithinBudget(channel, DEFAULT_DUPLEX_CLEANUP_BUDGET_MS);
        duplexChannelOpen.fallback(duplexReadinessFallbackReason(readiness.reason));
        await onLog(
          "stderr",
          `[paperclip] Sandbox duplex readiness failed (${readiness.reason}). Using the file bridge.\n`,
        );
      } else {
        // Readiness passed. The gate retained every byte that followed the
        // accepted READY line. Scan those retained bytes for the HTTP/2
        // client connection preface — the scan window opens only now, after
        // the gate accepted the nonce — and start the HTTP/2 session at that
        // offset, inclusive. A missing preface inside the bounded readiness
        // buffer aborts the open; the run falls back to `queue_v1` exactly
        // one time (accepted security fix 6).
        const openedChannel = channel;
        const prefaceScan = scanForHttp2ClientPreface(gate.brokerChannel, {
          capBytes: DUPLEX_READINESS_BUFFER_CAP_BYTES,
          timeoutMs: readinessTimeoutMs,
        });
        const prefaceResult = await prefaceScan.settled;
        if (prefaceResult === "missing") {
          // Fail closed, the same shape as a readiness failure: close the
          // partial channel inside the cleanup budget, then select the file
          // bridge. No HTTP/2 server ever bound to this channel, so no
          // request reached it or any endpoint.
          gate.disposePendingReplay();
          await closeDuplexChannelWithinBudget(openedChannel, DEFAULT_DUPLEX_CLEANUP_BUDGET_MS);
          duplexChannelOpen.fallback("preface_missing");
          await onLog(
            "stderr",
            "[paperclip] Sandbox HTTP/2 client preface did not appear inside the bounded readiness buffer (preface_missing). Using the file bridge.\n",
          );
        } else {
          // The run disposition latch for the http2_v1 path, in the same
          // shape the retired duplex_v1 broker exposed. A loss ordered before
          // an orderly completion reports a failure with the typed loss
          // reason; every other state reports a success.
          const dispositionLatch = createHttp2RunDispositionLatch();
          // Set before the first await inside the forward handler, so a loss
          // that lands mid-request still classifies as `post_dispatch`.
          let anyStreamDispatched = false;

          const recordHttp2Loss = (event: Http2TelemetryEventName): void => {
            const reason = mapHttp2EventToDuplexLossReason(event);
            const disposedNow = dispositionLatch.recordLoss(reason);
            if (!disposedNow && (reason === "provider_exit" || reason === "transport_closed")) {
              // A clean channel end that orders after a host-observed orderly
              // completion is a normal teardown, not a loss: the run already
              // completed. Emit no loss telemetry and no log line for it, the
              // same policy the retired duplex_v1 broker applied.
              return;
            }
            const lossClass = anyStreamDispatched ? "post_dispatch" : "pre_dispatch";
            duplexObservability.recordLoss(lossClass, reason);
            void onLog("stderr", `[paperclip] Sandbox HTTP/2 channel lost (${reason}). The run fails.\n`);
          };

          // The forward handler applies the real host token and the run id
          // through the existing `forwardBridgeRequest` — the same function
          // the file bridge uses. The route allowlist, the header allowlist,
          // and the per-request debug-log suppression already ran inside
          // `createHttp2BridgeServer`'s own stream handler before this call.
          // It records the request span with the same latency-and-outcome
          // shape the retired duplex_v1 broker recorded: `ok` for any
          // delivered host response (any status), `error` only when the
          // forward call itself throws.
          const http2ForwardRequest: Http2BridgeForwardHandler = async (request) => {
            anyStreamDispatched = true;
            const dispatchStartMs = Date.now();
            try {
              const result = await forwardBridgeRequest(
                {
                  method: request.method,
                  path: request.pathname,
                  query: request.query,
                  headers: request.headers,
                  body: request.body.toString("utf8"),
                },
                request.signal,
                { suppressDebugLog: true },
              );
              duplexObservability.recordRequest({ latencyMs: Date.now() - dispatchStartMs, outcome: "ok" });
              return { status: result.status, headers: result.headers, body: result.body };
            } catch (error) {
              duplexObservability.recordRequest({ latencyMs: Date.now() - dispatchStartMs, outcome: "error" });
              throw error;
            }
          };

          const http2Server = createHttp2BridgeServer({
            bridgeToken,
            forwardRequest: http2ForwardRequest,
            onGoaway: () => recordHttp2Loss("session_goaway"),
            onSessionError: () => recordHttp2Loss("session_error"),
          });
          // Combine the loss hook with the forward-to-Duplex handoff inside
          // one `onExit` registration: the channel primitive holds exactly
          // one listener slot, and `bindChannel` below registers the one that
          // ends the wrapped `Duplex`.
          //
          // This object's `stop()` is also the real sandbox-side effect of
          // the post-bind read backpressure bound `bindChannel` applies
          // (`wrapDuplexChannelAsNodeDuplex` in `http2-bridge-server.ts`):
          // this raw provider channel exposes no pause, so once the bounded
          // read queue there overflows, it calls `stop()` through this exact
          // chain, down to `prefaceScan.scanned.stop()` and on to the real
          // channel, instead of letting sandbox-controlled bytes grow host
          // memory with no bound.
          const channelForHttp2Server: CommandManagedDuplexChannel = {
            write: (data: Uint8Array) => prefaceScan.scanned.write(data),
            onData: (listener: (chunk: Uint8Array) => void) => prefaceScan.scanned.onData(listener),
            onExit: (listener: (exit: { exitCode: number | null }) => void) => {
              prefaceScan.scanned.onExit((exit) => {
                recordHttp2Loss("channel_exit");
                listener(exit);
              });
            },
            stop: () => prefaceScan.scanned.stop(),
            close: () => prefaceScan.scanned.close(),
          };
          const boundDuplex = http2Server.bindChannel(channelForHttp2Server);
          // Also catches the `Duplex` this wrapper destroys when the bounded
          // read backpressure queue overflows post-bind, so that loss still
          // reaches `recordHttp2Loss` the same way any other write fault does.
          boundDuplex.on("error", () => recordHttp2Loss("write_error"));

          duplexChannelOpen.ready();
          await onLog(
            "stdout",
            "[paperclip] Sandbox HTTP/2 transport ready; serving the host-assigned origin.\n",
          );
          // Stream run logs on the http2 path with the same gate and the same
          // log line as the file path. The http2 path starts no file-bridge
          // worker, so create the log directory before the tail starts.
          let duplexRunLogTail: SandboxRunLogTailFactory | null = null;
          if (target.transport === "sandbox" && target.streamRunLogs !== false) {
            const duplexLogsDir = sandboxCallbackBridgeDirectories(queueDir).logsDir;
            await ensureSandboxRunLogDirectory({
              runner,
              remoteCwd: target.remoteCwd,
              logsDir: duplexLogsDir,
              shellCommand,
              timeoutMs: bridgeTimeoutMs,
            });
            duplexRunLogTail = createSandboxRunLogTailFactory({
              runner,
              remoteCwd: target.remoteCwd,
              logsDir: duplexLogsDir,
              shellCommand,
            });
            await onLog("stdout", "[paperclip] Sandbox run log streaming enabled for this run.\n");
          }
          return {
            env: {
              PAPERCLIP_API_URL: sandboxOrigin,
              PAPERCLIP_API_KEY: bridgeToken,
              PAPERCLIP_API_BRIDGE_MODE: SANDBOX_CALLBACK_BRIDGE_HTTP2_MODE,
            },
            runLogTail: duplexRunLogTail,
            readRunDisposition: (): DuplexBrokerRunDisposition => dispositionLatch.disposition,
            // Atomically read the latch and mark the orderly completion for the
            // ACP success-eligible terminal, so no await separates the read from
            // the mark and a teardown loss cannot slip in between.
            settleRunDisposition: (): DuplexBrokerRunDisposition => dispositionLatch.settleRunDisposition(),
            markOrderlyCompletion: (): void => dispositionLatch.markOrderlyCompletion(),
            stop: async () => {
              // Close the HTTP/2 server's sessions, then the channel, before
              // lease release, so no live provider session remains when the
              // caller releases the lease.
              await http2Server.close();
              await closeDuplexChannelWithinBudget(openedChannel, DEFAULT_DUPLEX_CLEANUP_BUDGET_MS);
              await bridgeAsset.cleanup();
            },
          };
        }
      }
    }
  }

  let server: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | null = null;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | null = null;
  try {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: target.remoteCwd,
      timeoutMs: bridgeTimeoutMs,
      shellCommand,
    });
    // `startSandboxCallbackBridgeWorker` keeps its awaited queue-directory
    // setup on the active `bridge.paperclip` step, and runs each request under
    // the run parent context (see `runWithRuntimeParent` inside that function).
    // So the startup `mkdir` execs stay parented to the step, and every later
    // request `sandbox.exec` span parents to the live run span.
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      maxBodyBytes,
      getRuntimeParentContext: input.getRuntimeParentContext,
      runtimeSpan: input.runtimeSpan,
      handleRequest: async (request, options) => forwardBridgeRequest(request, options?.signal),
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
