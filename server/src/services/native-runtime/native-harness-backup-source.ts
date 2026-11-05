import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Only filesystem inspection can produce this error. Database failures must
 * retain their identity, even if their class or code resembles a source error. */
export class NativeHarnessBackupSourceError extends Error {}

/** Wrap input reads individually, so archive output and database errors never
 * become deferrable just because they share a filesystem error code. */
export async function readNativeHarnessBackupSourceInput<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
      throw new NativeHarnessBackupSourceError("native_harness_migration_source_unavailable", { cause: error });
    }
    throw error;
  }
}

export async function readNativeHarnessBackupSource(root: string) {
  try {
    const stat = await readNativeHarnessBackupSourceInput(() => lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    }));
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeHarnessBackupSourceError("native_harness_migration_unsafe_source");
    const manifestBytes = await readNativeHarnessBackupSourceInput(() => readFile(join(root, "manifest.json")));
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const state: unknown = JSON.parse(await readNativeHarnessBackupSourceInput(() => readFile(join(root, "runner", "runner-state.json"), "utf8")));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || !state || typeof state !== "object" || Array.isArray(state)) {
      throw new NativeHarnessBackupSourceError("native_harness_migration_source_unsettled");
    }
    return { manifestBytes, manifest: manifest as Record<string, unknown>, state: state as Record<string, unknown> };
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeHarnessBackupSourceError("native_harness_migration_source_invalid_json", { cause: error });
    throw error;
  }
}
