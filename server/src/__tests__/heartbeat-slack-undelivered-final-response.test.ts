import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, chatConversations, chatDeliveries, chatEndpointResources,
  chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks,
  companies, companyMemberships, createDb, issueComments, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import {
  registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const conversationGuidance = "## Communication in Slack\nConversation guidance canary.";
const undeliveredNotice = "A Slack message did not start this run";
const destination = "(channel C-ORIGIN, thread_ts 1700000000.000100)";
const markdownKeys = [
  "paperclipTaskMarkdown",
  "paperclipTaskMarkdownCompact",
  "paperclipTaskMarkdownAssignment",
  "paperclipTaskMarkdownAssignmentCompact",
];

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;
if (!postgresSupport.supported) {
  console.warn(`Skipping Slack final response guidance tests: ${postgresSupport.reason ?? "embedded Postgres unavailable"}`);
}

describePostgres("Slack final response delivery in heartbeat guidance", () => {
  const adapterType = "slack_final_response_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("slack-final-response-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "slack-final-session", resultJson: {} };
      },
      testEnvironment: async () => ({
        adapterType, status: "pass", checks: [], testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), teammateId = randomUUID(), issueId = randomUUID();
    const endpointId = randomUUID(), resourceId = randomUUID(), conversationId = randomUUID();
    const applicationId = randomUUID(), connectionId = randomUUID(), principalId = randomUUID();
    const userId = `slack-final-user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Requester", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Slack final response fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Coordinator", adapterType, status: "idle" },
      { id: teammateId, companyId, name: "Planner", adapterType, status: "idle" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:slack:${endpointId}`, name: "Slack", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: endpointId, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "slack", publicId: randomUUID(),
      assignedAgentId: agentId, status: "active", providerAccountId: "T-ORIGIN",
      setup: { step: "complete", command: "/coordinator" },
      allowDirectMessages: true, allowUnlinkedPeople: false,
    });
    await db.insert(chatEndpointResources).values({ id: resourceId, companyId, endpointId, type: "channel", providerResourceId: "C-ORIGIN", label: "requests", availability: "available", enabled: true });
    await db.insert(issues).values({ id: issueId, companyId, title: "Slack request", description: "Plan the requested change.", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1, originKind: "chat_channel" });
    await db.insert(chatConversations).values({
      id: conversationId, companyId, endpointId, resourceId, issueId,
      externalConversationId: "C-ORIGIN", externalThreadId: "slack:C-ORIGIN:1700000000.000100",
      externalLabel: "requests", sessionGeneration: 1, isDirectMessage: false, state: "active",
      communicationGuidance: conversationGuidance,
    });
    await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "slack", providerAccountId: "T-ORIGIN", externalId: "U-ORIGIN", kind: "user" });
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: userId, status: "linked" });
    return { companyId, agentId, teammateId, issueId, endpointId, conversationId, principalId, userId };
  }

  async function wake(
    f: Awaited<ReturnType<typeof seed>>,
    commentId: string,
    source: string,
    requestedBy: { requestedByActorType: "user" | "agent"; requestedByActorId: string },
  ) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId },
      contextSnapshot: {
        issueId: f.issueId, taskId: f.issueId, source, commentId,
        wakeCommentId: commentId, wakeCommentIds: [commentId],
      },
      ...requestedBy,
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const input = captured.get(run!.id);
    expect(input).toBeDefined();
    return input!.context;
  }

  it("keeps delivery to Paperclip for a turn that a Slack message started", async () => {
    const f = await seed();
    const commentId = randomUUID(), deliveryId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.userId, body: "Please plan this change." });
    await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, principalId: f.principalId, providerEventId: commentId, deduplicationKey: commentId, eventKind: "message", normalizedEvent: {}, state: "processed", attempts: 1, processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, deliveryId, commentId, providerMessageId: commentId, direction: "inbound" });
    const context = await wake(f, commentId, "chat:slack", { requestedByActorType: "user", requestedByActorId: f.userId });
    for (const key of markdownKeys) {
      expect(String(context[key])).toContain("Paperclip delivers your final response to the originating Slack conversation");
      expect(String(context[key])).not.toContain(undeliveredNotice);
    }
    expect((context.paperclipWake as Record<string, unknown> | undefined)?.slackFinalResponseUndelivered).toBeUndefined();
  }, 30_000);

  it("tells the agent to post with slack_post_message when a teammate comment starts the run", async () => {
    const f = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.teammateId, body: "The plan is ready for approval." });
    const context = await wake(f, commentId, "issue.comment", { requestedByActorType: "agent", requestedByActorId: f.teammateId });
    for (const key of markdownKeys) {
      expect(String(context[key])).toContain(undeliveredNotice);
      expect(String(context[key])).toContain(destination);
    }
    expect(String(context.paperclipTaskCommunicationGuidance)).toContain(conversationGuidance);
    expect(String(context.paperclipTaskCommunicationGuidance)).not.toContain(undeliveredNotice);
    expect(context.paperclipWake).toMatchObject({ slackFinalResponseUndelivered: true });
  }, 30_000);
});
