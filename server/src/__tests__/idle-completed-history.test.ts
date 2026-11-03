import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as tables from "@paperclipai/db";
import { isRuntimeExposureAppPort } from "@paperclipai/shared";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { completedHistoryChecks, readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { readIdleIssueSchedule } from "../services/idle-issue-schedule.js";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import { inspectIdleSpool } from "../services/idle-local-work.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

// getUploadUrl returns the attachment once an upload completes. These tests need a new link.
function uploadLink<T extends object>(result: T) {
  if (!("url" in result)) throw new Error("Expected a new upload link");
  return result as Extract<T, { url: unknown }>;
}
// Public MCP capabilities never delete, so ApiDispatch omits DELETE. These tests delete through the route directly.
const DELETE_METHOD = "DELETE" as never;

(support.supported ? describe : describe.skip)("retained completed history", () => {
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
    const started = performance.now();
    const [row] = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (${sql.raw(check.query)}) AS blocked`);
    const elapsed = performance.now() - started;
    if (elapsed > 1000) console.info(`History predicate ${reason}: ${Math.round(elapsed)}ms`);
    return row.blocked;
  };
  const blockedActionKind = async (kind: string) => {
    const query = completedHistoryChecks.find(check => check.reason === "chat_actions")!.query;
    const [row] = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (${sql.raw(query)} AND a.kind = ${kind}) AS blocked`);
    return row.blocked;
  };
  beforeAll(async () => {
    if (!externalDatabaseUrl) database = await startEmbeddedPostgresTestDatabase("idle-history-");
    db = tables.createDb(externalDatabaseUrl ?? database!.connectionString, { maxConnections: 4 });
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
    const router = Router(), storage = createStorageService(createLocalDiskStorageProvider(directory));
    router.use(issueRoutes(db, storage));
    const oauth = createPublicMcpOAuth(db, { origin, resource }), api = createMcpApiDispatch(router);
    return { ...p, token, oauth, api, storage, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  async function slackFixture() {
    const f = await seed(), c = await connection(f), p = await mcp(f);
    await db.update(tables.toolConnections).set({ enabled: true, status: "active" }).where(eq(tables.toolConnections.id, c.connectionId));
    await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
      status: "active", membershipRole: "owner" });
    const [endpoint] = await db.insert(tables.chatEndpoints).values({ companyId: f.companyId, connectionId: c.connectionId,
      assignedAgentId: f.agentId, publicId: randomUUID(), provider: "slack", status: "active", providerAccountId: "TWORKSPACE",
      botExternalId: "UBOT", allowDirectMessages: true, publicationMode: "automatic" }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id,
      issueId: f.issueId, externalConversationId: "DCHANNEL", externalThreadId: "slack:DCHANNEL:123.456", externalLabel: "Personal",
      state: "active", isDirectMessage: true }).returning();
    const [principal] = await db.insert(tables.chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack",
      providerAccountId: "TWORKSPACE", externalId: "UREQUESTER", kind: "user", isBot: false }).returning();
    const authority = { endpoint, issueId: f.issueId, conversation, userId: p.userId, slackUserId: "UREQUESTER", principalId: principal.id,
      deliveryId: null, identityContextId: null, revision: "fixture-revision", workMode: "standard", botToken: "fixture-bot-token" };
    return { ...f, ...p, ...c, endpoint, conversation, principal, authority };
  }

  it("checks all 32 families on the real migrated schema and keeps an empty instance eligible", async () => {
    expect(new Set(completedHistoryChecks.map(c => c.reason)).size).toBe(32);
    for (const check of completedHistoryChecks) expect(await blocked(check.reason), check.reason).toBe(false);
    expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
  });

  it.each([false, true])("keeps real sandbox creation uncertainty blocked through owned cleanup, manualRemaining=%s", async manualRemaining => {
    const { createOwnedSandbox, recoverSandboxCreations, recordSandboxCreationResource } = await import("../services/sandbox-creation-operations.js");
    const { environmentRuntimeService } = await import("../services/environment-runtime.js");
    const { heartbeatService } = await import("../services/heartbeat.js");
    const { nextEnvironmentCleanupAt } = await import("../services/environment-cleanup-state.js");
    const f = await seed(), environmentId = randomUUID();
    const directory = await mkdtemp(path.join(tmpdir(), "history-sandbox-creation-"));
    await db.insert(tables.environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    const snapshot = () => readIdleSleepSafety(db, hold, Date.now, ownerId, async () => "none",
      undefined, undefined, false, false, { collectDiagnostics: true });
    const reason = async (key: string) => (await snapshot()).diagnostics!.checks.find(check => check.reason === key)!.state;
    const uncertain = async (contextual: boolean) => {
      const providerLeaseId = randomUUID();
      const result = await createOwnedSandbox(db, { companyId: f.companyId, environmentId, heartbeatRunId: f.runId,
        provider: "history-fixture", driverKey: "history-fixture", config: {}, requestKey: providerLeaseId,
        metadata: { driver: "sandbox", ...(contextual ? { runnerTaskLease: true, runnerTaskCreationContextId: randomUUID() } : {}) } },
      async () => {
        await writeFile(path.join(directory, providerLeaseId), "owned provider resource");
        return { providerLeaseId };
      });
      const id = String(result.metadata!.creationOperationId);
      // Advance the actual creation owner's saved deadline, not its status.
      await db.update(tables.sandboxCreationOperations).set({ nextAttemptAt: new Date(0) })
        .where(eq(tables.sandboxCreationOperations.id, id));
      await recoverSandboxCreations(db, async () => null);
      return { id, providerLeaseId };
    };
    try {
      expect(await read()).toEqual({ version: 1, backgroundWork: "none" });
      const contextual = await uncertain(true);
      const current = async (id: string) => (await db.select().from(tables.sandboxCreationOperations)
        .where(eq(tables.sandboxCreationOperations.id, id)))[0];
      expect(await current(contextual.id)).toMatchObject({ state: "needs_reconciliation", leaseId: null });
      // Isolated RED for the old pending-only catalog: there is no live run,
      // finalization, lease, local worker, or other durable blocker to mask it.
      expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
      expect(await reason("sandbox_creation_operations")).toBe("present");
      await recordSandboxCreationResource(db, { id: contextual.id, companyId: f.companyId, environmentId,
        providerLeaseId: contextual.providerLeaseId });
      expect(await nextEnvironmentCleanupAt(db)).not.toBeNull();
      expect(await reason("sandbox_creation_operations")).toBe("present");
      await recoverSandboxCreations(db, async () => { throw new Error("Known late resource must use its exact owner"); });
      const pending = await current(contextual.id);
      expect(pending).toMatchObject({ state: "cleanup_pending", leaseId: expect.any(String) });
      expect(await reason("sandbox_creation_operations")).toBe("none");
      expect(await reason("environment_leases")).toBe("present");
      expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
      const manual = manualRemaining ? await uncertain(false) : undefined;
      if (manual) {
        expect(await current(manual.id)).toMatchObject({ state: "needs_reconciliation", leaseId: null });
        expect(await reason("sandbox_creation_operations")).toBe("present");
      }
      let destroyed = 0;
      const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
        acquireRunLease: async () => { throw new Error("Unexpected provider acquire"); },
        releaseRunLease: async () => { throw new Error("Unexpected provider release"); },
        resolveCapabilities: async () => { throw new Error("Unexpected capability resolution"); },
        retryPendingSandboxTeardown: async ({ lease }: { lease: { providerLeaseId: string | null } }) => {
          expect(lease.providerLeaseId).toBe(contextual.providerLeaseId);
          const resource = path.join(directory, lease.providerLeaseId!);
          expect(await readFile(resource, "utf8")).toBe("owned provider resource");
          await rm(resource);
          await expect(readFile(resource)).rejects.toMatchObject({ code: "ENOENT" });
          destroyed++;
          return { providerLeaseId: lease.providerLeaseId, state: "destroyed" as const };
        } }] });
      await heartbeatService(db, { environmentRuntime: runtime }).sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(destroyed).toBe(1);
      expect(await current(contextual.id)).toMatchObject({ state: "resolved", leaseId: pending.leaseId });
      expect(await reason("environment_leases")).toBe("none");
      expect(await reason("sandbox_creation_operations")).toBe(manual ? "present" : "none");
      expect(await read()).toEqual({ version: 1, backgroundWork: manual ? "present" : "none" });
      if (manual) {
        expect(await current(manual.id)).toMatchObject({ state: "needs_reconciliation", leaseId: null });
        expect(await readFile(path.join(directory, manual.providerLeaseId), "utf8")).toBe("owned provider resource");
      }
      // A different creation is still real pending work after this one settles.
      await createOwnedSandbox(db, { companyId: f.companyId, environmentId, provider: "history-fixture",
        driverKey: "history-fixture", config: {}, metadata: {} }, async () => {
          const providerLeaseId = randomUUID();
          await writeFile(path.join(directory, providerLeaseId), "another pending provider resource");
          return { providerLeaseId };
        });
      expect(await read()).toEqual({ version: 1, backgroundWork: "present" });
    } finally {
      await db.delete(tables.sandboxCreationOperations).where(eq(tables.sandboxCreationOperations.companyId, f.companyId));
      await db.delete(tables.environments).where(eq(tables.environments.id, environmentId));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["completed", "cancelled"] as const)("retains a %s transfer without hiding its actual spool", async status => {
    const f = await seed();
    const result = await companyTransferRunService.resumeOrCreate(db, { companyId: f.companyId, direction: "import",
      actorKey: "board:history", idempotencyKey: randomUUID(), containerRef: { kind: "upload" } });
    expect(await blocked("company_transfer_runs")).toBe(true);
    if (status === "completed") {
      await companyTransferRunService.recordManifest(db, result.run.id, { chunks: [{ name: "tasks.jsonl" }], blobs: [] }, "a".repeat(64));
      await companyTransferRunService.start(db, result.run.id);
      expect(await companyTransferRunService.completePart(db, result.run.id, "tasks.jsonl")).toBe(true);
      expect(await companyTransferRunService.claimApply(db, result.run.id)).toBe(true);
      await companyTransferRunService.complete(db, result.run.id);
    }
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

  it("uses the attachment owner to commit bytes and clean an abandoned upload", async () => {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f);
    try {
      const transfers = createPublicMcpTransfers(db, p.oauth, p.api, p.storage);
      const principal = await p.oauth.authenticate(p.token), bytes = Buffer.from("verified retained attachment");
      const args = { companyId: f.companyId, taskId: f.issueId, requestId: randomUUID(), filename: "result.txt", contentType: "text/plain",
        byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const upload = uploadLink(await transfers.getUploadUrl(principal, args));
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      const app = express(); app.use(transfers.router);
      const url = new URL(String(upload.url));
      const result = await request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes).timeout({ response: 5000, deadline: 10_000 });
      expect(result.status).toBe(200);
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
      await db.update(tables.mcpAttachmentUploads).set({ cleanedAt: now, cleanupVerifiedAt: now }).where(eq(tables.mcpAttachmentUploads.id, String(upload.uploadId)));
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      await db.update(tables.mcpAttachmentUploads).set({ cleanedAt: null, cleanupVerifiedAt: null }).where(eq(tables.mcpAttachmentUploads.id, String(upload.uploadId)));
      const abandonedArgs = { ...args, requestId: randomUUID() };
      const abandoned = uploadLink(await transfers.getUploadUrl(principal, abandonedArgs));
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      const [old] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(abandoned.uploadId)));
      await p.storage.putFile({ companyId: f.companyId, namespace: "mcp-transfers", objectKey: old.objectKey,
        originalFilename: args.filename, contentType: args.contentType, body: bytes });
      // Model the old owner's optimistic cleanup: its stamp exists while bytes
      // survive. It must stay blocked until actual deletion and readback.
      await db.update(tables.mcpAttachmentUploads).set({ expiresAt: new Date(0), cleanedAt: new Date() }).where(eq(tables.mcpAttachmentUploads.id, old.id));
      expect(await p.storage.headObject(f.companyId, old.objectKey)).toMatchObject({ exists: true });
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      await transfers.getDownloadUrl(principal, result.body.attachment.id);
      expect(await p.storage.headObject(f.companyId, old.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
      const verified = (await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, old.id)))[0];
      const staleUrl = new URL(String(abandoned.url));
      expect((await request(app).put(staleUrl.pathname + staleUrl.search).set("Content-Type", "text/plain").send(bytes)
        .timeout({ response: 5000, deadline: 10_000 })).status).toBe(403);
      expect(await p.storage.headObject(f.companyId, old.objectKey)).toEqual({ exists: false });
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, old.id)))[0]).toEqual(verified);
      const reissued = uploadLink(await transfers.getUploadUrl(principal, abandonedArgs));
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, old.id)))[0])
        .toMatchObject({ cleanedAt: null, cleanupVerifiedAt: null });
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      const secondUrl = new URL(String(reissued.url));
      const second = await request(app).put(secondUrl.pathname + secondUrl.search).set("Content-Type", "text/plain").send(bytes)
        .timeout({ response: 5000, deadline: 10_000 });
      expect(second.status).toBe(200);
      for (const attachment of [result.body.attachment, second.body.attachment]) {
        expect(await p.api(principal, DELETE_METHOD, `/attachments/${attachment.id}`)).toEqual({ ok: true });
      }
      const [removed] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(upload.uploadId)));
      expect(removed).toMatchObject({ attachmentId: result.body.attachment.id, cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
      expect(await p.storage.headObject(f.companyId, removed.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
      await expect(transfers.getUploadUrl(principal, args)).rejects.toThrow();
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, removed.id)))[0]).toEqual(removed);
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
      await db.update(tables.mcpAttachmentUploads).set({ cleanupVerifiedAt: null }).where(eq(tables.mcpAttachmentUploads.id, removed.id));
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
    } finally { await p.cleanup(); }
  }, 60_000);

  it("renews only an expired live agent attachment's publication repair window", async () => {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { createPublicMcpOAuth } = await import("../services/public-mcp/oauth.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f);
    try {
      const board = await p.oauth.authenticate(p.token), sessionId = randomUUID();
      const resource = `${p.oauth.config.origin}/mcp/runner`;
      await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: true });
      await db.update(tables.mcpOauthGrants).set({ purpose: "agent", agentId: f.agentId,
        resource, scopes: ["paperclip:agent", "offline_access"] }).where(eq(tables.mcpOauthGrants.id, p.grantId));
      await db.update(tables.issues).set({ status: "in_progress" }).where(eq(tables.issues.id, f.issueId));
      await db.update(tables.heartbeatRuns).set({ status: "running", finishedAt: null, runtimeMode: "native",
        driverKind: "grok_bot_mcp", nativeIssueId: f.issueId }).where(eq(tables.heartbeatRuns.id, f.runId));
      const oauth = createPublicMcpOAuth(db, { ...p.oauth.config, resource });
      const principal = await oauth.authenticate(p.token);
      let ownerAvailable = true;
      let ownerRunId = f.runId;
      let pauseRepair = false, repairLocked!: () => void, releaseRepair!: () => void;
      const locked = new Promise<void>(resolve => { repairLocked = resolve; });
      const released = new Promise<void>(resolve => { releaseRepair = resolve; });
      // Named work-session boundary; OAuth, transfer HTTP, storage, attachment
      // registration and native publication receipt all use their real owners.
      const transfers = createPublicMcpTransfers(db, oauth, p.api, p.storage, { agentSession: {
        authorize: async (actor, session, taskId, _write, queryDb) => {
          if (!ownerAvailable || actor.grant.id !== p.grantId || actor.grant.agentId !== f.agentId
            || session !== sessionId || taskId !== f.issueId) throw new Error("work session unavailable");
          if (pauseRepair && queryDb) { pauseRepair = false; repairLocked(); await released; }
          return { agentId: f.agentId, runId: ownerRunId };
        },
      } });
      const app = express(); app.use(transfers.router);
      const bytes = Buffer.from("expired live publication repair");
      const args = { companyId: f.companyId, taskId: f.issueId, requestId: randomUUID(), filename: "repair.txt",
        contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const upload = uploadLink(await transfers.getUploadUrl(principal, args, sessionId));
      const put = async (value: unknown) => {
        const url = new URL(String(value));
        return request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes)
          .timeout({ response: 5000, deadline: 10_000 });
      };
      const initial = await put(upload.url);
      expect(initial.status).toBe(200);
      const uploadId = String(upload.uploadId), attachmentId = initial.body.attachment.id;
      const current = async () => (await db.select().from(tables.mcpAttachmentUploads)
        .where(eq(tables.mcpAttachmentUploads.id, uploadId)))[0];
      const loseReceipt = async () => {
        const [run] = await db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, f.runId));
        const receipts = { ...run.resultJson?.semanticToolReceipts as Record<string, unknown> };
        delete receipts[`external-upload:${uploadId}`];
        await db.update(tables.heartbeatRuns).set({ resultJson: { ...run.resultJson, semanticToolReceipts: receipts } })
          .where(eq(tables.heartbeatRuns.id, f.runId));
        await db.update(tables.mcpAttachmentUploads).set({ expiresAt: new Date(0) })
          .where(eq(tables.mcpAttachmentUploads.id, uploadId));
      };
      await loseReceipt();
      const expired = await current();
      expect((await put(upload.url)).status).toBe(403);
      const repair = uploadLink(await transfers.getUploadUrl(principal, args, sessionId));
      const renewed = await current();
      expect(renewed).toEqual({ ...expired, expiresAt: expect.any(Date) });
      expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const repaired = await put(repair.url);
      expect(repaired.status).toBe(200);
      expect(repaired.body).toMatchObject({ attachment: { id: attachmentId }, publication: {
        source: "authenticated_upload", evidenceRef: `deliverable:${attachmentId}` } });
      expect(await transfers.getUploadUrl(principal, args, sessionId)).toMatchObject({ status: "completed",
        attachment: { id: attachmentId }, publication: repaired.body.publication });
      expect(await current()).toEqual(renewed);
      expect(await db.select().from(tables.issueAttachments).where(eq(tables.issueAttachments.issueId, f.issueId))).toHaveLength(1);
      await loseReceipt();
      const beforeDenied = await current();
      ownerAvailable = false;
      await expect(transfers.getUploadUrl(principal, args, sessionId)).rejects.toThrow("work session unavailable");
      expect(await current()).toEqual(beforeDenied);
      ownerAvailable = true;
      ownerRunId = randomUUID();
      await expect(transfers.getUploadUrl(principal, args, sessionId)).rejects.toThrow();
      expect(await current()).toEqual(beforeDenied);
      ownerRunId = f.runId;
      await db.update(tables.mcpAttachmentUploads).set({ cleanedAt: new Date(), cleanupVerifiedAt: new Date() })
        .where(eq(tables.mcpAttachmentUploads.id, uploadId));
      const contradictory = await current();
      await expect(transfers.getUploadUrl(principal, args, sessionId)).rejects.toThrow();
      expect(await current()).toEqual(contradictory);
      expect((await put(repair.url)).status).toBe(403);
      await db.update(tables.mcpAttachmentUploads).set({ cleanedAt: null, cleanupVerifiedAt: null })
        .where(eq(tables.mcpAttachmentUploads.id, uploadId));
      // Deletion owns metadata/cleanup settlement. Overlap it with the locked
      // repair to prove renewal cannot revive a pointer or recreate its bytes.
      pauseRepair = true;
      const repairing = transfers.getUploadUrl(principal, args, sessionId).then(uploadLink);
      await locked;
      const deleting = p.api(board, DELETE_METHOD, `/attachments/${attachmentId}`);
      let overlappingRepair: Awaited<typeof repairing>;
      try {
        await vi.waitFor(async () => expect(await p.storage.headObject(f.companyId, renewed.objectKey)).toEqual({ exists: false }),
          { timeout: 5000, interval: 20 });
      } finally {
        releaseRepair();
        [overlappingRepair] = await Promise.all([repairing, deleting]);
      }
      const deleted = await current();
      expect(deleted).toMatchObject({ attachmentId, cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
      await expect(transfers.getUploadUrl(principal, args, sessionId)).rejects.toThrow();
      expect(await current()).toEqual(deleted);
      expect((await put(repair.url)).status).toBe(403);
      expect((await put(overlappingRepair.url)).status).toBe(403);
      expect(await p.storage.headObject(f.companyId, deleted.objectKey)).toEqual({ exists: false });
    } finally { await p.cleanup(); }
  }, 60_000);

  it.each(["delete_failed", "object_survived", "head_failed"] as const)("isolates orphan cleanup failure from another company's actual file transfers: %s", async failure => {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f), other = await seed(), q = await connectedMcp(other);
    const originalDelete = p.storage.deleteObject, originalHead = p.storage.headObject, originalGet = p.storage.getObject;
    try {
      const principal = await p.oauth.authenticate(p.token), unrelated = await q.oauth.authenticate(q.token);
      const transfers = createPublicMcpTransfers(db, p.oauth, p.api, p.storage);
      const app = express(); app.use(transfers.router);
      const bytes = Buffer.from("authorized bytes survive unrelated cleanup failure");
      const args = (owner: typeof f) => ({ companyId: owner.companyId, taskId: owner.issueId, requestId: randomUUID(),
        filename: "result.txt", contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      const put = async (link: { url?: unknown }) => {
        const url = new URL(String(link.url));
        return request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes)
          .timeout({ response: 5000, deadline: 10_000 });
      };
      const badLink = uploadLink(await transfers.getUploadUrl(principal, args(f)));
      const badResult = await put(badLink); expect(badResult.status).toBe(200);
      const goodLink = uploadLink(await transfers.getUploadUrl(unrelated, args(other)));
      const goodResult = await put(goodLink); expect(goodResult.status).toBe(200);
      const [bad] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(badLink.uploadId)));
      const abandonedLink = uploadLink(await transfers.getUploadUrl(unrelated, args(other)));
      const [abandoned] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(abandonedLink.uploadId)));
      await p.storage.putFile({ companyId: other.companyId, namespace: "mcp-transfers", objectKey: abandoned.objectKey,
        originalFilename: "result.txt", contentType: "text/plain", body: bytes });
      p.storage.deleteObject = async (companyId, objectKey) => {
        if (companyId === f.companyId && objectKey === bad.objectKey) {
          if (failure === "delete_failed") throw new Error("controlled old object DELETE failure");
          if (failure === "object_survived") return;
        }
        return originalDelete(companyId, objectKey);
      };
      p.storage.headObject = async (companyId, objectKey) => {
        if (companyId === f.companyId && objectKey === bad.objectKey && failure === "head_failed") {
          throw new Error("controlled old object HEAD failure");
        }
        return originalHead(companyId, objectKey);
      };
      expect(await p.api(principal, DELETE_METHOD, `/attachments/${badResult.body.attachment.id}`)).toEqual({ ok: true });
      await db.update(tables.mcpAttachmentUploads).set({ expiresAt: new Date(0) })
        .where(sql`${tables.mcpAttachmentUploads.id} IN (${bad.id}, ${abandoned.id})`);
      const [uncertain] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, bad.id));
      expect(uncertain).toMatchObject({ attachmentId: badResult.body.attachment.id, cleanedAt: null, cleanupVerifiedAt: null });
      // The old owner fails in this sweep, but the unrelated link and another
      // object's verified cleanup must commit independently of that failure.
      const download = await transfers.getDownloadUrl(unrelated, goodResult.body.attachment.id);
      const downloadUrl = new URL(download.url);
      const response = await request(app).get(downloadUrl.pathname + downloadUrl.search).timeout({ response: 5000, deadline: 10_000 });
      expect(response.status).toBe(200); expect(response.body).toEqual(bytes);
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, bad.id)))[0]).toEqual(uncertain);
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, abandoned.id)))[0])
        .toMatchObject({ cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
      expect(await originalHead(other.companyId, abandoned.objectKey)).toEqual({ exists: false });
      const next = uploadLink(await transfers.getUploadUrl(unrelated, args(other)));
      expect((await put(next)).status).toBe(200);
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      await expect(transfers.getDownloadUrl(principal, goodResult.body.attachment.id)).rejects.toThrow();
      await expect(transfers.getUploadUrl(principal, args(other))).rejects.toThrow();
      p.storage.deleteObject = originalDelete; p.storage.headObject = originalHead;
      await transfers.getDownloadUrl(unrelated, goodResult.body.attachment.id);
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, bad.id)))[0])
        .toMatchObject({ attachmentId: uncertain.attachmentId, cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
      expect(await originalHead(f.companyId, bad.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
      // Only opportunistic cleanup errors are isolated. The caller's own
      // transfer storage failure still reaches the existing route error path.
      p.storage.getObject = async () => { throw new Error("controlled requested object GET failure"); };
      expect((await request(app).get(downloadUrl.pathname + downloadUrl.search)
        .timeout({ response: 5000, deadline: 10_000 })).status).toBe(503);
    } finally {
      p.storage.deleteObject = originalDelete; p.storage.headObject = originalHead; p.storage.getObject = originalGet;
      await p.cleanup(); await q.cleanup();
    }
  }, 60_000);

  async function abandonedMcpBacklog() {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f), other = await seed(), q = await connectedMcp(other);
    try {
      const principal = await p.oauth.authenticate(p.token), unrelated = await q.oauth.authenticate(q.token);
      const hooks: { afterRead?: () => void } = {};
      const api: typeof p.api = async (...args) => { const result = await p.api(...args); hooks.afterRead?.(); return result; };
      const transfers = createPublicMcpTransfers(db, p.oauth, api, p.storage);
      const app = express(); app.use(transfers.router);
      const bytes = Buffer.from("real abandoned upload bytes");
      const args = (owner: typeof f) => ({ companyId: owner.companyId, taskId: owner.issueId, requestId: randomUUID(),
        filename: "retained.txt", contentType: "text/plain", byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
      const anchorArgs = args(other), link = await transfers.getUploadUrl(unrelated, anchorArgs);
      if (!("url" in link)) throw new Error("Expected a new anchor upload link");
      const url = new URL(String(link.url));
      const uploaded = await request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes)
        .timeout({ response: 5000, deadline: 10_000 });
      expect(uploaded.status).toBe(200);
      for (let index = 0; index < 22; index++) {
        const allocated = await transfers.getUploadUrl(principal, args(f));
        if (!("uploadId" in allocated)) throw new Error("Expected a new abandoned upload identity");
        const [upload] = await db.select().from(tables.mcpAttachmentUploads)
          .where(eq(tables.mcpAttachmentUploads.id, String(allocated.uploadId)));
        await p.storage.putFile({ companyId: f.companyId, namespace: "mcp-transfers", objectKey: upload.objectKey,
          originalFilename: upload.originalFilename, contentType: upload.contentType, body: bytes });
      }
      await db.update(tables.mcpAttachmentUploads).set({ expiresAt: new Date(0) })
        .where(eq(tables.mcpAttachmentUploads.companyId, f.companyId));
      const read = () => db.select().from(tables.mcpAttachmentUploads)
        .where(eq(tables.mcpAttachmentUploads.companyId, f.companyId)).orderBy(tables.mcpAttachmentUploads.id);
      const uploads = await read(); expect(uploads).toHaveLength(22);
      const trigger = (kind: "upload" | "download", owner = transfers) => kind === "upload"
        ? owner.getUploadUrl(unrelated, anchorArgs)
        : owner.getDownloadUrl(unrelated, uploaded.body.attachment.id);
      return { f, p, q, unrelated, api, hooks, transfers, createPublicMcpTransfers, trigger, uploads, read,
        cleanup: async () => { await p.cleanup(); await q.cleanup(); } };
    } catch (error) { await p.cleanup(); await q.cleanup(); throw error; }
  }

  it.each(["delete_failed", "object_survived", "head_failed"] as const)("advances bounded MCP cleanup through failed rows and retries after wrap: %s", async failure => {
    const b = await abandonedMcpBacklog();
    const originalDelete = b.p.storage.deleteObject, originalHead = b.p.storage.headObject;
    const good = b.uploads.at(-1)!, failed = b.uploads.slice(0, -1);
    const failedKeys = new Set(failed.map(upload => upload.objectKey));
    const idsByKey = new Map(b.uploads.map(upload => [upload.objectKey, upload.id]));
    const attempted: string[] = [];
    try {
      b.p.storage.deleteObject = async (companyId, objectKey) => {
        attempted.push(idsByKey.get(objectKey)!);
        if (failedKeys.has(objectKey)) {
          if (failure === "delete_failed") throw new Error("controlled backlog DELETE failure");
          if (failure === "object_survived") return;
        }
        return originalDelete(companyId, objectKey);
      };
      b.p.storage.headObject = async (companyId, objectKey) => {
        if (failedKeys.has(objectKey) && failure === "head_failed") throw new Error("controlled backlog HEAD failure");
        return originalHead(companyId, objectKey);
      };
      for (const kind of ["upload", "download"] as const) {
        const before = attempted.length;
        await b.trigger(kind);
        expect(attempted.length - before).toBeLessThanOrEqual(20);
      }
      expect(new Set(attempted)).toEqual(new Set(b.uploads.map(upload => upload.id)));
      const after = await b.read();
      expect(after.find(upload => upload.id === good.id)).toMatchObject({ cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
      expect(after.filter(upload => upload.id !== good.id)).toEqual(failed);
      expect(await originalHead(b.f.companyId, good.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      // Restore the same storage owner. Future real calls must wrap and retry
      // every failed identity; cursor movement alone cannot complete a row.
      b.p.storage.deleteObject = async (companyId, objectKey) => { attempted.push(idsByKey.get(objectKey)!); return originalDelete(companyId, objectKey); };
      b.p.storage.headObject = originalHead;
      for (const kind of ["download", "upload"] as const) {
        const before = attempted.length;
        await b.trigger(kind);
        expect(attempted.length - before).toBeLessThanOrEqual(20);
      }
      for (const upload of await b.read()) {
        expect(upload).toMatchObject({ cleanedAt: expect.any(Date), cleanupVerifiedAt: expect.any(Date) });
        expect(await originalHead(b.f.companyId, upload.objectKey)).toEqual({ exists: false });
      }
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
    } finally { b.p.storage.deleteObject = originalDelete; b.p.storage.headObject = originalHead; await b.cleanup(); }
  }, 60_000);

  it("coalesces concurrent MCP cleanup and revisits a locked row after wrap", async () => {
    const b = await abandonedMcpBacklog(), lockedUpload = b.uploads[0]!;
    const originalDelete = b.p.storage.deleteObject, originalHead = b.p.storage.headObject;
    let releaseLock!: () => void, enteredLock!: () => void, releaseStorage!: () => void, enteredStorage!: () => void;
    const locked = new Promise<void>(resolve => { enteredLock = resolve; });
    const unlock = new Promise<void>(resolve => { releaseLock = resolve; });
    const storageEntered = new Promise<void>(resolve => { enteredStorage = resolve; });
    const continueStorage = new Promise<void>(resolve => { releaseStorage = resolve; });
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    const lock = db.transaction(async tx => {
      await tx.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, lockedUpload.id)).for("update");
      enteredLock(); await unlock;
    });
    const attempted: string[] = [];
    try {
      await locked;
      b.p.storage.deleteObject = async (companyId, objectKey) => {
        attempted.push(objectKey);
        if (attempted.length === 1) { enteredStorage(); await continueStorage; }
        return originalDelete(companyId, objectKey);
      };
      first = b.trigger("download"); await storageEntered;
      let secondAuthorized!: () => void;
      const authorized = new Promise<void>(resolve => { secondAuthorized = resolve; });
      b.hooks.afterRead = secondAuthorized;
      second = b.trigger("upload"); await authorized;
      // Authority has returned. Drain its promise continuations before
      // releasing the real storage operation; this is not a wall-clock wait.
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseStorage(); await Promise.all([first, second]);
      expect(attempted).toHaveLength(20);
      const pending = (await b.read()).filter(upload => !upload.cleanupVerifiedAt);
      expect(pending).toHaveLength(2);
      expect(pending).toContainEqual(lockedUpload);
      expect(await originalHead(b.f.companyId, lockedUpload.objectKey)).toMatchObject({ exists: true });
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      releaseLock(); await lock;
      await b.trigger("download"); await b.trigger("upload");
      expect((await b.read()).every(upload => upload.cleanupVerifiedAt !== null)).toBe(true);
      expect(await originalHead(b.f.companyId, lockedUpload.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
    } finally {
      releaseStorage(); releaseLock(); await Promise.allSettled([lock, first, second]);
      b.p.storage.deleteObject = originalDelete; await b.cleanup();
    }
  }, 60_000);

  it("retries the same MCP cleanup batch after its real transaction rolls back", async () => {
    const b = await abandonedMcpBacklog();
    const originalDelete = b.p.storage.deleteObject;
    let rejectCommit = true;
    const transaction: typeof db.transaction = (callback, config) => db.transaction(async tx => {
      const result = await callback(tx);
      if (rejectCommit) { rejectCommit = false; throw new Error("controlled cleanup transaction rollback"); }
      return result;
    }, config);
    const faultDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return transaction;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const transfers = b.createPublicMcpTransfers(faultDb, b.p.oauth, b.api, b.p.storage);
    const attempted: string[] = [];
    try {
      b.p.storage.deleteObject = async (companyId, objectKey) => { attempted.push(objectKey); return originalDelete(companyId, objectKey); };
      await expect(b.trigger("download", transfers)).rejects.toThrow("controlled cleanup transaction rollback");
      expect(attempted).toHaveLength(20);
      expect(await b.read()).toEqual(b.uploads);
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      const abortedBatch = attempted.slice();
      await b.trigger("upload", transfers);
      expect(attempted.slice(abortedBatch.length)).toEqual(abortedBatch);
      expect((await b.read()).filter(upload => upload.cleanupVerifiedAt !== null)).toHaveLength(20);
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      await b.trigger("download", transfers);
      expect((await b.read()).every(upload => upload.cleanupVerifiedAt !== null)).toBe(true);
      expect(await blocked("mcp_attachment_uploads")).toBe(false);
    } finally { b.p.storage.deleteObject = originalDelete; await b.cleanup(); }
  }, 60_000);

  it.each(["delete_failed", "object_survived", "head_failed"] as const)("retains MCP cleanup uncertainty after actual attachment removal: %s", async failure => {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f);
    try {
      const principal = await p.oauth.authenticate(p.token), bytes = Buffer.from("retained uncertain attachment");
      const transfers = createPublicMcpTransfers(db, p.oauth, p.api, p.storage);
      const upload = uploadLink(await transfers.getUploadUrl(principal, { companyId: f.companyId, taskId: f.issueId, requestId: randomUUID(),
        filename: "uncertain.txt", contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
      const app = express(); app.use(transfers.router);
      const url = new URL(String(upload.url));
      const result = await request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes)
        .timeout({ response: 5000, deadline: 10_000 });
      expect(result.status).toBe(200);
      const [before] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(upload.uploadId)));
      const originalDelete = p.storage.deleteObject, originalHead = p.storage.headObject;
      if (failure === "delete_failed") p.storage.deleteObject = async () => { throw new Error("controlled storage removal failure"); };
      if (failure === "object_survived") p.storage.deleteObject = async () => {};
      if (failure === "head_failed") p.storage.headObject = async () => { throw new Error("controlled storage readback failure"); };
      try { expect(await p.api(principal, DELETE_METHOD, `/attachments/${result.body.attachment.id}`)).toEqual({ ok: true }); }
      finally { p.storage.deleteObject = originalDelete; p.storage.headObject = originalHead; }
      expect(await db.select().from(tables.issueAttachments).where(eq(tables.issueAttachments.id, result.body.attachment.id))).toHaveLength(0);
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, before.id)))[0])
        .toMatchObject({ attachmentId: before.attachmentId, cleanedAt: null, cleanupVerifiedAt: null });
      expect((await p.storage.headObject(f.companyId, before.objectKey)).exists).toBe(failure !== "head_failed");
      expect(await blocked("mcp_attachment_uploads")).toBe(true);
      // The existing bounded opportunistic owner can later retire this orphan
      // only by a real successful delete and readback, preserving its identity.
      await db.update(tables.mcpAttachmentUploads).set({ expiresAt: new Date(0) }).where(eq(tables.mcpAttachmentUploads.id, before.id));
      const pending = uploadLink(await transfers.getUploadUrl(principal, { companyId: f.companyId, taskId: f.issueId, requestId: randomUUID(),
        filename: "new.txt", contentType: "text/plain", byteSize: 1, sha256: createHash("sha256").update("x").digest("hex") }));
      expect((await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, before.id)))[0])
        .toMatchObject({ attachmentId: before.attachmentId, cleanupVerifiedAt: expect.any(Date) });
      expect(await p.storage.headObject(f.companyId, before.objectKey)).toEqual({ exists: false });
      expect(await blocked("mcp_attachment_uploads")).toBe(true); // newly allocated upload remains pending
      expect(pending.uploadId).toBeTruthy();
    } finally { await p.cleanup(); }
  }, 60_000);

  it.each([false, true])("preserves verified MCP cleanup after ordinary issue deletion, storageFailure=%s", async storageFailure => {
    const { createPublicMcpTransfers } = await import("../services/public-mcp/file-transfers.js");
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const f = await seed(), p = await connectedMcp(f);
    try {
      const principal = await p.oauth.authenticate(p.token), bytes = Buffer.from("removed with parent");
      const transfers = createPublicMcpTransfers(db, p.oauth, p.api, p.storage);
      const upload = uploadLink(await transfers.getUploadUrl(principal, { companyId: f.companyId, taskId: f.issueId, requestId: randomUUID(),
        filename: "parent.txt", contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
      const app = express(); app.use(transfers.router);
      const url = new URL(String(upload.url));
      const result = await request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes)
        .timeout({ response: 5000, deadline: 10_000 });
      expect(result.status).toBe(200);
      const originalDelete = p.storage.deleteObject;
      if (storageFailure) p.storage.deleteObject = async () => { throw new Error("controlled parent storage failure"); };
      try { await p.api(principal, DELETE_METHOD, `/issues/${f.issueId}`); }
      finally { p.storage.deleteObject = originalDelete; }
      expect(await db.select().from(tables.issues).where(eq(tables.issues.id, f.issueId))).toHaveLength(0);
      const [removed] = await db.select().from(tables.mcpAttachmentUploads).where(eq(tables.mcpAttachmentUploads.id, String(upload.uploadId)));
      expect(removed.attachmentId).toBe(result.body.attachment.id);
      expect(removed.cleanupVerifiedAt !== null).toBe(!storageFailure);
      expect((await p.storage.headObject(f.companyId, removed.objectKey)).exists).toBe(storageFailure);
      expect(await blocked("mcp_attachment_uploads")).toBe(storageFailure);
    } finally { await p.cleanup(); }
  }, 60_000);

  it("retains the actual rejected tool review and only its acknowledged delivery", async () => {
    const { commitToolActionReview } = await import("../services/tool-action-review.js");
    const { toolActionDeliveryService } = await import("../services/tool-action-delivery.js");
    const f = await seed(), requestId = randomUUID(), invocationId = randomUUID(), interactionId = randomUUID();
    await db.update(tables.issues).set({ status: "in_progress" }).where(eq(tables.issues.id, f.issueId));
    await db.insert(tables.toolInvocations).values({ id: invocationId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      actorType: "agent", actorId: f.agentId, agentId: f.agentId, toolName: "fixture:write", status: "awaiting_approval" });
    await db.insert(tables.issueThreadInteractions).values({ id: interactionId, companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", payload: { version: 1, prompt: "Approve fixture action?", toolAction: { actionRequestId: requestId, invocationId } } as never });
    await db.insert(tables.toolActionRequests).values({ id: requestId, companyId: f.companyId, issueId: f.issueId,
      invocationId, interactionId, requestedByAgentId: f.agentId, canonicalArgumentsHash: "a".repeat(64), canonicalArgumentsSummary: { summary: "fixture" } });
    expect(await blocked("tool_action_requests")).toBe(true);
    await commitToolActionReview(db, { companyId: f.companyId, actionRequestId: requestId, decision: "rejected", actor: { userId: "local-board" } });
    expect(await blocked("tool_action_requests")).toBe(false);
    expect(await blocked("tool_action_deliveries")).toBe(true);
    await db.update(tables.issues).set({ status: "done" }).where(eq(tables.issues.id, f.issueId));
    await toolActionDeliveryService(db, { wakeup: async () => { throw new Error("Closed issue must retire its receipt"); } }).deliver(requestId);
    expect(await blocked("tool_action_deliveries")).toBe(false);
    await db.update(tables.toolInvocations).set({ completedAt: null }).where(eq(tables.toolInvocations.id, invocationId));
    expect(await blocked("tool_action_requests")).toBe(true);
    expect(await blocked("tool_action_deliveries")).toBe(true);
  });

  it("accepts MCP completion receipts and cleanup while preserving unknown writes and pending uploads", async () => {
    const f = await seed(), p = await mcp(f);
    const [receipt] = await db.insert(tables.mcpMutationReceipts).values({ ...p, companyId: f.companyId,
      operation: "paperclip_create_task", requestId: randomUUID(), argumentsHash: "a", status: "completed", result: { id: f.issueId } }).returning();
    const [upload] = await db.insert(tables.mcpAttachmentUploads).values({ ...p, companyId: f.companyId, taskId: f.issueId,
      requestId: randomUUID(), argumentsHash: "a", originalFilename: "history.txt", contentType: "text/plain", byteSize: 1,
      sha256: "a".repeat(64), objectKey: "history/abandoned", storageProvider: "local_disk", expiresAt: now, cleanedAt: now, cleanupVerifiedAt: now }).returning();
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

  it.each([false, true])("requires actual Speko configure completion after tool receipts, defaultsFailure=%s", async defaultsFailure => {
    const { chatChannelService } = await import("../services/chat-channels.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const f = await seed(), p = await mcp(f), oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
      membershipRole: "owner", status: "active" });
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    await db.insert(tables.principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: p.userId,
      permissionKey: "agents:configure" });
    const tools: Record<string, unknown>[] = [], hooks: Record<string, unknown>[] = [];
    let failDefaults = defaultsFailure;
    const chat = chatChannelService(db, { heartbeat: { wakeup: async () => { throw new Error("No call expected"); } },
      publicBaseUrl: "https://history.example", webhookPublicBaseUrl: "https://history.example", fetch: async (input, init) => {
        const pathname = new URL(String(input)).pathname, method = init?.method ?? "GET";
        if (pathname === "/v1/agents/agent_test") {
          if (method === "PATCH" && failDefaults) return new Response("Defaults failed", { status: 503 });
          return Response.json({ id: "agent_test", organizationId: "org_test", name: "History voice" });
        }
        if (pathname.startsWith("/v1/agents/agent_test/tools")) {
          if (method === "GET") return Response.json(tools);
          const tool = { ...JSON.parse(String(init?.body)), id: pathname.split("/").length > 5 ? pathname.split("/").at(-1)! : `tool_${tools.length}` };
          const index = tools.findIndex(old => old.id === tool.id); if (index < 0) tools.push(tool); else tools[index] = tool;
          return Response.json({ id: tool.id });
        }
        if (pathname.startsWith("/v1/webhooks")) {
          if (method === "GET") return Response.json({ data: hooks });
          const hook = { ...JSON.parse(String(init?.body)), id: "hook_test", filterTags: {} }; hooks.splice(0, hooks.length, hook);
          return Response.json({ id: hook.id });
        }
        throw new Error(`Unexpected Speko provider boundary ${method} ${pathname}`);
      } });
    try {
      const endpoint = await chat.create(f.companyId, { provider: "speko", assignedAgentId: f.agentId }, p.userId);
      let configureAttempts = 0;
      const configure = () => chat.configure(endpoint.id, { action: configureAttempts++ === 0 ? "configure" : "reconnect",
        credentials: { apiKey: "fixture-api-key", agentId: "agent_test", signingSecret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } }, p.userId);
      if (defaultsFailure) {
        await expect(configure()).rejects.toMatchObject({ status: 422 });
        const partial = (await db.select().from(tables.chatActions)).filter(a => a.endpointId === endpoint.id);
        expect(partial).toHaveLength(4);
        expect(partial.every(a => a.status === "completed")).toBe(true);
        for (const receipt of partial) expect(await blockedActionKind(receipt.kind)).toBe(true);
        failDefaults = false;
      }
      await configure();
      const receipts = (await db.select().from(tables.chatActions)).filter(a => a.endpointId === endpoint.id);
      expect(receipts).toHaveLength(4);
      expect(await blockedActionKind("speko_tool_setup")).toBe(false);
      expect(await blockedActionKind("speko_lifecycle_setup")).toBe(false);
      const [activity] = await db.select().from(tables.activityLog).where(eq(tables.activityLog.action,
        defaultsFailure ? "chat_endpoint.reconnected" : "chat_endpoint.credentials_verified"));
      expect(activity.details).toMatchObject({ endpointId: endpoint.id, provider: "speko" });
    } finally {
      await chat.shutdown();
      if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = oldKey;
    }
  }, 60_000);

  it("retires actual GitHub omission navigation only after its exact native response publication settles", async () => {
    const { createGitHubPublicationPolicy } = await import("../services/chat-channels/github/publication-policy.js");
    const { ensureNativeCompletionContract } = await import("../services/native-runtime/completion-contracts.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const f = await slackFixture();
    const [endpoint] = await db.update(tables.chatEndpoints).set({ provider: "github" }).where(eq(tables.chatEndpoints.id, f.endpoint.id)).returning();
    const contract = await ensureNativeCompletionContract({ db, companyId: f.companyId, issue: { id: f.issueId, title: "Omitted source", description: null }, actorId: "history" });
    const [comment] = await db.insert(tables.issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, createdByRunId: f.runId, body: "Source unavailable; see the task" }).returning();
    await db.update(tables.heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId, completionContractId: contract.row.id,
      resultJson: { presentationDecision: { commentId: comment.id } } }).where(eq(tables.heartbeatRuns.id, f.runId));
    const [result] = await db.insert(tables.nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contract.row.id, schemaStatus: "accepted", serverFingerprint: randomUUID(), canonicalSha256: "a".repeat(64), resultJson: {} }).returning();
    await db.insert(tables.nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      phase: "committed", resultId: result.id });
    const [publication] = await db.insert(tables.chatPublications).values({ companyId: f.companyId, endpointId: endpoint.id,
      conversationId: f.conversation.id, issueId: f.issueId, commentId: comment.id, idempotencyKey: randomUUID(), payload: { text: comment.body } }).returning();
    const unused = async (): Promise<never> => { throw new Error("Unexpected GitHub publication boundary"); };
    const policy = createGitHubPublicationPolicy(db, { isExplicitOperatorPublication: () => false, getTaskBaseUrl: () => "https://history.example",
      // Exact current native-input authority is the named consumer boundary;
      // the actual policy validates canonical owner rows and writes the marker.
      failedChatRetrySource: async () => ({ endpointId: endpoint.id, conversationId: f.conversation.id,
        sources: [{ omissionReasons: { download_unavailable: 1 } }] }) as never,
      isExternalActionAuthorizationChange: () => false, FailedChatRetryPublicationReadError: class extends Error {}, endpointRecord: unused,
      runIdFromMilestonePublication: () => null, fetchImpl: unused, stageTerminalReceiptReactionRemovals: unused,
      runtimeContextForRecord: unused as never, scheduleMessageProcessing: unused, processReceiptReaction: unused });
    const text = await db.transaction(tx => policy.githubCurrentOmissionPreparedText(tx, publication, endpoint));
    expect(text).toContain("Open this Paperclip task");
    const [receipt] = await db.select().from(tables.chatActions).where(eq(tables.chatActions.kind, "github_omission_navigation"));
    expect(receipt).toMatchObject({ status: "processed", result: null });
    expect(await blockedActionKind("github_omission_navigation")).toBe(true);
    await db.update(tables.chatPublications).set({ payload: { ...publication.payload, text: String(text) }, state: "delivery_unknown" })
      .where(eq(tables.chatPublications.id, publication.id));
    const chat = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
    try { await chat.resolvePublication(endpoint.id, publication.id, "mark_delivered", f.userId); }
    finally { await chat.shutdown(); }
    expect(await blockedActionKind("github_omission_navigation")).toBe(false);
    await db.update(tables.chatActions).set({ payload: { ...receipt.payload, resultId: randomUUID() } }).where(eq(tables.chatActions.id, receipt.id));
    expect(await blockedActionKind("github_omission_navigation")).toBe(true);
  });

  it("retires an actual Discord status-command receipt while preserving registration deadline work", async () => {
    const { reconcileStoredDiscordCommandRegistration } = await import("../services/chat-discord-command-registration-store.js");
    const { createDiscordCommands } = await import("../services/chat-channels/discord/commands.js");
    const { chatCredentialMutationLease } = await import("../services/chat-credential-mutation-lease.js");
    const f = await slackFixture(), applicationId = String(1_400_000_000_000_000_000n + BigInt(Date.now()) + BigInt(randomBytes(2).readUInt16BE())), guildId = "1457808928258658549", channelId = "333333333333333333";
    const [endpoint] = await db.update(tables.chatEndpoints).set({ provider: "discord", botExternalId: applicationId,
      providerAccountId: guildId, capabilities: { slashCommands: true } as never }).where(eq(tables.chatEndpoints.id, f.endpoint.id)).returning();
    const [principal] = await db.update(tables.chatExternalPrincipals).set({ provider: "discord", externalId: "444444444444444444",
      providerAccountId: guildId }).where(eq(tables.chatExternalPrincipals.id, f.principal.id)).returning();
    const context = { generation: 1, credentialFingerprint: "c".repeat(64), localEpoch: 0, version: "fixture", discordGatewayOwned: true };
    const scope = { companyId: f.companyId, endpointId: endpoint.id, applicationId, guildId };
    const remote: Record<string, unknown>[] = [];
    const registered = await reconcileStoredDiscordCommandRegistration(db, { scope, runtimeFence: { generation: context.generation, credentialFingerprint: context.credentialFingerprint }, botToken: "fixture-token",
      authorize: async tx => {
        expect((await tx.select().from(tables.chatEndpoints).where(eq(tables.chatEndpoints.id, endpoint.id)).for("update"))[0].status).toBe("active");
      }, fetch: async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(remote);
        const command = { ...JSON.parse(String(init?.body)), id: "888888888888888888", application_id: applicationId, version: "999999999999999999" };
        remote.splice(0, remote.length, command); return Response.json(command);
      } });
    expect(registered.kind).toBe("registered");
    const leaseKey = "discord_gateway", token = randomUUID();
    await db.insert(tables.chatEndpointLeases).values({ companyId: f.companyId, endpointId: endpoint.id, leaseKey, token,
      expiresAt: new Date(Date.now() + 60_000) });
    const record = { endpoint, assignedAgentName: "Idle agent", connectionName: "Discord", applicationId: randomUUID(), credentialSecretRefs: [] };
    const unused = async (): Promise<never> => { throw new Error("No Discord transport/control boundary expected"); };
    const service = createDiscordCommands(db, { endpointRecord: async () => record, runtimeContextForRecord: () => context,
      runtimeGeneration: () => 1, credentialFingerprint: () => context.credentialFingerprint, resolveCredentialRefs: unused,
      fetchImpl: unused, withCredentialMutationLease: chatCredentialMutationLease(db), runtimeCallbackRecord: async () => record,
      ensurePrincipal: async () => ({ principal, userId: f.userId }), runtimeCallbackEndpoint: async () => endpoint,
      nonDirectDestinationAllowed: () => true, lockCurrentPrincipalAuthorization: async () => ({ allowed: true, userId: f.userId }),
      getDiscordGatewayOwnership: () => ({ leaseKey, token }), discordGatewayRuntimeIsCurrent: () => true,
      stageAuthorizedTaskControlPublication: unused, scheduleMessageProcessing: unused, processPendingPublications: unused });
    const thread = `discord:${guildId}:${channelId}`;
    const result = await service.handleDiscordNativeCommand({ endpointId: endpoint.id, provider: "discord", transport: "discord_gateway",
      event: { command: "/paperclip status", text: "", channelId: thread, channel: { id: thread },
        user: { userId: principal.externalId, isBot: false, isMe: false }, raw: { id: "777777777777777777", application_id: applicationId,
          type: 2, version: 1, channel_id: channelId, channel: { id: channelId, type: 0 }, guild_id: guildId, context: 0,
          authorizing_integration_owners: { "0": guildId }, data: { id: "888888888888888888", type: 1, name: "paperclip",
            options: [{ type: 1, name: "status" }] }, user: { id: principal.externalId, username: "operator", bot: false } } } } as never, context);
    expect(result).toMatchObject({ kind: "accepted" });
    expect(await blockedActionKind("discord_native_command")).toBe(false);
    expect(await blockedActionKind("discord_command_registration")).toBe(true);
    const [receipt] = await db.select().from(tables.chatActions).where(eq(tables.chatActions.kind, "discord_native_command"));
    await db.update(tables.chatActions).set({ result: { ...receipt.result, kind: "unknown" } }).where(eq(tables.chatActions.id, receipt.id));
    expect(await blockedActionKind("discord_native_command")).toBe(true);
  });

  it.each(["live_photo_video", "heif_jpeg_preview"] as const)("retains actual Photon %s provenance after source-bound storage registration", async relationKind => {
    const { createInboundAttachments } = await import("../services/chat-channels/inbound-attachments.js");
    const { createInboundWakeups } = await import("../services/chat-channels/inbound/wakeups.js");
    const { downloadPhotonAttachment } = await import("../services/photon/attachments.js");
    const { issueService } = await import("../services/issues.js");
    const { createStorageService } = await import("../storage/service.js");
    const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
    const f = await slackFixture(), directory = await mkdtemp(path.join(tmpdir(), "history-photon-provenance-"));
    const [endpoint] = await db.update(tables.chatEndpoints).set({ provider: "imessage-photon" }).where(eq(tables.chatEndpoints.id, f.endpoint.id)).returning();
    const [comment] = await db.insert(tables.issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "Source-bound photo" }).returning();
    const providerEventId = randomUUID();
    const [delivery] = await db.insert(tables.chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint.id,
      conversationId: f.conversation.id, principalId: f.principal.id, providerEventId, deduplicationKey: randomUUID(),
      eventKind: "message", state: "processing", attempts: 1, normalizedEvent: { providerEventId, kind: "message" } }).returning();
    const unused = async (): Promise<never> => { throw new Error("Unexpected Photon admission boundary"); };
    const wakes = createInboundWakeups(db, { authorizeInboundWakeup: unused, authorizeInboundWorkStart: unused,
      attachmentOmissionDetail: () => null, isExternalActionAuthorizationChange: () => false, redactError: String,
      fetchImpl: unused, heartbeat: { wakeup: unused } });
    try {
      await db.transaction(tx => wakes.stageInboundWakeup(tx, { endpoint, deliveryId: delivery.id, conversation: f.conversation,
        commentId: comment.id, principalId: f.principal.id, actorUserId: null }));
      const storage = createStorageService(createLocalDiskStorageProvider(directory));
      const bytes = relationKind === "heif_jpeg_preview"
        ? await readFile(new URL("./photon/fixtures/synthetic.heic", import.meta.url))
        : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6S8AAAAASUVORK5CYII=", "base64");
      const type = relationKind === "heif_jpeg_preview" ? "image/heic" : "image/png";
      let body: Buffer = bytes, closed = false;
      if (relationKind === "live_photo_video") {
        const companion = Buffer.from("Actual bounded companion bytes"), locator = { kind: "photon_attachment" as const,
          lineId: "line", chatGuid: "chat", messageGuid: "message", attachmentGuid: "attachment" };
        const info = { guid: "attachment", totalBytes: bytes.length, mimeType: type, fileName: "photo.png", isSticker: false, isHidden: false };
        const stream = { async *[Symbol.asyncIterator]() {
          yield { type: "header", info, companionInfo: { kind: "live-photo-video", mimeType: "video/mp4", totalBytes: companion.length, fileName: "motion.mp4" } };
          yield { type: "primaryChunk", data: bytes }; yield { type: "companionChunk", data: companion };
        }, close: async () => { closed = true; } };
        body = await downloadPhotonAttachment({ messages: { get: async () => ({ guid: "message", chatGuids: ["chat"], content: { attachments: [info] } }) },
          attachments: { downloadStream: () => stream } } as never, "line", locator);
        expect(closed).toBe(true);
      }
      const service = createInboundAttachments(db, { storage, authorizeInboundWakeup: async () => ({ delivery, conversation: f.conversation }),
        lifecycleRuntimeFence: () => ({ generation: 1, credentialFingerprint: "c".repeat(64) }), sanitizeFilename: value => value ?? null,
        issuesSvc: issueService(db), isExternalActionAuthorizationChange: () => false, redactError: String });
      const result = await service.ingestAttachments({ endpoint, endpointRuntime: {} as never, deliveryId: delivery.id,
        issueId: f.issueId, issueCommentId: comment.id, actorUserId: null,
        attachments: [{ type: "image", name: relationKind === "heif_jpeg_preview" ? "photo.heic" : "photo.png", mimeType: type,
          size: bytes.length, fetchData: async () => body }] });
      expect(result.omissionReasons).toEqual({});
      expect(result.storedIds).toHaveLength(2);
      const receipt = (await db.select().from(tables.chatActions)).find(a => a.kind === (relationKind === "heif_jpeg_preview" ? "attachment_derivative" : "attachment_companion"))!;
      expect(receipt).toMatchObject({ status: "processed", payload: { kind: relationKind } });
      expect(await blockedActionKind(receipt.kind)).toBe(false);
      expect(await blockedActionKind("inbound_wakeup")).toBe(true);
      const assets = await db.select().from(tables.assets);
      for (const asset of assets) expect((await storage.headObject(f.companyId, asset.objectKey)).exists).toBe(true);
      const { chatChannelService } = await import("../services/chat-channels.js");
      const chat = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
      try {
        await expect(chat.publishBoardMessage(endpoint.id, f.conversation.id, "Reuse an already bound attachment", randomUUID(), f.userId,
          [result.storedIds[0]])).rejects.toMatchObject({ status: 409 });
        expect(await blockedActionKind("board_send_rejected")).toBe(false);
      } finally { await chat.shutdown(); }
      await db.update(tables.chatActions).set({ payload: { ...receipt.payload, derivativeSha256: "0".repeat(64) } }).where(eq(tables.chatActions.id, receipt.id));
      expect(await blockedActionKind(receipt.kind)).toBe(true);
      await db.update(tables.chatActions).set({ payload: receipt.payload }).where(eq(tables.chatActions.id, receipt.id));
      const [otherIssue] = await db.insert(tables.issues).values({ companyId: f.companyId, title: "Wrong lineage" }).returning();
      await db.update(tables.issueAttachments).set({ issueId: otherIssue.id }).where(eq(tables.issueAttachments.id, String(receipt.payload.derivativeAttachmentId)));
      expect(await blockedActionKind(receipt.kind)).toBe(true);
      await db.update(tables.issueAttachments).set({ issueId: f.issueId }).where(eq(tables.issueAttachments.id, String(receipt.payload.derivativeAttachmentId)));
      const { issueRoutes } = await import("../routes/issues.js");
      const { createMcpApiDispatch } = await import("../services/public-mcp/capabilities.js");
      const { Router } = await import("express");
      const router = Router(); router.use(issueRoutes(db, storage));
      const api = createMcpApiDispatch(router), actor = { type: "board", userId: f.userId, companyIds: [f.companyId], source: "session",
        memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] };
      for (const id of result.storedIds) expect(await api({ actor } as never, DELETE_METHOD, `/attachments/${id}`)).toEqual({ ok: true });
      expect(await db.select().from(tables.issueAttachments)).toHaveLength(0);
      for (const asset of assets) expect((await storage.headObject(f.companyId, asset.objectKey)).exists).toBe(false);
      expect(await blockedActionKind(receipt.kind)).toBe(false);
      expect(await blockedActionKind("inbound_wakeup")).toBe(true);
    } finally { wakes.unregisterDeferredWakeOwner(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("retires actual Photon interaction, retry and response-notice history with their canonical owners", async () => {
    const { issueThreadInteractionService } = await import("../services/issue-thread-interactions.js");
    const { recordPhotonPublicationRetry } = await import("../services/chat-channels/imessage-photon/publication-retry.js");
    const { stagePhotonResponseNotice } = await import("../services/chat-channels/imessage-photon/response-notices.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const f = await seed(), c = await connection(f);
    await db.update(tables.issues).set({ status: "in_progress" }).where(eq(tables.issues.id, f.issueId));
    const [endpoint] = await db.insert(tables.chatEndpoints).values({ companyId: f.companyId, connectionId: c.connectionId,
      assignedAgentId: f.agentId, provider: "imessage-photon", publicId: randomUUID(), status: "active", publicationMode: "automatic" }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id,
      issueId: f.issueId, externalConversationId: "photon-personal", externalThreadId: "photon-personal", externalLabel: "Personal", state: "active" }).returning();
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, { kind: "ask_user_questions",
      continuationPolicy: "wake_assignee", payload: { version: 1, title: "Choose", submitLabel: "Continue", questions: [{
        id: "choice", prompt: "Choose", selectionMode: "single", required: true, allowOther: false,
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] } }, { agentId: f.agentId });
    const [token] = await db.select().from(tables.chatActions);
    expect(token).toMatchObject({ kind: "photon_interaction", status: "issued", conversationId: conversation.id });
    expect(await blockedActionKind("photon_interaction")).toBe(true);
    await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId }, interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: "local-board" });
    expect(await blockedActionKind("photon_interaction")).toBe(false);
    const [previousSource] = await db.select().from(tables.chatPublications);
    const [source] = await db.update(tables.chatPublications).set({ state: "delivery_unknown" })
      .where(eq(tables.chatPublications.id, previousSource.id)).returning();
    await db.transaction(async tx => {
      await recordPhotonPublicationRetry(tx, endpoint.id, source, "local-board");
      await stagePhotonResponseNotice(tx, { publication: source, reference: String(token.payload.reference), questionIndex: 0,
        key: `photon-response:${token.payload.reference}:1`, text: "Answer saved" });
    });
    expect(await blockedActionKind("photon_publication_retry")).toBe(true);
    expect(await blockedActionKind("photon_response_notice")).toBe(true);
    const unused = async (): Promise<never> => { throw new Error("No Photon network expected"); };
    const service = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
    try {
      for (const publication of await db.select().from(tables.chatPublications)) {
        await db.update(tables.chatPublications).set({ state: "delivery_unknown" }).where(eq(tables.chatPublications.id, publication.id));
        await service.resolvePublication(endpoint.id, publication.id, "mark_delivered", "local-board");
      }
      expect(await blocked("chat_actions")).toBe(false);
      await db.update(tables.chatActions).set({ payload: { ...token.payload, interactionId: randomUUID() } }).where(eq(tables.chatActions.id, token.id));
      expect(await blockedActionKind("photon_interaction")).toBe(true);
    } finally { await service.shutdown(); }
  });

  it("retains actual Slack connect discovery while its separate notice remains pending", async () => {
    const { createSlackCommands, slackCommandForAgent } = await import("../services/chat-channels/slack/commands.js");
    const { createProviderEffects } = await import("../services/chat-channels/provider-effects.js");
    const { chatCredentialMutationLease } = await import("../services/chat-credential-mutation-lease.js");
    const f = await slackFixture(), unused = async (): Promise<never> => { throw new Error("Unexpected discovery boundary"); };
    const effects = createProviderEffects(db, { endpointRecord: unused, runtimeCallbackEndpoint: async () => f.endpoint,
      withCredentialMutationLease: chatCredentialMutationLease(db), runtimeFor: unused, invalidateRuntime: unused,
      lockCurrentPrincipalAuthorization: unused, redactError: String, MAX_ERROR_TEXT: 500,
      nonDirectDestinationAllowed: () => false, lockTelegramCallbackNoticeAuthority: unused });
    const command = slackCommandForAgent("Idle agent", f.endpoint.publicId), scheduled: string[] = [];
    const service = createSlackCommands(db, { runtime: { get: () => null }, runtimeFor: unused, handleSdkMessage: unused,
      stageProviderEffect: effects.stageProviderEffect, scheduleProviderEffect: id => { scheduled.push(id); },
      ensurePrincipal: async () => ({ principal: f.principal, userId: null, linkedDenied: false }),
      runtimeCallbackEndpoint: async () => f.endpoint, getPublicBaseUrl: () => "https://history.example",
      canonicalProviderResourceId: unused as never, nonDirectDestinationAllowed: () => false, sponsorAllowsGuest: unused,
      latestSlackDmControlThreadId: unused, scheduleMessageProcessing: unused, processSlackTaskStart: unused });
    await service.handleSlackSlashCommand({ endpointId: f.endpoint.id, provider: "slack", transport: "slack_socket",
      event: { command, text: "connect", triggerId: randomUUID(), channel: { id: "DCHANNEL" },
        user: { userId: "UREQUESTER", isBot: false, isMe: false }, raw: {} } } as never,
      { generation: 1, credentialFingerprint: "c".repeat(64), localEpoch: 0, version: "fixture" },
      { endpoint: f.endpoint, assignedAgentName: "Idle agent", connectionName: "Slack", applicationId: randomUUID(), credentialSecretRefs: [] }, command, "connect");
    expect(scheduled).toHaveLength(1);
    expect((await db.select().from(tables.chatIdentityLinks))[0]).toMatchObject({ status: "pending", confirmationTokenHash: expect.any(String) });
    expect(await blockedActionKind("slack_connect")).toBe(false);
    expect(await blockedActionKind("provider_effect")).toBe(true);
    expect(await blocked("chat_actions")).toBe(true);
  });

  it("retains the actual Telegram stop-subscription ownership receipt", async () => {
    const { createTelegramMaintenance } = await import("../services/chat-channels/telegram/maintenance.js");
    const { chatCredentialMutationLease } = await import("../services/chat-credential-mutation-lease.js");
    const f = await seed(), c = await connection(f);
    await db.update(tables.toolConnections).set({ enabled: true, status: "active" }).where(eq(tables.toolConnections.id, c.connectionId));
    const [endpoint] = await db.insert(tables.chatEndpoints).values({ companyId: f.companyId, connectionId: c.connectionId,
      assignedAgentId: f.agentId, provider: "telegram", publicId: randomUUID(), status: "active", botExternalId: "1234567" }).returning();
    const unused = async (): Promise<never> => { throw new Error("Unexpected Telegram provider boundary"); };
    const context = { generation: 3, credentialFingerprint: "c".repeat(64) }, withCredentialMutationLease = chatCredentialMutationLease(db);
    const service = createTelegramMaintenance(db, { endpointRecord: unused, runtimeContextForRecord: () => context,
      withCredentialMutationLease, resolveCredentials: unused, clearCredentials: unused,
      runtimeCallbackEndpoint: async () => endpoint, getWebhookPublicBaseUrl: () => "https://history.example",
      fetchImpl: unused, runtimeGeneration: () => 3, credentialFingerprint: () => context.credentialFingerprint,
      redactError: String, credentialCheckTimeoutMs: 1000 });
    await withCredentialMutationLease(endpoint, lease => service.recordTelegramStopSubscription(endpoint, context, lease));
    expect(await service.hasTelegramStopSubscription(endpoint, context)).toBe(true);
    expect(await blocked("chat_actions")).toBe(false);
    const [receipt] = await db.select().from(tables.chatActions);
    await db.update(tables.chatActions).set({ payload: { ...receipt.payload, webhookUrlSha256: "unknown" } }).where(eq(tables.chatActions.id, receipt.id));
    expect(await blocked("chat_actions")).toBe(true);
  });

  it("retains the actual Slack private-source boundary and governed completed write", async () => {
    const { recordSlackReadBoundary } = await import("../services/connectors/slack-access.js");
    const { registerSlackTaskAuthority } = await import("../services/connectors/slack-authority.js");
    const { executeSlackWrite } = await import("../services/connectors/slack-writes.js");
    const f = await slackFixture();
    await recordSlackReadBoundary(db, f.authority, { id: "CPRIVATE", is_private: true });
    expect(await blocked("chat_actions")).toBe(false);
    const invocationId = randomUUID();
    await db.insert(tables.toolInvocations).values({ id: invocationId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, runId: f.runId, connectionId: f.connectionId, actorType: "agent", actorId: f.agentId,
      toolName: "slack_post_message", status: "executing" });
    const unregister = registerSlackTaskAuthority(db, async () => f.authority);
    const methods: string[] = [];
    try {
      await executeSlackWrite(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId },
        "slack_post_message", { channel: "DCHANNEL", text: "Confirmed message", idempotencyKey: randomUUID() }, invocationId,
        async input => {
          const method = new URL(String(input)).pathname.split("/").at(-1)!; methods.push(method);
          if (method === "conversations.info") return Response.json({ ok: true, channel: { id: "DCHANNEL", is_im: true, user: "UREQUESTER" } });
          if (method === "users.info") return Response.json({ ok: true, user: { id: "UREQUESTER", team_id: "TWORKSPACE", is_bot: false } });
          if (method === "chat.postMessage") return Response.json({ ok: true, channel: "DCHANNEL", ts: "123.456" });
          throw new Error(`Unexpected Slack boundary ${method}`);
        });
      expect(methods).toContain("chat.postMessage");
      expect((await db.select().from(tables.chatActions)).find(a => a.kind === "slack_tool_write"))
        .toMatchObject({ status: "processed", result: { channel: "DCHANNEL", ts: "123.456" } });
      expect(await blocked("chat_actions")).toBe(false);
      await db.update(tables.chatActions).set({ status: "uncertain" }).where(eq(tables.chatActions.kind, "slack_tool_write"));
      expect(await blocked("chat_actions")).toBe(true);
    } finally { unregister(); }
  });

  it("retires actual Slack invitation, test-message and mirror receipts without hiding their publication", async () => {
    const { slackTestMessageService } = await import("../services/connectors/slack/test-message.js");
    const { mirrorSlackBoardComment } = await import("../services/slack-board-messages.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const { chatCredentialMutationLease } = await import("../services/chat-credential-mutation-lease.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const f = await slackFixture();
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const unused = async (): Promise<never> => { throw new Error("Unexpected provider boundary"); };
    const credentialLease = chatCredentialMutationLease(db);
    const send = slackTestMessageService(db, { withLock: (id, task) => credentialLease(f.endpoint, task),
      runtimeBotToken: async () => "test-token", linkInstaller: async () => {}, ensureAccount: async () => f.principal.id,
      createLinkIntent: async () => ({ confirmationUrl: "https://example.test/link", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      fetch: async input => {
        const method = new URL(String(input)).pathname.split("/").at(-1);
        if (method === "users.info") return Response.json({ ok: true, user: { id: "UREQUESTER", team_id: "TWORKSPACE", is_bot: false } });
        if (method === "chat.postMessage") return Response.json({ ok: true, channel: "DCHANNEL", ts: "123.456" });
        throw new Error(`Unexpected setup boundary ${method}`);
      } });
    expect(await send(f.endpoint.id, { userId: f.userId, sessionId: null, bypassPermissionCheck: false }, { requestId: randomUUID(), slackUserId: "UREQUESTER" }))
      .toMatchObject({ status: "connection_pending" });
    expect(await blocked("chat_actions")).toBe(false);
    await db.insert(tables.chatIdentityLinks).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      principalId: f.principal.id, paperclipUserId: f.userId, status: "linked", confirmedAt: now });
    expect(await send(f.endpoint.id, { userId: f.userId, sessionId: null, bypassPermissionCheck: false }, { requestId: randomUUID(), slackUserId: "UREQUESTER" }))
      .toMatchObject({ status: "sent" });
    expect(await blocked("chat_actions")).toBe(false);
    const [comment] = await db.insert(tables.issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Mirror this board comment" }).returning();
    await db.transaction(tx => mirrorSlackBoardComment(tx, comment));
    const [publication] = await db.select().from(tables.chatPublications);
    expect(publication).toMatchObject({ state: "pending", commentId: comment.id });
    expect(await blocked("chat_actions")).toBe(true);
    const service = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
    try {
      await db.update(tables.chatPublications).set({ state: "delivery_unknown" }).where(eq(tables.chatPublications.id, publication.id));
      await service.resolvePublication(f.endpoint.id, publication.id, "mark_delivered", f.userId);
      expect(await blocked("chat_actions")).toBe(false);
      await db.update(tables.chatActions).set({ status: "uncertain" }).where(eq(tables.chatActions.kind, "slack_test_message"));
      expect(await blocked("chat_actions")).toBe(true);
    } finally { await service.shutdown(); }
  });

  it("retires the actual shared GitHub response target only after its request is final", async () => {
    const { githubIngressFixture } = await import("./helpers/github-webhook-ingress.js");
    const { writeGitHubResponseComment } = await import("../services/chat-github-response-comments.js");
    const { stagePullResponse } = await import("../services/chat-channels/github/response-target.js");
    const { withGitHubPublicationLease } = await import("../services/chat-github-publication-lease.js");
    const f = await githubIngressFixture(db), providerEventId = randomUUID();
    const [issue] = await db.insert(tables.issues).values({ companyId: f.companyId, title: "GitHub reply", status: "done" }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      issueId: issue.id, externalConversationId: "repository:418", externalThreadId: "github:org/repo:7", externalLabel: "PR7" }).returning();
    const [delivery] = await db.insert(tables.chatDeliveries).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      conversationId: conversation.id, providerEventId, deduplicationKey: randomUUID(), eventKind: "action", normalizedEvent: { providerEventId, kind: "action" } }).returning();
    const source = { endpoint: f.endpoint, conversation, delivery, number: 7, replyId: null, repositoryId: "418" };
    await stagePullResponse(db, source);
    expect(await blocked("chat_actions")).toBe(false); // initialized target owns no request yet
    let posted: { id: number; html_url: string; body: string; user: { login: string | null } } | undefined;
    const calls: string[] = [];
    const api = { request: async <T>(pathname: string, options?: { method?: string; body?: unknown }): Promise<T> => {
      calls.push(`${options?.method ?? "GET"} ${pathname}`);
      if (!options?.method) return (pathname.includes("?per_page=") ? [] : posted) as T;
      posted = { id: 123, html_url: "https://github.com/org/repo/pull/7#issuecomment-123",
        body: (options.body as { body: string }).body, user: { login: f.endpoint.botUsername } };
      return posted as T;
    } };
    const publish = (final: boolean) => withGitHubPublicationLease(db, { companyId: f.companyId, endpointId: f.endpoint.id,
      repositoryId: "418", number: 7 }, async () => { throw new Error("No lease network expected"); }, lease =>
      writeGitHubResponseComment(db, source, api, lease, { body: final ? "Final result" : "Working", final }, async () => {}));
    await publish(false);
    expect(await blocked("chat_actions")).toBe(true);
    await publish(true);
    expect(calls).toContain("PATCH /issues/comments/123");
    expect(await blocked("chat_actions")).toBe(false);
    const request = (await db.select().from(tables.chatActions)).find(a => a.kind === "github_response_comment")!;
    expect(request).toMatchObject({ status: "processed", result: { final: true, id: "123" } });
    await db.update(tables.chatActions).set({ result: { ...request.result, final: false } }).where(eq(tables.chatActions.id, request.id));
    expect(await blocked("chat_actions")).toBe(true);
  });

  it("retires actual GitHub terminal review checks despite their retained retry hints", async () => {
    const { githubIngressFixture } = await import("./helpers/github-webhook-ingress.js");
    const { githubReviewCheckService } = await import("../services/chat-github-checks.js");
    const { secretService } = await import("../services/secrets.js");
    const { defaultGitHubReviewPolicy } = await import("@paperclipai/shared");
    const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    try {
      const f = await githubIngressFixture(db);
      const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      const refs = [];
      for (const [key, value] of Object.entries({ appId: "12", installationId: "34", privateKey })) {
        const secret = await secretService(db).create(f.companyId, { name: `GitHub ${key}`, key, provider: "local_encrypted", value });
        refs.push({ configPath: `credentials.${key}`, secretId: secret.id, versionSelector: "latest" as const });
        await secretService(db).createBinding({ companyId: f.companyId, secretId: secret.id, targetType: "tool_connection",
          targetId: f.endpoint.connectionId, configPath: `credentials.${key}`, versionSelector: "latest" });
      }
      await db.update(tables.toolConnections).set({ enabled: true, status: "active", credentialSecretRefs: refs })
        .where(eq(tables.toolConnections.id, f.endpoint.connectionId));
      await db.insert(tables.chatGitHubConfigurations).values({ companyId: f.companyId, endpointId: f.endpoint.id, updatedByUserId: "local-board",
        configuration: { version: 1, toolsEnabled: true, responsibleUserId: "local-board", memberAccess: "all_linked", people: [],
          repositories: {}, defaults: { ...defaultGitHubReviewPolicy(), ratingThreshold: 3 } } });
      await db.insert(tables.chatEndpointResources).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        providerResourceId: "org/repo", type: "repository", label: "org/repo", enabled: true,
        availability: "available", metadata: { providerRepositoryId: "418" } });
      const event = { event: "opened" as const, deliveryId: randomUUID(), repositoryId: "418", repository: "org/repo", pullNumber: 7,
        title: "Saved review", body: "", baseSha: "a".repeat(40), headSha: "b".repeat(40), baseBranch: "master",
        author: { id: "42", login: "octocat", isBot: false }, sender: { id: "42", login: "octocat" }, draft: false, labels: [] };
      const calls: string[] = [];
      let stale = false;
      const service = githubReviewCheckService(db, async input => {
        const pathname = new URL(String(input)).pathname; calls.push(pathname);
        if (pathname === "/app/installations/34/access_tokens") return Response.json({ token: "test-token" });
        if (pathname === "/repos/org/repo/pulls/7") return Response.json({ head: { sha: stale ? "c".repeat(40) : event.headSha } });
        if (pathname.endsWith("/check-runs")) return Response.json(pathname.includes("/commits/")
          ? { check_runs: [] } : { id: 123, html_url: "https://github.com/org/repo/runs/123" });
        throw new Error(`Unexpected GitHub boundary ${pathname}`);
      });
      await service.enqueue(f.endpoint, event, false, "manual review required");
      const [pending] = await db.select().from(tables.chatActions).where(eq(tables.chatActions.kind, "github_review_check"));
      expect(await blocked("chat_actions")).toBe(true);
      await service.processPending();
      const [completed] = await db.select().from(tables.chatActions).where(eq(tables.chatActions.id, pending.id));
      expect(completed, JSON.stringify({ result: completed.result, calls })).toMatchObject({ status: "processed", result: { state: "manual_required", retryable: true } });
      expect(calls).toContain("/repos/org/repo/check-runs");
      expect(await blocked("chat_actions")).toBe(false);
      stale = true;
      await service.enqueue(f.endpoint, { ...event, deliveryId: randomUUID() }, false, "stale head");
      const next = (await db.select().from(tables.chatActions)).find(a => a.status === "received")!;
      await service.processPending();
      expect((await db.select().from(tables.chatActions).where(eq(tables.chatActions.id, next.id)))[0])
        .toMatchObject({ status: "cancelled", result: { code: "stale_head" } });
      expect(await blocked("chat_actions")).toBe(false);
      await service.enqueue(f.endpoint, { ...event, deliveryId: randomUUID() }, false, "connection removed");
      await db.update(tables.chatEndpointResources).set({ enabled: false }).where(eq(tables.chatEndpointResources.endpointId, f.endpoint.id));
      const last = (await db.select().from(tables.chatActions)).find(a => a.status === "received")!;
      await service.processPending();
      expect((await db.select().from(tables.chatActions).where(eq(tables.chatActions.id, last.id)))[0])
        .toMatchObject({ status: "cancelled", result: { code: "connection_changed" } });
      expect(await blocked("chat_actions")).toBe(false);
      await db.update(tables.chatActions).set({ result: { state: "queued", retryable: true } }).where(eq(tables.chatActions.id, completed.id));
      expect(await blocked("chat_actions")).toBe(true);
    } finally { if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = oldKey; }
  }, 60_000);

  it("retires real question-form tokens only after their exact canonical answer commits", async () => {
    const { issueThreadInteractionService } = await import("../services/issue-thread-interactions.js");
    const { claimChatQuestionFormSubmission, completeChatQuestionFormSubmission } = await import("../services/chat-question-forms.js");
    const f = await seed(), c = await connection(f);
    await db.update(tables.issues).set({ status: "in_progress" }).where(eq(tables.issues.id, f.issueId));
    const [endpoint] = await db.insert(tables.chatEndpoints).values({ companyId: f.companyId, connectionId: c.connectionId,
      assignedAgentId: f.agentId, publicId: randomUUID(), provider: "slack", status: "active", publicationMode: "automatic",
      capabilities: { actions: true, modals: true } as never }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id,
      issueId: f.issueId, externalConversationId: "question-channel", externalThreadId: "question-thread", externalLabel: "Question", state: "active" }).returning();
    const [principal] = await db.insert(tables.chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack",
      providerAccountId: "workspace", externalId: "answering-user" }).returning();
    const service = issueThreadInteractionService(db);
    const interaction = await service.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", title: "Two questions",
      payload: { version: 1, title: "Two questions", submitLabel: "Continue", questions: ["first", "second"].map(id => ({
        id, prompt: id, selectionMode: "single" as const, required: true, allowOther: false,
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] })) },
    }, { agentId: f.agentId });
    const actions = await db.select().from(tables.chatActions);
    const open = actions.find(a => a.kind === "question_form_open"), submit = actions.find(a => a.kind === "question_form_submit");
    expect(open).toMatchObject({ conversationId: conversation.id, status: "issued", result: null });
    expect(submit).toMatchObject({ status: "issued", result: null });
    expect(await blocked("chat_actions")).toBe(true);
    await service.answerQuestions({ id: f.issueId, companyId: f.companyId }, interaction.id,
      { answers: ["first", "second"].map(questionId => ({ questionId, optionIds: ["yes"] })) }, { userId: "local-board" }, {
        afterResolveInTransaction: async (tx, resolved) => {
          expect(await claimChatQuestionFormSubmission(tx, { actionRowId: submit!.id, principalId: principal.id })).toBe(true);
          expect(await completeChatQuestionFormSubmission(tx, { actionRowId: submit!.id, interactionId: resolved.id })).toBe(true);
        },
      });
    expect((await db.select().from(tables.issueThreadInteractions).where(eq(tables.issueThreadInteractions.id, interaction.id)))[0])
      .toMatchObject({ status: "answered", resolvedAt: expect.any(Date) });
    expect(await blocked("chat_actions")).toBe(false);
    await db.update(tables.chatActions).set({ result: { code: "question_form_answered", interactionId: randomUUID() } })
      .where(eq(tables.chatActions.id, submit!.id));
    expect(await blocked("chat_actions")).toBe(true);
  });

  it("retires a staged inbound wake only after its actual delivery owner rejects it", async () => {
    const { githubIngressFixture } = await import("./helpers/github-webhook-ingress.js");
    const { createInboundWakeups } = await import("../services/chat-channels/inbound/wakeups.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const f = await githubIngressFixture(db);
    const [issue] = await db.insert(tables.issues).values({ companyId: f.companyId, title: "Rejected input" }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      issueId: issue.id, externalConversationId: "rejected", externalThreadId: "rejected", externalLabel: "Rejected" }).returning();
    const [principal] = await db.insert(tables.chatExternalPrincipals).values({ companyId: f.companyId, provider: "github",
      providerAccountId: "test", externalId: "42" }).returning();
    const [comment] = await db.insert(tables.issueComments).values({ companyId: f.companyId, issueId: issue.id, body: "Input" }).returning();
    const providerEventId = randomUUID();
    const [delivery] = await db.insert(tables.chatDeliveries).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      conversationId: conversation.id, providerEventId, deduplicationKey: randomUUID(), eventKind: "message", state: "received",
      normalizedEvent: { providerEventId, kind: "message" } }).returning();
    const unused = async (): Promise<never> => { throw new Error("No provider/admission boundary expected"); };
    const wakes = createInboundWakeups(db, { authorizeInboundWakeup: unused, authorizeInboundWorkStart: unused,
      attachmentOmissionDetail: () => null, isExternalActionAuthorizationChange: () => false, redactError: String,
      fetchImpl: unused, heartbeat: { wakeup: unused } });
    const service = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
    try {
      await db.transaction(tx => wakes.stageInboundWakeup(tx, { endpoint: f.endpoint, deliveryId: delivery.id,
        conversation, commentId: comment.id, principalId: principal.id, actorUserId: null }));
      expect(await blocked("chat_actions")).toBe(true);
      await wakes.settleRejectedInboundWakeups(delivery.id);
      expect((await db.select().from(tables.chatActions))[0].status).toBe("preparing");
      await service.configure(f.endpoint.id, { action: "pause" }, "local-board");
      await wakes.settleRejectedInboundWakeups(delivery.id);
      expect((await db.select().from(tables.chatActions))[0]).toMatchObject({ status: "failed",
        result: { code: "inbound_wakeup_delivery_rejected" } });
      expect(await db.select().from(tables.agentWakeupRequests)).toHaveLength(0);
      expect(await blocked("chat_actions")).toBe(false);
      expect(await blocked("chat_deliveries")).toBe(false);
      await db.update(tables.chatDeliveries).set({ nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(tables.chatDeliveries.id, delivery.id));
      expect(await blocked("chat_actions")).toBe(true);
    } finally { wakes.unregisterDeferredWakeOwner(); await service.shutdown(); }
  });

  it("retires actual Teams consent and provider-effect receipts only after the transfer closes", async () => {
    const { teamsFileTransferService } = await import("../services/chat-teams-file-transfers.js");
    const { projectTeamsFilePublication } = await import("../services/chat-teams-file-publication.js");
    const { installTeamsFileConsentHook, restoreTeamsFileConsentBinding } = await import("../services/chat-teams-file-consent.js");
    const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    try {
      const f = await seed(), c = await connection(f), bytes = Buffer.from("Actual Teams transfer");
      const authority = { companyId: f.companyId, endpointId: randomUUID(), conversationId: randomUUID(), issueId: f.issueId,
        publicationId: randomUUID(), commentId: randomUUID(), attachmentId: randomUUID(), principalId: randomUUID(),
        authorizedUserId: "local-board", runtimeGeneration: 3, credentialFingerprint: "c".repeat(64), conversationGeneration: 2,
        sourceDigest: "d".repeat(64), tenantId: randomUUID(), botAppId: randomUUID(), aadObjectId: randomUUID(),
        providerConversationId: "a:exact-personal", providerUserId: "29:exact-recipient",
        sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, filename: "file.txt" };
      await db.insert(tables.chatEndpoints).values({ id: authority.endpointId, companyId: f.companyId, connectionId: c.connectionId,
        assignedAgentId: f.agentId, publicId: randomUUID(), provider: "microsoft-teams", status: "active",
        providerAccountId: authority.tenantId, botExternalId: authority.botAppId });
      await db.insert(tables.chatConversations).values({ id: authority.conversationId, companyId: f.companyId,
        endpointId: authority.endpointId, issueId: f.issueId, externalConversationId: authority.providerConversationId,
        externalThreadId: `teams:${Buffer.from(authority.providerConversationId).toString("base64url")}`, externalLabel: "Personal",
        isDirectMessage: true, sessionGeneration: 2 });
      await db.insert(tables.chatExternalPrincipals).values({ id: authority.principalId, companyId: f.companyId, provider: "microsoft-teams",
        providerAccountId: authority.tenantId, externalId: authority.aadObjectId });
      await db.insert(tables.issueComments).values({ id: authority.commentId, companyId: f.companyId, issueId: f.issueId,
        authorUserId: "local-board", body: "Share this file" });
      const [asset] = await db.insert(tables.assets).values({ companyId: f.companyId, provider: "local_disk", objectKey: randomUUID(),
        contentType: "text/plain", byteSize: bytes.length, sha256: authority.sha256, originalFilename: authority.filename }).returning();
      await db.insert(tables.issueAttachments).values({ id: authority.attachmentId, companyId: f.companyId, issueId: f.issueId,
        assetId: asset.id, issueCommentId: authority.commentId });
      await db.insert(tables.chatPublications).values({ id: authority.publicationId, companyId: f.companyId,
        endpointId: authority.endpointId, conversationId: authority.conversationId, issueId: f.issueId, commentId: authority.commentId,
        idempotencyKey: randomUUID(), payload: { text: "Share file", attachmentIds: [authority.attachmentId] } });
      const service = teamsFileTransferService(db, { authorize: async () => ({ ...authority }), loadBytes: async () => bytes,
        postConsent: async () => ({ id: "card-1" }), postFileInfo: async () => ({ id: "file-info-1" }),
        uploadRequest: async () => Response.json({ id: "item-1", name: "file.txt", size: bytes.length }, { status: 201 }),
        project: projectTeamsFilePublication });
      const created = await service.issue(authority, new Date(Date.now() + 60_000));
      await service.process(f.companyId, created.id);
      const [pending] = await db.select().from(tables.chatTeamsFileTransfers);
      expect(pending.phase).toBe("awaiting_consent");
      expect((await db.select().from(tables.chatActions)).map(a => a.kind)).toContain("teams_file_effect_intent");
      expect(await blocked("chat_actions")).toBe(true);
      const binding = await restoreTeamsFileConsentBinding({ companyId: f.companyId, endpointId: authority.endpointId,
        transferId: created.id, authorityDigest: pending.authorityDigest }, pending.privateState.binding as Record<string, unknown>);
      const handlers = new Map<string, (context: { activity: unknown }) => Promise<{ status: number }>>();
      installTeamsFileConsentHook({ on: (name, callback) => { handlers.set(name, callback); } }, {
        companyId: f.companyId, endpointId: authority.endpointId, tenantId: authority.tenantId, botAppId: authority.botAppId,
        onConsent: event => service.recordConsent(event) });
      expect((await handlers.get("file.consent.decline")!({ activity: { type: "invoke", name: "fileConsent/invoke", channelId: "msteams",
        id: "decline-1", from: { id: authority.providerUserId, aadObjectId: authority.aadObjectId },
        recipient: { id: `28:${authority.botAppId}` }, conversation: { id: authority.providerConversationId, conversationType: "personal", tenantId: authority.tenantId },
        replyToId: "card-1", value: { action: "decline", context: { schema: binding.schema, token: binding.token, action: "decline" } } } })).status).toBe(200);
      expect((await db.select().from(tables.chatTeamsFileTransfers))[0]).toMatchObject({ phase: "declined", attemptId: null, attemptExpiresAt: null });
      expect((await db.select().from(tables.chatActions)).map(a => a.kind)).toEqual(expect.arrayContaining(["teams_file_effect_intent", "teams_file_consent"]));
      expect(await blocked("chat_actions")).toBe(false);
      expect(await blocked("chat_publications")).toBe(false);
      const [receipt] = await db.select().from(tables.chatActions).where(eq(tables.chatActions.kind, "teams_file_consent"));
      await db.update(tables.chatActions).set({ payload: { ...receipt.payload, receiptDigest: "wrong" } }).where(eq(tables.chatActions.id, receipt.id));
      expect(await blocked("chat_actions")).toBe(true);
    } finally { if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = oldKey; }
  });

  it("measures both chat predicates against 10000 valid retained deliveries and 30000 completed actions", async () => {
    const { githubIngressFixture } = await import("./helpers/github-webhook-ingress.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const f = await githubIngressFixture(db, undefined, 256), providerEventId = randomUUID();
    const [delivery] = await db.insert(tables.chatDeliveries).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      providerEventId, deduplicationKey: randomUUID(), eventKind: "message", state: "received",
      normalizedEvent: { providerEventId, kind: "message" } }).returning();
    const action = await f.insertAction({ deliveryId: delivery.id });
    await f.service.processGitHubWebhookIngress(action.id);
    const unused = async (): Promise<never> => { throw new Error("No external boundary expected"); };
    const service = chatChannelService(db, { heartbeat: { wakeup: unused }, fetch: unused });
    try { await service.configure(f.endpoint.id, { action: "pause" }, "local-board"); }
    finally { await service.shutdown(); }
    expect(await blocked("chat_deliveries")).toBe(false);
    expect(await blocked("chat_actions")).toBe(false);
    // Retention load clones a receipt produced above; it is measurement data,
    // not a substitute for the producer regressions in the surrounding cases.
    await db.execute(sql`INSERT INTO chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key, event_kind,
      state, normalized_event, processed_at)
      SELECT ${f.companyId}::uuid, ${f.endpoint.id}::uuid, 'retained:' || n, 'retained:' || n, d.event_kind, d.state,
        jsonb_set(d.normalized_event, '{providerEventId}', to_jsonb('retained:' || n)), d.processed_at
      FROM chat_deliveries d CROSS JOIN generate_series(1, 9999) n WHERE d.id = ${delivery.id}::uuid`);
    await db.execute(sql`INSERT INTO chat_actions (company_id, endpoint_id, delivery_id, kind, provider_action_id, payload, status, result)
      SELECT a.company_id, a.endpoint_id, d.id, a.kind, 'retained:' || d.id || ':' || n, a.payload, a.status, a.result
      FROM chat_actions a JOIN chat_deliveries d ON d.endpoint_id = a.endpoint_id CROSS JOIN generate_series(1, 3) n
      WHERE a.id = ${action.id}::uuid AND d.id <> ${delivery.id}::uuid`);
    await db.execute(sql`ANALYZE chat_deliveries`);
    await db.execute(sql`ANALYZE chat_actions`);
    const current = completedHistoryChecks.filter(c => ["chat_deliveries", "chat_actions"].includes(c.reason));
    const baselinePath = process.env.PAPERCLIP_HISTORY_QUERY_BASELINE_PATH;
    const baseline: { reason: string; query: string }[] = baselinePath ? JSON.parse(await readFile(baselinePath, "utf8")) : [];
    const measurements = [];
    for (const [revision, checks] of [["published_aaf55692", baseline], ["repair", current]] as const) {
      for (const check of checks) {
        const started = performance.now();
        const plan = await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          return tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT EXISTS (${sql.raw(check.query)}) AS blocked`);
        });
        measurements.push({ revision, reason: check.reason, wallMs: performance.now() - started, plan });
      }
    }
    const evidence = { deliveries: 10000, actions: 29998, measurements };
    if (process.env.PAPERCLIP_HISTORY_QUERY_PLANS_PATH) await writeFile(process.env.PAPERCLIP_HISTORY_QUERY_PLANS_PATH,
      JSON.stringify(evidence, null, 2));
    console.info(`Retained chat history query plans ${JSON.stringify(evidence)}`);
    expect(await blocked("chat_deliveries")).toBe(false);
    expect(await blocked("chat_actions")).toBe(false);
  }, 60_000);

  it("uses actual chat ingress, lifecycle application and operator publication receipts", async () => {
    const { githubIngressFixture } = await import("./helpers/github-webhook-ingress.js");
    const { chatCredentialMutationLease } = await import("../services/chat-credential-mutation-lease.js");
    const { createChatResourceReconciliation } = await import("../services/chat-channels/resource-reconciliation.js");
    const { chatChannelService } = await import("../services/chat-channels.js");
    const { projectSafeChatPublication } = await import("../services/chat-publication-projection.js");
    const f = await githubIngressFixture(db), action = await f.insertAction();
    expect(await blocked("chat_actions")).toBe(true);
    await f.service.processGitHubWebhookIngress(action.id);
    expect(f.calls).toHaveLength(1);
    expect(await blocked("chat_actions")).toBe(false);
    const [issue] = await db.insert(tables.issues).values({ companyId: f.companyId, title: "Chat delivery", status: "done" }).returning();
    const [conversation] = await db.insert(tables.chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      issueId: issue.id, externalConversationId: "fixture", externalThreadId: "fixture", externalLabel: "History", state: "completed" }).returning();
    const effect = { kind: "resource" as const, provider: "github" as const, providerEventId: randomUUID(), providerResourceId: "repository:fixture",
      resourceType: "repository", label: "Fixture", availability: "removed" as const };
    const [delivery] = await db.insert(tables.chatDeliveries).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      providerEventId: `lifecycle:${effect.providerEventId}`, deduplicationKey: randomUUID(), eventKind: "uninstallation", state: "processing", attempts: 1,
      normalizedEvent: { providerEventId: `lifecycle:${effect.providerEventId}`, kind: "uninstallation", lifecycle: effect } }).returning();
    expect(await blocked("chat_deliveries")).toBe(true);
    const lease = chatCredentialMutationLease(db);
    const resources = createChatResourceReconciliation(db, { endpointRecord: async () => ({ endpoint: f.endpoint }),
      withCredentialMutationLease: lease, runtimeGeneration: () => 1, maxErrorText: 500 });
    await lease(f.endpoint, guard => resources.applyProviderAvailability({ currentEndpoint: f.endpoint, effect,
      credentialLease: guard, staleResourceEffect: false, claimed: delivery, candidate: { attempts: 0 } }));
    expect(await blocked("chat_deliveries")).toBe(false);
    const firstAction = await f.insertAction({ deliveryId: delivery.id });
    expect(await blocked("chat_deliveries")).toBe(true);
    await f.service.processGitHubWebhookIngress(firstAction.id);
    expect(await blocked("chat_deliveries")).toBe(false);
    const secondAction = await f.insertAction({ deliveryId: delivery.id });
    expect(await blocked("chat_deliveries")).toBe(true); // one completed sibling cannot hide another pending action
    await f.service.processGitHubWebhookIngress(secondAction.id);
    expect(await blocked("chat_deliveries")).toBe(false);
    await db.update(tables.chatDeliveries).set({ eventKind: "message",
      normalizedEvent: { providerEventId: delivery.providerEventId, kind: "message" } }).where(eq(tables.chatDeliveries.id, delivery.id));
    expect(await blocked("chat_deliveries")).toBe(true); // ordinary input requires its own consumed wake, not arbitrary completed actions
    await db.update(tables.chatDeliveries).set({ eventKind: "uninstallation", normalizedEvent: {} }).where(eq(tables.chatDeliveries.id, delivery.id));
    expect(await blocked("chat_deliveries")).toBe(true);
    const [publication] = await db.insert(tables.chatPublications).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: conversation.id,
      issueId: issue.id, idempotencyKey: randomUUID(), state: "delivery_unknown",
      payload: projectSafeChatPublication({ classification: "external", source: "explicit_board_send", text: "Retained result" }) }).returning();
    expect(await blocked("chat_publications")).toBe(true);
    const service = chatChannelService(db, { heartbeat: { wakeup: async () => { throw new Error("No turn expected"); } },
      fetch: async () => { throw new Error("No external network expected"); } });
    try {
      await service.resolvePublication(f.endpoint.id, publication.id, "mark_delivered", "local-board");
      expect(await blocked("chat_publications")).toBe(false);
      await db.update(tables.chatPublications).set({ publishedAt: null }).where(eq(tables.chatPublications.id, publication.id));
      expect(await blocked("chat_publications")).toBe(true);
    } finally { await service.shutdown(); }
  });

  it("retains a real acknowledged chat completion across later task versions", async () => {
    const { issueService } = await import("../services/issues.js");
    const { prepareChatCompletionTurn } = await import("../services/chat-completion-delivery.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const f = await seed(), service = issueService(db);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.update(tables.issues).set({ status: "in_progress", conversationAgentId: f.agentId,
      conversationUserId: "local-board", conversationState: "waiting" }).where(eq(tables.issues.id, f.issueId));
    await db.update(tables.heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 } }).where(eq(tables.heartbeatRuns.id, f.runId));
    const task = await service.create(f.companyId, { title: "Actual handoff", status: "todo", createdByAgentId: f.agentId, actorRunId: f.runId });
    await service.update(task.id, { status: "done" });
    expect(await blocked("chat_completion_deliveries")).toBe(true);
    const [turn] = await db.insert(tables.heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      contextSnapshot: { issueId: f.issueId, wakeReason: "chat_task_completed", conversationSessionGeneration: 0 } }).returning();
    await prepareChatCompletionTurn(db, turn);
    const reply = await service.addComment(f.issueId, "The result is ready.", { agentId: f.agentId, runId: turn.id }, { completionReply: true });
    expect(await blocked("chat_completion_deliveries")).toBe(true); // actual reply run still owns work
    await db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(tables.heartbeatRuns.id, turn.id));
    expect(await blocked("chat_completion_deliveries")).toBe(false);
    await service.update(task.id, { status: "todo" });
    expect(await blocked("chat_completion_deliveries")).toBe(false); // retained delivered version remains history
    await db.update(tables.issueComments).set({ createdByRunId: f.runId }).where(eq(tables.issueComments.id, reply.id));
    expect(await blocked("chat_completion_deliveries")).toBe(true);
  });

  it("uses the real browser accounting and verified provider stop writers", async () => {
    const { toolAccessService } = await import("../services/tool-access.js");
    const { browserUseService } = await import("../services/browser-use.js");
    const f = await seed(), userId = "browser-history-reviewer", providerRun = randomUUID(), providerSession = randomUUID(), providerBrowser = randomUUID();
    const oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    let providerStatus = "running", stopped = false, stopCalls = 0;
    const request = async (url: string, init: RequestInit = {}) => {
      const route = new URL(url).pathname.replace("/api/v4", "");
      if (route === "/profiles") return Response.json({ items: [], totalItems: 0 });
      if (route === "/runs" && init.method === "POST") return Response.json({ id: providerRun, sessionId: providerSession, status: providerStatus, model: "fixture" });
      if (route.endsWith("/status")) return Response.json({ status: providerStatus });
      if (route.endsWith("/events")) return Response.json({ events: [], nextAfter: 0, hasMore: false });
      if (route.endsWith("/cancel")) { providerStatus = "cancelled"; return Response.json({}); }
      if (route === `/runs/${providerRun}`) return Response.json({ status: providerStatus, totalCostUsd: "0.15", model: "fixture", result: "Finished" });
      if (route === "/browsers") return Response.json({ items: [{ id: providerBrowser, status: stopped ? "stopped" : "active" }], totalItems: 1 });
      if (route === `/browsers/${providerBrowser}`) {
        if (init.method === "PATCH") { stopped = true; stopCalls++; }
        return Response.json({ id: providerBrowser, agentSessionId: providerSession, status: stopped ? "stopped" : "active" });
      }
      throw new Error(`Unexpected browser provider route ${route}`);
    };
    try {
      await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
      const access = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      const actor = { actorType: "user" as const, actorId: userId };
      const connected = await access.connectGalleryApp(f.companyId, { galleryKey: "browser-use-cloud", connectionMethodKey: "cloud-v4",
        credentialValues: { "credentials.apiKey": "bu_fixture_secret" } }, actor);
      await access.finishGalleryAppConnection(f.companyId, connected.connectionId, { enabledCatalogEntryIds: connected.catalog.map(entry => entry.id),
        askFirstCatalogEntryIds: [], access: { agentIds: [f.agentId] } }, actor);
      const [grant] = await db.select().from(tables.connectionGrants).where(eq(tables.connectionGrants.connectionId, connected.connectionId));
      await db.update(tables.heartbeatRuns).set({ status: "running", finishedAt: null, responsibleUserId: userId }).where(eq(tables.heartbeatRuns.id, f.runId));
      await db.update(tables.issues).set({ status: "in_progress" }).where(eq(tables.issues.id, f.issueId));
      const service = browserUseService(db, request);
      const started = await service.execute({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId }, grant,
        randomUUID(), "browser_start", { task: "Read the retained fixture", maxCostUsd: 1 }) as { sessionId: string };
      for (const reason of ["browser_use_sessions", "browser_use_runs"]) expect(await blocked(reason)).toBe(true);
      providerStatus = "completed";
      await db.update(tables.browserUseSessions).set({ nextPollAt: new Date(0) }).where(eq(tables.browserUseSessions.id, started.sessionId));
      await service.sweep(connected.connectionId);
      expect(await blocked("browser_use_browsers")).toBe(true);
      const [session] = await db.select().from(tables.browserUseSessions).where(eq(tables.browserUseSessions.id, started.sessionId));
      await service.control(session, "end");
      await db.update(tables.browserUseSessions).set({ nextPollAt: new Date(0) }).where(eq(tables.browserUseSessions.id, started.sessionId));
      await service.sweep(connected.connectionId);
      expect(stopCalls).toBeGreaterThan(0);
      await db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(tables.heartbeatRuns.id, f.runId));
      for (const reason of ["browser_use_sessions", "browser_use_runs", "browser_use_browsers"]) expect(await blocked(reason), reason).toBe(false);
      const [run] = await db.select().from(tables.browserUseRuns).where(eq(tables.browserUseRuns.sessionId, started.sessionId));
      expect((run.result as { paperclipBudgetHold?: unknown } | null)?.paperclipBudgetHold).toMatchObject({ state: "settled", accountedCentsExact: "15.0000000" });
      await db.update(tables.browserUseRuns).set({ eventsDrained: 0 }).where(eq(tables.browserUseRuns.id, run.id));
      expect(await blocked("browser_use_runs")).toBe(true);
    } finally {
      if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = oldKey;
    }
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

  it("uses actual secret and binding approval receipts, including ciphertext scrubbing", async () => {
    const { createSecretProposalsService } = await import("../services/secret-proposals.js");
    const f = await seed(), p = await mcp(f), oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    try {
      await db.update(tables.heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(tables.heartbeatRuns.id, f.runId));
      await db.update(tables.issues).set({ status: "in_progress", executionRunId: f.runId }).where(eq(tables.issues.id, f.issueId));
      const service = createSecretProposalsService(db);
      const context = { companyId: f.companyId, heartbeatRunId: f.runId, registerForRedaction: () => {} };
      const secret = await service.createSecret(context, { name: "history/token", key: "HISTORY_TOKEN", value: "synthetic-history-secret", justification: "Retained completed approval" });
      expect(await blocked("company_secret_proposals")).toBe(true);
      const approved = await service.approve(f.companyId, secret.id, { resolvedByUserId: p.userId });
      const binding = await service.createBinding(context, { secretId: approved.createdSecretId!, configPath: "env.HISTORY_TOKEN",
        bindingTargetPolicy: "self_and_reports", justification: "Use the approved credential" });
      await service.approve(f.companyId, binding.id, { resolvedByUserId: p.userId });
      await db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(tables.heartbeatRuns.id, f.runId));
      expect(await blocked("company_secret_proposals")).toBe(false);
      await db.update(tables.companySecretProposals).set({ appliedBindingConfigPath: null }).where(eq(tables.companySecretProposals.id, binding.id));
      expect(await blocked("company_secret_proposals")).toBe(true);
    } finally { if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = oldKey; }
  });

  it("uses actual retention archive notification dispatch and durable acknowledgment", async () => {
    const { decisionRetentionService } = await import("../services/decision-retention.js");
    const { decisionArchiveDeliveryService } = await import("../services/decision-archive-delivery.js");
    const f = await seed(), activityAt = new Date("2026-01-01T00:00:00.000Z");
    await db.update(tables.agents).set({ status: "active" }).where(eq(tables.agents.id, f.agentId));
    await db.update(tables.issues).set({ createdByAgentId: f.agentId }).where(eq(tables.issues.id, f.issueId));
    await db.insert(tables.decisionRetention).values({ companyId: f.companyId, sourceKind: "review", sourceId: f.issueId, sourceActivityAt: activityAt, version: 1 });
    expect(await decisionRetentionService(db).autoArchive({ companyId: f.companyId, items: [{ sourceKind: "review", subject: { id: f.issueId },
      activityAt: activityAt.toISOString(), retentionVersion: 1, keep: false, archivedAt: null }], now })).toBe(1);
    expect(await blocked("decision_archive_notification_outbox")).toBe(true);
    let notifications = 0;
    expect(await decisionArchiveDeliveryService(db, { notifyOriginAgent: async batch => {
      expect(batch).toMatchObject({ companyId: f.companyId, agentId: f.agentId, items: [{ sourceId: f.issueId }] }); notifications++;
    } }).deliver()).toMatchObject({ delivered: 1 });
    expect(notifications).toBe(1);
    expect(await blocked("decision_archive_notification_outbox")).toBe(false);
    await db.update(tables.decisionArchiveNotificationOutbox).set({ deliveredAt: null });
    expect(await blocked("decision_archive_notification_outbox")).toBe(true);
  });

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

  it.each(["missing_decider", "missing_option"] as const)("requires the actual %s recovery stop receipt after partial effects", async reason => {
    const previous = process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    try {
      const f = await decisionFixture();
      const decision = await f.service.create({ companyId: f.companyId, actor: f.actor, agentId: f.agentId, runId: f.runId,
        title: "Recover interrupted effect ownership", body: reason, continuationPolicy: "none", options: [{ id: "yes", label: "Yes",
          effects: [{ type: "comment_on_issue", targetIssueId: f.issueId, staleness: "lenient", bodyMarkdown: "Already persisted effect" }] }] });
      await f.service.decide({ id: decision.id, optionId: "yes", decidedByUserId: f.userId, userActor: f.userActor });
      // Model a stranded claim whose durable option/decider was lost after an
      // already-written effect. Recovery must record its own final stop.
      await db.update(tables.decisions).set({ executionStatus: "running", updatedAt: new Date(Date.now() - 120_000),
        ...(reason === "missing_decider" ? { decidedByUserId: null } : { chosenOptionId: "missing" }) }).where(eq(tables.decisions.id, decision.id));
      expect(await blocked("decisions")).toBe(true);
      expect(await f.service.recoverEffects()).toEqual({ resumed: 1 });
      await f.finish();
      expect(await f.service.get(decision.id)).toMatchObject({ executionStatus: "partial", metadata: { effectRecoveryError: reason } });
      expect(await blocked("decisions")).toBe(false);
      await db.delete(tables.activityLog).where(sql`${tables.activityLog.entityId} = ${decision.id} AND ${tables.activityLog.action} = 'decision.recovery_failed'`);
      expect(await blocked("decisions")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET; else process.env.PAPERCLIP_DECISION_SIGNING_SECRET = previous;
    }
  });

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
        outcome: command.action === "consume_input" ? { status: "consumed", ...command.input }
          : { status: command.action === "accept" ? "accepted" : "completed" } } });
    });
    try {
      await port.dispatch({ sourceEventId: `offer_${randomUUID()}`, payload: { kind: "assignment", binding: ref, tools: [],
        acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 3_600_000 } });
      const [assignment] = await db.select().from(tables.museRunnerAssignments).where(eq(tables.museRunnerAssignments.runId, f.runId));
      expect(await blocked("muse_runner_assignments")).toBe(true);
      await broker.act(subject, { version: 1, command: "accept", assignmentId: assignment.id, requestId: randomUUID() });
      const { digestPaperclipSemanticContent } = await import("../vendor/paperclip-runner/index.js");
      const nativeRequestId = "history_question", response = { schema: "paperclip.question_response.v1", answers: [] };
      const inputDigest = digestPaperclipSemanticContent({ requestId: nativeRequestId, turnId, response });
      await port.inputAvailable({ sourceEventId: randomUUID(), payload: { binding: ref, requestId: nativeRequestId, turnId, inputDigest, response } });
      expect(await blocked("muse_input_deliveries")).toBe(true);
      await broker.act(subject, { version: 1, command: "consume_input", assignmentId: assignment.id, requestId: randomUUID(),
        nativeRequestId, inputDigest, continuationReceiptId: randomUUID(), continuationPersisted: true });
      await broker.act(subject, { version: 1, command: "finish", assignmentId: assignment.id, requestId: randomUUID(), result: {} });
      expect(await blocked("muse_runner_assignments")).toBe(true);
      const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: () => {} } as unknown as
        import("../services/heartbeat/run-lifecycle.js").HeartbeatLifecycleDependencies);
      await lifecycle.setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
      await broker.reconcileTerminalAssignments(f.companyId, f.agentId, binding.id);
      for (const family of ["muse_runner_assignments", "muse_runner_operations", "muse_mailbox_items", "muse_input_deliveries", "external_agent_holds"]) {
        expect(await blocked(family), family).toBe(false);
      }
      await db.update(tables.museRunnerOperations).set({ status: "unknown" }).where(eq(tables.museRunnerOperations.assignmentId, assignment.id));
      expect(await blocked("muse_runner_assignments")).toBe(true);
      expect(await blocked("muse_runner_operations")).toBe(true);
      await db.update(tables.museRunnerOperations).set({ status: "settled" }).where(eq(tables.museRunnerOperations.assignmentId, assignment.id));
      expect(await blocked("muse_agent_bindings")).toBe(true);
      expect(await blocked("muse_credentials")).toBe(true);
      await broker.revoke(f.companyId, f.agentId, p.userId);
      expect(await blocked("muse_agent_bindings")).toBe(false);
      expect(await blocked("muse_credentials")).toBe(true); // cleanup authority still lives for its owner TTL
      await db.update(tables.museCredentials).set({ expiresAt: new Date(0) }).where(eq(tables.museCredentials.bindingId, binding.id));
      expect(await blocked("muse_credentials")).toBe(false);
    } finally { await detach(); }
  }, 60_000);

  it("settles actual Dot runner assignments, operation receipts and mailbox history", async () => {
    const { dotRunnerBroker } = await import("../services/dot-runner-broker.js");
    const { instanceSettingsService } = await import("../services/instance-settings.js");
    const { createHeartbeatLifecycle } = await import("../services/heartbeat/run-lifecycle.js");
    const f = await seed(), p = await mcp(f, true), sessionId = randomUUID(), turnId = `turn_${randomUUID()}`;
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true });
    await db.insert(tables.companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: p.userId, membershipRole: "owner", status: "active" });
    await db.update(tables.mcpOauthGrants).set({ revokedAt: null }).where(eq(tables.mcpOauthGrants.id, p.grantId));
    const [grant] = await db.select().from(tables.mcpOauthGrants).where(eq(tables.mcpOauthGrants.id, p.grantId));
    const [binding] = await db.insert(tables.dotAgentBindings).values({ companyId: f.companyId, agentId: f.agentId, operatorId: p.userId,
      grantId: p.grantId, providerKind: "openai_dot", status: "connected" }).returning();
    await db.update(tables.agents).set({ status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "openai_dot", dotBindingId: binding.id, allowUnmeteredProvider: true } }).where(eq(tables.agents.id, f.agentId));
    await db.update(tables.issues).set({ status: "in_progress", responsibleUserId: p.userId, checkoutRunId: f.runId, executionRunId: f.runId }).where(eq(tables.issues.id, f.issueId));
    await db.update(tables.heartbeatRuns).set({ status: "running", runtimeMode: "native", driverKind: "openai_dot_mcp", finishedAt: null,
      nativeIssueId: f.issueId, nativeSessionId: sessionId, nativePhase: "turn_running", responsibleUserId: p.userId }).where(eq(tables.heartbeatRuns.id, f.runId));
    await db.insert(tables.nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "running", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 600_000) });
    const broker = dotRunnerBroker(db, { heartbeat: { wakeup: async () => null, cancelRun: async () => null } });
    const { createPublicMcpOAuth } = await import("../services/public-mcp/oauth.js");
    const { createPublicMcpEvents } = await import("../services/public-mcp/events.js");
    const principal = { grant, actor: { type: "agent" as const, agentId: f.agentId, companyId: f.companyId },
      company: { id: f.companyId, name: "History", issuePrefix: "H", status: "active" } };
    const events = createPublicMcpEvents(db, createPublicMcpOAuth(db, { origin: "https://example.test", resource: "https://example.test/mcp" }, { mode: "openai_dot_agent" }),
      async () => { throw new Error("No personal API expected"); }, { enableDotRunner: true, fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        return body.type === "verification" ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 204 });
      } });
    await events.subscribe(principal, { name: "paperclip.dot.mailbox_updated", arguments: { companyId: f.companyId, bindingId: binding.id },
      delivery: { mode: "webhook", url: "https://receiver.example/dot", secret: `whsec_${randomBytes(32).toString("base64")}` } });
    await events.tick();
    const challenge = (await broker.mailbox(principal)).items.find(item => item.kind === "readiness_challenge")!;
    await broker.confirmChallenge(principal, String(challenge.references.challenge));
    const execution = { binding: { companyId: f.companyId, agentId: f.agentId, runId: f.runId },
      provider: { kind: "openai_dot" as const, binding: await broker.snapshot(f.companyId, f.agentId, binding.id) } };
    const ref = { ...execution.provider.binding, runId: f.runId, normalizedSessionId: sessionId, turnId, assignmentRevision: 1 };
    const port = broker.port(execution);
    const detach = await port.attach(async command => {
      await port.settle({ sourceEventId: randomUUID(), payload: { binding: ref, requestId: command.requestId,
        outcome: { status: command.action === "accept" ? "accepted" : "completed" } } });
    });
    try {
      await port.dispatch({ sourceEventId: randomUUID(), payload: { kind: "assignment", binding: ref, tools: [],
        acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 3_600_000 } });
      const [assignment] = await db.select().from(tables.dotRunnerAssignments).where(eq(tables.dotRunnerAssignments.runId, f.runId));
      expect(await blocked("dot_runner_assignments")).toBe(true);
      expect(await blocked("dot_mailbox_items")).toBe(true);
      await broker.operation(principal, assignment.id, randomUUID(), "accept", {});
      await broker.operation(principal, assignment.id, randomUUID(), "finish", { result: {} });
      const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: () => {} } as unknown as
        import("../services/heartbeat/run-lifecycle.js").HeartbeatLifecycleDependencies);
      await lifecycle.setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
      for (const reason of ["dot_runner_assignments", "dot_runner_operations"]) expect(await blocked(reason), reason).toBe(false);
      // The independent readiness mailbox is retained until its binding is revoked.
      await broker.revoke(f.companyId, f.agentId, p.userId);
      expect(await blocked("dot_mailbox_items")).toBe(false);
      await db.update(tables.dotRunnerOperations).set({ status: "admitted", outcome: null }).where(eq(tables.dotRunnerOperations.assignmentId, assignment.id));
      expect(await blocked("dot_runner_assignments")).toBe(true);
      expect(await blocked("dot_runner_operations")).toBe(true);
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
      let port = 0;
      for (let attempt = 0; attempt < 32; attempt++) {
        const server = net.createServer();
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        port = (server.address() as net.AddressInfo).port;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (!isRuntimeExposureAppPort(port)) break;
      }
      expect(isRuntimeExposureAppPort(port)).toBe(false);
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
      let enterCleanup!: () => void, releaseCleanup!: () => void;
      const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
      const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
      const failedControl = Object.create(db) as typeof db;
      failedControl.select = (() => ({ from: () => ({ where: async () => {
        enterCleanup(); await cleanupGate; throw new Error("controlled stop cleanup failure");
      } }) })) as unknown as typeof db.select;
      const stopping = runtime.stopRuntimeServicesForExecutionWorkspace({ db: failedControl,
        executionWorkspaceId: workspace.id, workspaceCwd: directory });
      await cleanupEntered;
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("present");
      let releaseReconstruction!: () => void;
      const reconstructionGate = new Promise<void>(resolve => { releaseReconstruction = resolve; });
      const staleReconstruction = Object.create(db) as typeof db;
      let firstSelect = true;
      staleReconstruction.select = ((...fields: unknown[]) => {
        const query = Reflect.apply(db.select, db, fields);
        if (!firstSelect) return query;
        firstSelect = false;
        return { from: (...from: unknown[]) => {
          const selected = Reflect.apply(query.from, query, from) as { where: (...args: unknown[]) => unknown };
          return { where: (...where: unknown[]) => reconstructionGate.then(() => Reflect.apply(selected.where, selected, where)) };
        } };
      }) as typeof db.select;
      const earlierReconstruction = runtime.reconcilePersistedRuntimeServicesOnStartup(staleReconstruction);
      releaseCleanup();
      await expect(stopping).rejects.toThrow("controlled stop cleanup failure");
      releaseReconstruction();
      await earlierReconstruction;
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown"); // older successful flight cannot erase the failed control epoch
      await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      ownedProcess = null;
      expect(runtime.readWorkspaceRuntimeIdleWork()).toBe("unknown");
      await runtime.reconcilePersistedRuntimeServicesOnStartup(db);
      await runtime.stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: workspace.id, workspaceCwd: directory });
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
