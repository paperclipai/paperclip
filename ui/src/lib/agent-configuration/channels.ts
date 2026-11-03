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
      const previous = requireItem(before, channel => channel.id === row.id, `Channel ${row.id}`);
      if (row.provider !== previous.provider) throw new Error("A channel provider cannot be changed. Create a new channel instead.");
      unique(row.resources.map(resource => resource.id), `channels.${row.id}.resources`);
      for (const resource of row.resources) {
        const existing = requireItem(previous.resources, value => value.id === resource.id, `Channel resource ${resource.id}`);
        requireExplicitFields(existing, resource, `channels.${row.id}.resources.${resource.id}`);
      }
      if (!equal(previous.settings, row.settings)) {
        requireExplicitFields(previous.settings, row.settings, `channels.${row.id}.settings`);
        const changes = Object.fromEntries(Object.entries(row.settings).filter(([key, value]) =>
          !equal(value, previous.settings[key as keyof typeof previous.settings])));
        add(`Channel settings: ${row.id}`, () => chatEndpointsApi.update(row.id, changes));
      }
      const resources = previous.resources.map(resource => row.resources.find(value => value.id === resource.id) ?? { ...resource, enabled: false });
      if (!equal(previous.resources, resources)) {
        add(`Channel resources: ${row.id}`, () => chatEndpointsApi.updateResources(row.id, resources));
      }
    }
    for (const previous of before) if (!next.some(row => row.id === previous.id)) {
      add(`Remove channel: ${previous.id}`, () => chatEndpointsApi.setup(previous.id, { action: "remove" }));
    }
  }
  const operations = document.spec.channelOperations;
  if (!operations) return;
  unique(operations.setup.map(row => row.id), "channelOperations.setup");
  for (const input of operations.create) add(`Create ${input.provider} channel`, () => chatEndpointsApi.create(companyId, { ...input, assignedAgentId: agentId }));
  for (const operation of operations.setup) {
    const previous = requireItem(before, channel => channel.id === operation.id, `Channel ${operation.id}`);
    if (operation.input.action === "remove" && next && !equal(next.find(row => row.id === operation.id), previous)) throw new Error(`Channel ${operation.id} cannot be edited and removed in the same save.`);
    if (next && !next.some(row => row.id === operation.id)) throw new Error(`Channel ${operation.id} is both removed and configured.`);
    add(`Channel ${operation.input.action}: ${operation.id}`, () => chatEndpointsApi.setup(operation.id, operation.input));
  }
  unique(operations.revokeIdentityLinks.map(row => `${row.endpointId}/${row.principalId}`), "channelOperations.revokeIdentityLinks");
  for (const operation of operations.revokeIdentityLinks) {
    if ((next && !next.some(row => row.id === operation.endpointId)) || operations.setup.some(row => row.id === operation.endpointId && row.input.action === "remove")) throw new Error(`Channel ${operation.endpointId} cannot be removed and have its identities edited in the same save.`);
    const channel = requireItem(snapshot.channels, row => row.detail.id === operation.endpointId, `Channel ${operation.endpointId}`);
    requireItem(channel.principals, row => row.principalId === operation.principalId, `Identity ${operation.principalId}`);
    add(`Revoke channel identity: ${operation.principalId}`, () => chatEndpointsApi.revokeLink(operation.endpointId, operation.principalId));
  }
}
