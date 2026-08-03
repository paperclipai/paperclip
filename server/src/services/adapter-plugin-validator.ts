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
 *
 * The path-name TOCTOU closure (round 3/4) and the file-mutation
 * closure (round 5) extend the identity check to cover the canonical
 * package directory, the manifest file, the manifest-controlled
 * entry-point file, and (when present) the optional `ui-parser`
 * file. See commits 62c51ae30 / cec6c019e / <round 5> for the diff
 * history. Together these guarantee that any filesystem object the
 * loader subsequently reads or imports is byte-equivalent to the
 * one the validator inspected.
 */

import fs from "node:fs";
import path from "node:path";
import { getAdapterPluginsDir } from "./adapter-plugin-store.js";

export const REQUIRED_PLUGIN_KEYWORD = "paperclip-adapter-plugin";
export const MTIME_FLOOR_MS = 2000;

/**
 * Multi-field filesystem identity for a single inode (file OR
 * directory). Comparing all five fields at load time rejects
 * replacement, mutation, and inode-recycle attacks — `st_ino` alone
 * is not sufficient (ext4 inode recycling observed on the CI
 * runner; `ctime`/`mtime` get reset on inode reuse, so combining
 * them with `ino` gives a stable identity that catches both rename
 * + recreate and overwrite-in-place).
 */
export type FileFingerprint = {
  dev: number;
  ino: number;
  ctime: number;
  mtime: number;
  size: number;
};

/**
 * Capture a FileFingerprint from a Stats object. Centralizes the
 * field mapping (mtimeMs / ctimeMs) so both validator and loader
 * use identical fields.
 */
export function fingerprintFromStats(stat: fs.Stats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    ctime: stat.ctimeMs,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
}

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

/**
 * Resolve the package's `exports[."]` / `main` entry to a string
 * path *relative to* the package dir. Mirrors the loader's
 * `resolvePackageEntryPoint` so the validator can compute the entry
 * file path at validation time (then the loader uses the captured
 * canonical entry path instead of re-reading the manifest).
 *
 * Returns null if the entry point is an absolute path (loader must
 * reject absolutes; the validator surfaces that as
 * `absolute_entry_point`).
 */
export function resolveRelativeEntryPoint(manifest: Record<string, unknown>): string | null {
  const exp = manifest.exports;
  if (exp && typeof exp === "object") {
    const root = (exp as Record<string, unknown>)["."];
    if (typeof root === "string") {
      return path.isAbsolute(root) ? null : root;
    }
    if (root && typeof root === "object") {
      const r = root as Record<string, unknown>;
      const cand = r.import ?? r.default;
      if (typeof cand === "string") {
        return path.isAbsolute(cand) ? null : cand;
      }
    }
  }
  if (typeof manifest.main === "string") {
    return path.isAbsolute(manifest.main) ? null : manifest.main;
  }
  return "index.js";
}

/**
 * Resolve the package's optional `./ui-parser` export relative to
 * the package dir. Mirrors the loader's ui-parser extraction. Returns
 * null if no `./ui-parser` export is declared, or if it points to an
 * absolute path.
 */
export function resolveRelativeUiParser(manifest: Record<string, unknown>): string | null {
  const exp = manifest.exports;
  if (!exp || typeof exp !== "object") return null;
  const ui = (exp as Record<string, unknown>)["./ui-parser"];
  if (!ui) return null;
  if (typeof ui === "string") {
    return path.isAbsolute(ui) ? null : ui;
  }
  if (typeof ui === "object" && ui !== null) {
    const u = ui as Record<string, unknown>;
    const cand = u.import ?? u.default;
    if (typeof cand === "string") {
      return path.isAbsolute(cand) ? null : cand;
    }
  }
  return null;
}

export type PluginLoadDecision =
  | {
      ok: true;
      manifest: { name: string; version?: string; keywords: string[] };
      canonicalDir: string;
      // Canonical realpath of the resolved entry-point file. The
      // loader uses this directly instead of re-resolving the
      // entry point from the manifest at load time — this closes
      // the file-mutation bypass where the agent rewrites
      // package.json (or its `main`/`exports` field) between
      // validation and import. If the new entry path differs, the
      // loader's canonicalEntryPath mismatch fires first.
      canonicalEntryPath: string;
      // Optional canonical realpath of the `./ui-parser` export.
      // Only present when the manifest declares a `./ui-parser`
      // export; the loader fingerprints it the same way.
      canonicalUiParserPath?: string;
      // Filesystem-identity fingerprints (dev/ino/ctime/mtime/size)
      // captured at validation time. The loader MUST re-stat each
      // tracked path at load time and reject if ANY field has
      // changed — this closes both the path-name TOCTOU (round 3/4,
      // directory swap) AND the file-mutation bypass (round 5,
      // package.json or entry-file overwrite). The four fingerprints
      // are independent; overwriting one file changes only its own
      // fingerprint fields, not the others.
      canonicalDirIdentity: FileFingerprint;
      canonicalManifestIdentity: FileFingerprint;
      canonicalEntryIdentity: FileFingerprint;
      canonicalUiParserIdentity?: FileFingerprint;
    }
  | {
      ok: false;
      reason:
        | "outside_plugins_dir"
        | "missing_manifest"
        | "invalid_json"
        | "missing_keyword"
        | "manifest_too_recent"
        | "absolute_entry_point"
        | "missing_entry_file"
        | "unresolvable_entry_file"
        | "entry_file_outside_dir"
        | "missing_ui_parser_file"
        | "unresolvable_ui_parser_file"
        | "ui_parser_file_outside_dir";
      detail?: string;
    };

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

  // Capture filesystem-identity fingerprints of every file the loader
  // is going to read or import. Without these, an attacker who can
  // write to the plugin directory (and they can, to install into it)
  // can validate a benign package, then overwrite package.json and/or
  // the entry file inside the same directory; the directory stat
  // stays identical so the round-4 fingerprint passes, but the loader
  // subsequently re-reads the *new* manifest and imports the *new*
  // entry file. Round 5 closes this by fingerprinting each
  // independently:
  //
  //   - canonicalDirIdentity: the package directory inode (round 3/4)
  //   - canonicalManifestIdentity: package.json's own inode
  //   - canonicalEntryIdentity: the entry-point file's inode
  //   - canonicalUiParserIdentity: optional, the ui-parser file's inode
  //
  // Each fingerprint is a multi-field (dev/ino/ctime/mtime/size)
  // identity. st_ino alone is not sufficient — ext4's inode-recycle
  // cache can return the same inode number to a recreated directory
  // (Empirically observed in CI: rm + mkdir at the same pathname
  // returned the same st_ino on the test runner's filesystem.)
  // ctime/mtime get reset on inode reuse, so combining them with
  // st_ino gives a stable multi-field identity.

  // 1. Package directory fingerprint.
  let canonicalDirIdentity: FileFingerprint;
  try {
    canonicalDirIdentity = fingerprintFromStats(fs.statSync(resolvedDir as string));
  } catch (err) {
    return {
      ok: false,
      reason: "missing_manifest",
      detail: `Cannot stat canonical dir ${resolvedDir} at validation close: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 2. Manifest (package.json) fingerprint.
  let canonicalManifestIdentity: FileFingerprint;
  try {
    canonicalManifestIdentity = fingerprintFromStats(fs.statSync(pkgJsonPath));
  } catch (err) {
    return {
      ok: false,
      reason: "missing_manifest",
      detail: `Cannot stat manifest ${pkgJsonPath} at validation close: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 3. Resolve the entry-point file path from the manifest (relative
  //    to packageDir), then realpath it and check it's inside the
  //    canonical package dir. Capture the entry file's fingerprint.
  const relEntry = resolveRelativeEntryPoint(obj);
  if (relEntry === null) {
    return {
      ok: false,
      reason: "absolute_entry_point",
      detail: `package.json declares an absolute entry point; refusing to load`,
    };
  }
  const entryPath = path.resolve(resolvedDir as string, relEntry);
  let canonicalEntryPath: string;
  try {
    canonicalEntryPath = fs.realpathSync(entryPath);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error && err.message.includes("ENOENT")
        ? "missing_entry_file"
        : "unresolvable_entry_file",
      detail: `Entry file ${entryPath} cannot be realpath'd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  // Containment check on the entry file: the canonical entry path MUST
  // live inside the canonical package dir (catches `..` escape
  // entries that realpath-resolved outside the package).
  if (
    canonicalEntryPath !== (resolvedDir as string) &&
    !canonicalEntryPath.startsWith((resolvedDir as string) + path.sep)
  ) {
    return {
      ok: false,
      reason: "entry_file_outside_dir",
      detail: `Entry file ${entryPath} canonicalizes to ${canonicalEntryPath} which is outside the canonical package dir ${resolvedDir}`,
    };
  }
  let canonicalEntryIdentity: FileFingerprint;
  try {
    canonicalEntryIdentity = fingerprintFromStats(fs.statSync(canonicalEntryPath));
  } catch (err) {
    return {
      ok: false,
      reason: "missing_entry_file",
      detail: `Cannot stat entry file ${canonicalEntryPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 4. Optional ui-parser export. Only fingerprint when the manifest
  //    declares it (most packages don't). Same containment + stat
  //    dance as the main entry.
  let canonicalUiParserPath: string | undefined;
  let canonicalUiParserIdentity: FileFingerprint | undefined;
  const relUi = resolveRelativeUiParser(obj);
  if (relUi !== null) {
    const uiPath = path.resolve(resolvedDir as string, relUi);
    try {
      canonicalUiParserPath = fs.realpathSync(uiPath);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error && err.message.includes("ENOENT")
          ? "missing_ui_parser_file"
          : "unresolvable_ui_parser_file",
        detail: `UI parser file ${uiPath} cannot be realpath'd: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (
      canonicalUiParserPath !== (resolvedDir as string) &&
      !canonicalUiParserPath.startsWith((resolvedDir as string) + path.sep)
    ) {
      return {
        ok: false,
        reason: "ui_parser_file_outside_dir",
        detail: `UI parser file ${uiPath} canonicalizes to ${canonicalUiParserPath} which is outside the canonical package dir ${resolvedDir}`,
      };
    }
    try {
      canonicalUiParserIdentity = fingerprintFromStats(fs.statSync(canonicalUiParserPath));
    } catch (err) {
      return {
        ok: false,
        reason: "missing_ui_parser_file",
        detail: `Cannot stat ui-parser file ${canonicalUiParserPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
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
    // importing the module — passing the mutable path lets an
    // attacker swap the package between validation and import
    // (TOCTOU).
    canonicalDir: resolvedDir as string,
    // The canonical realpath of the entry-point file. The loader
    // uses this directly (instead of re-resolving the entry point
    // from the manifest at load time) so a manifest mutation between
    // validation and load cannot redirect the import.
    canonicalEntryPath,
    ...(canonicalUiParserPath !== undefined ? { canonicalUiParserPath } : {}),
    // Per-path filesystem-identity fingerprints (dev/ino/ctime/mtime/size)
    // captured at validation time. The loader re-stats each path and
    // rejects if ANY field has changed. Closes:
    //   - path-name TOCTOU (round 3/4): canonicalDirIdentity
    //   - file-mutation bypass (round 5): canonicalManifestIdentity,
    //     canonicalEntryIdentity, canonicalUiParserIdentity
    canonicalDirIdentity,
    canonicalManifestIdentity,
    canonicalEntryIdentity,
    ...(canonicalUiParserIdentity !== undefined ? { canonicalUiParserIdentity } : {}),
  };
}
