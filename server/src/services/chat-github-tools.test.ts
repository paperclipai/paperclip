import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { GITHUB_BOT_TOOLS, githubGuestBotConnectionForSession } from "./chat-github-tools.js";
import { createToolGatewayService } from "./tool-gateway.js";

describe("GitHub review tool contract", () => {
  it("discovers the repository-specific finding category constraint", () => {
    const submit = GITHUB_BOT_TOOLS.find(tool => tool.name === "submit_review")!;
    expect(submit.schema).toMatchObject({
      properties: {
        findings: {
          items: {
            properties: {
              category: {
                description: expect.stringContaining("begin_review.findingCategories"),
              },
            },
          },
        },
      },
    });
    expect(submit.schema).not.toHaveProperty("properties.findings.items.properties.category.enum");
  });
  it("tells new bots which review sections Paperclip renders", () => {
    const submit = GITHUB_BOT_TOOLS.find(tool => tool.name === "submit_review")!;
    const properties = submit.schema.properties!;
    expect(properties.summary).toMatchObject({
      description: expect.stringContaining("Review body only"),
      maxLength: 24000,
    });
    expect(properties.summary).toMatchObject({
      description: expect.stringContaining("Paperclip adds"),
    });
    expect(properties.rationale).toMatchObject({
      description: expect.stringContaining("Do not repeat the summary"),
      maxLength: 12000,
    });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub guest bot connection discovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-guest-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Guest discovery", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [first, second] = await db.insert(agents).values([
      { companyId: company.id, name: "First agent", role: "general", adapterType: "codex_local" },
      { companyId: company.id, name: "Second agent", role: "general", adapterType: "codex_local" },
    ]).returning();
    const [issue, other] = await db.insert(issues).values([
      { companyId: company.id, title: "Reassigned task", assigneeAgentId: second.id },
      { companyId: company.id, title: "Other task", assigneeAgentId: second.id },
    ]).returning();
    return { company, first, second, issue, other };
  }

  async function continuation(f: Awaited<ReturnType<typeof fixture>>, parent: { agentId: string; issueId: string }) {
    const [source, continued] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: parent.agentId, status: "succeeded", nativeIssueId: parent.issueId, contextSnapshot: {}, responsibleUserId: "requester" },
      { companyId: f.company.id, agentId: f.second.id, status: "running", nativeIssueId: f.issue.id, contextSnapshot: {}, responsibleUserId: "requester" },
    ]).returning();
    const [origin] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: source.id, revision: 1, responsibleUserId: "requester", cause: "dispatch", correlationId: "dispatch" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", parentContextId: origin.id, cause: "dispatch", correlationId: "dispatch" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, continued.id));
    return { companyId: f.company.id, agentId: f.second.id, runId: continued.id, issueId: f.issue.id };
  }

  async function guestSource(f: Awaited<ReturnType<typeof fixture>>, guest: boolean) {
    const endpointId = randomUUID();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, applicationKey: `chat:github:${endpointId}`, name: `GitHub ${endpointId}`, type: "chat", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, name: "GitHub", uid: `chat-github-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true }).returning();
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.company.id, connectionId: connection.id, provider: "github", publicId: randomUUID(), assignedAgentId: f.second.id, status: "active" });
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId, issueId: f.issue.id, externalConversationId: `github:owner/repo:${endpointId}`, externalLabel: "Guest thread" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "requester", body: "Please review" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.company.id, endpointId, conversationId: conversation.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: { githubAuthority: { guest } }, state: "processed" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId, conversationId: conversation.id, deliveryId: delivery.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    return { connectionId: connection.id, commentId: comment.id };
  }

  async function sponsoredRun(f: Awaited<ReturnType<typeof fixture>>, commentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.second.id, status: "running", nativeIssueId: f.issue.id, contextSnapshot: {}, responsibleUserId: "requester" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: run.id, revision: 1, responsibleUserId: "requester", messageId: commentId, cause: "instruction", correlationId: "message" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, run.id));
    return { companyId: f.company.id, agentId: f.second.id, runId: run.id, issueId: f.issue.id };
  }

  it.each(["agent", "task"])("finds no guest sponsor when the run chain continues another %s", async (fault) => {
    const f = await fixture();
    const session = await continuation(f, fault === "agent"
      ? { agentId: f.first.id, issueId: f.issue.id }
      : { agentId: f.second.id, issueId: f.other.id });
    expect(await githubGuestBotConnectionForSession(db, session)).toBeNull();
  });

  it("still refuses a guest-sponsored task whose run chain continues another agent", async () => {
    const f = await fixture();
    await guestSource(f, true);
    const session = await continuation(f, { agentId: f.first.id, issueId: f.issue.id });
    await expect(githubGuestBotConnectionForSession(db, session)).rejects.toMatchObject({ status: 403 });
  });

  it("does not inherit guest sponsorship from a delegating task", async () => {
    const f = await fixture();
    await guestSource(f, true);
    const session = await continuation(f, { agentId: f.first.id, issueId: f.other.id });
    expect(await githubGuestBotConnectionForSession(db, session)).toBeNull();
  });

  it("lists gateway tools for a delegated task with a guest message", async () => {
    const f = await fixture();
    await guestSource(f, true);
    const session = await continuation(f, { agentId: f.first.id, issueId: f.other.id });
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, profileKey: `discovery-${randomUUID()}`, name: "Discovery", defaultAction: "deny" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: f.second.id });
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: profile.id, selectorType: "tool_name", effect: "include", toolName: "paperclip-self:list_my_issues" });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "test-action-signing-secret" });
    const named = await gateway.createNamedGateway({ companyId: f.company.id, body: { name: "Delegated task", profileId: profile.id, defaultProfileMode: "gateway_only" } });
    const token = await gateway.createNamedGatewayToken({ companyId: f.company.id, gatewayId: named.id, body: {
      name: "Runtime", subjectType: "heartbeat_run", subjectId: session.runId, clientLabel: "Runtime", ownerNote: "", allowedActions: ["tools/list"], expiresAt: new Date(Date.now() + 60_000),
    }, actor: { agentId: f.second.id } });
    const tools = await gateway.listToolsForNamedGateway({ gatewayId: named.id, bearerToken: token.token });
    expect(tools.map(tool => tool.name)).toContain("paperclip-self:list_my_issues");
  });

  it("retains the task's guest restriction when ancestry returns after delegation", async () => {
    const f = await fixture();
    const source = await guestSource(f, true);
    const guest = await sponsoredRun(f, source.commentId);
    const [guestRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, guest.runId));
    const [delegation, continued] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.first.id, status: "succeeded", nativeIssueId: f.other.id, responsibleUserId: "requester" },
      { companyId: f.company.id, agentId: f.second.id, status: "running", nativeIssueId: f.issue.id, responsibleUserId: "requester" },
    ]).returning();
    const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "requester", body: "Continue" }).returning();
    const [foreign] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: delegation.id, revision: 1, responsibleUserId: "requester", parentContextId: guestRun.activeIdentityContextId, cause: "dispatch", correlationId: "dispatch" }).returning();
    const [current] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", messageId: message.id, parentContextId: foreign.id, cause: "dispatch", correlationId: "dispatch" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: current.id }).where(eq(heartbeatRuns.id, continued.id));
    expect(await githubGuestBotConnectionForSession(db, { companyId: f.company.id, agentId: f.second.id, runId: continued.id, issueId: f.issue.id })).toBe(source.connectionId);
  });

  it.each([true, false])("resolves the bot connection only for a run sponsored by a GitHub guest (guest=%s)", async (guest) => {
    const f = await fixture();
    const source = await guestSource(f, guest);
    const session = await sponsoredRun(f, source.commentId);
    expect(await githubGuestBotConnectionForSession(db, session)).toBe(guest ? source.connectionId : null);
  });
});
