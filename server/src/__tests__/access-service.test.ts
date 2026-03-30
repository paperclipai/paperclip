import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  seatOccupancies,
  seats,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres access service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("accessService seat-derived permissions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(seatOccupancies);
    await db.delete(companyMemberships);
    await db.delete(seats);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("grants CEO seat authority to active human_operator with company membership", async () => {
    const companyId = randomUUID();
    const ceoAgentId = randomUUID();
    const userId = "user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ceoAgentId,
      companyId,
      name: "CEO Agent",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [ceoSeat] = await db.insert(seats).values({
      companyId,
      slug: "ceo-seat",
      name: "CEO Seat",
      seatType: "ceo",
      status: "active",
      operatingMode: "assisted",
      defaultAgentId: ceoAgentId,
      currentHumanUserId: userId,
    }).returning();

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    await db.insert(seatOccupancies).values([
      {
        companyId,
        seatId: ceoSeat.id,
        occupantType: "agent",
        occupantId: ceoAgentId,
        occupancyRole: "primary_agent",
        status: "active",
      },
      {
        companyId,
        seatId: ceoSeat.id,
        occupantType: "user",
        occupantId: userId,
        occupancyRole: "human_operator",
        status: "active",
      },
    ]);

    const access = accessService(db);

    await expect(access.canUser(companyId, userId, "agents:create")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "tasks:assign")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "joins:approve")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "users:invite")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "users:manage_permissions")).resolves.toBe(true);
  });

  it("grants CEO seat authority to active primary_agent even without explicit grants", async () => {
    const companyId = randomUUID();
    const ceoAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ceoAgentId,
      companyId,
      name: "CEO Agent",
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [ceoSeat] = await db.insert(seats).values({
      companyId,
      slug: "ceo-seat",
      name: "CEO Seat",
      seatType: "ceo",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: ceoAgentId,
    }).returning();

    await db.insert(seatOccupancies).values({
      companyId,
      seatId: ceoSeat.id,
      occupantType: "agent",
      occupantId: ceoAgentId,
      occupancyRole: "primary_agent",
      status: "active",
    });

    const access = accessService(db);

    await expect(access.hasPermission(companyId, "agent", ceoAgentId, "agents:create")).resolves.toBe(true);
    await expect(access.hasPermission(companyId, "agent", ceoAgentId, "tasks:assign")).resolves.toBe(true);
    await expect(access.hasPermission(companyId, "agent", ceoAgentId, "joins:approve")).resolves.toBe(true);
  });

  it("does not grant CEO seat authority to shadow_agent or membership-less human", async () => {
    const companyId = randomUUID();
    const shadowAgentId = randomUUID();
    const userId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: shadowAgentId,
      companyId,
      name: "Shadow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [ceoSeat] = await db.insert(seats).values({
      companyId,
      slug: "ceo-seat",
      name: "CEO Seat",
      seatType: "ceo",
      status: "active",
      operatingMode: "shadowed",
      defaultAgentId: shadowAgentId,
      currentHumanUserId: userId,
    }).returning();

    await db.insert(seatOccupancies).values([
      {
        companyId,
        seatId: ceoSeat.id,
        occupantType: "agent",
        occupantId: shadowAgentId,
        occupancyRole: "shadow_agent",
        status: "active",
      },
      {
        companyId,
        seatId: ceoSeat.id,
        occupantType: "user",
        occupantId: userId,
        occupancyRole: "human_operator",
        status: "active",
      },
    ]);

    const access = accessService(db);

    await expect(access.hasPermission(companyId, "agent", shadowAgentId, "tasks:assign")).resolves.toBe(false);
    await expect(access.canUser(companyId, userId, "tasks:assign")).resolves.toBe(false);
  });

  it("grants delegated seat permissions from seat metadata to active primary agents and human operators", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = "user-3";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operations Agent",
      role: "general",
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
      operatingMode: "assisted",
      defaultAgentId: agentId,
      currentHumanUserId: userId,
      metadata: {
        delegatedPermissions: ["tasks:assign", "users:invite"],
      },
    }).returning();

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

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

    const access = accessService(db);

    await expect(access.hasPermission(companyId, "agent", agentId, "tasks:assign")).resolves.toBe(true);
    await expect(access.hasPermission(companyId, "agent", agentId, "users:invite")).resolves.toBe(true);
    await expect(access.hasPermission(companyId, "agent", agentId, "joins:approve")).resolves.toBe(false);

    await expect(access.canUser(companyId, userId, "tasks:assign")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "users:invite")).resolves.toBe(true);
    await expect(access.canUser(companyId, userId, "agents:create")).resolves.toBe(false);
  });
});
