import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
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
import { runtimeIntegrityService } from "../services/runtime-integrity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("runtime integrity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-integrity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input?: { companyStatus?: "active" | "paused" | "archived"; agentStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Runtime Integrity Co",
      issuePrefix,
      status: input?.companyStatus ?? "active",
      pauseReason: input?.companyStatus === "paused" ? "manual" : null,
      pausedAt: input?.companyStatus === "paused" ? new Date("2026-04-18T09:00:00.000Z") : null,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "COO",
      role: "coo",
      status: (input?.agentStatus as "idle" | "running" | "paused" | "terminated" | "error" | "pending_approval" | undefined) ?? "idle",
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

    return { companyId, agentId, issuePrefix };
  }

  it("terminalizes a queued wakeup when the linked run is cancelled", async () => {
    const { companyId, agentId } = await seedCompany();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: {},
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "cancelled",
      wakeupRequestId,
      contextSnapshot: { wakeReason: "heartbeat_timer" },
      error: "Cancelled due to company pause",
      errorCode: "cancelled",
      finishedAt: new Date("2026-04-18T10:00:00.000Z"),
    });

    const result = await runtimeIntegrityService(db).reconcileAll();

    expect(result.wakeupsReconciled).toBe(1);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(wakeup?.status).toBe("cancelled");
    expect(wakeup?.error).toContain("company pause");
  });

  it("cancels queued runs that belong to archived companies", async () => {
    const { companyId, agentId } = await seedCompany({ companyStatus: "archived" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: {},
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });

    const result = await runtimeIntegrityService(db).reconcileAll();

    expect(result.runsCancelled).toBe(1);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("archived");
    expect(wakeup?.status).toBe("cancelled");
  });

  it("normalizes impossible in-progress issues back to todo", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Broken in-progress issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const result = await runtimeIntegrityService(db).reconcileAll();

    expect(result.issuesNormalized).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("todo");
    expect(issue?.assigneeAgentId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
  });

  it("rebinds in-progress ownership when there is exactly one live run for the issue", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

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
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date("2026-04-18T10:00:00.000Z"),
      updatedAt: new Date("2026-04-18T10:00:10.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recoverable in-progress issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    const result = await runtimeIntegrityService(db).reconcileAll();

    expect(result.issuesRebound).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBe(runId);
    expect(issue?.executionRunId).toBe(runId);
  });
});
