import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
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

function stateBase(): string {
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
  const base = stateBase();
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

export function verifyNativeHarnessBackupStamp(
  value: unknown,
  expectedProviderLeaseId: string,
): boolean {
  if (!expectedProviderLeaseId) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
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
    !stamp.manifestSha256.startsWith("sha256:")
  )
    return false;
  const root = stateRootFromDigest(stamp.sessionScopeSha256);
  if (!root || !isRealDirectory(root)) return false;
  const backupRoot = resolve(root, "failover-backups");
  for (const candidate of [
    resolve(backupRoot, "current"),
    resolve(backupRoot, "previous"),
  ]) {
    const manifestPath = resolve(candidate, "manifest.json");
    if (!isRealDirectory(candidate) || !isRealFile(manifestPath)) continue;
    try {
      const bytes = readFileSync(manifestPath);
      const manifestSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (manifestSha256 !== stamp.manifestSha256) continue;
      const manifest = JSON.parse(bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      if (
        manifest.schema !== "paperclip.native-harness-backup.v1" ||
        manifest.normalizedSessionId !== stamp.normalizedSessionId ||
        manifest.runnerInstanceId !== stamp.runnerInstanceId ||
        manifest.sourceProviderLeaseId !== stamp.sourceProviderLeaseId ||
        !Array.isArray(manifest.directories) ||
        manifest.directories.length === 0
      )
        continue;
      let valid = true;
      for (const entry of manifest.directories) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          valid = false;
          break;
        }
        const declared = entry as Record<string, unknown>;
        if (
          typeof declared.name !== "string" ||
          !/^[A-Za-z0-9._-]+$/.test(declared.name) ||
          typeof declared.sha256 !== "string" ||
          typeof declared.bytes !== "number"
        ) {
          valid = false;
          break;
        }
        const directory = resolve(candidate, declared.name);
        if (!isRealDirectory(directory)) {
          valid = false;
          break;
        }
        const actual = digestDirectory(directory);
        if (
          actual.sha256 !== declared.sha256 ||
          actual.bytes !== declared.bytes
        ) {
          valid = false;
          break;
        }
      }
      if (valid) return true;
    } catch {
      // Try the previous atomically-published backup.
    }
  }
  return false;
}
