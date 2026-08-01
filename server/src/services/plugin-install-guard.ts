/**
 * @fileoverview Security guard for plugin install sources.
 *
 * Two related protections for `POST /api/plugins/install`:
 *
 * 1. **Cloud install floor.** Instances managed by the Paperclip Cloud
 *    harness receive a `PAPERCLIP_MANAGED_CONFIG` environment document that
 *    only the harness can inject. On such instances, plugin installation is
 *    a remote-code-execution surface on shared infrastructure, so the route
 *    enforces a positive allowlist: only install sources that canonicalize
 *    to a path inside the bundled plugin catalog root may be installed.
 *    npm/registry installs and arbitrary `localPath` installs are rejected.
 *
 * 2. **`localPath` canonicalization for every instance.** The install route
 *    historically skipped its package-name character check when
 *    `isLocalPath` was set, passing the raw request string straight to the
 *    loader. All local install paths are now canonicalized (absolute
 *    resolution + symlink/`..` normalization via `realpath`) and validated
 *    to be readable directories before the loader sees them.
 *
 * The floor is enforced in code at the route, independent of any feature
 * flag or of the managed-config document's *content*: a corrupted flag
 * document cannot widen the install surface because this module never reads
 * the document body at all (see `isCloudManagedInstance`).
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { BUNDLED_LOCAL_PLUGIN_ROOT } from "./plugin-loader.js";

/**
 * Environment key carrying the harness-injected managed-instance document.
 *
 * The full document contract (`mode: "cloud"`, feature overlay, plugin
 * auto-install list) is parsed fail-closed elsewhere at startup; this module
 * only cares about the variable's presence.
 */
export const MANAGED_CONFIG_ENV_KEY = "PAPERCLIP_MANAGED_CONFIG";

/**
 * Whether this instance is managed by the Paperclip Cloud harness.
 *
 * Deliberately presence-based rather than content-based: the strict startup
 * parser refuses to boot a managed instance with a malformed document, and
 * absent env means self-hosted. Deciding the security floor on presence
 * alone means a corrupted, truncated, or attacker-influenced document can
 * never *disable* the floor — the failure mode is closed, not open.
 *
 * @param env - Raw environment map (injectable for tests; defaults to `process.env`)
 */
export function isCloudManagedInstance(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MANAGED_CONFIG_ENV_KEY] !== undefined;
}

/** Result of canonicalizing a requested local plugin install path. */
export type LocalPluginPathValidation =
  | { ok: true; canonicalPath: string }
  | { ok: false; reason: string };

/**
 * Canonicalize and validate a raw `localPath` install source.
 *
 * Resolves the request string to an absolute path, then to its real path —
 * collapsing `..` traversal segments and resolving every symlink — and
 * requires the result to be an existing directory. Downstream checks (the
 * cloud catalog containment test, the loader itself) must only ever see the
 * canonical form so that no alias of a path can reach a different decision
 * than the path itself.
 *
 * @param rawPath - The unsanitized `packageName` value from the request body
 */
export async function canonicalizeLocalPluginPath(
  rawPath: string,
): Promise<LocalPluginPathValidation> {
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "path contains a null byte" };
  }

  const absolutePath = path.resolve(rawPath);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    return { ok: false, reason: `path does not exist: ${absolutePath}` };
  }

  try {
    const stats = await stat(canonicalPath);
    if (!stats.isDirectory()) {
      return { ok: false, reason: `path is not a directory: ${canonicalPath}` };
    }
  } catch {
    return { ok: false, reason: `path is not readable: ${canonicalPath}` };
  }

  return { ok: true, canonicalPath };
}

/**
 * Whether a canonical path lies strictly inside the bundled plugin catalog
 * root (`packages/plugins` in the application bundle).
 *
 * The catalog root itself is also canonicalized before comparison so a
 * symlinked deployment layout cannot produce false negatives, and the
 * containment test is segment-based (`path.relative`), never a string-prefix
 * check. The root itself does not count as inside — an install source must
 * be a package directory *within* the catalog.
 *
 * @param canonicalPath - A path already canonicalized by {@link canonicalizeLocalPluginPath}
 * @param bundledRootOverride - Catalog root override for tests; defaults to
 *   {@link BUNDLED_LOCAL_PLUGIN_ROOT}
 */
export async function isWithinBundledPluginRoot(
  canonicalPath: string,
  bundledRootOverride?: string,
): Promise<boolean> {
  const bundledRoot = bundledRootOverride ?? BUNDLED_LOCAL_PLUGIN_ROOT;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(bundledRoot);
  } catch {
    // No catalog root on disk means nothing is bundled; fail closed.
    return false;
  }

  const relative = path.relative(canonicalRoot, canonicalPath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
