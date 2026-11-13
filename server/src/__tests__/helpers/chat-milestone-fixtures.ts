import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  activityLog, agents, agentWakeupRequests, authUsers,
  caseHandoffs, cases, companyMemberships, chatActions,
  chatConversations, chatEndpoints, chatMessageLinks, chatPublications,
  companies, completionContracts, documentRevisions, documents,
  issueDocuments, type Db, nativeRunFinalizations, nativeRunResults,
  statusDecisions, statusDecisionEffects, workAssessments, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions,
  issues, toolApplications, toolConnections,
} from "@paperclipai/db";

// This owns only fixture data. Each test retains its worker, clock and quiet
// assertions, and must stop the worker before cleanup.
export function createChatMilestoneFixtures(db: Db) {
  const fixtureCompanies: string[] = [];
  const fixtureUsers: string[] = [];
  async function create(companyId: string = randomUUID()) {
    const agentId = randomUUID(), issueId = randomUUID(), endpointId = randomUUID(), conversationId = randomUUID(), commentId = randomUUID(), userId = randomUUID();
    if (!fixtureCompanies.includes(companyId)) {
      fixtureCompanies.push(companyId);
      await db.insert(companies).values({ id: companyId, name: "Milestones", issuePrefix: `M${companyId.slice(0, 7)}` });
    }
    fixtureUsers.push(userId);
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Maya", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: `Chat ${applicationId}`, type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Chat", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "slack", status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Chat" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", body: "Start work" });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, commentId, providerMessageId: commentId, direction: "inbound" });
    return { companyId, agentId, issueId, endpointId, conversationId, commentId, userId };
  }
  async function cleanup() {
    for (const companyId of fixtureCompanies.splice(0)) {
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(caseHandoffs).where(eq(caseHandoffs.companyId, companyId));
      await db.delete(cases).where(eq(cases.companyId, companyId));
      await db.delete(chatActions).where(eq(chatActions.companyId, companyId));
      await db.delete(chatMessageLinks).where(eq(chatMessageLinks.companyId, companyId));
      await db.delete(chatPublications).where(eq(chatPublications.companyId, companyId));
      await db.delete(chatConversations).where(eq(chatConversations.companyId, companyId));
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.companyId, companyId));
      await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
      await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
      await db.delete(statusDecisionEffects).where(eq(statusDecisionEffects.companyId, companyId));
      await db.delete(statusDecisions).where(eq(statusDecisions.companyId, companyId));
      await db.delete(workAssessments).where(eq(workAssessments.companyId, companyId));
      await db.delete(nativeRunResults).where(eq(nativeRunResults.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      await db.delete(completionContracts).where(eq(completionContracts.companyId, companyId));
      await db.delete(issueDocuments).where(eq(issueDocuments.companyId, companyId));
      await db.delete(documentRevisions).where(eq(documentRevisions.companyId, companyId));
      await db.delete(documents).where(eq(documents.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    for (const userId of fixtureUsers.splice(0)) await db.delete(authUsers).where(eq(authUsers.id, userId));
  }
  return { create, cleanup };
}
