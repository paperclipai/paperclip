import path from "node:path";
import {
  prepareSandboxManagedRuntime,
  type PreparedSandboxManagedRuntime,
  type SandboxManagedRuntimeAsset,
  type SandboxManagedRuntimeClient,
  type SandboxRemoteExecutionSpec,
} from "./sandbox-managed-runtime.js";
import { preferredShellForSandbox } from "./sandbox-shell.js";
import type { RunProcessResult } from "./server-utils.js";

export interface CommandManagedRuntimeRunner {
  execute(input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }): Promise<RunProcessResult>;
}

export interface CommandManagedRuntimeSpec {
  providerKey?: string | null;
  shellCommand?: "bash" | "sh" | null;
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
}

export type CommandManagedRuntimeAsset = SandboxManagedRuntimeAsset;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function mergeRuntimeExcludes(entries: string[] | undefined): string[] {
  return [...new Set([".paperclip-runtime", ...(entries ?? [])])];
}

const REMOTE_WRITE_BASE64_CHUNK_SIZE = 32 * 1024;

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireSuccessfulResult(result: RunProcessResult, action: string): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? `: ${stderr}` : "";
  throw new Error(`${action} failed with exit code ${result.exitCode ?? "null"}${detail}`);
}

export function createCommandManagedRuntimeClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs: number;
  shellCommand?: "bash" | "sh" | null;
}): SandboxManagedRuntimeClient {
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runShell = async (script: string, opts: { stdin?: string; timeoutMs?: number } = {}) => {
    const result = await input.runner.execute({
      command: shellCommand,
      args: ["-lc", script],
      cwd: input.remoteCwd,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? input.timeoutMs,
    });
    requireSuccessfulResult(result, script);
    return result;
  };

  return {
    makeDir: async (remotePath) => {
      await runShell(`mkdir -p ${shellQuote(remotePath)}`);
    },
    writeFile: async (remotePath, bytes) => {
      const body = toBuffer(bytes).toString("base64");
      const remoteDir = path.posix.dirname(remotePath);
      const remoteTempPath = `${remotePath}.paperclip-upload.b64`;

      await runShell(
        `mkdir -p ${shellQuote(remoteDir)} && rm -f ${shellQuote(remoteTempPath)} && : > ${shellQuote(remoteTempPath)}`,
      );
      for (let offset = 0; offset < body.length; offset += REMOTE_WRITE_BASE64_CHUNK_SIZE) {
        const chunk = body.slice(offset, offset + REMOTE_WRITE_BASE64_CHUNK_SIZE);
        await runShell(`printf '%s' ${shellQuote(chunk)} >> ${shellQuote(remoteTempPath)}`);
      }
      await runShell(
        `base64 -d < ${shellQuote(remoteTempPath)} > ${shellQuote(remotePath)} && rm -f ${shellQuote(remoteTempPath)}`,
      );
    },
    readFile: async (remotePath) => {
      const result = await runShell(`base64 < ${shellQuote(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    },
    listFiles: async (remotePath) => {
      const result = await runShell(
        `if [ -d ${shellQuote(remotePath)} ]; then ` +
          `for entry in ${shellQuote(remotePath)}/*; do ` +
          `[ -f "$entry" ] || continue; ` +
          `basename "$entry"; ` +
          `done; ` +
        `fi`,
      );
      return result.stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    remove: async (remotePath) => {
      const result = await input.runner.execute({
        command: shellCommand,
        args: ["-lc", `rm -rf ${shellQuote(remotePath)}`],
        cwd: input.remoteCwd,
        timeoutMs: input.timeoutMs,
      });
      requireSuccessfulResult(result, `remove ${remotePath}`);
    },
    run: async (command, options) => {
      const result = await input.runner.execute({
        command: shellCommand,
        args: ["-lc", command],
        cwd: input.remoteCwd,
        timeoutMs: options.timeoutMs,
      });
      requireSuccessfulResult(result, command);
    },
  };
}

export async function prepareCommandManagedRuntime(input: {
  runner: CommandManagedRuntimeRunner;
  spec: CommandManagedRuntimeSpec;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: CommandManagedRuntimeAsset[];
  installCommand?: string | null;
  /** When provided alongside `installCommand`, skip the install if `command -v <detectCommand>` succeeds. */
  detectCommand?: string | null;
}): Promise<PreparedSandboxManagedRuntime> {
  const timeoutMs = input.spec.timeoutMs && input.spec.timeoutMs > 0 ? input.spec.timeoutMs : 300_000;
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeSpec: SandboxRemoteExecutionSpec = {
    transport: "sandbox",
    provider: input.spec.providerKey ?? "sandbox",
    sandboxId: input.spec.leaseId ?? "managed",
    remoteCwd: workspaceRemoteDir,
    timeoutMs,
    apiKey: null,
  };
  const client = createCommandManagedRuntimeClient({
    runner: input.runner,
    remoteCwd: workspaceRemoteDir,
    timeoutMs,
    shellCommand: input.spec.shellCommand,
  });
  const shellCommand = preferredShellForSandbox(input.spec.shellCommand);

  if (input.installCommand?.trim()) {
    const installCommand = input.installCommand.trim();
    const detectCommand = input.detectCommand?.trim();
    // Skip the install when the binary is already on PATH. Without this
    // probe the install runs unconditionally on every execute() call (and
    // also runs a second time after `ensureAdapterExecutionTargetCommandResolvable`
    // has already installed it during the resolvability gate).
    if (detectCommand) {
      const probe = await input.runner.execute({
        command: shellCommand,
        args: ["-lc", `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`],
        cwd: workspaceRemoteDir,
        timeoutMs,
      });
      if (!probe.timedOut && (probe.exitCode ?? 1) === 0) {
        return await prepareSandboxManagedRuntime({
          spec: runtimeSpec,
          client,
          adapterKey: input.adapterKey,
          workspaceLocalDir: input.workspaceLocalDir,
          workspaceRemoteDir,
          workspaceExclude: mergeRuntimeExcludes(input.workspaceExclude),
          preserveAbsentOnRestore: input.preserveAbsentOnRestore,
          assets: input.assets,
        });
      }
    }
    const result = await input.runner.execute({
      command: shellCommand,
      args: ["-lc", installCommand],
      cwd: workspaceRemoteDir,
      timeoutMs,
    });
    // A failed install is not always fatal: the CLI may already be on PATH
    // from a previous lease, the template image, or another path entry. Log
    // and continue rather than aborting the agent run; downstream code that
    // exec's the CLI will surface a clear "command not found" if it is in
    // fact missing. The test path's `maybeRunSandboxInstallCommand` already
    // honors this contract — keep them consistent.
    if (result.timedOut || (result.exitCode ?? 0) !== 0) {
      const tail = (text: string) =>
        text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join(" | ").slice(0, 480);
      const reason = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"}`;
      console.warn(
        `[paperclip] managed-runtime install command ${reason}: ${installCommand} :: ${tail(result.stderr || result.stdout)}`,
      );
    }
  }

  return await prepareSandboxManagedRuntime({
    spec: runtimeSpec,
    client,
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    workspaceExclude: mergeRuntimeExcludes(input.workspaceExclude),
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
  });
}
