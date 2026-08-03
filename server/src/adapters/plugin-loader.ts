/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
  getAdapterPluginByType,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";

// ---------------------------------------------------------------------------
// In-memory UI parser cache
// ---------------------------------------------------------------------------

const uiParserCache = new Map<string, string>();

export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * On cache miss, attempt on-demand extraction from the plugin store.
 * Makes the ui-parser.js endpoint self-healing.
 */
export function getOrExtractUiParserSource(adapterType: string): string | undefined {
  const cached = uiParserCache.get(adapterType);
  if (cached) return cached;

  const record = getAdapterPluginByType(adapterType);
  if (!record) return undefined;

  const packageDir = resolvePackageDir(record);
  const source = extractUiParserSource(packageDir, record.packageName);
  if (source) {
    uiParserCache.set(adapterType, source);
    logger.info(
      { type: adapterType, packageName: record.packageName, origin: "lazy" },
      "UI parser extracted on-demand (cache miss)",
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  }
  return pkg.main ?? "index.js";
}

/**
 * Resolve the entry point relative to the package dir AND verify the
 * canonical (realpath-resolved) entry file is still inside the
 * canonical package dir. Without this check, a package whose
 * `exports` / `main` is an absolute path (or a `../` escape) would
 * import code from outside the managed plugins directory. Returns
 * the canonical path on success.
 *
 * The packageDir MUST be the canonical realpath-resolved dir
 * returned by `validateExternalPluginLoad` — passing a mutable path
 * here would re-introduce the symlink containment bypass the
 * validator fixed.
 */
function resolveCanonicalEntryPoint(packageDir: string, packageName: string): string {
  const entryPoint = resolvePackageEntryPoint(packageDir);
  // Reject absolute entry points outright. `path.resolve(abs, x)` discards
  // `abs` when `x` is absolute, so absolute entry points could escape
  // containment silently.
  if (path.isAbsolute(entryPoint)) {
    throw new Error(
      `Package "${packageName}" entry point "${entryPoint}" is an absolute path; refusing to load`,
    );
  }
  const joined = path.resolve(packageDir, entryPoint);
  let canonicalJoined: string;
  try {
    canonicalJoined = fs.realpathSync(joined);
  } catch (err) {
    throw new Error(
      `Package "${packageName}" entry point "${entryPoint}" is not resolvable on disk: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const canonicalDir = fs.realpathSync(packageDir);
  const insideDir =
    canonicalJoined === canonicalDir ||
    canonicalJoined.startsWith(canonicalDir + path.sep);
  if (!insideDir) {
    throw new Error(
      `Package "${packageName}" entry point "${entryPoint}" resolves to ${canonicalJoined} which is outside the canonical package dir ${canonicalDir}`,
    );
  }
  return canonicalJoined;
}

// ---------------------------------------------------------------------------
// UI parser extraction
// ---------------------------------------------------------------------------

const SUPPORTED_PARSER_CONTRACT = "1";

function extractUiParserSource(
  packageDir: string,
  packageName: string,
): string | undefined {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (!pkg.exports || typeof pkg.exports !== "object" || !pkg.exports["./ui-parser"]) {
    return undefined;
  }

  const contractVersion = pkg.paperclip?.adapterUiParser;
  if (contractVersion) {
    const major = contractVersion.split(".")[0];
    if (major !== SUPPORTED_PARSER_CONTRACT) {
      logger.warn(
        { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
        "Adapter declares unsupported UI parser contract version — skipping UI parser",
      );
      return undefined;
    }
  } else {
    logger.info(
      { packageName },
      "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
    );
  }

  const uiParserExp = pkg.exports["./ui-parser"];
  const uiParserFile = typeof uiParserExp === "string"
    ? uiParserExp
    : (uiParserExp.import ?? uiParserExp.default);
  const uiParserPath = path.resolve(packageDir, uiParserFile);

  if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
    logger.warn(
      { packageName, uiParserFile },
      "UI parser path escapes package directory — skipping",
    );
    return undefined;
  }

  if (!fs.existsSync(uiParserPath)) {
    return undefined;
  }

  try {
    const source = fs.readFileSync(uiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserFile, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;
  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }
  return adapterModule;
}

/**
 * Load an external adapter package. The caller (the route handler)
 * MUST pass `canonicalPackageDir` (the result of
 * `validateExternalPluginLoad(...).canonicalDir`) AND
 * `canonicalDirIdentity` (the result of
 * `validateExternalPluginLoad(...).canonicalDirIdentity`) — passing
 * only the path string lets an attacker replace the package
 * directory at the canonical pathname between validation and load
 * and defeat the manifest/age/path checks. The fingerprint is a
 * multi-field (dev/ino/ctime/mtime/size) identity — st_ino alone is
 * not sufficient because ext4's inode-recycle cache can return the
 * same inode number to a recreated directory at the same pathname,
 * which CI empirically observed (see PHA-1659 round-4 test failure
 * on `paperclipai:master`).
 *
 * The legacy `localPath` arg is kept for backward compatibility with
 * internal callers (e.g. the registry) that have already
 * canonicalized via their own path; the public agent-reachable
 * routes MUST use the canonicalDir from the validator.
 */
export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
  canonicalPackageDir?: string,
  canonicalDirIdentity?: { dev: number; ino: number; ctime: number; mtime: number; size: number },
): Promise<ServerAdapterModule> {
  // Prefer the explicitly canonicalized dir from the validator; fall
  // back to resolving localPath / node_modules ourselves for
  // internal callers that bypass the route.
  const packageDir =
    canonicalPackageDir ??
    fs.realpathSync(
      localPath
        ? path.resolve(localPath)
        : path.resolve(getAdapterPluginsDir(), "node_modules", packageName),
    );

  // Multi-field fingerprint check (dev/ino/ctime/mtime/size). If ANY
  // field has changed, the directory at canonicalDir has been
  // replaced since validation; reject before any import. st_ino
  // alone is insufficient on ext4 with inode recycling — ctime and
  // mtime get reset on inode reuse, so checking them catches the
  // case where the inode number happens to match.
  if (canonicalDirIdentity !== undefined) {
    let current: { dev: number; ino: number; ctime: number; mtime: number; size: number };
    try {
      const stat = fs.statSync(packageDir);
      current = {
        dev: stat.dev,
        ino: stat.ino,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    } catch (err) {
      throw new Error(
        `Package "${packageName}" canonical dir ${packageDir} cannot be re-stated at load time: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const mismatches: string[] = [];
    if (current.dev !== canonicalDirIdentity.dev) mismatches.push(`dev ${canonicalDirIdentity.dev} -> ${current.dev}`);
    if (current.ino !== canonicalDirIdentity.ino) mismatches.push(`ino ${canonicalDirIdentity.ino} -> ${current.ino}`);
    if (current.ctime !== canonicalDirIdentity.ctime) mismatches.push(`ctime ${canonicalDirIdentity.ctime} -> ${current.ctime}`);
    if (current.mtime !== canonicalDirIdentity.mtime) mismatches.push(`mtime ${canonicalDirIdentity.mtime} -> ${current.mtime}`);
    if (current.size !== canonicalDirIdentity.size) mismatches.push(`size ${canonicalDirIdentity.size} -> ${current.size}`);
    if (mismatches.length > 0) {
      throw new Error(
        `Package "${packageName}" canonical dir ${packageDir} was replaced between validation and load ` +
          `(fingerprint mismatches: ${mismatches.join(", ")})`,
      );
    }
  }

  const modulePath = resolveCanonicalEntryPoint(packageDir, packageName);
  const uiParserSource = extractUiParserSource(packageDir, packageName);

  logger.info({ packageName, packageDir, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(modulePath);
  const adapterModule = validateAdapterModule(mod, packageName);

  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    return await loadExternalAdapterPackage(record.packageName, record.localPath);
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 *
 * If `canonicalPackageDir` is provided, it MUST be the result of
 * `validateExternalPluginLoad(...).canonicalDir` for the same package
 * and we will use it as the package root. If `canonicalDirIdentity`
 * is provided, it MUST be the result of
 * `validateExternalPluginLoad(...).canonicalDirIdentity` for the
 * same package; the loader will re-stat the dir and reject if any
 * of the fingerprint fields has changed (path-name TOCTOU closure,
 * multi-field to defeat ext4 inode recycling). Otherwise we resolve
 * the record's localPath / node_modules path ourselves. Both paths
 * go through `resolveCanonicalEntryPoint` so an entry-point escape
 * is rejected at load time.
 */
export async function reloadExternalAdapter(
  type: string,
  canonicalPackageDir?: string,
  canonicalDirIdentity?: { dev: number; ino: number; ctime: number; mtime: number; size: number },
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const packageDir =
    canonicalPackageDir ??
    fs.realpathSync(
      record.localPath
        ? path.resolve(record.localPath)
        : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName),
    );

  // Same multi-field fingerprint check as loadExternalAdapterPackage.
  // Closes the path-name TOCTOU for the reload path. If the
  // fingerprint check fires, we never bust the ESM cache or run the
  // import — fail closed.
  if (canonicalDirIdentity !== undefined) {
    let current: { dev: number; ino: number; ctime: number; mtime: number; size: number };
    try {
      const stat = fs.statSync(packageDir);
      current = {
        dev: stat.dev,
        ino: stat.ino,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    } catch (err) {
      throw new Error(
        `Adapter "${type}" canonical dir ${packageDir} cannot be re-stated at reload time: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const mismatches: string[] = [];
    if (current.dev !== canonicalDirIdentity.dev) mismatches.push(`dev ${canonicalDirIdentity.dev} -> ${current.dev}`);
    if (current.ino !== canonicalDirIdentity.ino) mismatches.push(`ino ${canonicalDirIdentity.ino} -> ${current.ino}`);
    if (current.ctime !== canonicalDirIdentity.ctime) mismatches.push(`ctime ${canonicalDirIdentity.ctime} -> ${current.ctime}`);
    if (current.mtime !== canonicalDirIdentity.mtime) mismatches.push(`mtime ${canonicalDirIdentity.mtime} -> ${current.mtime}`);
    if (current.size !== canonicalDirIdentity.size) mismatches.push(`size ${canonicalDirIdentity.size} -> ${current.size}`);
    if (mismatches.length > 0) {
      throw new Error(
        `Adapter "${type}" canonical dir ${packageDir} was replaced between validation and reload ` +
          `(fingerprint mismatches: ${mismatches.join(", ")})`,
      );
    }
  }

  const modulePath = resolveCanonicalEntryPoint(packageDir, record.packageName);
  const fileUrl = `file://${modulePath}`;

  // Bust ESM module cache so re-import loads fresh code from disk.
  // Query-string trick (?t=...) works in Node; Bun may need the file:// URL
  // to be evicted from its internal registry first.
  try {
    // @ts-expect-error -- Bun internal module cache
    const bunCache = globalThis.Bun?.__moduleCache as Map<string, unknown> | undefined;
    if (bunCache) {
      bunCache.delete(fileUrl);
      bunCache.delete(modulePath);
    }
  } catch {
    // Ignore — query-string fallback still works in Node
  }

  const cacheBustUrl = `${fileUrl}?t=${Date.now()}`;

  logger.info(
    { type, packageName: record.packageName, modulePath, cacheBustUrl },
    "Reloading external adapter (cache bust)",
  );

  const mod = await import(cacheBustUrl);
  const adapterModule = validateAdapterModule(mod, record.packageName);

  uiParserCache.delete(type);
  const uiParserSource = extractUiParserSource(packageDir, record.packageName);
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  logger.info(
    { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
    "Successfully reloaded external adapter",
  );

  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}
