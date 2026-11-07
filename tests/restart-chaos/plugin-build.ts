/**
 * The bundled Daytona plugin lives outside the pnpm workspace, so workspace
 * builds and `agent-preflight` never rebuild it. A worktree that moves to a new
 * master would otherwise keep serving the plugin built for an older commit,
 * and plugin-side fixes would silently go untested.
 *
 * The build is keyed by a content hash of the plugin's inputs, recorded next
 * to its output.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const PLUGIN_BUILD_STAMP = "dist/.restart-chaos-build-input.sha256";
const INPUT_FILES = ["package.json", "pnpm-lock.yaml", "tsconfig.json"];
const INPUT_DIRECTORIES = ["src"];

function listFiles(root: string, relative: string): string[] {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(root, child);
    return entry.isFile() ? [child] : [];
  });
}

/** sha256 over the plugin's build inputs: paths and contents, in sorted order. */
export function pluginBuildInputHash(pluginRoot: string, extraInputs: readonly string[] = []): string {
  const hash = createHash("sha256");
  const files = [...INPUT_FILES.filter(file => existsSync(path.join(pluginRoot, file))),
    ...INPUT_DIRECTORIES.flatMap(directory => listFiles(pluginRoot, directory))].sort();
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(path.join(pluginRoot, file)));
    hash.update("\0");
  }
  // Inputs outside the plugin directory (for example the linked plugin SDK) are hashed as given.
  for (const extra of [...extraInputs].sort()) {
    hash.update(`extra:${extra}\0`);
    for (const file of statSync(extra, { throwIfNoEntry: false })?.isDirectory() ? listFiles(extra, "").sort() : [""]) {
      const absolute = file ? path.join(extra, file) : extra;
      if (!existsSync(absolute)) continue;
      hash.update(`${file}\0`);
      hash.update(readFileSync(absolute));
    }
  }
  return hash.digest("hex");
}

export interface PluginBuildState { needsInstall: boolean; needsBuild: boolean; inputHash: string; reason: string }

/** Whether the installed and built plugin matches its current sources. */
export function pluginBuildState(pluginRoot: string, extraInputs: readonly string[] = []): PluginBuildState {
  const inputHash = pluginBuildInputHash(pluginRoot, extraInputs);
  const needsInstall = !existsSync(path.join(pluginRoot, "node_modules/@daytonaio/sdk"));
  const outputs = ["dist/manifest.js", "dist/worker.js"].every(file => existsSync(path.join(pluginRoot, file)));
  const stamp = existsSync(path.join(pluginRoot, PLUGIN_BUILD_STAMP))
    ? readFileSync(path.join(pluginRoot, PLUGIN_BUILD_STAMP), "utf8").trim() : null;
  const reason = needsInstall ? "dependencies missing" : !outputs ? "build output missing"
    : stamp === null ? "build was not stamped with its inputs" : stamp !== inputHash ? "plugin sources changed since the last build" : "up to date";
  return { needsInstall, needsBuild: reason !== "up to date", inputHash, reason };
}
