import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { agentApiKeys, agents, budgetPolicies, companies, costEvents, createDb, pluginCompanySettings, pluginLifecycleAcknowledgments, plugins, projects, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { budgetService } from "../services/budgets.js";
import { projectService } from "../services/projects.js";
import { recordResourceCreationEvent } from "../services/resource-lifecycle-events.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

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
  const createPlugin = async () => {
    const [plugin] = await db.insert(plugins).values({ pluginKey: randomUUID(), packageName: "lifecycle-fixture", version: "1.0.0", status: "ready", manifestJson: {} as never }).returning();
    return plugin;
  };

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
    expect(await events()).toEqual([expect.objectContaining({ action: "update", resourceId: oldProjectId })]);
    const agent = await createAgent();
    const project = await projectService(db).create(companyId, { name: "New project" });
    expect((await events()).filter(row => row.action === "create").map(row => row.resourceId).sort()).toEqual([agent.id, project.id].sort());
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

  it("captures project and workspace updates and batches repository replacement", async () => {
    const service = projectService(db);
    const project = await service.createWithRepositories(companyId, { name: "Mutable project" }, [
      { id: "1", fullName: "fixture/one", url: "https://github.com/fixture/one", connections: [] },
    ]);
    expect((await events()).map(row => row.action)).toEqual(["create"]);
    await service.update(project.id, { name: "Updated project" });
    const workspace = await service.createWorkspace(project.id, { repoUrl: "https://github.com/fixture/two" });
    await service.updateWorkspace(project.id, workspace!.id, { repoRef: "main" });
    await service.removeWorkspace(project.id, workspace!.id);
    const beforeReplace = (await events()).length;
    await service.replaceRepositories(project.id, [
      { id: "3", fullName: "fixture/three", url: "https://github.com/fixture/three", connections: [] },
      { id: "4", fullName: "fixture/four", url: "https://github.com/fixture/four", connections: [] },
    ]);
    expect(await events()).toHaveLength(beforeReplace + 1);
    const beforeArchive = await events();
    expect((await service.getById(project.id))?.workspaces).toHaveLength(2);
    expect(beforeArchive.sort((a, b) => a.id - b.id).map(row => row.action)).toEqual(["create", "update", "update", "update", "update", "update"]);
  });

  it("records archive once per transition and update on restore, retaining repositories", async () => {
    const service = projectService(db);
    const project = await service.createWithRepositories(companyId, { name: "Archive fixture" }, [
      { id: "1", fullName: "fixture/one", url: "https://github.com/fixture/one", connections: [] },
    ]);
    await Promise.all([
      service.update(project.id, { archivedAt: new Date(), name: undefined }),
      service.update(project.id, { archivedAt: new Date() }),
    ]);
    expect((await events()).map(row => row.action)).toEqual(["create", "archive"]);
    expect((await service.getById(project.id))?.workspaces).toHaveLength(1);
    await service.update(project.id, { archivedAt: null });
    await service.update(project.id, { archivedAt: null });
    await service.update(project.id, { archivedAt: new Date(), name: "Edited and archived" });
    expect((await events()).sort((a, b) => a.id - b.id).map(row => row.action))
      .toEqual(["create", "archive", "update", "update", "archive"]);
  });

  it("rolls back archive and combined edits when the archive record fails", async () => {
    const service = projectService(db);
    const project = await service.create(companyId, { name: "Retained project" });
    const before = await events();
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_archive CHECK (action <> 'archive') NOT VALID`);
    try {
      await expect(service.update(project.id, { archivedAt: new Date(), name: "Rejected edit" })).rejects.toThrow();
      expect(await service.getById(project.id)).toMatchObject({ name: "Retained project", archivedAt: null });
      expect(await events()).toEqual(before);
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_archive`);
    }
  });

  it("rolls back project and repository mutations when their update record fails", async () => {
    const service = projectService(db);
    const project = await service.create(companyId, { name: "Retained project" });
    const workspace = await service.createWorkspace(project.id, { repoUrl: "https://github.com/fixture/retained" });
    const before = await events();
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_update CHECK (action <> 'update') NOT VALID`);
    try {
      await expect(service.update(project.id, { name: "Rejected update" })).rejects.toThrow();
      await expect(service.createWorkspace(project.id, { repoUrl: "https://github.com/fixture/rejected" })).rejects.toThrow();
      await expect(service.updateWorkspace(project.id, workspace!.id, { repoRef: "rejected" })).rejects.toThrow();
      await expect(service.removeWorkspace(project.id, workspace!.id)).rejects.toThrow();
      await expect(service.replaceRepositories(project.id, [])).rejects.toThrow();
      expect(await service.getById(project.id)).toMatchObject({ name: "Retained project", workspaces: [expect.objectContaining({ id: workspace!.id, repoRef: null })] });
      expect(await events()).toEqual(before);
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_update`);
    }
  });

  const backfillBaseline = () => db.transaction(async tx => {
    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0301_whole_venom.sql", import.meta.url), "utf8");
    const lock = migration.split("--> statement-breakpoint")[0];
    const baseline = migration.slice(migration.indexOf("-- Seed a one-time current-state baseline"));
    for (const statement of [lock, ...baseline.split("--> statement-breakpoint")]) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
  });

  it("backfills a current-state baseline once without bypassing approval or reordering partial histories", async () => {
    const [live, paused, terminated, pending, partial, resumed] = await db.insert(agents).values([
      { companyId, name: "Legacy live", status: "idle" },
      { companyId, name: "Legacy paused", status: "paused" },
      { companyId, name: "Legacy terminated", status: "terminated" },
      { companyId, name: "Legacy pending", status: "pending_approval" },
      { companyId, name: "Partial pause", status: "paused" },
      { companyId, name: "Partial resume", status: "idle" },
    ]).returning();
    const [archived] = await db.insert(projects).values({ companyId, name: "Archived baseline", archivedAt: new Date(0) }).returning();
    const existing = await createAgent();
    const [earlyPause] = await db.insert(resourceLifecycleEvents).values([
      { companyId, resourceType: "agent", resourceId: partial.id, action: "pause" },
      { companyId, resourceType: "agent", resourceId: resumed.id, action: "pause" },
    ]).returning();
    const deletedId = randomUUID();
    const [deleted] = await db.insert(resourceLifecycleEvents).values({ companyId, resourceType: "agent", resourceId: deletedId, action: "terminate" }).returning();
    await backfillBaseline();
    const baseline = (await events()).sort((a, b) => a.id - b.id);
    const actions = (id: string) => baseline.filter(e => e.resourceId === id).map(e => e.action);
    expect(actions(live.id)).toEqual(["create"]);
    expect(actions(paused.id)).toEqual(["create", "pause"]);
    expect(actions(terminated.id)).toEqual(["terminate"]);
    expect(actions(pending.id)).toEqual([]);
    expect(actions(partial.id)).toEqual(["pause", "create"]);
    expect(actions(resumed.id)).toEqual(["pause", "create", "resume"]);
    expect(actions(archived.id)).toEqual(["create"]);
    expect(actions(existing.id)).toEqual(["create"]);
    expect(baseline.find(e => e.id === deleted.id)).toEqual(deleted);
    const plugin = await createPlugin();
    const inbox = pluginLifecycleInbox(db, plugin.id);
    const creation = (await inbox.list(companyId)).find(e => e.resourceId === partial.id)!;
    expect(creation.action).toBe("create");
    expect(Number(creation.id)).toBeGreaterThan(earlyPause.id);
    await expect(inbox.acknowledge(companyId, String(earlyPause.id))).rejects.toMatchObject({ status: 409 });
    await inbox.acknowledge(companyId, creation.id);
    expect((await inbox.list(companyId)).find(e => e.resourceId === partial.id)).toMatchObject({ id: String(earlyPause.id), action: "pause" });
    await backfillBaseline();
    expect((await events()).sort((a, b) => a.id - b.id)).toEqual(baseline);
  });

  it("keeps delivery unavailable when the baseline migration fails", async () => {
    await db.insert(agents).values({ companyId, name: "Legacy paused", status: "paused" });
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ALTER COLUMN id DROP IDENTITY`);
    await db.execute(sql`DROP TABLE plugin_lifecycle_acknowledgments`);
    await db.execute(sql`DROP INDEX resource_lifecycle_events_resource_order_idx`);
    const applyDeliveryMigration = () => db.transaction(async tx => {
      const migration = readFileSync(new URL("../../../packages/db/src/migrations/0301_whole_venom.sql", import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
    });
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT fixture_reject_baseline CHECK (action <> 'pause') NOT VALID`);
    try {
      await expect(applyDeliveryMigration()).rejects.toMatchObject({ cause: { constraint_name: "fixture_reject_baseline" } });
      expect(await events()).toEqual([]);
      expect((await db.execute(sql`SELECT is_identity FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'resource_lifecycle_events' AND column_name = 'id'`))[0]).toMatchObject({ is_identity: "NO" });
      expect((await db.execute(sql`SELECT to_regclass('public.plugin_lifecycle_acknowledgments') AS relation`))[0]).toMatchObject({ relation: null });
    } finally {
      await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT fixture_reject_baseline`);
      await applyDeliveryMigration();
      expect((await db.execute(sql`SELECT is_identity FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'resource_lifecycle_events' AND column_name = 'id'`))[0]).toMatchObject({ is_identity: "YES" });
    }
  });

  it("retries until acknowledgment, preserves resource order, and isolates progress per plugin", async () => {
    const first = await createPlugin();
    const second = await createPlugin();
    const agent = await createAgent();
    await agentService(db).pause(agent.id);
    await agentService(db).resume(agent.id);
    const journal = (await events()).sort((a, b) => a.id - b.id);
    const inbox = pluginLifecycleInbox(db, first.id);
    const [event] = await inbox.list(companyId);
    expect(event).toMatchObject({ id: String(journal[0].id), resourceId: agent.id, action: "create" });
    expect(await pluginLifecycleInbox(db, first.id).list(companyId)).toEqual([event]);
    await expect(inbox.acknowledge(companyId, String(journal[1].id))).rejects.toMatchObject({ status: 409 });
    await Promise.all([inbox.acknowledge(companyId, event.id), inbox.acknowledge(companyId, event.id)]);
    expect(await inbox.list(companyId)).toEqual([expect.objectContaining({ action: "pause" })]);
    expect(await pluginLifecycleInbox(db, second.id).list(companyId)).toEqual([event]);
    await inbox.acknowledge(companyId, String(journal[1].id));
    await inbox.acknowledge(companyId, String(journal[2].id));
    expect(await inbox.list(companyId)).toEqual([]);
    await db.delete(plugins).where(eq(plugins.id, first.id));
    expect(await db.select().from(pluginLifecycleAcknowledgments).where(eq(pluginLifecycleAcknowledgments.pluginId, first.id))).toEqual([]);
  });

  it("pages past 100 failing resources without skipping their later events", async () => {
    const plugin = await createPlugin();
    const inbox = pluginLifecycleInbox(db, plugin.id);
    await db.insert(resourceLifecycleEvents).values(Array.from({ length: 101 }, () => ({
      companyId, resourceType: "agent" as const, resourceId: randomUUID(), action: "create" as const,
    })));
    const first = await inbox.list(companyId, 100);
    await db.insert(resourceLifecycleEvents).values({ companyId, resourceType: "agent", resourceId: first[0].resourceId, action: "pause" });
    const next = await inbox.list(companyId, 100, first.at(-1)!.id);
    expect(next).toHaveLength(1);
    expect(next[0].resourceId).not.toBe(first[0].resourceId);
    await inbox.acknowledge(companyId, next[0].id);
    expect(await inbox.list(companyId, 100, first.at(-1)!.id)).toEqual([]);
    expect(await inbox.list(companyId, 100)).toEqual(first);
    await expect(inbox.list(companyId, 100, "invalid")).rejects.toMatchObject({ status: 400 });
  });

  it("never skips a lower event id that commits after a higher id is acknowledged", async () => {
    const plugin = await createPlugin();
    const inbox = pluginLifecycleInbox(db, plugin.id);
    await db.transaction(async tx => {
      const low = await agentService(tx as unknown as Db).create(companyId, { name: "Delayed commit" });
      const high = await createAgent();
      const [visible] = await inbox.list(companyId);
      expect(visible.resourceId).toBe(high.id);
      await inbox.acknowledge(companyId, visible.id);
      expect(await inbox.list(companyId)).toEqual([]);
      expect(low.id).not.toBe(high.id);
    });
    expect(await inbox.list(companyId)).toEqual([expect.objectContaining({ action: "create" })]);
  });

  it("enforces capability, invocation company, plugin availability, and company boundaries through host RPC", async () => {
    const plugin = await createPlugin();
    await createAgent();
    const services = buildHostServices(db, plugin.id, plugin.pluginKey, createPluginEventBus());
    const handlers = createHostClientHandlers({ pluginId: plugin.id, capabilities: ["events.subscribe"], services });
    const scope = { invocationScope: { companyId } };
    try {
      await expect(handlers["events.listLifecycle"]({ companyId })).rejects.toThrow("company context");
      const other = randomUUID();
      await expect(handlers["events.listLifecycle"]({ companyId: other }, scope)).rejects.toThrow("requested company");
      const denied = createHostClientHandlers({ pluginId: plugin.id, capabilities: [], services });
      await expect(denied["events.listLifecycle"]({ companyId }, scope)).rejects.toThrow("events.subscribe");
      await expect(denied["events.acknowledgeLifecycle"]({ companyId, eventId: "1" }, scope)).rejects.toThrow("events.subscribe");
      const [event] = await handlers["events.listLifecycle"]({ companyId }, scope);
      await expect(handlers["events.acknowledgeLifecycle"]({ companyId: other, eventId: event.id }, scope)).rejects.toThrow("requested company");
      await expect(pluginLifecycleInbox(db, plugin.id).acknowledge(other, event.id)).rejects.toMatchObject({ status: 404 });
      await db.insert(pluginCompanySettings).values({ pluginId: plugin.id, companyId, enabled: false });
      await expect(handlers["events.listLifecycle"]({ companyId }, scope)).rejects.toMatchObject({ status: 403 });
      await expect(handlers["events.acknowledgeLifecycle"]({ companyId, eventId: event.id }, scope)).rejects.toMatchObject({ status: 403 });
      await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.pluginId, plugin.id));
      await expect(handlers["events.listLifecycle"]({ companyId, limit: 0 }, scope)).rejects.toMatchObject({ status: 400 });
      await expect(handlers["events.acknowledgeLifecycle"]({ companyId, eventId: "1e2" }, scope)).rejects.toMatchObject({ status: 400 });
      await handlers["events.acknowledgeLifecycle"]({ companyId, eventId: event.id }, scope);
      expect(await handlers["events.listLifecycle"]({ companyId }, scope)).toEqual([]);
      await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, plugin.id));
      await expect(handlers["events.listLifecycle"]({ companyId }, scope)).rejects.toMatchObject({ status: 403 });
    } finally {
      services.dispose();
    }
  });
});
