import { canonicalize, resolveBundledCatalogRoot, resolveBundledPluginInstalls, type ResolvedBundledPlugin } from "./bundled-plugins.js";
import { getManagedInstanceConfig, type ManagedConfigEnv } from "./managed-config.js";

let cache: { grants: object; catalogRoot: string; installs: readonly ResolvedBundledPlugin[] } | null = null;

function grantedInstalls(grants: object, env: ManagedConfigEnv) {
  const catalogRoot = resolveBundledCatalogRoot(env);
  if (cache?.grants === grants && cache.catalogRoot === catalogRoot) return cache.installs;
  const installs = resolveBundledPluginInstalls(Object.keys(grants), { catalogRoot, env, enforceCatalogRoot: true });
  cache = { grants, catalogRoot, installs };
  return installs;
}

/**
 * The variable names the control plane grants to this plugin. A grant applies
 * only to the plugin at the catalog path for its key. Any other install with
 * the same plugin key receives nothing.
 */
export function managedPluginWorkerEnvGrant(
  plugin: { pluginKey: string; packagePath?: string | null },
  env: ManagedConfigEnv = process.env,
): readonly string[] {
  const grants = getManagedInstanceConfig(env)?.plugins.workerEnv;
  if (!grants || !plugin.packagePath) return [];
  const install = grantedInstalls(grants, env).find(entry => entry.pluginKey === plugin.pluginKey);
  if (!install || canonicalize(plugin.packagePath) !== canonicalize(install.localPath)) return [];
  return grants[install.key] ?? [];
}
