import { createAgentLifecycle as createLifecycleCommands, invalidateAgentVerification } from "../index.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { deleteCompany } from "../../../services/company-deletion.js";
import { agentLifecycleCompanyDeletion } from "../company-deletion.js";
import { requireServerAdapter } from "../../../adapters/index.js";
import { agentExecutionsHaveStopped } from "../../../services/agent-execution-stop.js";
import { remoteTerminationReceipt } from "../../../services/remote-execution-termination.js";
import { approvalService } from "../../../services/approvals.js";
import { agentConfigurationService } from "../../../services/agent-configuration.js";
import { agentService as agentConfiguration } from "../../../services/agents.js";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { agentRoutes } from "../../../routes/agents.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, approvals, projects, issues, heartbeatRuns, nativeRunFinalizations, budgetPolicies, environmentLeases, agentApiKeys, activityLog, agentConfigRevisions, userCompanyPreferences, companies, companyMemberships, principalPermissionGrants, plugins, pluginCompanySettings, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleStore as createStore } from "../adapters/postgres.js";
import { transition } from "../domain/policy.js";
import type { LifecycleAgent } from "../application/ports.js";
import { budgetService } from "../../../services/budgets.js";

const createLifecycleStore = (db: Db) => createStore(db, createAgentLifecycleEffects());

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent lifecycle commands", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-lifecycle-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { for (const worker of workers) await worker.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const work of workers) await work.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle test", issuePrefix: `L${companyId.slice(0, 7)}` });
  });
  function worker(runHost: (agent: LifecycleAgent) => Promise<"complete" | "pending"> = async () => "complete") {
    const value = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost });
    workers.push(value); return value;
  }
  async function hire(status = "idle") { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status, adapterType: "process" }); }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }

  it("maps existing states without starting setup or clearing pause reasons", async () => {
    const rows = await db.insert(agents).values(["idle", "running", "error", "paused", "pending_approval", "terminated"].map(status => ({
      companyId, name: status, status, pauseReason: status === "paused" ? "budget" : null,
    }))).returning();
    const migration = readFileSync(new URL("../../../../../packages/db/src/migrations/0320_daily_onslaught.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration.slice(migration.indexOf('UPDATE "agents"'))));
    for (const row of rows) {
      const mapped = await current(row.id);
      expect(mapped.lifecycleState).toBe(["paused", "pending_approval", "terminated"].includes(row.status) ? row.status : "ready");
      expect(mapped.lifecycleOperation).toBeNull();
      expect(mapped.lifecycleRequiredPluginIds).toBeNull();
      expect(mapped.lifecycleHolds).toEqual(row.status === "paused" ? ["budget"] : []);
    }
  });

  it("commits the record before preparation and verifies before admission", async () => {
    const observed: string[] = [];
    const work = worker(async agent => {
      expect((await current(agent.id)).lifecycleState).toBe(agent.lifecycleState);
      observed.push(agent.lifecycleState); return "complete";
    });
    const agent = await hire();
    expect(agent).toMatchObject({ lifecycleState: "preparing", status: "paused" });
    await work.process(agent.id);
    expect(observed).toEqual(["preparing", "verifying"]);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle" });
    expect(agent).not.toHaveProperty("lifecycleOperation");
  });

  it("rolls back a hire and its grants when hire initialization fails", async () => {
    const effects = createAgentLifecycleEffects();
    const lifecycle = createLifecycleCommands(db, { ...effects,
      initializeHire: async (tx, agent, options) => {
        await effects.initializeHire(tx, agent, options);
        throw new Error("Hire initialization failed");
      },
    });
    await expect(lifecycle.requestHire(companyId, { name: "Rollback hire", adapterType: "process" }))
      .rejects.toThrow("Hire initialization failed");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId))).toHaveLength(0);
  });

  it("runs the saved harness test and keeps a failed configuration out of ready", async () => {
    const driver = createLifecycleDriver(db, {} as never);
    const work = worker(driver.runHost);
    const agent = await hire();
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "verifying", status: "paused" });
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: process.execPath } });
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it.each(["claude_local", "gemini_local"])("keeps %s authentication warnings out of ready", async adapterType => {
    const adapter = requireServerAdapter(adapterType);
    const probe = vi.spyOn(adapter, "testEnvironment").mockResolvedValue({ adapterType, status: "warn",
      testedAt: new Date().toISOString(), checks: [{ code: `${adapterType.split("_")[0]}_hello_probe_auth_required`, level: "warn", message: "Login required" }] });
    try {
      const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Login test", adapterType });
      const work = worker(createLifecycleDriver(db, {} as never).runHost);
      await work.process(agent.id);
      expect(probe).toHaveBeenCalled();
      expect(await current(agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: "The lifecycle step failed. Retry the operation." });
    } finally { probe.mockRestore(); }
  });

  it("recovers an expired native owner only after the cancelled run and controller stop", async () => {
    const agent = await hire();
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancelled native run" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native",
      startedAt: new Date(), finishedAt: new Date(), processPid: process.pid }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
      phase: "executing", leaseOwner: "stopped-server", leaseExpiresAt: new Date(0), controllerPid: process.pid });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(nativeRunFinalizations).set({ controllerPid: null }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000 }).where(eq(heartbeatRuns.id, run.id));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0]).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it("does not advance termination while a cancelled process still runs", async () => {
    const agent = await hire();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "legacy",
      startedAt: new Date(), finishedAt: new Date(), processPid: process.pid }).returning();
    const driver = createLifecycleDriver(db, {} as never);
    const work = worker(driver.runHost);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminating");
    await db.update(heartbeatRuns).set({ processPid: null,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, run.id));
    await createAgentLifecycle(db).retry(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
  });

  it("does not cancel a reporting agent when its manager pauses", async () => {
    const parent = await hire();
    const [child] = await db.insert(agents).values({ companyId, name: "Report", reportsTo: parent.id,
      status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: child.id,
      status: "queued", invocationSource: "on_demand" }).returning();
    const work = worker(createLifecycleDriver(db, {} as never).runHost);
    await createAgentLifecycle(db).pauseAgent(parent.id);
    await work.process(parent.id);
    expect((await current(parent.id)).lifecycleState).toBe("paused");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!.status).toBe("queued");
  });

  it("retains company data until every agent finishes termination", async () => {
    const agent = await hire();
    const [project] = await db.insert(projects).values({ companyId, name: "Keep until cleanup", leadAgentId: agent.id }).returning();
    await db.insert(issues).values({ companyId, projectId: project.id, title: "Keep this task", assigneeAgentId: agent.id });
    const pending = worker(async () => "pending");
    await expect(deleteCompany(db, companyId)).rejects.toThrow("Complete termination");
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    await pending.stop();
    const complete = worker();
    await createAgentLifecycle(db).retry(agent.id);
    await complete.process(agent.id);
    await deleteCompany(db, companyId);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
  });

  it("requires a transaction for the company deletion integration", async () => {
    await expect(agentLifecycleCompanyDeletion.deleteCompanyData(db as never, companyId))
      .rejects.toThrow("Company deletion requires a database transaction");
  });

  it("rejects individual deletion before cleanup and rolls back failed cleanup", async () => {
    const agent = await hire();
    const effects = createAgentLifecycleEffects();
    const cleanup = vi.fn(effects.deleteDependencies);
    const lifecycle = createLifecycleCommands(db, { ...effects, deleteDependencies: cleanup });
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Complete termination");
    expect(cleanup).not.toHaveBeenCalled();

    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, agent.id));
    const [key] = await db.insert(agentApiKeys).values({ companyId, agentId: agent.id, name: "Keep on rollback", keyHash: randomUUID() }).returning();
    cleanup.mockImplementation(async (tx, companyId, id) => {
      await effects.deleteDependencies(tx, companyId, id);
      throw new Error("Dependency cleanup failed");
    });
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Dependency cleanup failed");
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "terminated" });
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, key.id))).toHaveLength(1);
  });

  it("deletes terminated and rejected agents only in the requested company", async () => {
    await db.insert(agents).values((["terminated", "rejected"] as const).map(lifecycleState => ({
      companyId, name: lifecycleState, status: "terminated", lifecycleState,
    })));
    const [otherCompany] = await db.insert(companies).values({ name: "Keep this company", issuePrefix: `K${companyId.slice(0, 7)}` }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Keep this agent",
      status: "terminated", lifecycleState: "terminated" }).returning();

    await deleteCompany(db, companyId);

    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await current(otherAgent.id)).toMatchObject({ companyId: otherCompany.id });
    expect(await db.select().from(companies).where(eq(companies.id, otherCompany.id))).toHaveLength(1);
  });

  it("rolls back agent and company data deletion when a later operation fails", async () => {
    const agent = await hire("terminated");
    const [project] = await db.insert(projects).values({ companyId, name: "Keep on rollback" }).returning();
    const removeAgents = agentLifecycleCompanyDeletion.deleteCompanyData;
    const failure = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      await removeAgents(tx, id);
      expect(await tx.select().from(agents).where(eq(agents.companyId, id))).toHaveLength(0);
      throw new Error("Later deletion failed");
    });
    try {
      await expect(deleteCompany(db, companyId)).rejects.toThrow("Later deletion failed");
      expect(await current(agent.id)).toMatchObject({ lifecycleState: "terminated" });
      expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
    } finally { failure.mockRestore(); }
  });

  it("blocks a concurrent hire until company deletion commits", async () => {
    let reportLock!: (pid: number) => void;
    let rejectLock!: (error: unknown) => void;
    const locked = new Promise<number>((resolve, reject) => { reportLock = resolve; rejectLock = reject; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const removeAgents = agentLifecycleCompanyDeletion.deleteCompanyData;
    const pause = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      reportLock(backend!.pid);
      await released;
      await removeAgents(tx, id);
    });
    const deletion = deleteCompany(db, companyId);
    void deletion.catch(rejectLock);
    let hiring: Promise<unknown> | undefined;
    try {
      const pid = await locked;
      hiring = hire().then(() => "created", error => error.message);
      await vi.waitFor(async () => {
        const blocked = await db.execute(sql`select 1 from pg_stat_activity
          where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))`);
        expect(blocked).toHaveLength(1);
      });
      release();
      await deletion;
      expect(await hiring).toBe("Company not found");
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled([deletion, hiring]);
      pause.mockRestore();
    }
  });

  it("requires cleanup proof after a remote run is already cancelled", async () => {
    const agent = await hire();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native",
      startedAt: new Date(), finishedAt: new Date() }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id,
      provider: "test", providerLeaseId: "test-lease", status: "pending_cleanup",
      cleanupStatus: "failed", releasedAt: new Date() }).returning();
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }),
    } }).where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });

  it("does not prepare a proposed hire until approval", async () => {
    const observed: string[] = [];
    const work = worker(async agent => { observed.push(agent.lifecycleState); return "complete"; });
    const agent = await hire("pending_approval");
    await work.process(agent.id);
    expect(observed).toEqual([]);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", payload: { agentId: agent.id }, status: "pending" });
    await approvalService(db).approve(approval.id, "board");
    await vi.waitFor(async () => expect((await current(agent.id)).lifecycleState).toBe("ready"));
    expect(observed).toEqual(["preparing", "verifying"]);
  });

  it.each(["approved", "rejected"] as const)("uses the same %s hire decision for an agent and its approval", async decision => {
    const agent = await hire("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      requestedByUserId: "requester", payload: { agentId: agent.id }, status: "pending" });
    const lifecycle = createAgentLifecycle(db);
    const decide = decision === "approved" ? lifecycle.approveHire : lifecycle.rejectHire;
    const first = await decide(agent.id, "board");
    expect(first).toMatchObject({ applied: true, approval: { id: approval.id, status: decision },
      agent: { lifecycleState: decision === "approved" ? "preparing" : "rejected" } });
    const version = (await current(agent.id)).lifecycleVersion;
    expect(await decide({ approvalId: approval.id }, "board")).toMatchObject({ applied: false, hireApprovedAgentId: null });
    expect((await current(agent.id)).lifecycleVersion).toBe(version);
  });

  it("rolls back the approval and agent together when activation fails", async () => {
    const agent = await hire("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      payload: { agentId: agent.id }, status: "pending" });
    const lifecycle = createLifecycleCommands(db, { ...createAgentLifecycleEffects(),
      recordCreation: async () => { throw new Error("Creation event failed"); } });
    await expect(lifecycle.approveHire(agent.id, "board")).rejects.toThrow("Creation event failed");
    expect((await current(agent.id)).lifecycleState).toBe("pending_approval");
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0].status).toBe("pending");
  });

  it("keeps the hire credential owner and recovers it for migrated approvals", async () => {
    for (const savedOwner of [null, "original-owner"]) {
      const [agent] = await db.insert(agents).values({ companyId, name: "Migrated hire", status: "pending_approval",
        lifecycleState: "pending_approval", lifecycleOperation: savedOwner ? {
          id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, responsibleUserId: savedOwner,
        } : null }).returning();
      const approval = await approvalService(db).create(companyId, { type: "hire_agent",
        requestedByUserId: "requesting-member", payload: { agentId: agent.id }, status: "pending" });
      await approvalService(db).approve(approval.id, "approving-member");
      expect((await current(agent.id)).lifecycleOperation?.responsibleUserId).toBe(savedOwner ?? "requesting-member");
    }
  });

  it("rejects transaction injection and generic state writes", async () => {
    const agent = await hire("pending_approval");
    await expect(db.transaction(async tx => createAgentLifecycle(tx as unknown as Db))).rejects.toThrow("root database");
    await expect(agentConfiguration(db).update(agent.id, { status: "idle" } as never)).rejects.toThrow("lifecycle command");
    await expect(createAgentLifecycle(db).requestHire(companyId, { name: "Bypass", lifecycleRequiredPluginIds: [] } as never)).rejects.toThrow("Lifecycle fields");
  });

  it("clears a rejected hire from the user's primary selection", async () => {
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Proposed", status: "pending_approval" }, { createdByUserId: "board" });
    const preference = () => db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId));
    expect((await preference())[0]!.primaryAgentId).toBe(agent.id);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", payload: { agentId: agent.id }, status: "pending" });
    await approvalService(db).reject(approval.id, "board");
    expect((await preference())[0]!.primaryAgentId).toBeNull();
    expect((await current(agent.id)).lifecycleState).toBe("rejected");
  });

  it("rolls back configuration and its revision when the requested transition fails", async () => {
    const lifecycle = createAgentLifecycle(db);
    const agent = await hire("terminated");
    await expect(lifecycle.updateAndTransition(agent.id, "resume", { name: "Must not persist" },
      { recordRevision: { createdByUserId: "board", source: "patch" } })).rejects.toThrow("Cannot resume");
    expect((await current(agent.id)).name).toBe("Agent");
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toEqual([]);
    const active = await hire();
    expect(await lifecycle.updateAndTransition(active.id, "pause", { name: "Paused agent" })).toMatchObject({ name: "Paused agent", lifecycleState: "pausing" });
  });

  it("preserves a disabled positive budget at approval and applies explicit configuration changes", async () => {
    const agent = await hire("pending_approval");
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "agent", scopeId: agent.id, amount: 1000, isActive: false }, null);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      payload: { agentId: agent.id, budgetMonthlyCents: 1000 }, status: "pending" });
    const policy = async () => (await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, agent.id)))[0]!;
    await approvalService(db).approve(approval.id, "board");
    expect(await policy()).toMatchObject({ amount: 1000, isActive: false });
    await agentConfiguration(db).update(agent.id, { budgetMonthlyCents: 2000 });
    expect(await policy()).toMatchObject({ amount: 2000, isActive: true });
    await agentConfiguration(db).update(agent.id, { budgetMonthlyCents: 0 });
    expect(await policy()).toMatchObject({ amount: 0, isActive: false });
  });

  it("limits invocation policy checks to the requested agent", async () => {
    const one = await hire();
    const two = await createAgentLifecycle(db).requestHire(companyId, { name: "Another agent" });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    await budgetService(db).getInvocationBlock(companyId, one.id);
    expect((await current(one.id)).lifecycleHolds).toContain("company_paused");
    expect((await current(two.id)).lifecycleHolds).toEqual([]);
  });

  it("keeps a manual hold when company policy changes", async () => {
    const work = worker(); const lifecycle = createAgentLifecycle(db); const agent = await hire(); await work.process(agent.id);
    await lifecycle.pauseAgent(agent.id); await work.process(agent.id);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await createAgentLifecycle(db).reconcilePolicyHolds(companyId); await work.process(agent.id);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));
    await createAgentLifecycle(db).reconcilePolicyHolds(companyId); await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["manual"] });
    await lifecycle.resumeAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("defers automatic policy changes while a task holds the agent lock", async () => {
    const agent = await hire("paused");
    await db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, agent.id)).for("update");
      expect(await createLifecycleStore(db).change(agent.id, "reconcile")).toBeNull();
    });
    expect(await createLifecycleStore(db).change(agent.id, "reconcile")).not.toBeNull();
  });

  it("retains the failed phase and the same operation for retry", async () => {
    let fail = true;
    const work = worker(async agent => { if (agent.lifecycleState === "verifying" && fail) throw new Error("private detail"); return "complete"; });
    const agent = await hire(); await work.process(agent.id);
    const failed = await current(agent.id);
    expect(failed.lifecycleState).toBe("verifying");
    expect(failed.lifecycleError).not.toContain("private detail");
    fail = false;
    await createAgentLifecycle(db).retry(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("fences a late completion when termination replaces preparation", async () => {
    const agent = await hire("paused");
    const store = createLifecycleStore(db);
    await createAgentLifecycle(db).resumeAgent(agent.id);
    const claimed = await store.claim(agent.id, "old", new Date());
    expect(claimed).not.toBeNull();
    await store.setRequiredPlugins(claimed!, "old", []);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    expect(await store.completeHost(claimed!, "old")).toBe(false);
    expect(await store.change(agent.id, "complete", { owner: "old", version: claimed!.lifecycleVersion })).toBeNull();
    expect((await current(agent.id)).lifecycleState).toBe("terminating");
  });

  it("revokes keys at termination and waits for cleanup before deletion", async () => {
    let pending = true;
    const phases: string[] = [];
    const work = worker(async agent => { phases.push(agent.lifecycleState); return agent.lifecycleState === "cleaning_up" && pending ? "pending" : "complete"; });
    const lifecycle = createAgentLifecycle(db); const agent = await hire(); await work.process(agent.id);
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId, name: "Test", keyHash: randomUUID() });
    await lifecycle.terminateAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("cleaning_up");
    expect((await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id)))[0].revokedAt).not.toBeNull();
    await expect(agentConfiguration(db).remove(agent.id)).rejects.toThrow("Complete termination");
    pending = false; await lifecycle.retry(agent.id); await work.process(agent.id);
    expect(phases).toContain("terminating");
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    await agentConfiguration(db).remove(agent.id);
    expect(await current(agent.id)).toBeUndefined();
  });

  it("retains required plugin IDs and checks the operation and company on each reply", async () => {
    const agent = await hire("paused");
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "lifecycle-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete" }));
    const driver = createLifecycleDriver(db, { call } as never);
    const snapshot = (await createLifecycleStore(db).get(agent.id))!;
    expect(await driver.requiredPluginIds(snapshot)).toContain(pluginId);
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    expect(await driver.requiredPluginIds(snapshot)).not.toContain(pluginId);
    expect(await driver.requiredPluginIds({ ...snapshot, lifecycleRequiredPluginIds: [pluginId] })).toContain(pluginId);
    await expect(driver.runPlugin(snapshot, pluginId)).rejects.toThrow("unavailable");
    await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.pluginId, pluginId));
    expect(await driver.runPlugin(snapshot, pluginId)).toBe("complete");
    expect(call).toHaveBeenCalledWith(pluginId, "agentLifecycle", { companyId, agentId: agent.id,
      operationId: snapshot.lifecycleOperation!.id, version: snapshot.lifecycleVersion, phase: "paused" }, 30_000);
    call.mockResolvedValueOnce({ operationId: "stale", version: snapshot.lifecycleVersion, status: "complete" });
    await expect(driver.runPlugin(snapshot, pluginId)).rejects.toThrow("Invalid lifecycle result");
  });

  it("keeps host completion and required plugin results across a worker restart", async () => {
    const pluginIds = [randomUUID(), randomUUID()];
    const runHost = vi.fn(async () => "complete" as const);
    const firstPlugin = vi.fn(async (_agent: LifecycleAgent, pluginId: string) =>
      pluginId === pluginIds[0] ? "complete" as const : "pending" as const);
    const first = configureAgentLifecycle(db, { requiredPluginIds: async () => pluginIds, runHost, runPlugin: firstPlugin });
    workers.push(first);
    const agent = await hire();
    await first.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "preparing", lifecycleRequiredPluginIds: pluginIds,
      lifecycleOperation: { hostComplete: true, completedPluginIds: [pluginIds[0]] } });
    await first.stop();

    const discover = vi.fn(async () => []);
    const resumedPlugin = vi.fn(async (_agent: LifecycleAgent, _pluginId: string) => "complete" as const);
    const resumed = configureAgentLifecycle(db, { requiredPluginIds: discover, runHost, runPlugin: resumedPlugin });
    workers.push(resumed);
    await createAgentLifecycle(db).retry(agent.id);
    await resumed.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
    expect(discover).not.toHaveBeenCalled();
    expect(runHost).toHaveBeenCalledTimes(2);
    expect(resumedPlugin.mock.calls.map(call => call[1])).toEqual([pluginIds[1], ...pluginIds]);
  });

  it("requires host and plugin completion and freezes the selected plugin IDs", async () => {
    const agent = await hire();
    const store = createLifecycleStore(db);
    const claimed = (await store.claim(agent.id, "test", new Date()))!;
    const pluginId = randomUUID();
    expect(await store.setRequiredPlugins(claimed, "test", [pluginId])).toBe(true);
    expect(await store.setRequiredPlugins(claimed, "test", [])).toBe(false);
    expect(await store.completePlugin(claimed, "test", randomUUID())).toBe(false);
    const complete = () => store.change(agent.id, "complete", { owner: "test", version: claimed.lifecycleVersion });
    expect(await complete()).toBeNull();
    expect(await store.completePlugin(claimed, "test", pluginId)).toBe(true);
    expect(await complete()).toBeNull();
    expect(await store.completeHost(claimed, "test")).toBe(true);
    expect(await complete()).toMatchObject({ lifecycleState: "verifying" });
    expect(await store.completePlugin(claimed, "test", pluginId)).toBe(false);
  });

  it("fences verification when the saved configuration changes", async () => {
    const lifecycle = createAgentLifecycle(db); const store = createLifecycleStore(db);
    const agent = await hire();
    const claimed = (await store.claim(agent.id, "configuration-test", new Date()))!;
    await store.setRequiredPlugins(claimed, "configuration-test", []);
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: "echo" } });
    expect(await store.completeHost(claimed, "configuration-test")).toBe(false);
    expect((await lifecycle.get(agent.id))!.lifecycleVersion).toBeGreaterThan(claimed.lifecycleVersion);
  });

  it("rolls back configuration and verification invalidation in the credential transaction", async () => {
    const agent = await hire();
    const before = await current(agent.id);
    await expect(invalidateAgentVerification(db, agent.id)).rejects.toThrow("configuration transaction");
    await expect(agentConfigurationService(db).update(agent.id, { name: "Uncommitted" }, undefined, []))
      .rejects.toThrow("require a transaction");
    await expect(db.transaction(async tx => {
      await agentConfiguration(tx as unknown as Db).update(agent.id, { adapterConfig: { command: "echo" } });
      expect((await tx.select().from(agents).where(eq(agents.id, agent.id)))[0].lifecycleVersion).toBe(before.lifecycleVersion + 1);
      throw new Error("Credential change failed");
    })).rejects.toThrow("Credential change failed");
    expect(await current(agent.id)).toMatchObject({ adapterConfig: before.adapterConfig,
      lifecycleVersion: before.lifecycleVersion, lifecycleOperation: before.lifecycleOperation });
  });

  it("permits a board retry and rejects an agent or a different company", async () => {
    const agent = await hire();
    function app(actor: Express.Request["actor"]) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", agentRoutes(db)); app.use(errorHandler); return app;
    }
    const board: Express.Request["actor"] = { type: "board", source: "session", userId: "board", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }] };
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "admin" });
    await db.insert(principalPermissionGrants).values(["agents:create", "agents:configure"].map(permissionKey => ({ companyId, principalType: "user", principalId: "board", permissionKey })));
    const url = `/api/agents/${agent.id}/lifecycle/retry`;
    const response = await request(app(board)).post(url).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.lifecycleState).toBe("preparing");
    expect(response.body).not.toHaveProperty("lifecycleOperation");
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.lifecycle_retried"))))
      .toEqual([expect.objectContaining({ actorType: "user", actorId: "board" })]);
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: agent.id })).post(url).send({}).expect(403);
    const denied = await request(app({ ...board, companyIds: [], memberships: [] })).post(url).send({});
    expect([403, 404]).toContain(denied.status);
  });

  it("recovers an expired lease and never accepts an expired completion", async () => {
    const agent = await hire("paused"); const store = createLifecycleStore(db);
    await createAgentLifecycle(db).resumeAgent(agent.id);
    const claim = await store.claim(agent.id, "first", new Date(Date.now() - 180_000));
    expect(claim).not.toBeNull();
    await store.setRequiredPlugins(claim!, "first", []);
    await store.completeHost(claim!, "first");
    expect(await store.change(agent.id, "complete", { owner: "first", version: claim!.lifecycleVersion })).toBeNull();
    expect(await store.claim(agent.id, "second", new Date())).not.toBeNull();
  });
});

describe("lifecycle transition rules", () => {
  it("does not bypass authorization, verification, or cleanup", () => {
    expect(() => transition("pending_approval", "resume")).toThrow();
    expect(transition("preparing", "complete")).toBe("verifying");
    expect(transition("terminating", "complete")).toBe("cleaning_up");
    expect(transition("cleaning_up", "complete")).toBe("terminated");
    expect(() => transition("terminated", "resume")).toThrow();
    expect(transition("terminating", "terminate")).toBe("terminating");
  });
});
