/**
 * @fileoverview Plugin load constraints for externally installed adapters.
 *
 * External adapter packages are loaded into the Paperclip server process.
 * To prevent a confused-deputy attack (an agent loading arbitrary untrusted
 * code), the plugin load path enforces three hard constraints before any
 * `import()` happens:
 *
 *   1. **Path allowlist** — the resolved package directory MUST be inside
 *      `~/.paperclip/adapter-plugins/` (the managed plugins directory).
 *      This is automatic for `npm install --no-save` (which `cwd`s into
 *      the plugins dir), and explicit for local-path installs.
 *
 *   2. **Keyword shape** — `package.json` MUST declare the
 *      `"paperclip-adapter-plugin"` keyword. This is the only way an
 *      external package can be recognized as a Paperclip adapter. Mixed
 *      up a package, no load.
 *
 *   3. **Mtime floor** — `package.json` mtime MUST be ≥ 2 seconds old at
 *      the moment of load. Prevents in-flight half-writes racing the load.
 *
 * The auth gate that lets an agent call `/api/adapters/install` and
 * `/api/adapters/:type/reload` is `assertBoardOrAgent`. The shape checks
 * below are *additive* — both gates run, in either order, and either
 * failure short-circuits the load.
 *
 * @module server/services/adapter-plugin-validator
 */

import fs from "node:fs";
import path from "node:path";
import { getAdapterPluginsDir } from "./adapter-plugin-store.js";

export const REQUIRED_PLUGIN_KEYWORD = "paperclip-adapter-plugin";
export const MTIME_FLOOR_MS = 2000;

export type PluginLoadDecision =
  | { ok: true; manifest: { name: string; version?: string; keywords: string[] } }
  | { ok: false; reason: "outside_plugins_dir" | "missing_manifest" | "invalid_json" | "missing_keyword" | "manifest_too_recent"; detail?: string };

/**
 * Check whether `packageDir` is allowed to be loaded as an external
 * adapter plugin. Returns a discriminated union rather than throwing so
 * the route handler can map failures to specific HTTP responses and the
 * audit log gets the exact reason.
 *
 * The path allowlist is `startsWith(pluginsDir + path.sep)` OR an exact
 * match. The plugins dir is created if missing, so a fresh install
 * doesn't blow up — the function falls through to "outside_plugins_dir".
 */
export function validateExternalPluginLoad(packageDir: string, now = Date.now()): PluginLoadDecision {
  const pluginsDir = path.resolve(getAdapterPluginsDir());
  const resolvedDir = path.resolve(packageDir);

  // Allow list: must be inside the managed plugins dir.
  const insidePluginsDir =
    resolvedDir === pluginsDir ||
    resolvedDir.startsWith(pluginsDir + path.sep);
  if (!insidePluginsDir) {
    return {
      ok: false,
      reason: "outside_plugins_dir",
      detail: `Resolved dir ${resolvedDir} is outside the managed adapter-plugins directory ${pluginsDir}`,
    };
  }

  const pkgJsonPath = path.join(resolvedDir, "package.json");

  // Mtime floor: refuse if package.json was modified too recently —
  // this catches in-flight half-writes racing the load.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pkgJsonPath);
  } catch {
    return { ok: false, reason: "missing_manifest", detail: pkgJsonPath };
  }
  if (now - stat.mtimeMs < MTIME_FLOOR_MS) {
    return {
      ok: false,
      reason: "manifest_too_recent",
      detail: `package.json was modified ${Math.round(now - stat.mtimeMs)}ms ago; floor is ${MTIME_FLOOR_MS}ms — likely an in-flight half-write`,
    };
  }

  // Keyword shape: package.json must declare REQUIRED_PLUGIN_KEYWORD.
  let raw: string;
  try {
    raw = fs.readFileSync(pkgJsonPath, "utf-8");
  } catch {
    return { ok: false, reason: "missing_manifest", detail: pkgJsonPath };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const obj = pkg as Record<string, unknown>;
  const keywords = obj.keywords;
  if (!Array.isArray(keywords) || !keywords.includes(REQUIRED_PLUGIN_KEYWORD)) {
    return {
      ok: false,
      reason: "missing_keyword",
      detail: `package.json keywords must include "${REQUIRED_PLUGIN_KEYWORD}"`,
    };
  }

  return {
    ok: true,
    manifest: {
      name: typeof obj.name === "string" ? obj.name : path.basename(resolvedDir),
      version: typeof obj.version === "string" ? obj.version : undefined,
      keywords: keywords as string[],
    },
  };
}
