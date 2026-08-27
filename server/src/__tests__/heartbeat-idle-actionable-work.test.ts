import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres idle-actionable-work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Dispatch is wake-driven: `shouldPickUpIssue` requires a wakeReason, and wakes only come
 * from assignment, comments, blocker resolution, monitors, routines and continuations. An
 * owned, unblocked card that is simply waiting has no event left to produce one, so before
 * tickIdleActionableWork it waited forever — measured at 14 days on eight TSMC cards.
 *
 * The first test is the RED proof: against `live` it fails with enqueued 0.
 */
const NOW = new Date("2026-08-27T09:00:00Z");
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describeEmbeddedPostgres("heartbeat tickIdleActionableWork", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-idle-actionable-work-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Clear the candidate pool and the wake ledger, and leave companies/agents in place.
    // TRUNCATE ... CASCADE deadlocks against the service's in-flight work, and deleting
    // companies means chasing every FK in the schema; neither is what this test is about.
    // What must be clean between tests is the candidate set and the wake ledger, because the
    // per-tick cap is fleet-wide — leftovers from an earlier test would starve the next one.
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Idle Work Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    status?: string;
    updatedAt: Date;
    title?: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: `IDLE-${id.slice(0, 4)}`,
      title: input.title ?? "Actionable, owned, unblocked",
      status: (input.status ?? "todo") as never,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    } as never);
    return id;
  }

  async function idleWakes(issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .then((rows) =>
        rows.filter(
          (row) =>
            row.reason === "idle_actionable_work" &&
            (row.payload as { issueId?: string } | null)?.issueId === issueId,
        ),
      );
  }

  // RED against live: nothing sweeps idle actionable work, so this card stays untouched.
  it("wakes the owner of an owned, unblocked card that has gone idle", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await insertIssue({ companyId, assigneeAgentId: agentId, updatedAt: DAYS_AGO(14) });

    await heartbeatService(db).tickTimers(NOW);

    expect(await idleWakes(issueId)).toHaveLength(1);
  });

  it("also picks up backlog, which is where newly filed cards land and stop", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await insertIssue({
      companyId,
      assigneeAgentId: agentId,
      status: "backlog",
      updatedAt: DAYS_AGO(9),
    });

    await heartbeatService(db).tickTimers(NOW);

    expect(await idleWakes(issueId)).toHaveLength(1);
  });

  it("leaves live work alone — a card touched inside the idle window is not poked", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await insertIssue({
      companyId,
      assigneeAgentId: agentId,
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });

    await heartbeatService(db).tickTimers(NOW);

    expect(await idleWakes(issueId)).toHaveLength(0);
  });

  it("does not wake twice for the same idle period", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await insertIssue({ companyId, assigneeAgentId: agentId, updatedAt: DAYS_AGO(14) });

    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(NOW);
    await heartbeat.tickTimers(new Date(NOW.getTime() + 60_000));

    expect(await idleWakes(issueId)).toHaveLength(1);
  });

  it("ignores unowned cards and operator-owned cards", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const unowned = await insertIssue({ companyId, updatedAt: DAYS_AGO(20), title: "Nobody owns this" });
    const operatorOwned = await insertIssue({
      companyId,
      assigneeUserId: randomUUID(),
      updatedAt: DAYS_AGO(20),
      title: "Operator decision, not agent work",
    });

    await heartbeatService(db).tickTimers(NOW);

    expect(await idleWakes(unowned)).toHaveLength(0);
    expect(await idleWakes(operatorOwned)).toHaveLength(0);
  });

  it("caps the fleet-wide batch so the sweep can never become a churn generator", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    for (let i = 0; i < 12; i += 1) {
      await insertIssue({ companyId, assigneeAgentId: agentId, updatedAt: DAYS_AGO(30 + i) });
    }

    await heartbeatService(db).tickTimers(NOW);

    const emitted = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.filter((row) => row.reason === "idle_actionable_work").length);
    expect(emitted).toBeLessThanOrEqual(5);
    expect(emitted).toBeGreaterThan(0);
  });

  // Regression: the first version of this sweep re-woke a card whose queued retries the
  // equivalent-failure circuit breaker had just cancelled, quietly undoing the breaker. The same
  // hole would re-wake every ceiling-bricked card every 24h forever.
  it("never re-runs a card whose last attempt failed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await insertIssue({ companyId, assigneeAgentId: agentId, updatedAt: DAYS_AGO(14) });
    for (const status of ["failed", "cancelled", "timed_out", "interrupted"]) {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: status as never,
        invocationSource: "automation",
        contextSnapshot: { issueId },
        createdAt: DAYS_AGO(1),
        updatedAt: DAYS_AGO(1),
      } as never);

      await heartbeatService(db).tickTimers(NOW);

      expect(await idleWakes(issueId), `last attempt ${status} must not be re-run`).toHaveLength(0);
    }
  });

  it("does not touch issues.updatedAt — the fix must not erase the staleness evidence", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const staleAt = DAYS_AGO(14);
    const issueId = await insertIssue({ companyId, assigneeAgentId: agentId, updatedAt: staleAt });

    await heartbeatService(db).tickTimers(NOW);

    const [row] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, issueId));
    expect(row.updatedAt.getTime()).toBe(staleAt.getTime());
  });
});
