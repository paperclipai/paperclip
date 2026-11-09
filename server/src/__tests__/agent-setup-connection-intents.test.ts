import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, heartbeatRuns, issues, issueThreadInteractions,
  connectionIntentDeliveries, toolApplications, toolConnections, connectionGrants, aiProviderDefaults, createDb } from "@paperclipai/db";
import { connectionIntentService } from "../services/connection-intents.js";
import { connectionIntentDeliveryService, wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("queued agent setup uses task connection cards", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("agent-setup-card-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Setup card", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const binding = { mode: "responsible_user", provider: "openrouter", method: "api_key" } as const;
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", status: "paused", lifecycleState: "verifying", lifecycleHolds: [],
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 1, retryRequired: true },
      adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, runtimeConfig: { aiConnection: binding } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review after setup", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", responsibleUserId: userId, contextSnapshot: { issueId } });
    const service = connectionIntentService(db);
    const claims = { sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: userId };
    return { companyId, agentId, issueId, runId, userId, binding, service, claims };
  }
  async function repair(f: Awaited<ReturnType<typeof fixture>>) {
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, applicationKey: "setup-openrouter", name: "OpenRouter", type: "mcp_http", metadata: { sourceTemplateKey: "openrouter" } }).returning();
    const [account] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app!.id, name: "Review account", uid: randomUUID(), connectionPurpose: "ai", transport: "runtime_auth", authKind: "api_key", credentialPolicy: "per_user", healthStatus: "ok", status: "active", enabled: true, config: { sourceTemplateKey: "openrouter", ai: { provider: "openrouter", method: "api_key" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: account!.id, kind: "user", subjectUserId: f.userId, createdByUserId: f.userId }).returning();
    await db.insert(aiProviderDefaults).values({ companyId: f.companyId, userId: f.userId, provider: "openrouter", grantId: grant!.id });
    return account!;
  }
  const cards = (issueId: string) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));

  it("creates one existing inline card without admitting runtime tokens, then rechecks verification once for the same queued turn", async () => {
    const f = await fixture();
    await expect(f.service.validate(f.claims)).rejects.toThrow("no longer active");
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const pending = await cards(f.issueId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "connection_intent", status: "pending", sourceRunId: f.runId, addresseeUserId: f.userId,
      payload: { purpose: "ai", serviceSlug: "openrouter", agentSetup: true } });
    expect((await f.service.setupOptions(pending[0]!.id)).aiConnection).toEqual(f.binding);
    const account = await repair(f);
    await f.service.complete(pending[0]!.id, account.id, f.userId);
    const wakeup = vi.fn();
    const delivery = connectionIntentDeliveryService(db, { wakeup } as never);
    await delivery.deliver(pending[0]!.id);
    await delivery.deliver(pending[0]!.id);
    expect(wakeup).not.toHaveBeenCalled();
    const [held] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(held!.lifecycleState).toBe("verifying");
    expect(held!.lifecycleOperation).not.toHaveProperty("retryRequired");
    const onReady = vi.fn();
    const host = vi.fn(async () => "complete" as const);
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: host, runPlugin: async () => "complete" as const, onReady });
    try { await worker.process(f.agentId); await worker.process(f.agentId); }
    finally { await worker.stop(); }
    expect(host).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId)))).toMatchObject([{ id: f.runId, status: "queued", startedAt: null }]);
    expect((await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, pending[0]!.id)))[0]!.deliveredAt).not.toBeNull();
  });

  it.each(["decline", "stop", "reassign"] as const)("does not dispatch or lift verification after %s", async action => {
    const f = await fixture();
    await f.service.requestForQueuedAgentSetup(f.companyId, f.agentId);
    const [card] = await cards(f.issueId);
    if (action === "decline") await f.service.decline(card!.id, f.userId);
    else {
      const account = await repair(f);
      await f.service.complete(card!.id, account.id, f.userId);
      if (action === "stop") await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      else await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    }
    const wakeup = vi.fn();
    await connectionIntentDeliveryService(db, { wakeup } as never).deliver(card!.id);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleOperation?.retryRequired).toBe(true);
  });

  it.each(["manual_pause", "started", "foreign_company"] as const)("does not create a setup card for %s", async state => {
    const f = await fixture();
    if (state === "manual_pause") await db.update(agents).set({ lifecycleState: "paused", lifecycleHolds: ["manual"] }).where(eq(agents.id, f.agentId));
    if (state === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await f.service.requestForQueuedAgentSetup(state === "foreign_company" ? randomUUID() : f.companyId, f.agentId);
    expect(await cards(f.issueId)).toHaveLength(0);
  });

  it("keeps setup-card outcomes out of the generic provider wake path", async () => {
    const wakeup = vi.fn();
    await wakeConnectionIntentAfterResolution({ wakeup } as never, { loaded: { issue: { id: "task", status: "in_progress", assigneeAgentId: "agent" }, interaction: { id: "card", payload: { purpose: "ai", agentSetup: true } } }, status: "accepted", actorId: "user" });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
