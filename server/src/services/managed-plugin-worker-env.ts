import { canonicalize, resolveBundledCatalogRoot, resolveBundledPluginInstalls, type ResolvedBundledPlugin } from "./bundled-plugins.js";
import { getManagedInstanceConfig, type ManagedConfigEnv, type ManagedInstanceConfig } from "./managed-config.js";

type ManagedPlugin = { pluginKey: string; packagePath?: string | null };

let cache: { config: ManagedInstanceConfig; catalogRoot: string; installs: readonly ResolvedBundledPlugin[] } | null = null;

function managedInstalls(config: ManagedInstanceConfig, env: ManagedConfigEnv) {
  const catalogRoot = resolveBundledCatalogRoot(env);
  if (cache?.config === config && cache.catalogRoot === catalogRoot) return cache.installs;
  const keys = new Set([...Object.keys(config.plugins.workerEnv ?? {}), ...Object.keys(config.plugins.enabledCompanies ?? {})]);
  const installs = resolveBundledPluginInstalls([...keys], { catalogRoot, env, enforceCatalogRoot: true });
  cache = { config, catalogRoot, installs };
  return installs;
}

/**
 * The catalog key of a plugin the control plane manages. It matches only the
 * plugin at the catalog path for its key. Any other install with the same
 * plugin key is not managed.
 */
function managedCatalogKey(config: ManagedInstanceConfig, plugin: ManagedPlugin, env: ManagedConfigEnv) {
  if (!plugin.packagePath) return null;
  const install = managedInstalls(config, env).find(entry => entry.pluginKey === plugin.pluginKey);
  return install && canonicalize(plugin.packagePath) === canonicalize(install.localPath) ? install.key : null;
}

/** The variable names the control plane grants to this plugin's worker. */
export function managedPluginWorkerEnvGrant(plugin: ManagedPlugin, env: ManagedConfigEnv = process.env): readonly string[] {
  const config = getManagedInstanceConfig(env);
  const key = config && managedCatalogKey(config, plugin, env);
  return (key && config.plugins.workerEnv?.[key]) || [];
}

/** The companies this plugin may serve with no saved configuration. */
export function managedPluginEnabledCompanies(plugin: ManagedPlugin, env: ManagedConfigEnv = process.env): readonly string[] {
  const config = getManagedInstanceConfig(env);
  const key = config && managedCatalogKey(config, plugin, env);
  return (key && config.plugins.enabledCompanies?.[key]) || [];
}
