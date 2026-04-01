import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "./client.js";
import { companies, agents, goals, issues, projects, routines, seats, seatOccupancies } from "./schema/index.js";
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

      const result = await backfillSeatModel(db, { companyId: company.id, batchSize: 1 });

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
    "backfills issue/project/goal/routine seat owners, warns on user-only issues, and falls back from terminated agents",
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

      const [liveProject, terminatedProject] = await db.insert(projects).values([
        {
          companyId: company.id,
          name: "CEO Project",
          leadAgentId: ceo.id,
        },
        {
          companyId: company.id,
          name: "Terminated Project",
          leadAgentId: terminatedEngineer.id,
        },
      ]).returning();

      const [liveGoal, terminatedGoal] = await db.insert(goals).values([
        {
          companyId: company.id,
          title: "CEO Goal",
          ownerAgentId: ceo.id,
        },
        {
          companyId: company.id,
          title: "Terminated Goal",
          ownerAgentId: terminatedEngineer.id,
        },
      ]).returning();

      const [liveRoutine, terminatedRoutine] = await db.insert(routines).values([
        {
          companyId: company.id,
          projectId: liveProject.id,
          title: "CEO Routine",
          assigneeAgentId: ceo.id,
        },
        {
          companyId: company.id,
          projectId: liveProject.id,
          title: "Terminated Routine",
          assigneeAgentId: terminatedEngineer.id,
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
      const refreshedLiveProject = await db
        .select()
        .from(projects)
        .where(eq(projects.id, liveProject.id))
        .then((rows) => rows[0] ?? null);
      const refreshedTerminatedProject = await db
        .select()
        .from(projects)
        .where(eq(projects.id, terminatedProject.id))
        .then((rows) => rows[0] ?? null);
      const refreshedLiveGoal = await db
        .select()
        .from(goals)
        .where(eq(goals.id, liveGoal.id))
        .then((rows) => rows[0] ?? null);
      const refreshedTerminatedGoal = await db
        .select()
        .from(goals)
        .where(eq(goals.id, terminatedGoal.id))
        .then((rows) => rows[0] ?? null);
      const refreshedLiveRoutine = await db
        .select()
        .from(routines)
        .where(eq(routines.id, liveRoutine.id))
        .then((rows) => rows[0] ?? null);
      const refreshedTerminatedRoutine = await db
        .select()
        .from(routines)
        .where(eq(routines.id, terminatedRoutine.id))
        .then((rows) => rows[0] ?? null);

      expect(refreshedLiveIssue?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedUserOnlyIssue?.ownerSeatId).toBeNull();
      expect(refreshedTerminatedIssue?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedUnassignedIssue?.ownerSeatId).toBeNull();
      expect(refreshedLiveProject?.leadSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedTerminatedProject?.leadSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedLiveGoal?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedTerminatedGoal?.ownerSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedLiveRoutine?.assigneeSeatId).toBe(ceoSeat?.id ?? null);
      expect(refreshedTerminatedRoutine?.assigneeSeatId).toBe(ceoSeat?.id ?? null);
      expect(result.ownershipBackfills).toEqual({
        issues: 2,
        projects: 2,
        goals: 2,
        routines: 2,
      });

      expect(
        result.warnings.some((warning) => warning.code === "issue_user_only_without_owner_seat"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "issue_rehomed_from_terminated_agent"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "project_rehomed_from_terminated_agent"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "goal_rehomed_from_terminated_agent"),
      ).toBe(true);
      expect(
        result.warnings.some((warning) => warning.code === "routine_rehomed_from_terminated_agent"),
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

  it(
    "replaces a conflicting active primary occupancy instead of failing on rerun",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Seat Rebind Co",
        issuePrefix: "SRC",
      }).returning();

      const [agent, otherAgent] = await db.insert(agents).values([
        {
          companyId: company.id,
          name: "Primary Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
        {
          companyId: company.id,
          name: "Conflicting Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        },
      ]).returning();

      const [seat] = await db.insert(seats).values({
        companyId: company.id,
        slug: "primary-seat",
        name: "Primary Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: agent.id,
      }).returning();

      await db.insert(seatOccupancies).values({
        companyId: company.id,
        seatId: seat.id,
        occupantType: "agent",
        occupantId: otherAgent.id,
        occupancyRole: "primary_agent",
        status: "active",
      });

      const result = await backfillSeatModel(db, { companyId: company.id });
      expect(result.seatsUpdated).toBeGreaterThanOrEqual(1);

      const activePrimary = await db
        .select()
        .from(seatOccupancies)
        .where(
          and(
            eq(seatOccupancies.seatId, seat.id),
            eq(seatOccupancies.occupancyRole, "primary_agent"),
            eq(seatOccupancies.status, "active"),
          ),
        );
      expect(activePrimary).toHaveLength(1);
      expect(activePrimary[0]?.occupantId).toBe(agent.id);
    },
    20_000,
  );

  it(
    "uses multiple transactions instead of one long-running transaction for the full backfill",
    async () => {
      const db = await createTempDb();

      const [company] = await db.insert(companies).values({
        name: "Seat Transaction Co",
        issuePrefix: "STC",
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

      await db.insert(issues).values([
        {
          companyId: company.id,
          title: "CEO issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: ceo.id,
        },
        {
          companyId: company.id,
          title: "Engineer issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: engineer.id,
        },
      ]);

      let transactionCount = 0;
      const countedDb = Object.assign(Object.create(db), db, {
        transaction: async (...args: Parameters<typeof db.transaction>) => {
          transactionCount += 1;
          return db.transaction(...args);
        },
      });

      await backfillSeatModel(countedDb as typeof db, { companyId: company.id, batchSize: 1 });

      expect(transactionCount).toBeGreaterThan(1);
    },
    20_000,
  );
});
