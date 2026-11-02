import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as tables from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { completedHistoryChecks, readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { readIdleIssueSchedule } from "../services/idle-issue-schedule.js";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import { inspectIdleSpool } from "../services/idle-local-work.js";

describe("retained completed history", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof tables.createDb>;
  const now = new Date();
  const ownerId = randomUUID();
  const hold = () => ({ ownerId, draining: true, startedAt: new Date(now.getTime() - 1000),
    expiresAt: new Date(Date.now() + 60_000), activeRuns: 0, pendingWakes: 0 });
  const read = () => readIdleSleepSafety(db, hold, Date.now, ownerId, async () => "none");
  const blocked = async (reason: string) => {
    const check = completedHistoryChecks.find(check => check.reason === reason);
    if (!check) throw new Error(`Missing family ${reason}`);
    const [row] = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (${sql.raw(check.query)}) AS blocked`);
    return row.blocked;
  };
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");
    if (!external) database = await startEmbeddedPostgresTestDatabase("idle-history-");
    db = tables.createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(tables.companies).values({ id: companyId, name: "Retained history", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(tables.agents).values({ id: agentId, companyId, name: "Idle agent", status: "idle", adapterType: "process" });
    await db.insert(tables.issues).values({ id: issueId, companyId, title: "Finished work", status: "done", assigneeAgentId: agentId });
    await db.insert(tables.heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded",
      invocationSource: "on_demand", finishedAt: now, contextSnapshot: { issueId } });
    return { companyId, agentId, issueId, runId };
  }

  async function connection(f: Awaited<ReturnType<typeof seed>>) {
    const [application] = await db.insert(tables.toolApplications).values({ companyId: f.companyId,
      applicationKey: randomUUID(), name: "History fixture", type: "rest_api" }).returning();
    const [connection] = await db.insert(tables.toolConnections).values({ companyId: f.companyId,
      applicationId: application.id, name: "Disabled draft", uid: randomUUID(), transport: "rest_api", status: "draft", enabled: false }).returning();
    const [grant] = await db.insert(tables.connectionGrants).values({ companyId: f.companyId, connectionId: connection.id,
      kind: "organization", status: "revoked", revokedAt: now }).returning();
    return { connectionId: connection.id, grantId: grant.id };
  }

  async function mcp(f: Awaited<ReturnType<typeof seed>>, agent = false) {
    const userId = randomUUID(), clientId = randomUUID();
    await db.insert(tables.authUsers).values({ id: userId, name: "History user", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(tables.mcpOauthClients).values({ id: clientId, name: "History client", redirectUris: ["https://example.test/callback"] });
    const [grant] = await db.insert(tables.mcpOauthGrants).values({ companyId: f.companyId, userId, clientId,
      resource: "https://example.test/mcp", purpose: agent ? "agent" : "personal", agentId: agent ? f.agentId : null,
      scopes: agent ? ["paperclip:agent", "offline_access"] : ["paperclip:read"], revokedAt: now }).returning();
    return { userId, grantId: grant.id };
  }

  async function decisionFixture() {
    const { decisionService } = await import("../services/decisions.js");
    const f = await seed(), p = await mcp(f);
    await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
      status: "active", membershipRole: "member" });
    await db.update(tables.heartbeatRuns).set({ status: "running", responsibleUserId: p.userId }).where(eq(tables.heartbeatRuns.id, f.runId));
    await db.update(tables.issues).set({ status: "in_progress", responsibleUserId: p.userId }).where(eq(tables.issues.id, f.issueId));
    const actor = { type: "agent" as const, companyId: f.companyId, agentId: f.agentId, runId: f.runId, source: "agent_jwt" as const,
      onBehalfOfUserId: p.userId, onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] };
    const userActor = { type: "board" as const, userId: p.userId, companyIds: [f.companyId], source: "session" as const,
      memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] };
    const service = decisionService(db, { wakeOriginAgent: async () => null });
    const finish = () => db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(tables.heartbeatRuns.id, f.runId));
    return { ...f, ...p, actor, userActor, service, finish };
  }

  async function connectedMcp(f: Awaited<ReturnType<typeof seed>>) {
    const { createPublicMcpOAuth, hashMcpSecret } = await import("../services/public-mcp/oauth.js");
    const { createMcpApiDispatch } = await import("../services/public-mcp/capabilities.js");
    const { issueRoutes } = await import("../routes/issues.js");
    const { createStorageService } = await import("../storage/service.js");
    const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const { Router } = await import("express");
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
    const p = await mcp(f), origin = "https://history.example", resource = `${origin}/mcp/paperclip`;
    await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
      membershipRole: "owner", status: "active" });
    await db.update(tables.mcpOauthGrants).set({ revokedAt: null, resource, scopes: ["paperclip:read", "paperclip:write"] })
      .where(eq(tables.mcpOauthGrants.id, p.grantId));
    const token = randomBytes(32).toString("base64url");
    await db.insert(tables.mcpOauthTokens).values({ grantId: p.grantId, kind: "access", tokenHash: hashMcpSecret(token),
      expiresAt: new Date(Date.now() + 600_000) });
    const directory = await mkdtemp(path.join(tmpdir(), "history-mcp-storage-"));
    const router = Router();
    router.use(issueRoutes(db, createStorageService(createLocalDiskStorageProvider(directory))));
    const oauth = createPublicMcpOAuth(db, { origin, resource }), api = createMcpApiDispatch(router);
    return { ...p, token, oauth, api, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  it("checks all 32 families on the real migrated schema and keeps an empty instance eligible", async () => {
    expect(new Set(completedHistoryChecks.map(c => c.reason)).size).toBe(32);
    for (const check of completedHistoryChecks) expect(await blocked(check.reason), check.reason).toBe(false);
    expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
  });

  it.each(["completed", "cancelled"] as const)("retains a %s transfer without hiding its actual spool", async status => {
    const f = await seed();
    const result = await companyTransferRunService.resumeOrCreate(db, { companyId: f.companyId, direction: "import",
      actorKey: "board:history", idempotencyKey: randomUUID(), containerRef: { kind: "upload" } });
    expect(await blocked("company_transfer_runs")).toBe(true);
    if (status === "completed") await companyTransferRunService.complete(db, result.run.id);
    else await companyTransferRunService.cancel(db, result.run.id);
    expect(await blocked("company_transfer_runs")).toBe(false);
    const directory = await mkdtemp(path.join(tmpdir(), "history-spool-"));
    try {
      await writeFile(path.join(directory, result.run.id), "unfinished cleanup");
      const local = () => inspectIdleSpool(directory);
      expect(await readIdleSleepSafety(db, hold, Date.now, ownerId, local)).toEqual({ version: 1, backgroundWork: "present" });
      await rm(path.join(directory, result.run.id));
      expect(await readIdleSleepSafety(db, hold, Date.now, ownerId, local)).toEqual({ version: 1, backgroundWork: "none" });
      expect(await companyTransferRunService.getRun(db, result.run.id)).toMatchObject({ status });
      const next = await companyTransferRunService.resumeOrCreate(db, { companyId: f.companyId, direction: "import",
        actorKey: "board:history", idempotencyKey: randomUUID(), containerRef: { kind: "upload" } });
      expect(await blocked("company_transfer_runs")).toBe(true);
      await companyTransferRunService.fail(db, next.run.id, "retry remains available");
      expect(await blocked("company_transfer_runs")).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("accepts MCP completion receipts and cleanup while preserving unknown writes and pending uploads", async () => {
    const f = await seed(), p = await mcp(f);
    const [receipt] = await db.insert(tables.mcpMutationReceipts).values({ ...p, companyId: f.companyId,
      operation: "paperclip_create_task", requestId: randomUUID(), argumentsHash: "a", status: "completed", result: { id: f.issueId } }).returning();
    const [upload] = await db.insert(tables.mcpAttachmentUploads).values({ ...p, companyId: f.companyId, taskId: f.issueId,
      requestId: randomUUID(), argumentsHash: "a", originalFilename: "history.txt", contentType: "text/plain", byteSize: 1,
      sha256: "a".repeat(64), objectKey: "history/abandoned", storageProvider: "local_disk", expiresAt: now, cleanedAt: now }).returning();
    expect(await blocked("mcp_mutation_receipts")).toBe(false);
    expect(await blocked("mcp_attachment_uploads")).toBe(false);
    expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
    await db.update(tables.mcpMutationReceipts).set({ status: "unknown" }).where(eq(tables.mcpMutationReceipts.id, receipt.id));
    expect(await blocked("mcp_mutation_receipts")).toBe(true);
    await db.update(tables.mcpMutationReceipts).set({ status: "completed", result: null }).where(eq(tables.mcpMutationReceipts.id, receipt.id));
    expect(await blocked("mcp_mutation_receipts")).toBe(true);
    await db.update(tables.mcpAttachmentUploads).set({ cleanedAt: null }).where(eq(tables.mcpAttachmentUploads.id, upload.id));
    expect(await blocked("mcp_attachment_uploads")).toBe(true);
  });

  it("retains the real MCP mutation receipt and still blocks the actual task it creates", async () => {
    const { createPublicMcpExecutor } = await import("../services/public-mcp/capabilities.js");
    const f = await seed(), p = await connectedMcp(f);
    try {
      // Pausing is the product's ordinary admission control. No provider turn
      // is run merely to exercise a mutation receipt or task creation.
      await db.update(tables.agents).set({ status: "paused" }).where(eq(tables.agents.id, f.agentId));
      const execute = createPublicMcpExecutor(db, p.oauth, p.api);
      const input = { companyId: f.companyId, title: "Actual MCP producer", description: "Retained receipt",
        requestId: randomUUID(), assigneeAgentId: f.agentId };
      const result = await execute(p.token, "paperclip_create_task", input);
      expect(result).toHaveProperty("task.status", "todo");
      expect(await blocked("mcp_mutation_receipts")).toBe(false);
      expect(await execute(p.token, "paperclip_create_task", input)).toEqual(result);
      expect(await db.select().from(tables.mcpMutationReceipts)).toHaveLength(1);
      expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
      const receipt = (await db.select().from(tables.mcpMutationReceipts))[0];
      await db.update(tables.mcpMutationReceipts).set({ status: "reserved" }).where(eq(tables.mcpMutationReceipts.id, receipt.id));
      expect(await blocked("mcp_mutation_receipts")).toBe(true);
    } finally { await p.cleanup(); }
  }, 60_000);

  it.each([200, 410])("uses actual MCP subscription and callback delivery receipts for HTTP %s", async status => {
    const { createPublicMcpEvents } = await import("../services/public-mcp/events.js");
    const { logActivity } = await import("../services/activity-log.js");
    const f = await seed(), p = await connectedMcp(f);
    try {
      let received = 0;
      const events = createPublicMcpEvents(db, p.oauth, p.api, { fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.type === "verification") return Response.json({ challenge: body.challenge });
        received += 1;
        return new Response(null, { status });
      } });
      const principal = await p.oauth.authenticate(p.token);
      await events.subscribe(principal, { name: "paperclip.task.status_changed", arguments: { companyId: f.companyId, taskId: f.issueId },
        delivery: { mode: "webhook", url: "https://receiver.example/events", secret: `whsec_${randomBytes(32).toString("base64")}` } });
      await logActivity(db, { companyId: f.companyId, actorType: "system", actorId: "history",
        action: "issue.updated", entityType: "issue", entityId: f.issueId, details: { status: "done" } });
      await events.tick();
      expect(received).toBeGreaterThan(0);
      expect(await blocked("mcp_event_deliveries")).toBe(false);
      expect((await db.select().from(tables.mcpEventDeliveries)).every(row => row.finishedAt !== null)).toBe(true);
      expect(await blocked("mcp_event_subscriptions")).toBe(status !== 410);
      expect(await blocked("mcp_oauth_grants")).toBe(true);
    } finally { await p.cleanup(); }
  }, 60_000);

  it.each(["delivered", "filtered", "inactive", "delivery_exhausted", "http_400", "http_503"])("retires finished MCP event outcome %s only with its source", async outcome => {
    const f = await seed(), p = await mcp(f);
    const subscriptionId = randomUUID();
    await db.insert(tables.mcpEventSubscriptions).values({ id: subscriptionId, companyId: f.companyId, grantId: p.grantId,
      name: "paperclip.task.updated", taskId: f.issueId, arguments: { taskId: f.issueId }, deliveryMaterial: {}, verifiedAt: now,
      expiresAt: now, stoppedAt: now });
    const [activity] = await db.insert(tables.activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "history",
      action: "issue.updated", entityType: "issue", entityId: f.issueId }).returning();
    const [delivery] = await db.insert(tables.mcpEventDeliveries).values({ subscriptionId, activityId: activity.id,
      event: {}, finishedAt: now, outcome, attempts: 6 }).returning();
    expect(await blocked("mcp_event_subscriptions")).toBe(false);
    expect(await blocked("mcp_event_deliveries")).toBe(false);
    await db.update(tables.mcpEventDeliveries).set({ finishedAt: null }).where(eq(tables.mcpEventDeliveries.id, delivery.id));
    expect(await blocked("mcp_event_deliveries")).toBe(true);
  });

  it("keeps browser accounting, run ownership and provider resource cleanup independent", async () => {
    const f = await seed(), c = await connection(f), invocationId = randomUUID();
    const [session] = await db.insert(tables.browserUseSessions).values({ ...f, ...c, status: "closed", providerSessionId: randomUUID() }).returning();
    const [run] = await db.insert(tables.browserUseRuns).values({ companyId: f.companyId, sessionId: session.id, heartbeatRunId: f.runId,
      invocationId, providerRunId: randomUUID(), status: "completed", eventsDrained: 1,
      result: { paperclipBudgetHold: { invocationId, state: "settled", accountedCentsExact: "0.0000000" } } }).returning();
    const [browser] = await db.insert(tables.browserUseBrowsers).values({ companyId: f.companyId, sessionId: session.id,
      providerBrowserId: randomUUID(), status: "stopped" }).returning();
    for (const reason of ["browser_use_sessions", "browser_use_runs", "browser_use_browsers"]) expect(await blocked(reason)).toBe(false);
    await db.update(tables.browserUseRuns).set({ eventsDrained: 0 }).where(eq(tables.browserUseRuns.id, run.id));
    expect(await blocked("browser_use_sessions")).toBe(true);
    expect(await blocked("browser_use_runs")).toBe(true);
    await db.update(tables.browserUseRuns).set({ eventsDrained: 1 }).where(eq(tables.browserUseRuns.id, run.id));
    await db.update(tables.browserUseBrowsers).set({ status: "active" }).where(eq(tables.browserUseBrowsers.id, browser.id));
    expect(await blocked("browser_use_sessions")).toBe(true);
    expect(await blocked("browser_use_browsers")).toBe(true);
  });

  it("uses one conversation proof for ordinary and scheduled reports and detects the comment-to-wake crash window", async () => {
    const { issueService } = await import("../services/issues.js");
    const { settleConversationTurn } = await import("../services/agent-conversations.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const f = await seed();
    const service = issueService(db);
    const conversation = await service.create(f.companyId, { title: "History chat", assigneeAgentId: f.agentId,
      conversationAgentId: f.agentId, conversationUserId: "local-board", conversationState: "waiting", status: "in_review" });
    expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
    expect((await readIdleIssueSchedule(db, ownerId, Date.now())).blocked).toBe(false);
    const comment = await service.addComment(conversation.id, "A new question", { userId: "local-board" },
      { clientRequestId: randomUUID() });
    expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
    // Preserve the original comment but reproduce the crash before enqueue.
    await db.update(tables.issues).set({ conversationState: "waiting" }).where(eq(tables.issues.id, conversation.id));
    expect((await readIdleIssueSchedule(db, ownerId, Date.now())).blocked).toBe(true);
    const runId = randomUUID();
    const [run] = await db.insert(tables.heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "succeeded", finishedAt: now,
      contextSnapshot: { issueId: conversation.id, commentId: comment.id, conversationSessionGeneration: 0 } }).returning();
    await db.insert(tables.agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      idempotencyKey: `conversation-comment:${comment.id}`, source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      status: "completed", finishedAt: now, runId, payload: { issueId: conversation.id } });
    await db.insert(tables.issueComments).values({ companyId: f.companyId, issueId: conversation.id,
      authorAgentId: f.agentId, createdByRunId: runId, body: "The question is answered." });
    await db.update(tables.issues).set({ conversationState: "active", status: "in_progress" }).where(eq(tables.issues.id, conversation.id));
    expect(await settleConversationTurn(db, run)).toBe(true);
    expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
    expect((await readIdleIssueSchedule(db, ownerId, Date.now())).blocked).toBe(false);
    await db.update(tables.heartbeatRuns).set({ costAccountingPending: true }).where(eq(tables.heartbeatRuns.id, runId));
    expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
  }, 60_000);

  it.each(["rejected", "withdrawn", "expired"] as const)("accepts actual %s secret-proposal scrubbing and refuses retained ciphertext", async status => {
    const { createSecretProposalsService } = await import("../services/secret-proposals.js");
    const f = await seed();
    const [proposal] = await db.insert(tables.companySecretProposals).values({ companyId: f.companyId, kind: "secret",
      proposedName: "history/token", proposedKey: "TOKEN", justification: "History fixture", proposedByAgentId: f.agentId,
      originRunId: f.runId, originIssueId: f.issueId, expiresAt: now, valueCiphertext: { pending: true } }).returning();
    expect(await blocked("company_secret_proposals")).toBe(true);
    const result = await createSecretProposalsService(db).transition(f.companyId, proposal.id, status, { proposerAgentId: f.agentId });
    expect(result).toMatchObject({ status, valueCiphertext: null });
    expect(await blocked("company_secret_proposals")).toBe(false);
    await db.update(tables.companySecretProposals).set({ valueCiphertext: { unfinished: true } }).where(eq(tables.companySecretProposals.id, proposal.id));
    expect(await blocked("company_secret_proposals")).toBe(true);
  }, 60_000);

  it("retains actual decided effects, and reblocks when one effect lacks its completion receipt", async () => {
    const { decisionService } = await import("../services/decisions.js");
    const previous = process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    try {
      const f = await seed(), p = await mcp(f);
      await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
        status: "active", membershipRole: "member" });
      await db.update(tables.heartbeatRuns).set({ status: "running", responsibleUserId: p.userId }).where(eq(tables.heartbeatRuns.id, f.runId));
      await db.update(tables.issues).set({ status: "in_progress", responsibleUserId: p.userId }).where(eq(tables.issues.id, f.issueId));
      const actor = { type: "agent" as const, companyId: f.companyId, agentId: f.agentId, runId: f.runId, source: "agent_jwt" as const,
        onBehalfOfUserId: p.userId, onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] };
      const userActor = { type: "board" as const, userId: p.userId, companyIds: [f.companyId], source: "session" as const,
        memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] };
      const service = decisionService(db, { wakeOriginAgent: async () => null });
      const decision = await service.create({ companyId: f.companyId, actor, agentId: f.agentId, runId: f.runId,
        title: "Save this comment?", body: "Completion proof", continuationPolicy: "none",
        options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId: f.issueId,
          staleness: "lenient", bodyMarkdown: "Saved by the decision owner." }] }] });
      expect(await blocked("decisions")).toBe(true);
      await service.decide({ id: decision.id, optionId: "yes", decidedByUserId: p.userId, userActor });
      await db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: now }).where(eq(tables.heartbeatRuns.id, f.runId));
      expect(await blocked("decisions")).toBe(false);
      expect(await blocked("decision_effect_executions")).toBe(false);
      await db.update(tables.decisions).set({ chosenOptionId: "another-option" }).where(eq(tables.decisions.id, decision.id));
      expect(await blocked("decisions")).toBe(true);
      await db.update(tables.decisions).set({ chosenOptionId: "yes" }).where(eq(tables.decisions.id, decision.id));
      const [effect] = await db.select().from(tables.decisionEffectExecutions).where(eq(tables.decisionEffectExecutions.decisionId, decision.id));
      await db.delete(tables.decisionEffectExecutions).where(eq(tables.decisionEffectExecutions.id, effect.id));
      expect(await blocked("decisions")).toBe(true);
      await db.insert(tables.decisionEffectExecutions).values(effect);
      await db.update(tables.decisionEffectExecutions).set({ executedAt: null }).where(eq(tables.decisionEffectExecutions.decisionId, decision.id));
      expect(await blocked("decisions")).toBe(true);
      expect(await blocked("decision_effect_executions")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
      else process.env.PAPERCLIP_DECISION_SIGNING_SECRET = previous;
    }
  }, 60_000);

  it.each(["zero_effect", "dismissed", "cancelled", "expired", "partial", "failed"] as const)("proves the actual decision owner branch %s", async branch => {
    const previous = process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    try {
      const f = await decisionFixture();
      const effects = branch === "zero_effect" ? [] : [
        { type: "comment_on_issue" as const, targetIssueId: f.issueId, staleness: "lenient" as const, bodyMarkdown: "First effect" },
        ...(branch === "partial" ? [{ type: "comment_on_issue" as const, targetIssueId: f.issueId,
          staleness: "strict" as const, bodyMarkdown: "Snapshot is now stale" }] : []),
      ];
      const decision = await f.service.create({ companyId: f.companyId, actor: f.actor, agentId: f.agentId, runId: f.runId,
        title: "Decision branch", body: branch, continuationPolicy: "none", options: [{ id: "yes", label: "Yes", effects }] });
      if (branch === "dismissed") await f.service.dismiss(decision.id, f.userId, f.userActor);
      else if (branch === "cancelled") await f.service.cancel(decision.id, { actorType: "agent", actorId: f.agentId, runId: f.runId });
      else if (branch === "expired") {
        await db.update(tables.decisions).set({ expiresAt: new Date(0) }).where(eq(tables.decisions.id, decision.id));
        await f.service.sweepTtlExpiry();
      } else await f.service.decide({ id: decision.id, optionId: "yes", decidedByUserId: f.userId,
        userActor: branch === "failed" ? { type: "none", source: "none" } : f.userActor });
      await f.finish();
      const saved = await f.service.get(decision.id);
      expect(saved?.executionStatus).toBe(branch === "partial" ? "partial" : branch === "failed" ? "failed"
        : branch === "cancelled" || branch === "expired" ? null : "succeeded");
      expect(await blocked("decisions")).toBe(false);
      expect(await blocked("decision_effect_executions")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET; else process.env.PAPERCLIP_DECISION_SIGNING_SECRET = previous;
    }
  }, 60_000);

  it.each(["archive", "keep", "manifest_failure"] as const)("checks the separate reviewed retention manifest for %s", async branch => {
    const { hashAttentionArchiveManifest } = await import("../services/decision-retention.js");
    const previous = process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    try {
      const f = await decisionFixture(), activityAt = new Date("2026-04-01T00:00:00.000Z");
      await db.insert(tables.decisionRetention).values({ companyId: f.companyId, sourceKind: "review", sourceId: f.issueId,
        sourceActivityAt: activityAt, version: 1 });
      const manifest = [{ companyId: f.companyId, sourceKind: "review" as const, sourceId: f.issueId,
        expectedVersion: 1, activityAt: activityAt.toISOString(), reason: "Reviewed history" }];
      const decision = await f.service.create({ companyId: f.companyId, actor: f.actor, agentId: f.agentId, runId: f.runId,
        title: "Archive reviewed set", body: "Only the selected source", continuationPolicy: "none",
        options: [{ id: "archive", label: "Archive", style: "destructive", effects: [] }, { id: "keep", label: "Keep", effects: [] }],
        metadata: { kind: "attention_archive_proposal", manifestHash: branch === "manifest_failure" ? "invalid" : hashAttentionArchiveManifest(manifest) },
        additionalTargetSnapshots: { [`attention:review:${f.issueId}`]: { status: "attention", assigneeAgentId: null,
          assigneeUserId: null, updatedAt: activityAt.toISOString(), attentionArchive: manifest[0] } } });
      const outcome = await f.service.decide({ id: decision.id, optionId: branch === "keep" ? "keep" : "archive",
        decidedByUserId: f.userId, userActor: f.userActor });
      expect(outcome.executionStatus).toBe(branch === "manifest_failure" ? "failed" : "succeeded");
      await f.finish();
      expect(await blocked("decisions")).toBe(false);
      if (branch === "archive") {
        await db.update(tables.decisions).set({ targetSnapshots: {} }).where(eq(tables.decisions.id, decision.id));
        expect(await blocked("decisions")).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET; else process.env.PAPERCLIP_DECISION_SIGNING_SECRET = previous;
    }
  }, 60_000);

  it("settles retained Muse assignments through the real pair, runner receipt and terminal reconciliation paths", async () => {
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const { museIdentity, museCredentialHash } = await import("../services/muse-identity.js");
    const { museRunnerBroker } = await import("../services/muse-runner-broker.js");
    const { createHeartbeatLifecycle } = await import("../services/heartbeat/run-lifecycle.js");
    const f = await seed(), p = await mcp(f);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableMuse: true });
    await db.insert(tables.companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: p.userId, membershipRole: "owner", status: "active" },
      { companyId: f.companyId, principalType: "agent", principalId: f.agentId, membershipRole: "member", status: "active" },
    ]);
    const adapterConfig = { provider: "muse", allowUnmeteredProvider: true, lifecycle: "per_turn" };
    await db.update(tables.agents).set({ status: "active", adapterType: "paperclip_runner", adapterConfig }).where(eq(tables.agents.id, f.agentId));
    const ticket = randomBytes(32).toString("base64url");
    const [binding] = await db.insert(tables.museAgentBindings).values({ companyId: f.companyId, agentId: f.agentId, operatorId: p.userId,
      ticketHash: museCredentialHash(ticket), ticketExpiresAt: new Date(Date.now() + 600_000) }).returning();
    await db.update(tables.agents).set({ adapterConfig: { ...adapterConfig, museBindingId: binding.id } }).where(eq(tables.agents.id, f.agentId));
    const identity = museIdentity(db), credentials = await identity.pair(ticket, "2");
    const broker = museRunnerBroker(db, { publicOrigin: "https://paperclip.example",
      heartbeat: { wakeup: async () => null, cancelRun: async () => null } });
    await db.update(tables.museAgentBindings).set({ status: "ready", receiverContactAt: new Date(), verifiedReplyAt: new Date() })
      .where(eq(tables.museAgentBindings.id, binding.id));
    const subject = await identity.authenticate(credentials.accessToken), sessionId = randomUUID(), turnId = `turn_${randomUUID()}`;
    await db.update(tables.issues).set({ status: "in_progress", responsibleUserId: p.userId,
      checkoutRunId: f.runId, executionRunId: f.runId }).where(eq(tables.issues.id, f.issueId));
    await db.update(tables.heartbeatRuns).set({ status: "running", runtimeMode: "native", driverKind: "muse_external",
      nativeIssueId: f.issueId, nativeSessionId: sessionId, nativePhase: "turn_running", responsibleUserId: p.userId, finishedAt: null })
      .where(eq(tables.heartbeatRuns.id, f.runId));
    await db.insert(tables.nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "running", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 600_000) });
    const execution = { binding: { companyId: f.companyId, agentId: f.agentId, runId: f.runId },
      provider: { binding: await broker.snapshot(f.companyId, f.agentId, binding.id) } };
    const port = broker.port(execution);
    const ref = { ...execution.provider.binding, runId: f.runId, normalizedSessionId: sessionId, turnId, assignmentRevision: 1 };
    const detach = await port.attach(async command => {
      // Named external runner boundary: persist the real broker's receipt for
      // the exact command it emitted, without invoking paid native execution.
      await port.settle({ sourceEventId: `result_${command.requestId}`, payload: { binding: ref, requestId: command.requestId,
        outcome: { status: command.action === "accept" ? "accepted" : "completed" } } });
    });
    try {
      await port.dispatch({ sourceEventId: `offer_${randomUUID()}`, payload: { kind: "assignment", binding: ref, tools: [],
        acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 3_600_000 } });
      const [assignment] = await db.select().from(tables.museRunnerAssignments).where(eq(tables.museRunnerAssignments.runId, f.runId));
      expect(await blocked("muse_runner_assignments")).toBe(true);
      await broker.act(subject, { version: 1, command: "accept", assignmentId: assignment.id, requestId: randomUUID() });
      await broker.act(subject, { version: 1, command: "finish", assignmentId: assignment.id, requestId: randomUUID(), result: {} });
      expect(await blocked("muse_runner_assignments")).toBe(true);
      const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: () => {} } as unknown as
        import("../services/heartbeat/run-lifecycle.js").HeartbeatLifecycleDependencies);
      await lifecycle.setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
      await broker.reconcileTerminalAssignments(f.companyId, f.agentId, binding.id);
      for (const family of ["muse_runner_assignments", "muse_runner_operations", "muse_mailbox_items", "external_agent_holds"]) {
        expect(await blocked(family), family).toBe(false);
      }
      await db.update(tables.museRunnerOperations).set({ status: "unknown" }).where(eq(tables.museRunnerOperations.assignmentId, assignment.id));
      expect(await blocked("muse_runner_assignments")).toBe(true);
      expect(await blocked("muse_runner_operations")).toBe(true);
    } finally { await detach(); }
  }, 60_000);

  it("uses the actual Dot revocation writer but preserves Grok routine and recovery blockers", async () => {
    const { dotRunnerBroker } = await import("../services/dot-runner-broker.js");
    const f = await seed(), p = await mcp(f, true);
    await db.update(tables.mcpOauthGrants).set({ revokedAt: null }).where(eq(tables.mcpOauthGrants.id, p.grantId));
    const [binding] = await db.insert(tables.dotAgentBindings).values({ companyId: f.companyId, agentId: f.agentId,
      operatorId: p.userId, grantId: p.grantId, status: "ready", providerKind: "openai_dot" }).returning();
    expect(await blocked("dot_agent_bindings")).toBe(true);
    await dotRunnerBroker(db).revoke(f.companyId, f.agentId, p.userId);
    expect(await blocked("dot_agent_bindings")).toBe(false);
    expect(await blocked("mcp_oauth_grants")).toBe(false);
    const [secret] = await db.insert(tables.companySecrets).values({ companyId: f.companyId, key: "GROK_ROUTINE",
      name: "Grok routine material", provider: "local_encrypted" }).returning();
    const [grok] = await db.insert(tables.dotAgentBindings).values({ companyId: f.companyId, agentId: f.agentId,
      operatorId: p.userId, status: "revoked", providerKind: "grok_bot", revokedAt: now }).returning();
    await db.insert(tables.grokBotRoutines).values({ companyId: f.companyId, agentId: f.agentId, bindingId: grok.id,
      bindingGeneration: grok.generation, botName: "History routine", secretId: secret.id, secretVersion: 1,
      recoveryRequiredAt: new Date(), recoveryReason: "work_session" });
    expect(await blocked("dot_agent_bindings")).toBe(true);
    expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
    expect(await db.select().from(tables.grokBotRoutines)).toHaveLength(1);
    expect((await db.select().from(tables.dotAgentBindings).where(eq(tables.dotAgentBindings.id, binding.id)))[0].status).toBe("revoked");
  }, 60_000);

  it("retains a stale runtime exclusivity lease only after its exact owner and resources finish", async () => {
    const { workspaceRuntimeLeaseService } = await import("../services/workspace-runtime-leases.js");
    const f = await seed();
    const [workspace] = await db.insert(tables.executionWorkspaces).values({ companyId: f.companyId, name: "History workspace",
      mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs" }).returning();
    const lease = await workspaceRuntimeLeaseService(db).claim({ companyId: f.companyId, executionWorkspaceId: workspace.id,
      action: "start", owner: { actorType: "agent", agentId: f.agentId, issueId: f.issueId, runId: f.runId } });
    expect(lease.outcome).toBe("created");
    expect(await blocked("execution_workspace_runtime_leases")).toBe(false);
    const [runtime] = await db.insert(tables.workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId,
      executionWorkspaceId: workspace.id, issueId: f.issueId, serviceName: "Unstarted history", scopeType: "execution_workspace",
      scopeId: workspace.id, status: "stopped", lifecycle: "shared", provider: "local_process", stoppedAt: now }).returning();
    expect(await blocked("workspace_runtime_services")).toBe(false);
    await db.update(tables.workspaceRuntimeServices).set({ status: "running", stoppedAt: null }).where(eq(tables.workspaceRuntimeServices.id, runtime.id));
    expect(await blocked("workspace_runtime_services")).toBe(true);
    expect(await blocked("execution_workspace_runtime_leases")).toBe(true);
    await db.update(tables.workspaceRuntimeServices).set({ status: "stopped", stoppedAt: now, exposureHandle: "uncleaned" })
      .where(eq(tables.workspaceRuntimeServices.id, runtime.id));
    expect(await blocked("workspace_runtime_services")).toBe(true);
    await db.update(tables.executionWorkspaceRuntimeLeases).set({ ownerKey: `issue:${randomUUID()}` })
      .where(eq(tables.executionWorkspaceRuntimeLeases.id, lease.lease!.id));
    expect(await blocked("execution_workspace_runtime_leases")).toBe(true);
  });

  it("inspects an actual owned runtime process across stopped-row fallback, adoption, termination and reconstruction failure", async () => {
    const runtime = await import("../services/workspace-runtime.js");
    const supervisor = await import("../services/local-service-supervisor.js");
    let ownedProcess: Awaited<ReturnType<typeof supervisor.findLocalServiceRegistryRecordByRuntimeServiceId>> = null;
    const directory = await mkdtemp(path.join(tmpdir(), "history-owned-runtime-"));
    const previousHome = process.env.PAPERCLIP_HOME, previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = directory;
    process.env.PAPERCLIP_INSTANCE_ID = "history-owned-runtime";
    const f = await seed();
    const [workspace] = await db.insert(tables.executionWorkspaces).values({ companyId: f.companyId, name: "Owned local runtime",
      mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd: directory }).returning();
    try {
      await runtime.resetRuntimeServicesForTests({ terminateProcesses: true });
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown");
      await runtime.reconcilePersistedRuntimeServicesOnStartup(db);
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("none");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const command = "node -e \"require('node:http').createServer((req,res)=>res.end('history')).listen(Number(process.env.PORT),'127.0.0.1')\"";
      const refs = await runtime.startRuntimeServicesForWorkspaceControl({ db,
        actor: { id: null, name: "History operator", companyId: f.companyId }, issue: null,
        executionWorkspaceId: workspace.id, adapterEnv: {},
        workspace: { baseCwd: directory, source: "project_primary", projectId: null, workspaceId: null,
          repoUrl: null, repoRef: null, strategy: "project_primary", cwd: directory, branchName: null,
          worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
        config: { desiredState: "running", workspaceRuntime: { services: [{ name: "history-http", command, port,
          expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
          lifecycle: "shared", reuseScope: "execution_workspace", stopPolicy: { type: "manual" } }] } } });
      expect(refs).toHaveLength(1);
      ownedProcess = await supervisor.findLocalServiceRegistryRecordByRuntimeServiceId({ runtimeServiceId: refs[0].id, profileKind: "workspace-runtime" });
      expect(ownedProcess?.pid).toBeGreaterThan(0);
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("present");
      await db.update(tables.workspaceRuntimeServices).set({ status: "stopped", stoppedAt: new Date(), url: null })
        .where(eq(tables.workspaceRuntimeServices.id, refs[0].id));
      expect(await blocked("workspace_runtime_services")).toBe(false);
      expect(await readIdleSleepSafety(db, hold, Date.now, ownerId, async () => runtime.readWorkspaceRuntimeIdleWork()))
        .toEqual({ version: 1, backgroundWork: "present" });
      await runtime.resetRuntimeServicesForTests({ simulateSupervisorExit: true });
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown");
      const adopted = await runtime.reconcilePersistedRuntimeServicesOnStartup(db);
      expect(adopted.adopted).toBe(1);
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("present");
      await runtime.stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: workspace.id, workspaceCwd: directory });
      ownedProcess = null;
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("none");
      expect(await blocked("workspace_runtime_services")).toBe(false);
      const unavailable = Object.create(db) as typeof db;
      unavailable.select = () => { throw new Error("controlled startup database failure"); };
      await expect(runtime.reconcilePersistedRuntimeServicesOnStartup(unavailable)).rejects.toThrow("controlled startup");
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown");
      await runtime.reconcilePersistedRuntimeServicesOnStartup(db);
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("none");
      await runtime.resetRuntimeServicesForTests();
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown");
    } finally {
      await runtime.resetRuntimeServicesForTests({ terminateProcesses: true });
      if (ownedProcess) await supervisor.terminateLocalService({ pid: ownedProcess.pid,
        processGroupId: ownedProcess.processGroupId ?? ownedProcess.pid, port: ownedProcess.port });
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
