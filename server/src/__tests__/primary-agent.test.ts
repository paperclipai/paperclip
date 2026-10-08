import { createAgentLifecycle } from "../modules/agent-lifecycle/index.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, userCompanyPreferences } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { primaryAgentRoutes } from "../routes/primary-agent.js";
import { agentService } from "../services/agents.js";
import { primaryAgentService } from "../services/primary-agent.js";
import { resourceMembershipService } from "../services/resource-memberships.js";
import { activityRoutes } from "../routes/activity.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Primary agent database tests unavailable: ${support.reason}`);

(support.supported ? describe : describe.skip)("personal primary agent", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-primary-agent-");
    db = createDb(temp.connectionString);
  }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });

  const actor = (companyId: string, userId = "user-a"): Express.Request["actor"] => ({
    type: "board", source: "session", userId, companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  });
  const app = (identity: Express.Request["actor"]) => {
    const result = express(); result.use(express.json());
    result.use((req, _res, next) => { req.actor = identity; next(); });
    result.use("/api", primaryAgentRoutes(db));
    result.use("/api", activityRoutes(db)); result.use(errorHandler);
    return result;
  };
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Primary test", issuePrefix: `P${id.slice(0, 7)}` });
    await db.insert(companyMemberships).values(["user-a", "user-b", "explicit"].map(principalId => ({ companyId: id, principalType: "user", principalId, status: "active", membershipRole: "admin" })));
    return id;
  }
  const create = (companyId: string, name: string, userId?: string) => createAgentLifecycle(db).requestHire(companyId, {
    name, adapterType: "process", status: "idle",
  }, { createdByUserId: userId });
  const get = (companyId: string, userId = "user-a") => primaryAgentService(db).get(companyId, userId);
  const url = (companyId: string) => `/api/companies/${companyId}/primary-agent/me`;

  it("automatically crowns the first human creation, ignoring provisioned and agent-authored creations", async () => {
    const c = await company();
    await create(c, "System"); await create(c, "Agent hire");
    expect(await get(c)).toMatchObject({ primaryAgentId: null, initialized: false });
    const first = await create(c, "Maia", "user-a");
    await create(c, "Alex", "user-a");
    expect(await get(c)).toMatchObject({ primaryAgentId: first.id, initialized: true });
  });

  it("arbitrates simultaneous human creations and cannot overwrite an explicit choice", async () => {
    const c = await company();
    const created = await Promise.all([create(c, "Maia", "user-a"), create(c, "Alex", "user-a")]);
    const preference = await get(c);
    expect(created.map(a => a.id)).toContain(preference.primaryAgentId);
    expect(await db.select().from(userCompanyPreferences).where(and(eq(userCompanyPreferences.companyId, c), eq(userCompanyPreferences.userId, "user-a")))).toHaveLength(1);
    const selected = created.find(a => a.id !== preference.primaryAgentId)!;
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: selected.id }).expect(200);
    await create(c, "Later", "user-a");
    expect((await get(c)).primaryAgentId).toBe(selected.id);
  });

  it("isolates company/user preferences, including trusted local board, and rejects untrusted identity fields", async () => {
    const c = await company(), other = await company();
    const a = await create(c, "Maia", "user-a"), b = await create(c, "Alex", "user-b");
    const elsewhere = await create(other, "Elsewhere", "user-a");
    expect((await request(app(actor(c))).get(url(c)).expect(200)).body.primaryAgentId).toBe(a.id);
    expect((await request(app(actor(c, "user-b"))).get(url(c)).expect(200)).body.primaryAgentId).toBe(b.id);
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: elsewhere.id }).expect(404);
    await request(app(actor(c))).get(url(other)).expect(403);
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: b.id, userId: "user-b" }).expect(400);
    await request(app({ type: "agent", source: "agent_key", agentId: a.id, companyId: c })).put(url(c)).send({ primaryAgentId: b.id }).expect(403);
    const local: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
    await request(app(local)).put(url(c)).send({ primaryAgentId: b.id }).expect(200);
    expect((await get(c, "local-board")).primaryAgentId).toBe(b.id);
    expect((await get(other, "local-board")).primaryAgentId).toBeNull();
    expect((await get(c)).primaryAgentId).toBe(a.id);
  });

  it("serializes competing explicit choices and leave races", async () => {
    const c = await company();
    await create(c, "Maia", "user-a");
    const a = await create(c, "Alex"), b = await create(c, "River");
    const service = primaryAgentService(db);
    await Promise.all([service.set(c, "user-a", a.id, actor(c)), service.set(c, "user-a", b.id, actor(c))]);
    const current = (await get(c)).primaryAgentId;
    const updates = await db.select().from(activityLog).where(and(eq(activityLog.companyId, c), eq(activityLog.action, "primary_agent.updated")));
    expect(updates).toHaveLength(2);
    expect([a.id, b.id]).toContain(current);
    await Promise.all([
      service.set(c, "user-a", a.id, actor(c)),
      resourceMembershipService(db).updateAgent({ companyId: c, userId: "user-a", agentId: a.id, state: "left", actor: actor(c) }),
    ]);
    const memberships = await resourceMembershipService(db).listForUser(c, "user-a", actor(c));
    expect((await get(c)).primaryAgentId).toBe(memberships.agentMemberships[a.id] === "left" ? null : a.id);
  });

  it("audits preference changes without exposing the selection through company activity", async () => {
    const c = await company();
    const first = await create(c, "Maia", "user-a"), next = await create(c, "Alex");
    await primaryAgentService(db).set(c, "user-a", next.id, actor(c));
    await resourceMembershipService(db).updateAgent({ companyId: c, userId: "user-a", agentId: next.id, state: "left", actor: actor(c) });
    const response = await request(app(actor(c, "user-b"))).get(`/api/companies/${c}/activity`).expect(200);
    const events = response.body.filter((event: { action: string }) => event.action.startsWith("primary_agent."));
    expect(events.map((event: { action: string }) => event.action).sort()).toEqual([
      "primary_agent.cleared", "primary_agent.initialized", "primary_agent.updated",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ entityType: "user_preference", entityId: "user-a", agentId: null, details: null });
      expect(JSON.stringify(event)).not.toContain(first.id);
      expect(JSON.stringify(event)).not.toContain(next.id);
    }
  });

  it("retains paused/error primaries, clears on leave, rejoins when chosen, and preserves stars", async () => {
    const c = await company(); const a = await create(c, "Maia", "user-a");
    await createAgentLifecycle(db).pauseAgent(a.id);
    expect((await get(c)).primaryAgentId).toBe(a.id);
    await db.update(agents).set({ status: "error", lifecycleState: "ready", lifecycleHolds: [] }).where(eq(agents.id, a.id));
    expect((await get(c)).primaryAgentId).toBe(a.id);
    const memberships = resourceMembershipService(db);
    await memberships.updateAgent({ companyId: c, userId: "user-a", agentId: a.id, state: "left", actor: actor(c) });
    expect(await get(c)).toMatchObject({ primaryAgentId: null, initialized: true });
    await create(c, "Later", "user-a");
    expect((await get(c)).primaryAgentId).toBeNull();
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: a.id }).expect(200);
    expect((await memberships.listForUser(c, "user-a", actor(c))).agentMemberships[a.id]).toBe("joined");
    await memberships.updateAgent({ companyId: c, userId: "user-a", agentId: a.id, starred: true, actor: actor(c) });
    const b = await create(c, "Alex");
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: b.id }).expect(200);
    expect((await memberships.listForUser(c, "user-a", actor(c))).starredAgentIds).toContain(a.id);
  });

  it("allows viewers to choose their own primary without granting company write permissions", async () => {
    const c = await company(); const a = await create(c, "Maia");
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, c), eq(companyMemberships.principalId, "user-a")));
    const viewer = { ...actor(c), memberships: [{ companyId: c, membershipRole: "viewer" as const, status: "active" as const }] };
    await request(app(viewer)).put(url(c)).send({ primaryAgentId: a.id }).expect(200);
    expect((await get(c)).primaryAgentId).toBe(a.id);
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, c), eq(companyMemberships.principalId, "user-a")));
    expect(membership.membershipRole).toBe("viewer");
    await request(app({ ...viewer, memberships: [] })).get(url(c)).expect(403);
  });

  it("clears terminated/deleted primaries and rejects terminated targets and explicit removal", async () => {
    const c = await company(); const a = await create(c, "Maia", "user-a");
    await createAgentLifecycle(db).terminateAgent(a.id);
    expect(await get(c)).toMatchObject({ primaryAgentId: null, initialized: true });
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: a.id }).expect(422);
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: null }).expect(400);
    const b = await create(c, "Alex", "user-a");
    expect((await get(c)).primaryAgentId).toBeNull();
    await request(app(actor(c))).put(url(c)).send({ primaryAgentId: b.id }).expect(200);
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, b.id));
    await createAgentLifecycle(db).purgeAgent(b.id);
    expect(await get(c)).toMatchObject({ primaryAgentId: null, initialized: true });
  });

  it("rejects creation inside a caller transaction", async () => {
    const c = await company();
    await expect(db.transaction(async tx => {
      await createAgentLifecycle(tx as unknown as typeof db).requestHire(c, { name: "Rolled back", adapterType: "process" }, { createdByUserId: "user-a" });
      throw new Error("rollback");
    })).rejects.toThrow("root database");
    expect(await get(c)).toMatchObject({ primaryAgentId: null, initialized: false });
    expect(await db.select().from(agents).where(eq(agents.companyId, c))).toHaveLength(0);
  });

  it("backfills the earliest human event, leaves gone/terminated originals empty, and preserves explicit preferences", async () => {
    const c = await company(); const first = await create(c, "First"), later = await create(c, "Later");
    const terminated = await create(c, "Terminated");
    await createAgentLifecycle(db).terminateAgent(terminated.id);
    const events = [
      ["human", first.id, "user", 1], ["human", later.id, "user", 2],
      ["gone", randomUUID(), "user", 1], ["gone", later.id, "user", 2],
      ["retired", terminated.id, "user", 1], ["retired", later.id, "user", 2],
      ["system", later.id, "system", 0], [first.id, later.id, "agent", 0],
      ["board", later.id, "user", 0], ["explicit", first.id, "user", 0],
    ] as const;
    for (const [actorId, entityId, actorType, day] of events) await db.insert(activityLog).values({
      companyId: c, actorId, actorType, entityId, entityType: "agent", action: "agent.created", createdAt: new Date(2020, 0, day + 1),
    });
    await request(app(actor(c, "explicit"))).put(url(c)).send({ primaryAgentId: later.id }).expect(200);
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0315_rapid_emma_frost.sql", import.meta.url), "utf8");
    // Replay the whole migration twice: an already migrated preview instance
    // must retain its explicit preferences when upgrading to the merged build.
    for (let replay = 0; replay < 2; replay++) {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.execute(sql.raw(statement));
      }
    }
    expect((await get(c, "human")).primaryAgentId).toBe(first.id);
    expect(await get(c, "gone")).toMatchObject({ primaryAgentId: null, initialized: true });
    expect(await get(c, "retired")).toMatchObject({ primaryAgentId: null, initialized: true });
    expect((await get(c, "explicit")).primaryAgentId).toBe(later.id);
    for (const user of ["system", "board", first.id]) expect((await get(c, user)).initialized).toBe(false);
  });
});
