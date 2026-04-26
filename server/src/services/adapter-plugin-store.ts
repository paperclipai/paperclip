/**
 * JSON-file-backed store for external adapter registrations.
 *
 * Stores metadata about externally installed adapter packages at
 * ~/.paperclip/adapter-plugins.json. This is the source of truth for which
 * external adapters should be loaded at startup.
 *
 * Both the plugin store and the settings store are cached in memory after
 * the first read. Writes invalidate the cache so the next read picks up
 * the new state without a redundant disk round-trip.
 *
 * @module server/services/adapter-plugin-store
 */

import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterPluginRecord {
  /** npm package name (e.g., "droid-paperclip-adapter") */
  packageName: string;
  /** Absolute local filesystem path (for locally linked adapters) */
  localPath?: string;
  /** Installed version string (for npm packages) */
  version?: string;
  /** Adapter type identifier (matches ServerAdapterModule.type) */
  type: string;
  /** ISO 8601 timestamp of when the adapter was installed */
  installedAt: string;
  /** Whether this adapter is disabled (hidden from menus but still functional) */
  disabled?: boolean;
}

interface AdapterSettings {
  disabledTypes: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function adapterPluginPaths() {
  const paperclipDir = resolvePaperclipHomeDir();
  return {
    adapterPluginsDir: path.join(paperclipDir, "adapter-plugins"),
    adapterPluginsStorePath: path.join(paperclipDir, "adapter-plugins.json"),
    adapterSettingsPath: path.join(paperclipDir, "adapter-settings.json"),
  };
}

// ---------------------------------------------------------------------------
// In-memory caches (invalidated on write)
// ---------------------------------------------------------------------------

let storeCache: { path: string; records: AdapterPluginRecord[] } | null = null;
let settingsCache: { path: string; settings: AdapterSettings } | null = null;

// ---------------------------------------------------------------------------
// Store functions
// ---------------------------------------------------------------------------

function ensureDirs(): string {
  const { adapterPluginsDir } = adapterPluginPaths();
  fs.mkdirSync(adapterPluginsDir, { recursive: true });
  const pkgJsonPath = path.join(adapterPluginsDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: "paperclip-adapter-plugins",
      version: "0.0.0",
      private: true,
      description: "Managed directory for Paperclip external adapter plugins. Do not edit manually.",
    }, null, 2) + "\n");
  }
  return adapterPluginsDir;
}

function readStore(): AdapterPluginRecord[] {
  const { adapterPluginsStorePath } = adapterPluginPaths();
  if (storeCache?.path === adapterPluginsStorePath) return storeCache.records;
  try {
    const raw = fs.readFileSync(adapterPluginsStorePath, "utf-8");
    const parsed = JSON.parse(raw);
    storeCache = {
      path: adapterPluginsStorePath,
      records: Array.isArray(parsed) ? (parsed as AdapterPluginRecord[]) : [],
    };
  } catch {
    storeCache = { path: adapterPluginsStorePath, records: [] };
  }
  return storeCache.records;
}

function writeStore(records: AdapterPluginRecord[]): void {
  ensureDirs();
  const { adapterPluginsStorePath } = adapterPluginPaths();
  fs.writeFileSync(adapterPluginsStorePath, JSON.stringify(records, null, 2), "utf-8");
  storeCache = { path: adapterPluginsStorePath, records };
}

function readSettings(): AdapterSettings {
  const { adapterSettingsPath } = adapterPluginPaths();
  if (settingsCache?.path === adapterSettingsPath) return settingsCache.settings;
  try {
    const raw = fs.readFileSync(adapterSettingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    settingsCache = {
      path: adapterSettingsPath,
      settings: parsed && Array.isArray(parsed.disabledTypes)
        ? (parsed as AdapterSettings)
        : { disabledTypes: [] },
    };
  } catch {
    settingsCache = { path: adapterSettingsPath, settings: { disabledTypes: [] } };
  }
  return settingsCache.settings;
}

function writeSettings(settings: AdapterSettings): void {
  ensureDirs();
  const { adapterSettingsPath } = adapterPluginPaths();
  fs.writeFileSync(adapterSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
  settingsCache = { path: adapterSettingsPath, settings };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns all registered adapter plugin records from the store. */
export function listAdapterPlugins(): AdapterPluginRecord[] {
  return readStore();
}

/** Adds or replaces an adapter plugin record in the store (keyed by `type`). */
export function addAdapterPlugin(record: AdapterPluginRecord): void {
  const store = [...readStore()];
  const idx = store.findIndex((r) => r.type === record.type);
  if (idx >= 0) {
    store[idx] = record;
  } else {
    store.push(record);
  }
  writeStore(store);
}

/** Removes the adapter plugin with the given type from the store. Returns true if it was found and removed. */
export function removeAdapterPlugin(type: string): boolean {
  const store = [...readStore()];
  const idx = store.findIndex((r) => r.type === type);
  if (idx < 0) return false;
  store.splice(idx, 1);
  writeStore(store);
  return true;
}

/** Returns the adapter plugin record matching the given type, or undefined if not found. */
export function getAdapterPluginByType(type: string): AdapterPluginRecord | undefined {
  return readStore().find((r) => r.type === type);
}

/** Returns the path to the managed adapter plugins directory, creating it if needed. */
export function getAdapterPluginsDir(): string {
  return ensureDirs();
}

// ---------------------------------------------------------------------------
// Adapter enable/disable (settings)
// ---------------------------------------------------------------------------

/** Returns the list of adapter type identifiers that are currently disabled. */
export function getDisabledAdapterTypes(): string[] {
  return readSettings().disabledTypes;
}

/** Returns true if the given adapter type is currently disabled. */
export function isAdapterDisabled(type: string): boolean {
  return readSettings().disabledTypes.includes(type);
}

/** Enables or disables an adapter type. Returns true if the settings were changed. */
export function setAdapterDisabled(type: string, disabled: boolean): boolean {
  const settings = { ...readSettings(), disabledTypes: [...readSettings().disabledTypes] };
  const idx = settings.disabledTypes.indexOf(type);

  if (disabled && idx < 0) {
    settings.disabledTypes.push(type);
    writeSettings(settings);
    return true;
  }
  if (!disabled && idx >= 0) {
    settings.disabledTypes.splice(idx, 1);
    writeSettings(settings);
    return true;
  }
  return false;
}
