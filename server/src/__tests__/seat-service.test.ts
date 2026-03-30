import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  seatOccupancies,
  seats,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seatService } from "../services/seats.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres seat service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("seatService.orgForCompany", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seat-service-org-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(seatOccupancies);
    await db.delete(companyMemberships);
    await db.delete(seats);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("builds org tree from seats rather than agents.reportsTo", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent Alpha",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      },
      {
        id: agentBId,
        companyId,
        name: "Agent Beta",
        role: "engineer",
        status: "active",
        reportsTo: agentAId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [rootSeat, childSeat] = await db.insert(seats).values([
      {
        companyId,
        slug: "platform-seat",
        name: "Platform Seat",
        seatType: "manager",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: agentBId,
      },
      {
        companyId,
        slug: "executive-seat",
        name: "Executive Seat",
        seatType: "ceo",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: agentAId,
      },
    ]).returning();

    await db.update(seats).set({ parentSeatId: rootSeat.id }).where(eq(seats.id, childSeat.id));

    await db.update(agents).set({ seatId: rootSeat.id, seatRole: "primary_agent" }).where(eq(agents.id, agentBId));
    await db.update(agents).set({ seatId: childSeat.id, seatRole: "primary_agent" }).where(eq(agents.id, agentAId));

    await db.insert(seatOccupancies).values([
      {
        companyId,
        seatId: rootSeat.id,
        occupantType: "agent",
        occupantId: agentBId,
        occupancyRole: "primary_agent",
        status: "active",
      },
      {
        companyId,
        seatId: childSeat.id,
        occupantType: "agent",
        occupantId: agentAId,
        occupancyRole: "primary_agent",
        status: "active",
      },
    ]);

    const tree = await seatService(db).orgForCompany(companyId);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe(agentBId);
    expect(tree[0]?.name).toBe("Platform Seat");
    expect(tree[0]?.role).toBe("engineer");
    expect(tree[0]?.reports).toHaveLength(1);
    expect(tree[0]?.reports[0]?.id).toBe(agentAId);
    expect(tree[0]?.reports[0]?.name).toBe("Executive Seat");
    expect(tree[0]?.reports[0]?.role).toBe("ceo");
  });

  it("attaches and detaches a human operator, updating mode and falling back open work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Primary Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [seat] = await db.insert(seats).values({
      companyId,
      slug: "primary-seat",
      name: "Primary Seat",
      seatType: "individual",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: agentId,
    }).returning();

    await db.update(agents).set({ seatId: seat.id, seatRole: "primary_agent" }).where(eq(agents.id, agentId));
    await db.insert(seatOccupancies).values({
      companyId,
      seatId: seat.id,
      occupantType: "agent",
      occupantId: agentId,
      occupancyRole: "primary_agent",
      status: "active",
    });

    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Human-owned issue",
      status: "todo",
      priority: "medium",
      ownerSeatId: seat.id,
      assigneeUserId: userId,
    }).returning();

    const svc = seatService(db);
    const attached = await svc.attachHuman(companyId, seat.id, userId);
    expect(attached.operatingMode).toBe("assisted");
    expect(attached.currentHumanUserId).toBe(userId);

    const detached = await svc.detachHuman(companyId, seat.id, userId);
    expect(detached.operatingMode).toBe("vacant");
    expect(detached.currentHumanUserId).toBeNull();
    expect(detached.fallbackReassignedIssueCount).toBe(1);

    const updatedIssue = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAgentId).toBe(agentId);
    expect(updatedIssue?.assigneeUserId).toBeNull();
  });

  it("reads and updates delegated permissions on a seat", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Primary Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [seat] = await db.insert(seats).values({
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      seatType: "manager",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: agentId,
      metadata: {
        delegatedPermissions: ["tasks:assign"],
        custom: "keep-me",
      },
    }).returning();

    const svc = seatService(db);
    const detail = await svc.getDetail(companyId, seat.id);
    expect(detail?.delegatedPermissions).toEqual(["tasks:assign"]);

    const updated = await svc.updateDelegatedPermissions(companyId, seat.id, ["users:invite", "tasks:assign"]);
    expect(updated?.delegatedPermissions).toEqual(["users:invite", "tasks:assign"]);

    const persisted = await db.select().from(seats).where(eq(seats.id, seat.id)).then((rows) => rows[0] ?? null);
    expect((persisted?.metadata as Record<string, unknown>)?.custom).toBe("keep-me");
    expect((persisted?.metadata as Record<string, unknown>)?.delegatedPermissions).toEqual(["users:invite", "tasks:assign"]);
  });

  it("attaches a shadow agent and keeps the seat in shadowed mode while a human is attached", async () => {
    const companyId = randomUUID();
    const primaryAgentId = randomUUID();
    const shadowAgentId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    await db.insert(agents).values([
      {
        id: primaryAgentId,
        companyId,
        name: "Primary Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: shadowAgentId,
        companyId,
        name: "Shadow Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [seat] = await db.insert(seats).values({
      companyId,
      slug: "ops-seat",
      name: "Operations Seat",
      seatType: "manager",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: primaryAgentId,
    }).returning();

    await db.update(agents).set({ seatId: seat.id, seatRole: "primary_agent" }).where(eq(agents.id, primaryAgentId));
    await db.update(agents).set({ seatId: seat.id, seatRole: "shadow_agent" }).where(eq(agents.id, shadowAgentId));

    await db.insert(seatOccupancies).values({
      companyId,
      seatId: seat.id,
      occupantType: "agent",
      occupantId: primaryAgentId,
      occupancyRole: "primary_agent",
      status: "active",
    });

    const svc = seatService(db);
    await svc.attachHuman(companyId, seat.id, userId);
    const updated = await svc.attachShadowAgent(companyId, seat.id, shadowAgentId);

    expect(updated.operatingMode).toBe("shadowed");
    const activeShadow = await db
      .select()
      .from(seatOccupancies)
      .where(and(eq(seatOccupancies.seatId, seat.id), eq(seatOccupancies.occupancyRole, "shadow_agent"), eq(seatOccupancies.status, "active")))
      .then((rows) => rows[0] ?? null);
    expect(activeShadow?.occupantId).toBe(shadowAgentId);
  });
});
