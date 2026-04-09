import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginLoader } from "./plugin-loader.js";
import type { pluginRegistryService } from "./plugin-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface FirstPartyPluginCatalogEntry {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: "first_party";
}

type CatalogDefinition = Omit<FirstPartyPluginCatalogEntry, "localPath"> & {
  relativePath: string;
  legacyPackageNames?: string[];
  legacyRelativePaths?: string[];
};

type ResolvedCatalogDefinition = FirstPartyPluginCatalogEntry & {
  legacyPackageNames: string[];
  legacyLocalPaths: string[];
};

const FIRST_PARTY_PLUGIN_DEFINITIONS: CatalogDefinition[] = [
  {
    packageName: "@goldneuron/plugin-company-pulse",
    pluginKey: "paperclip.hello-world-example",
    displayName: "Pulso da Empresa",
    description: "Widget operacional de dashboard para resumir carga, issues abertas, metas e agentes ativos da empresa.",
    relativePath: "packages/plugins/company-pulse",
    legacyPackageNames: ["@paperclipai/plugin-company-pulse"],
    legacyRelativePaths: ["packages/plugins/examples/plugin-hello-world-example"],
    tag: "first_party",
  },
  {
    packageName: "@goldneuron/plugin-workspace-explorer",
    pluginKey: "paperclip-file-browser-example",
    displayName: "Explorador de Workspace",
    description: "Superfície operacional para navegar workspaces, editar arquivos e abrir referências vindas de comentários.",
    relativePath: "packages/plugins/workspace-explorer",
    legacyPackageNames: ["@paperclipai/plugin-workspace-explorer"],
    legacyRelativePaths: ["packages/plugins/examples/plugin-file-browser-example"],
    tag: "first_party",
  },
  {
    packageName: "@goldneuron/plugin-central-operacoes",
    pluginKey: "paperclip-kitchen-sink-example",
    displayName: "Central de Operações",
    description: "Cockpit operacional para intake, automações, diagnósticos, follow-up, métricas e coordenação entre agentes.",
    relativePath: "packages/plugins/central-operacoes",
    legacyPackageNames: ["@paperclipai/plugin-central-operacoes"],
    legacyRelativePaths: ["packages/plugins/examples/plugin-kitchen-sink-example"],
    tag: "first_party",
  },
];

function resolveFirstPartyPluginCatalog(): ResolvedCatalogDefinition[] {
  return FIRST_PARTY_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const localPath = path.resolve(REPO_ROOT, definition.relativePath);
    if (!existsSync(localPath)) return [];
    return [{
      packageName: definition.packageName,
      pluginKey: definition.pluginKey,
      displayName: definition.displayName,
      description: definition.description,
      localPath,
      legacyPackageNames: definition.legacyPackageNames ?? [],
      legacyLocalPaths: (definition.legacyRelativePaths ?? []).map((relativePath) =>
        path.resolve(REPO_ROOT, relativePath),
      ),
      tag: "first_party" as const,
    }];
  });
}

export function listFirstPartyPluginCatalog(): FirstPartyPluginCatalogEntry[] {
  return resolveFirstPartyPluginCatalog().map(({ legacyPackageNames: _legacyPackageNames, legacyLocalPaths: _legacyLocalPaths, ...entry }) => entry);
}

function buildSyncUpdate(
  plugin: Awaited<ReturnType<ReturnType<typeof pluginRegistryService>["listInstalled"]>>[number],
  entry: ResolvedCatalogDefinition,
  manifest: PaperclipPluginManifestV1,
): {
  packageName?: string;
  packagePath?: string | null;
  version?: string;
  manifest?: PaperclipPluginManifestV1;
} | null {
  const currentPackagePath = plugin.packagePath ? path.resolve(plugin.packagePath) : null;
  const currentDisplayName =
    typeof plugin.manifestJson?.displayName === "string" ? plugin.manifestJson.displayName : null;
  const currentDescription =
    typeof plugin.manifestJson?.description === "string" ? plugin.manifestJson.description : null;
  const isLegacyPackageName = entry.legacyPackageNames.includes(plugin.packageName);
  const isLegacyLocalPath = currentPackagePath ? entry.legacyLocalPaths.includes(currentPackagePath) : false;
  const isRepoManagedPath = currentPackagePath === entry.localPath;
  const shouldTouchRecord = isLegacyPackageName || isLegacyLocalPath || isRepoManagedPath;
  if (!shouldTouchRecord) return null;

  const update: {
    packageName?: string;
    packagePath?: string | null;
    version?: string;
    manifest?: PaperclipPluginManifestV1;
  } = {};

  if (plugin.packageName !== entry.packageName) {
    update.packageName = entry.packageName;
  }

  if (isLegacyLocalPath || isRepoManagedPath) {
    const nextPackagePath = entry.localPath;
    if (plugin.packagePath !== nextPackagePath) {
      update.packagePath = nextPackagePath;
    }
  }

  if (isLegacyLocalPath || isRepoManagedPath) {
    if (
      plugin.version !== manifest.version ||
      currentDisplayName !== manifest.displayName ||
      currentDescription !== manifest.description
    ) {
      update.version = manifest.version;
      update.manifest = manifest;
    }
  }

  return Object.keys(update).length > 0 ? update : null;
}

export async function syncFirstPartyPluginRecords(
  registry: ReturnType<typeof pluginRegistryService>,
  loader: PluginLoader,
): Promise<void> {
  const catalog = resolveFirstPartyPluginCatalog();
  if (catalog.length === 0) return;

  const byKey = new Map(catalog.map((entry) => [entry.pluginKey, entry]));
  const installedPlugins = await registry.listInstalled();

  for (const plugin of installedPlugins) {
    const catalogEntry = byKey.get(plugin.pluginKey);
    if (!catalogEntry) continue;

    const manifest = await loader.loadManifest(catalogEntry.localPath);
    if (!manifest || manifest.id !== catalogEntry.pluginKey) continue;
    const update = buildSyncUpdate(plugin, catalogEntry, manifest);
    if (!update) continue;

    await registry.update(plugin.id, update);
  }
}
