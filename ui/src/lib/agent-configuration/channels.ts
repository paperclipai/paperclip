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
      const previous = requireItem(before, channel => channel.id === row.id, t("nov02Core.config061", { v0: row.id }));
      if (row.provider !== previous.provider) throw new Error(t("nov02Core.config062"));
      unique(row.resources.map(resource => resource.id), `channels.${row.id}.resources`);
      for (const resource of row.resources) {
        const existing = requireItem(previous.resources, value => value.id === resource.id, t("nov02Core.config063", { v0: resource.id }));
        requireExplicitFields(existing, resource, `channels.${row.id}.resources.${resource.id}`);
      }
      if (!equal(previous.settings, row.settings)) {
        requireExplicitFields(previous.settings, row.settings, `channels.${row.id}.settings`);
        const changes = Object.fromEntries(Object.entries(row.settings).filter(([key, value]) =>
          !equal(value, previous.settings[key as keyof typeof previous.settings])));
        add(t("nov02Core.config064", { v0: row.id }), () => chatEndpointsApi.update(row.id, changes));
      }
      const resources = previous.resources.map(resource => row.resources.find(value => value.id === resource.id) ?? { ...resource, enabled: false });
      if (!equal(previous.resources, resources)) {
        add(t("nov02Core.config065", { v0: row.id }), () => chatEndpointsApi.updateResources(row.id, resources));
      }
    }
    for (const previous of before) if (!next.some(row => row.id === previous.id)) {
      add(t("nov02Core.config066", { v0: previous.id }), () => chatEndpointsApi.setup(previous.id, { action: "remove" }));
    }
  }
  const operations = document.spec.channelOperations;
  if (!operations) return;
  unique(operations.setup.map(row => row.id), "channelOperations.setup");
  for (const input of operations.create) add(t("nov02Core.config067", { v0: input.provider }), () => chatEndpointsApi.create(companyId, { ...input, assignedAgentId: agentId }));
  for (const operation of operations.setup) {
    const previous = requireItem(before, channel => channel.id === operation.id, t("nov02Core.config068", { v0: operation.id }));
    if (operation.input.action === "remove" && next && !equal(next.find(row => row.id === operation.id), previous)) throw new Error(t("nov02Core.config069", { v0: operation.id }));
    if (next && !next.some(row => row.id === operation.id)) throw new Error(t("nov02Core.config070", { v0: operation.id }));
    add(t("nov02Core.config071", { v0: t(`nov02Core.channelAction.${operation.input.action}`), v1: operation.id }), () => chatEndpointsApi.setup(operation.id, operation.input));
  }
  unique(operations.revokeIdentityLinks.map(row => `${row.endpointId}/${row.principalId}`), "channelOperations.revokeIdentityLinks");
  for (const operation of operations.revokeIdentityLinks) {
    if ((next && !next.some(row => row.id === operation.endpointId)) || operations.setup.some(row => row.id === operation.endpointId && row.input.action === "remove")) throw new Error(t("nov02Core.config072", { v0: operation.endpointId }));
    const channel = requireItem(snapshot.channels, row => row.detail.id === operation.endpointId, t("nov02Core.config073", { v0: operation.endpointId }));
    requireItem(channel.principals, row => row.principalId === operation.principalId, t("nov02Core.config074", { v0: operation.principalId }));
    add(t("nov02Core.config075", { v0: operation.principalId }), () => chatEndpointsApi.revokeLink(operation.endpointId, operation.principalId));
  }
}
