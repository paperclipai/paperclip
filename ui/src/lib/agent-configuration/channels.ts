import { t } from "@/i18n";
import type { AgentConfigurationDocument } from "@paperclipai/shared";
import { chatEndpointsApi } from "../../api/chatEndpoints";
import { equal, type AgentConfigurationSnapshot } from "./load";
import { requireItem, requireExplicitFields, unique, type AddConfigurationStep } from "./steps";

export function planChannelChanges(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, add: AddConfigurationStep) {
  const { id: agentId, companyId } = snapshot.agent;
  const before = snapshot.document.spec.channels!;
  const next = document.spec.channels;
  if (next) {
    unique(next.map(row => row.id), "channels");
    for (const row of next) {
      const previous = requireItem(before, channel => channel.id === row.id, t("display:config_385e787b904f", { value0: row.id }));
      if (row.provider !== previous.provider) throw new Error(t("display:config_4ce7c6fa132e"));
      unique(row.resources.map(resource => resource.id), `channels.${row.id}.resources`);
      for (const resource of row.resources) {
        const existing = requireItem(previous.resources, value => value.id === resource.id, t("display:config_7f71c912d411", { value0: resource.id }));
        requireExplicitFields(existing, resource, `channels.${row.id}.resources.${resource.id}`);
      }
      if (!equal(previous.settings, row.settings)) {
        requireExplicitFields(previous.settings, row.settings, `channels.${row.id}.settings`);
        const changes = Object.fromEntries(Object.entries(row.settings).filter(([key, value]) =>
          !equal(value, previous.settings[key as keyof typeof previous.settings])));
        add(t("display:config_d51c842bacdb", { value0: row.id }), () => chatEndpointsApi.update(row.id, changes));
      }
      const resources = previous.resources.map(resource => row.resources.find(value => value.id === resource.id) ?? { ...resource, enabled: false });
      if (!equal(previous.resources, resources)) {
        add(t("display:config_b8233f1527df", { value0: row.id }), () => chatEndpointsApi.updateResources(row.id, resources));
      }
    }
    for (const previous of before) if (!next.some(row => row.id === previous.id)) {
      add(t("display:config_ebdb0cc23831", { value0: previous.id }), () => chatEndpointsApi.setup(previous.id, { action: "remove" }));
    }
  }
  const operations = document.spec.channelOperations;
  if (!operations) return;
  unique(operations.setup.map(row => row.id), "channelOperations.setup");
  for (const input of operations.create) add(t("display:config_3d7b7a570362", { value0: input.provider }), () => chatEndpointsApi.create(companyId, { ...input, assignedAgentId: agentId }));
  for (const operation of operations.setup) {
    const previous = requireItem(before, channel => channel.id === operation.id, t("display:config_385e787b904f", { value0: operation.id }));
    if (operation.input.action === "remove" && next && !equal(next.find(row => row.id === operation.id), previous)) throw new Error(t("display:config_bfa440512691", { value0: operation.id }));
    if (next && !next.some(row => row.id === operation.id)) throw new Error(t("display:config_2bcf28513893", { value0: operation.id }));
    add(t("display:config_e5467d95eff9", { value0: operation.input.action, value1: operation.id }), () => chatEndpointsApi.setup(operation.id, operation.input));
  }
  unique(operations.revokeIdentityLinks.map(row => `${row.endpointId}/${row.principalId}`), "channelOperations.revokeIdentityLinks");
  for (const operation of operations.revokeIdentityLinks) {
    if ((next && !next.some(row => row.id === operation.endpointId)) || operations.setup.some(row => row.id === operation.endpointId && row.input.action === "remove")) throw new Error(t("display:config_8ba9e51f8efd", { value0: operation.endpointId }));
    const channel = requireItem(snapshot.channels, row => row.detail.id === operation.endpointId, t("display:config_385e787b904f", { value0: operation.endpointId }));
    requireItem(channel.principals, row => row.principalId === operation.principalId, t("display:config_08448d3e9ebf", { value0: operation.principalId }));
    add(t("display:config_9424e88a16d3", { value0: operation.principalId }), () => chatEndpointsApi.revokeLink(operation.endpointId, operation.principalId));
  }
}
