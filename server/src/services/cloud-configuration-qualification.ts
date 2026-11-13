import type { Db } from "@paperclipai/db";
import { BUNDLED_PLUGIN_CATALOG, resolveBundledCatalogRoot, resolveBundledPluginInstalls, resolveManagedBundledPluginKeys, type ResolvedBundledPlugin } from "./bundled-plugins.js";
import { readDistributionPluginCatalog } from "./distribution-plugin-catalog.js";
import { createBundledPluginPackageResolver } from "./bundled-plugin-package.js";
import { cloudConfigurationMigrationService } from "./cloud-configuration-migration.js";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import { getManagedInstanceConfig } from "./managed-config.js";
import { pluginLoader } from "./plugin-loader.js";

export async function qualifyCloudConfigurationForCurrentImage(db: Db, options: {
  runtimeEnv?: CloudInstanceEnv;
  expectedPackageEvidenceDigest?: string;
} = {}) {
  const env = options.runtimeEnv ?? process.env;
  if (!isCloudManagedInstance(env)) return null;
  const service = cloudConfigurationMigrationService(db, { runtimeEnv: env });
  const catalogRoot = resolveBundledCatalogRoot(env);
  let installs: ResolvedBundledPlugin[];
  try {
    const distribution = readDistributionPluginCatalog(catalogRoot, BUNDLED_PLUGIN_CATALOG);
    installs = resolveBundledPluginInstalls(resolveManagedBundledPluginKeys(getManagedInstanceConfig(env)?.plugins.autoInstall, env) ?? [], {
      catalogRoot, env, enforceCatalogRoot: true, distributionPlugins: distribution,
    });
  } catch {
    return service.qualify({ installs: [], loadManifest: async () => null, imageCatalogUnavailable: true, expectedPackageEvidenceDigest: options.expectedPackageEvidenceDigest });
  }
  const resolver = createBundledPluginPackageResolver(installs);
  const loader = pluginLoader(db, {
    prebuiltOnly: true, enableLocalFilesystem: false, enableNpmDiscovery: false,
    assertPackageActivation: resolver.assertActivation, resolvePackageRoot: resolver.resolve,
  });
  return service.qualify({ installs, catalogRoot, loadManifest: (root) => loader.loadManifest(root), expectedPackageEvidenceDigest: options.expectedPackageEvidenceDigest });
}
