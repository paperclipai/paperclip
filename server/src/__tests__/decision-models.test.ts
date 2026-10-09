import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  createDb, companies, agents, companyMemberships, companyDecisionModels, costEvents, decisionInvocations,
  connectionGrants, connectionGrantMembers, toolConnectionInstalls, budgetPolicies, budgetReservations,
  heartbeatRuns, issues, projects, runIdentityContexts, secretAccessEvents, companySecrets,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { DECISION_TEST_REQUEST, updateDecisionModelSchema, createCostEventSchema } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { agentService } from "../services/agents.js";
import { decisionModelService, settingsDecisionTest, defineDecisionFeature, type DecisionContext } from "../services/decision-models.js";
import { decisionReceipt, type DecisionProviderOutcome } from "../services/decision-model-provider.js";
import { costService } from "../services/costs.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import express from "express";
import request from "supertest";
import { decisionModelRoutes } from "../routes/decision-models.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const backgroundFeature = defineDecisionFeature("test.background", { background: true });
const outcome: DecisionProviderOutcome = { answers: { billing: { type: "boolean", probability: 0.9 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 100, outputTokens: 0 } }) };
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-decisions-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "decisions-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-decisions-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
let sequence = 0;
async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Decision tests", issuePrefix: `DC${++sequence}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Test agent", adapterType: "codex_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "owner" })));
  const connections = aiConnectionService(db);
  const binding = await connections.save(companyId, "alice", { provider: "openai", method: "api_key", name: "Decision key", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
  const provider = vi.fn().mockResolvedValue(structuredClone(outcome));
  const service = decisionModelService(db, { provider });
  const context: DecisionContext = { companyId, feature: settingsDecisionTest,
    actor: { type: "board", userId: "alice", source: "session", companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] } };
  const config = { ...binding, enabled: true, allowBackground: true };
  await service.configure(companyId, "alice", config);
  return { companyId, agentId, binding, provider, service, context, config, connections };
}
describe("company decision service", () => {
  it("starts unconfigured with background sponsorship on and makes availability free", async () => {
    const f = await fixture();
    await db.delete(companyDecisionModels).where(eq(companyDecisionModels.companyId, f.companyId));
    expect(await f.service.settings(f.companyId)).toMatchObject({ enabled: false, allowBackground: true, connectionId: null });
    expect(await f.service.availability(f.context)).toEqual({ available: false, reason: "not_configured" });
    await f.service.configure(f.companyId, "alice", updateDecisionModelSchema.parse({ ...f.binding, enabled: true }));
    const before = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.companyId));
    const memo = f.service.availabilityForRequest();
    expect(memo(f.context)).toBe(memo(f.context));
    expect(await memo(f.context)).toEqual({ available: true });
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.companyId))).toHaveLength(before.length);
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("records a human service charge without an agent, exact cost and no input or answer content", async () => {
    const f = await fixture();
    const result = await f.service.decide(f.context, { ...DECISION_TEST_REQUEST, state: "PRIVATE PAYLOAD" });
    expect(result.status).toBe("succeeded");
    expect(f.provider.mock.calls[0][0].apiKey).toBe("fixture-key");
    const [event] = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(event).toMatchObject({ agentId: null, responsibleUserId: "alice", usageKind: "decision", costCents: 0.001, costStatus: "estimated", heartbeatRunId: null });
    const rows = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(rows[0]).toMatchObject({ status: "succeeded", actorType: "user", responsibleUserId: "alice", costEventId: event.id });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE PAYLOAD"); expect(JSON.stringify(rows)).not.toContain("probability");
    expect((await costService(db).byUser(f.companyId)).rows.find(r => r.userId === "alice")?.costCentsExact).toBe("0.0010000");
    expect((await costService(db).byAgent(f.companyId))[0].agentId).toBeNull();
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe("settled");
  });
  it("allows real background use, preserves explicit off, and never sponsors a denied human", async () => {
    const f = await fixture();
    const context: DecisionContext = { companyId: f.companyId, feature: backgroundFeature, actor: { type: "system" } };
    expect((await f.service.decide(context, DECISION_TEST_REQUEST)).status).toBe("succeeded");
    expect((await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId)))[0]).toMatchObject({ actorType: "system", responsibleUserId: null });
    await f.service.configure(f.companyId, "alice", { ...f.config, allowBackground: false });
    expect(await f.service.availability(context)).toEqual({ available: false, reason: "background_disabled" });
    const second = await f.connections.save(f.companyId, "alice", { provider: "openrouter", method: "api_key", name: "Other key", ownership: "shared", apiKey: "other", agentIds: [], allAgents: true }, "other");
    await f.service.configure(f.companyId, "alice", { ...second, enabled: true, allowBackground: false });
    expect((await f.service.settings(f.companyId)).allowBackground).toBe(false);
    await f.service.configure(f.companyId, "alice", f.config);
    await db.insert(connectionGrantMembers).values({ companyId: f.companyId, grantId: f.binding.grantId, subjectType: "user", subjectId: "bob" });
    expect(await f.service.decide({ ...f.context, feature: backgroundFeature }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "access_denied" });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("retains the charge and dispatch snapshot when the task is deleted during provider work", async () => {
    const f = await fixture(), issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Temporary task" });
    f.provider.mockImplementationOnce(async () => {
      await db.delete(issues).where(eq(issues.id, issueId));
      return structuredClone(outcome);
    });
    expect((await f.service.decide({ ...f.context, issueId }, DECISION_TEST_REQUEST)).status).toBe("succeeded");
    const [event] = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(event).toMatchObject({ issueId: null, costCents: 0.001 });
    const [invocation] = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(invocation).toMatchObject({ issueId, status: "succeeded", costEventId: event.id });
  });
  it("rechecks revoked grants after availability, and can disable a revoked connection", async () => {
    const f = await fixture(); expect(await f.service.availability(f.context)).toEqual({ available: true });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.binding.grantId));
    expect(await f.service.decide(f.context, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "connection_unavailable" });
    await f.service.configure(f.companyId, "alice", { ...f.config, enabled: false });
    expect(await f.service.availability(f.context)).toEqual({ available: false, reason: "disabled" }); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["disabled", "rotated"])("rejects a secret %s while admission waits for accounting", async change => {
    const f = await fixture();
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    let release!: () => void, locked!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<number>(resolve => { locked = resolve; });
    const holding = withAccountingTransaction(db, f.companyId, async tx => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked(row.pid); await gate;
    });
    const pid = await acquired;
    const pending = f.service.decide(f.context, DECISION_TEST_REQUEST);
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
        expect(row.count).toBeGreaterThan(0);
      }, { timeout: 5000 });
      await db.update(companySecrets).set(change === "disabled" ? { status: "disabled" } : { latestVersion: secret.latestVersion + 1 }).where(eq(companySecrets.id, secret.id));
    } finally { release(); await holding; }
    expect(await pending).toMatchObject({ status: "unavailable", reason: "connection_unavailable" });
    expect(f.provider).not.toHaveBeenCalled();
    expect(await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId))).toHaveLength(0);
  });
  it("preserves sponsorship off when a deleted grant is replaced", async () => {
    const f = await fixture();
    await f.service.configure(f.companyId, "alice", { ...f.config, allowBackground: false });
    await db.delete(connectionGrants).where(eq(connectionGrants.id, f.binding.grantId));
    expect(await f.service.availability(f.context)).toMatchObject({ available: false, reason: "connection_unavailable" });
    expect((await f.service.settings(f.companyId)).allowBackground).toBe(false);
    const next = await f.connections.save(f.companyId, "alice", { provider: "openrouter", method: "api_key", name: "Replacement", ownership: "shared", apiKey: "other", agentIds: [], allAgents: true }, "other");
    await f.service.configure(f.companyId, "alice", { ...next, enabled: true });
    expect((await f.service.settings(f.companyId)).allowBackground).toBe(false);
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("rejects foreign-company credentials, membership loss, and invented feature handles", async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.service.configure(f.companyId, "alice", { ...other.config })).rejects.toThrow();
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "alice")));
    expect(await f.service.availability(f.context)).toMatchObject({ available: false, reason: "access_denied" });
    expect(await f.service.decide({ ...f.context, feature: { id: "settings.test", background: true }, actor: { type: "system" } }, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "access_denied" });
  });
  it("captures the active run identity and checks both human and agent access", async () => {
    const f = await fixture(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Decision task", status: "in_progress", assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "on_demand", responsibleUserId: "alice", contextSnapshot: { issueId } });
    const [identity] = await db.insert(runIdentityContexts).values({ companyId: f.companyId, runId, revision: 1, responsibleUserId: "bob", cause: "steering", correlationId: "test", acceptedAt: new Date() }).returning();
    await db.update(heartbeatRuns).set({ responsibleUserId: "bob", activeIdentityContextId: identity.id }).where(eq(heartbeatRuns.id, runId));
    const context: DecisionContext = { companyId: f.companyId, feature: settingsDecisionTest, actor: { type: "agent", agentId: f.agentId, runId, companyId: f.companyId, source: "agent_jwt", onBehalfOfUserId: "alice" } };
    expect((await f.service.decide(context, DECISION_TEST_REQUEST)).status).toBe("succeeded");
    expect((await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId)))[0]).toMatchObject({ responsibleUserId: "bob", runId, issueId, identityContextId: identity.id });
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.binding.connectionId));
    expect(await f.service.availability(context)).toMatchObject({ available: false, reason: "access_denied" });
    await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, runId));
    expect(await f.service.availability(context)).toMatchObject({ available: false, reason: "responsible_user_missing" });
  });
  it("serializes budget admission against concurrent requests", async () => {
    const f = await fixture();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, windowKind: "calendar_month_utc", amount: 1, reservationCents: "1", notifyEnabled: false });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    f.provider.mockImplementationOnce(async () => { entered(); await gate; return structuredClone(outcome); });
    const first = f.service.decide(f.context, DECISION_TEST_REQUEST);
    await started;
    try { expect(await f.service.decide(f.context, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "budget_blocked" }); }
    finally { release(); }
    expect((await first).status).toBe("succeeded"); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("blocks agent deletion while an in-flight or unknown decision retains a budget hold", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "on_demand", responsibleUserId: "alice" });
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, windowKind: "calendar_month_utc", amount: 1, reservationCents: "1", notifyEnabled: false });
    const context: DecisionContext = { companyId: f.companyId, feature: settingsDecisionTest,
      actor: { type: "agent", agentId: f.agentId, runId, companyId: f.companyId, source: "agent_jwt" } };
    const remove = () => agentService(db).remove(f.agentId);
    f.provider.mockImplementationOnce(async () => {
      await expect(remove()).rejects.toMatchObject({ status: 409, details: { code: "agent_decision_accounting_pending" } });
      expect(await f.service.decide(f.context, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "budget_blocked" });
      return { errorCode: "timeout", receipt: decisionReceipt("openai", null) };
    });
    expect((await f.service.decide(context, DECISION_TEST_REQUEST)).status).toBe("failed");
    await expect(remove()).rejects.toMatchObject({ status: 409, details: { code: "agent_decision_accounting_pending" } });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0]).toMatchObject({ state: "held", amountCents: "1.0000000" });
  });
  it("holds unknown billing until an audited correction, without rerunning the provider", async () => {
    const f = await fixture(); f.provider.mockResolvedValue({ errorCode: "timeout", receipt: decisionReceipt("openai", null) });
    expect((await f.service.decide(f.context, DECISION_TEST_REQUEST)).status).toBe("failed");
    const [event] = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(event.costStatus).toBe("unpriced");
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe("held");
    await billingReconciliationService(db).adjust(f.companyId, event.id, { idempotencyKey: "correction", expectedCents: "0", correctedCents: "0.002", reason: "Verified provider invoice", pricing: { source: "operator" } }, "alice");
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe("settled");
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("recovers an interrupted dispatch once without paying for a retry", async () => {
    const f = await fixture();
    const [invocation] = await db.insert(decisionInvocations).values({ companyId: f.companyId, feature: "test.background", actorType: "system", actorId: "paperclip-decisions",
      ...f.binding, provider: "openai", model: "gpt-6-luna", questionTypes: ["boolean"], startedAt: new Date(Date.now() - 180_000) }).returning();
    await db.insert(budgetReservations).values({ companyId: f.companyId, decisionInvocationId: invocation.id, amountCents: "0.01", providerStartedAt: invocation.startedAt });
    await Promise.all([f.service.recoverInterrupted(), f.service.recoverInterrupted()]);
    const events = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(events).toHaveLength(1); expect(events[0].costStatus).toBe("unpriced"); expect(f.provider).not.toHaveBeenCalled();
  });
  it("keeps public cost reporting agent-scoped and bounds decision input before payment", async () => {
    expect(createCostEventSchema.safeParse({ agentId: null, provider: "openai", model: "gpt-6-luna", costCents: 1, occurredAt: new Date().toISOString() }).success).toBe(false);
    const f = await fixture(); await expect(f.service.decide(f.context, { ...DECISION_TEST_REQUEST, state: "x".repeat(32_001) })).rejects.toThrow(); expect(f.provider).not.toHaveBeenCalled();
  });
  it("preserves an explicit sponsorship opt-out when a subsequent edit omits the field", async () => {
    const f = await fixture();
    await f.service.configure(f.companyId, "alice", { ...f.config, allowBackground: false });
    const second = await f.connections.save(f.companyId, "alice", { provider: "openrouter", method: "api_key", name: "Other", ownership: "shared", apiKey: "other", agentIds: [], allAgents: true }, "other");
    await f.service.configure(f.companyId, "alice", { ...second, enabled: true });
    expect((await f.service.settings(f.companyId)).allowBackground).toBe(false);
  });
  it("rejects revoked secrets without provider work and returns usage on successful calls", async () => {
    const f = await fixture();
    expect(await f.service.decide(f.context, DECISION_TEST_REQUEST)).toMatchObject({ status: "succeeded", usage: { costCents: "0.0010000", costStatus: "estimated", inputTokens: 100 } });
    await db.update(companySecrets).set({ status: "revoked" }).where(eq(companySecrets.companyId, f.companyId));
    expect(await f.service.decide(f.context, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable" });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each(["agent", "project"] as const)("reserves and enforces applicable %s budgets", async scopeType => {
    const f = await fixture(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Decisions project" });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, projectId, title: "Budgeted task", assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "on_demand", responsibleUserId: "alice", contextSnapshot: { issueId } });
    const context: DecisionContext = { companyId: f.companyId, feature: settingsDecisionTest, actor: { type: "agent", agentId: f.agentId, runId, companyId: f.companyId, source: "agent_jwt" } };
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType, scopeId: scopeType === "agent" ? f.agentId : projectId, windowKind: "calendar_month_utc", amount: 1, reservationCents: "2", notifyEnabled: false }).returning();
    expect(await f.service.availability(context)).toEqual({ available: true });
    expect(await f.service.decide(context, DECISION_TEST_REQUEST)).toMatchObject({ status: "unavailable", reason: "budget_blocked" });
    expect(f.provider).not.toHaveBeenCalled();
    await db.update(budgetPolicies).set({ amount: 5 }).where(eq(budgetPolicies.id, policy.id));
    expect((await f.service.decide(context, DECISION_TEST_REQUEST)).status).toBe("succeeded");
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0]).toMatchObject({ agentId: f.agentId, projectId, amountCents: "2.0000000", state: "settled" });
  });
  it("releases reservations when the provider rejects a request before model work", async () => {
    const f = await fixture();
    f.provider.mockResolvedValue({ noProviderWork: true, errorCode: "provider_auth_failed", receipt: { ...outcome.receipt, inputTokens: 0, costCents: "0", pricingProvenance: { source: "unknown", evidence: "HTTP 401" } } });
    expect((await f.service.decide(f.context, DECISION_TEST_REQUEST)).status).toBe("failed");
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe("released");
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId)))[0].costCents).toBe(0);
  });
  it("enforces manager-only configuration and tests, company isolation, and fixed sample execution", async () => {
    const f = await fixture(), other = await fixture();
    const app = express(); app.use(express.json());
    let actor = f.context.actor;
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", decisionModelRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/decision-model`;
    expect((await request(app).get(url)).body.canManage).toBe(true);
    expect((await request(app).get(`/api/companies/${other.companyId}/decision-model`)).status).toBe(403);
    actor = { type: "board", userId: "alice", source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).body).toEqual({ canManage: false, settings: null, choices: [] });
    expect((await request(app).put(url).send(f.config)).status).toBe(403);
    expect((await request(app).post(`${url}/test`).send({ actor: { type: "system" } })).status).toBe(403);
    actor = f.context.actor;
    await f.service.configure(f.companyId, "alice", { ...f.config, enabled: false });
    expect((await request(app).post(`${url}/test`).send({ state: "untrusted", actor: { type: "system" }, model: "untrusted" })).body).toEqual({ status: "unavailable", reason: "disabled" });
    expect((await request(app).post(`${url}/decide`).send(DECISION_TEST_REQUEST)).status).toBe(404);
    expect((await request(app).get(`${url}/history?limit=501`)).status).toBe(400);
    expect((await request(app).get(`${url}/history?from=2026-10-01T00:00:00.000Z&to=2026-10-31T23:59:59.000Z`)).status).toBe(200);
  });
  it("keeps private task links out of company cost history for unauthorized readers", async () => {
    const f = await fixture(), projectId = randomUUID(), issueId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Private project", visibility: "private", privacyOwnerUserId: "bob" });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, projectId, title: "PRIVATE TITLE", identifier: "SECRET-1" });
    await f.service.decide({ companyId: f.companyId, feature: backgroundFeature, actor: { type: "system" }, issueId }, DECISION_TEST_REQUEST);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "alice")));
    const actor = { type: "board" as const, userId: "alice", source: "session" as const, companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "member" }] };
    expect(await f.service.availability({ ...f.context, actor, issueId })).toMatchObject({ available: false, reason: "access_denied" });
    const history = await f.service.history(f.companyId, actor);
    expect(history[0]).toMatchObject({ issueId: null, issueIdentifier: null, runId: null });
    expect(JSON.stringify(history)).not.toContain("SECRET");
  });
});
