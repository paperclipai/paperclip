import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const SHIM_FILES = ["parse.mjs", "shim-entry.mjs"] as const;
const SHIMMED_TOOLS = ["gh", "git"] as const;

export interface LeakCheckShimSetup {
  /** Absolute path to the shim dir to prepend to PATH. */
  shimDir: string;
  /** Absolute path to the resolved leak-check.sh script. */
  scriptPath: string;
  /** Cleanup hook — removes the shim dir. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

export interface LeakCheckShimRequest {
  runId: string;
  /** Resolved abs path to the company policies/leak-check.sh. */
  scriptPath: string;
  /** Whether to honor --allow-leak-OK (requires approved board override). */
  allowOverride?: boolean;
}

/**
 * Build a temp directory containing executable `gh` and `git` bash wrappers
 * that forward through the leak-check shim. The directory should be
 * prepended to PATH for the child process.
 *
 * The shim-entry .mjs is copied from a fixed location relative to this
 * module so the spawned shim does not depend on the package's source tree
 * layout at runtime.
 *
 * NOTE: this writes a brand-new dir per run for clean concurrency. Multiple
 * agents on the same host get distinct shim dirs.
 */
export async function prepareLeakCheckShimDir(
  request: LeakCheckShimRequest,
): Promise<LeakCheckShimSetup> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-leak-check-${safeForFilename(request.runId)}-`));
  try {
    await materializeShimAssets(tmpRoot);
    await writeWrappers(tmpRoot, await locateNodeBinary());
    return {
      shimDir: tmpRoot,
      scriptPath: request.scriptPath,
      cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined),
    };
  } catch (err) {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Resolve the path to the company leak-check.sh script. Returns null if no
 * script exists for the company (meaning leak-check is unconfigured and the
 * shim should be skipped).
 *
 * Convention: <instanceRoot>/companies/<companyId>/policies/leak-check.sh
 */
export async function resolveLeakCheckScript(input: {
  instanceRoot: string;
  companyId: string;
}): Promise<string | null> {
  const candidate = path.resolve(
    input.instanceRoot,
    "companies",
    input.companyId,
    "policies",
    "leak-check.sh",
  );
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return candidate;
  } catch {
    /* fall through */
  }
  return null;
}

/** Internal: copy parse.mjs and shim-entry.mjs into the shim dir. */
async function materializeShimAssets(targetDir: string): Promise<void> {
  for (const asset of SHIM_FILES) {
    const source = path.resolve(__moduleDir, asset);
    const dest = path.resolve(targetDir, asset);
    await fs.copyFile(source, dest);
  }
}

async function writeWrappers(targetDir: string, nodeBin: string): Promise<void> {
  const shimEntry = path.resolve(targetDir, "shim-entry.mjs");
  for (const tool of SHIMMED_TOOLS) {
    const wrapperPath = path.resolve(targetDir, tool);
    const body =
      "#!/usr/bin/env bash\n" +
      "# Paperclip leak-check shim wrapper. Forwards through shim-entry.mjs.\n" +
      `exec ${shellQuoteForBash(nodeBin)} ${shellQuoteForBash(shimEntry)} ${tool} "$@"\n`;
    await fs.writeFile(wrapperPath, body, { mode: 0o755 });
  }
}

async function locateNodeBinary(): Promise<string> {
  if (process.execPath && (await pathExists(process.execPath))) {
    return process.execPath;
  }
  return "node";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function shellQuoteForBash(raw: string): string {
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function safeForFilename(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32) || "run";
}

/**
 * Prepend a shim directory to a PATH-style env value (cross-platform).
 */
export function prependPath(currentPath: string | undefined, shimDir: string): string {
  const sep = process.platform === "win32" ? ";" : ":";
  if (!currentPath || currentPath.length === 0) return shimDir;
  return `${shimDir}${sep}${currentPath}`;
}
