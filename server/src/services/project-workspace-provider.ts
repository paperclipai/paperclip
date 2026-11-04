import { and, eq, notInArray } from "drizzle-orm";
import { pluginCompanySettings, plugins, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, ProjectWorkspaceProviderConfiguration } from "@paperclipai/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { conflict } from "../errors.js";

export function isWorkspaceProvider(manifest: PaperclipPluginManifestV1) {
  return Boolean(manifest.workspaceProvider && manifest.capabilities.includes("workspaces.manage") &&
    manifest.resourceLifecycle?.includes("project"));
}

type ProviderDb = Pick<Db, "select">;

export async function listProjectWorkspaceProviders(db: ProviderDb, companyId: string) {
  const rows = await db.select({ plugin: plugins, enabled: pluginCompanySettings.enabled })
    .from(plugins)
    .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id),
      eq(pluginCompanySettings.companyId, companyId)))
    .where(notInArray(plugins.status, ["disabled", "uninstalled"]));
  return rows.filter(row => row.enabled !== false && isWorkspaceProvider(row.plugin.manifestJson))
    .map(row => row.plugin);
}

type Provider = Awaited<ReturnType<typeof listProjectWorkspaceProviders>>[number];

export function resolveProjectWorkspaceProvider(
  rawPolicy: unknown,
  providers: Provider[],
  hasGitSource: boolean,
): ProjectWorkspaceProviderConfiguration {
  const policy = parseProjectExecutionWorkspacePolicy(rawPolicy);
  const explicit = policy?.storageProviderPluginId !== undefined;
  const defaults = providers.filter(plugin => plugin.manifestJson.workspaceProvider?.defaultForProjects);
  const selected = explicit ? providers.find(plugin => plugin.id === policy?.storageProviderPluginId)
    : defaults.length === 1 ? defaults[0] : undefined;
  const pluginId = explicit ? policy?.storageProviderPluginId ?? null : selected?.id ?? null;
  let error = !explicit && defaults.length > 1
    ? `Multiple workspace storage plugins claim the project default: ${defaults.map(plugin => plugin.manifestJson.displayName).sort().join(", ")}. Select a storage provider in project configuration or disable a conflicting default.`
    : null;
  const declaration = selected?.manifestJson.workspaceProvider;
  const supplied = hasGitSource ? declaration?.defaultForProjects : undefined;
  const effectivePolicy = pluginId ? parseProjectExecutionWorkspacePolicy({
    enabled: true,
    ...(supplied ? { defaultMode: supplied.mode } : {}),
    ...policy,
    storageProviderPluginId: pluginId,
    ...(supplied ? { workspaceStrategy: { type: supplied.strategy, ...policy?.workspaceStrategy } } : {}),
  }) : policy;
  if (pluginId && !selected) error = "The workspace storage plugin is unavailable";
  if (declaration && effectivePolicy && hasGitSource && (
    effectivePolicy.enabled === false ||
    (effectivePolicy.defaultMode && !declaration.modes.includes(effectivePolicy.defaultMode as "isolated_workspace")) ||
    (effectivePolicy.workspaceStrategy?.type && !declaration.strategies.includes(effectivePolicy.workspaceStrategy.type as "git_worktree"))
  )) {
    error = "The storage plugin does not support the explicit project workspace settings. Change the workspace mode or strategy, or select another storage provider in project configuration.";
  }
  return {
    source: explicit ? "project" : selected || error ? "default" : "core",
    pluginId,
    displayName: selected?.manifestJson.displayName ?? (pluginId ? "Unavailable provider" : "Core / local"),
    providers: providers.map(plugin => ({ id: plugin.id, displayName: plugin.manifestJson.displayName,
      isDefault: Boolean(plugin.manifestJson.workspaceProvider?.defaultForProjects) })),
    effectivePolicy,
    error,
  };
}

export async function effectiveProjectWorkspacePolicy(db: ProviderDb, companyId: string, rawPolicy: unknown, hasGitSource: boolean) {
  const configuration = resolveProjectWorkspaceProvider(rawPolicy, await listProjectWorkspaceProviders(db, companyId), hasGitSource);
  if (configuration.error) throw conflict(configuration.error);
  return configuration.effectivePolicy;
}
