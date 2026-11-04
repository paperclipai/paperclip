import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, chatConversations, chatEndpoints, chatMessageLinks,
  chatPublications, connectionIntentDeliveries, companies, companyMemberships, closeRegisteredClients, createDb, heartbeatRuns,
  issueComments, issueThreadInteractions, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveChatRunPresentationAuthorizationReason, enqueueChatRunMilestones } from "./chat-run-publications.js";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON, isChatOriginPublicationCandidate, isExternalChatPresentationContext, resolveHeartbeatRunResponse } from "./heartbeat-run-summary.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";

describe("chat interaction continuation delivery", () => {
  const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("chat-interaction-delivery-");
    db = createDb(externalUrl ?? temporary!.connectionString);
    await db.insert(authUsers).values({ id: "requester", name: "Requester", email: "requester@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); if (externalUrl) await closeRegisteredClients(externalUrl); });
  async function fixture(kind = "request_checkbox_confirmation", status = "accepted") {
    const [company] = await db.insert(companies).values({ name: "Continuation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "requester", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Repository QA", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: "requester" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: company.id, endpointId: endpoint.id, issueId: issue.id, externalConversationId: "test-channel", externalThreadId: randomUUID(), externalLabel: "QA" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "requester", body: "QA the runner migration" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: company.id, endpointId: endpoint.id, conversationId: conversation.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "succeeded", responsibleUserId: "requester", contextSnapshot: {
        source: "chat:slack", issueId: issue.id, endpointId: endpoint.id, wakeCommentId: comment.id,
      } }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: issue.id,
      kind, status, sourceRunId: source.id, payload: { version: 1 } as never,
      result: { version: 1, outcome: "resolved", complete: status === "answered", items: [{ id: "one", verdict: "approve" }] } as never,
    }).returning();
    const isConnection = kind === "connection_intent";
    if (isConnection) await db.insert(connectionIntentDeliveries).values({ companyId: company.id, interactionId: interaction.id });
    const isVerdicts = kind === "request_item_verdicts";
    const payload = { issueId: issue.id, interactionId: interaction.id, interactionKind: kind,
      interactionStatus: status, ...(isConnection ? {} : { sourceRunId: source.id }), mutation: "interaction",
      ...(isVerdicts ? { newlyResolvedItemIds: ["one"] } : {}),
    };
    const sourceName = isVerdicts ? "verdicts" : status === "rejected" ? "reject" : status === "cancelled" ? "cancel" : "accept";
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "running", responsibleUserId: "requester", contextSnapshot: { ...payload, source: isConnection ? "connection_intent.resolved" : `issue.interaction.${sourceName}` },
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "automation", reason: "issue_commented", status: "claimed", runId: successor.id, payload,
      idempotencyKey: isConnection ? `connection-intent:${interaction.id}:${status}` : isVerdicts ? `request_item_verdicts:${issue.id}:${interaction.id}:123` : `interaction:${interaction.id}:${status}`,
    }).returning();
    await db.insert(chatPublications).values({ companyId: company.id, issueId: issue.id, endpointId: endpoint.id,
      conversationId: conversation.id, state: "published", idempotencyKey: `interaction:${interaction.id}:${endpoint.id}`,
      payload: { interactionId: interaction.id, text: "Please review the QA result" },
    });
    const bindings = () => resolveChatOriginPublicationBindings(db, company.id, issue.id, successor.id);
    return { company, agent, issue, endpoint, conversation, source, successor, wake, interaction, bindings };
  }

  it.each([
    ["request_confirmation", "accepted"], ["request_confirmation", "rejected"],
    ["request_checkbox_confirmation", "accepted"], ["request_checkbox_confirmation", "rejected"],
    ["suggest_tasks", "accepted"], ["suggest_tasks", "rejected"],
    ["connection_intent", "accepted"], ["connection_intent", "rejected"],
    ["request_item_verdicts", "answered"], ["request_item_verdicts", "pending"],
  ])("delivers the final response after %s becomes %s", async (kind, status) => {
    const f = await fixture(kind, status);
    expect(await f.bindings()).toEqual([{ companyId: f.company.id, endpointId: f.endpoint.id, conversationId: f.conversation.id }]);
    const authorization = isChatOriginPublicationCandidate(f.successor.contextSnapshot)
      ? await resolveChatRunPresentationAuthorizationReason(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.successor.id }) : null;
    expect(authorization).toBe(CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON);
    const resolved = resolveHeartbeatRunResponse({ resultJson: {},
      existingComment: { id: "bookkeeping", body: "Saved the review." },
      finalAgentMessage: { text: "Verified result delivered.", channel: "final", sourceEventId: "final" },
      preferFinalResponseOverExistingComment: isExternalChatPresentationContext(f.successor.contextSnapshot, authorization === CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON),
    });
    expect(resolved.decision).toMatchObject({ chosenSource: "final_agent_message", commentAction: "create" });
    await enqueueChatRunMilestones(db);
    const published = await db.select().from(chatPublications).where(and(eq(chatPublications.issueId, f.issue.id), eq(chatPublications.idempotencyKey, `run:${f.successor.id}:working:${f.endpoint.id}`)));
    expect(published).toHaveLength(1);
    expect(published[0].conversationId).toBe(f.conversation.id);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.successor.id));
  });

  it.each(["wake", "source", "agent", "conversation", "internal"])("withholds replies with invalid %s authority", async fault => {
    const f = await fixture();
    if (fault === "wake") await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "source") await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, f.interaction.id));
    if (fault === "agent") {
      const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", adapterType: "process" }).returning();
      await db.update(agentWakeupRequests).set({ agentId: other.id }).where(eq(agentWakeupRequests.id, f.wake.id));
    }
    if (fault === "conversation") {
      const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Unrelated task" }).returning();
      await db.update(chatConversations).set({ issueId: other.id }).where(eq(chatConversations.id, f.conversation.id));
    }
    if (fault === "internal") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.successor.contextSnapshot, source: "issue.assigned" } }).where(eq(heartbeatRuns.id, f.successor.id));
    expect(await f.bindings()).toEqual([]);
  });

  it.each(["key", "unsaved", "payload", "skipped"])("rejects an item-review wake with %s proof", async fault => {
    const f = await fixture("request_item_verdicts", "pending");
    if (fault === "key") await db.update(agentWakeupRequests).set({ idempotencyKey: "forged" }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "unsaved") await db.update(issueThreadInteractions).set({ result: null }).where(eq(issueThreadInteractions.id, f.interaction.id));
    if (fault === "payload") await db.update(agentWakeupRequests).set({ payload: { ...f.wake.payload, newlyResolvedItemIds: ["not-saved"] } }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "skipped") await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(await f.bindings()).toEqual([]);
  });
  it.each(["accepted", "rejected"])("delivers an automation-origin connection %s through its published Slack prompt", async status => {
    const f = await fixture("connection_intent", status);
    await db.update(heartbeatRuns).set({ contextSnapshot: { source: "automation", issueId: f.issue.id } }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await f.bindings()).toEqual([{ companyId: f.company.id, endpointId: f.endpoint.id, conversationId: f.conversation.id }]);
    expect(await resolveChatRunPresentationAuthorizationReason(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.successor.id })).toBe(CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.successor.id));
  });

  it.each(["publication", "receipt"])("withholds automation-origin connection replies without the %s", async missing => {
    const f = await fixture("connection_intent", "rejected");
    await db.update(heartbeatRuns).set({ contextSnapshot: { source: "automation", issueId: f.issue.id } }).where(eq(heartbeatRuns.id, f.source.id));
    if (missing === "publication") await db.update(chatPublications).set({ state: "pending" }).where(eq(chatPublications.issueId, f.issue.id));
    if (missing === "receipt") await db.delete(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, f.interaction.id));
    expect(await f.bindings()).toEqual([]);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.successor.id));
  });

  it.each(["delivery", "wake", "key", "pending", "source"])("rejects connection continuation with missing %s proof", async fault => {
    const f = await fixture("connection_intent", "rejected");
    if (fault === "delivery") await db.delete(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, f.interaction.id));
    if (fault === "wake") await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "key") await db.update(agentWakeupRequests).set({ idempotencyKey: "forged" }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "pending") await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, f.interaction.id));
    if (fault === "source") await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, f.interaction.id));
    expect(await f.bindings()).toEqual([]);
  });

});
