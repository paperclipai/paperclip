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
import type { FileFingerprint } from "../services/adapter-plugin-validator.js";
import { fingerprintFromStats } from "../services/adapter-plugin-validator.js";

/**
 * Compare a captured fingerprint against a fresh stat and return a
 * list of `"field before -> after"` mismatches (empty if equal).
 * Multi-field (dev/ino/ctime/mtime/size) — any difference is a
 * mismatch. Used for all three fingerprints (directory, manifest,
 * entry file, ui-parser file) so the rejection message is uniform.
 */
function fingerprintMismatches(
  label: string,
  captured: FileFingerprint,
  stat: fs.Stats,
): string[] {
  const current = fingerprintFromStats(stat);
  const mismatches: string[] = [];
  if (current.dev !== captured.dev) mismatches.push(`${label}.dev ${captured.dev} -> ${current.dev}`);
  if (current.ino !== captured.ino) mismatches.push(`${label}.ino ${captured.ino} -> ${current.ino}`);
  if (current.ctime !== captured.ctime) mismatches.push(`${label}.ctime ${captured.ctime} -> ${current.ctime}`);
  if (current.mtime !== captured.mtime) mismatches.push(`${label}.mtime ${captured.mtime} -> ${current.mtime}`);
  if (current.size !== captured.size) mismatches.push(`${label}.size ${captured.size} -> ${current.size}`);
  return mismatches;
}

/**
 * Run all four fingerprint checks (directory, manifest, entry file,
 * ui-parser file) against fresh stats. Returns a list of mismatch
 * descriptions (empty if everything matches). The caller is expected
 * to throw on a non-empty result.
 */
function verifyAllFingerprints(
  packageName: string,
  packageDir: string,
  pkgJsonPath: string,
  entryPath: string,
  uiParserPath: string | undefined,
  canonicalDirIdentity: FileFingerprint | undefined,
  canonicalManifestIdentity: FileFingerprint | undefined,
  canonicalEntryIdentity: FileFingerprint | undefined,
  canonicalUiParserIdentity: FileFingerprint | undefined,
): string[] {
  const mismatches: string[] = [];
  if (canonicalDirIdentity !== undefined) {
    try {
      mismatches.push(...fingerprintMismatches("dir", canonicalDirIdentity, fs.statSync(packageDir)));
    } catch (err) {
      mismatches.push(`dir: cannot re-stat ${packageDir} at load time: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
  if (canonicalManifestIdentity !== undefined) {
    try {
      mismatches.push(...fingerprintMismatches("manifest", canonicalManifestIdentity, fs.statSync(pkgJsonPath)));
    } catch (err) {
      mismatches.push(`manifest: cannot re-stat ${pkgJsonPath} at load time: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
  if (canonicalEntryIdentity !== undefined) {
    try {
      mismatches.push(...fingerprintMismatches("entry", canonicalEntryIdentity, fs.statSync(entryPath)));
    } catch (err) {
      mismatches.push(`entry: cannot re-stat ${entryPath} at load time: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
  if (canonicalUiParserIdentity !== undefined && uiParserPath !== undefined) {
    try {
      mismatches.push(...fingerprintMismatches("ui-parser", canonicalUiParserIdentity, fs.statSync(uiParserPath)));
    } catch (err) {
      mismatches.push(`ui-parser: cannot re-stat ${uiParserPath} at load time: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
  if (mismatches.length > 0) {
    logger.warn(
      { packageName, packageDir, mismatches },
      "Plugin file fingerprint mismatch — refusing to load (file mutation between validation and load)",
    );
  }
  return mismatches;
}

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

/**
 * Resolve the optional `./ui-parser` export to an absolute path on
 * disk, or undefined if the manifest doesn't declare one. Used by
 * the legacy loader path (no captured ui-parser path from the
 * validator).
 */
function resolveUiParserPath(packageDir: string): string | undefined {
  const pkgJsonPath = path.join(packageDir, "package.json");
  let pkg: { exports?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return undefined;
  }
  if (!pkg.exports || typeof pkg.exports !== "object") return undefined;
  const ui = (pkg.exports as Record<string, unknown>)["./ui-parser"];
  if (!ui) return undefined;
  let file: unknown;
  if (typeof ui === "string") {
    if (path.isAbsolute(ui)) return undefined;
    file = ui;
  } else if (typeof ui === "object" && ui !== null) {
    const u = ui as Record<string, unknown>;
    file = u.import ?? u.default;
  }
  if (typeof file !== "string") return undefined;
  return path.resolve(packageDir, file);
}

/**
 * Read the ui-parser source from a known canonical path (the one
 * captured by the validator). Used when `canonicalUiParserPath` is
 * supplied so we don't re-read package.json at load time (the
 * validator's fingerprint on package.json has already ensured the
 * manifest hasn't changed).
 */
function extractUiParserSourceAt(
  packageDir: string,
  packageName: string,
  canonicalUiParserPath: string,
): string | undefined {
  // Re-check the ui-parser contract version from package.json. This
  // is still safe because the manifest fingerprint (if supplied)
  // has already verified package.json hasn't been mutated.
  const pkgJsonPath = path.join(packageDir, "package.json");
  let pkg: { paperclip?: { adapterUiParser?: unknown } };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return undefined;
  }
  const contractVersion = pkg.paperclip?.adapterUiParser;
  if (typeof contractVersion === "string") {
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
  try {
    const source = fs.readFileSync(canonicalUiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserPath: canonicalUiParserPath, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, canonicalUiParserPath }, "Failed to read UI parser from adapter package");
    return undefined;
  }
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
 * MUST pass the four fingerprints + canonicalEntryPath from
 * `validateExternalPluginLoad(...)` — passing only the path string
 * lets an attacker rewrite the package directory, the manifest, or
 * the entry file between validation and load and defeat the
 * manifest/age/path checks. The fingerprints are a multi-field
 * (dev/ino/ctime/mtime/size) identity — st_ino alone is not
 * sufficient because ext4's inode-recycle cache can return the same
 * inode number to a recreated directory at the same pathname, which
 * CI empirically observed (see PHA-1659 round-4 test failure on
 * `paperclipai:master`). The entry path is the canonical realpath
 * resolved by the validator — the loader uses it directly instead
 * of re-resolving from the manifest, so a manifest mutation between
 * validation and load cannot redirect the import.
 *
 * The legacy `localPath` arg is kept for backward compatibility with
 * internal callers (e.g. the registry) that have already
 * canonicalized via their own path; the public agent-reachable
 * routes MUST use the canonicalDir from the validator. Internal
 * callers without the fingerprint args fall through to the legacy
 * realpath path (no fingerprint check).
 */
export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
  canonicalPackageDir?: string,
  canonicalDirIdentity?: FileFingerprint,
  canonicalManifestIdentity?: FileFingerprint,
  canonicalEntryIdentity?: FileFingerprint,
  canonicalEntryPath?: string,
  canonicalUiParserPath?: string,
  canonicalUiParserIdentity?: FileFingerprint,
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

  // Run all available fingerprints (directory, manifest, entry file,
  // optional ui-parser) against fresh stats. ANY mismatch rejects
  // before any import. The directory check closes path-name TOCTOU
  // (round 3/4); the manifest + entry + ui-parser checks close the
  // file-mutation bypass (round 5) where the agent overwrites files
  // inside the same directory.
  if (
    canonicalDirIdentity !== undefined ||
    canonicalManifestIdentity !== undefined ||
    canonicalEntryIdentity !== undefined ||
    canonicalUiParserIdentity !== undefined
  ) {
    const pkgJsonPath = path.join(packageDir, "package.json");
    // If the validator already captured the entry path, use it for
    // the entry-file stat. Otherwise derive the entry path from the
    // current packageDir (legacy path — no entry fingerprint, so
    // file mutation would not be detected; but the legacy path is
    // only used by internal callers that bypass the validator).
    const entryPathForStat =
      canonicalEntryPath ??
      resolveCanonicalEntryPoint(packageDir, packageName);
    const uiParserPathForStat =
      canonicalUiParserPath ?? resolveUiParserPath(packageDir);

    const mismatches = verifyAllFingerprints(
      packageName,
      packageDir,
      pkgJsonPath,
      entryPathForStat,
      uiParserPathForStat,
      canonicalDirIdentity,
      canonicalManifestIdentity,
      canonicalEntryIdentity,
      canonicalUiParserIdentity,
    );
    if (mismatches.length > 0) {
      throw new Error(
        `Package "${packageName}" files were mutated between validation and load ` +
          `(fingerprint mismatches: ${mismatches.join(", ")})`,
      );
    }
  }

  // Use the canonical entry path captured at validation time if
  // available; otherwise re-resolve from the manifest (legacy path).
  const modulePath =
    canonicalEntryPath ?? resolveCanonicalEntryPoint(packageDir, packageName);
  const uiParserSource =
    canonicalUiParserPath !== undefined
      ? extractUiParserSourceAt(packageDir, packageName, canonicalUiParserPath)
      : extractUiParserSource(packageDir, packageName);

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
 * and we will use it as the package root. The other fingerprint args
 * MUST also come from the validator's `ok: true` decision for the
 * same package; the loader will re-stat the dir / manifest / entry
 * file / ui-parser file and reject if any fingerprint field has
 * changed (path-name TOCTOU closure on the directory, file-mutation
 * bypass closure on the manifest / entry / ui-parser). Otherwise we
 * resolve the record's localPath / node_modules path ourselves.
 * Both paths go through `resolveCanonicalEntryPoint` (or the
 * captured canonicalEntryPath) so an entry-point escape is rejected
 * at reload time.
 */
export async function reloadExternalAdapter(
  type: string,
  canonicalPackageDir?: string,
  canonicalDirIdentity?: FileFingerprint,
  canonicalManifestIdentity?: FileFingerprint,
  canonicalEntryIdentity?: FileFingerprint,
  canonicalEntryPath?: string,
  canonicalUiParserPath?: string,
  canonicalUiParserIdentity?: FileFingerprint,
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

  // Same fingerprint check as loadExternalAdapterPackage. Closes the
  // path-name TOCTOU (directory fingerprint) AND the file-mutation
  // bypass (manifest + entry + ui-parser fingerprints). If any
  // fingerprint fires, we never bust the ESM cache or run the
  // import — fail closed.
  if (
    canonicalDirIdentity !== undefined ||
    canonicalManifestIdentity !== undefined ||
    canonicalEntryIdentity !== undefined ||
    canonicalUiParserIdentity !== undefined
  ) {
    const pkgJsonPath = path.join(packageDir, "package.json");
    const entryPathForStat =
      canonicalEntryPath ?? resolveCanonicalEntryPoint(packageDir, record.packageName);
    const uiParserPathForStat =
      canonicalUiParserPath ?? resolveUiParserPath(packageDir);

    const mismatches = verifyAllFingerprints(
      record.packageName,
      packageDir,
      pkgJsonPath,
      entryPathForStat,
      uiParserPathForStat,
      canonicalDirIdentity,
      canonicalManifestIdentity,
      canonicalEntryIdentity,
      canonicalUiParserIdentity,
    );
    if (mismatches.length > 0) {
      throw new Error(
        `Adapter "${type}" files were mutated between validation and reload ` +
          `(fingerprint mismatches: ${mismatches.join(", ")})`,
      );
    }
  }

  const modulePath =
    canonicalEntryPath ?? resolveCanonicalEntryPoint(packageDir, record.packageName);
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
