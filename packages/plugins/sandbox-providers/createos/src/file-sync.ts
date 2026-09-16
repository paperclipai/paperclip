import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { PluginEnvironmentSyncInParams, PluginEnvironmentSyncResult } from "@paperclipai/plugin-sdk";
import { CreateosClient, identifier } from "./client.js";
import { execute, shellQuote } from "./execute.js";

const ROOT = "/paperclip-workspace";

export function assertRemotePath(value: string): void {
  if (!path.posix.isAbsolute(value) || value.includes("\0") || value.split("/").includes("..")) {
    throw new Error("CreateOS transfer requires a confined absolute sandbox path.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) throw new Error("CreateOS transfer path escapes the workspace.");
}

function remoteGuard(candidate: string): string {
  assertRemotePath(candidate);
  // Re-check symlinks inside the sandbox immediately before use. A missing
  // canonicalizer fails the command rather than weakening containment.
  return `root=$(realpath -- ${shellQuote(ROOT)}) && test "$root" = ${shellQuote(ROOT)} && ` +
    `resolved=$(realpath -m -- ${shellQuote(candidate)}) && ` +
    `case "$resolved" in "$root"|"$root"/*) ;; *) exit 1 ;; esac`;
}

export async function validateArchive(file: string): Promise<number> {
  let invalid = false;
  let bytes = 0;
  let files = 0;
  const inside = (entryPath: string) => !path.posix.isAbsolute(entryPath) &&
    !entryPath.split("/").includes("..") && !entryPath.includes("\\") && !entryPath.includes("\0");
  await tar.t({ file, strict: true, onReadEntry(entry) {
    bytes += entry.size;
    if (bytes > 10 * 1024 ** 3 || !inside(entry.path)) invalid = true;
    if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type)) invalid = true;
    if (entry.type === "File" || entry.type === "OldFile") files++;
    if (entry.type === "SymbolicLink" || entry.type === "Link") {
      if (!entry.linkpath) { invalid = true; return; }
      const base = entry.type === "SymbolicLink" ? path.posix.dirname(entry.path) : ".";
      const target = path.posix.normalize(path.posix.join(base, entry.linkpath));
      if (path.posix.isAbsolute(entry.linkpath) || entry.linkpath.includes("\\") || !inside(target)) invalid = true;
    }
  } });
  if (invalid) throw new Error("CreateOS archive contains unsafe entries or exceeds the extraction limit.");
  return files;
}

function excluded(name: string, patterns: string[]): boolean {
  name = name.replace(/^\.\//, "").replace(/\/$/, "");
  return patterns.some((pattern) => [pattern, `${pattern}/**`, `**/${pattern}`, `**/${pattern}/**`]
    .some((glob) => path.matchesGlob(name, glob)));
}

export async function syncFiles(
  client: CreateosClient,
  params: PluginEnvironmentSyncInParams,
  direction: "in" | "out",
  signal: AbortSignal,
): Promise<PluginEnvironmentSyncResult> {
  const id = identifier(params.lease.providerLeaseId);
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  const run = async (command: string, cwd = ROOT, timeoutMs?: number) => {
    assertRemotePath(cwd);
    const result = await execute(client, { ...params, command: "/bin/bash", args: ["-c", command], cwd },
      timeoutMs == null ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    if (result.timedOut || result.exitCode !== 0) throw new Error("CreateOS transfer command failed.");
  };
  const upload = async (local: string, remote: string) => {
    const source = createReadStream(local);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT", body: Readable.toWeb(source) as ReadableStream<Uint8Array>,
        duplex: "half", headers: { "Content-Type": "application/octet-stream" }, signal,
      };
      const response = await client.request(`/sandboxes/${id}/files?path=${encodeURIComponent(remote)}`, init);
      await response.body?.cancel();
    } finally { source.destroy(); }
  };
  const download = async (remote: string, local: string, mode = 0o600) => {
    const response = await client.request(`/sandboxes/${id}/files?path=${encodeURIComponent(remote)}`, { signal });
    if (!response.body) throw new Error("CreateOS file download has no body.");
    await pipeline(response.body, createWriteStream(local, { flags: "wx", mode }), { signal });
  };

  // Validate every mapping before beginning side effects. Host paths are
  // orchestrator-authored and checked by its source/target-root guard.
  for (const operation of params.operations) {
    for (const mapping of operation.files) {
      if (!["file", "directory"].includes(mapping.kind)) throw new Error("Unsupported CreateOS transfer kind.");
      if (!path.isAbsolute(direction === "in" ? mapping.sourcePath : mapping.targetPath)) throw new Error("CreateOS transfer requires an absolute host path.");
      if (mapping.mode != null && (!Number.isInteger(mapping.mode) || mapping.mode < 0 || mapping.mode > 0o777)) throw new Error("Invalid CreateOS file mode.");
      assertRemotePath(direction === "in" ? mapping.targetPath : mapping.sourcePath);
    }
    for (const command of operation.postUploadCommands ?? []) {
      assertRemotePath(command.cwd ?? ROOT);
      if (command.timeoutMs != null && (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 86_400_000)) throw new Error("Invalid CreateOS transfer timeout.");
    }
    if (direction === "out" && operation.postUploadCommands?.length) throw new Error("Outbound CreateOS transfers cannot run post-upload commands.");
  }

  for (const operation of params.operations) {
    let bytesTransferred = 0;
    let filesTransferred = 0;
    for (const mapping of operation.files) {
      signal.throwIfAborted();
      const local = direction === "in" ? mapping.sourcePath : mapping.targetPath;
      const remote = direction === "in" ? mapping.targetPath : mapping.sourcePath;
      const scratch = `/tmp/paperclip-createos-transfer-${randomUUID()}`;
      // Outbound temporary files are on the target filesystem for atomic rename.
      const parent = direction === "out" ? path.dirname(local) : os.tmpdir();
      await fs.mkdir(parent, { recursive: true });
      const temp = await fs.mkdtemp(path.join(parent, ".paperclip-createos-"));
      const transferFile = path.join(temp, "data");
      try {
        if (direction === "in") {
          let source = local;
          if (mapping.kind === "directory") {
            await tar.c({ file: transferFile, cwd: local, follow: mapping.followSymlinks === true,
              filter: (name) => !excluded(name, mapping.exclude ?? []) }, ["."]);
            source = transferFile;
          }
          await upload(source, scratch);
          const mode = mapping.mode ?? (mapping.kind === "file" ? (await fs.stat(source)).mode & 0o777 : 0o755);
          await run(mapping.kind === "file"
            ? `${remoteGuard(remote)} && mkdir -p -- "$(dirname -- "$resolved")" && chmod ${mode.toString(8)} -- ${shellQuote(scratch)} && mv -f -- ${shellQuote(scratch)} "$resolved"`
            : `${remoteGuard(remote)} && mkdir -p -- "$resolved" && tar -xf ${shellQuote(scratch)} -C "$resolved" && chmod ${mode.toString(8)} -- "$resolved"`);
          filesTransferred += mapping.kind === "file" ? 1 : await countArchiveFiles(source);
          bytesTransferred += (await fs.stat(source)).size;
        } else {
          const excludeArgs = (mapping.exclude ?? []).map((pattern) => `--exclude=${shellQuote(pattern)}`).join(" ");
          await run(mapping.kind === "file"
            ? `${remoteGuard(remote)} && test -f "$resolved" && cp -- "$resolved" ${shellQuote(scratch)}`
            : `${remoteGuard(remote)} && test -d "$resolved" && tar ${mapping.followSymlinks ? "-h " : ""}${excludeArgs} -cf ${shellQuote(scratch)} -C "$resolved" .`);
          await download(scratch, transferFile, mapping.mode ?? 0o600);
          bytesTransferred += (await fs.stat(transferFile)).size;
          if (mapping.kind === "file") {
            // Apply exact requested mode before promotion, including under a
            // restrictive umask. Never expose secret bytes at the final path first.
            await fs.chmod(transferFile, mapping.mode ?? 0o600);
            await fs.rename(transferFile, local);
            filesTransferred++;
          } else {
            filesTransferred += await validateArchive(transferFile);
            await fs.mkdir(local, { recursive: true, mode: mapping.mode ?? 0o700 });
            if ((await fs.lstat(local)).isSymbolicLink()) throw new Error("CreateOS archive destination cannot be a symlink.");
            // tar rejects traversal through existing symlink parents. Validate
            // all archive entries first so an unsafe archive never partly lands.
            await tar.x({ file: transferFile, cwd: local, strict: true, preservePaths: false });
            if (mapping.mode != null) await fs.chmod(local, mapping.mode);
          }
        }
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
        await client.json(`/sandboxes/${id}/exec`, "POST", { cmd: "/bin/rm", args: ["-f", "--", scratch] }).catch(() => undefined);
      }
    }
    for (const command of operation.postUploadCommands ?? []) {
      await run(remoteGuard(command.cwd ?? ROOT));
      await run(command.command, command.cwd ?? ROOT, command.timeoutMs);
    }
    operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }
  return { operations };
}

async function countArchiveFiles(file: string): Promise<number> {
  let count = 0;
  await tar.t({ file, onReadEntry(entry) { if (entry.type === "File" || entry.type === "OldFile") count++; } });
  return count;
}
