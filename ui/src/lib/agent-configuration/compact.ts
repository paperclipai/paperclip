import type { AgentConfigurationDocument, AgentConfigurationInput } from "@paperclipai/shared";

const nonempty = (value: unknown) => value !== null && value !== undefined
  && (typeof value !== "object" || Object.keys(value).length > 0);

export function compactAgentConfiguration(document: AgentConfigurationDocument): AgentConfigurationInput {
  const spec: AgentConfigurationInput["spec"] = { ...document.spec };
  if (spec.adapterConfig && Object.hasOwn(spec.adapterConfig, "promptTemplate")) {
    spec.adapterConfig = { ...spec.adapterConfig };
    delete spec.adapterConfig.promptTemplate;
  }
  for (const key of ["title", "icon", "reportsTo", "capabilities", "defaultEnvironmentId", "metadata", "adapterConfig", "runtimeConfig"] as const) {
    if (!nonempty(spec[key])) delete spec[key];
  }
  if (spec.budgetMonthlyCents === 0) delete spec.budgetMonthlyCents;
  if (spec.permissions) {
    const defaults = { canCreateAgents: false, canCreateSkills: true, canAssignTasks: false, trustPreset: "standard" };
    spec.permissions = Object.fromEntries(Object.entries(spec.permissions).filter(([key, value]) =>
      value !== defaults[key as keyof typeof defaults] && nonempty(value)));
    if (!Object.keys(spec.permissions).length) delete spec.permissions;
  }
  if (spec.instructions?.mode) {
    spec.instructions = {
      mode: spec.instructions.mode,
      ...(spec.instructions.mode === "external" ? { rootPath: spec.instructions.rootPath } : {}),
      entryFile: spec.instructions.entryFile,
    };
  } else if (document.spec.adapterConfig.promptTemplate && spec.instructions) {
    spec.instructions = { entryFile: spec.instructions.entryFile };
  } else delete spec.instructions;
  if (spec.skills?.length) spec.skills = spec.skills.map(skill => typeof skill === "string" || skill.versionId ? skill : skill.key);
  else delete spec.skills;
  const tools = document.spec.tools;
  if (tools) {
    spec.tools = {
      ...(tools.connections.some(row => row.installed) ? {
        connections: tools.connections.filter(row => row.installed).map(row => ({ connectionId: row.connectionId })),
      } : {}),
      ...(tools.profiles.length ? { profiles: tools.profiles.map(row => ({
        ...(row.configuration.profileKey ? { profileKey: row.configuration.profileKey } : { profileId: row.profileId }),
        ...(row.priority !== 100 ? { priority: row.priority } : {}),
        ...(nonempty(row.metadata) ? { metadata: row.metadata } : {}),
      })) } : {}),
      ...(tools.policies.length ? { policies: tools.policies } : {}),
    };
    if (!Object.keys(spec.tools).length) delete spec.tools;
  }
  if (spec.channels?.length) spec.channels = spec.channels.map(row => {
    const settings = Object.fromEntries(Object.entries(row.settings ?? {}).filter(([, value]) => nonempty(value) && value !== ""));
    const resources = row.resources?.filter(resource => resource.enabled).map(resource => ({
      id: resource.id, enabled: true,
      ...(resource.executionDefaults ? { executionDefaults: resource.executionDefaults } : {}),
    }));
    return { id: row.id, provider: row.provider,
      ...(Object.keys(settings).length ? { settings } : {}), ...(resources?.length ? { resources } : {}),
    };
  });
  else delete spec.channels;
  for (const key of ["apiKeys", "secrets", "channelOperations", "revisions"] as const) {
    if (!spec[key]) continue;
    const operations = Object.fromEntries(Object.entries(spec[key]).filter(([, value]) => nonempty(value)));
    if (Object.keys(operations).length) Object.assign(spec, { [key]: operations });
    else delete spec[key];
  }
  return { apiVersion: document.apiVersion, kind: document.kind, spec };
}
