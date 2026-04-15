/**
 * @fileoverview Adapter management REST API routes
 *
 * This module provides Express routes for managing external adapter plugins:
 * - Listing all registered adapters (built-in + external)
 * - Installing external adapters from npm packages or local paths
 * - Unregistering external adapters
 *
 * All routes require board-level authentication (assertBoard middleware).
 *
 * @module server/routes/adapters
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import {
  listServerAdapters,
  findServerAdapter,
  findActiveServerAdapter,
  listEnabledServerAdapters,
  registerServerAdapter,
  unregisterServerAdapter,
  isOverridePaused,
  setOverridePaused,
} from "../adapters/registry.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  listAdapterPlugins,
  addAdapterPlugin,
  removeAdapterPlugin,
  getAdapterPluginByType,
  getAdapterPluginsDir,
  getDisabledAdapterTypes,
  setAdapterDisabled,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import type { ServerAdapterModule, AdapterConfigSchema } from "../adapters/types.js";
import { loadExternalAdapterPackage, getUiParserSource, getOrExtractUiParserSource, reloadExternalAdapter } from "../adapters/plugin-loader.js";
import { logger } from "../middleware/logger.js";
import { assertBoard } from "./authz.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface AdapterInstallRequest {
  /** npm package name (e.g., "droid-paperclip-adapter") or local path */
  packageName: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
}

interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
  version?: string;
  packageName?: string;
  isLocalPath?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the adapter package directory (same rules as plugin-loader).
 */
function resolveAdapterPackageDir(record: AdapterPluginRecord): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

/**
 * Read `version` from the adapter's package.json on disk.
 * This is the source of truth for what is actually installed (npm or local path).
 */
function readAdapterPackageVersionFromDisk(record: AdapterPluginRecord): string | undefined {
  try {
    const pkgDir = resolveAdapterPackageDir(record);
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

function buildAdapterInfo(adapter: ServerAdapterModule, externalRecord: AdapterPluginRecord | undefined, disabledSet: Set<string>): AdapterInfo {
  const fromDisk = externalRecord ? readAdapterPackageVersionFromDisk(externalRecord) : undefined;
  return {
    type: adapter.type,
    label: adapter.type, // ServerAdapterModule doesn't have a separate "label" field; type serves as label
    source: externalRecord ? "external" : "builtin",
    modelsCount: (adapter.models ?? []).length,
    loaded: true, // If it's in the registry, it's loaded
    disabled: disabledSet.has(adapter.type),
    overriddenBuiltin: externalRecord ? BUILTIN_ADAPTER_TYPES.has(adapter.type) : undefined,
    overridePaused: BUILTIN_ADAPTER_TYPES.has(adapter.type) ? isOverridePaused(adapter.type) : undefined,
    // Prefer on-disk package.json so the UI reflects bumps without relying on store-only fields.
    version: fromDisk ?? externalRecord?.version,
    packageName: externalRecord?.packageName,
    isLocalPath: externalRecord?.localPath ? true : undefined,
  };
}

/**
 * Normalize a local path that may be a Windows path into a WSL-compatible path.
 *
 * - Windows paths (e.g., "C:\\Users\\...") are converted via `wslpath -u`.
 * - Paths already starting with `/mnt/` or `/` are returned as-is.
 */
async function normalizeLocalPath(rawPath: string): Promise<string> {
  // Already a POSIX path (WSL or native Linux)
  if (rawPath.startsWith("/")) {
    return rawPath;
  }

  // Windows path detection: C:\ or C:/ pattern
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    try {
      const { stdout } = await execFileAsync("wslpath", ["-u", rawPath]);
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, rawPath }, "wslpath conversion failed; using path as-is");
      return rawPath;
    }
  }

  return rawPath;
}

/**
 * Register an adapter module into the server registry, filling in
 * sessionManagement from the host.
 */
function registerWithSessionManagement(adapter: ServerAdapterModule): void {
  const wrapped: ServerAdapterModule = {
    ...adapter,
    sessionManagement: getAdapterSessionManagement(adapter.type) ?? undefined,
  };
  registerServerAdapter(wrapped);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function adapterRoutes() {
  const router = Router();

  /**
   * GET /api/adapters
   *
   * List all registered adapters (built-in + external).
   * Each entry includes whether the adapter is built-in or external,
   * its model count, and load status.
   */
  router.get("/adapters", async (_req, res) => {
    assertBoard(_req);

    const registeredAdapters = listServerAdapters();
    const externalRecords = new Map(
      listAdapterPlugins().map((r) => [r.type, r]),
    );
    const disabledSet = new Set(getDisabledAdapterTypes());

    const result: AdapterInfo[] = registeredAdapters.map((adapter) =>
      buildAdapterInfo(adapter, externalRecords.get(adapter.type), disabledSet),
    ).sort((a, b) => a.type.localeCompare(b.type));

    res.json(result);
  });

  /**
   * POST /api/adapters/install
   *
   * Install an external adapter from an npm package or local path.
   *
   * Request body:
   * - packageName: string (required) — npm package name or local path
   * - isLocalPath?: boolean (default false)
   * - version?: string — target version for npm packages
   */
  router.post("/adapters/install", async (req, res) => {
    assertBoard(req);

    const { packageName, isLocalPath = false, version } = req.body as AdapterInstallRequest;

    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required and must be a string." });
      return;
    }

    // Strip version suffix if the UI sends "pkg@1.2.3" instead of separating it
    // e.g. "@henkey/hermes-paperclip-adapter@0.3.0" → packageName + version
    let canonicalName = packageName;
    let explicitVersion = version;
    const versionSuffix = packageName.match(/@(\d+\.\d+\.\d+.*)$/);
    if (versionSuffix) {
      // For scoped packages: "@scope/name@1.2.3" → "@scope/name" + "1.2.3"
      // For unscoped: "name@1.2.3" → "name" + "1.2.3"
      const lastAtIndex = packageName.lastIndexOf("@");
      if (lastAtIndex > 0 && !explicitVersion) {
        canonicalName = packageName.slice(0, lastAtIndex);
        explicitVersion = versionSuffix[1];
      }
    }

    try {
      let installedVersion: string | undefined;
      let moduleLocalPath: string | undefined;

      if (!isLocalPath) {
        // npm install into the managed directory
        const pluginsDir = getAdapterPluginsDir();
        const spec = explicitVersion ? `${canonicalName}@${explicitVersion}` : canonicalName;

        logger.info({ spec, pluginsDir }, "Installing adapter package via npm");

        await execFileAsync("npm", ["install", "--no-save", spec], {
          cwd: pluginsDir,
          timeout: 120_000,
        });

        // Read installed version from package.json
        try {
          const pkgJsonPath = path.join(pluginsDir, "node_modules", canonicalName, "package.json");
          const pkgContent = await import("node:fs/promises");
          const pkgRaw = await pkgContent.readFile(pkgJsonPath, "utf-8");
          const pkg = JSON.parse(pkgRaw);
          const v = pkg.version;
          installedVersion =
            typeof v === "string" && v.trim().length > 0 ? v.trim() : explicitVersion;
        } catch {
          installedVersion = explicitVersion;
        }
      } else {
        // Local path — normalize (e.g., Windows → WSL) and use the resolved path
        moduleLocalPath = path.resolve(await normalizeLocalPath(packageName));
        try {
          const pkgRaw = await readFile(path.join(moduleLocalPath, "package.json"), "utf-8");
          const v = JSON.parse(pkgRaw).version;
          if (typeof v === "string" && v.trim().length > 0) {
            installedVersion = v.trim();
          }
        } catch {
          // leave installedVersion undefined if package.json is missing
        }
      }

      // Load and register the adapter (use canonicalName for path resolution)
      const adapterModule = await loadExternalAdapterPackage(canonicalName, moduleLocalPath);

      // Check if this type conflicts with a built-in adapter
      if (BUILTIN_ADAPTER_TYPES.has(adapterModule.type)) {
        res.status(409).json({
          error: `Adapter type "${adapterModule.type}" is a built-in adapter and cannot be overwritten.`,
        });
        return;
      }

      // Check if already registered (indicates a reinstall/update)
      const existing = findServerAdapter(adapterModule.type);
      const isReinstall = existing !== null;
      if (existing) {
        unregisterServerAdapter(adapterModule.type);
        logger.info({ type: adapterModule.type }, "Unregistered existing adapter for replacement");
      }

      // Register the new adapter
      registerWithSessionManagement(adapterModule);

      // Persist the record (use canonicalName without version suffix)
      const record: AdapterPluginRecord = {
        packageName: canonicalName,
        localPath: moduleLocalPath,
        version: installedVersion ?? explicitVersion,
        type: adapterModule.type,
        installedAt: new Date().toISOString(),
      };
      addAdapterPlugin(record);

      logger.info(
        { type: adapterModule.type, packageName: canonicalName },
        "External adapter installed and registered",
      );

      res.status(201).json({
        type: adapterModule.type,
        packageName: canonicalName,
        version: installedVersion ?? explicitVersion,
        installedAt: record.installedAt,
        requiresRestart: isReinstall,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, packageName }, "Failed to install external adapter");

      // Distinguish npm errors from load errors
      if (message.includes("npm") || message.includes("ERR!")) {
        res.status(500).json({ error: `npm install failed: ${message}` });
      } else {
        res.status(500).json({ error: `Failed to install adapter: ${message}` });
      }
    }
  });

  /**
   * PATCH /api/adapters/:type
   *
   * Enable or disable an adapter. Disabled adapters are hidden from agent
   * creation menus but remain functional for existing agents.
   *
   * Request body: { "disabled": boolean }
   */
  router.patch("/adapters/:type", async (req, res) => {
    assertBoard(req);

    const adapterType = req.params.type;
    const { disabled } = req.body as { disabled?: boolean };

    if (typeof disabled !== "boolean") {
      res.status(400).json({ error: "Request body must include { \"disabled\": true|false }." });
      return;
    }

    // Check that the adapter exists in the registry
    const existing = findServerAdapter(adapterType);
    if (!existing) {
      res.status(404).json({ error: `Adapter "${adapterType}" is not registered.` });
      return;
    }

    const changed = setAdapterDisabled(adapterType, disabled);

    if (changed) {
      logger.info({ type: adapterType, disabled }, "Adapter enabled/disabled");
    }

    res.json({ type: adapterType, disabled, changed });
  });

  /**
   * PATCH /api/adapters/:type/override
   *
   * Pause or resume an external adapter's override of a builtin type.
   * When paused, the server returns the builtin adapter for all new requests
   * (execute, listModels, config schema, etc.).  Already-running sessions
   * keep the adapter they started with.
   */
  router.patch("/adapters/:type/override", async (req, res) => {
    assertBoard(req);

    const adapterType = req.params.type;
    const { paused } = req.body as { paused?: boolean };

    if (typeof paused !== "boolean") {
      res.status(400).json({ error: "\"paused\" (boolean) is required in request body." });
      return;
    }

    if (!BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      res.status(400).json({ error: `Type "${adapterType}" is not a builtin adapter.` });
      return;
    }

    const changed = setOverridePaused(adapterType, paused);

    logger.info({ type: adapterType, paused, changed }, "Adapter override toggle");

    res.json({ type: adapterType, paused, changed });
  });

  /**
   * DELETE /api/adapters/:type
   *
   * Unregister an external adapter. Built-in adapters cannot be removed.
   */
  router.delete("/adapters/:type", async (req, res) => {
    assertBoard(req);

    const adapterType = req.params.type;

    if (!adapterType) {
      res.status(400).json({ error: "Adapter type is required." });
      return;
    }

    // Prevent removal of built-in adapters
    if (BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      res.status(403).json({
        error: `Cannot remove built-in adapter "${adapterType}".`,
      });
      return;
    }

    // Check that the adapter exists in the registry
    const existing = findServerAdapter(adapterType);
    if (!existing) {
      res.status(404).json({
        error: `Adapter "${adapterType}" is not registered.`,
      });
      return;
    }

    // Check that it's an external adapter
    const externalRecord = getAdapterPluginByType(adapterType);
    if (!externalRecord) {
      res.status(404).json({
        error: `Adapter "${adapterType}" is not an externally installed adapter.`,
      });
      return;
    }

    // If installed via npm (has packageName but no localPath), run npm uninstall
    if (externalRecord.packageName && !externalRecord.localPath) {
      try {
        const pluginsDir = getAdapterPluginsDir();
        await execFileAsync("npm", ["uninstall", externalRecord.packageName], {
          cwd: pluginsDir,
          timeout: 60_000,
        });
        logger.info(
          { type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall completed for external adapter",
        );
      } catch (err) {
        logger.warn(
          { err, type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall failed for external adapter; continuing with unregister",
        );
      }
    }

    // Unregister from the runtime registry
    unregisterServerAdapter(adapterType);

    // Remove from the persistent store
    removeAdapterPlugin(adapterType);

    logger.info({ type: adapterType }, "External adapter unregistered and removed");

    res.json({ type: adapterType, removed: true });
  });

  /**
   * POST /api/adapters/:type/reload
   *
   * Reload an external adapter at runtime (for dev iteration without server restart).
   * Busts the ESM module cache, re-imports the adapter, and re-registers it.
   *
   * Cannot be used on built-in adapter types.
   */
  router.post("/adapters/:type/reload", async (req, res) => {
    assertBoard(req);

    const type = req.params.type;

    // Built-in adapters cannot be reloaded unless overridden by an external one
    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      res.status(400).json({ error: "Cannot reload built-in adapter." });
      return;
    }

    // Reload the adapter module (busts ESM cache, re-imports)
    try {
      const newModule = await reloadExternalAdapter(type);

      // Not found in the external adapter store
      if (!newModule) {
        res.status(404).json({ error: `Adapter "${type}" is not an externally installed adapter.` });
        return;
      }

      // Swap in the reloaded module
      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      // Sync store.version from package.json (store may be missing version for local installs).
      const record = getAdapterPluginByType(type);
      let newVersion: string | undefined;
      if (record) {
        newVersion = readAdapterPackageVersionFromDisk(record);
        if (newVersion) {
          addAdapterPlugin({ ...record, version: newVersion });
        }
      }

      logger.info({ type, version: newVersion }, "External adapter reloaded at runtime");

      res.json({ type, version: newVersion, reloaded: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reload external adapter");
      res.status(500).json({ error: `Failed to reload adapter: ${message}` });
    }
  });

  // ── POST /api/adapters/:type/reinstall ──────────────────────────────────
  // Reinstall an npm-sourced external adapter (pulls latest from registry).
  // Local-path adapters cannot be reinstalled — use Reload instead.
  //
  // This is a convenience shortcut for remove + install with the same
  // package name, but without the risk of losing the store record.
  router.post("/adapters/:type/reinstall", async (req, res) => {
    assertBoard(req);

    const type = req.params.type;

    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      res.status(400).json({ error: "Cannot reinstall built-in adapter." });
      return;
    }

    const record = getAdapterPluginByType(type);
    if (!record) {
      res.status(404).json({ error: `Adapter "${type}" is not an externally installed adapter.` });
      return;
    }

    if (record.localPath) {
      res.status(400).json({ error: "Local-path adapters cannot be reinstalled. Use Reload instead." });
      return;
    }

    try {
      const pluginsDir = getAdapterPluginsDir();

      logger.info({ type, packageName: record.packageName }, "Reinstalling adapter package via npm");

      await execFileAsync("npm", ["install", "--no-save", record.packageName], {
        cwd: pluginsDir,
        timeout: 120_000,
      });

      // Reload the freshly installed adapter
      const newModule = await reloadExternalAdapter(type);
      if (!newModule) {
        res.status(500).json({ error: "npm install succeeded but adapter reload failed." });
        return;
      }

      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      // Sync store version from disk
      let newVersion: string | undefined;
      const updatedRecord = getAdapterPluginByType(type);
      if (updatedRecord) {
        newVersion = readAdapterPackageVersionFromDisk(updatedRecord);
        if (newVersion) {
          addAdapterPlugin({ ...updatedRecord, version: newVersion });
        }
      }

      logger.info({ type, version: newVersion }, "Adapter reinstalled from npm");

      res.json({ type, version: newVersion, reinstalled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reinstall adapter");
      res.status(500).json({ error: `Reinstall failed: ${message}` });
    }
  });

  // ── GET /api/adapters/:type/config-schema ────────────────────────────────
  // Serve a declarative config schema for an adapter's UI form fields.
  // The adapter's getConfigSchema() resolves all options (static and dynamic)
  // so the UI receives a fully hydrated schema in a single fetch.
  const configSchemaCache = new Map<string, {
    adapter: ServerAdapterModule;
    schema: AdapterConfigSchema;
    fetchedAt: number;
  }>();
  const CONFIG_SCHEMA_TTL_MS = 30_000;

  router.get("/adapters/:type/config-schema", async (req, res) => {
    assertBoard(req);
    const { type } = req.params;

    const adapter = findActiveServerAdapter(type);
    if (!adapter) {
      res.status(404).json({ error: `Adapter "${type}" is not registered.` });
      return;
    }
    if (!adapter.getConfigSchema) {
      res.status(404).json({ error: `Adapter "${type}" does not provide a config schema.` });
      return;
    }

    const cached = configSchemaCache.get(type);
    if (cached && cached.adapter === adapter && Date.now() - cached.fetchedAt < CONFIG_SCHEMA_TTL_MS) {
      res.json(cached.schema);
      return;
    }

    try {
      const schema = await adapter.getConfigSchema();
      configSchemaCache.set(type, { adapter, schema, fetchedAt: Date.now() });
      res.json(schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to resolve config schema");
      res.status(500).json({ error: `Failed to resolve config schema: ${message}` });
    }
  });

  // ── GET /api/adapters/:type/ui-parser.js ─────────────────────────────────
  // Serve the self-contained UI parser JS for an adapter type.
  // This allows external adapters to provide custom run-log parsing
  // without modifying Paperclip's source code.
  //
  // The adapter package must export a "./ui-parser" entry in package.json
  // pointing to a self-contained ESM module with zero runtime dependencies.
  router.get("/adapters/:type/ui-parser.js", (req, res) => {
    assertBoard(req);
    const { type } = req.params;
    const source = getOrExtractUiParserSource(type);
    if (!source) {
      res.status(404).json({ error: `No UI parser available for adapter "${type}".` });
      return;
    }
    res.type("application/javascript").send(source);
  });

  return router;
}
