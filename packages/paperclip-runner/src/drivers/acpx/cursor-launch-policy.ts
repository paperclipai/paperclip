import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

export const CURSOR_PINNED_VERSION = QUALIFIED_ACPX_PROFILES.cursor.agentServerVersion;
export const CURSOR_FIXED_ARGUMENTS = ["--disable-project-configs", "--disable-auto-update", "acp"] as const;
export const CURSOR_CREDENTIAL_ENVIRONMENT_NAMES = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const;

/** Add only after the shared launcher has created and pinned private roots. */
export function cursorPrivateEnvironment(paths: { agentHomeDirectory: string; dataDirectory: string; cacheDirectory: string }): NodeJS.ProcessEnv {
  return {
    CURSOR_CONFIG_DIR: paths.agentHomeDirectory,
    CURSOR_DATA_DIR: paths.dataDirectory,
    NODE_COMPILE_CACHE: join(paths.cacheDirectory, "cursor-compile-cache"),
    AGENT_CLI_CREDENTIAL_STORE: "memory",
    NO_OPEN_BROWSER: "1",
  };
}

/**
 * The vendor's disable-project-configs flag covers cli.json only. Keep this
 * admission refusal as defense in depth without mutating the user's project.
 * The separately verified paperclip-cursor-usage-v4 distribution removes
 * ambient MCP and hook discovery at its source for the entire session. This
 * check alone is not continuous filesystem protection or an OS sandbox.
 */
export async function assertCursorWorkspacePolicy(workspacePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const paths: Array<{ path: string; inspectClaude?: boolean }> = [];
  const workspace = await realpath(workspacePath);
  let directory = workspace;
  const ancestors: string[] = [];
  let foundRepository = false;
  while (true) {
    ancestors.push(directory);
    try { await lstat(join(directory, ".git")); foundRepository = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cursor project root could not be inspected"); }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const directory of foundRepository ? ancestors : [workspace]) {
    paths.push(
      { path: join(directory, ".cursor", "mcp.json") },
      { path: join(directory, ".cursor", "hooks.json") },
      { path: join(directory, ".cursor", "plugins") },
      { path: join(directory, ".claude", "plugins") },
      { path: join(directory, ".claude", "settings.json"), inspectClaude: true },
      { path: join(directory, ".claude", "settings.local.json"), inspectClaude: true },
    );
  }
  paths.push({ path: platform === "darwin" ? "/Library/Application Support/Cursor/hooks.json" : "/etc/cursor/hooks.json" });
  for (const { path, inspectClaude } of paths) {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("Cursor ambient execution configuration could not be inspected"); }
    if (inspectClaude && metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 64 * 1024) {
      try {
        const config: unknown = JSON.parse(await readFile(path, "utf8"));
        if (config !== null && typeof config === "object" && !Array.isArray(config) && !("hooks" in config) && !("enabledPlugins" in config)) continue;
      } catch { /* Unreadable or invalid execution config cannot be admitted. */ }
    }
    throw new Error(`Cursor ambient execution configuration is not allowed in an isolated runner: ${path}`);
  }
}
