import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export interface NativeHarnessBackupStamp {
  schema: "paperclip.native-harness-backup-stamp.v1";
  normalizedSessionId: string;
  runnerInstanceId: string;
  manifestSha256: string;
  completedAt: string;
}

function stateRoot(normalizedSessionId: string): string {
  return resolve(
    process.env.PAPERCLIP_RUNNER_STATE_DIR
      ?? resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "durable-sessions"),
    createHash("sha256").update(normalizedSessionId).digest("hex"),
  );
}

function digestDirectory(directory: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = (current: string, relative: string) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
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
        hash.update(`file:${relativePath}:${stats.mode & 0o777}:${contents.byteLength}\0`);
        hash.update(contents);
      } else {
        throw new Error(`runner_harness_backup_unsupported_entry:${relativePath}`);
      }
    }
  };
  visit(directory, "");
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

export function createNativeHarnessBackupStamp(input: {
  manifestPath: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  completedAt: string;
}): NativeHarnessBackupStamp {
  const manifestBytes = readFileSync(input.manifestPath);
  return {
    schema: "paperclip.native-harness-backup-stamp.v1",
    normalizedSessionId: input.normalizedSessionId,
    runnerInstanceId: input.runnerInstanceId,
    manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    completedAt: input.completedAt,
  };
}

export function verifyNativeHarnessBackupStamp(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stamp = value as Record<string, unknown>;
  if (
    stamp.schema !== "paperclip.native-harness-backup-stamp.v1" ||
    typeof stamp.normalizedSessionId !== "string" || !stamp.normalizedSessionId ||
    typeof stamp.runnerInstanceId !== "string" || !stamp.runnerInstanceId ||
    typeof stamp.manifestSha256 !== "string" || !stamp.manifestSha256.startsWith("sha256:")
  ) return false;
  const backupRoot = resolve(stateRoot(stamp.normalizedSessionId), "failover-backups");
  for (const candidate of [resolve(backupRoot, "current"), resolve(backupRoot, "previous")]) {
    const manifestPath = resolve(candidate, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const bytes = readFileSync(manifestPath);
      const manifestSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (manifestSha256 !== stamp.manifestSha256) continue;
      const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (
        manifest.schema !== "paperclip.native-harness-backup.v1" ||
        manifest.normalizedSessionId !== stamp.normalizedSessionId ||
        manifest.runnerInstanceId !== stamp.runnerInstanceId ||
        !Array.isArray(manifest.directories) ||
        manifest.directories.length === 0
      ) continue;
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
        if (!existsSync(directory)) {
          valid = false;
          break;
        }
        const actual = digestDirectory(directory);
        if (actual.sha256 !== declared.sha256 || actual.bytes !== declared.bytes) {
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
