import { and, eq, notInArray } from "drizzle-orm";
import { pluginCompanySettings, plugins, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, ProjectExecutionWorkspacePolicy, ProjectWorkspaceProviderConfiguration } from "@paperclipai/shared";
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
  const pluginId = policy?.storageProviderPluginId ?? null;
  const selected = pluginId ? providers.find(plugin => plugin.id === pluginId) : undefined;
  let error: string | null = null;
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
    source: explicit ? "project" : "core",
    pluginId,
    displayName: selected?.manifestJson.displayName ?? (pluginId ? "Unavailable provider" : "Core / local"),
    providers: providers.map(plugin => ({ id: plugin.id, displayName: plugin.manifestJson.displayName,
      isDefault: Boolean(plugin.manifestJson.workspaceProvider?.defaultForProjects) })),
    effectivePolicy,
    error,
  };
}

export function sourcelessProjectWorkspacePolicy(rawPolicy: unknown): ProjectExecutionWorkspacePolicy | null {
  const policy = parseProjectExecutionWorkspacePolicy(rawPolicy);
  if (policy?.storageProviderPluginId === undefined) return policy;
  const { storageProviderPluginId: _storage, ...settings } = policy;
  return Object.keys(settings).some(key => key !== "enabled") ? settings : null;
}

export async function withDefaultProjectStorage(db: ProviderDb, companyId: string, rawPolicy: unknown) {
  if (parseProjectExecutionWorkspacePolicy(rawPolicy)?.storageProviderPluginId !== undefined) return rawPolicy;
  const defaults = (await listProjectWorkspaceProviders(db, companyId))
    .filter(plugin => plugin.manifestJson.workspaceProvider?.defaultForProjects);
  if (defaults.length > 1) {
    throw conflict(`Multiple workspace storage plugins claim the project default: ${defaults.map(plugin => plugin.manifestJson.displayName).sort().join(", ")}. Select a storage provider in project configuration or disable a conflicting provider.`);
  }
  if (!defaults[0]) return rawPolicy;
  return { enabled: true, ...(rawPolicy as Record<string, unknown> | null), storageProviderPluginId: defaults[0].id };
}

export async function effectiveProjectWorkspacePolicy(db: ProviderDb, companyId: string, rawPolicy: unknown, hasGitSource: boolean) {
  const configuration = resolveProjectWorkspaceProvider(rawPolicy, await listProjectWorkspaceProviders(db, companyId), hasGitSource);
  if (configuration.error) throw conflict(configuration.error);
  return configuration.effectivePolicy;
}
