import {
  agentConfigurationSpec, canonicalAgentConfiguration,
  type AgentConfigurationDocument, type AgentInstructionsFileDetail, type ToolProfileWithDetails, type ToolPolicy,
} from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { toolsApi } from "../../api/tools";
import { chatEndpointsApi } from "../../api/chatEndpoints";
import { secretsApi } from "../../api/secrets";

export const ownedAdapterKeys = ["paperclipSkillSync", "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath"] as const;
export const equal = (a: unknown, b: unknown) => canonicalAgentConfiguration(a) === canonicalAgentConfiguration(b);
export const jsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export async function mapBounded<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, 4) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await read(items[index]); }
  }));
  return results;
}

export function profileConfiguration(profile: ToolProfileWithDetails) {
  return {
    profileKey: profile.profileKey, name: profile.name, description: profile.description,
    status: profile.status, defaultAction: profile.defaultAction, metadata: profile.metadata,
    entries: profile.entries.map(({ selectorType, effect, applicationId, connectionId, catalogEntryId, toolName, riskLevel, conditions }) =>
      ({ selectorType, effect, applicationId, connectionId, catalogEntryId, toolName, riskLevel, conditions })),
  };
}

export function policyConfiguration(policy: ToolPolicy) {
  const { name, description, policyType, priority, enabled, selectors, conditions, config } = policy;
  return { name, description, policyType, priority, enabled, selectors, conditions, config };
}

export function policyAgentIds(policy: Pick<ToolPolicy, "selectors">): string[] {
  return [policy.selectors.agentId, policy.selectors.agentIds].flatMap(value =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : typeof value === "string" ? [value] : []);
}

export async function loadAgentConfiguration(id: string, companyId: string) {
  const core = await agentsApi.getConfiguration(id, companyId);
  const [agent, bundle, skills, connections, profiles, policies, endpoints, keys, revisions, secrets, proposals] = await Promise.all([
    agentsApi.get(id, companyId), agentsApi.instructionsBundle(id, companyId), agentsApi.skills(id, companyId),
    toolsApi.listConnections(companyId), toolsApi.listProfiles(companyId), toolsApi.listPolicies(companyId),
    chatEndpointsApi.list(companyId), agentsApi.listKeys(id, companyId), agentsApi.listConfigRevisions(id, companyId),
    secretsApi.list(companyId), secretsApi.listProposals(companyId),
  ]);
  const [files, channels] = await Promise.all([
    mapBounded(bundle.files.filter(file => file.editable && !file.binary && !file.virtual), file => agentsApi.instructionsFile(id, file.path, companyId)),
    mapBounded(endpoints.filter(endpoint => endpoint.assignedAgentId === id && endpoint.status !== "archived"), async endpoint => {
      const [detail, resources, principals] = await Promise.all([
        chatEndpointsApi.get(endpoint.id), chatEndpointsApi.listResources(endpoint.id), chatEndpointsApi.listPrincipals(endpoint.id),
      ]);
      if (detail.assignedAgentId !== id || detail.companyId !== companyId) throw new Error("Channel ownership changed. Reload configuration.");
      return { detail, resources, principals };
    }),
  ]);
  const adapterConfig = { ...core.adapterConfig };
  for (const key of ownedAdapterKeys) delete adapterConfig[key];
  const directPolicies = policies.policies.filter(policy => {
    const ids = policyAgentIds(policy); return ids.length > 0 && ids.every(value => value === id);
  });
  const directProfiles = profiles.profiles.flatMap(profile => {
    const binding = profile.bindings.find(binding => binding.targetType === "agent" && binding.targetId === id);
    return binding ? [{ profileId: profile.id, updateSharedDefinition: false, priority: binding.priority, metadata: binding.metadata, configuration: profileConfiguration(profile) }] : [];
  });
  const document = jsonValue({
    apiVersion: "paperclip/v1", kind: "Agent",
    spec: {
      ...agentConfigurationSpec(core), adapterConfig,
      permissions: {
        canCreateAgents: Boolean(agent.permissions.canCreateAgents), canCreateSkills: agent.permissions.canCreateSkills !== false,
        canAssignTasks: Boolean(agent.access?.canAssignTasks), trustPreset: agent.permissions.trustPreset ?? "standard",
        ...(agent.permissions.authorizationPolicy ? { authorizationPolicy: agent.permissions.authorizationPolicy } : {}),
      },
      instructions: { mode: bundle.mode, rootPath: bundle.rootPath, entryFile: bundle.entryFile,
        files: Object.fromEntries(files.map(file => [file.path, file.content])) },
      skills: skills.desiredSkillEntries ?? skills.desiredSkills.map(key => ({ key, versionId: null })),
      tools: {
        connections: connections.connections.map(connection => ({ connectionId: connection.id,
          installed: (connection.installs ?? []).some(install => install.targetType === "agent" && install.targetId === id) })),
        profiles: directProfiles,
        policies: directPolicies.map(policy => ({ id: policy.id, configuration: policyConfiguration(policy) })),
      },
      channels: channels.map(({ detail, resources }) => ({ id: detail.id, provider: detail.provider, settings: {
        executionDefaults: detail.executionDefaults ?? null,
        ...(detail.provider === "slack" ? { communicationInstructions: detail.communicationInstructions ?? "" } : {}),
        allowUnlinkedPeople: detail.allowUnlinkedPeople,
        ...(detail.allowDirectMessages !== undefined ? { allowDirectMessages: detail.allowDirectMessages } : {}),
        ...(detail.provider === "slack" && detail.requireAtMention !== undefined ? { requireAtMention: detail.requireAtMention } : {}),
        ...(detail.allowGroupChats !== undefined ? { allowGroupChats: detail.allowGroupChats } : {}),
        ...(detail.setup?.slackApp ? { slackApp: detail.setup.slackApp } : {}),
        ...(detail.setup?.slackSetupMethod ? { slackSetupMethod: detail.setup.slackSetupMethod } : {}),
      }, resources: resources.map(resource => ({ id: resource.id, enabled: resource.enabled, executionDefaults: resource.executionDefaults ?? null })) })),
      apiKeys: { create: [], revoke: [] }, revisions: { restore: null },
      secrets: { create: [], rotate: [], update: [], proposals: [] },
      channelOperations: { create: [], setup: [], revokeIdentityLinks: [] },
    },
    observed: {
      apiKeys: keys, revisions: revisions.map(({ id, source, changedKeys, createdAt }) => ({ id, source, changedKeys, createdAt })),
      instructionFiles: bundle.files.filter(file => !file.editable || file.binary || file.virtual), instructionWarnings: bundle.warnings,
      skillWarnings: skills.warnings,
      connections: connections.connections.map(connection => ({ id: connection.id, name: connection.name,
        inherited: (connection.installs ?? []).some(install => install.targetType === "company" && install.targetId === companyId) })),
      availableProfiles: profiles.profiles.map(profile => ({ id: profile.id, configuration: profileConfiguration(profile) })),
      inheritedProfiles: profiles.profiles.filter(profile => profile.bindings.some(binding => binding.targetType === "company" && binding.targetId === companyId)).map(profile => ({ id: profile.id, configuration: profileConfiguration(profile) })),
      inheritedPolicies: policies.policies.filter(policy => !directPolicies.includes(policy) && (policyAgentIds(policy).length === 0 || policyAgentIds(policy).includes(id))).map(policy => ({ id: policy.id, configuration: policyConfiguration(policy) })),
      channels: channels.map(({ detail, resources, principals }) => ({ id: detail.id, status: detail.status, botLabel: detail.botLabel, resources, principals })),
      secrets: secrets.map(({ id, name, key, provider, latestVersion }) => ({ id, name, key, provider, latestVersion })),
      secretProposals: proposals.filter(proposal => (proposal.target?.id === id || proposal.proposedBy.id === id)),
    },
  }) as AgentConfigurationDocument;
  return { agent, core, bundle, files: new Map<string, AgentInstructionsFileDetail>(files.map(file => [file.path, file])),
    connections: connections.connections, profiles: profiles.profiles, policies: policies.policies, channels, keys, revisions, secrets, proposals, document };
}

export type AgentConfigurationSnapshot = Awaited<ReturnType<typeof loadAgentConfiguration>>;
