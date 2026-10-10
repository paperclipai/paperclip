import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpointResources,
  chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks,
  companies, companyMemberships, createDb, issueComments, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import {
  registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;
if (!postgresSupport.supported) {
  console.warn(`Skipping Slack invitation heartbeat tests: ${postgresSupport.reason ?? "embedded Postgres unavailable"}`);
}

describePostgres("saved Slack invitation command in heartbeat prompts", () => {
  const adapterType = "slack_invitation_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("slack-invitation-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "invitation-session", resultJson: {} };
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
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const endpointId = randomUUID(), resourceId = randomUUID(), conversationId = randomUUID();
    const applicationId = randomUUID(), connectionId = randomUUID(), principalId = randomUUID();
    const userId = `invitation-user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Invitation fixture", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Original researcher", adapterType, status: "idle",
    });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:slack:${endpointId}`, name: "Slack", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: endpointId, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "slack", publicId: randomUUID(),
      assignedAgentId: agentId, status: "active", providerAccountId: "T-INVITE",
      setup: { step: "complete", command: "/research_ops", providerUrl: "https://setup-canary-secret.invalid" },
      allowDirectMessages: true, allowUnlinkedPeople: false,
    });
    await db.insert(chatEndpointResources).values({ id: resourceId, companyId, endpointId, type: "direct_message", providerResourceId: "D-INVITE", label: "DM", availability: "available", enabled: true });
    await db.insert(issues).values({ id: issueId, companyId, title: "Invite a teammate", description: "Help teammates connect their own Slack accounts.", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1, originKind: "chat_channel" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, resourceId, issueId, externalConversationId: "D-INVITE", externalThreadId: "slack:D-INVITE:1", externalLabel: "DM", sessionGeneration: 1, isDirectMessage: true, state: "active" });
    await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "slack", providerAccountId: "T-INVITE", externalId: "U-INVITE", kind: "user" });
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: userId, status: "linked" });
    // Renaming must not change the provider's registered command.
    await db.update(agents).set({ name: "Renamed analyst" }).where(eq(agents.id, agentId));
    return { companyId, agentId, issueId, endpointId, conversationId, principalId, userId };
  }

  async function turn(f: Awaited<ReturnType<typeof seed>>) {
    const commentId = randomUUID(), deliveryId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.userId, body: "How can a teammate talk to you?" });
    await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, principalId: f.principalId, providerEventId: commentId, deduplicationKey: commentId, eventKind: "message", normalizedEvent: {}, state: "processed", attempts: 1, processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, deliveryId, commentId, providerMessageId: commentId, direction: "inbound" });
    const run = await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId },
      contextSnapshot: {
        issueId: f.issueId, taskId: f.issueId, source: "chat:slack", commentId,
        wakeCommentId: commentId, wakeCommentIds: [commentId],
        // Caller fields must not replace the durable endpoint command.
        slackCommand: "/forged", chatSlackCommand: "/forged",
      },
      requestedByActorType: "user", requestedByActorId: f.userId,
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const input = captured.get(run!.id);
    expect(input).toBeDefined();
    return input!;
  }

  it("loads the custom saved command for fresh and resumed prompts after an agent rename", async () => {
    const f = await seed();
    for (let index = 0; index < 2; index++) {
      const input = await turn(f);
      expect(input.runtime.sessionId).toBe(index === 0 ? null : "invitation-session");
      const context = input.context;
      for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact"]) {
        const prompt = String(context[key]);
        expect(prompt).toContain("saved account-linking command is /research_ops connect");
        expect(prompt).not.toContain("/renamed");
        expect(prompt).not.toContain("/forged");
        expect(prompt).not.toContain("setup-canary-secret");
      }
    }
  }, 30_000);

  it("uses the Access page fallback when the saved command is missing", async () => {
    const f = await seed();
    await db.update(chatEndpoints).set({ setup: { step: "complete" } }).where(eq(chatEndpoints.id, f.endpointId));
    const { context } = await turn(f);
    expect(context.paperclipTaskMarkdown).toContain("No saved account-linking command is available");
    expect(context.paperclipTaskMarkdown).toContain("Access → Invite people");
    expect(context.paperclipTaskMarkdown).not.toContain("/forged");
  }, 30_000);

  it.each(["inactive", "different-agent"])("excludes the command from an unauthorized endpoint (%s)", async (change) => {
    const f = await seed();
    if (change === "inactive") {
      await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
    } else {
      const otherId = randomUUID();
      await db.insert(agents).values({ id: otherId, companyId: f.companyId, name: "Other agent", adapterType, status: "idle" });
      await db.update(chatEndpoints).set({ assignedAgentId: otherId }).where(eq(chatEndpoints.id, f.endpointId));
    }
    const { context } = await turn(f);
    expect(context.paperclipTaskMarkdown).not.toContain("/research_ops");
    expect(context.paperclipTaskMarkdown).not.toContain("/forged");
  }, 30_000);
});
