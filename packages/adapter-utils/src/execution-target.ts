import path from "node:path";
import type { SshRemoteExecutionSpec } from "./ssh.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import {
  buildRemoteExecutionSessionIdentity,
  prepareRemoteManagedRuntime,
  remoteExecutionSessionMatches,
  type RemoteManagedRuntimeAsset,
} from "./remote-managed-runtime.js";
import { parseSshRemoteExecutionSpec, runSshCommand, shellQuote } from "./ssh.js";
import {
  ensureCommandResolvable,
  resolveCommandForLogs,
  runChildProcess,
  type RunProcessResult,
  type TerminalResultCleanupOptions,
} from "./server-utils.js";

export interface AdapterLocalExecutionTarget {
  kind: "local";
  environmentId?: string | null;
  leaseId?: string | null;
}

export interface AdapterSshExecutionTarget {
  kind: "remote";
  transport: "ssh";
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  paperclipApiUrl?: string | null;
  spec: SshRemoteExecutionSpec;
}

export interface AdapterSandboxExecutionTarget {
  kind: "remote";
  transport: "sandbox";
  providerKey?: string | null;
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  paperclipApiUrl?: string | null;
  timeoutMs?: number | null;
  runner?: CommandManagedRuntimeRunner;
}

export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterSshExecutionTarget
  | AdapterSandboxExecutionTarget;

export type AdapterRemoteExecutionSpec = SshRemoteExecutionSpec;

export type AdapterManagedRuntimeAsset = RemoteManagedRuntimeAsset;

export interface PreparedAdapterExecutionTargetRuntime {
  target: AdapterExecutionTarget;
  runtimeRootDir: string | null;
  assetDirs: Record<string, string>;
  restoreWorkspace(): Promise<void>;
}

export interface AdapterExecutionTargetProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  terminalResultCleanup?: TerminalResultCleanupOptions;
}

export interface AdapterExecutionTargetShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

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

export function adapterExecutionTargetPaperclipApiUrl(
  target: AdapterExecutionTarget | null | undefined,
): string | null {
  if (target?.kind !== "remote") return null;
  if (target.transport === "ssh") return target.paperclipApiUrl ?? target.spec.paperclipApiUrl ?? null;
  return target.paperclipApiUrl ?? null;
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

function requireSandboxRunner(target: AdapterSandboxExecutionTarget): CommandManagedRuntimeRunner {
  if (target.runner) return target.runner;
  throw new Error(
    "Sandbox execution target is missing its provider runtime runner. Sandbox commands must execute through the environment runtime.",
  );
}

export async function ensureAdapterExecutionTargetCommandResolvable(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return;
  }
  await ensureCommandResolvable(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
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
    return await runner.execute({
      command,
      args,
      cwd: target.remoteCwd,
      env: options.env,
      stdin: options.stdin,
      timeoutMs: options.timeoutSec > 0 ? options.timeoutSec * 1000 : target.timeoutMs ?? undefined,
      onLog: options.onLog,
      onSpawn: options.onSpawn
        ? async (meta) => options.onSpawn?.({ ...meta, processGroupId: null })
        : undefined,
    });
  }

  return await runChildProcess(runId, command, args, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    timeoutSec: options.timeoutSec,
    graceSec: options.graceSec,
    onLog: options.onLog,
    onSpawn: options.onSpawn,
    terminalResultCleanup: options.terminalResultCleanup,
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
    if (target.transport === "ssh") {
      try {
        const result = await runSshCommand(target.spec, `sh -lc ${shellQuote(command)}`, {
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

    return await requireSandboxRunner(target).execute({
      command: "sh",
      args: ["-lc", command],
      cwd: target.remoteCwd,
      env: options.env,
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
    ...(target.paperclipApiUrl ? { paperclipApiUrl: target.paperclipApiUrl } : {}),
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
    readStringMeta(parsedSaved, "remoteCwd") === current?.remoteCwd &&
    readStringMeta(parsedSaved, "paperclipApiUrl") === (current?.paperclipApiUrl ?? null)
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
      paperclipApiUrl: readStringMeta(parsed, "paperclipApiUrl") ?? spec.paperclipApiUrl ?? null,
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
      paperclipApiUrl: readStringMeta(parsed, "paperclipApiUrl"),
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : null,
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
      paperclipApiUrl: ssh.paperclipApiUrl ?? null,
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
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: AdapterManagedRuntimeAsset[];
  installCommand?: string | null;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  const target = input.target ?? { kind: "local" as const };
  if (target.kind === "local") {
    return {
      target,
      runtimeRootDir: null,
      assetDirs: {},
      restoreWorkspace: async () => {},
    };
  }

  if (target.transport === "ssh") {
    const prepared = await prepareRemoteManagedRuntime({
      spec: target.spec,
      adapterKey: input.adapterKey,
      workspaceLocalDir: input.workspaceLocalDir,
      assets: input.assets,
    });
    return {
      target,
      runtimeRootDir: prepared.runtimeRootDir,
      assetDirs: prepared.assetDirs,
      restoreWorkspace: prepared.restoreWorkspace,
    };
  }

  const prepared = await prepareCommandManagedRuntime({
    runner: requireSandboxRunner(target),
    spec: {
      providerKey: target.providerKey,
      leaseId: target.leaseId,
      remoteCwd: target.remoteCwd,
      timeoutMs: target.timeoutMs,
      paperclipApiUrl: target.paperclipApiUrl,
    },
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceExclude: input.workspaceExclude,
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
    installCommand: input.installCommand,
  });
  return {
    target,
    runtimeRootDir: prepared.runtimeRootDir,
    assetDirs: prepared.assetDirs,
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
