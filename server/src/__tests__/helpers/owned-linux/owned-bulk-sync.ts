// PRIVATE UNRUN fixture transfer over an exact owned bind mount, not Docker cp
// or base64-over-exec. The normal SDK mapping/ordered-command contract remains.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream, constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { PluginEnvironmentSyncResult, PluginSyncOperation } from "@paperclipai/plugin-sdk";

interface TransferScope {
  remoteRoot: string;
  hostLeaseRoot: string;
  readableHostRoots: readonly string[];
  readableHostFiles: ReadonlySet<string>;
  writableHostRoot: string;
  assertCurrentLease(): Promise<void>;
  execute(command: { command: string; cwd: string; timeoutMs?: number }): Promise<{ exitCode: number | null; timedOut: boolean }>;
}
const inside = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
const deny = () => new Error("owned_sync_scope_denied");
async function noSymlinkParents(root: string, destination: string) {
  if (!inside(root, destination) || await realpath(root) !== root) throw deny();
  if (destination === root) return;
  let current = root;
  for (const component of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch(async error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw deny();
  }
  try { const stat = await lstat(destination); if (stat.isSymbolicLink()) throw deny(); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}
export async function transferOwnedMappings(scope: TransferScope, operations: readonly PluginSyncOperation[], direction: "in" | "out"): Promise<PluginEnvironmentSyncResult> {
  await scope.assertCurrentLease();
  if (await realpath(scope.hostLeaseRoot) !== scope.hostLeaseRoot || await realpath(scope.writableHostRoot) !== scope.writableHostRoot) throw deny();
  const mapped = (value: string) => {
    if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || !inside(scope.remoteRoot, value)) throw deny();
    return path.join(scope.hostLeaseRoot, path.posix.relative(scope.remoteRoot, value));
  };
  const result: PluginEnvironmentSyncResult = { operations: [] };
  for (const operation of operations) {
    let filesTransferred = 0, bytesTransferred = 0, visited = 0;
    const copy = async (source: string, destination: string, destinationRoot: string, mode?: number): Promise<void> => {
      if (++visited > 10000) throw new Error("owned_sync_inventory_overflow");
      const stat = await lstat(source); if (stat.isSymbolicLink()) throw deny();
      await noSymlinkParents(destinationRoot, destination);
      if (stat.isDirectory()) {
        await mkdir(destination, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
        const target = await lstat(destination); if (!target.isDirectory() || target.isSymbolicLink()) throw deny();
        for (const child of await readdir(source)) await copy(path.join(source, child), path.join(destination, child), destinationRoot);
        if (mode !== undefined) await chmod(destination, mode);
        return;
      }
      if (!stat.isFile()) throw deny();
      // Bounded accounting protects the fixture, not a product quota assertion.
      if (bytesTransferred + stat.size > 512 * 1024 * 1024) throw new Error("owned_sync_byte_overflow");
      const temporary = path.join(path.dirname(destination), ".sync-" + randomUUID());
      try {
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await pipeline(input.createReadStream(),
            createWriteStream(temporary, { flags: "wx", mode: mode ?? (stat.mode & 0o777) }));
        } finally {
          await input.close();
        }
        await rename(temporary, destination);
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      filesTransferred++; bytesTransferred += stat.size;
    };
    for (const mapping of operation.files) {
      if (mapping.mode !== undefined && (!Number.isInteger(mapping.mode) || mapping.mode < 0 || mapping.mode > 0o777)) throw deny();
      const source = direction === "in" ? mapping.sourcePath : mapped(mapping.sourcePath);
      const destination = direction === "in" ? mapped(mapping.targetPath) : mapping.targetPath;
      const sourceReal = await realpath(source);
      if (sourceReal !== source) throw deny();
      if (direction === "in" && !scope.readableHostFiles.has(source)
          && !scope.readableHostRoots.some(root => inside(root, source))) throw deny();
      if (direction === "out" && !inside(scope.writableHostRoot, destination)) throw deny();
      const stat = await lstat(source);
      if (mapping.kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw deny();
      await copy(source, destination, direction === "in" ? scope.hostLeaseRoot : scope.writableHostRoot, mapping.mode);
    }
    for (const command of operation.postUploadCommands ?? []) {
      if (direction !== "in") throw new Error("owned_sync_out_commands_denied");
      const cwd = command.cwd ?? scope.remoteRoot; mapped(cwd); // revalidate actual target confinement
      await scope.assertCurrentLease();
      const exit = await scope.execute({ ...command, cwd });
      if (exit.exitCode !== 0 || exit.timedOut) throw new Error("owned_sync_post_upload_failed");
    }
    result.operations.push({ operationId: operation.operationId, filesTransferred, bytesTransferred });
  }
  await scope.assertCurrentLease(); return result;
}
