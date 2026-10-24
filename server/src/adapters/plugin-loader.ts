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

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerAdapterModule } from "./types.js";
import { validateAdapterLoginCapability } from "@paperclipai/adapter-utils";
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

export function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
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

  // Fail closed on a malformed login capability. The validator throws a clear
  // error, so the loader rejects the adapter instead of loading it with a
  // partial capability.
  try {
    validateAdapterLoginCapability(adapterModule);
  } catch (err) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid login capability: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
): Promise<ServerAdapterModule> {
  const packageDir = localPath
    ? path.resolve(localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);

  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const uiParserSource = extractUiParserSource(packageDir, packageName);

  logger.info({ packageName, packageDir, entryPoint, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(pathToFileURL(modulePath).href);
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

const RELOAD_DIR_PREFIX = ".reload-";
const RELOAD_DIR_TTL_MS = 3_600_000;
const activeReloadDirs = new Map<string, string>();
const typeLocks = new Map<string, Promise<unknown>>();

export function lockKeysForType(type: string): string[] {
  const record = getAdapterPluginByType(type);
  if (!record || record.localPath || !record.packageName) return [`type:${type}`];
  return [`type:${type}`, `pkg:${record.packageName}`];
}

/**
 * Non-reentrant per-key promise-chain mutex. A rejection never breaks the
 * chain: queued sections still run. Keys use `type:<adapterType>` and
 * `pkg:<packageName>` namespaces; multi-key sections must take type before
 * pkg. Callers already holding a key must use the `lockHeld` escape hatch
 * instead of re-entering, or they self-deadlock.
 */
export async function withAdapterLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previousRun = typeLocks.get(key) ?? Promise.resolve();
  const run = previousRun.catch(() => undefined).then(fn);
  typeLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (typeLocks.get(key) === run) typeLocks.delete(key);
  }
}

export async function withAdapterLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)];
  const run = async (index: number): Promise<T> =>
    index >= ordered.length ? fn() : withAdapterLock(ordered[index], () => run(index + 1));
  return run(0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeReloadDirSegment(type: string): string {
  return type.replace(/[^A-Za-z0-9_-]/g, "_");
}

function reloadDirPrefixForType(type: string): string {
  return RELOAD_DIR_PREFIX + sanitizeReloadDirSegment(type);
}

function dirHashForType(type: string): string {
  return createHash("sha256").update(type, "utf8").digest("hex").slice(0, 8);
}

export function reloadDirNameForType(type: string): string {
  return `${reloadDirPrefixForType(type)}-${dirHashForType(type)}-${Date.now()}-${randomUUID()}`;
}

export function isReloadDirEntry(entry: string, type: string): boolean {
  const prefix = escapeRegExp(reloadDirPrefixForType(type));
  const tail = "-\\d+-[0-9a-f-]{36}$";
  if (new RegExp(`^${prefix}-${dirHashForType(type)}${tail}`).test(entry)) return true;
  return new RegExp(`^${prefix}${tail}`).test(entry);
}

export function isAnyReloadDirEntry(entry: string): boolean {
  return /^\.reload-.*-\d+-[0-9a-f-]{36}$/.test(entry);
}

function isExpiredReloadDir(pluginsDir: string, entry: string): boolean {
  try {
    return Date.now() - fs.statSync(path.join(pluginsDir, entry)).mtimeMs >= RELOAD_DIR_TTL_MS;
  } catch {
    return false;
  }
}

function pruneStaleReloadDirs(pluginsDir: string, type: string, keepDirs: string[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsDir);
  } catch {
    return;
  }
  const keep = new Set(keepDirs.map((dir) => path.resolve(dir)));
  for (const entry of entries) {
    if (!isReloadDirEntry(entry, type)) continue;
    if (keep.has(path.resolve(pluginsDir, entry))) continue;
    if (!isExpiredReloadDir(pluginsDir, entry)) continue;
    try {
      fs.rmSync(path.join(pluginsDir, entry), { recursive: true, force: true });
    } catch {
      // Leave it; the next reload retries.
    }
  }
}

export function pruneReloadDirsForType(type: string, opts?: { keepActive?: boolean }): void {
  const pluginsDir = getAdapterPluginsDir();
  const keep = opts?.keepActive ? activeReloadDirs.get(type) : undefined;
  const keepResolved = keep === undefined ? undefined : path.resolve(keep);
  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isReloadDirEntry(entry, type)) continue;
    if (keepResolved !== undefined && path.resolve(pluginsDir, entry) === keepResolved) continue;
    removeReloadDir(path.join(pluginsDir, entry));
  }
  activeReloadDirs.delete(type);
}

export function pruneAllReloadDirs(): void {
  const pluginsDir = getAdapterPluginsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsDir);
  } catch {
    return;
  }
  const keep = new Set([...activeReloadDirs.values()].map((dir) => path.resolve(dir)));
  for (const entry of entries) {
    if (!isAnyReloadDirEntry(entry)) continue;
    if (keep.has(path.resolve(pluginsDir, entry))) continue;
    removeReloadDir(path.join(pluginsDir, entry));
  }
}

function linkSelfImport(reloadDir: string, packageName: string): void {
  const segments = packageName.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    logger.warn({ packageName }, "Skipping self-import link for malformed package name");
    return;
  }
  const linkDir = path.join(reloadDir, "node_modules", ...segments.slice(0, -1));
  const linkPath = path.join(linkDir, segments[segments.length - 1]);
  try {
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(reloadDir, linkPath, "junction");
  } catch (err) {
    logger.warn({ err, packageName }, "Failed to link self-import in reload copy; bare self-imports stay stale");
  }
}

function removeReloadDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leave it; prune on the next reload retries.
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Imports from a unique copy of the package directory: a query string busts
 * only the entry point while nested relative imports resolve to cached URLs.
 * Returns null only when no plugin record exists; staging and import failures
 * throw so routes report 500 with the cause instead of a misleading 404. The
 * previous module stays registered on every failure path. Serialized per
 * type (plus package for npm records); pass `lockHeld` only when the caller
 * already holds this type's keys via withAdapterLocks.
 */
export async function reloadExternalAdapter(
  type: string,
  opts?: { lockHeld?: boolean },
): Promise<ServerAdapterModule | null> {
  if (opts?.lockHeld) return reloadInner(type);
  return withAdapterLocks(lockKeysForType(type), () => reloadInner(type));
}

async function reloadInner(type: string): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const packageDir = resolvePackageDir(record);
  const pluginsDir = getAdapterPluginsDir();
  const reloadDir = path.join(pluginsDir, reloadDirNameForType(type));
  let entryPoint: string;
  try {
    entryPoint = resolvePackageEntryPoint(packageDir);
    // Verbatim symlinks: relative links must keep pointing inside the copy,
    // otherwise they resolve back to the source tree (measured: without
    // verbatimSymlinks a ./nested.js link is recreated as an absolute path).
    fs.cpSync(packageDir, reloadDir, { recursive: true, dereference: false, verbatimSymlinks: true });
    linkSelfImport(reloadDir, record.packageName);
  } catch (err) {
    removeReloadDir(reloadDir);
    throw new Error(
      `Failed to stage reload copy for "${type}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const modulePath = path.join(reloadDir, entryPoint);
    logger.info(
      { type, packageName: record.packageName, modulePath },
      "Reloading external adapter (fresh copy)",
    );

    const mod = await import(pathToFileURL(modulePath).href);
    const adapterModule = validateAdapterModule(mod, record.packageName);
    const uiParserSource = extractUiParserSource(packageDir, record.packageName);

    uiParserCache.delete(type);
    if (uiParserSource) {
      uiParserCache.set(adapterModule.type, uiParserSource);
    }

    // Retain one previous generation: in-flight work on the old module may
    // still read sibling files, so it is pruned only when superseded again.
    const keepDirs = [reloadDir];
    const previous = activeReloadDirs.get(type);
    if (previous) keepDirs.push(previous);
    activeReloadDirs.set(type, reloadDir);
    pruneStaleReloadDirs(pluginsDir, type, keepDirs);

    logger.info(
      { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
      "Successfully reloaded external adapter",
    );

    return adapterModule;
  } catch (err) {
    removeReloadDir(reloadDir);
    throw new Error(
      `Failed to reload adapter "${type}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  pruneAllReloadDirs();
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
