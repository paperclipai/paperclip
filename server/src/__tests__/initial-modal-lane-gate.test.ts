/**
 * Tests for Gate 2: initial-modal cleanup and lane-session continuity gates (feacb699)
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  initialModalCleanupGateService,
  laneSessionContinuityGateService,
} from "../services/initial-modal-lane-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("initialModalCleanupGateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-modal-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: "TST",
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "general",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId, issueId, staleRunId };
  }

  it("detects no stale locks on a clean issue", async () => {
    const { companyId, agentId, issueId } = await seedFixture();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Clean issue",
      status: "todo",
      priority: "medium",
    });

    const gate = initialModalCleanupGateService(db);
    const result = await gate.detectStaleLocks({ companyId, agentId, issueId });

    expect(result.hasStaleCheckout).toBe(false);
    expect(result.hasStaleExecutionLock).toBe(false);
  });

  it("detects stale checkout lock", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seedFixture();

    // Must insert the heartbeat run first (FK constraint)
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "succeeded",
    });

    const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout",
      status: "in_progress",
      priority: "medium",
      checkoutRunId: staleRunId,
      updatedAt: staleTime,
    });

    const gate = initialModalCleanupGateService(db);
    const result = await gate.detectStaleLocks({ companyId, agentId, issueId });

    expect(result.hasStaleCheckout).toBe(true);
    expect(result.staleCheckoutRunId).toBe(staleRunId);
  });

  it("does not detect fresh checkout lock as stale", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seedFixture();

    // Must insert the heartbeat run first (FK constraint)
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "succeeded",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fresh checkout",
      status: "in_progress",
      priority: "medium",
      checkoutRunId: staleRunId,
      updatedAt: new Date(), // just now
    });

    const gate = initialModalCleanupGateService(db);
    const result = await gate.detectStaleLocks({ companyId, agentId, issueId });

    expect(result.hasStaleCheckout).toBe(false);
  });

  it("force-cleans stale locks", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seedFixture();

    // Must insert the heartbeat run first (FK constraint)
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "succeeded",
    });

    const staleTime = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale locks",
      status: "in_progress",
      priority: "medium",
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: staleTime,
      executionAgentNameKey: "TestAgent",
      updatedAt: staleTime,
    });

    const gate = initialModalCleanupGateService(db);

    // Before cleanup
    const before = await gate.detectStaleLocks({ companyId, agentId, issueId });
    expect(before.hasStaleCheckout).toBe(true);
    expect(before.hasStaleExecutionLock).toBe(true);

    // Clean
    await gate.forceCleanStaleLocks({ companyId, agentId, issueId });

    // After cleanup
    const after = await gate.detectStaleLocks({ companyId, agentId, issueId });
    expect(after.hasStaleCheckout).toBe(false);
    expect(after.hasStaleExecutionLock).toBe(false);
  });

  it("assertCleanInitialModal succeeds on clean issue", async () => {
    const { companyId, agentId, issueId } = await seedFixture();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Clean",
      status: "todo",
      priority: "medium",
    });

    const gate = initialModalCleanupGateService(db);
    await expect(
      gate.assertCleanInitialModal({ companyId, agentId, issueId }),
    ).resolves.toBeUndefined();
  });

  it("assertCleanInitialModal cleans and succeeds on stale issue", async () => {
    const { companyId, agentId, issueId, staleRunId } = await seedFixture();

    // Must insert the heartbeat run first (FK constraint)
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "succeeded",
    });

    const staleTime = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale",
      status: "in_progress",
      priority: "medium",
      checkoutRunId: staleRunId,
      updatedAt: staleTime,
    });

    const gate = initialModalCleanupGateService(db);
    await expect(
      gate.assertCleanInitialModal({ companyId, agentId, issueId }),
    ).resolves.toBeUndefined();

    // Verify cleaned
    const [row] = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row?.checkoutRunId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lane session continuity tests
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("laneSessionContinuityGateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lane-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: "TST",
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "general",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
    });

    return { companyId, agentId, issueId };
  }

  it("passes when no prior run exists and issue is unlocked", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
  });

  it("passes with breakContinuity=true", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
        breakContinuity: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when prior run exists and is from same agent", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const priorRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId,
      status: "succeeded",
    });

    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
        priorRunId,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when prior run belongs to different agent (lane mismatch)", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const otherAgentId = randomUUID();
    const priorRunId = randomUUID();

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "general",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId: otherAgentId,
      status: "succeeded",
    });

    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
        priorRunId,
      }),
    ).rejects.toThrow();
  });

  it("throws when prior run not found", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
        priorRunId: randomUUID(), // nonexistent
      }),
    ).rejects.toThrow();
  });

  it("throws when issue is locked by a different agent (fail-closed)", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const otherAgentId = randomUUID();
    const lockRunId = randomUUID();

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "general",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: lockRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
    });

    // Lock the issue to the other agent's run
    await db
      .update(issues)
      .set({ executionRunId: lockRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("passes when issue is locked by the same agent", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const lockRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockRunId,
      companyId,
      agentId,
      status: "running",
    });

    // Lock the issue to this agent's run
    await db
      .update(issues)
      .set({ executionRunId: lockRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    const gate = laneSessionContinuityGateService(db);

    await expect(
      gate.assertSessionContinuity({
        companyId,
        agentId,
        issueId,
        currentRunId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
  });
});
