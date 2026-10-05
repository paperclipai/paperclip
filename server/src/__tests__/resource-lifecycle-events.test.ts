import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agentApiKeys, agents, budgetPolicies, companies, costEvents, createDb, projects, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { budgetService } from "../services/budgets.js";
import { projectService } from "../services/projects.js";
import { recordResourceCreationEvent } from "../services/resource-lifecycle-events.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping lifecycle event database tests: ${support.reason}`);

describePostgres("Resource lifecycle events", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resource-events-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle fixture", issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 6)}` });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  const events = () => db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId));
  const createAgent = (status: "idle" | "pending_approval" | "terminated" = "idle", database: Db = db) =>
    agentService(database).create(companyId, { name: "Lifecycle agent", adapterType: "process", adapterConfig: {}, status });

  it("records direct and approval-free hires once, including concurrent duplicate submissions", async () => {
    const agent = await createAgent();
    await Promise.all(Array.from({ length: 5 }, () => recordResourceCreationEvent(db, companyId, "agent", agent.id)));
    expect(await events()).toEqual([expect.objectContaining({ resourceType: "agent", resourceId: agent.id, action: "create" })]);
  });

  it("records pending hires only after approval and ignores repeated approval", async () => {
    const agent = await createAgent("pending_approval");
    expect(await events()).toEqual([]);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", status: "pending", payload: { agentId: agent.id } });
    await approvalService(db).approve(approval.id, "fixture-board");
    await approvalService(db).approve(approval.id, "fixture-board");
    await agentService(db).activatePendingApproval(agent.id);
    expect(await events()).toEqual([expect.objectContaining({ resourceType: "agent", resourceId: agent.id })]);
  });

  it("records legacy approvals that create the agent at approval time", async () => {
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", status: "pending", payload: { name: "Legacy hire", adapterType: "process" } });
    await approvalService(db).approve(approval.id, "fixture-board");
    const [intent] = await events();
    expect(intent?.resourceType).toBe("agent");
    expect(await agentService(db).getById(intent!.resourceId)).toMatchObject({ status: "idle", companyId });
  });

  it("does not allocate for rejected or terminated hires", async () => {
    const agent = await createAgent("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", status: "pending", payload: { agentId: agent.id } });
    await approvalService(db).reject(approval.id, "fixture-board");
    await createAgent("terminated");
    expect(await events()).toEqual([expect.objectContaining({ action: "terminate", resourceId: agent.id })]);
  });

  it("rolls back hire rejection if termination cannot record its hook, allowing a retry", async () => {
    const agent = await createAgent("pending_approval");
    const service = approvalService(db);
    const approval = await service.create(companyId, { type: "hire_agent", status: "pending", payload: { agentId: agent.id } });
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_hook CHECK (false) NOT VALID`);
    try {
      await expect(service.reject(approval.id, "fixture-board")).rejects.toThrow();
      expect(await service.getById(approval.id)).toMatchObject({ status: "pending" });
      expect(await agentService(db).getById(agent.id)).toMatchObject({ status: "pending_approval" });
      expect(await events()).toEqual([]);
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_hook`);
    }
    expect(await service.reject(approval.id, "fixture-board")).toMatchObject({ applied: true, approval: { status: "rejected" } });
    expect(await agentService(db).getById(agent.id)).toMatchObject({ status: "terminated" });
    expect(await service.reject(approval.id, "fixture-board")).toMatchObject({ applied: false });
    expect(await events()).toEqual([expect.objectContaining({ action: "terminate", resourceId: agent.id })]);
  });

  it("records projects with zero or multiple repository workspaces without storing repository data", async () => {
    const empty = await projectService(db).create(companyId, { name: "Empty project" });
    const project = await projectService(db).createWithRepositories(companyId, { name: "Repository project" }, [
      { id: "1", fullName: "fixture/one", url: "https://github.com/fixture/one", connections: [] },
      { id: "2", fullName: "fixture/two", url: "https://github.com/fixture/two", connections: [] },
    ]);
    expect(project.workspaces).toHaveLength(2);
    const rows = await events();
    expect(rows.map(row => row.resourceId).sort()).toEqual([empty.id, project.id].sort());
    expect(rows.every(row => row.resourceType === "project")).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
  });

  it("records every pause/resume cycle and termination in resource order, without duplicate hooks", async () => {
    const agent = await createAgent();
    const service = agentService(db);
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId, name: "Lifecycle key", keyHash: "fixture-hash" });
    await Promise.all(Array.from({ length: 4 }, () => service.pause(agent.id)));
    await Promise.all(Array.from({ length: 4 }, () => service.resume(agent.id)));
    await service.update(agent.id, { status: "paused" });
    await service.update(agent.id, { status: "idle" });
    await Promise.all(Array.from({ length: 4 }, () => service.terminate(agent.id)));
    const rows = (await events()).sort((a, b) => a.id - b.id);
    expect(rows.map(row => row.action)).toEqual(["create", "pause", "resume", "pause", "resume", "terminate"]);
    expect(rows.every(row => row.resourceId === agent.id)).toBe(true);
    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id));
    expect(key.revokedAt).not.toBeNull();
    await expect(service.pause(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.resume(agent.id)).rejects.toMatchObject({ status: 409 });
  });

  it("does not bypass pending hire approval with pause or resume", async () => {
    const agent = await createAgent("pending_approval");
    await expect(agentService(db).pause(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(agentService(db).resume(agent.id)).rejects.toMatchObject({ status: 409 });
    expect(await events()).toEqual([]);
  });

  it("records budget pause and resume hooks without replaying repeated budget evaluation", async () => {
    const agent = await createAgent();
    const service = budgetService(db);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, notifyEnabled: false });
    const [event] = await db.insert(costEvents).values({ companyId, agentId: agent.id, provider: "fixture", model: "fixture", costCents: 150, occurredAt: new Date() }).returning();
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);
    expect(await agentService(db).getById(agent.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agent.id, amount: 200 }, "fixture-board");
    expect(await agentService(db).getById(agent.id)).toMatchObject({ status: "idle", pauseReason: null });
    expect((await events()).sort((a, b) => a.id - b.id).map(row => row.action)).toEqual(["create", "pause", "resume"]);
  });

  it("rolls back pause, resume, termination, and key revocation if a hook write fails", async () => {
    const agent = await createAgent();
    const paused = await createAgent();
    await agentService(db).pause(paused.id);
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId, name: "Retained key", keyHash: "fixture-retained-hash" });
    const before = await events();
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_hook CHECK (false) NOT VALID`);
    try {
      await expect(agentService(db).pause(agent.id)).rejects.toThrow();
      await expect(agentService(db).resume(paused.id)).rejects.toThrow();
      await expect(agentService(db).terminate(agent.id)).rejects.toThrow();
      expect(await agentService(db).getById(agent.id)).toMatchObject({ status: "idle" });
      expect(await agentService(db).getById(paused.id)).toMatchObject({ status: "paused" });
      const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id));
      expect(key.revokedAt).toBeNull();
      expect(await events()).toEqual(before);
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_hook`);
    }
  });

  it("rolls back agent and project events with the outer creation transaction", async () => {
    const agentId = randomUUID();
    const projectId = randomUUID();
    await expect(db.transaction(async tx => {
      const txDb = tx as unknown as Db;
      await agentService(txDb).create(companyId, { id: agentId, name: "Rolled back agent" });
      await projectService(txDb).createWithRepositories(companyId, { id: projectId, name: "Rolled back project" }, []);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await events()).toEqual([]);
    expect(await agentService(db).getById(agentId)).toBeNull();
    expect(await projectService(db).getById(projectId)).toBeNull();
  });

  it("fails creation and activation atomically if the intent cannot be persisted", async () => {
    const pending = await createAgent("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", status: "pending", payload: { agentId: pending.id } });
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_intent CHECK (false) NOT VALID`);
    try {
      await expect(createAgent()).rejects.toThrow();
      await expect(projectService(db).create(companyId, { name: "Rejected project" })).rejects.toThrow();
      await expect(approvalService(db).approve(approval.id, "fixture-board")).rejects.toThrow();
      expect(await approvalService(db).getById(approval.id)).toMatchObject({ status: "pending" });
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual([expect.objectContaining({ id: pending.id, status: "pending_approval" })]);
      expect(await db.select().from(projects).where(eq(projects.companyId, companyId))).toEqual([]);
      expect(await events()).toEqual([]);
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_intent`);
    }
  });

  it("captures self-hosted lifecycle events without backfilling older resources", async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    const oldAgentId = randomUUID();
    const oldProjectId = randomUUID();
    await db.insert(agents).values({ id: oldAgentId, companyId, name: "Existing agent" });
    await db.insert(projects).values({ id: oldProjectId, companyId, name: "Existing project" });
    await agentService(db).update(oldAgentId, { name: "Renamed agent" });
    await projectService(db).update(oldProjectId, { name: "Renamed project" });
    expect(await events()).toEqual([]);
    const agent = await createAgent();
    const project = await projectService(db).create(companyId, { name: "New project" });
    expect((await events()).map(row => row.resourceId).sort()).toEqual([agent.id, project.id].sort());
  });

  it("scopes resource identities by company and type", async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-token");
    const id = randomUUID();
    await recordResourceCreationEvent(db, companyId, "agent", id);
    await recordResourceCreationEvent(db, companyId, "project", id);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" });
    await recordResourceCreationEvent(db, otherCompanyId, "agent", id);
    expect(await events()).toHaveLength(2);
    expect(await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, otherCompanyId))).toHaveLength(1);
    await db.delete(companies).where(eq(companies.id, otherCompanyId));
    expect(await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, otherCompanyId))).toEqual([]);
  });
});
