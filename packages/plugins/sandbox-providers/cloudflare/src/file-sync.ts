import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PluginPostUploadCommand,
  PluginSyncFileMapping,
  PluginSyncOperation,
  PluginEnvironmentSyncResult,
} from "@paperclipai/plugin-sdk";
import { CloudflareBridgeError } from "./bridge-client.js";
import type { CloudflareBridgeExecuteRequest, CloudflareBridgeExecuteResponse } from "./types.js";

const execFileAsync = promisify(execFile);

export const UPLOAD_PART_BYTES = 64 * 1024 * 1024;
export const TRANSFER_ATTEMPTS = 3;
export const TRANSFER_BACKOFF_MS = [1_000, 3_000] as const;

export interface FileSyncBridge {
  downloadFile(input: {
    providerLeaseId: string;
    path: string;
    consume: (body: ReadableStream<Uint8Array>) => Promise<void>;
  }): Promise<void>;
  uploadFile(input: { providerLeaseId: string; path: string; bytes: Uint8Array }): Promise<void>;
  execute(body: CloudflareBridgeExecuteRequest): Promise<CloudflareBridgeExecuteResponse>;
}

export interface FileSyncContext {
  bridge: FileSyncBridge;
  providerLeaseId: string;
  commandCwd: string;
  timeoutMs: number;
  sessionStrategy: CloudflareBridgeExecuteRequest["sessionStrategy"];
  sessionId: string;
  sleep?: (ms: number) => Promise<void>;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertSandboxPath(value: string, label: string): string {
  if (!path.posix.isAbsolute(value) || value.includes("\0") || value.split("/").includes("..")) {
    throw new Error(`Cloudflare sync ${label} is not a confined absolute sandbox path: ${value}`);
  }
  return path.posix.normalize(value);
}

function assertHostPath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Cloudflare sync ${label} is not an absolute host path: ${value}`);
  }
  return path.normalize(value);
}

function isTransientTransferError(error: unknown): boolean {
  if (error instanceof CloudflareBridgeError) {
    return error.status === 429 || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|fetch failed|network|socket|ECONNRESET|overloaded|terminated/i.test(message);
}

async function withTransferRetry<T>(context: FileSyncContext, work: () => Promise<T>): Promise<T> {
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSFER_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === TRANSFER_ATTEMPTS || !isTransientTransferError(error)) throw error;
      await sleep(TRANSFER_BACKOFF_MS[Math.min(attempt - 1, TRANSFER_BACKOFF_MS.length - 1)]!);
    }
  }
  throw lastError;
}

async function runSandboxCommand(
  context: FileSyncContext,
  script: string,
  options: { cwd?: string; timeoutMs?: number; label: string },
): Promise<void> {
  const result = await context.bridge.execute({
    providerLeaseId: context.providerLeaseId,
    command: "sh",
    args: ["-c", script],
    cwd: options.cwd ?? context.commandCwd,
    timeoutMs: options.timeoutMs ?? context.timeoutMs,
    sessionStrategy: context.sessionStrategy,
    sessionId: context.sessionId,
  });
  if (result.timedOut) {
    throw new Error(`Cloudflare sync ${options.label} timed out.`);
  }
  if (result.exitCode !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(-2_000);
    throw new Error(`Cloudflare sync ${options.label} failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
}

async function runRepeatableSandboxCommand(
  context: FileSyncContext,
  script: string,
  options: { cwd?: string; timeoutMs?: number; label: string },
): Promise<void> {
  await withTransferRetry(context, () => runSandboxCommand(context, script, options));
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Cloudflare sync could not write the downloaded bytes to the host.");
    offset += bytesWritten;
  }
}

async function bestEffortRemove(context: FileSyncContext, remotePaths: string[]): Promise<void> {
  if (remotePaths.length === 0) return;
  await runSandboxCommand(context, `rm -f -- ${remotePaths.map(shellQuote).join(" ")}`, { label: "cleanup" }).catch(
    () => undefined,
  );
}

async function withHostTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cloudflare-sync-"));
  try {
    return await work(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadToHostFile(
  context: FileSyncContext,
  remotePath: string,
  hostPath: string,
  mode: number | undefined,
): Promise<number> {
  const staging = `${hostPath}.paperclip-download.${randomUUID()}`;
  try {
    const bytes = await withTransferRetry(context, async () => {
      const handle = await fs.open(staging, "w", 0o600);
      let written = 0;
      try {
        await context.bridge.downloadFile({
          providerLeaseId: context.providerLeaseId,
          path: remotePath,
          consume: async (body) => {
            const reader = body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                await writeFully(handle, value);
                written += value.byteLength;
              }
            }
          },
        });
      } finally {
        await handle.close();
      }
      return written;
    });
    if (mode != null) await fs.chmod(staging, mode & 0o7777);
    await fs.rename(staging, hostPath);
    return bytes;
  } finally {
    await fs.rm(staging, { force: true }).catch(() => undefined);
  }
}

async function uploadHostFile(context: FileSyncContext, hostPath: string, remotePath: string): Promise<number> {
  const stat = await fs.stat(hostPath);
  if (!stat.isFile()) throw new Error(`Cloudflare sync source is not a regular file: ${hostPath}`);
  const total = stat.size;
  const handle = await fs.open(hostPath, "r");
  const readPart = async (offset: number): Promise<Uint8Array> => {
    const length = Math.min(UPLOAD_PART_BYTES, total - offset);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) throw new Error(`Cloudflare sync source changed while uploading: ${hostPath}`);
      filled += bytesRead;
    }
    return buffer;
  };
  try {
    const token = randomUUID();
    const staging = `${remotePath}.paperclip-upload.${token}`;
    if (total <= UPLOAD_PART_BYTES) {
      const bytes = await readPart(0);
      try {
        await withTransferRetry(context, () =>
          context.bridge.uploadFile({ providerLeaseId: context.providerLeaseId, path: staging, bytes }),
        );
        await runRepeatableSandboxCommand(context, `mv -f ${shellQuote(staging)} ${shellQuote(remotePath)}`, {
          label: "upload commit",
        });
      } catch (error) {
        await bestEffortRemove(context, [staging]);
        throw error;
      }
      return total;
    }
    const parts: string[] = [];
    try {
      for (let offset = 0, index = 0; offset < total; offset += UPLOAD_PART_BYTES, index += 1) {
        const partPath = `${remotePath}.paperclip-part.${token}.${index}`;
        parts.push(partPath);
        const bytes = await readPart(offset);
        await withTransferRetry(context, () =>
          context.bridge.uploadFile({ providerLeaseId: context.providerLeaseId, path: partPath, bytes }),
        );
      }
      await runRepeatableSandboxCommand(
        context,
        `cat ${parts.map(shellQuote).join(" ")} > ${shellQuote(staging)} && mv -f ${shellQuote(staging)} ${shellQuote(remotePath)}`,
        { label: "upload assembly" },
      );
      return total;
    } finally {
      await bestEffortRemove(context, [...parts, staging]);
    }
  } finally {
    await handle.close();
  }
}

function tarExcludeArgs(exclude: string[] | undefined): string[] {
  return ["._*", ...(exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
}

async function createHostTarball(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<void> {
  const list = `${input.archivePath}.entries`;
  const entries = await fs.readdir(input.localDir);
  await fs.writeFile(list, entries.map((entry) => `${entry}\0`).join(""), { mode: 0o600 });
  try {
    await execFileAsync(
      "tar",
      [
        "-c",
        "--no-xattrs",
        ...(input.followSymlinks ? ["-h"] : []),
        "-f",
        input.archivePath,
        "-C",
        input.localDir,
        ...tarExcludeArgs(input.exclude),
        "--null",
        "-T",
        list,
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 32 * 1024 * 1024 },
    );
  } finally {
    await fs.rm(list, { force: true }).catch(() => undefined);
  }
}

export function buildRemoteTarCommand(input: {
  sourceDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): string {
  const list = `${input.archivePath}.entries`;
  const excludes = ["._*", ...(input.exclude ?? [])].map((entry) => `--exclude ${shellQuote(entry)}`).join(" ");
  return [
    `cd ${shellQuote(input.sourceDir)}`,
    `find . -mindepth 1 -maxdepth 1 -print0 > ${shellQuote(list)}`,
    `tar -c --no-xattrs ${input.followSymlinks ? "-h " : ""}-f ${shellQuote(input.archivePath)} ${excludes} --null -T ${shellQuote(list)}`,
    `rm -f -- ${shellQuote(list)}`,
  ].join(" && ");
}

export function buildRemoteExtractCommand(input: { archivePath: string; targetDir: string }): string {
  return [
    `rm -rf ${shellQuote(input.targetDir)}`,
    `mkdir -p ${shellQuote(input.targetDir)}`,
    `tar -xf ${shellQuote(input.archivePath)} -C ${shellQuote(input.targetDir)}`,
    `rm -f ${shellQuote(input.archivePath)}`,
  ].join(" && ");
}

async function syncOutMapping(context: FileSyncContext, mapping: PluginSyncFileMapping): Promise<number> {
  const source = assertSandboxPath(mapping.sourcePath, "source");
  const target = assertHostPath(mapping.targetPath, "target");
  if (mapping.kind === "file") {
    await fs.mkdir(path.dirname(target), { recursive: true });
    return await downloadToHostFile(context, source, target, mapping.mode);
  }
  const remoteArchive = `/tmp/.paperclip-sync-out-${randomUUID()}.tar`;
  try {
    await runRepeatableSandboxCommand(
      context,
      buildRemoteTarCommand({
        sourceDir: source,
        archivePath: remoteArchive,
        exclude: mapping.exclude,
        followSymlinks: mapping.followSymlinks,
      }),
      { label: "archive" },
    );
    return await withHostTempDir(async (dir) => {
      const localArchive = path.join(dir, "sync-out.tar");
      const bytes = await downloadToHostFile(context, remoteArchive, localArchive, undefined);
      await fs.mkdir(target, { recursive: true });
      await execFileAsync("tar", ["-xf", localArchive, "-C", target], { maxBuffer: 32 * 1024 * 1024 });
      if (mapping.mode != null) await fs.chmod(target, mapping.mode & 0o7777);
      return bytes;
    });
  } finally {
    await bestEffortRemove(context, [remoteArchive, `${remoteArchive}.entries`]);
  }
}

async function syncInMapping(context: FileSyncContext, mapping: PluginSyncFileMapping): Promise<number> {
  const source = assertHostPath(mapping.sourcePath, "source");
  const target = assertSandboxPath(mapping.targetPath, "target");
  if (mapping.kind === "file") {
    const bytes = await uploadHostFile(context, source, target);
    if (mapping.mode != null) {
      await runSandboxCommand(context, `chmod ${(mapping.mode & 0o7777).toString(8)} ${shellQuote(target)}`, {
        label: "chmod",
      });
    }
    return bytes;
  }
  return await withHostTempDir(async (dir) => {
    const localArchive = path.join(dir, "sync-in.tar");
    await createHostTarball({
      localDir: source,
      archivePath: localArchive,
      exclude: mapping.exclude,
      followSymlinks: mapping.followSymlinks,
    });
    const remoteArchive = `${target}.paperclip-syncin.tar.${randomUUID()}`;
    try {
      const bytes = await uploadHostFile(context, localArchive, remoteArchive);
      await runSandboxCommand(context, buildRemoteExtractCommand({ archivePath: remoteArchive, targetDir: target }), {
        label: "extract",
      });
      return bytes;
    } finally {
      await bestEffortRemove(context, [remoteArchive]);
    }
  });
}

async function runPostUploadCommands(context: FileSyncContext, commands: PluginPostUploadCommand[]): Promise<void> {
  for (const command of commands) {
    if (command.cwd != null) assertSandboxPath(command.cwd, "post-upload cwd");
    await runSandboxCommand(context, command.command, {
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      label: "post-upload command",
    });
  }
}

export async function performSyncOut(
  context: FileSyncContext,
  operations: PluginSyncOperation[],
): Promise<PluginEnvironmentSyncResult> {
  const results: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of operations) {
    let bytesTransferred = 0;
    for (const mapping of operation.files) {
      bytesTransferred += await syncOutMapping(context, mapping);
    }
    results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
  }
  return { operations: results };
}

export async function performSyncIn(
  context: FileSyncContext,
  operations: PluginSyncOperation[],
): Promise<PluginEnvironmentSyncResult> {
  const results: PluginEnvironmentSyncResult["operations"] = [];
  for (const operation of operations) {
    let bytesTransferred = 0;
    for (const mapping of operation.files) {
      bytesTransferred += await syncInMapping(context, mapping);
    }
    await runPostUploadCommands(context, operation.postUploadCommands ?? []);
    results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
  }
  return { operations: results };
}
