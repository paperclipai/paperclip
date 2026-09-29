import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { assertNoPendingLegacyMigration } from "../../vendor/paperclip-runner/index.js";

function schema(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("native_indexed_locator_unsafe");
    // Large files are legacy checkpoints, never indexed locators.
    if (stat.size > 8192) return "legacy";
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("native_indexed_locator_changed");
      offset += count;
    }
    const after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("native_indexed_locator_changed");
    const value = JSON.parse(bytes.toString("utf8")) as { schema?: string };
    if (value.schema?.includes("indexed.v1") || value.schema === "paperclip.runner.authority-locator.v1") {
      if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error("native_indexed_locator_unsafe");
    }
    return value.schema ?? "legacy";
  } finally { closeSync(fd); }
}

/** The rollout flag controls fresh format selection, never retained recovery. */
export function useIndexedNativeAuthority(directory: string, enableFresh: boolean): boolean {
  assertNoPendingLegacyMigration(directory);
  const controller = schema(resolve(directory, "control-plane-state.json"));
  if (controller !== null) return controller === "paperclip.runner.authority-locator.v1";
  const provider = schema(resolve(directory, "../runner/codex-provider-state.json"));
  if (provider !== null) return provider === "paperclip.runner.codex-provider-state.indexed.v1";
  const runner = schema(resolve(directory, "../runner/runner-state.json"));
  if (runner !== null) return runner === "paperclip.runner.durable.state.indexed.v1";
  return enableFresh;
}
