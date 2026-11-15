import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, budgetPolicies, chatDeliveries, chatEndpoints, companies,
  companyTransferRuns, connectionEventDeliveries, createDb, heartbeatRuns, issues,
  routineTriggers, routines, instanceSettings, toolApplications, toolConnections, toolInvocations, toolMcpTasks, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerMcpTaskWork } from "../services/mcp-task-work.js";
import { queueBudgetEvaluation } from "../services/budget-evaluation-work.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const now = Date.UTC(2026, 10, 2);
const ownerId = randomUUID();
const hold = () => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const localNone = async () => "none" as const;

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_IDLE_SLEEP_DIAGNOSTICS_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping idle sleep diagnostics Postgres tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("existing-instance sleep blocker diagnostics", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (!externalDatabaseUrl) temporary = await startEmbeddedPostgresTestDatabase("idle-sleep-diagnostics-");
    db = createDb(externalDatabaseUrl ?? temporary!.connectionString, { maxConnections: 4 });
    await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  const read = (scheduled = false, monitors = false) => readIdleSleepSafety(db, hold, () => now, ownerId,
    localNone, undefined, undefined, scheduled, monitors, { collectDiagnostics: true });
  const blockers = (report: Awaited<ReturnType<typeof read>>) => report.diagnostics?.checks
    .filter(check => check.state === "present").map(check => check.reason);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Existing inventory fixture", issuePrefix: `DI${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "On-demand worker", role: "engineer", adapterType: "process", status: "idle" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: "succeeded", finishedAt: new Date(now - 1000) });
    return { companyId, agentId, runId };
  }

  async function chatHistory(f: Awaited<ReturnType<typeof seed>>) {
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Slack fixture", type: "rest_api" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application!.id,
      name: "Unconfigured Slack", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk", status: "draft", enabled: false }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection!.id,
      provider: "slack", publicId: randomUUID(), assignedAgentId: f.agentId, status: "draft", setup: { step: "provider_setup" } }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint!.id,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: {},
      state: "processed", processedAt: new Date(now - 1000) }).returning();
    return delivery!;
  }

  it("inspects every current predicate while retaining settled ordinary history", async () => {
    const f = await seed();
    const report = await read();
    expect(report.backgroundWork).toBe("none");
    expect(report.diagnostics?.complete).toBe(true);
    expect(blockers(report)).toEqual([]);
    expect(report.diagnostics?.checks).toContainEqual({ reason: "budget_evaluation_work", state: "none" });
    expect(report.diagnostics?.checks.filter(check => !check.reason.includes(".") ||
      ["agents.execution_or_timer", "agents.lifecycle", "agents.company_hold", "heartbeat_runs.budget_cancellation"].includes(check.reason)))
      .toHaveLength(76);
    expect(report.diagnostics?.checks).toEqual(expect.arrayContaining([
      { reason: "mcp_file_tickets", state: "none" },
      { reason: "mcp_authorization_handoffs", state: "none" },
    ]));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(1);
    await db.transaction(tx => queueBudgetEvaluation(tx as unknown as Db, { companyId: f.companyId, agentId: f.agentId }));
    const pending = await read();
    expect(pending.backgroundWork).toBe("present");
    expect(blockers(pending)).toEqual(["budget_evaluation_work"]);
  });

  it("reports history, credentials, debt, running work and future configuration simultaneously", async () => {
    const f = await seed();
    const history = await chatHistory(f);
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, name: "Saved machine access", keyHash: randomUUID() });
    await db.insert(companyTransferRuns).values({ companyId: f.companyId, direction: "export", status: "completed",
      actorKey: "fixture-board", containerRef: {}, idempotencyKey: randomUUID(), finishedAt: new Date(now - 2000) });
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      windowKind: "calendar_month_utc", enforcementVersion: 2, enforcementDeliveredVersion: 1 });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand", status: "queued" });
    await db.insert(routines).values({ companyId: f.companyId, title: "Configured future duty", status: "active", assigneeAgentId: f.agentId });
    const report = await read();
    expect(report.backgroundWork).toBe("present");
    expect(report.diagnostics?.complete).toBe(true);
    expect(blockers(report)).toEqual(["agent_api_keys", "budget_policies", "chat_deliveries", "company_transfer_runs", "heartbeat_runs", "routines"]);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, history.id)))
      .toMatchObject([{ state: "processed", processedAt: history.processedAt }]);
    expect(await db.select().from(agentApiKeys)).toHaveLength(1);
    expect(await db.select().from(companyTransferRuns)).toMatchObject([{ status: "completed" }]);
  });

  it.each(["processed", "retry"] as const)("identifies retained %s chat rows without changing domain policy", async state => {
    const delivery = await chatHistory(await seed());
    await db.update(chatDeliveries).set({ state }).where(eq(chatDeliveries.id, delivery.id));
    expect(blockers(await read())).toEqual(["chat_deliveries"]);
    expect(await db.select().from(chatDeliveries)).toMatchObject([{ id: delivery.id, state }]);
  });

  it("distinguishes processed connector receipts from pending application without clearing history", async () => {
    const f = await seed();
    const [receipt] = await db.insert(connectionEventDeliveries).values({ companyId: f.companyId, provider: "github",
      providerDeliveryId: randomUUID(), event: "issues", status: "processed", processedAt: new Date(now - 1000) }).returning();
    expect(blockers(await read())).toEqual([]);
    await db.update(connectionEventDeliveries).set({ status: "received", processedAt: null }).where(eq(connectionEventDeliveries.id, receipt!.id));
    expect(blockers(await read())).toEqual(["connection_event_deliveries"]);
    expect(await db.select().from(connectionEventDeliveries)).toHaveLength(1);
  });

  it("collects schedule and unrelated history reasons from the same negotiated inspection", async () => {
    const f = await seed();
    await chatHistory(f);
    const [routine] = await db.insert(routines).values({ companyId: f.companyId, title: "Future routine", status: "active", assigneeAgentId: f.agentId }).returning();
    const [trigger] = await db.insert(routineTriggers).values({ companyId: f.companyId, routineId: routine!.id, kind: "schedule",
      cronExpression: "*/15 * * * *", timezone: "UTC", nextRunAt: new Date(now + 600_000), enabled: true, archived: false, setupPending: false }).returning();
    await db.insert(issues).values({ companyId: f.companyId, title: "Passive backlog", status: "backlog" });
    expect(blockers(await read())).toEqual(["chat_deliveries", "issues", "routines"]);
    expect(blockers(await read(true, true))).toEqual(["chat_deliveries"]);
    await db.update(routineTriggers).set({ nextRunAt: new Date(now - 1000) }).where(eq(routineTriggers.id, trigger!.id));
    const due = await read(true, true);
    expect(blockers(due)).toEqual(["chat_deliveries", "routines.schedule"]);
    expect(await db.select().from(routineTriggers)).toMatchObject([{ nextRunAt: new Date(now - 1000) }]);
  });

  it("fails closed on a real malformed SQL configuration without leaking values", async () => {
    const f = await seed();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: "private-bad-interval" } } })
      .where(eq(agents.id, f.agentId));
    const report = await read();
    expect(report.backgroundWork).toBe("unknown");
    expect(report.diagnostics?.complete).toBe(false);
    expect(report.diagnostics?.checks).toContainEqual({ reason: "durable.snapshot", state: "unknown" });
    expect(JSON.stringify(report)).not.toMatch(/private-bad-interval|numeric|SELECT|runtime_config/);
  });

  // These inventory fixtures never make a provider call: all retained polls are
  // in the future. The normal gateway and deadline owner remain unmodified.
  async function retainedMcpTask() {
    const f = await seed();
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId,
      name: "Retained MCP task fixture", type: "rest_api" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId,
      applicationId: application!.id, name: "Retained task connection", uid: randomUUID(),
      transport: "mcp_remote", status: "draft", enabled: false }).returning();
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId,
      connectionId: connection!.id, toolName: "fixture.task", status: "succeeded" }).returning();
    const [task] = await db.insert(toolMcpTasks).values({ companyId: f.companyId,
      invocationId: invocation!.id, connectionId: connection!.id, grantId: randomUUID(),
      actorType: "system", catalogToolName: "fixture.task", requestHash: "fixture-request",
      endpointHash: "fixture-endpoint", protocolVersion: "2026-07-28",
      sealedProviderTaskId: "not-read-by-this-inventory-test", providerTaskIdHash: randomUUID(),
      status: "working", expiresAt: new Date(Date.now() + 3_600_000),
      nextPollAt: new Date(Date.now() + 600_000), argumentsIdentity: "fixture-arguments" }).returning();
    return task!;
  }

  async function withMcpTaskSettings(body: () => Promise<void>) {
    const [saved] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    try {
      await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
      await body();
    } finally {
      vi.unstubAllEnvs();
      await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
      if (saved) await db.insert(instanceSettings).values(saved);
    }
  }

  it("uses the normal effective MCP Tasks authority for retained future work and settled history", async () => {
    await withMcpTaskSettings(async () => {
      const taskState = async () => (await read()).diagnostics?.checks.find(check => check.reason === "tool_mcp_tasks")?.state;
      expect(await taskState()).toBe("none"); // default off, no row
      const task = await retainedMcpTask();
      const settings = instanceSettingsService(db);
      await settings.updateExperimental({ enableMcpTasks: false });
      expect(await taskState()).toBe("none"); // explicitly disabled retained work
      vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture",
        features: { enableMcpTasks: true }, plugins: { autoInstall: [] } }));
      const gateway = createToolGatewayService(db);
      expect(await gateway.nextMcpTaskPollAt()).toBe(task.nextPollAt!.getTime());
      expect(await taskState()).toBe("present"); // first OLD-product causal oracle
      await db.update(toolMcpTasks).set({ status: "completed", nextPollAt: null }).where(eq(toolMcpTasks.id, task.id));
      expect(await gateway.nextMcpTaskPollAt()).toBeNull();
      expect(await taskState()).toBe("none");
      vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
      await instanceSettingsService(db).updateExperimental({ enableMcpTasks: true });
      vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture",
        features: { enableMcpTasks: false }, plugins: { autoInstall: [] } }));
      await db.update(toolMcpTasks).set({ status: "working", nextPollAt: task.nextPollAt }).where(eq(toolMcpTasks.id, task.id));
      expect(await gateway.nextMcpTaskPollAt()).toBeNull();
      expect(await taskState()).toBe("none"); // raw true cannot defeat managed false
    });
  }, 30_000);

  it("normal settings re-enable rearms the settled MCP Tasks owner without another task write", async () => {
    await withMcpTaskSettings(async () => {
      const task = await retainedMcpTask();
      const settings = instanceSettingsService(db);
      await settings.updateExperimental({ enableMcpTasks: false });
      const gateway = createToolGatewayService(db);
      const poll = vi.spyOn(gateway, "pollDueMcpTasks"); // pass-through, no mocked result
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: error => { errors.push(error); } });
      try {
        const worker = registerMcpTaskWork(coordinator, gateway, null, () => true);
        await worker.ready;
        expect(poll).toHaveBeenCalledTimes(1);
        expect(worker.reconciliationSnapshot().reconciled).toBe(true);
        expect(coordinator.nextWakeAt()).toBeNull();
        await settings.updateExperimental({ enableMcpTasks: true });
        await expect.poll(() => poll.mock.calls.length, { timeout: 2_000 }).toBeGreaterThan(1);
        await expect.poll(() => worker.reconciliationSnapshot().reconciled, { timeout: 2_000 }).toBe(true);
        expect(coordinator.nextWakeAt()).toBe(task.nextPollAt!.getTime());
        expect(await db.select().from(toolMcpTasks).where(eq(toolMcpTasks.id, task.id))).toMatchObject([
          { status: "working", nextPollAt: task.nextPollAt, leaseOwner: null, leaseExpiresAt: null },
        ]);
        expect(errors).toEqual([]);
      } finally {
        await coordinator.stop();
        poll.mockRestore();
      }
    });
  }, 30_000);
});
