import { resolveBundledCatalogRoot, resolveBundledPluginInstalls, type ResolvedBundledPlugin } from "./bundled-plugins.js";
import { getManagedInstanceConfig, type ManagedConfigEnv, type ManagedInstanceConfig } from "./managed-config.js";

let cache: { config: ManagedInstanceConfig; catalogRoot: string; installs: readonly ResolvedBundledPlugin[] } | null = null;

function managedInstalls(config: ManagedInstanceConfig, env: ManagedConfigEnv) {
  const catalogRoot = resolveBundledCatalogRoot(env);
  if (cache?.config === config && cache.catalogRoot === catalogRoot) return cache.installs;
  const keys = new Set([...Object.keys(config.plugins.workerEnv ?? {}), ...Object.keys(config.plugins.enabledCompanies ?? {})]);
  const installs = resolveBundledPluginInstalls([...keys], { catalogRoot, env, enforceCatalogRoot: true });
  cache = { config, catalogRoot, installs };
  return installs;
}

function managedEntry(section: "workerEnv" | "enabledCompanies", pluginKey: string, env: ManagedConfigEnv): readonly string[] {
  const config = getManagedInstanceConfig(env);
  const entries = config?.plugins[section];
  if (!config || !entries) return [];
  const key = managedInstalls(config, env).find(install => install.pluginKey === pluginKey)?.key;
  return key !== undefined && Object.hasOwn(entries, key) ? entries[key]! : [];
}

export function managedPluginWorkerEnvGrant(pluginKey: string, env: ManagedConfigEnv = process.env): readonly string[] {
  return managedEntry("workerEnv", pluginKey, env);
}

export function managedPluginEnabledCompanies(pluginKey: string, env: ManagedConfigEnv = process.env): readonly string[] {
  return managedEntry("enabledCompanies", pluginKey, env);
}
