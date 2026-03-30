import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "./client.js";
import { companies, agents, issues, seats, seatOccupancies } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { backfillSeatModel } from "./seat-backfill.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDb() {
  const dbInfo = await startEmbeddedPostgresTestDatabase("paperclip-seat-backfill-");
  cleanups.push(dbInfo.cleanup);
  return createDb(dbInfo.connectionString);
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres seat backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("backfillSeatModel", () => {
  it(
    "creates seats and primary occupancies for non-terminated agents",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Seat Backfill Co",
        issuePrefix: "SBC",
      }).returning();

      const [ceo] = await db.insert(agents).values({
        companyId: company.id,
        name: "CEO Agent",
        role: "ceo",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();

      const [engineer] = await db.insert(agents).values({
        companyId: company.id,
        name: "Engineer Agent",
        role: "engineer",
        status: "idle",
        reportsTo: ceo.id,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();

      const result = await backfillSeatModel(db, { companyId: company.id });

      expect(result.seatsCreated).toBe(2);
      expect(result.primaryOccupanciesCreated).toBe(2);
      expect(result.warnings).toHaveLength(0);

      const allSeats = await db.select().from(seats).where(eq(seats.companyId, company.id));
      expect(allSeats).toHaveLength(2);

      const seatByDefaultAgent = new Map(allSeats.map((seat) => [seat.defaultAgentId, seat]));
      const ceoSeat = seatByDefaultAgent.get(ceo.id);
      const engineerSeat = seatByDefaultAgent.get(engineer.id);

      expect(ceoSeat?.seatType).toBe("ceo");
      expect(engineerSeat?.parentSeatId).toBe(ceoSeat?.id ?? null);

      const occupancies = await db
        .select()
        .from(seatOccupancies)
        .where(and(eq(seatOccupancies.companyId, company.id), eq(seatOccupancies.status, "active")));
      expect(occupancies).toHaveLength(2);
      expect(occupancies.every((row) => row.occupancyRole === "primary_agent")).toBe(true);
    },
    20_000,
  );

  it(
    "backfills issue owner seats, warns on user-only issues, and falls back from terminated agents",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Seat Backfill Work Co",
        issuePrefix: "SBW",
      }).returning();

      const [ceo] = await db.insert(agents).values({
        companyId: company.id,
        name: "CEO Agent",
        role: "ceo",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();

      const [terminatedEngineer] = await db.insert(agents).values({
        companyId: company.id,
        name: "Former Engineer",
        role: "engineer",
        status: "terminated",
        reportsTo: ceo.id,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();

      const [liveIssue, userOnlyIssue, terminatedIssue, unassignedIssue] = await db.insert(issues).values([
        {
          companyId: company.id,
          title: "Assigned to CEO",
          status: "todo",
          priority: "medium",
          assigneeAgentId: ceo.id,
        },
        {
          companyId: company.id,
          title: "User only issue",
          status: "todo",
          priority: "medium",
          assigneeUserId: "user-123",
        },
        {
          companyId: company.id,
          title: "Terminated assignee issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: terminatedEngineer.id,
        },
        {
          companyId: company.id,
          title: "Unassigned issue",
          status: "todo",
          priority: "medium",
        },
      ]).returning();

      const result = await backfillSeatModel(db, { companyId: company.id });

      const ceoSeat = await db
        .select()
        .from(seats)
        .where(and(eq(seats.companyId, company.id), eq(seats.defaultAgentId, ceo.id)))
        .then((rows) => rows[0] ?? null);

      expect(ceoSeat).not.toBeNull();

      const refreshedLiveIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, liveIssue.id))
        .then((rows) => rows[0] ?? null);
      const refreshedUserOnlyIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, userOnlyIssue.id))
        .then((rows) => rows[0] ?? null);
      const refreshedTerminatedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, terminatedIssue.id))
        .then((rows) => rows[0] ?? null);
      const refreshedUnassignedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, unassignedIssue.id))
        .then((rows) => rows[0] ?? null);

      expect(refreshedLiveIssue?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedUserOnlyIssue?.ownerSeatId).toBeNull();
      expect(refreshedTerminatedIssue?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedUnassignedIssue?.ownerSeatId).toBeNull();

      expect(
        result.warnings.some((warning) => warning.code === "issue_user_only_without_owner_seat"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "issue_rehomed_from_terminated_agent"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "issue_without_assignee_during_seat_backfill"),
      ).toBe(true);

      const terminatedSeat = await db
        .select()
        .from(seats)
        .where(and(eq(seats.companyId, company.id), eq(seats.defaultAgentId, terminatedEngineer.id)))
        .then((rows) => rows[0] ?? null);
      expect(terminatedSeat).toBeNull();

      const seatlessAgents = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, company.id), isNull(agents.seatId)));
    expect(seatlessAgents.some((agent) => agent.id === terminatedEngineer.id)).toBe(true);
  },
    20_000,
  );

  it(
    "demotes extra CEO agents to exec seats during backfill instead of crashing",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Dual CEO Co",
        issuePrefix: "DCE",
      }).returning();

      await db.insert(agents).values([
        {
          companyId: company.id,
          name: "CEO One",
          role: "ceo",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
        {
          companyId: company.id,
          name: "CEO Two",
          role: "ceo",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
      ]);

      const result = await backfillSeatModel(db, { companyId: company.id });
      const companySeats = await db.select().from(seats).where(eq(seats.companyId, company.id));
      const ceoSeats = companySeats.filter((seat) => seat.seatType === "ceo");
      const execSeats = companySeats.filter((seat) => seat.seatType === "exec");

      expect(result.seatsCreated).toBe(2);
      expect(ceoSeats).toHaveLength(1);
      expect(execSeats).toHaveLength(1);
      expect(result.warnings.some((warning) => warning.code === "multiple_ceo_agents_demoted")).toBe(true);
    },
    20_000,
  );

  it(
    "prevents seat cycles when the source reporting graph is cyclic",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Seat Cycle Co",
        issuePrefix: "SCC",
      }).returning();

      const [agentA, agentB] = await db.insert(agents).values([
        {
          companyId: company.id,
          name: "Agent A",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
        {
          companyId: company.id,
          name: "Agent B",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
      ]).returning();

      await db.update(agents).set({ reportsTo: agentB.id }).where(eq(agents.id, agentA.id));
      await db.update(agents).set({ reportsTo: agentA.id }).where(eq(agents.id, agentB.id));

      const result = await backfillSeatModel(db, { companyId: company.id });
      const companySeats = await db.select().from(seats).where(eq(seats.companyId, company.id));
      const seatByDefaultAgentId = new Map(companySeats.map((seat) => [seat.defaultAgentId, seat]));
      const seatA = seatByDefaultAgentId.get(agentA.id);
      const seatB = seatByDefaultAgentId.get(agentB.id);

      expect(result.warnings.some((warning) => warning.code === "seat_cycle_prevented")).toBe(true);
      expect(seatA).toBeTruthy();
      expect(seatB).toBeTruthy();
      expect([seatA?.parentSeatId ?? null, seatB?.parentSeatId ?? null].filter(Boolean)).toHaveLength(1);
    },
    20_000,
  );
});
