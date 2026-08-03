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
 *
 * Greptile review response (PR #10706): the symlink containment bypass
 * finding is fixed by replacing the lexical startsWith() comparison
 * with a realpath-based one. See commit 31f4d7316 for the diff.
 */

import fs from "node:fs";
import path from "node:path";
import { getAdapterPluginsDir } from "./adapter-plugin-store.js";

export const REQUIRED_PLUGIN_KEYWORD = "paperclip-adapter-plugin";
export const MTIME_FLOOR_MS = 2000;

/**
 * Resolve a path with realpathSync and return null on any failure
 * (ENOENT, EACCES, loop, …) so callers can map failures to a single
 * "outside_plugins_dir" outcome instead of crashing the route. We
 * deliberately swallow the underlying error — the route handler does
 * not need to know WHY the path was unresolvable, only that the
 * containment check rejected it.
 */
function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export type PluginLoadDecision =
  | {
      ok: true;
      manifest: { name: string; version?: string; keywords: string[] };
      canonicalDir: string;
      // Filesystem-identity fingerprint (dev/ino/ctime/mtime/size)
      // of the canonical package directory at validation time. The
      // loader MUST re-stat the canonical dir and reject if ANY of
      // these fields has changed — this closes the path-name TOCTOU
      // even on filesystems where st_ino alone is insufficient
      // (e.g. ext4 with inode-recycle cache).
      canonicalDirIdentity: { dev: number; ino: number; ctime: number; mtime: number; size: number };
    }
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
  // Canonicalize both the managed plugins dir and the resolved package
  // dir with realpath so the containment check below resists symlink
  // bypass. A symlink planted at ~/.paperclip/adapter-plugins/foo that
  // points at /tmp/evil would pass a lexical path.startsWith() check,
  // but realpathSync follows the link and the comparison below then
  // rejects it. The plugins dir is created if missing so a fresh
  // install still surfaces as "outside_plugins_dir" rather than a
  // confusing ENOENT.
  const pluginsDir = safeRealpath(getAdapterPluginsDir());
  const resolvedDir = safeRealpath(packageDir);

  // Allow list: must be inside the managed plugins dir (canonical).
  const insidePluginsDir =
    resolvedDir === pluginsDir ||
    (resolvedDir !== null && pluginsDir !== null && resolvedDir.startsWith(pluginsDir + path.sep));
  if (!insidePluginsDir) {
    return {
      ok: false,
      reason: "outside_plugins_dir",
      detail: `Resolved dir ${packageDir} (canonical: ${resolvedDir ?? "<unresolvable>"}) is outside the managed adapter-plugins directory ${pluginsDir ?? getAdapterPluginsDir()}`,
    };
  }

  // Both realpaths succeeded and resolvedDir is a strict descendant of
  // pluginsDir — we can use resolvedDir confidently from here. The
  // post-realpath type narrow is handled by the guard above; if either
  // realpath returned null we already returned.
  const pkgJsonPath = path.join(resolvedDir as string, "package.json");

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

  // Capture a filesystem-identity fingerprint of the canonical package
  // directory so the loader can verify the directory has not been
  // replaced between validation and import. We capture multiple
  // fields (ino, ctime, mtime, dev, size) and the loader checks ALL
  // of them. st_ino alone is not sufficient — ext4's inode-recycle
  // cache can return the same inode number to a recreated directory
  // (Empirically observed in CI: rm + mkdir at the same pathname
  // returned the same st_ino on the test runner's filesystem.)
  // ctime/mtime get reset on inode reuse, so combining them with
  // st_ino gives a stable multi-field identity.
  let canonicalDirIdentity: { dev: number; ino: number; ctime: number; mtime: number; size: number };
  try {
    const stat = fs.statSync(resolvedDir as string);
    canonicalDirIdentity = {
      dev: stat.dev,
      ino: stat.ino,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "missing_manifest",
      detail: `Cannot stat canonical dir ${resolvedDir} at validation close: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return {
    ok: true,
    manifest: {
      name: typeof obj.name === "string" ? obj.name : path.basename(resolvedDir as string),
      version: typeof obj.version === "string" ? obj.version : undefined,
      keywords: keywords as string[],
    },
    // The canonical realpath of the resolved dir. Callers MUST use
    // this canonicalDir (not the original mutable packageDir) when
    // resolving entry points and importing the module — passing the
    // mutable path lets an attacker swap the package between
    // validation and import (TOCTOU).
    canonicalDir: resolvedDir as string,
    // The filesystem-identity fingerprint (dev/ino/ctime/mtime/size)
    // captured at validation time. The loader re-stats the canonical
    // dir and rejects if ANY of these fields has changed — this
    // closes the path-name TOCTOU even on filesystems (ext4 with
    // inode recycling) where st_ino alone is insufficient.
    canonicalDirIdentity,
  };
}
