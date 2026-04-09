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
import os from "node:os";

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

const PAPERCLIP_DIR = path.join(os.homedir(), ".paperclip");
const ADAPTER_PLUGINS_DIR = path.join(PAPERCLIP_DIR, "adapter-plugins");
const ADAPTER_PLUGINS_STORE_PATH = path.join(PAPERCLIP_DIR, "adapter-plugins.json");
const ADAPTER_SETTINGS_PATH = path.join(PAPERCLIP_DIR, "adapter-settings.json");

// ---------------------------------------------------------------------------
// In-memory caches (invalidated on write)
// ---------------------------------------------------------------------------

let storeCache: AdapterPluginRecord[] | null = null;
let settingsCache: AdapterSettings | null = null;

// ---------------------------------------------------------------------------
// Store functions
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  fs.mkdirSync(ADAPTER_PLUGINS_DIR, { recursive: true });
  const pkgJsonPath = path.join(ADAPTER_PLUGINS_DIR, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: "paperclip-adapter-plugins",
      version: "0.0.0",
      private: true,
      description: "Managed directory for Paperclip external adapter plugins. Do not edit manually.",
    }, null, 2) + "\n");
  }
}

function readStore(): AdapterPluginRecord[] {
  if (storeCache) return storeCache;
  try {
    const raw = fs.readFileSync(ADAPTER_PLUGINS_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    storeCache = Array.isArray(parsed) ? (parsed as AdapterPluginRecord[]) : [];
  } catch {
    storeCache = [];
  }
  return storeCache;
}

function writeStore(records: AdapterPluginRecord[]): void {
  ensureDirs();
  fs.writeFileSync(ADAPTER_PLUGINS_STORE_PATH, JSON.stringify(records, null, 2), "utf-8");
  storeCache = records;
}

function readSettings(): AdapterSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = fs.readFileSync(ADAPTER_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    settingsCache = parsed && Array.isArray(parsed.disabledTypes)
      ? (parsed as AdapterSettings)
      : { disabledTypes: [] };
  } catch {
    settingsCache = { disabledTypes: [] };
  }
  return settingsCache;
}

function writeSettings(settings: AdapterSettings): void {
  ensureDirs();
  fs.writeFileSync(ADAPTER_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  settingsCache = settings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listAdapterPlugins(): AdapterPluginRecord[] {
  return readStore();
}

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

export function removeAdapterPlugin(type: string): boolean {
  const store = [...readStore()];
  const idx = store.findIndex((r) => r.type === type);
  if (idx < 0) return false;
  store.splice(idx, 1);
  writeStore(store);
  return true;
}

export function getAdapterPluginByType(type: string): AdapterPluginRecord | undefined {
  return readStore().find((r) => r.type === type);
}

export function getAdapterPluginsDir(): string {
  ensureDirs();
  return ADAPTER_PLUGINS_DIR;
}

// ---------------------------------------------------------------------------
// Adapter enable/disable (settings)
// ---------------------------------------------------------------------------

export function getDisabledAdapterTypes(): string[] {
  return readSettings().disabledTypes;
}

export function isAdapterDisabled(type: string): boolean {
  return readSettings().disabledTypes.includes(type);
}

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
