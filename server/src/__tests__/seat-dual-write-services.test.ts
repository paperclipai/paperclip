import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  goals,
  projects,
  seats,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres seat dual-write service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("project and goal seat dual-write", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seat-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(seats);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("sets and updates leadSeatId from leadAgentId on projects", async () => {
    const companyId = randomUUID();
    const leadOneId = randomUUID();
    const leadTwoId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: leadOneId,
        companyId,
        name: "Lead One",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: leadTwoId,
        companyId,
        name: "Lead Two",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [seatOne, seatTwo] = await db.insert(seats).values([
      {
        companyId,
        slug: "lead-one",
        name: "Lead One Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: leadOneId,
      },
      {
        companyId,
        slug: "lead-two",
        name: "Lead Two Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: leadTwoId,
      },
    ]).returning();

    await db.update(agents).set({ seatId: seatOne.id, seatRole: "primary_agent" }).where(eq(agents.id, leadOneId));
    await db.update(agents).set({ seatId: seatTwo.id, seatRole: "primary_agent" }).where(eq(agents.id, leadTwoId));

    const svc = projectService(db);
    const created = await svc.create(companyId, {
      name: "Seat Project",
      status: "backlog",
      leadAgentId: leadOneId,
    });
    expect(created.leadSeatId).toBe(seatOne.id);

    const updated = await svc.update(created.id, { leadAgentId: leadTwoId });
    expect(updated?.leadSeatId).toBe(seatTwo.id);
  });

  it("rejects project dual-write when leadAgentId belongs to another company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const foreignLeadId = randomUUID();

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

    await db.insert(agents).values({
      id: foreignLeadId,
      companyId: otherCompanyId,
      name: "Foreign Lead",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(
      projectService(db).create(companyId, {
        name: "Seat Project",
        status: "backlog",
        leadAgentId: foreignLeadId,
      }),
    ).rejects.toThrow("Lead agent must belong to same company");
  });

  it("sets and updates ownerSeatId from ownerAgentId on goals", async () => {
    const companyId = randomUUID();
    const ownerOneId = randomUUID();
    const ownerTwoId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ownerOneId,
        companyId,
        name: "Owner One",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerTwoId,
        companyId,
        name: "Owner Two",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const [seatOne, seatTwo] = await db.insert(seats).values([
      {
        companyId,
        slug: "owner-one",
        name: "Owner One Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: ownerOneId,
      },
      {
        companyId,
        slug: "owner-two",
        name: "Owner Two Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: ownerTwoId,
      },
    ]).returning();

    await db.update(agents).set({ seatId: seatOne.id, seatRole: "primary_agent" }).where(eq(agents.id, ownerOneId));
    await db.update(agents).set({ seatId: seatTwo.id, seatRole: "primary_agent" }).where(eq(agents.id, ownerTwoId));

    const svc = goalService(db);
    const created = await svc.create(companyId, {
      title: "Seat Goal",
      level: "company",
      status: "planned",
      ownerAgentId: ownerOneId,
    });
    expect(created.ownerSeatId).toBe(seatOne.id);

    const updated = await svc.update(created.id, { ownerAgentId: ownerTwoId });
    expect(updated?.ownerSeatId).toBe(seatTwo.id);
  });

  it("rejects goal dual-write when ownerAgentId belongs to another company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const foreignOwnerId = randomUUID();

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

    await db.insert(agents).values({
      id: foreignOwnerId,
      companyId: otherCompanyId,
      name: "Foreign Owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(
      goalService(db).create(companyId, {
        title: "Seat Goal",
        level: "company",
        status: "planned",
        ownerAgentId: foreignOwnerId,
      }),
    ).rejects.toThrow("Owner agent must belong to same company");
  });
});
