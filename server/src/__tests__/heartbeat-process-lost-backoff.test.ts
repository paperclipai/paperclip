import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  agents,
  agentWakeupRequests,
  createDb,
  companies,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PROCESS_LOST_BACKOFF_DELAYS_MS,
  PROCESS_LOST_BACKOFF_THRESHOLD,
  PROCESS_LOST_BACKOFF_WINDOW_MS,
  computeProcessLostBackoffDecision,
  deriveProcessLostBackoffDelayMs,
} from "../services/heartbeat-process-lost-backoff.ts";

describe("deriveProcessLostBackoffDelayMs", () => {
  it("returns 0 for counts below the threshold", () => {
    for (let i = 0; i < PROCESS_LOST_BACKOFF_THRESHOLD; i += 1) {
      expect(deriveProcessLostBackoffDelayMs(i)).toBe(0);
    }
  });

  it("returns the canonical delay table from the SPC-6121 spec", () => {
    expect(deriveProcessLostBackoffDelayMs(5)).toBe(30_000);
    expect(deriveProcessLostBackoffDelayMs(6)).toBe(60_000);
    expect(deriveProcessLostBackoffDelayMs(7)).toBe(120_000);
    expect(deriveProcessLostBackoffDelayMs(8)).toBe(300_000);
  });

  it("caps at the maximum delay for high counts", () => {
    const cap = PROCESS_LOST_BACKOFF_DELAYS_MS[PROCESS_LOST_BACKOFF_DELAYS_MS.length - 1];
    expect(deriveProcessLostBackoffDelayMs(20)).toBe(cap);
    expect(deriveProcessLostBackoffDelayMs(1_000)).toBe(cap);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres process_lost backoff tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("computeProcessLostBackoffDecision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-process-lost-backoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(): Promise<{ companyId: string; agentId: string; issueId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backoff Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Process_lost backoff fixture",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function insertTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: "failed" | "succeeded" | "cancelled" | "timed_out";
    errorCode?: string | null;
    finishedAt: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.status,
      contextSnapshot: { issueId: input.issueId },
      errorCode: input.errorCode ?? null,
      startedAt: new Date(input.finishedAt.getTime() - 10_000),
      finishedAt: input.finishedAt,
      createdAt: new Date(input.finishedAt.getTime() - 10_000),
      updatedAt: input.finishedAt,
    });
    return runId;
  }

  it("returns zero delay when no terminal runs exist on the issue", async () => {
    const { companyId, issueId } = await seedFixture();
    const now = new Date("2026-05-25T00:00:00.000Z");

    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now,
    });

    expect(decision.consecutiveCount).toBe(0);
    expect(decision.requiredDelayMs).toBe(0);
    expect(decision.remainingDelayMs).toBe(0);
  });

  it("returns zero delay for fewer than 5 consecutive process_lost failures", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();

    for (let i = 0; i < 4; i += 1) {
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(baseTime + i * 11_000),
      });
    }
    const now = new Date(baseTime + 5 * 11_000);

    const decision = await computeProcessLostBackoffDecision(db, { companyId, issueId, now });

    expect(decision.consecutiveCount).toBe(4);
    expect(decision.requiredDelayMs).toBe(0);
    expect(decision.remainingDelayMs).toBe(0);
  });

  it("requires 30s delay after 5 consecutive process_lost failures", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();
    let latestFinishedAt = baseTime;

    for (let i = 0; i < 5; i += 1) {
      latestFinishedAt = baseTime + i * 11_000;
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(latestFinishedAt),
      });
    }

    // Polled exactly when the 5th failure landed → 30s remaining
    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt),
    });
    expect(decision.consecutiveCount).toBe(5);
    expect(decision.requiredDelayMs).toBe(30_000);
    expect(decision.remainingDelayMs).toBe(30_000);

    // 15 seconds after the last failure → 15s remaining
    const partial = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt + 15_000),
    });
    expect(partial.remainingDelayMs).toBe(15_000);

    // After the full 30 seconds have elapsed → fully eligible (0 remaining)
    const eligible = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt + 30_000),
    });
    expect(eligible.remainingDelayMs).toBe(0);
    expect(eligible.requiredDelayMs).toBe(30_000);
  });

  it("walks the exponential schedule: 6→60s, 7→120s, 8→300s, 12→300s (capped)", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();
    let cursor = baseTime;
    let latestFinishedAt = baseTime;

    for (let i = 0; i < 12; i += 1) {
      cursor += 11_000;
      latestFinishedAt = cursor;
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(cursor),
      });
    }

    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt),
      // Window is 5 min = 300s; we placed 12 failures spanning 132 s, all within window.
      lookback: 20,
    });
    expect(decision.consecutiveCount).toBe(12);
    // Count=12 → stepIndex = min(12-5, 3) = 3 → 300 000 ms cap
    expect(decision.requiredDelayMs).toBe(300_000);
  });

  it("resets the counter when a successful run breaks the chain", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();

    // 6 process_lost failures
    for (let i = 0; i < 6; i += 1) {
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(baseTime + i * 11_000),
      });
    }
    // …then a successful run on top
    const successFinishedAt = new Date(baseTime + 7 * 11_000);
    await insertTerminalRun({
      companyId,
      agentId,
      issueId,
      status: "succeeded",
      errorCode: null,
      finishedAt: successFinishedAt,
    });

    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(successFinishedAt.getTime() + 1_000),
    });
    expect(decision.consecutiveCount).toBe(0);
    expect(decision.requiredDelayMs).toBe(0);
    expect(decision.remainingDelayMs).toBe(0);
  });

  it("ignores process_lost failures outside the 5-minute window", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();

    // 3 ancient process_lost failures (10+ minutes before the newest)
    for (let i = 0; i < 3; i += 1) {
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(baseTime + i * 1_000),
      });
    }
    // 4 recent process_lost failures clustered near `latest`
    const recentBase = baseTime + PROCESS_LOST_BACKOFF_WINDOW_MS + 60_000;
    let latestFinishedAt = recentBase;
    for (let i = 0; i < 4; i += 1) {
      latestFinishedAt = recentBase + i * 5_000;
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(latestFinishedAt),
      });
    }

    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt),
    });
    // Only the 4 recent ones are within the window from the newest; the ancient ones drop out.
    expect(decision.consecutiveCount).toBe(4);
    expect(decision.requiredDelayMs).toBe(0);
  });

  it("does not count process_lost failures separated by a non-process_lost terminal run", async () => {
    const { companyId, agentId, issueId } = await seedFixture();
    const baseTime = new Date("2026-05-25T00:00:00.000Z").getTime();

    // 3 old process_lost failures
    for (let i = 0; i < 3; i += 1) {
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(baseTime + i * 1_000),
      });
    }
    // A different terminal failure (timeout) breaks the chain
    await insertTerminalRun({
      companyId,
      agentId,
      issueId,
      status: "timed_out",
      errorCode: "process_timeout",
      finishedAt: new Date(baseTime + 3 * 1_000),
    });
    // 4 new process_lost after the break
    let latestFinishedAt = baseTime;
    for (let i = 0; i < 4; i += 1) {
      latestFinishedAt = baseTime + 10_000 + i * 1_000;
      await insertTerminalRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        errorCode: "process_lost",
        finishedAt: new Date(latestFinishedAt),
      });
    }

    const decision = await computeProcessLostBackoffDecision(db, {
      companyId,
      issueId,
      now: new Date(latestFinishedAt),
    });
    // Only the 4 newest, which were not separated by the timeout, count.
    expect(decision.consecutiveCount).toBe(4);
    expect(decision.requiredDelayMs).toBe(0);
  });
});
