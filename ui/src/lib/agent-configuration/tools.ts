import { t } from "@/i18n";
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
  for (const row of next.connections) requireItem(snapshot.connections, connection => connection.id === row.connectionId, t("display:config_2cd653dbc77b", { value0: row.connectionId }));
  const connectionIds = new Set([...before.connections, ...next.connections].map(row => row.connectionId));
  for (const connectionId of connectionIds) {
    const previous = before.connections.find(row => row.connectionId === connectionId) ?? { connectionId, installed: false };
    const installed = next.connections.find(row => row.connectionId === previous.connectionId)?.installed ?? false;
    if (installed === previous.installed) continue;
    const connection = snapshot.connections.find(row => row.id === previous.connectionId)!;
    if (connection.installs?.some(row => row.targetType === "company")) throw new Error(t("display:config_3c93967f48e5", { value0: connection.name }));
    add(t("display:config_15bf9667ed8f", { value0: connection.name }), async () => {
      const current = await toolsApi.getConnectionInstalls(connection.id);
      if (current.installs.some(row => row.targetType === "company") || current.installs.some(row => row.targetType === "agent" && row.targetId === agentId) !== previous.installed) {
        throw new Error(t("display:config_5f34923aa018", { value0: connection.name }));
      }
      const installs = current.installs.filter(row => !(row.targetType === "agent" && row.targetId === agentId))
        .map(({ targetType, targetId }) => ({ targetType, targetId }));
      if (installed) installs.push({ targetType: "agent", targetId: agentId });
      return toolsApi.putConnectionInstalls(connection.id, installs);
    });
  }
  for (const row of next.profiles) {
    const existing = row.profileId ? requireItem(snapshot.profiles, profile => profile.id === row.profileId, t("display:config_27a6356ee1d1", { value0: row.profileId })) : null;
    const previous = before.profiles.find(profile => profile.profileId === row.profileId);
    if (previous && equal({ ...previous, updateSharedDefinition: false }, { ...row, updateSharedDefinition: false })) continue;
    if (existing) {
      requireExplicitFields(profileConfiguration(existing), row.configuration, `tools.profiles.${row.profileId}.configuration`);
      const shared = existing.bindings.some(binding => binding.targetType !== "agent" || binding.targetId !== agentId);
      if (shared && !equal(profileConfiguration(existing), row.configuration) && !row.updateSharedDefinition) {
        throw new Error(t("display:config_66c0b8dbd8fe", { value0: existing.name }));
      }
    }
    add(t("display:config_bee679cbc618", { value0: row.updateSharedDefinition ? t("display:config_8de58bdb237f") : "", value1: row.configuration.name }), async () => {
      let profileId = row.profileId;
      if (!profileId) profileId = (await toolsApi.createProfile(companyId, row.configuration)).id;
      else if (existing && !equal(profileConfiguration(existing), row.configuration)) await toolsApi.updateProfile(profileId, row.configuration);
      return toolsApi.bindProfile(companyId, profileId, { targetType: "agent", targetId: agentId, priority: row.priority, metadata: row.metadata });
    });
  }
  for (const previous of before.profiles) {
    if (!next.profiles.some(row => row.profileId === previous.profileId)) add(t("display:config_57007483090e", { value0: previous.configuration.name }),
      () => toolsApi.unbindProfile(companyId, previous.profileId!, { targetType: "agent", targetId: agentId }));
  }
  for (const row of next.policies) {
    const previous = row.id ? requireItem(before.policies, policy => policy.id === row.id, t("display:config_b41128427140", { value0: row.id })) : null;
    if (previous) requireExplicitFields(previous.configuration, row.configuration, `tools.policies.${row.id}.configuration`);
    const agents = policyAgentIds(row.configuration);
    if (agents.some(id => id !== agentId)) throw new Error(t("display:config_2096be1b4298"));
    const selectors: Record<string, unknown> = { ...row.configuration.selectors, agentIds: [agentId] };
    delete selectors.agentId;
    const configuration = { ...row.configuration, selectors };
    if (previous && equal(previous.configuration, row.configuration)) continue;
    add(t("display:config_97bf07aebaf4", { value0: configuration.name }), () => row.id
      ? toolsApi.updatePolicy(companyId, row.id, configuration)
      : toolsApi.createPolicy(companyId, configuration));
  }
  for (const previous of before.policies) {
    if (!next.policies.some(row => row.id === previous.id)) add(t("display:config_381af9dea8e0", { value0: previous.configuration.name }),
      () => toolsApi.deletePolicy(companyId, previous.id!));
  }
}
