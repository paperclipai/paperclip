import fs from "node:fs/promises";
import path from "node:path";
import { resolveSharedClaudeConfigDir } from "./claude-config.js";

export interface PluginManifestResult {
  filePath: string;
  valid: boolean;
  /** Top-level keys found when the manifest is malformed (missing mcpServers). */
  foundKeys?: string[];
}

async function findManifestFiles(cacheDir: string): Promise<string[]> {
  const results: string[] = [];
  let marketplaces: string[];
  try {
    marketplaces = await fs.readdir(cacheDir);
  } catch {
    return results;
  }
  for (const marketplace of marketplaces) {
    const marketplaceDir = path.join(cacheDir, marketplace);
    let plugins: string[];
    try {
      plugins = await fs.readdir(marketplaceDir);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      const pluginDir = path.join(marketplaceDir, plugin);
      let versions: string[];
      try {
        versions = await fs.readdir(pluginDir);
      } catch {
        continue;
      }
      for (const version of versions) {
        const candidate = path.join(pluginDir, version, ".mcp.json");
        try {
          await fs.access(candidate);
          results.push(candidate);
        } catch {
          // no manifest at this version path
        }
      }
    }
  }
  return results;
}

/**
 * Scans all .mcp.json files under the plugin cache directory and validates
 * that each has the canonical `mcpServers` top-level key.
 *
 * Returns one result per manifest found. Malformed manifests are flagged but
 * never throw — callers decide how to surface the warnings.
 */
export async function validatePluginCacheManifests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginManifestResult[]> {
  const claudeConfigDir = resolveSharedClaudeConfigDir(env);
  const cacheDir = path.join(claudeConfigDir, "plugins", "cache");
  const manifestFiles = await findManifestFiles(cacheDir);
  const results: PluginManifestResult[] = [];
  for (const filePath of manifestFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      results.push({ filePath, valid: false, foundKeys: [] });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      results.push({ filePath, valid: false, foundKeys: [] });
      continue;
    }
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (!keys.includes("mcpServers")) {
      results.push({ filePath, valid: false, foundKeys: keys });
    } else {
      results.push({ filePath, valid: true });
    }
  }
  return results;
}
