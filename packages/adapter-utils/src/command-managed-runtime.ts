import path from "node:path";
import {
  prepareSandboxManagedRuntime,
  type PreparedSandboxManagedRuntime,
  type SandboxManagedRuntimeAsset,
  type SandboxManagedRuntimeClient,
  type SandboxRemoteExecutionSpec,
  type SandboxSyncOperation,
  type SandboxSyncResult,
} from "./sandbox-managed-runtime.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import type { RunProcessResult } from "./server-utils.js";
import type { RuntimeProgressSink, RuntimeStatusSink } from "./runtime-progress.js";

export interface CommandManagedRuntimeRunner {
  /**
   * True only when `execute({ stdin })` can surface useful in-flight progress
   * for a single stdin-backed command. Provider-backed sandbox runners usually
   * complete the entire RPC before returning, so they should leave this false
   * and let the caller choose a chunked upload path when progress is requested.
   */
  supportsSingleStreamStdinProgress?: boolean;
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
  /**
   * Optional native inbound file transfer. Present only when the sandbox
   * provider advertises both `environmentSyncIn` and `environmentSyncOut`; the
   * client exposes `syncIn`/`syncOut` only when BOTH are present, so the
   * orchestrator either uses the native path for both directions or falls back
   * to the base64 transport for both.
   */
  syncIn?(operations: SandboxSyncOperation[]): Promise<SandboxSyncResult>;
  /** Optional native outbound file transfer. See {@link syncIn}. */
  syncOut?(operations: SandboxSyncOperation[]): Promise<SandboxSyncResult>;
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

// Largest base64 body we hand to the runner as a single stdin string. Normal
// multi-MB workspace/asset tarballs stay well under this and upload in one
// round-trip; anything larger uses the bounded chunked-append fallback so a
// runaway stdin string can't blow the runner/provider RPC limits.
const REMOTE_WRITE_SINGLE_STREAM_MAX_BASE64_BYTES = 96 * 1024 * 1024;
// Fallback chunk size (base64 bytes). Kept a multiple of 4 so each chunk is a
// self-contained base64 unit that decodes cleanly on its own.
const REMOTE_WRITE_FALLBACK_BASE64_CHUNK_SIZE = 4 * 1024 * 1024;
const REMOTE_WRITE_FALLBACK_DECODED_CHUNK_SIZE = (REMOTE_WRITE_FALLBACK_BASE64_CHUNK_SIZE / 4) * 3;
const REMOTE_READ_CHUNK_BYTES = REMOTE_WRITE_FALLBACK_DECODED_CHUNK_SIZE;

function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const FAILED_COMMAND_OUTPUT_TAIL_CHARS = 4_000;

function formatFailedCommandOutput(result: RunProcessResult): string {
  const tail = (text: string): string => {
    const trimmed = text.trim();
    if (trimmed.length <= FAILED_COMMAND_OUTPUT_TAIL_CHARS) return trimmed;
    return `...[truncated]\n${trimmed.slice(-FAILED_COMMAND_OUTPUT_TAIL_CHARS)}`;
  };
  const stderr = tail(result.stderr);
  const stdout = tail(result.stdout);
  const parts: string[] = [];
  if (stderr.length > 0) parts.push(`stderr: ${stderr}`);
  if (stdout.length > 0) parts.push(`stdout: ${stdout}`);
  return parts.length > 0 ? `:\n${parts.join("\n")}` : "";
}

function requireSuccessfulResult(result: RunProcessResult, action: string): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = formatFailedCommandOutput(result);
  throw new Error(`${action} failed with exit code ${result.exitCode ?? "null"}${detail}`);
}

export function createCommandManagedRuntimeClient(input: {
  runner: CommandManagedRuntimeRunner;
  commandCwd: string;
  timeoutMs: number;
  shellCommand?: "bash" | "sh" | null;
}): SandboxManagedRuntimeClient {
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runShell = async (
    script: string,
    opts: {
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    } = {},
  ) => {
    const result = await input.runner.execute({
      command: shellCommand,
      args: shellCommandArgs(script),
      cwd: input.commandCwd,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? input.timeoutMs,
      onLog: opts.onLog,
    });
    requireSuccessfulResult(result, script);
    return result;
  };

  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => {
      await runShell(`mkdir -p ${shellQuote(remotePath)}`);
    },
    writeFile: async (remotePath, bytes, options) => {
      const buffer = toBuffer(bytes);
      const total = buffer.byteLength;
      const encodedLength = base64EncodedLength(total);
      const remoteDir = path.posix.dirname(remotePath);
      const remoteTempPath = `${remotePath}.paperclip-upload`;
      const canUseSingleStreamProgressPath = input.runner.supportsSingleStreamStdinProgress === true;

      // Primary path: a single round-trip. Stream the entire base64 body to one
      // `base64 -d` process via stdin, decode straight into a temp file, then
      // atomically rename into place. This replaces the previous loop that did
      // one `printf >> tmpfile` shell round-trip per 32 KB — thousands of serial
      // processes for a large workspace — with exactly one process.
      if (
        encodedLength <= REMOTE_WRITE_SINGLE_STREAM_MAX_BASE64_BYTES &&
        canUseSingleStreamProgressPath
      ) {
        const body = buffer.toString("base64");
        await options?.onProgress?.(0, total);
        await runShell(
          `mkdir -p ${shellQuote(remoteDir)} && ` +
            `base64 -d > ${shellQuote(remoteTempPath)} && ` +
            `mv -f ${shellQuote(remoteTempPath)} ${shellQuote(remotePath)}`,
          { stdin: body },
        );
        await options?.onProgress?.(total, total);
        return;
      }

      // Bounded fallback for payloads too large to hand the runner as one stdin
      // string: append the base64 body to a remote temp file in large chunks
      // (orders of magnitude fewer round-trips than the old 32 KB loop), decoding
      // each self-contained chunk on arrival and emitting progress per write,
      // then atomically rename into place.
      await runShell(
        `mkdir -p ${shellQuote(remoteDir)} && ` +
          `rm -f ${shellQuote(remoteTempPath)} && : > ${shellQuote(remoteTempPath)}`,
      );
      for (let offset = 0; offset < total; offset += REMOTE_WRITE_FALLBACK_DECODED_CHUNK_SIZE) {
        const end = Math.min(total, offset + REMOTE_WRITE_FALLBACK_DECODED_CHUNK_SIZE);
        const chunk = buffer.subarray(offset, end).toString("base64");
        await runShell(`base64 -d >> ${shellQuote(remoteTempPath)}`, { stdin: chunk });
        await options?.onProgress?.(end, total);
      }
      await runShell(`mv -f ${shellQuote(remoteTempPath)} ${shellQuote(remotePath)}`);
      await options?.onProgress?.(total, total);
    },
    readFile: async (remotePath, options) => {
      // Chunked reads intentionally query the remote size first, even without
      // a progress sink, so each sandbox RPC stays bounded and truncation is
      // detected without materializing the whole file as one stdout string.
      const sizeResult = await runShell(`wc -c < ${shellQuote(remotePath)}`);
      const totalBytes = Number.parseInt(sizeResult.stdout.trim(), 10);
      if (!Number.isFinite(totalBytes) || totalBytes < 0) {
        throw new Error(`Could not determine remote file size for ${remotePath}`);
      }

      // Read in bounded remote chunks so the runner never has to materialize a
      // single base64 stdout string for the whole archive. The client API still
      // returns the decoded file as a Buffer, but every command result stays
      // small enough for provider-backed sandbox RPCs.
      const decodedChunks: Buffer[] = [];
      let decodedSoFar = 0;
      if (totalBytes === 0) {
        await options?.onProgress?.(0, 0);
        return Buffer.alloc(0);
      }
      for (let chunkIndex = 0; decodedSoFar < totalBytes; chunkIndex++) {
        const result = await runShell(
          `dd if=${shellQuote(remotePath)} bs=${REMOTE_READ_CHUNK_BYTES} skip=${chunkIndex} count=1 2>/dev/null | base64`,
        );
        const chunk = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
        if (chunk.byteLength === 0) break;
        decodedChunks.push(chunk);
        decodedSoFar += chunk.byteLength;
        await options?.onProgress?.(Math.min(decodedSoFar, totalBytes), totalBytes);
      }
      const out = Buffer.concat(decodedChunks);
      if (out.byteLength !== totalBytes) {
        throw new Error(`Remote file read was truncated for ${remotePath}: ${out.byteLength}/${totalBytes} bytes`);
      }
      await options?.onProgress?.(out.byteLength, totalBytes);
      return out;
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
        args: shellCommandArgs(`rm -rf ${shellQuote(remotePath)}`),
        cwd: input.commandCwd,
        timeoutMs: input.timeoutMs,
      });
      requireSuccessfulResult(result, `remove ${remotePath}`);
    },
    run: async (command, options) => {
      const result = await input.runner.execute({
        command: shellCommand,
        args: shellCommandArgs(command),
        cwd: input.commandCwd,
        timeoutMs: options.timeoutMs,
      });
      requireSuccessfulResult(result, command);
    },
  };

  // Expose the native sync capability to the orchestrator only when the runner
  // supports BOTH directions; a provider that advertises just one verb (or
  // neither) keeps the byte-identical base64 fallback for both.
  const { syncIn, syncOut } = input.runner;
  if (syncIn && syncOut) {
    client.syncIn = (operations) => syncIn(operations);
    client.syncOut = (operations) => syncOut(operations);
  }

  return client;
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
  // Upload progress sink. Forwarded to prepareSandboxManagedRuntime; the child
  // task wires it into the byte-counting writeFile/readFile transport.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedSandboxManagedRuntime> {
  const timeoutMs = input.spec.timeoutMs && input.spec.timeoutMs > 0 ? input.spec.timeoutMs : 300_000;
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  // Managed-runtime sync/restore scripts use absolute paths throughout, so
  // run them from a stable cwd. The target workspace itself may be removed or
  // recreated during a run, which breaks shell startup if we chdir into it.
  const commandCwd = "/";
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
    commandCwd,
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
        args: shellCommandArgs(`command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`),
        cwd: commandCwd,
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
          onProgress: input.onProgress,
          onRuntimeProgress: input.onRuntimeProgress,
        });
      }
    }
    const result = await input.runner.execute({
      command: shellCommand,
      args: shellCommandArgs(installCommand),
      cwd: commandCwd,
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
    onProgress: input.onProgress,
    onRuntimeProgress: input.onRuntimeProgress,
  });
}
