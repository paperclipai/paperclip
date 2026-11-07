import { agentConfigurationDocumentSchema, agentConfigurationInputSchema, type AgentConfigurationInput } from "@paperclipai/shared";
import { equal, profileConfiguration, type AgentConfigurationSnapshot } from "./load";
import { requireItem } from "./steps";

export function resolveAgentConfiguration(snapshot: AgentConfigurationSnapshot, input: AgentConfigurationInput) {
  const document = agentConfigurationInputSchema.parse(input);
  if (document.observed !== undefined && !equal(document.observed, snapshot.document.observed)) {
    throw new Error("observed is read-only. Remove this block and edit spec to change configuration.");
  }
  const before = snapshot.document.spec;
  const spec = { ...before, ...document.spec };
  // Legacy instruction text is omitted from the adapter display, but remains
  // editable explicitly or through Instructions. Other adapter keys retain
  // replacement semantics.
  if (document.spec.adapterConfig && !Object.hasOwn(document.spec.adapterConfig, "promptTemplate") && Object.hasOwn(before.adapterConfig, "promptTemplate")) {
    spec.adapterConfig = { ...document.spec.adapterConfig, promptTemplate: before.adapterConfig.promptTemplate };
  }
  for (const key of ["permissions", "instructions", "tools", "apiKeys", "secrets", "channelOperations", "revisions"] as const) {
    if (document.spec[key]) Object.assign(spec, { [key]: { ...before[key], ...document.spec[key] } });
  }
  if (document.spec.skills) spec.skills = document.spec.skills.map(skill =>
    typeof skill === "string" ? { key: skill, versionId: null } : { ...skill, versionId: skill.versionId ?? null });
  if (document.spec.instructions?.files) {
    const files = { ...before.instructions?.files };
    for (const [path, content] of Object.entries(document.spec.instructions.files)) {
      const existing = snapshot.bundle.files.find(file => file.path === path);
      if (existing && (!existing.editable || existing.binary || existing.virtual)) {
        throw new Error(`Instruction file ${path} cannot be edited as text.`);
      }
      if (content === null) delete files[path];
      else files[path] = content;
    }
    spec.instructions = { ...spec.instructions, files };
  }
  if (document.spec.tools?.connections) spec.tools!.connections = document.spec.tools.connections.map(row => ({ ...row, installed: row.installed ?? true }));
  if (document.spec.tools?.profiles) spec.tools!.profiles = document.spec.tools.profiles.map(row => {
    const existing = row.profileId || row.profileKey
      ? requireItem(snapshot.profiles, profile => (!row.profileId || profile.id === row.profileId)
        && (!row.profileKey || profile.profileKey === row.profileKey), `Profile ${row.profileKey ?? row.profileId}`)
      : null;
    const binding = before.tools?.profiles.find(profile => profile.profileId === existing?.id);
    return {
      profileId: existing?.id ?? null,
      updateSharedDefinition: row.updateSharedDefinition ?? false,
      priority: row.priority ?? binding?.priority ?? 100,
      metadata: row.metadata === undefined ? binding?.metadata ?? null : row.metadata,
      configuration: row.configuration ?? (existing ? profileConfiguration(existing) : undefined),
    };
  });
  if (document.spec.channels) spec.channels = document.spec.channels.map(row => {
    const previous = requireItem(before.channels ?? [], channel => channel.id === row.id, `Channel ${row.id}`);
    return {
      ...previous, ...row,
      settings: { ...previous.settings, ...row.settings },
      resources: row.resources?.map(resource => ({
        ...requireItem(previous.resources, existing => existing.id === resource.id, `Channel resource ${resource.id}`), ...resource,
      })) ?? previous.resources,
    };
  });
  return agentConfigurationDocumentSchema.parse({ ...document, spec, observed: snapshot.document.observed });
}
