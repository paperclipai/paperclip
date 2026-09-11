import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import { readSuppressedWakeParkMarker } from "../services/recovery/suppression-wait.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres suppression-park tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("suppressed wake parking on the scheduled-retry carrier", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-suppression-park-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    stopTaskDrain();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  interface ParkFixture {
    companyId: string;
    agentId: string;
    blockerIssueId: string;
    dependentIssueId: string;
    sourceRunId: string;
  }

  async function seedParkFixture(): Promise<ParkFixture> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentIssueId = randomUUID();
    const sourceRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Parked Coder",
      role: "engineer",
      status: "idle",
      adapterType: "workspace_busy_test",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Blocker issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Dependent issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, invocationSource: "automation",
      triggerDetail: "system", status: "failed", finishedAt: new Date(),
      contextSnapshot: { issueId: dependentIssueId },
    });
    return { companyId, agentId, blockerIssueId, dependentIssueId, sourceRunId };
  }

  function wakeDependent(fixture: ParkFixture, reason = "issue_continuation_needed") {
    return heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { issueId: fixture.dependentIssueId, retryOfRunId: fixture.sourceRunId },
      requestedByActorType: "system",
      requestedByActorId: "recovery",
    });
  }

  async function listParks(companyId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          eq(heartbeatRuns.scheduledRetryReason, "issue_dependencies_blocked"),
        ),
      );
  }

  async function listCompanyWakes(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
  }

  it("parks a dependency-blocked wake once and coalesces repeats without row storms", async () => {
    const fixture = await seedParkFixture();

    await wakeDependent(fixture);
    await wakeDependent(fixture);
    await wakeDependent(fixture);

    const skipped = (await listCompanyWakes(fixture.companyId)).filter(
      (row) => row.status === "skipped" && row.reason === "issue_dependencies_blocked",
    );
    expect(skipped).toHaveLength(0);

    const parks = await listParks(fixture.companyId);
    expect(parks).toHaveLength(1);
    const park = parks[0]!;
    expect(park.retryOfRunId).toBe(fixture.sourceRunId);
    const marker = readSuppressedWakeParkMarker(park.contextSnapshot);
    expect(marker?.cause).toBe("issue_dependencies_blocked");
    expect(marker?.unresolvedBlockerIssueIds).toEqual([fixture.blockerIssueId]);

    const wake = (await listCompanyWakes(fixture.companyId)).find(
      (row) => (row.payload as Record<string, unknown>)?.issueId === fixture.dependentIssueId,
    );
    expect(wake?.status).toBe("queued");
    expect(wake?.runId).toBe(park.id);
    expect(wake?.coalescedCount).toBe(2);
    expect(wake?.reason).toBe("issue_continuation_needed");
    expect((wake?.payload as Record<string, unknown>)?.retryOfRunId).toBe(fixture.sourceRunId);
  });

  it("admits the parked intent exactly once when the blocker resolves", async () => {
    const fixture = await seedParkFixture();
    await wakeDependent(fixture);
    const parks = await listParks(fixture.companyId);
    expect(parks).toHaveLength(1);

    // Resolve the blocker and make the parked run due.
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, fixture.blockerIssueId));
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1000) })
      .where(eq(heartbeatRuns.id, parks[0]!.id));

    const promoted = await heartbeat.promoteDueScheduledRetries();
    expect(promoted.runIds).toContain(parks[0]!.id);

    const promotedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parks[0]!.id))
      .then((rows) => rows[0]!);
    expect(promotedRun.status).toBe("queued");

    // A later promotion pass must not re-admit or duplicate the intent.
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1000) })
      .where(eq(heartbeatRuns.status, "scheduled_retry"));
    const again = await heartbeat.promoteDueScheduledRetries();
    expect(again.runIds).not.toContain(parks[0]!.id);
  });

  it("refuses a stale parked intent at release after the issue was reassigned", async () => {
    const fixture = await seedParkFixture();
    await wakeDependent(fixture);
    const parks = await listParks(fixture.companyId);
    expect(parks).toHaveLength(1);

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "Other Coder",
      role: "engineer",
      status: "idle",
      adapterType: "workspace_busy_test",
      adapterConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: otherAgentId })
      .where(eq(issues.id, fixture.dependentIssueId));
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1000) })
      .where(eq(heartbeatRuns.id, parks[0]!.id));

    await heartbeat.promoteDueScheduledRetries();

    const cancelled = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parks[0]!.id))
      .then((rows) => rows[0]!);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).toBe("issue_reassigned");
    const wake = (await listCompanyWakes(fixture.companyId)).find(
      (row) => (row.payload as Record<string, unknown>)?.issueId === fixture.dependentIssueId,
    );
    expect(wake?.status).toBe("cancelled");
  });

  it("parks concurrent identical suppressions as one pair", async () => {
    const fixture = await seedParkFixture();

    // The park serializes identical intents on a transaction-scoped advisory
    // lock, so concurrent suppressed wakes cannot race the lookup and mint
    // duplicate parked pairs.
    await Promise.all([
      wakeDependent(fixture),
      wakeDependent(fixture),
      wakeDependent(fixture),
      wakeDependent(fixture),
    ]);

    const parks = await listParks(fixture.companyId);
    expect(parks).toHaveLength(1);
    const parkWakes = (await listCompanyWakes(fixture.companyId)).filter(
      (row) => (row.payload as Record<string, unknown>)?.issueId === fixture.dependentIssueId,
    );
    expect(parkWakes).toHaveLength(1);
  });

  it("keeps rechecking an unchanged dependency wait past twenty rechecks", async () => {
    const fixture = await seedParkFixture();
    await wakeDependent(fixture);
    const parks = await listParks(fixture.companyId);
    expect(parks).toHaveLength(1);
    const parkId = parks[0]!.id;

    // A long-lived human-owned blocker: the dependency gate keeps holding and
    // the parked retry keeps re-arming in place on an escalating cadence. The
    // wait lifetime belongs to the blocker's owner, never to a recheck clock,
    // so past twenty rechecks the pair is still parked — no cancel, no
    // synthetic repair lane, no exhaustion.
    for (let recheck = 0; recheck < 25; recheck += 1) {
      await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAt: new Date(Date.now() - 1000) })
        .where(eq(heartbeatRuns.id, parkId));
      const outcome = await heartbeat.promoteDueScheduledRetries();
      expect(outcome.runIds).not.toContain(parkId);
      const current = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, parkId))
        .then((rows) => rows[0]!);
      expect(current.status).toBe("scheduled_retry");
      const marker = readSuppressedWakeParkMarker(current.contextSnapshot);
      expect(marker?.rechecks).toBe(recheck + 1);
    }

    const finalRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parkId))
      .then((rows) => rows[0]!);
    expect(finalRun.status).toBe("scheduled_retry");
    expect(finalRun.errorCode).toBeNull();
    // The recheck cadence escalated instead of busy-polling.
    const finalMarker = readSuppressedWakeParkMarker(finalRun.contextSnapshot);
    expect(finalMarker?.rechecks).toBe(25);
    expect(finalRun.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("parks a drain-suppressed wake once and admits it after the drain lifts", async () => {
    const fixture = await seedParkFixture();
    startTaskDrain();
    try {
      await wakeDependent(fixture, "issue_continuation_needed");
      await wakeDependent(fixture, "issue_continuation_needed");

      const parks = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, fixture.companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            eq(heartbeatRuns.scheduledRetryReason, "scheduling_suppressed"),
          ),
        );
      expect(parks).toHaveLength(1);
      const marker = readSuppressedWakeParkMarker(parks[0]!.contextSnapshot);
      expect(marker?.cause).toBe("scheduling_suppressed");
      expect(marker?.schedulingReason).toBe("task_drain");
      expect(marker?.suppressions).toBe(2);

      // The drain lifts (restart included): the parked pair is durable, and
      // the normal promotion path admits the intent exactly once.
      stopTaskDrain();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerIssueId));
      await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAt: new Date(Date.now() - 1000) })
        .where(eq(heartbeatRuns.id, parks[0]!.id));
      const promoted = await heartbeat.promoteDueScheduledRetries();
      expect(promoted.runIds).toContain(parks[0]!.id);
      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, parks[0]!.id))
        .then((rows) => rows[0]!);
      expect(promotedRun.status).toBe("queued");
    } finally {
      stopTaskDrain();
    }
  });
});
