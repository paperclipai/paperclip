/**
 * Resolve which package manager installs runtime Paperclip plugins.
 *
 * `plugin install` used to hardcode `npm install --prefix … --ignore-scripts`.
 * That breaks npm 12 (EALLOWSCRIPTS) and ignores Bun even when the operator
 * runs the CLI via bun.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Owner-only default for new prefix `.npmrc` files that may hold registry credentials. */
export const DEFAULT_NPMRC_MODE = 0o600;

export type PluginPackageManager = "bun" | "npm";

export type PluginInstallPlan = {
  command: string;
  args: string[];
  manager: PluginPackageManager;
};

function isRunnableFile(candidate: string): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function commandOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const dir of pathEnv.split(sep)) {
    const cleaned = dir.replace(/^["']|["']$/g, "");
    if (!cleaned) continue;
    for (const ext of exts) {
      if (isRunnableFile(path.join(cleaned, bin + ext))) return true;
    }
  }
  return false;
}

function npmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Choose bun when requested or when bun is on PATH; otherwise npm.
 * Override with PAPERCLIP_PLUGIN_PACKAGE_MANAGER=bun|npm.
 */
export function resolvePluginPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  which: (bin: string) => boolean = commandOnPath,
): PluginPackageManager {
  const raw = (env.PAPERCLIP_PLUGIN_PACKAGE_MANAGER ?? "").trim().toLowerCase();
  if (raw === "npm") return "npm";
  if (raw === "bun") return "bun";
  if (which("bun")) return "bun";
  return "npm";
}

export function assertSafePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`invalid plugin spec: ${spec}`);
  }
  return trimmed;
}

export function pluginInstallChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase().replace(/-/g, "_") === "npm_config_ignore_scripts") {
      delete out[key];
    }
  }
  return out;
}

export function planPluginInstall(
  spec: string,
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
  which: (bin: string) => boolean = commandOnPath,
): PluginInstallPlan {
  const safeSpec = assertSafePluginSpec(spec);
  const manager = resolvePluginPackageManager(env, which);
  if (manager === "bun") {
    return {
      manager,
      command: "bun",
      args: ["add", "--cwd", prefix, "--ignore-scripts", "--", safeSpec],
    };
  }
  // npm 12 rejects --ignore-scripts on project-scoped installs (EALLOWSCRIPTS).
  // Prefer a prefix .npmrc `ignore-scripts=true` written by the caller.
  // Put the spec after `--` so a leading-dash token cannot become CLI config.
  return {
    manager,
    command: npmBin(),
    args: ["install", "--prefix", prefix, "--save", "--", safeSpec],
  };
}

export const NPMRC_IGNORE_SCRIPTS = "ignore-scripts=true\n";

/** Keep existing prefix .npmrc keys; force every ignore-scripts assignment to true.
 * npm uses the last duplicate key, so rewriting only the first line is not enough.
 */
export function mergeIgnoreScriptsNpmrc(existing: string): string {
  const text = existing.replace(/\r\n/g, "\n");
  const without = text
    .split("\n")
    .filter((line) => !/^ignore-scripts\s*=/i.test(line.trim()))
    .join("\n")
    .replace(/\s+$/g, "");
  return (without ? without + "\n" : "") + NPMRC_IGNORE_SCRIPTS;
}

/**
 * Read the existing target mode, or `undefined` when the path is missing.
 * Non-ENOENT stat failures propagate so we fail closed instead of replacing
 * a credential file with a weaker umask-derived mode.
 */
async function existingFileMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Replace `filePath` by writing a sibling temp file, then renaming over the
 * live path. A crash during the temp write cannot truncate existing contents.
 *
 * The replacement inode copies the existing file mode (e.g. 0600 for
 * registry credentials). New files default to {@link DEFAULT_NPMRC_MODE}.
 * `chmod` is applied on the temp path before rename so umask cannot widen
 * the mode across the swap.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const mode = (await existingFileMode(filePath)) ?? DEFAULT_NPMRC_MODE;
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx", mode });
    // writeFile creation modes are umask-masked; chmod applies the exact mode.
    await chmod(tempPath, mode);
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Force `ignore-scripts=true` in the plugin-prefix `.npmrc` without replacing
 * registry/auth/proxy keys. The write is atomic so a crash cannot leave an
 * empty or partial shared config, and existing file modes (e.g. 0600) are
 * preserved so credentials stay owner-only.
 */
export async function ensureIgnoreScriptsNpmrc(prefixDir: string): Promise<void> {
  const npmrcPath = path.join(prefixDir, ".npmrc");
  let existing = "";
  try {
    existing = await readFile(npmrcPath, "utf8");
  } catch (err) {
    // Only treat missing files as empty. Other read failures (EACCES,
    // EISDIR, etc.) must not wipe registry/auth/proxy settings on write.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  await writeFileAtomic(npmrcPath, mergeIgnoreScriptsNpmrc(existing));
}
