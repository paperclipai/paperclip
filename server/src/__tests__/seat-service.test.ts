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
    expect(attached.previousOperatingMode).toBe("vacant");
    expect(attached.operatingMode).toBe("assisted");
    expect(attached.currentHumanUserId).toBe(userId);

    const detached = await svc.detachHuman(companyId, seat.id, userId);
    expect(detached.previousOperatingMode).toBe("assisted");
    expect(detached.operatingMode).toBe("vacant");
    expect(detached.currentHumanUserId).toBeNull();
    expect(detached.fallbackReassignedIssueCount).toBe(1);

    const updatedIssue = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAgentId).toBe(agentId);
    expect(updatedIssue?.assigneeUserId).toBeNull();
  });

  it("clears assigneeUserId even when an agent assignee already exists", async () => {
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
      operatingMode: "assisted",
      defaultAgentId: agentId,
      currentHumanUserId: userId,
    }).returning();

    await db.insert(seatOccupancies).values([
      {
        companyId,
        seatId: seat.id,
        occupantType: "agent",
        occupantId: agentId,
        occupancyRole: "primary_agent",
        status: "active",
      },
      {
        companyId,
        seatId: seat.id,
        occupantType: "user",
        occupantId: userId,
        occupancyRole: "human_operator",
        status: "active",
      },
    ]);

    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Mixed assignment issue",
      status: "todo",
      priority: "medium",
      ownerSeatId: seat.id,
      assigneeAgentId: agentId,
      assigneeUserId: userId,
    }).returning();

    const detached = await seatService(db).detachHuman(companyId, seat.id, userId);
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
    expect(updated?.seat.delegatedPermissions).toEqual(["users:invite", "tasks:assign"]);
    expect(updated?.previousDelegatedPermissions).toEqual(["tasks:assign"]);

    const persisted = await db.select().from(seats).where(eq(seats.id, seat.id)).then((rows) => rows[0] ?? null);
    expect((persisted?.metadata as Record<string, unknown>)?.custom).toBe("keep-me");
    expect((persisted?.metadata as Record<string, unknown>)?.delegatedPermissions).toEqual(["users:invite", "tasks:assign"]);
  });

  it("surfaces pause ownership for paused seats", async () => {
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

    const [manualSeat, maintenanceSeat] = await db.insert(seats).values([
      {
        companyId,
        slug: "manual-seat",
        name: "Manual Seat",
        seatType: "manager",
        status: "paused",
        operatingMode: "vacant",
        defaultAgentId: agentId,
      },
      {
        companyId,
        slug: "maintenance-seat",
        name: "Maintenance Seat",
        seatType: "manager",
        status: "paused",
        operatingMode: "vacant",
        defaultAgentId: agentId,
        metadata: {
          pause: {
            reason: "maintenance",
            reasons: ["maintenance"],
          },
        },
      },
    ]).returning();

    const svc = seatService(db);
    expect(await svc.getDetail(companyId, manualSeat.id)).toMatchObject({
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin"],
    });
    expect(await svc.getDetail(companyId, maintenanceSeat.id)).toMatchObject({
      pauseReason: "maintenance",
      pauseReasons: ["maintenance"],
    });
  });

  it("allows operators to pause and resume a seat with manual reasons", async () => {
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
    }).returning();

    const svc = seatService(db);
    const paused = await svc.pauseSeat(companyId, seat.id, "manual_admin");
    expect(paused).toMatchObject({
      status: "paused",
      pauseReason: "manual_admin",
      pauseReasons: ["manual_admin"],
    });

    const resumed = await svc.resumeSeat(companyId, seat.id, null);
    expect(resumed).toMatchObject({
      status: "active",
      pauseReason: null,
      pauseReasons: [],
    });
  });

  it("only clears operator-owned pause reasons when resuming a stacked paused seat", async () => {
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
      slug: "paused-seat",
      name: "Paused Seat",
      seatType: "manager",
      status: "paused",
      operatingMode: "vacant",
      defaultAgentId: agentId,
      metadata: {
        pause: {
          reason: "manual_admin",
          reasons: ["manual_admin", "budget_enforcement"],
        },
        budgetPause: {
          source: "budget",
          pausedAt: "2026-03-31T00:00:00.000Z",
        },
      },
    }).returning();

    const resumed = await seatService(db).resumeSeat(companyId, seat.id, null);
    expect(resumed).toMatchObject({
      status: "paused",
      pauseReason: "budget_enforcement",
      pauseReasons: ["budget_enforcement"],
    });
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

    expect(updated.previousOperatingMode).toBe("assisted");
    expect(updated.operatingMode).toBe("shadowed");
    const activeShadow = await db
      .select()
      .from(seatOccupancies)
      .where(and(eq(seatOccupancies.seatId, seat.id), eq(seatOccupancies.occupancyRole, "shadow_agent"), eq(seatOccupancies.status, "active")))
      .then((rows) => rows[0] ?? null);
    expect(activeShadow?.occupantId).toBe(shadowAgentId);
  });

  it("detaches a shadow agent and returns the seat to assisted mode", async () => {
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
      operatingMode: "shadowed",
      defaultAgentId: primaryAgentId,
      currentHumanUserId: userId,
    }).returning();

    await db.insert(seatOccupancies).values([
      {
        companyId,
        seatId: seat.id,
        occupantType: "agent",
        occupantId: primaryAgentId,
        occupancyRole: "primary_agent",
        status: "active",
      },
      {
        companyId,
        seatId: seat.id,
        occupantType: "user",
        occupantId: userId,
        occupancyRole: "human_operator",
        status: "active",
      },
      {
        companyId,
        seatId: seat.id,
        occupantType: "agent",
        occupantId: shadowAgentId,
        occupancyRole: "shadow_agent",
        status: "active",
      },
    ]);

    const svc = seatService(db);
    const updated = await svc.detachShadowAgent(companyId, seat.id, shadowAgentId);

    expect(updated.previousOperatingMode).toBe("shadowed");
    expect(updated.operatingMode).toBe("assisted");
    const activeShadow = await db
      .select()
      .from(seatOccupancies)
      .where(and(eq(seatOccupancies.seatId, seat.id), eq(seatOccupancies.occupancyRole, "shadow_agent"), eq(seatOccupancies.status, "active")))
      .then((rows) => rows[0] ?? null);
    expect(activeShadow).toBeNull();
  });

  it("reassigns the active primary agent occupancy for a seat", async () => {
    const companyId = randomUUID();
    const primaryAgentId = randomUUID();
    const nextPrimaryAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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
        seatId: null,
        seatRole: "primary_agent",
      },
      {
        id: nextPrimaryAgentId,
        companyId,
        name: "Next Primary Agent",
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
    await db.insert(seatOccupancies).values({
      companyId,
      seatId: seat.id,
      occupantType: "agent",
      occupantId: primaryAgentId,
      occupancyRole: "primary_agent",
      status: "active",
    });

    const updated = await seatService(db).reassignPrimaryAgent(companyId, seat.id, nextPrimaryAgentId);
    expect(updated.operatingMode).toBe("vacant");

    const activePrimary = await db
      .select()
      .from(seatOccupancies)
      .where(and(eq(seatOccupancies.seatId, seat.id), eq(seatOccupancies.occupancyRole, "primary_agent"), eq(seatOccupancies.status, "active")))
      .then((rows) => rows[0] ?? null);
    expect(activePrimary?.occupantId).toBe(nextPrimaryAgentId);

    const refreshedPrimary = await db.select().from(agents).where(eq(agents.id, primaryAgentId)).then((rows) => rows[0] ?? null);
    const refreshedNext = await db.select().from(agents).where(eq(agents.id, nextPrimaryAgentId)).then((rows) => rows[0] ?? null);
    expect(refreshedPrimary?.seatRole).toBeNull();
    expect(refreshedNext?.seatId).toBe(seat.id);
    expect(refreshedNext?.seatRole).toBe("primary_agent");
  });

  it("rejects shadow attachment for archived seats and foreign-company agents", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const primaryAgentId = randomUUID();
    const foreignAgentId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Elsewhere",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

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
        id: foreignAgentId,
        companyId: otherCompanyId,
        name: "Foreign Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [archivedSeat] = await db.insert(seats).values({
      companyId,
      slug: "archived-seat",
      name: "Archived Seat",
      seatType: "manager",
      status: "archived",
      operatingMode: "assisted",
      defaultAgentId: primaryAgentId,
      currentHumanUserId: userId,
    }).returning();

    await expect(seatService(db).attachShadowAgent(companyId, archivedSeat.id, foreignAgentId)).rejects.toThrow();
  });
});
