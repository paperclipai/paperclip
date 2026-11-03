import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRecord } from "@paperclipai/shared";

export const DEFAULT_LOCAL_PLUGIN_DIR = path.join(os.homedir(), ".paperclip", "plugins");

/** Resolve installed bytes only; deployment activation policy is a separate guard. */
export function resolvePluginPackageRoot(
  plugin: Pick<PluginRecord, "pluginKey" | "packageName" | "packagePath">,
  localPluginDir: string,
): string {
  if (plugin.packagePath && existsSync(plugin.packagePath)) return path.resolve(plugin.packagePath);
  const packageDir = path.join(localPluginDir, "node_modules", ...plugin.packageName.split("/"));
  if (existsSync(packageDir)) return packageDir;
  const directDir = path.join(localPluginDir, plugin.packageName);
  if (existsSync(directDir)) return directDir;
  throw new Error(`Package root not found for plugin "${plugin.pluginKey}"`);
}
