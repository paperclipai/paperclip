import { chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatGitHubConfigurations } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const authorizationEvent = sql<Record<string, unknown>>`case
  when jsonb_typeof(${chatDeliveries.normalizedEvent}) = 'object' then (
    select coalesce(jsonb_object_agg(field.key, case
      when jsonb_typeof(field.value->'context') = 'object' then
        jsonb_build_object('context', (field.value->'context') - 'body' - 'title')
      else field.value end), '{}'::jsonb)
    from jsonb_each(${chatDeliveries.normalizedEvent}) as field(key, value)
    where field.key in ('githubAutomatic', 'githubIssue')
  ) else ${chatDeliveries.normalizedEvent} end`;

export const githubResponseAuthorityFields = {
  endpoint: {
    id: chatEndpoints.id,
    companyId: chatEndpoints.companyId,
    assignedAgentId: chatEndpoints.assignedAgentId,
    botExternalId: chatEndpoints.botExternalId,
    botUsername: chatEndpoints.botUsername,
    provider: chatEndpoints.provider,
    status: chatEndpoints.status,
    allowUnlinkedPeople: chatEndpoints.allowUnlinkedPeople,
    setup: sql<unknown>`case when jsonb_typeof(${chatEndpoints.setup}) = 'object'
      then jsonb_build_object('runtimeGeneration', ${chatEndpoints.setup}->'runtimeGeneration')
      else ${chatEndpoints.setup} end`,
  },
  conversation: {
    id: chatConversations.id,
    issueId: chatConversations.issueId,
    externalThreadId: chatConversations.externalThreadId,
  },
  delivery: {
    id: chatDeliveries.id,
    principalId: chatDeliveries.principalId,
    state: chatDeliveries.state,
    createdAt: chatDeliveries.createdAt,
    normalizedEvent: authorizationEvent,
  },
  resource: {
    enabled: chatEndpointResources.enabled,
    availability: chatEndpointResources.availability,
    providerResourceId: chatEndpointResources.providerResourceId,
    metadata: sql<typeof chatEndpointResources.$inferSelect["metadata"]>`case
      when jsonb_typeof(${chatEndpointResources.metadata}) = 'object'
        then jsonb_build_object('providerRepositoryId', ${chatEndpointResources.metadata}->'providerRepositoryId')
      else ${chatEndpointResources.metadata} end`,
  },
  toolsEnabled: sql<unknown>`${chatGitHubConfigurations.configuration}->'toolsEnabled'`,
};
