import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../../services/delivery-work-notifications.js";
import { aiConnectionService } from "../../services/ai-connections.js";
import { fastResponseService } from "../../services/fast-responses.js";
import { fastResponseReceipt } from "../../services/fast-response-provider.js";
import { fastResponseRequests } from "@paperclipai/db";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, agentWakeupRequests, activityLog, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companies, heartbeatRunEvents, heartbeatRuns, issueComments, issues, executionWorkspaces, projects, toolConnections } from "@paperclipai/db";
import type { Message } from "chat";
import { type ChatChannelService } from "../../services/chat-channels.js";
import type { ChatSdkMessageTrigger } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { subscribeCompanyLiveEvents } from "../../services/live-events.js";
import { enqueueSafeNativeChatProgress } from "../../services/chat-run-publications.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, TEST_SLACK_BOT_SCOPES, uniqueDiscordApplicationId, fakeSlackFetch, fakeDiscordFetch, makeThread, makeMessage, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";

describeEmbeddedPostgres("chat channels: slack ingress and threads", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { seedCompany, readChatConversationsByEndpointId, readIssueCommentsByIssueId, readChatDeliveriesByEndpointId, readChatDeliveriesById, readIssuesById, readChatPublicationsByEndpointId, readToolConnectionsById, readIssuesByCompanyId, readChatPublicationsByCommentId, readHeartbeatRunsByCompanyId, createService, recordSlackUrlVerification, signedSlackWebhookRequest, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, deliverMessage } = h;
  const { recordGitHubWebhookVerification, configuredGitHubEndpoint } = gh;

  it("refuses to create a chat endpoint while its provider experiment is off", async () => {
    const settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    try {
      await settings.updateExperimental({ enableChatConnectors: false, enableGitHubReviewBots: false });
      const fixture = await seedCompany();
      const { service } = createService();
      const app = routesApp(db, fixture.companyId, service);
      for (const provider of ["imessage-photon", "slack", "github"]) {
        const response = await request(app).post(`/api/companies/${fixture.companyId}/chat-endpoints`)
          .send({ provider, assignedAgentId: fixture.assignedAgentId }).expect(403);
        expect(response.body.error).toContain("/<prefix>/company/settings/instance/experimental");
      }
      expect(await service.list(fixture.companyId)).toEqual([]);
    } finally {
      await settings.updateExperimental({ enableChatConnectors: previous.enableChatConnectors, enableGitHubReviewBots: previous.enableGitHubReviewBots });
    }
  });

  it("saves Slack communication instructions with validation, company isolation, and audit attribution", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);
    const endpoint = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId });
    expect(endpoint.communicationInstructions).toBe("");
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ communicationInstructions: "  Use customer-facing names.  " }).expect(200);
    expect((await service.get(endpoint.id)).communicationInstructions).toBe("Use customer-facing names.");
    const entries = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.entityId, endpoint.connectionId)));
    expect(entries.find((entry) => entry.action === "chat_endpoint.updated")?.details).toMatchObject({ fields: ["communicationInstructions"] });
    expect(JSON.stringify(entries)).not.toContain("Use customer-facing names.");
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ communicationInstructions: "a".repeat(4001) }).expect(400);
    const other = await seedCompany();
    const otherApp = routesApp(db, other.companyId, service);
    expect((await request(otherApp).patch(`/api/chat-endpoints/${endpoint.id}`).send({ communicationInstructions: "Wrong company" })).status).toBeOneOf([403, 404]);
    expect((await service.get(endpoint.id)).communicationInstructions).toBe("Use customer-facing names.");
    await request(app).patch(`/api/chat-endpoints/${endpoint.id}`).send({ communicationInstructions: "" }).expect(200);
    expect((await service.get(endpoint.id)).communicationInstructions).toBe("");
    const github = await service.create(fixture.companyId, { provider: "github", assignedAgentId: fixture.assignedAgentId });
    await request(app).patch(`/api/chat-endpoints/${github.id}`).send({ communicationInstructions: "Not enabled" }).expect(422);
  });

  it.each(["slack", "github"] as const)("publishes fast responses to the accepted %s thread without completing its work", async channelProvider => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true, enableFastResponses: true });
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } = channelProvider === "github" ? await configuredGitHubEndpoint(fixture) : await configuredSlackEndpoint(fixture);
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    if (channelProvider === "github") {
      const current = await service.get(endpoint.id);
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "github", providerAccountId: current.providerAccountId!, externalId: "42", kind: "user", displayName: "Octocat", handle: "octocat", isBot: false }).returning();
      await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
    }
    const binding = await aiConnectionService(db).save(fixture.companyId, "owner-user", { provider: "openrouter", method: "api_key", name: "Fast test", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
    const provider = vi.fn(async () => ({ text: "I’ll check the border styling.", receipt: fastResponseReceipt({ usage: { inputTokens: 80, outputTokens: 8 }, response: { body: { usage: { cost: 0.00001 } } } }) }));
    const fast = fastResponseService(db, { provider, authorizeExternal: service.authorizeFastResponse });
    await fast.configure(fixture.companyId, "owner-user", { enabled: true, ...binding, model: "openai/gpt-oss-120b", allowSponsored: true });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now()); onTestFinished(() => now.mockRestore());
    const current = await service.get(endpoint.id);
    const channel = makeThread(channelProvider === "github" ? { channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:903" } : { channelId: "CFAST", id: "slack:CFAST:9000.1", name: "fast response test" });
    await deliverMessage({ callbacks, provider: channelProvider, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "9000.1", text: `@${current.botUsername ?? "maya"} fix the border styling`, mentioned: true, ...(channelProvider === "github" ? { userId: "42", userName: "octocat" } : {}) }), trigger: "mention" });
    const [job] = await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.companyId, fixture.companyId));
    expect(job).toBeDefined(); expect(wakeup).toHaveBeenCalled();
    const [queuedRun] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "queued", contextSnapshot: { issueId: job.issueId, wakeCommentId: job.sourceCommentId } }).returning();
    await db.update(agentWakeupRequests).set({ runId: queuedRun.id }).where(and(eq(agentWakeupRequests.companyId, fixture.companyId), eq(agentWakeupRequests.agentId, fixture.assignedAgentId)));
    await fast.process(job);
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('"state":"queued"') }));
    await service.processPendingPublications();
    const posts = runtime.endpoints.get(endpoint.id)!.posts;
    expect(posts).toContainEqual({ threadId: channel.thread.id, text: "I’ll check the border styling." });
    const [receipt] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, job.issueId!), eq(issueComments.origin, "fast_response")));
    expect(receipt).toMatchObject({ authorAgentId: fixture.assignedAgentId, createdByRunId: null });
    expect((await readIssuesById(job.issueId!))[0].status).not.toBe("done");
    expect(provider).toHaveBeenCalledTimes(1);
    if (channelProvider === "slack") {
      await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "running",
        contextSnapshot: await chatWakeContext({ endpointId: endpoint.id, issueId: job.issueId!, provider: "slack", providerMessageId: "9000.1" }),
      }).where(eq(heartbeatRuns.id, queuedRun.id));
      await db.insert(chatPublications).values({ companyId: fixture.companyId, endpointId: endpoint.id,
        conversationId: job.conversationId!, issueId: job.issueId!, idempotencyKey: `run:${queuedRun.id}:working:${endpoint.id}`,
        payload: { text: "Maya is working…", progressState: "working" }, createdAt: new Date(Date.now() - 60_000),
      });
      await service.processPendingPublications();
      const [working] = await db.select().from(chatPublications).where(eq(chatPublications.idempotencyKey, `run:${queuedRun.id}:working:${endpoint.id}`));
      expect(working).toMatchObject({ state: "cancelled", redactedError: "Acknowledged by contextual fast response" });
      await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.assignedAgentId, runId: queuedRun.id,
        seq: 1, eventType: "item.completed", payload: { prpEvent: { schema: "paperclip.prp.event.v1", eventType: "item.completed", runId: queuedRun.id,
          payload: { kind: "agentMessage", channel: "progress", text: "Found the border rule. Checking the fix." } } },
      });
      await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.assignedAgentId, runId: queuedRun.id,
        seq: 2, eventType: "tool.execution.completed", payload: { result: "PRIVATE tool output" },
      });
      expect(await enqueueSafeNativeChatProgress(db, { scope: { companyId: fixture.companyId, issueId: job.issueId! } })).toBe(1);
      await service.processPendingPublications();
      const slack = runtime.endpoints.get(endpoint.id)!;
      expect(slack.posts).toHaveLength(1);
      expect(slack.edits).toEqual([expect.objectContaining({ text: expect.stringContaining("Found the border rule. Checking the fix.") })]);
      await addSelectedChatFinal({ companyId: fixture.companyId, agentId: fixture.assignedAgentId, issueId: job.issueId!, runId: queuedRun.id, body: "Fixed the border." });
      await service.processPendingPublications();
      expect(slack.posts).toHaveLength(2);
      expect(slack.posts[1].text).toBe("Fixed the border.");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, queuedRun.id));
    }
  });

  it("mirrors Paperclip messages with user attribution and returns only the selected Slack reply", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } = await configuredSlackEndpoint(fixture);
    const workWake = vi.fn();
    const stopWorkObserver = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatBoardMessages, workWake);
    onTestFinished(() => { stopWorkObserver(); expect(workWake).toHaveBeenCalled(); });
    const channel = makeThread({ channelId: "CBOARD", id: "slack:CBOARD:8000.1", name: "board" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "8000.1", text: "@maya start here", mentioned: true }), trigger: "mention" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    const [conversation] = await service.listConversations(endpoint.id);
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;
    wakeup.mockClear();
    const [boardPrincipal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: boardPrincipal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
    const clientRequestId = randomUUID();
    const comment = await issueService(db).addComment(conversation.issueId, "Please make the plan", { userId: "owner-user" },
      { authorType: "user", mirrorToSlack: true, clientRequestId });
    expect((await issueService(db).addComment(conversation.issueId, "Please make the plan", { userId: "owner-user" },
      { authorType: "user", mirrorToSlack: true, clientRequestId })).id).toBe(comment.id);
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)!.posts).toEqual([
      { threadId: channel.thread.id, text: "**Owner User (via Paperclip)**\n\nPlease make the plan" },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.assignedAgentId,
      status: "running", responsibleUserId: "owner-user", contextSnapshot: { issueId: conversation.issueId, source: "issue.comment", wakeCommentId: comment.id } });
    await initializeRunIdentity(db, { companyId: fixture.companyId, runId, issueId: conversation.issueId, responsibleUserId: "owner-user", messageIds: [comment.id], cause: "user_message" });
    const { resolveSlackTaskAuthority } = await import("../../services/connectors/slack-authority.js");
    await expect(resolveSlackTaskAuthority(db, { companyId: fixture.companyId, agentId: fixture.assignedAgentId, runId, issueId: conversation.issueId, endpointId: endpoint.id })).resolves.toMatchObject({
      slackUserId: "UBOARD", conversation: { id: conversation.id }, deliveryId: null,
    });
    await issueService(db).addComment(conversation.issueId, "Internal bookkeeping", { agentId: fixture.assignedAgentId, runId }, { authorizationReason: "internal_agent_write" });
    await addSelectedChatFinal({ companyId: fixture.companyId, issueId: conversation.issueId, agentId: fixture.assignedAgentId, runId, body: "The plan is ready." });
    await service.processPendingPublications();
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)!.posts.map(post => post.text)).toEqual([
      "**Owner User (via Paperclip)**\n\nPlease make the plan", "The plan is ready.",
    ]);
    // The explicit Board composer uses the same mirror and a durable wakeup.
    workWake.mockClear();
    const key = randomUUID();
    await service.publishBoardMessage(endpoint.id, conversation.id, "Now assign the follow-ups", key, "owner-user");
    await service.publishBoardMessage(endpoint.id, conversation.id, "Now assign the follow-ups", key, "owner-user");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(fixture.assignedAgentId, expect.objectContaining({ requestedByActorId: "owner-user", contextSnapshot: expect.objectContaining({ source: "issue.comment", taskKey: (await issueService(db).getById(conversation.issueId))!.identifier, wakeCommentId: expect.any(String) }) }));
    expect(runtime.endpoints.get(endpoint.id)!.posts.filter(post => post.text.includes("Now assign the follow-ups"))).toHaveLength(1);
    const ordinary = await issueService(db).addComment(conversation.issueId, "Private system note", { agentId: fixture.assignedAgentId }, { authorType: "agent" });
    expect(await readChatPublicationsByCommentId(ordinary.id)).toEqual([]);
    // A scheduler outage preserves the Board request for the delivery worker.
    wakeup.mockRejectedValueOnce(new Error("temporary scheduler failure"));
    await service.publishBoardMessage(endpoint.id, conversation.id, "Retry this work", randomUUID(), "owner-user");
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slack_board_message"), eq(chatActions.status, "received")))).toHaveLength(1);
    const recovery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerChatActionWork(recovery, service, () => true).ready;
      await vi.waitFor(async () => {
        expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slack_board_message"), eq(chatActions.status, "received")))).toHaveLength(0);
      });
    } finally { await recovery.stop(); }
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)!.posts.filter(post => post.text.includes("Retry this work"))).toHaveLength(1);
  });

  it.each(["revoked", "relinked", "private-membership", "later-cancelled"] as const)("rechecks %s authority before queued Slack Board messages and replies", async (change) => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    let canRead = true;
    const fallback = fakeSlackFetch();
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      const args = new URLSearchParams(String(init?.body ?? new URL(url).search));
      if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { id: args.get("channel"), is_member: true, is_private: true } });
      if (url.includes("conversations.members")) return Response.json({ ok: true, members: canRead ? ["UBOARD"] : [] });
      return fallback(input, init);
    }) as typeof fetch;
    const { callbacks, endpoint, runtime, service } = await configuredSlackEndpoint(fixture, { fetch: fetchImpl });
    const channel = makeThread({ channelId: "CBOARD", id: "slack:CBOARD:8000.1", name: "board" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "8000.1", text: "@maya start here", mentioned: true }), trigger: "mention" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    const [conversation] = await service.listConversations(endpoint.id);
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;
    await expect(issueService(db).addComment(conversation.issueId, "Unlinked Board message", { userId: "owner-user" },
      { authorType: "user", mirrorToSlack: true })).rejects.toMatchObject({ status: 403 });
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
    const [link] = await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() }).returning();
    const comment = await issueService(db).addComment(conversation.issueId, "Queued before access changed", { userId: "owner-user" }, { authorType: "user", mirrorToSlack: true });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.assignedAgentId, status: "running", responsibleUserId: "owner-user", contextSnapshot: { issueId: conversation.issueId, source: "issue.comment", wakeCommentId: comment.id } });
    await initializeRunIdentity(db, { companyId: fixture.companyId, runId, issueId: conversation.issueId, responsibleUserId: "owner-user", messageIds: [comment.id], cause: "user_message" });
    await addSelectedChatFinal({ companyId: fixture.companyId, issueId: conversation.issueId, agentId: fixture.assignedAgentId, runId, body: "Queued final before access changed" });
    expect(await readChatPublicationsByEndpointId(endpoint.id)).toHaveLength(2);
    if (change === "later-cancelled") {
      const later = await issueService(db).addComment(conversation.issueId, "A different, cancelled request", { userId: "owner-user" }, { authorType: "user", mirrorToSlack: true });
      await db.update(chatActions).set({ status: "cancelled" }).where(and(eq(chatActions.endpointId, endpoint.id), eq(sql<string>`${chatActions.payload}->>'commentId'`, later.id)));
      await db.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.commentId, later.id));
    } else if (change === "private-membership") canRead = false;
    else {
      await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() }).where(eq(chatIdentityLinks.id, link.id));
      if (change === "relinked") {
        const [other] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UOTHER" }).returning();
        await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: other.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
      }
      const { slackBoardReplyBindings } = await import("../../services/slack-board-messages.js");
      expect(await slackBoardReplyBindings(db, { companyId: fixture.companyId, issueId: conversation.issueId, agentId: fixture.assignedAgentId, userId: "owner-user", commentIds: [comment.id] })).toEqual([]);
    }
    await service.processPendingPublications();
    if (change === "later-cancelled") {
      expect(runtime.endpoints.get(endpoint.id)!.posts.map(post => post.text)).toEqual([
        "**Owner User (via Paperclip)**\n\nQueued before access changed", "Queued final before access changed",
      ]);
    } else {
      expect(runtime.endpoints.get(endpoint.id)!.posts).toEqual([]);
      expect((await readChatPublicationsByEndpointId(endpoint.id)).every(row => row.state === "cancelled")).toBe(true);
    }
  });

  it.each(["cancelled", "paused", "blocked", "closed-workspace"] as const)("does not bypass %s task guards from the Slack Board composer or its outbox", async (guard) => {
    const { issueTreeHolds, issueRelations, executionWorkspaces, projects } = await import("@paperclipai/db");
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup, runtime } = await configuredSlackEndpoint(fixture);
    const channel = makeThread({ channelId: "CGUARD", id: "slack:CGUARD:8100.1", name: "guard" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "8100.1", text: "@maya start here", mentioned: true }), trigger: "mention" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    const [conversation] = await service.listConversations(endpoint.id);
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;
    wakeup.mockClear();
    wakeup.mockRejectedValueOnce(new Error("scheduler unavailable"));
    await service.publishBoardMessage(endpoint.id, conversation.id, "Queued work", randomUUID(), "owner-user");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(runtime.endpoints.get(endpoint.id)!.posts).toEqual([]);
    if (guard === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, conversation.issueId));
    if (guard === "paused") await db.insert(issueTreeHolds).values({ companyId: fixture.companyId, rootIssueId: conversation.issueId, mode: "pause", status: "active" });
    if (guard === "blocked") {
      const [blocker] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Unresolved prerequisite", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId: fixture.companyId, issueId: blocker.id, relatedIssueId: conversation.issueId, type: "blocks" });
    }
    if (guard === "closed-workspace") {
      const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Workspace guard" }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: fixture.companyId, projectId: project.id, mode: "isolated_workspace", strategyType: "git_worktree", name: "Closed", status: "archived", closedAt: new Date() }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, conversation.issueId));
    }
    const before = await readIssueCommentsByIssueId(conversation.issueId);
    await expect(service.publishBoardMessage(endpoint.id, conversation.id, "Must not bypass guard", randomUUID(), "owner-user")).rejects.toMatchObject({ status: 409 });
    expect(await readIssueCommentsByIssueId(conversation.issueId)).toHaveLength(before.length);
    wakeup.mockClear();
    await service.processPendingDeliveries();
    expect(wakeup).not.toHaveBeenCalled();
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)!.posts).toEqual([]);
    expect((await readChatPublicationsByEndpointId(endpoint.id)).every(row => row.state === "cancelled")).toBe(true);
    expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "slack_board_message")))).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it.each(["concurrent", "lost-response"] as const)("applies the Slack Board resume once during %s dispatch", async (mode) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup, runtime } = await configuredSlackEndpoint(fixture, { linkedBoardUser: true });
    const channel = makeThread({ channelId: "CONCE", id: "slack:CONCE:8200.1", name: "once" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: channel.thread,
      message: makeMessage({ id: "8200.1", text: "@maya start here", mentioned: true }), trigger: "mention" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
    const [conversation] = await service.listConversations(endpoint.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, conversation.issueId));
    runtime.endpoints.get(endpoint.id)!.posts.length = 0;
    wakeup.mockClear();
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    wakeup.mockImplementationOnce(async () => {
      // Model a scheduler which accepts the request and finishes before its
      // HTTP response reaches this outbox worker.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, conversation.issueId));
      reached();
      if (mode === "lost-response") throw new Error("scheduler response lost");
      await blocked;
      return null;
    });
    const sending = service.publishBoardMessage(endpoint.id, conversation.id, "One resume", randomUUID(), "owner-user");
    await entered;
    try {
      if (mode === "lost-response") await sending;
      await service.processPendingDeliveries();
      expect((await issueService(db).getById(conversation.issueId))!.status).toBe("done");
      expect(wakeup).toHaveBeenCalledTimes(mode === "concurrent" ? 1 : 2);
      const resumes = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.entityId, conversation.issueId), eq(sql<string>`${activityLog.details}->>'source'`, "slack_board_message")));
      expect(resumes).toHaveLength(1);
    } finally {
      release();
      await sending;
    }
    await service.processPendingPublications();
    expect(runtime.endpoints.get(endpoint.id)!.posts.filter(post => post.text.includes("One resume"))).toHaveLength(1);
  });

  it.each([false, true])("requires at-mentions by default only in Slack channels (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, { requireAtMention: true });
    // The returned endpoint is the original creation result, before fixture updates.
    expect(endpoint.requireAtMention).toBe(true);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(true);
    const thread = makeThread({ channelId: isDM ? "D-DEFAULT" : "C-DEFAULT", id: `slack:${isDM ? "D-DEFAULT" : "C-DEFAULT"}:7500.1`, isDM });
    const send = (id: string, mentioned: boolean) => deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id, text: mentioned ? "@maya start" : "Start", mentioned }), trigger: isDM ? "direct_message" : mentioned ? "mention" : "subscribed_message" });
    await send("7500.1", false);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 1 : 0);
    await send("7500.2", true);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 2 : 1);
    await service.update(endpoint.id, { requireAtMention: false });
    await send("7500.3", false);
    expect(wakeup).toHaveBeenCalledTimes(isDM ? 3 : 2);
    const other = await service.create(fixture.companyId, { provider: "github", assignedAgentId: fixture.assignedAgentId });
    expect(other.requireAtMention).toBe(false);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(false);
    await service.shutdown();
  });

  it.each([false, true])("allows Slack thread replies without mentions while exempting DMs (DM=%s)", async (isDM) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture);
    expect((await service.get(endpoint.id)).requireAtMention).toBe(false);
    const thread = makeThread({ channelId: isDM ? "D-MENTION" : "C-MENTION", id: isDM ? "slack:D-MENTION:" : "slack:C-MENTION:7100.1", isDM });
    const send = (id: string, mentioned: boolean, trigger: ChatSdkMessageTrigger = isDM ? "direct_message" : "subscribed_message") =>
      deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
        message: makeMessage({ id, text: mentioned ? "@maya continue" : "Continue", mentioned }), trigger });
    // Disabled mode preserves unmentioned DMs and subscribed thread replies.
    await send("7100.1", true, isDM ? "direct_message" : "mention");
    await send("7100.2", false);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect((await service.update(endpoint.id, { requireAtMention: true })).requireAtMention).toBe(true);
    await send("7100.3", false, "subscribed_message");
    expect(wakeup).toHaveBeenCalledTimes(3);
    const [filtered] = await db.select().from(chatDeliveries).where(and(
      eq(chatDeliveries.endpointId, endpoint.id), eq(chatDeliveries.state, "filtered")));
    expect(filtered).toBeUndefined();
    // Both Slack callback kinds can carry an explicit mention. Retries cannot
    // produce a second wakeup for the same provider message.
    await send("7100.4", true);
    await send("7100.4", true, "mention");
    expect(wakeup).toHaveBeenCalledTimes(4);
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(1);
    const comments = await readIssueCommentsByIssueId(conversations[0].issueId);
    expect(comments).toHaveLength(4);
    expect(conversations[0].externalThreadId).toBe(thread.thread.id);
    await service.update(endpoint.id, { requireAtMention: false });
    await send("7100.5", false);
    expect(wakeup).toHaveBeenCalledTimes(5);
    if (isDM) {
      await service.update(endpoint.id, { requireAtMention: true, allowDirectMessages: false });
      await send("7100.6", false);
      expect(wakeup).toHaveBeenCalledTimes(5);
    }
  });

  it.each([
    { isDM: false, isReply: false },
    { isDM: false, isReply: true },
    { isDM: true, isReply: false },
  ])("rechecks queued Slack channel roots but exempts replies and DMs (DM=$isDM, reply=$isReply)", async ({ isDM, isReply }) => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } = await configuredSlackEndpoint(fixture, {
      deferWebhookProcessing: true, scheduleDeferredWork: () => undefined,
    });
    const channelId = isDM ? "D-QUEUED-MENTION" : "C-QUEUED-MENTION";
    const thread = makeThread({ channelId, id: `slack:${channelId}:${isDM ? "" : "7300.1"}`, isDM });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7300.1", text: "@maya start", mentioned: true }), trigger: isDM ? "direct_message" : "mention" });
    const [starter] = await readChatDeliveriesByEndpointId(endpoint.id);
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(chatDeliveries.id, starter.id));
    await service.processPendingDeliveries(25, starter.id);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const nextThread = isReply || isDM ? thread.thread : makeThread({ channelId, id: `slack:${channelId}:7300.2` }).thread;
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: nextThread,
      message: makeMessage({ id: "7300.2", text: "Continue work" }), trigger: isDM ? "direct_message" : "subscribed_message" });
    await service.update(endpoint.id, { requireAtMention: true });
    const delivery = (await readChatDeliveriesByEndpointId(endpoint.id)).find(row => row.id !== starter.id)!;
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(chatDeliveries.id, delivery.id));
    await service.processPendingDeliveries(25, delivery.id);
    const allowed = isDM || isReply;
    expect(wakeup).toHaveBeenCalledTimes(allowed ? 2 : 1);
    expect(await readChatConversationsByEndpointId(endpoint.id)).toHaveLength(1);
    const [result] = await readChatDeliveriesById(delivery.id);
    expect(result.state).toBe(allowed ? "processed" : "filtered");
    if (!allowed) {
      expect(result.redactedError).toBe("Message did not @mention the bot");
      expect(result.normalizedEvent).toMatchObject({ filtering: { contentRetained: false } });
      expect(result.normalizedEvent).not.toHaveProperty("message.text");
    }
  });

  it("snapshots channel workspace defaults on new tasks and preserves them on replies", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    await service.update(endpoint.id, { executionDefaults: { workspace: { kind: "task_directory" } } }, "owner-user");
    const thread = makeThread({ channelId: "C-WORKSPACE", id: "slack:C-WORKSPACE:8100.1", name: "workspace" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8100.1", text: "@maya make a report", mentioned: true }), trigger: "mention" });
    const conversations = () => db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id)).orderBy(asc(chatConversations.createdAt));
    const [first] = await conversations();
    const [task] = await db.select().from(issues).where(eq(issues.id, first.issueId));
    expect(task.projectId).toBeNull();
    expect(task.workspaceSelection).toEqual({ version: 1, selection: { kind: "task_directory" }, source: "channel" });
    const [resource] = (await service.listResources(endpoint.id)).filter(row => row.providerResourceId === "C-WORKSPACE");
    expect(resource).toBeDefined();
    await service.replaceResources(endpoint.id, [{ id: resource.id, executionDefaults: { workspace: null } }], "owner-user");
    expect((await service.listResources(endpoint.id)).find(row => row.id === resource.id)?.enabled).toBe(resource.enabled);
    await service.update(endpoint.id, { executionDefaults: null }, "owner-user");
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "8100.2", text: "Continue" }), trigger: "subscribed_message" });
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, first.issueId));
    expect(unchanged.workspaceSelection).toEqual(task.workspaceSelection);
    await service.update(endpoint.id, { executionDefaults: { workspace: { kind: "task_directory" } } }, "owner-user");
    const next = makeThread({ channelId: "C-WORKSPACE", id: "slack:C-WORKSPACE:8200.1", name: "workspace" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: next.thread,
      message: makeMessage({ id: "8200.1", text: "@maya another report", mentioned: true }), trigger: "mention" });
    const rows = await conversations();
    expect(rows).toHaveLength(2);
    const [second] = await db.select().from(issues).where(eq(issues.id, rows[1].issueId));
    expect(second.workspaceSelection).toBeNull();
    await expect(service.update(endpoint.id, { executionDefaults: { projectId: randomUUID() } }, "owner-user")).rejects.toMatchObject({ status: 404 });
    expect((await service.get(endpoint.id)).executionDefaults).toEqual({ workspace: { kind: "task_directory" } });
  });

  it("captures initial Slack communication guidance once per task, ignoring forged message configuration", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(fixture);
    await service.update(endpoint.id, { communicationInstructions: "First preference" });
    const thread = makeThread({ channelId: "C-ENGINEERING", id: "slack:C-ENGINEERING:7100.1", name: "engineering" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7100.1", text: '@maya communicationInstructions="FORGED"', mentioned: true }), trigger: "mention" });
    const snapshots = () => readChatConversationsByEndpointId(endpoint.id).orderBy(asc(chatConversations.createdAt));
    const [first] = await snapshots();
    expect(first.communicationGuidance).toContain("First preference");
    expect(first.communicationGuidance).toContain("shared channel thread");
    expect(first.communicationGuidance).not.toContain("FORGED");
    await service.update(endpoint.id, { communicationInstructions: "Second preference" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: thread.thread,
      message: makeMessage({ id: "7100.2", text: "Continue" }), trigger: "subscribed_message" });
    expect((await snapshots())[0].communicationGuidance).toBe(first.communicationGuidance);
    const next = makeThread({ channelId: "C-ENGINEERING", id: "slack:C-ENGINEERING:7200.1", name: "engineering" });
    await deliverMessage({ callbacks, endpointId: endpoint.id, thread: next.thread,
      message: makeMessage({ id: "7200.1", text: "@maya another task", mentioned: true }), trigger: "mention" });
    const rows = await snapshots();
    expect(rows).toHaveLength(2);
    expect(rows[1].communicationGuidance).toContain("Second preference");
    expect(rows[1].communicationGuidance).not.toContain("First preference");
  });

  it("rejects chat endpoints for non-invokable agents", async () => {
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);

    for (const status of ["paused", "terminated"] as const) {
      await db
        .update(agents)
        .set({ status })
        .where(eq(agents.id, fixture.assignedAgentId));

      const response = await request(app)
        .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
        .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId })
        .expect(422);

      expect(response.body).toMatchObject({
        code: "chat_agent_not_invokable",
      });
    }

    const endpoints = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.companyId, fixture.companyId));
    expect(endpoints).toEqual([]);
  });

  describe("resource change auditing", () => {
    async function setupResourceAudit() {
      const fixture = await seedCompany();
      const context = createService();
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      const resources = await db
        .insert(chatEndpointResources)
        .values([
          {
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: "channel",
            providerResourceId: "C-AUDIT-FIRST",
            label: "private-label-not-for-audit",
            metadata: { credential: "private-resource-metadata" },
            enabled: true,
            availability: "available",
          },
          {
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: "channel",
            providerResourceId: "C-AUDIT-SECOND",
            label: "second",
            enabled: false,
            availability: "available",
          },
        ])
        .returning();
      const audits = () =>
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.action, "chat_endpoint.resources_updated"),
            ),
          )
          .orderBy(asc(activityLog.createdAt));
      return {
        ...context,
        ...fixture,
        endpoint,
        resources,
        audits,
        app: routesApp(db, fixture.companyId, context.service),
      };
    }

    it("records exact actual changes and authenticated route actor, without resource content", async () => {
      const context = await setupResourceAudit();
      const { app, audits, companyId, endpoint, resources, service, wakeup } =
        context;
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        if (
          event.type === "activity.logged" &&
          event.payload.action === "chat_endpoint.resources_updated"
        )
          events.push(event.payload);
      });
      try {
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: resources.map((resource) => ({
              id: resource.id,
              enabled: false,
            })),
          })
          .expect(200);
        const rows = await audits();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          companyId,
          actorType: "user",
          actorId: "owner-user",
          responsibleUserId: "owner-user",
          entityType: "tool_connection",
          entityId: endpoint.connectionId,
          details: {
            endpointId: endpoint.id,
            provider: "slack",
            changes: [
              {
                resourceId: resources[0]!.id,
                before: { enabled: true },
                after: { enabled: false },
              },
            ],
          },
        });
        expect(rows[0]!.details).toEqual({
          permissionDecision: expect.objectContaining({ operation: "PUT /chat-endpoints/:endpointId/resources" }),
          endpointId: endpoint.id,
          provider: "slack",
          changes: [
            {
              resourceId: resources[0]!.id,
              before: { enabled: true },
              after: { enabled: false },
            },
          ],
        });
        expect(events).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain("private-");
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: [{ id: resources[0]!.id, enabled: true }],
            actorUserId: "spoofed",
          })
          .expect(400);
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({
            resources: resources.map((resource) => ({
              id: resource.id,
              enabled: false,
            })),
          })
          .expect(200);
        await request(app)
          .put(`/api/chat-endpoints/${endpoint.id}/resources`)
          .send({ resources: [] })
          .expect(200);
        expect(await audits()).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect(wakeup).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await service.shutdown();
      }
    });
  });

  describe("resource change audit atomicity", () => {
    async function fixtureForAudit(
      overrides: Parameters<typeof createService>[2] = {},
    ) {
      const fixture = await seedCompany();
      const context = createService(undefined, undefined, overrides);
      const endpoint = await context.service.create(
        fixture.companyId,
        {
          provider: "slack",
          assignedAgentId: fixture.assignedAgentId,
        },
        "owner-user",
      );
      const [resource] = await db
        .insert(chatEndpointResources)
        .values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: "channel",
          providerResourceId: "C-RESOURCE-AUDIT",
          label: "audit",
          availability: "available",
          enabled: true,
        })
        .returning();
      const audits = () =>
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.action, "chat_endpoint.resources_updated"),
            ),
          )
          .orderBy(asc(activityLog.createdAt));
      const current = () =>
        db
          .select({ enabled: chatEndpointResources.enabled })
          .from(chatEndpointResources)
          .where(eq(chatEndpointResources.id, resource!.id));
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(
        fixture.companyId,
        (event) => {
          if (
            event.type === "activity.logged" &&
            event.payload.action === "chat_endpoint.resources_updated"
          )
            events.push(event.payload);
        },
      );
      return {
        ...context,
        ...fixture,
        endpoint,
        resource: resource!,
        audits,
        current,
        events,
        async cleanup() {
          unsubscribe();
          await context.service.shutdown();
        },
      };
    }

    it("keeps duplicate last-write semantics but audits only net changes", async () => {
      const context = await fixtureForAudit();
      const { service, endpoint, resource, audits, events } = context;
      try {
        await service.replaceResources(
          endpoint.id,
          [
            { id: resource.id, enabled: false },
            { id: resource.id, enabled: true },
          ],
          "owner-user",
        );
        expect(await audits()).toEqual([]);
        expect(events).toEqual([]);
        await service.replaceResources(
          endpoint.id,
          [
            { id: resource.id, enabled: true },
            { id: resource.id, enabled: false },
          ],
          "owner-user",
        );
        expect(await context.current()).toEqual([{ enabled: false }]);
        expect(await audits()).toMatchObject([
          {
            details: {
              changes: [
                {
                  resourceId: resource.id,
                  before: { enabled: true },
                  after: { enabled: false },
                },
              ],
            },
          },
        ]);
        expect(events).toHaveLength(1);
      } finally {
        await context.cleanup();
      }
    });

    it.each(["foreign", "unavailable"] as const)(
      "rolls back the entire %s resource batch without audit or events",
      async (kind) => {
        const context = await fixtureForAudit();
        const foreign = await fixtureForAudit();
        try {
          const [other] = await db
            .insert(chatEndpointResources)
            .values({
              companyId: context.companyId,
              endpointId: context.endpoint.id,
              type: "channel",
              providerResourceId: "C-UNAVAILABLE",
              label: "unavailable",
              availability: "unavailable",
              enabled: false,
            })
            .returning();
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [
                { id: context.resource.id, enabled: false },
                ...(kind === "foreign"
                  ? [{ id: foreign.resource.id, enabled: false }]
                  : [
                      { id: other!.id, enabled: true },
                      { id: other!.id, enabled: false },
                    ]),
              ],
              "owner-user",
            ),
          ).rejects.toMatchObject({ status: kind === "foreign" ? 422 : 409 });
          expect(await context.current()).toEqual([{ enabled: true }]);
          expect(await foreign.current()).toEqual([{ enabled: true }]);
          expect(await context.audits()).toEqual([]);
          expect(context.events).toEqual([]);
          expect(foreign.events).toEqual([]);
        } finally {
          await context.cleanup();
          await foreign.cleanup();
        }
      },
    );

    it.each(["audit_insert", "after_audit"] as const)(
      "rolls back resource writes and suppresses events on %s failure",
      async (failureAt) => {
        const context = await fixtureForAudit();
        const failure = new Error(`resource-audit-${failureAt}`);
        const transaction = db.transaction.bind(db);
        let sawAudit = false;
        const transactionSpy = vi
          .spyOn(db, "transaction")
          .mockImplementation((callback, config) =>
            transaction(async (tx) => {
              const insert = tx.insert.bind(tx);
              const insertSpy = vi
                .spyOn(tx, "insert")
                .mockImplementation((table) => {
                  if (table === activityLog && failureAt === "audit_insert") {
                    sawAudit = true;
                    throw failure;
                  }
                  return insert(table);
                });
              try {
                const result = await callback(tx);
                if (failureAt === "after_audit") {
                  const rows = await tx
                    .select()
                    .from(activityLog)
                    .where(
                      and(
                        eq(activityLog.companyId, context.companyId),
                        eq(
                          activityLog.action,
                          "chat_endpoint.resources_updated",
                        ),
                      ),
                    );
                  expect(rows).toHaveLength(1);
                  sawAudit = true;
                  expect(context.events).toEqual([]);
                  throw failure;
                }
                return result;
              } finally {
                insertSpy.mockRestore();
              }
            }, config),
          );
        try {
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [{ id: context.resource.id, enabled: false }],
              "owner-user",
            ),
          ).rejects.toBe(failure);
          expect(sawAudit).toBe(true);
          expect(await context.current()).toEqual([{ enabled: true }]);
          expect(await context.audits()).toEqual([]);
          expect(context.events).toEqual([]);
        } finally {
          transactionSpy.mockRestore();
          await context.cleanup();
        }
      },
    );

    it.each(["inside_transaction", "after_commit"] as const)(
      "keeps the audit aligned with commit on lease loss %s",
      async (failureAt) => {
        let renewals = 0;
        const context = await fixtureForAudit({
          credentialMutationLeaseRenewalIntervalMs: 60_000,
          renewCredentialMutationLease: async () =>
            ++renewals !== (failureAt === "inside_transaction" ? 2 : 3),
        });
        try {
          await expect(
            context.service.replaceResources(
              context.endpoint.id,
              [{ id: context.resource.id, enabled: false }],
              "owner-user",
            ),
          ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
          const committed = failureAt === "after_commit";
          expect(await context.current()).toEqual([{ enabled: !committed }]);
          expect(await context.audits()).toHaveLength(committed ? 1 : 0);
          expect(context.events).toHaveLength(committed ? 1 : 0);
          await context.service.replaceResources(
            context.endpoint.id,
            [{ id: context.resource.id, enabled: false }],
            "owner-user",
          );
          expect(await context.audits()).toHaveLength(1);
          expect(context.events).toHaveLength(1);
        } finally {
          await context.cleanup();
        }
      },
    );

    it("reads the actual resource state after the row lock, not a pre-lock snapshot", async () => {
      const context = await fixtureForAudit();
      let ready!: (pid: number) => void;
      const held = new Promise<number>((resolve) => {
        ready = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction(async (tx) => {
        await tx
          .update(chatEndpointResources)
          .set({ enabled: false })
          .where(eq(chatEndpointResources.id, context.resource.id));
        const [row] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        ready(row!.pid);
        await gate;
      });
      let mutation: Promise<unknown> | undefined;
      try {
        const pid = await held;
        mutation = context.service.replaceResources(
          context.endpoint.id,
          [{ id: context.resource.id, enabled: false }],
          "owner-user",
        );
        await vi.waitFor(async () => {
          const [row] = (await db.execute(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${pid} = any(pg_blocking_pids(pid))
          ) as blocked`)) as unknown as Array<{ blocked: boolean }>;
          expect(row!.blocked).toBe(true);
        });
        release();
        await Promise.all([transaction, mutation]);
        expect(await context.current()).toEqual([{ enabled: false }]);
        expect(await context.audits()).toEqual([]);
        expect(context.events).toEqual([]);
        await context.service.replaceResources(
          context.endpoint.id,
          [{ id: context.resource.id, enabled: true }],
          "owner-user",
        );
        expect(await context.audits()).toMatchObject([
          {
            details: {
              changes: [
                {
                  resourceId: context.resource.id,
                  before: { enabled: false },
                  after: { enabled: true },
                },
              ],
            },
          },
        ]);
      } finally {
        release();
        await Promise.allSettled([
          transaction,
          ...(mutation ? [mutation] : []),
        ]);
        await context.cleanup();
      }
    });

    it("joins concurrent identical and opposite changes into actual before/after history", async () => {
      const context = await fixtureForAudit();
      try {
        const change = (enabled: boolean) =>
          context.service.replaceResources(
            context.endpoint.id,
            [{ id: context.resource.id, enabled }],
            "owner-user",
          );
        await Promise.all([change(false), change(false)]);
        expect(await context.audits()).toHaveLength(1);
        await Promise.all([change(true), change(false)]);
        const rows = await context.audits();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        let enabled = true;
        for (const row of rows) {
          const changes = row.details!.changes as Array<{
            resourceId: string;
            before: { enabled: boolean };
            after: { enabled: boolean };
          }>;
          expect(changes).toHaveLength(1);
          expect(changes[0]!.resourceId).toBe(context.resource.id);
          expect(changes[0]!.before.enabled).toBe(enabled);
          expect(changes[0]!.after.enabled).toBe(!enabled);
          enabled = !enabled;
        }
        expect(await context.current()).toEqual([{ enabled }]);
        expect(context.events).toHaveLength(rows.length);
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await context.cleanup();
      }
    });
  });

  it.each(["slack", "discord", "github"] as const)("preserves the public inventory error response for %s", async (provider) => {
    const fixture = await seedCompany();
    let failInventory = false;
    let service: ChatChannelService;
    let endpoint: Awaited<ReturnType<ChatChannelService["create"]>>;
    if (provider === "slack") {
      const successfulFetch = fakeSlackFetch();
      const context = await configuredSlackEndpoint(fixture, {
        fetch: (async (input, init) => {
          if (failInventory && String(input).includes("/conversations.list"))
            throw new Error("inventory fixture outage");
          return successfulFetch(input, init);
        }) as typeof fetch,
      });
      ({ service, endpoint } = context);
    } else if (provider === "discord") {
      const applicationId = uniqueDiscordApplicationId();
      const successfulFetch = fakeDiscordFetch(applicationId);
      const context = createService(new FakeChatSdkRuntime(), (async (input) => {
        if (failInventory && new URL(String(input)).pathname.endsWith("/channels"))
          throw new Error("inventory fixture outage");
        return successfulFetch(input);
      }) as typeof fetch);
      service = context.service;
      endpoint = await service.create(fixture.companyId, {
        provider, assignedAgentId: fixture.assignedAgentId,
      }, "owner-user");
      await service.configure(endpoint.id, {
        action: "configure",
        credentials: { applicationId, botToken: "discord-secret", guildId: "1457808928258658549" },
      }, "owner-user");
    } else {
      const context = await configuredGitHubEndpoint(fixture);
      ({ service, endpoint } = context);
      context.setSupplementalProviderFetch(async (input) => {
        if (failInventory && String(input).includes("/app/installations?"))
          throw new Error("inventory fixture outage");
        return undefined;
      });
    }
    const [before] = await readToolConnectionsById(endpoint.connectionId);
    failInventory = true;
    const response = await request(routesApp(db, fixture.companyId, service))
      .post(`/api/chat-endpoints/${endpoint.id}/setup`)
      .send({ action: "reconnect" });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("inventory fixture outage"),
      details: { code: "chat_provider_inventory_failed" },
    });
    const [after] = await readToolConnectionsById(endpoint.connectionId);
    expect(after.credentialSecretRefs).toEqual(before.credentialSecretRefs);
  });

  it("rejects under-scoped Slack and GitHub apps before saving provider credentials", async () => {
    const fixture = await seedCompany();
    const slack = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://slack.com/api/auth.test") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T-UNDER-SCOPED",
          team: "Under-scoped",
          user_id: "U-UNDER-SCOPED",
          user: "maya-under-scoped",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "chat:write",
          },
        },
      );
    }) as typeof globalThis.fetch);
    const slackEndpoint = await slack.service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      slack.service.configure(
        slackEndpoint.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-under-scoped",
            signingSecret: "signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "slack",
      },
    });

    const appId = "991122";
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const github = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://api.github.com/app") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          id: 991122,
          slug: "maya-under-scoped",
          name: "Maya Under-scoped",
          owner: { login: "paperclipai" },
          permissions: {
            issues: "read",
            metadata: "read",
            pull_requests: "write",
          },
          events: ["issue_comment"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);
    const githubEndpoint = await github.service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const { webhookSecret } = await github.service.generateSetupSecret(
      githubEndpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      github.service,
      githubEndpoint.publicId,
      webhookSecret,
    );
    await expect(
      github.service.configure(
        githubEndpoint.id,
        {
          action: "configure",
          credentials: {
            appId,
            privateKey,
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: ["issues"],
      },
    });

    const connections = await db
      .select({
        id: toolConnections.id,
        refs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(
        inArray(toolConnections.id, [
          slackEndpoint.connectionId,
          githubEndpoint.connectionId,
        ]),
      );
    expect(
      connections.find(
        (connection) => connection.id === slackEndpoint.connectionId,
      )?.refs,
    ).toEqual([]);
    expect(
      connections.find(
        (connection) => connection.id === githubEndpoint.connectionId,
      )?.refs,
    ).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it("reconciles Slack membership during configure, resume, and reconnect", async () => {
    const fixture = await seedCompany();
    let channels = [
      { id: "C-ONE", name: "one", is_member: true, is_archived: false, creator: "U-HUMAN" },
    ];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-RECONCILE",
            team: "Reconcile Test",
            user_id: "U-RECONCILE",
            user: "maya-reconcile",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels,
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-ONE",
        availability: "available",
        enabled: true,
      }),
    ]);

    const [firstResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [{ id: firstResource!.id, enabled: false }]);
    await service.configure(endpoint.id, { action: "reconnect", credentials: {
      botToken: "xoxb-reconcile", signingSecret: "reconcile-signing-secret",
    } }, "owner-user");
    expect((await service.listResources(endpoint.id))[0]).toMatchObject({
      id: firstResource!.id, enabled: false, availability: "available",
    });

    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    channels = [
      { id: "C-TWO", name: "two", is_member: true, is_archived: false, creator: "U-HUMAN" },
    ];
    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-TWO", availability: "available" },
    ]);

    await db
      .update(chatEndpoints)
      .set({ status: "attention" })
      .where(eq(chatEndpoints.id, endpoint.id));
    channels = [
      { id: "C-THREE", name: "three", is_member: true, is_archived: false, creator: "U-RECONCILE" },
    ];
    await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-THREE", availability: "available" },
      { id: "C-TWO", availability: "unavailable" },
    ]);
    expect((await service.listResources(endpoint.id)).find(resource => resource.providerResourceId === "C-THREE"))
      .toMatchObject({ enabled: false });
  });

  it("rejects reconnect credentials for a different Slack bot without rotating secrets", async () => {
    const fixture = await seedCompany();
    let botId = "U-ORIGINAL-BOT";
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-IMMUTABLE",
            team: "Immutable Test",
            user_id: botId,
            user: botId === "U-ORIGINAL-BOT" ? "maya-original" : "maya-other",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-original",
          signingSecret: "original-secret",
        },
      },
      "owner-user",
    );
    const [before] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));

    botId = "U-DIFFERENT-BOT";
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: {
            botToken: "xoxb-different",
            signingSecret: "different-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });

    const [after] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(after.refs).toEqual(before.refs);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      botExternalId: "U-ORIGINAL-BOT",
    });
  });

  it.each(["membership-first", "mention-first"])(
    "accepts the Slack invitation mention exactly once (%s)",
    async (order) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture);
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const current = await service.get(endpoint.id);
      const channel = makeThread({
        channelId: "C-INVITED",
        id: "slack:C-INVITED:100.1",
        name: "invited",
      });
      const mention = () =>
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: channel.thread,
          message: makeMessage({
            id: "100.1",
            text: "@maya summarize the recent papercuts",
            mentioned: true,
          }),
          trigger: "mention",
        });
      const joined = () =>
        service.handleWebhook(
          endpoint.publicId,
          "slack",
          new Request("https://paperclip.example/slack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_id: "Ev-invited",
              event: {
                type: "member_joined_channel",
                event_ts: "101.0",
                user: current.botExternalId,
                channel: "C-INVITED",
                channel_type: "C",
              },
            }),
          }),
        );
      if (order === "membership-first") {
        await joined();
        await mention();
      } else {
        await mention();
        await joined();
      }
      // Slack may retry either event. Neither changes the resource choice or starts duplicate work.
      await joined();
      await mention();
      const resources = await service.listResources(endpoint.id);
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        providerResourceId: "C-INVITED",
        availability: "available",
        enabled: true,
      });
      expect(await service.listConversations(endpoint.id)).toHaveLength(1);
      expect(
        await readIssuesByCompanyId(fixture.companyId),
      ).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["verifying", "active"] as const)(
    "preserves an explicitly disabled Slack channel after invitation and mentions (%s)",
    async (status) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredSlackEndpoint(fixture);
      if (status === "active")
        await db
          .update(chatEndpoints)
          .set({ status })
          .where(eq(chatEndpoints.id, endpoint.id));
      const current = await service.get(endpoint.id);
      let eventSequence = 100;
      const membership = (type: string) =>
        service.handleWebhook(
          endpoint.publicId,
          "slack",
          new Request("https://paperclip.example/slack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_id: `Ev-disabled-${eventSequence}`,
              event: {
                type,
                event_ts: String(eventSequence++),
                user: current.botExternalId,
                channel: "C-DISABLED",
                channel_type: "C",
              },
            }),
          }),
        );
      await membership("member_joined_channel");
      const [resource] = await service.listResources(endpoint.id);
      expect(resource!.enabled).toBe(true);
      await service.replaceResources(endpoint.id, [
        { id: resource!.id, enabled: false },
      ]);
      await membership("member_left_channel");
      await membership("member_joined_channel");
      const channel = makeThread({
        channelId: "C-DISABLED",
        id: "slack:C-DISABLED:200.1",
        name: "disabled",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "200.1",
          text: "@maya do not override the opt-out",
          mentioned: true,
        }),
        trigger: "mention",
      });
      expect((await service.listResources(endpoint.id))[0]).toMatchObject({
        enabled: false,
        availability: "available",
      });
      expect(await service.listConversations(endpoint.id)).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  it("persists Slack membership, uninstall, and same-bot reinstall lifecycle before acknowledging", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const send = (payload: unknown) =>
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

    await send({
      event_id: "Ev-member-joined",
      event: {
        type: "member_joined_channel",
        event_ts: "100.000000",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
        channel_type: "C",
      },
    });
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    expect(resource).toMatchObject({
      providerResourceId: "C-LIFECYCLE",
      availability: "available",
      enabled: true,
    });
    await vi.waitFor(async () => {
      await expect(service.listResources(endpoint.id)).resolves.toEqual([
        expect.objectContaining({ label: "#c-lifecycle" }),
      ]);
    });
    await service.replaceResources(endpoint.id, [
      { id: resource.id, enabled: true },
    ]);

    const thread = makeThread({
      channelId: "C-LIFECYCLE",
      id: "slack:C-LIFECYCLE:123.45",
      name: "slack:C-LIFECYCLE",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "123.45",
        text: "@maya preserve this task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversation).toBeDefined();
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ label: "#c-lifecycle" }),
    ]);

    const leftEvent = {
      event_id: "Ev-member-left",
      event: {
        type: "channel_left",
        event_ts: "200.000000",
        channel: "C-LIFECYCLE",
      },
    };
    await send(leftEvent);
    await send(leftEvent);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-LIFECYCLE",
        availability: "unavailable",
        label: "#c-lifecycle",
      }),
    ]);
    expect(
      await db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).toEqual([{ state: "unavailable" }]);
    expect(
      await readIssuesById(conversation.issueId),
    ).toHaveLength(1);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: makeThread({
        channelId: "C-LIFECYCLE",
        id: "slack:C-LIFECYCLE:999.01",
        name: "lifecycle",
      }).thread,
      message: makeMessage({
        id: "999.01",
        text: "@maya this delayed root must stay blocked",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(1);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await send({
      event_id: "Ev-stale-member-joined",
      event: {
        type: "member_joined_channel",
        event_ts: "150.000000",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
      },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    expect(
      (
        await readChatDeliveriesByEndpointId(endpoint.id)
      ).filter(
        (delivery) => delivery.providerEventId === "lifecycle:Ev-member-left",
      ),
    ).toHaveLength(1);

    await send({
      event_id: "Ev-uninstalled",
      event: { type: "app_uninstalled" },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "Slack app was uninstalled",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const [connection] = await readToolConnectionsById(endpoint.connectionId);
    expect(connection).toMatchObject({
      status: "disabled",
      enabled: false,
      healthStatus: "failed",
    });

    const reconnecting = await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    expect(reconnecting).toMatchObject({
      status: "verifying",
      botExternalId: configuredEndpoint.botExternalId,
      // Same app, signing secret, and callback URL retain their signed proof.
      setup: { step: "provider_setup", webhookVerifiedAt: configuredEndpoint.setup?.webhookVerifiedAt },
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await recordSlackUrlVerification(service, endpoint.publicId);
    await expect(
      service.configure(endpoint.id, { action: "verify" }, "owner-user"),
    ).resolves.toMatchObject({
      status: "verifying",
      setup: { step: "test", webhookVerifiedAt: expect.any(String) },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-LIFECYCLE",
        availability: "unavailable",
        enabled: true,
        label: "#c-lifecycle",
      }),
    ]);
  });

  it("orders Slack private-channel archive, unarchive, and rename lifecycle", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`;
    const send = async (
      eventId: string,
      type: string,
      eventTs: string,
      channel: string | { id: string; name: string },
    ) => {
      const body = JSON.stringify({
        event_id: eventId,
        event: { type, event_ts: eventTs, channel },
      });
      await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedSlackWebhookRequest({
          url: webhookUrl,
          contentType: "application/json",
          body,
        }),
      );
    };
    const resource = async () =>
      (await service.listResources(endpoint.id)).find(
        (candidate) => candidate.providerResourceId === "G-PRIVATE-LIFECYCLE",
      );

    await send(
      "Ev-group-archive",
      "group_archive",
      "300.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await expect(resource()).resolves.toMatchObject({
      availability: "unavailable",
    });

    await send(
      "Ev-group-unarchive",
      "group_unarchive",
      "400.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await send(
      "Ev-stale-group-archive",
      "group_archive",
      "350.000000",
      "G-PRIVATE-LIFECYCLE",
    );
    await expect(resource()).resolves.toMatchObject({
      availability: "available",
    });

    await send("Ev-group-rename", "group_rename", "500.000000", {
      id: "G-PRIVATE-LIFECYCLE",
      name: "private-renamed",
    });
    await expect(resource()).resolves.toMatchObject({
      availability: "available",
      label: "private-renamed",
    });
  });

  it("does not acknowledge lifecycle callbacks whose durable write fails", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected provider runtime");
    providerRuntime.handleWebhook = vi.fn(async () => {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      return new Response("accepted", { status: 202 });
    });
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: "Ev-must-persist",
            event: {
              type: "member_joined_channel",
              user: configuredEndpoint.botExternalId,
              channel: "C-MUST-PERSIST",
            },
          }),
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("activates Slack only after provider verification and a real test message", async () => {
    const fixture = await seedCompany();
    const { runtime, service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    expect(endpoint.allowUnlinkedPeople).toBe(false);
    await service.update(endpoint.id, { allowUnlinkedPeople: true }, "owner-user");

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    expect(configured).toMatchObject({
      status: "verifying",
      setup: { step: "provider_setup" },
    });
    const [storedConfigured] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedConfigured.setup).toMatchObject({
      step: "provider_setup",
      testStartedAt: null,
      webhookVerifiedAt: null,
      runtimeGeneration: expect.any(Number),
    });

    await expect(
      service.configure(endpoint.id, { action: "verify" }, "owner-user"),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_webhook_not_verified" },
    });
    await recordSlackUrlVerification(service, endpoint.publicId);

    const providerVerified = await service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    expect(providerVerified).toMatchObject({
      status: "verifying",
      setup: { step: "test" },
    });
    const [storedProviderVerified] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedProviderVerified.setup).toMatchObject({
      step: "test",
      testStartedAt: expect.any(String),
    });
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_message_missing" },
    });

    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    const testThread = makeThread({
      channelId: "C-SETUP",
      id: "slack:C-SETUP:9000.1",
      name: "setup",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9000.1",
        text: "@maya verify this connection",
        mentioned: true,
      }),
      trigger: "mention",
    });

    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_follow_up_missing" },
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const activated = await service.test(endpoint.id);
    expect(activated).toMatchObject({
      status: "active",
      healthMessage: "Connected",
      activatedAt: expect.any(String),
      setup: { step: "complete" },
    });
    const [storedActivated] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedActivated.setup).toMatchObject({
      step: "complete",
      testStartedAt: null,
      runtimeGeneration: expect.any(Number),
    });
  });

  it("paginates mixed activity beyond 100 rows without losing timestamp ties", async () => {
    const fixture = await seedCompany();
    const { service } = createService(new FakeChatSdkRuntime(), fakeSlackFetch());
    const endpoint = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    const other = await service.create(fixture.companyId, { provider: "slack", assignedAgentId: fixture.assignedAgentId }, "owner-user");
    const createdAt = new Date("2026-01-01T00:00:00.123Z");
    const deliveries = await db.insert(chatDeliveries).values(Array.from({ length: 110 }, (_, index) => ({
      companyId: fixture.companyId, endpointId: endpoint.id,
      providerEventId: `page-${index}`, deduplicationKey: `page-${index}`,
      eventKind: "message" as const, normalizedEvent: {}, state: "processed" as const, createdAt,
    }))).returning();
    const actions = await db.insert(chatActions).values(Array.from({ length: 15 }, (_, index) => ({
      companyId: fixture.companyId, endpointId: endpoint.id,
      kind: "slack_session_sync", providerActionId: `page-${index}`,
      // Activity for session actions follows updatedAt, not createdAt.
      createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: createdAt,
    }))).returning();
    await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: other.id, kind: "slash_task_start", providerActionId: "other-endpoint", createdAt });
    const expected = [...deliveries, ...actions].map((row) => row.id).sort((a, b) => b.localeCompare(a));
    const found: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await service.listActivityPage(endpoint.id, 25, cursor);
      expect(result.items).toHaveLength(25);
      found.push(...result.items.map((row) => row.id));
      expect(Boolean(result.nextCursor)).toBe(page < 4);
      cursor = result.nextCursor ?? undefined;
      if (page === 0) {
        // New arrivals must not shift the older pages.
        await db.insert(chatActions).values({ companyId: fixture.companyId, endpointId: endpoint.id, kind: "slash_task_start", providerActionId: "new-arrival", createdAt: new Date("2026-01-02T00:00:00Z") });
      }
    }
    expect(found).toEqual(expected);
    expect(await service.listActivity(endpoint.id)).toHaveLength(100);
    await expect(service.listActivityPage(endpoint.id, 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.listActivityPage(endpoint.id, 101)).rejects.toMatchObject({ status: 400 });
    await expect(service.listActivityPage(endpoint.id, 25, "invalid")).rejects.toMatchObject({ status: 400 });
  });

  it("starts real Slack conversations from bare mentions and accepts same-thread follow-ups", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredSlackEndpoint(fixture, { linkedBoardUser: true, allowUnlinkedPeople: false });
    const configured = await service.get(endpoint.id);
    const variants = [
      "",
      "   \t\n",
      `<@${configured.botExternalId}>`,
      ` \u200b <@${configured.botExternalId}>  @maya !!! `,
    ];

    for (const [index, text] of variants.entries()) {
      const root = makeThread({
        channelId: "C-EMPTY-MENTION",
        id: `slack:C-EMPTY-MENTION:3200.${index}`,
        name: "empty-mention",
      });
      const message = makeMessage({
        id: `3200.${index}`,
        text,
        mentioned: true,
        userId: "UBOARD",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });

      expect(root.post).not.toHaveBeenCalled();
      expect(root.subscribe).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledTimes(index * 2 + 1);
      const conversation = (await service.listConversations(endpoint.id)).find(row => row.externalThreadId === root.thread.id)!;
      expect(conversation).toMatchObject({ state: "active" });
      const task = await readIssuesById(conversation.issueId!).then(rows => rows[0]);
      expect(task).toMatchObject({ assigneeAgentId: fixture.assignedAgentId, responsibleUserId: "owner-user" });
      await deliverMessage({
        callbacks, endpointId: endpoint.id, thread: root.thread,
        message: makeMessage({ id: `3201.${index}`, text: "u there?", userId: "UBOARD" }),
        trigger: "subscribed_message",
      });
      expect(wakeup).toHaveBeenCalledTimes(index * 2 + 2);
      const comments = await readIssueCommentsByIssueId(task!.id).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(comments.map(comment => comment.body)).toEqual([text.trim() || "Started a conversation by mentioning the agent.", "u there?"]);
      expect(runtime.endpoints.get(endpoint.id)?.reactions).toContainEqual({
        threadId: root.thread.id,
        messageId: message.id,
        emoji: "eyes",
      });
      expect(root.addReaction).not.toHaveBeenCalled();
    }

    expect(await service.listConversations(endpoint.id)).toHaveLength(variants.length);
    expect(
      await readIssuesByCompanyId(fixture.companyId),
    ).toHaveLength(variants.length);
    expect(
      await readHeartbeatRunsByCompanyId(fixture.companyId),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.companyId, fixture.companyId)),
    ).toHaveLength(0);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deliveries).toHaveLength(variants.length * 2);
    expect(
      deliveries.every(
        (delivery) =>
          delivery.state === "processed" &&
          (delivery.eventKind !== "mention" || (delivery.normalizedEvent.deduplication as { duplicateCount?: number } | undefined)?.duplicateCount === 1),
      ),
    ).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(variants.length * 2);
  });
});
