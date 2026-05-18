import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  closeDb,
  companies,
  createDb,
  creditLedger,
  heartbeatRuns,
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
    `Skipping undirected wake coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat undirected wake coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-undirected-coalesce-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(creditLedger);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDb(db);
    await tempDb?.cleanup();
  });

  it(
    "coalesces an undirected wake into an active issue-scoped run instead of spawning a parallel run",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const heartbeat = heartbeatService(db);

      await db.insert(companies).values({
        id: companyId,
        name: "Test Company",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Test Agent",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(creditLedger).values({
        accountId: companyId,
        eventType: "subscription_grant",
        amount: 10_000,
        idempotencyKey: `test-grant-${companyId}`,
      });

      // Simulate an active issue-scoped run already in progress.
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "claimed",
        runId,
        claimedAt: new Date(),
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId,
        // taskKey derived from contextSnapshot.issueId — this is an issue-scoped run.
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: new Date(),
      });

      // An undirected wake arrives (no issueId / taskId in context).
      // Before fix #5180: this spawned a new parallel run.
      // After fix: it coalesces into the already-running issue-scoped run.
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual_invoke",
        reason: "manual_invoke",
        contextSnapshot: {},
        payload: null,
      });

      const allWakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));

      const coalescedWakeup = allWakeups.find((w) => w.status === "coalesced");
      const queuedWakeup = allWakeups.find((w) => w.status === "queued");

      expect(coalescedWakeup).toBeDefined();
      expect(queuedWakeup).toBeUndefined();

      // Exactly one heartbeat run should exist — the original issue-scoped run.
      const allRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));

      expect(allRuns).toHaveLength(1);
      expect(allRuns[0].id).toBe(runId);
      expect(allRuns[0].status).toBe("running");
    },
    30_000,
  );

  it(
    "coalesces an undirected wake into an active queued run instead of spawning a second queued run",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const heartbeat = heartbeatService(db);

      await db.insert(companies).values({
        id: companyId,
        name: "Test Company",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Test Agent",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(creditLedger).values({
        accountId: companyId,
        eventType: "subscription_grant",
        amount: 10_000,
        idempotencyKey: `test-grant-${companyId}`,
      });

      // Simulate an issue-scoped run that is queued (not yet running).
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId },
      });

      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual_invoke",
        reason: "manual_invoke",
        contextSnapshot: {},
        payload: null,
      });

      const allWakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));

      const coalescedWakeup = allWakeups.find((w) => w.status === "coalesced");
      const queuedWakeups = allWakeups.filter((w) => w.status === "queued");

      expect(coalescedWakeup).toBeDefined();
      // Only the original queued wakeup should remain; no second queued wakeup.
      expect(queuedWakeups).toHaveLength(1);
      expect(queuedWakeups[0].id).toBe(wakeupRequestId);

      const allRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));

      expect(allRuns).toHaveLength(1);
      expect(allRuns[0].id).toBe(runId);
    },
    30_000,
  );
});
