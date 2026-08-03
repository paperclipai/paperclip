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
 * MUST pass `canonicalPackageDir` as the result of
 * `validateExternalPluginLoad(...).canonicalDir` — passing a mutable
 * path here re-introduces the TOCTOU race the validator was supposed
 * to close. The legacy `localPath` arg is kept for backward
 * compatibility with internal callers (e.g. the registry) that have
 * already canonicalized via their own path, but the public
 * agent-reachable routes MUST use the canonicalDir from the validator.
 */
export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
  canonicalPackageDir?: string,
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
 * and we will use it as the package root. Otherwise we resolve the
 * record's localPath / node_modules path ourselves. Both paths go
 * through `resolveCanonicalEntryPoint` so an entry-point escape is
 * rejected at load time.
 */
export async function reloadExternalAdapter(
  type: string,
  canonicalPackageDir?: string,
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
