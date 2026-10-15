import express from "express";
import request from "supertest";
import { grokBotRoutes } from "../routes/grok-bot.js";
import { publicMcpIngressRoutes } from "../routes/public-mcp.js";
import { createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import { createDotRunnerMcpTools } from "../services/dot-runner-broker.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, dotAgentBindings, grokBotDispatches,
  grokBotRoutines, mcpOauthGrants, activityLog, issues, heartbeatRuns, dotRunnerAssignments, dotRunnerOperations, dotMailboxItems, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { createGrokRoutineDispatcher } from "../services/grok-bot/dispatcher.js";
import { grokRoutineService } from "../services/grok-bot/routine.js";
import * as secretModule from "../services/secrets.js";
import * as externalAuthority from "../services/external-bot-authority.js";
import { type GrokRoutineWake } from "../services/grok-bot/webhook.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("paperclip-grok-routine-");
  db = createDb(temporary.connectionString);
  vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
  await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableNativeRunner: true, enableGrokBot: true, enableOpenAiDot: true });
}, 120000);
afterAll(async () => { try { await temporary?.cleanup(); } finally { vi.unstubAllEnvs(); } });

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Grok operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [company] = await db.insert(companies).values({ name: "Grok test", issuePrefix: "GK" + randomBytes(3).toString("hex") }).returning();
  await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await accessService(db).setPrincipalPermission(company!.id, "user", userId, "agents:create", true, userId);
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Grok test", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider: "grok_bot", allowUnmeteredProvider: true, lifecycleMode: "per_turn" } }).returning();
  const oauth = createPublicMcpOAuth(db, { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/runner" });
  const client = await oauth.register({ client_name: "Synthetic Grok client", redirect_uris: ["https://client.example/callback"] }, randomUUID());
  const verifier = randomBytes(32).toString("base64url");
  const input = { client_id: client.client_id, redirect_uri: "https://client.example/callback", response_type: "code", resource: oauth.config.resource,
    scope: "paperclip:agent offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
  const requestId = (await oauth.authorize(input)).split("/").at(-1)!;
  const pairing = await dotRunnerBroker(db).createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId, provider: "grok_bot" });
  const consent = await oauth.consentDotPairing(requestId, pairing.pairingCode);
  const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: input.redirect_uri,
    resource: oauth.config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
  const principal = await oauth.authenticate(tokens.access_token);
  const delivery = vi.fn().mockResolvedValue({ delivery: "accepted", httpStatus: 200 });
  const service = grokRoutineService(db, delivery);
  const config = { companyId: company!.id, agentId: agent!.id, bindingId: pairing.bindingId, operatorId: userId,
    expectedRevision: 0, botName: "Synthetic Bot", webhookUrl: "https://bot.example.test/routines/synthetic", webhookKey: "synthetic-sender-key" };
  await service.configure(config);
  return { company: company!, agent: agent!, principal, pairing, service, delivery, config, oauth, tokens };
}
async function verification(f: Awaited<ReturnType<typeof fixture>>, sourceEventId = randomUUID()) {
  return f.service.reserve({ companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId, sourceEventId, kind: "verify" });
}
function acknowledgement(row: Awaited<ReturnType<typeof verification>>) {
  const wake = row.payload as GrokRoutineWake & { challenge: string };
  return { correlationId: row.id, bindingId: row.bindingId, bindingGeneration: row.bindingGeneration, challenge: wake.challenge };
}

async function admittedWork(f: Awaited<ReturnType<typeof fixture>>, status: "offered" | "accepted") {
  const verified = await verification(f);
  await f.service.send(f.company.id, f.agent.id, verified.id);
  await f.service.acknowledge(f.principal, acknowledgement(verified));
  const sessionId = randomUUID();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
    status: "running", runtimeMode: "native", nativeSessionId: sessionId, invocationSource: "assignment", triggerDetail: "system" }).returning();
  const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Grok assignment",
    assigneeAgentId: f.agent.id, executionRunId: run!.id, checkoutRunId: run!.id, status: "in_progress" }).returning();
  await db.update(heartbeatRuns).set({ nativeIssueId: task!.id }).where(eq(heartbeatRuns.id, run!.id));
  await db.insert(nativeRunFinalizations).values({ runId: run!.id, companyId: f.company.id, issueId: task!.id,
    phase: "observed", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 60_000) });
  const [work] = await db.insert(dotRunnerAssignments).values({ companyId: f.company.id, agentId: f.agent.id,
    bindingId: f.pairing.bindingId, bindingGeneration: 1, runId: run!.id, normalizedSessionId: sessionId, turnId: randomUUID(),
    controllerGeneration: 1, catalogDigest: "test", status, projection: {},
    acceptBy: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 60_000) }).returning();
  return { run: run!, task: task!, work: work! };
}

async function acceptance(f: Awaited<ReturnType<typeof fixture>>, work: typeof dotRunnerAssignments.$inferSelect) {
  const requestId = randomUUID();
  await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: work.id, requestId,
    digest: "accept", command: { action: "accept" }, status: "admitted" });
  const binding = { companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId,
    bindingGeneration: 1, runId: work.runId, normalizedSessionId: work.normalizedSessionId,
    turnId: work.turnId, assignmentRevision: work.revision };
  const port = dotRunnerBroker(db).port({ binding, provider: { binding: { ...binding,
    acceptByUnixMs: work.acceptBy.getTime(), expiresAtUnixMs: work.expiresAt.getTime() } } });
  return () => port.settle({ sourceEventId: randomUUID(), payload: { requestId, binding, outcome: { status: "accepted" } } });
}

describe("durable Grok routine qualification", () => {
  it("receives an authenticated Grok acknowledgement through the actual MCP transport without exposing personal or Dot event tools", async () => {
    const f = await fixture(); const row = await verification(f);
    await f.service.send(f.company.id, f.agent.id, row.id);
    const app = express(); app.use(express.json());
    const dispatch = async () => { throw new Error("Personal dispatch forbidden"); };
    app.use(publicMcpIngressRoutes(f.oauth, createPublicMcpExecutor(db, f.oauth, dispatch), undefined, createDotRunnerMcpTools(db)));
    const invoke = (method: string, params: unknown) => request(app).post("/mcp/runner")
      .set("Authorization", `Bearer ${f.tokens.access_token}`).set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method, params });
    const list = await invoke("tools/list", {});
    expect(list.status).toBe(200);
    const names = list.body.result.tools.map((tool: {name: string}) => tool.name);
    expect(names).toContain("paperclip_grok_ack_wake");
    expect(names).not.toContain("paperclip_dot_confirm_event");
    expect(names).not.toContain("paperclip_call_api");
    const reply = await invoke("tools/call", { name: "paperclip_grok_ack_wake", arguments: acknowledgement(row) });
    expect(reply.status).toBe(200);
    expect(reply.body.result.structuredContent).toMatchObject({ outcome: "completed", result: { status: "acknowledged" } });
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: true });
  });

  it("rejects acknowledgement after the authorizing person loses permission to manage the agent", async () => {
    const f = await fixture(); const row = await verification(f);
    await f.service.send(f.company.id, f.agent.id, row.id);
    await accessService(db).setPrincipalPermission(f.company.id, "user", f.principal.grant.userId, "agents:create", false, f.principal.grant.userId);
    await expect(f.service.acknowledge(f.principal, acknowledgement(row))).rejects.toThrow("permission");
  });

  it("filters private current and queued tasks from the connection overview", async () => {
    const f = await fixture();
    const reader = randomUUID();
    await db.insert(authUsers).values({ id: reader, name: "Reader", email: `${reader}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: reader, membershipRole: "member", status: "active" });
    const [privateTask] = await db.insert(issues).values({ companyId: f.company.id, title: "Private strategy", visibility: "private", createdByUserId: f.principal.grant.userId, assigneeAgentId: f.agent.id, status: "todo" }).returning();
    await db.insert(issues).values({ companyId: f.company.id, title: "Visible task", assigneeAgentId: f.agent.id, status: "todo" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", invocationSource: "assignment", triggerDetail: "system", nativeIssueId: privateTask!.id }).returning();
    await db.insert(dotRunnerAssignments).values({ companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId, bindingGeneration: 1,
      runId: run!.id, normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "fixture", projection: {},
      status: "accepted", acceptBy: new Date(Date.now() + 60000), expiresAt: new Date(Date.now() + 60000) });
    const app = express(); app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: reader, companyIds: [f.company.id], memberships: [{ companyId: f.company.id, membershipRole: "member", status: "active" }] }; next(); });
    app.use("/api", grokBotRoutes(db, f.oauth.config.resource));
    const path = `/api/companies/${f.company.id}/agents/${f.agent.id}/grok-binding`;
    const hidden = await request(app).get(path).expect(200);
    expect(hidden.body).toMatchObject({ currentTask: null, queuedTaskCount: 1 });
    expect(JSON.stringify(hidden.body)).not.toContain("Private strategy");
    await db.update(issues).set({ responsibleUserId: reader }).where(eq(issues.id, privateTask!.id));
    const visible = await request(app).get(path).expect(200);
    expect(visible.body).toMatchObject({ currentTask: { id: privateTask!.id, title: "Private strategy" }, queuedTaskCount: 2 });
  });

  it.each(["dispatch", "work_session"] as const)("closes settled wake obligations without clearing a %s hold incorrectly", async reason => {
    const f = await fixture(); const verified = await verification(f);
    await f.service.send(f.company.id, f.agent.id, verified.id); await f.service.acknowledge(f.principal, acknowledgement(verified));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", invocationSource: "assignment", triggerDetail: "system" }).returning();
    const [work] = await db.insert(dotRunnerAssignments).values({ companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId, bindingGeneration: 1,
      runId: run!.id, normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "fixture", projection: {},
      status: "settled", acceptBy: new Date(), expiresAt: new Date(Date.now() - 1) }).returning();
    const wake = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId,
      assignmentId: work!.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    await db.update(grokBotDispatches).set({ status: "unknown", sentAt: new Date() }).where(eq(grokBotDispatches.id, wake.id));
    await db.update(grokBotRoutines).set({ recoveryRequiredAt: new Date(), recoveryReason: reason }).where(eq(grokBotRoutines.bindingId, f.pairing.bindingId));
    await db.transaction(tx => grokRoutineService(tx as unknown as typeof db).settleWorkNotifications(f.company.id, f.pairing.bindingId, work!.id));
    expect((await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.id, wake.id)))[0]!.status).toBe("cancelled");
    const ack = { correlationId: wake.id, bindingId: wake.bindingId, bindingGeneration: wake.bindingGeneration };
    expect(await f.service.acknowledge(f.principal, ack)).toMatchObject({ status: "acknowledged", remoteTerminationConfirmed: false });
    expect(await f.service.recoveryNeeded(f.company.id, f.agent.id)).toBe(reason === "work_session");
    await expect(dotRunnerBroker(db).operation(f.principal, work!.id, randomUUID(), "progress", { text: "late effect" })).rejects.toThrow("expired");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work!.id)))[0]!.status).toBe("settled");
    await db.update(dotRunnerAssignments).set({ status: "fenced" }).where(eq(dotRunnerAssignments.id, work!.id));
    await expect(f.service.acknowledge(f.principal, ack)).rejects.toThrow("revoked");
  });

  it("keeps HTTP delivery and authenticated reply separate, with auditable agent and authorizer", async () => {
    const f = await fixture();
    const row = await verification(f);
    await f.service.send(f.company.id, f.agent.id, row.id);
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: false, lastExchange: { status: "accepted", httpStatus: 200, acknowledgedAt: null } });
    expect((await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, row.bindingId)))[0]!.status).toBe("connected");
    await f.service.acknowledge(f.principal, acknowledgement(row));
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: true, recoveryNeeded: false, lastExchange: { status: "acknowledged" } });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id), eq(activityLog.action, "grok.wake_verified")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: f.agent.id, details: { authorizingPersonId: f.principal.grant.userId, correlationId: row.id } });
    expect(JSON.stringify(await f.service.state(f.company.id, f.agent.id, row.bindingId))).not.toContain("synthetic-sender-key");
  });

  it("reserves once across concurrent attempts and never resends accepted work after a new controller starts", async () => {
    const f = await fixture(), source = randomUUID();
    const rows = await Promise.all([1, 2, 3].map(() => verification(f, source)));
    expect(new Set(rows.map(r => r.id)).size).toBe(1);
    await Promise.all(rows.map(r => f.service.send(f.company.id, f.agent.id, r.id)));
    const restarted = grokRoutineService(db, f.delivery);
    await restarted.send(f.company.id, f.agent.id, rows[0]!.id);
    expect(f.delivery).toHaveBeenCalledTimes(1);
    await expect(verification(f)).rejects.toThrow("outstanding delivery");
  });

  it("reconciles a lost HTTP response with the same authenticated challenge without retrying", async () => {
    const f = await fixture(); f.delivery.mockResolvedValue({ delivery: "unknown", httpStatus: null });
    const row = await verification(f);
    await f.service.send(f.company.id, f.agent.id, row.id);
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ recoveryNeeded: true, verified: false });
    await f.service.acknowledge(f.principal, acknowledgement(row));
    await f.service.acknowledge(f.principal, acknowledgement(row));
    expect(f.delivery).toHaveBeenCalledTimes(1);
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ recoveryNeeded: false, verified: true });
  });

  it("does not downgrade an authenticated acknowledgement when an ambiguous transport response arrives later", async () => {
    const f = await fixture(); const row = await verification(f);
    f.delivery.mockImplementation(async () => { await f.service.acknowledge(f.principal, acknowledgement(row)); return { delivery: "unknown", httpStatus: 504 }; });
    await f.service.send(f.company.id, f.agent.id, row.id);
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ recoveryNeeded: false, verified: true, lastExchange: { status: "acknowledged" } });
  });

  it("keeps crashed sending intents in recovery and prevents credential replacement while delivery is uncertain", async () => {
    const f = await fixture(); const row = await verification(f);
    await db.update(grokBotDispatches).set({ status: "sending", sentAt: new Date(Date.now() - 60000), updatedAt: new Date(Date.now() - 60000) }).where(eq(grokBotDispatches.id, row.id));
    await f.service.send(f.company.id, f.agent.id, row.id);
    expect(f.delivery).not.toHaveBeenCalled();
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ recoveryNeeded: true });
    await expect(f.service.configure({ ...f.config, expectedRevision: 1 })).rejects.toThrow("recover");
  });

  it.each(["wrong nonce", "wrong binding", "wrong generation", "expired", "revoked", "personal grant", "other company"])("rejects %s without readiness or accepted late results", async condition => {
    const f = await fixture(); const other = await fixture(); const row = await verification(f);
    await f.service.send(f.company.id, f.agent.id, row.id);
    const ack = acknowledgement(row);
    let principal = f.principal;
    if (condition === "wrong nonce") ack.challenge = "a-different-nonce-long-enough";
    if (condition === "wrong binding") ack.bindingId = other.pairing.bindingId;
    if (condition === "wrong generation") ack.bindingGeneration++;
    if (condition === "expired") await db.update(grokBotDispatches).set({ expiresAt: new Date(0) }).where(eq(grokBotDispatches.id, row.id));
    if (condition === "revoked") await db.update(mcpOauthGrants).set({ revokedAt: new Date() }).where(eq(mcpOauthGrants.id, f.principal.grant.id));
    if (condition === "personal grant") principal = { ...f.principal, grant: { ...f.principal.grant, purpose: "personal" } };
    if (condition === "other company") principal = other.principal;
    await expect(f.service.acknowledge(principal, ack)).rejects.toThrow();
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: false });
  });

  it("stores URL and key together encrypted and rejects stale, foreign or unauthorized configuration", async () => {
    const f = await fixture();
    const [stored] = await db.select().from(grokBotRoutines).where(eq(grokBotRoutines.bindingId, f.pairing.bindingId));
    expect(JSON.stringify(stored)).not.toContain(f.config.webhookKey);
    await expect(f.service.configure({ ...f.config, expectedRevision: 0 })).rejects.toThrow("changed");
    await expect(f.service.configure({ ...f.config, expectedRevision: 1, operatorId: randomUUID() })).rejects.toThrow("permission");
    await expect(f.service.configure({ ...f.config, expectedRevision: 1, companyId: randomUUID() })).rejects.toThrow();
    await expect(f.service.configure({ ...f.config, expectedRevision: 1, webhookUrl: "https://user:password@bot.example.test/routine" })).rejects.toThrow("Invalid");
  });
  it("retries only confirmed rejection, retaining receipts and deduplicating concurrent operator retries", async () => {
    const f = await fixture(); const row = await verification(f);
    f.delivery.mockResolvedValueOnce({ delivery: "rejected", httpStatus: 429 });
    await f.service.send(f.company.id, f.agent.id, row.id);
    await expect(f.service.retryRejected(f.company.id, f.agent.id, randomUUID(), row.id)).rejects.toThrow("permission");
    await expect(f.service.retryRejected(randomUUID(), f.agent.id, f.principal.grant.userId, row.id)).rejects.toThrow();
    await Promise.all([1, 2].map(() => f.service.retryRejected(f.company.id, f.agent.id, f.principal.grant.userId, row.id)));
    const receipts = await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.bindingId, f.pairing.bindingId));
    expect(receipts).toHaveLength(2);
    expect(receipts.find(receipt => receipt.id === row.id)).toMatchObject({ status: "rejected", httpStatus: 429 });
    const retry = receipts.find(receipt => receipt.id !== row.id)!;
    expect(retry).toMatchObject({ status: "accepted", sourceEventId: `retry:${row.id}` });
    expect(f.delivery).toHaveBeenCalledTimes(2);
    await expect(f.service.retryRejected(f.company.id, f.agent.id, f.principal.grant.userId, retry.id)).rejects.toThrow("confirmed rejected");
    await f.service.acknowledge(f.principal, acknowledgement(retry));
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: true });
  });

  it.each(["follow_up", "operation_result"] as const)("does not start another routine for %s during accepted work", async kind => {
    const f = await fixture(); const { work } = await admittedWork(f, "accepted");
    await db.update(grokBotRoutines).set({ lastContactAt: new Date(Date.now() - 60_000) }).where(eq(grokBotRoutines.bindingId, f.pairing.bindingId));
    const sourceEventId = randomUUID(); const requestId = randomUUID();
    if (kind === "follow_up") await db.insert(dotMailboxItems).values({ companyId: f.company.id,
      bindingId: f.pairing.bindingId, bindingGeneration: 1, assignmentId: work.id,
      kind: "follow_up", sourceEventId, references: { consumed: false } });
    else await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: work.id, requestId,
      digest: "synthetic-progress", command: { action: "tool", input: { name: "report_progress" } }, status: "completed",
      outcome: { status: "completed", result: { recorded: true } }, pendingReturnedAt: new Date(Date.now() - 30_000) });
    f.delivery.mockClear(); const dispatcher = createGrokRoutineDispatcher(db, () => true, f.delivery);
    await dispatcher.tick(); await dispatcher.tick();
    expect(f.delivery).not.toHaveBeenCalled();
    if (kind === "follow_up") {
      expect((await dotRunnerBroker(db).mailbox(f.principal)).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceEventId, references: { consumed: false } }),
      ]));
    } else {
      expect(await dotRunnerBroker(db).operationStatus(f.principal, work.id, requestId)).toEqual({ status: "completed", result: { recorded: true } });
      expect((await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId, requestId)))[0]?.observedAt).not.toBeNull();
    }
    expect((await dotRunnerBroker(db).read(f.principal, work.id)).toolUsageInstructions).toContain("paperclip_grok_operation_status");
  });

  it("cancels a queued wake when its assignment was already accepted", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const queued = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id,
      bindingId: f.pairing.bindingId, assignmentId: work.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    await db.update(dotRunnerAssignments).set({ status: "accepted", acceptedAt: new Date() }).where(eq(dotRunnerAssignments.id, work.id));
    f.delivery.mockClear(); await createGrokRoutineDispatcher(db, () => true, f.delivery).tick();
    expect(f.delivery).not.toHaveBeenCalled();
    expect((await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.id, queued.id)))[0]?.status).toBe("cancelled");
  });

  it("cancels an unsent wake when acceptance commits during secret lookup", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const queued = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id,
      bindingId: f.pairing.bindingId, assignmentId: work.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    const accept = await acceptance(f, work);
    const original = secretModule.secretService;
    vi.spyOn(secretModule, "secretService").mockImplementation(database => {
      const service = original(database);
      return { ...service, resolveSecretValue: async (...args) => { await accept(); return service.resolveSecretValue(...args); } };
    });
    f.delivery.mockClear();
    await f.service.send(f.company.id, f.agent.id, queued.id);
    expect(f.delivery).not.toHaveBeenCalled();
    expect((await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.id, queued.id)))[0]).toMatchObject({ status: "cancelled", httpStatus: null });
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work.id)))[0]?.status).toBe("accepted");
    expect(await f.service.recoveryNeeded(f.company.id, f.agent.id)).toBe(false);
  });

  it("serializes acceptance during the final send check without blocking an authenticated reply", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const queued = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id,
      bindingId: f.pairing.bindingId, assignmentId: work.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    const accept = await acceptance(f, work);
    let accepting: Promise<void> | undefined; let authorityChecks = 0;
    const original = externalAuthority.authorizeExternalBotBinding;
    vi.spyOn(externalAuthority, "authorizeExternalBotBinding").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++authorityChecks === 3) {
        accepting = accept();
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and not granted`);
          expect(waiting.length).toBeGreaterThan(0);
        });
      }
      return result;
    });
    f.delivery.mockClear();
    f.delivery.mockImplementation(async () => {
      expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work.id)))[0]?.status).toBe("offered");
      await f.service.acknowledge(f.principal, { correlationId: queued.id, bindingId: f.pairing.bindingId, bindingGeneration: 1 });
      return { delivery: "accepted", httpStatus: 200 };
    });
    await f.service.send(f.company.id, f.agent.id, queued.id);
    expect(accepting).toBeDefined(); await accepting;
    expect(f.delivery).toHaveBeenCalledTimes(1);
    expect((await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.id, queued.id)))[0]?.acknowledgedAt).not.toBeNull();
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work.id)))[0]?.status).toBe("accepted");
  });

  it("allows Stop to fence work while webhook delivery is pending", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const queued = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id,
      bindingId: f.pairing.bindingId, assignmentId: work.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const broker = dotRunnerBroker(db, { heartbeat: { wakeup: vi.fn(), cancelRun } });
    f.delivery.mockClear();
    f.delivery.mockImplementation(async () => {
      expect(await broker.stopGrokWork(f.company.id, f.agent.id, f.principal.grant.userId, work.runId))
        .toMatchObject({ stopped: true, remoteTerminationConfirmed: false });
      expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work.id)))[0]?.status).toBe("fenced");
      return { delivery: "unknown", httpStatus: null };
    });
    await f.service.send(f.company.id, f.agent.id, queued.id);
    expect(f.delivery).toHaveBeenCalledTimes(1); expect(cancelRun).toHaveBeenCalledTimes(1);
    expect((await db.select().from(grokBotRoutines).where(eq(grokBotRoutines.bindingId, f.pairing.bindingId)))[0]?.recoveryReason).toBe("work_session");
  });

  it("accepts a late acknowledgement after the Bot has claimed its offer", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const sent = await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id,
      bindingId: f.pairing.bindingId, assignmentId: work.id, kind: "mailbox_updated", sourceEventId: randomUUID() });
    await f.service.send(f.company.id, f.agent.id, sent.id);
    await db.update(dotRunnerAssignments).set({ status: "accepted", acceptedAt: new Date() }).where(eq(dotRunnerAssignments.id, work.id));
    expect(await f.service.acknowledge(f.principal, { correlationId: sent.id, bindingId: f.pairing.bindingId,
      bindingGeneration: 1 })).toMatchObject({ status: "acknowledged", remoteTerminationConfirmed: false });
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, work.id)))[0]?.status).toBe("accepted");
  });

  it("retries rejected offer delivery explicitly while retaining unread feedback", async () => {
    const f = await fixture(); const { work } = await admittedWork(f, "offered");
    const sourceEventId = randomUUID();
    await db.insert(dotMailboxItems).values({ companyId: f.company.id, bindingId: f.pairing.bindingId, bindingGeneration: 1,
      assignmentId: work!.id, kind: "follow_up", sourceEventId, references: { consumed: false } });
    await f.service.reserve({ companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId,
      assignmentId: work.id, kind: "mailbox_updated", sourceEventId });
    f.delivery.mockClear(); f.delivery.mockResolvedValueOnce({ delivery: "rejected", httpStatus: 429 });
    const dispatcher = createGrokRoutineDispatcher(db, () => true, f.delivery);
    await dispatcher.tick(); await dispatcher.tick();
    expect(f.delivery).toHaveBeenCalledTimes(1);
    const [rejected] = await db.select().from(grokBotDispatches).where(and(eq(grokBotDispatches.assignmentId, work!.id), eq(grokBotDispatches.sourceEventId, sourceEventId)));
    expect(rejected).toMatchObject({ status: "rejected" });
    await f.service.retryRejected(f.company.id, f.agent.id, f.principal.grant.userId, rejected!.id);
    await dispatcher.tick();
    expect(f.delivery).toHaveBeenCalledTimes(2);
    const [input] = await db.select().from(dotMailboxItems).where(eq(dotMailboxItems.sourceEventId, sourceEventId));
    expect(input?.references).toMatchObject({ consumed: false });
  });

  it("never retries uncertain delivery or a rejection from replaced credentials", async () => {
    const f = await fixture(); const row = await verification(f);
    f.delivery.mockResolvedValueOnce({ delivery: "unknown", httpStatus: 504 });
    await f.service.send(f.company.id, f.agent.id, row.id);
    await expect(f.service.retryRejected(f.company.id, f.agent.id, f.principal.grant.userId, row.id)).rejects.toThrow("confirmed rejected");
    await f.service.recover(f.company.id, f.agent.id, f.principal.grant.userId);
    const rejected = await verification(f);
    f.delivery.mockResolvedValueOnce({ delivery: "rejected", httpStatus: 401 });
    await f.service.send(f.company.id, f.agent.id, rejected.id);
    await f.service.configure({ ...f.config, expectedRevision: 1 });
    await expect(f.service.retryRejected(f.company.id, f.agent.id, f.principal.grant.userId, rejected.id)).rejects.toThrow("authority changed");
    expect(f.delivery).toHaveBeenCalledTimes(2);
  });

  it("waits for the binding before acquiring routine recovery locks", async () => {
    const f = await fixture();
    let recovery: Promise<unknown> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, f.pairing.bindingId)).for("update");
        recovery = f.service.recover(f.company.id, f.agent.id, f.principal.grant.userId);
        void recovery.catch(() => {});
        await vi.waitFor(async () => {
          const result = await db.execute(sql`select exists (select 1 from pg_stat_activity where datname = current_database()
            and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%dot_agent_bindings%') as waiting`);
          const row = Array.isArray(result) ? result[0] : result.rows[0];
          expect(row?.waiting).toBe(true);
        }, { timeout: 5000 });
        await tx.execute(sql`set local lock_timeout = '2s'`);
        // A reverse-order recovery holds this row while waiting for our binding.
        await tx.select().from(grokBotRoutines).where(eq(grokBotRoutines.bindingId, f.pairing.bindingId)).for("update");
      });
    } finally { await recovery; }
  });

  it("holds uncertainty across disconnect and requires inspection plus a fresh verification", async () => {
    const f = await fixture(); const row = await verification(f);
    f.delivery.mockResolvedValue({ delivery: "unknown", httpStatus: 504 });
    await f.service.send(f.company.id, f.agent.id, row.id);
    await f.service.recover(f.company.id, f.agent.id, f.principal.grant.userId);
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: false, recoveryNeeded: false });
    await expect(f.service.acknowledge(f.principal, acknowledgement(row))).rejects.toThrow("cancelled");
    const next = await verification(f);
    expect(next.id).not.toBe(row.id);
    f.delivery.mockResolvedValue({ delivery: "accepted", httpStatus: 200 });
    await f.service.send(f.company.id, f.agent.id, next.id);
    await f.service.acknowledge(f.principal, acknowledgement(next));
    expect(await f.service.state(f.company.id, f.agent.id, row.bindingId)).toMatchObject({ verified: true });
  });
  it("keeps a revoked binding's unknown activity from being bypassed by reconnecting", async () => {
    const f = await fixture(); const row = await verification(f);
    f.delivery.mockResolvedValue({ delivery: "unknown", httpStatus: null });
    await f.service.send(f.company.id, f.agent.id, row.id);
    await dotRunnerBroker(db).revoke(f.company.id, f.agent.id, f.principal.grant.userId);
    expect(await f.service.recoveryNeeded(f.company.id, f.agent.id)).toBe(true);
    await f.service.recover(f.company.id, f.agent.id, f.principal.grant.userId);
    expect(await f.service.recoveryNeeded(f.company.id, f.agent.id)).toBe(false);
  });

});
