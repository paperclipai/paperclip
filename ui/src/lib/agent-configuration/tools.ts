import type { AgentConfigurationDocument } from "@paperclipai/shared";
import { toolsApi } from "../../api/tools";
import { equal, policyAgentIds, profileConfiguration, type AgentConfigurationSnapshot } from "./load";
import { requireItem, requireExplicitFields, unique, type AddConfigurationStep } from "./steps";

export function planToolChanges(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, add: AddConfigurationStep) {
  const next = document.spec.tools;
  if (!next) return;
  const before = snapshot.document.spec.tools!;
  const { id: agentId, companyId } = snapshot.agent;
  unique(next.connections.map(row => row.connectionId), "tools.connections");
  unique(next.profiles.flatMap(row => row.profileId ? [row.profileId] : []), "tools.profiles");
  unique(next.policies.flatMap(row => row.id ? [row.id] : []), "tools.policies");
  for (const row of next.connections) requireItem(snapshot.connections, connection => connection.id === row.connectionId, `Connection ${row.connectionId}`);
  const connectionIds = new Set([...before.connections, ...next.connections].map(row => row.connectionId));
  for (const connectionId of connectionIds) {
    const previous = before.connections.find(row => row.connectionId === connectionId) ?? { connectionId, installed: false };
    const installed = next.connections.find(row => row.connectionId === previous.connectionId)?.installed ?? false;
    if (installed === previous.installed) continue;
    const connection = snapshot.connections.find(row => row.id === previous.connectionId)!;
    if (connection.installs?.some(row => row.targetType === "company")) throw new Error(`${connection.name} is installed organization-wide. Its inherited installation cannot be overridden for one agent.`);
    add(`Tool installation: ${connection.name}`, async () => {
      const current = await toolsApi.getConnectionInstalls(connection.id);
      if (current.installs.some(row => row.targetType === "company") || current.installs.some(row => row.targetType === "agent" && row.targetId === agentId) !== previous.installed) {
        throw new Error(`Installation for ${connection.name} changed. Reload before saving.`);
      }
      const installs = current.installs.filter(row => !(row.targetType === "agent" && row.targetId === agentId))
        .map(({ targetType, targetId }) => ({ targetType, targetId }));
      if (installed) installs.push({ targetType: "agent", targetId: agentId });
      return toolsApi.putConnectionInstalls(connection.id, installs);
    });
  }
  for (const row of next.profiles) {
    const existing = row.profileId ? requireItem(snapshot.profiles, profile => profile.id === row.profileId, `Profile ${row.profileId}`) : null;
    const previous = before.profiles.find(profile => profile.profileId === row.profileId);
    if (previous && equal({ ...previous, updateSharedDefinition: false }, { ...row, updateSharedDefinition: false })) continue;
    if (existing) {
      requireExplicitFields(profileConfiguration(existing), row.configuration, `tools.profiles.${row.profileId}.configuration`);
      const shared = existing.bindings.some(binding => binding.targetType !== "agent" || binding.targetId !== agentId);
      if (shared && !equal(profileConfiguration(existing), row.configuration) && !row.updateSharedDefinition) {
        throw new Error(`Profile ${existing.name} is shared with other targets. Set updateSharedDefinition: true to change its shared definition, or create a separate profile with profileId: null.`);
      }
    }
    add(`Tool profile${row.updateSharedDefinition ? " (shared definition)" : ""}: ${row.configuration.name}`, async () => {
      let profileId = row.profileId;
      if (!profileId) profileId = (await toolsApi.createProfile(companyId, row.configuration)).id;
      else if (existing && !equal(profileConfiguration(existing), row.configuration)) await toolsApi.updateProfile(profileId, row.configuration);
      return toolsApi.bindProfile(companyId, profileId, { targetType: "agent", targetId: agentId, priority: row.priority, metadata: row.metadata });
    });
  }
  for (const previous of before.profiles) {
    if (!next.profiles.some(row => row.profileId === previous.profileId)) add(`Unbind tool profile: ${previous.configuration.name}`,
      () => toolsApi.unbindProfile(companyId, previous.profileId!, { targetType: "agent", targetId: agentId }));
  }
  for (const row of next.policies) {
    const previous = row.id ? requireItem(before.policies, policy => policy.id === row.id, `Agent policy ${row.id}`) : null;
    if (previous) requireExplicitFields(previous.configuration, row.configuration, `tools.policies.${row.id}.configuration`);
    const agents = policyAgentIds(row.configuration);
    if (agents.some(id => id !== agentId)) throw new Error("tools.policies must be scoped only to this agent.");
    const selectors: Record<string, unknown> = { ...row.configuration.selectors, agentIds: [agentId] };
    delete selectors.agentId;
    const configuration = { ...row.configuration, selectors };
    if (previous && equal(previous.configuration, row.configuration)) continue;
    add(`Tool policy: ${configuration.name}`, () => row.id
      ? toolsApi.updatePolicy(companyId, row.id, configuration)
      : toolsApi.createPolicy(companyId, configuration));
  }
  for (const previous of before.policies) {
    if (!next.policies.some(row => row.id === previous.id)) add(`Remove tool policy: ${previous.configuration.name}`,
      () => toolsApi.deletePolicy(companyId, previous.id!));
  }
}
