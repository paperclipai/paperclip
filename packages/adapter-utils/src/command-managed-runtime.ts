import path from "node:path";
import {
  prepareSandboxManagedRuntime,
  type PreparedSandboxManagedRuntime,
  type SandboxManagedRuntimeAsset,
  type SandboxManagedRuntimeClient,
  type SandboxRemoteExecutionSpec,
} from "./sandbox-managed-runtime.js";
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
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
  paperclipApiUrl?: string | null;
}

export type CommandManagedRuntimeAsset = SandboxManagedRuntimeAsset;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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

function createCommandManagedRuntimeClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs: number;
}): SandboxManagedRuntimeClient {
  const runShell = async (script: string, opts: { stdin?: string; timeoutMs?: number } = {}) => {
    const result = await input.runner.execute({
      command: "sh",
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
      await runShell(
        `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && base64 -d > ${shellQuote(remotePath)}`,
        { stdin: body },
      );
    },
    readFile: async (remotePath) => {
      const result = await runShell(`base64 < ${shellQuote(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    },
    remove: async (remotePath) => {
      const result = await input.runner.execute({
        command: "sh",
        args: ["-lc", `rm -rf ${shellQuote(remotePath)}`],
        cwd: input.remoteCwd,
        timeoutMs: input.timeoutMs,
      });
      requireSuccessfulResult(result, `remove ${remotePath}`);
    },
    run: async (command, options) => {
      const result = await input.runner.execute({
        command: "sh",
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
    paperclipApiUrl: input.spec.paperclipApiUrl ?? null,
  };
  const client = createCommandManagedRuntimeClient({
    runner: input.runner,
    remoteCwd: workspaceRemoteDir,
    timeoutMs,
  });

  if (input.installCommand?.trim()) {
    const result = await input.runner.execute({
      command: "sh",
      args: ["-lc", input.installCommand.trim()],
      cwd: workspaceRemoteDir,
      timeoutMs,
    });
    requireSuccessfulResult(result, input.installCommand.trim());
  }

  return await prepareSandboxManagedRuntime({
    spec: runtimeSpec,
    client,
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    workspaceExclude: input.workspaceExclude,
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
  });
}
