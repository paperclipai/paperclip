/**
 * Resolve which package manager installs runtime Paperclip plugins.
 *
 * `plugin install` used to hardcode `npm install --prefix … --ignore-scripts`.
 * That breaks npm 12 (EALLOWSCRIPTS) and ignores Bun even when the operator
 * runs the CLI via bun.
 */
import { statSync } from "node:fs";
import path from "node:path";

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
