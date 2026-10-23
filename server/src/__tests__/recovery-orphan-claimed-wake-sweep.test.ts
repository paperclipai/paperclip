import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphan-claimed-wake sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// SIA-803 regression: two leak classes observed in production on 2026-09-23 —
// (A) 37 claimed wakes whose runs the recovery backstop terminalized as
//     `interrupted/orphaned_running_run` without finalizing the wake, and
// (B) 8 claimed wakes whose runs reached `succeeded` but the wake was never
//     finalized (crash between setRunStatus and setWakeupStatus).
// Both must be finalized by sweepOrphanClaimedWakes; live claims must survive.
describeEmbeddedPostgres("recovery sweepOrphanClaimedWakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-wake-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertRun(
    companyId: string,
    agentId: string,
    status: string,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "manual",
      ...(status === "running" ? { startedAt: new Date() } : { finishedAt: new Date() }),
    });
    return runId;
  }

  async function insertClaimedWake(
    companyId: string,
    agentId: string,
    runId: string | null,
  ) {
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });
    return wakeId;
  }

  it("finalizes claimed wakes whose run was terminalized as interrupted (leak class A)", async () => {
    const { companyId, agentId } = await seed();
    const runId = await insertRun(companyId, agentId, "interrupted");
    const wakeId = await insertClaimedWake(companyId, agentId, runId);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepOrphanClaimedWakes();

    expect(result.finalized).toBe(1);
    expect(result.byRunStatus).toEqual({ interrupted: 1 });

    const [row] = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(row.status).toBe("failed");
    expect(row.finishedAt).not.toBeNull();
  });

  it("finalizes claimed wakes whose run succeeded but never finalized the wake (leak class B)", async () => {
    const { companyId, agentId } = await seed();
    const runId = await insertRun(companyId, agentId, "succeeded");
    const wakeId = await insertClaimedWake(companyId, agentId, runId);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepOrphanClaimedWakes();

    expect(result.finalized).toBe(1);
    expect(result.byRunStatus).toEqual({ succeeded: 1 });

    const [row] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(row.status).toBe("failed");
  });

  it("finalizes claimed wakes whose run row is missing entirely", async () => {
    const { companyId, agentId } = await seed();
    const wakeId = await insertClaimedWake(companyId, agentId, null);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepOrphanClaimedWakes();

    expect(result.finalized).toBe(1);
    expect(result.missingRun).toBe(1);

    const [row] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(row.status).toBe("failed");
  });

  it("preserves claimed wakes whose run is still running or queued, and is idempotent", async () => {
    const { companyId, agentId } = await seed();
    const runningRunId = await insertRun(companyId, agentId, "running");
    const queuedRunId = await insertRun(companyId, agentId, "queued");
    const liveWakeId = await insertClaimedWake(companyId, agentId, runningRunId);
    await insertClaimedWake(companyId, agentId, queuedRunId);
    // also one already-finalized wake: must not be touched
    const terminalRunId = await insertRun(companyId, agentId, "cancelled");
    const orphanWakeId = await insertClaimedWake(companyId, agentId, terminalRunId);

    const first = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepOrphanClaimedWakes();
    expect(first.finalized).toBe(1);
    expect(first.byRunStatus).toEqual({ cancelled: 1 });

    const statuses = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests);
    for (const row of statuses) {
      if (row.id === liveWakeId) expect(row.status).toBe("claimed");
      else if (row.id === orphanWakeId) expect(row.status).toBe("failed");
      else expect(row.status).toBe("claimed");
    }

    // Second sweep is a no-op: no wake storm, no double-finalization.
    const second = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepOrphanClaimedWakes();
    expect(second.finalized).toBe(0);
  });
});
