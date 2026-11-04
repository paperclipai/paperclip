import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { MAX_NATIVE_HARNESS_BYTES, MAX_NATIVE_HARNESS_ENTRIES } from "./native-harness-backup-archive.js";
import { dirname, resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export interface NativeHarnessBackupStamp {
  schema: "paperclip.native-harness-backup-stamp.v2";
  normalizedSessionId: string;
  runnerInstanceId: string;
  sessionScopeSha256: string;
  sourceProviderLeaseId: string;
  authorizedProviderLeaseId: string;
  manifestSha256: string;
  completedAt: string;
}

export function nativeHarnessStateBase(): string {
  return resolve(
    process.env.PAPERCLIP_RUNNER_STATE_DIR ??
      resolve(
        resolvePaperclipInstanceRoot(),
        "runtime",
        "paperclip-runner",
        "durable-sessions",
      ),
  );
}

function stateRootFromDigest(digest: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  const base = nativeHarnessStateBase();
  const root = resolve(base, digest);
  return dirname(root) === base ? root : null;
}

function isRealDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function digestDirectory(directory: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = (current: string, relative: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (entries.length === 0) hash.update(`directory:${relative}\0`);
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const stats = lstatSync(path);
      if (entry.isDirectory()) {
        hash.update(`directory:${relativePath}:${stats.mode & 0o777}\0`);
        visit(path, relativePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink:${relativePath}:${readlinkSync(path)}\0`);
      } else if (entry.isFile()) {
        const contents = readFileSync(path);
        bytes += contents.byteLength;
        hash.update(
          `file:${relativePath}:${stats.mode & 0o777}:${contents.byteLength}\0`,
        );
        hash.update(contents);
      } else {
        throw new Error(
          `runner_harness_backup_unsupported_entry:${relativePath}`,
        );
      }
    }
  };
  visit(directory, "");
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

export function createNativeHarnessBackupStamp(input: {
  manifestPath: string;
  sessionScopeId: string;
  authorizedProviderLeaseId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  completedAt: string;
}): NativeHarnessBackupStamp {
  if (!input.authorizedProviderLeaseId) {
    throw new Error("runner_harness_backup_lease_missing");
  }
  const sessionScopeSha256 = createHash("sha256")
    .update(input.sessionScopeId)
    .digest("hex");
  const root = stateRootFromDigest(sessionScopeSha256);
  if (!root || !isRealDirectory(root)) {
    throw new Error("runner_harness_backup_scope_invalid");
  }
  const resolvedManifestPath = resolve(input.manifestPath);
  const allowedManifestPaths = ["current", "previous"].map((candidate) =>
    resolve(root, "failover-backups", candidate, "manifest.json"),
  );
  if (
    !allowedManifestPaths.includes(resolvedManifestPath) ||
    !isRealDirectory(dirname(resolvedManifestPath)) ||
    !isRealFile(resolvedManifestPath)
  ) {
    throw new Error("runner_harness_backup_scope_invalid");
  }
  const manifestBytes = readFileSync(input.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (
    manifest.schema !== "paperclip.native-harness-backup.v1" ||
    manifest.normalizedSessionId !== input.normalizedSessionId ||
    manifest.runnerInstanceId !== input.runnerInstanceId ||
    manifest.completedAt !== input.completedAt ||
    typeof manifest.sourceProviderLeaseId !== "string" ||
    !manifest.sourceProviderLeaseId
  ) {
    throw new Error("runner_harness_backup_scope_invalid");
  }
  return {
    schema: "paperclip.native-harness-backup-stamp.v2",
    normalizedSessionId: input.normalizedSessionId,
    runnerInstanceId: input.runnerInstanceId,
    sessionScopeSha256,
    sourceProviderLeaseId: manifest.sourceProviderLeaseId,
    authorizedProviderLeaseId: input.authorizedProviderLeaseId,
    manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    completedAt: input.completedAt,
  };
}

export function readNativeHarnessBackupStamp(
  value: unknown,
  expectedProviderLeaseId: string,
): NativeHarnessBackupStamp | null {
  if (!expectedProviderLeaseId) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stamp = value as Record<string, unknown>;
  if (
    stamp.schema !== "paperclip.native-harness-backup-stamp.v2" ||
    typeof stamp.normalizedSessionId !== "string" ||
    !stamp.normalizedSessionId ||
    typeof stamp.runnerInstanceId !== "string" ||
    !stamp.runnerInstanceId ||
    typeof stamp.sessionScopeSha256 !== "string" ||
    typeof stamp.sourceProviderLeaseId !== "string" ||
    !stamp.sourceProviderLeaseId ||
    stamp.authorizedProviderLeaseId !== expectedProviderLeaseId ||
    typeof stamp.manifestSha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(stamp.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(stamp.sessionScopeSha256) ||
    typeof stamp.completedAt !== "string" || !Number.isFinite(Date.parse(stamp.completedAt))
  )
    return null;
  return stamp as unknown as NativeHarnessBackupStamp;
}

function matchingBackupDirectories(candidate: string, stamp: NativeHarnessBackupStamp): Array<{ path: string; sha256: string; bytes: number }> | null {
  const manifestPath = resolve(candidate, "manifest.json");
  if (!isRealDirectory(candidate) || !isRealFile(manifestPath) || lstatSync(manifestPath).size > 4 * 1024 * 1024) return null;
  const bytes = readFileSync(manifestPath);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== stamp.manifestSha256) return null;
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema !== "paperclip.native-harness-backup.v1" || manifest.normalizedSessionId !== stamp.normalizedSessionId
    || manifest.runnerInstanceId !== stamp.runnerInstanceId || manifest.sourceProviderLeaseId !== stamp.sourceProviderLeaseId
    || !Array.isArray(manifest.directories) || manifest.directories.length === 0) return null;
  const directories: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const entry of manifest.directories) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string"
      || !/^[A-Za-z0-9._-]+$/.test(entry.name) || [".", ".."].includes(entry.name)
      || typeof entry.sha256 !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
    const path = resolve(candidate, entry.name);
    if (!isRealDirectory(path)) return null;
    directories.push({ path, sha256: entry.sha256, bytes: entry.bytes });
  }
  return directories;
}

function backupCandidates(stamp: NativeHarnessBackupStamp) {
  const root = stateRootFromDigest(stamp.sessionScopeSha256);
  return !root || !isRealDirectory(root) ? [] : ["current", "previous"].map(name => resolve(root, "failover-backups", name));
}

export function verifyNativeHarnessBackupStamp(value: unknown, expectedProviderLeaseId: string): boolean {
  const stamp = readNativeHarnessBackupStamp(value, expectedProviderLeaseId);
  if (!stamp) return false;
  for (const candidate of backupCandidates(stamp)) {
    try {
      const directories = matchingBackupDirectories(candidate, stamp);
      if (directories?.every(directory => {
        const actual = digestDirectory(directory.path);
        return actual.sha256 === directory.sha256 && actual.bytes === directory.bytes;
      })) return true;
    } catch {}
  }
  return false;
}

export async function verifyNativeHarnessBackupStampAsync(value: unknown, expectedProviderLeaseId: string, signal: AbortSignal): Promise<boolean> {
  const stamp = readNativeHarnessBackupStamp(value, expectedProviderLeaseId);
  if (!stamp) return false;
  for (const candidate of backupCandidates(stamp)) {
    signal.throwIfAborted();
    try {
      const directories = matchingBackupDirectories(candidate, stamp);
      if (!directories || directories.reduce((total, entry) => total + entry.bytes, 0) > MAX_NATIVE_HARNESS_BYTES) continue;
      let valid = true, count = 0;
      for (const directory of directories) {
        const hash = createHash("sha256"); let bytes = 0;
        const visit = async (current: string, relative: string): Promise<void> => {
          signal.throwIfAborted();
          const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          if (!entries.length) hash.update(`directory:${relative}\0`);
          for (const entry of entries) {
            if (++count > MAX_NATIVE_HARNESS_ENTRIES) throw new Error("native_harness_backup_entry_limit");
            const path = resolve(current, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
            const stats = await lstat(path);
            if (stats.isDirectory()) { hash.update(`directory:${name}:${stats.mode & 0o777}\0`); await visit(path, name); }
            else if (stats.isSymbolicLink()) hash.update(`symlink:${name}:${await readlink(path)}\0`);
            else if (stats.isFile()) {
              hash.update(`file:${name}:${stats.mode & 0o777}:${stats.size}\0`);
              const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const before = await handle.stat();
                if (!before.isFile() || stats.ino !== before.ino || stats.dev !== before.dev || stats.size !== before.size) throw new Error("native_harness_backup_source_changed");
                for await (const chunk of handle.createReadStream({ signal, autoClose: false })) {
                  bytes += chunk.length; if (bytes > directory.bytes) throw new Error("native_harness_backup_size_mismatch"); hash.update(chunk);
                }
                const after = await handle.stat();
                if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("native_harness_backup_source_changed");
              } finally { await handle.close(); }
            } else throw new Error("native_harness_backup_unsupported_entry");
          }
        };
        await visit(directory.path, "");
        if (`sha256:${hash.digest("hex")}` !== directory.sha256 || bytes !== directory.bytes) { valid = false; break; }
      }
      if (valid) return true;
    } catch { signal.throwIfAborted(); }
  }
  return false;
}
