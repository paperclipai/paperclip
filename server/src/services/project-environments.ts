import { and, eq, notInArray } from "drizzle-orm";
import { agents, builtInManagedResources, userCompanyPreferences, type Db } from "@paperclipai/db";
import type { ProjectEnvironmentOptions } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { listProjectWorkspaceProviders, projectStorageForEnvironment } from "./project-workspace-provider.js";

export interface ProjectCreationEnvironment {
  userId?: string | null;
  agentId?: string | null;
  environmentId?: string;
  expectedStorageProviderPluginId?: string | null;
}

export async function projectEnvironmentOptions(db: Db, companyId: string, actor: ProjectCreationEnvironment = {}): Promise<ProjectEnvironmentOptions> {
  const svc = environmentService(db);
  const [settings, environments, providers, bindings] = await Promise.all([
    instanceSettingsService(db).get(),
    svc.list({ status: "active" }),
    listProjectWorkspaceProviders(db, companyId),
    db.select({ environmentId: builtInManagedResources.resourceId, companyId: builtInManagedResources.companyId })
      .from(builtInManagedResources).where(eq(builtInManagedResources.resourceKind, "environment")),
  ]);
  let preferredEnvironmentId = settings.defaultEnvironmentId;
  if (actor.agentId || actor.userId) {
    const candidates = db.select({ environmentId: agents.defaultEnvironmentId }).from(agents);
    const [agent] = actor.agentId
      ? await candidates.where(and(eq(agents.companyId, companyId), eq(agents.id, actor.agentId)))
      : await candidates.innerJoin(userCompanyPreferences, and(eq(userCompanyPreferences.primaryAgentId, agents.id),
        eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.userId, actor.userId!)))
        .where(and(eq(agents.companyId, companyId), notInArray(agents.status, ["terminated", "pending_approval"])));
    preferredEnvironmentId = agent?.environmentId ?? preferredEnvironmentId;
  }
  let preferred = environments.find(environment => environment.id === preferredEnvironmentId)
    ?? (!preferredEnvironmentId ? environments.find(environment => environment.driver === "local") : undefined);
  const forcedKubernetes = settings.general.executionMode === "kubernetes";
  const managedOnly = settings.experimental.enableManagedSandboxOnly === true;
  if (forcedKubernetes) {
    preferred = environments.find(environment => environment.driver === "sandbox" && environment.metadata?.managedKubernetesSandbox === true);
  } else if (managedOnly && (!preferred || preferred.driver === "local")) {
    preferred = environments.find(environment => environment.driver === "sandbox" && environment.metadata?.managedByPaperclip === true);
  }

  const groups: ProjectEnvironmentOptions["groups"] = [];
  for (const environment of environments) {
    const owners = bindings.filter(binding => binding.environmentId === environment.id);
    if (owners.length && !owners.some(binding => binding.companyId === companyId)) continue;
    if (forcedKubernetes && environment.id !== preferred?.id) continue;
    if (managedOnly && environment.driver === "local") continue;
    const storage = projectStorageForEnvironment(environment, providers);
    if (!storage) continue;
    let group = groups.find(value => value.storageProviderPluginId === storage.pluginId);
    if (!group) {
      group = { storageProviderPluginId: storage.pluginId, environments: [] };
      groups.push(group);
    }
    group.environments.push({ id: environment.id, name: environment.name });
  }
  for (const group of groups) group.environments.sort((a, b) => a.name.localeCompare(b.name));
  groups.sort((a, b) => a.environments[0].name.localeCompare(b.environments[0].name));
  const defaultAvailable = preferred && groups.some(group => group.environments.some(environment => environment.id === preferred.id));
  return {
    groups,
    defaultEnvironmentId: defaultAvailable ? preferred?.id ?? null : null,
    error: !defaultAvailable && (preferredEnvironmentId || forcedKubernetes || managedOnly || environments.length > 0)
      ? "The default environment cannot use project workspace storage. Select an available environment or repair the default environment configuration."
      : null,
  };
}

export async function withDefaultProjectStorage(db: Db, companyId: string, rawPolicy: unknown, actor: ProjectCreationEnvironment = {}) {
  const policy = parseProjectExecutionWorkspacePolicy(rawPolicy);
  if (policy?.storageProviderPluginId !== undefined && !actor.environmentId && actor.expectedStorageProviderPluginId === undefined) return rawPolicy;
  const options = await projectEnvironmentOptions(db, companyId, actor);
  const environmentId = actor.environmentId ?? options.defaultEnvironmentId;
  const group = options.groups.find(value => value.environments.some(environment => environment.id === environmentId));
  if (actor.environmentId && !group) throw conflict("The selected environment is unavailable for this project. Select an available environment.", { code: "project_environment_unavailable" });
  if (!actor.environmentId && options.error) throw conflict(options.error, { code: "project_environment_unavailable" });
  const pluginId = group?.storageProviderPluginId ?? null;
  if (actor.expectedStorageProviderPluginId !== undefined && actor.expectedStorageProviderPluginId !== pluginId) {
    throw conflict("The environment's project storage changed. Review the available environments and retry.", { code: "project_environment_incompatible" });
  }
  if (policy?.storageProviderPluginId !== undefined && policy.storageProviderPluginId !== pluginId) {
    throw conflict("The selected environment cannot use the requested project workspace storage.", { code: "project_environment_incompatible" });
  }
  return pluginId || policy?.storageProviderPluginId !== undefined
    ? { enabled: true, ...policy, storageProviderPluginId: pluginId }
    : rawPolicy;
}
