import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issues, issueComments, toolApplications,
  toolConnections, chatEndpoints, chatEndpointResources, chatConversations,
  chatExternalPrincipals, chatIdentityLinks, companyMemberships, chatDeliveries,
  chatMessageLinks, type Db } from "@paperclipai/db";
export async function seedBoundChatAuthorization(db: Db) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(),
    otherIssueId = randomUUID(), runId = randomUUID(), endpointId = randomUUID(),
    resourceId = randomUUID(), conversationId = randomUUID(), principalId = randomUUID(),
    commentId = randomUUID(), deliveryId = randomUUID();
  const provider = "slack", userId = "prepared-chat-user";
  const binding = { companyId, agentId, issueId, runId };
  const context = { source: "chat:slack", paperclipHarnessCheckedOut: true,
    wakeCommentIds: [commentId] };
  await db
    .insert(companies)
    .values({
      id: companyId,
      name: "Reviewed chat",
      issuePrefix: "RCB",
      issueCounter: 1,
    });
  await db
    .insert(agents)
    .values({
      id: agentId,
      companyId,
      name: "Chat runner",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      status: "active",
    });
  await db
    .insert(issues)
    .values({
      id: issueId,
      companyId,
      title: "Reviewed conversation",
      issueNumber: 1,
      identifier: "RCB-1",
      status: "in_review",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
  await db.insert(issues).values({
    id: otherIssueId,
    companyId,
    title: "Unrelated conversation",
    issueNumber: 2,
    identifier: "RCB-2",
    status: "in_review",
    assigneeAgentId: agentId,
  });
  const applicationId = randomUUID(),
    connectionId = randomUUID();
  await db
    .insert(toolApplications)
    .values({
      id: applicationId,
      companyId,
      applicationKey: `chat:${provider}:${endpointId}`,
      name: "Discord",
      type: "chat",
      status: "active",
    });
  await db
    .insert(toolConnections)
    .values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Discord",
      uid: `chat-${provider}-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
  await db
    .insert(chatEndpoints)
    .values({
      id: endpointId,
      companyId,
      connectionId,
      provider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: "guild-1",
      allowUnlinkedPeople: false,
    });
  await db
    .insert(chatEndpointResources)
    .values({
      id: resourceId,
      companyId,
      endpointId,
      type: "channel",
      providerResourceId: "channel-1",
      label: "#review",
      availability: "available",
      enabled: true,
    });
  await db
    .insert(chatConversations)
    .values({
      id: conversationId,
      companyId,
      endpointId,
      resourceId,
      issueId,
      externalConversationId: "channel-1",
      externalThreadId: "thread-1",
      externalLabel: "Review thread",
      state: "active",
    });
  await db
    .insert(chatExternalPrincipals)
    .values({
      id: principalId,
      companyId,
      provider,
      providerAccountId: "guild-1",
      externalId: "user-1",
      kind: "user",
    });
  await db
    .insert(chatIdentityLinks)
    .values({
      companyId,
      endpointId,
      principalId,
      paperclipUserId: userId,
      status: "linked",
    });
  await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
  await db
    .insert(issueComments)
    .values({
      id: commentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: userId,
      body: "Please inspect the earlier photo, without approving completion.",
    });
  await db
    .insert(chatDeliveries)
    .values({
      id: deliveryId,
      companyId,
      endpointId,
      conversationId,
      principalId,
      providerEventId: "review-followup",
      deduplicationKey: "review-followup",
      eventKind: "message",
      normalizedEvent: {},
      state: "processed",
      attempts: 1,
      processedAt: new Date(),
    });
  await db
    .insert(chatMessageLinks)
    .values({
      companyId,
      endpointId,
      conversationId,
      deliveryId,
      commentId,
      providerMessageId: "review-message",
      direction: "inbound",
    });
  return { binding, context, companyId, agentId, issueId, otherIssueId, runId,
    endpointId, resourceId, conversationId, principalId, commentId, deliveryId, userId };
}
