import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  companyStanding,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  plugins,
} from "@paperclipai/db";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { companyStandingService } from "../services/company-standing.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-standing gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat company-standing run-start gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const heartbeats: Array<ReturnType<typeof heartbeatService>> = [];

  function makeHeartbeat(...args: Parameters<typeof heartbeatService>) {
    const heartbeat = heartbeatService(...args);
    heartbeats.push(heartbeat);
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-company-standing-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    while (heartbeats.length > 0) {
      await heartbeats.pop()?.drain();
    }
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }, 20_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Standing Gate Co",
      status: "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      // Every successful-wakeup fixture in this suite family sets this (see
      // heartbeat-accepted-plan-workspace-refresh.test.ts:300-305) so run
      // seeding never trips the responsible_user_unresolved 422.
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gate Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });

    return { companyId, agentId, pluginId };
  }

  it("refuses new runs with typed company_blocked when effectively blocked", async () => {
    const { companyId, agentId, pluginId } = await insertFixture();
    await companyStandingService(db).setStanding(pluginId, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Your subscription has lapsed.",
      actionUrl: "/billing",
    });

    const heartbeat = makeHeartbeat(db);

    await expect(heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Your subscription has lapsed.",
      details: {
        code: "company_blocked",
        reason: "subscription_lapsed",
        actionUrl: "/billing",
      },
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);

    // The refusal is recorded as a skipped wakeup request, like budget blocks.
    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .then((rows) => rows.filter((row) => row.agentId === agentId && row.status === "skipped"));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]).toMatchObject({ reason: "company.standing_blocked" });
  });

  it("grace never blocks: runs proceed", async () => {
    const { companyId, agentId, pluginId } = await insertFixture();
    await companyStandingService(db).setStanding(pluginId, companyId, {
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
    });

    const heartbeat = makeHeartbeat(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(run).toBeTruthy();
  });

  it("no standing rows: runs proceed (fail-safe active)", async () => {
    const { agentId } = await insertFixture();

    const heartbeat = makeHeartbeat(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(run).toBeTruthy();
  });

  // The admission gate above (heartbeat.wakeup) only covers the very first
  // decision to accept a wake request. A separate universal queued->running
  // transition happens in claimQueuedRun (invoked via resumeQueuedRuns), and
  // it must enforce the same blocked standing, mirroring how it already
  // disposes of a queued run on a budget block (cancelRunInternal).
  describe("claimQueuedRun: queued -> running transition", () => {
    async function seedQueuedRun(companyId: string, agentId: string) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual",
        payload: {},
        status: "queued",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: {},
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId })
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      return runId;
    }

    it("blocked standing: does not transition to running, disposes the run with the standing reason", async () => {
      // Pre-existing behavior (not introduced by this test): cancelRunInternal
      // ends with `await startNextQueuedRunForAgent(run.agentId)`, and here it
      // is invoked from *inside* that same function's withAgentStartLock
      // closure (claimQueuedRun -> cancelRunInternal). The reentrant call
      // waits on its own outer lock until agent-start-lock.ts's 30s staleness
      // fallback releases it, so this assertion is correct but takes ~30s.
      // Same latent stall would hit the existing budgetBlock branch in
      // claimQueuedRun if it were ever exercised end-to-end like this.
      const { companyId, agentId, pluginId } = await insertFixture();
      const runId = await seedQueuedRun(companyId, agentId);
      await companyStandingService(db).setStanding(pluginId, companyId, {
        status: "blocked",
        reason: "subscription_lapsed",
        message: "Your subscription has lapsed.",
        actionUrl: "/billing",
      });

      const heartbeat = makeHeartbeat(db);
      await heartbeat.resumeQueuedRuns();

      const [run] = await db
        .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      expect(run?.status).not.toBe("running");
      expect(run).toMatchObject({
        status: "cancelled",
        error: "Your subscription has lapsed.",
      });
    }, 45_000);

    it("grace standing: claims normally (transitions to running)", async () => {
      const { companyId, agentId, pluginId } = await insertFixture();
      const runId = await seedQueuedRun(companyId, agentId);
      await companyStandingService(db).setStanding(pluginId, companyId, {
        status: "grace",
        reason: "payment_failed",
        message: "Your last payment failed.",
      });

      const heartbeat = makeHeartbeat(db);
      await heartbeat.resumeQueuedRuns();

      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      expect(run?.status).toBe("running");
    }, 20_000);
  });
});
