import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  DETACHED_PROCESS_ERROR_CODE,
  isCheckoutOwningRunOrphan,
  reapOrphanCheckouts,
} from "../services/recovery/orphan-checkout-reaper.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphan checkout reaper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("orphan checkout reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-checkout-reaper-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("treats terminal and missing checkout runs as orphan", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(
      isCheckoutOwningRunOrphan({
        runStatus: "failed",
        runErrorCode: "adapter_failed",
        runUpdatedAt: now,
        hasInMemoryHandle: false,
        now,
        staleThresholdMs: 0,
      }),
    ).toBe(true);
    expect(
      isCheckoutOwningRunOrphan({
        runStatus: null,
        runErrorCode: null,
        runUpdatedAt: null,
        hasInMemoryHandle: false,
        now,
        staleThresholdMs: 0,
      }),
    ).toBe(true);
  });

  it("clears checkout locks held by terminal runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "adapter_failed",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Frozen checkout",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "engineer",
      executionLockedAt: new Date(),
    });

    const result = await reapOrphanCheckouts(db, {
      hasInMemoryRunHandle: () => false,
    });
    expect(result.reaped).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("clears checkout locks held by detached runs without in-memory handles", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const detachedRunId = randomUUID();
    const updatedAt = new Date("2026-06-15T11:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: detachedRunId,
      companyId,
      agentId,
      status: "running",
      errorCode: DETACHED_PROCESS_ERROR_CODE,
      processPid: 424242,
      invocationSource: "manual",
      startedAt: updatedAt,
      updatedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Detached checkout",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: detachedRunId,
      executionRunId: detachedRunId,
      executionAgentNameKey: "engineer",
      executionLockedAt: updatedAt,
    });

    const blocked = await reapOrphanCheckouts(db, {
      now: new Date("2026-06-15T11:02:00.000Z"),
      staleThresholdMs: 5 * 60 * 1000,
      hasInMemoryRunHandle: () => false,
    });
    expect(blocked.reaped).toBe(0);

    const cleared = await reapOrphanCheckouts(db, {
      now: new Date("2026-06-15T11:06:00.000Z"),
      staleThresholdMs: 5 * 60 * 1000,
      hasInMemoryRunHandle: () => false,
    });
    expect(cleared.reaped).toBe(1);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
    });
  });
});
