import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-run evaluation close-out tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function truncateCompaniesWithDeadlockRetry(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "40P01" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

describeEmbeddedPostgres("stale-run evaluation close-out rule (database)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-run-closeout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateCompaniesWithDeadlockRetry(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed one stale-run evaluation card plus the run it was raised against.
   *
   * `runStatus` is the status of the ORIGIN run (the run the watchdog suspected was silent);
   * `cardStatus` is the status of the evaluation card itself.
   */
  async function seedStaleRunCard(opts: {
    runStatus: "running" | "failed" | "timed_out" | "cancelled" | "succeeded";
    cardStatus?: "backlog" | "todo" | "in_progress";
    cardDescription?: string;
    cardComment?: string;
    cardExecutionRunId?: string;
  }) {
    const now = new Date("2026-11-03T05:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const cardId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Closeout Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: opts.runStatus,
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(now.getTime() - 3 * 60 * 60_000),
      finishedAt: opts.runStatus === "running" ? null : new Date(now.getTime() - 60 * 60_000),
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: cardId,
      companyId,
      title: "Review silent active run",
      status: opts.cardStatus ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
      description:
        opts.cardDescription ??
        "Paperclip detected suspicious output silence on an active heartbeat run.\n\n- Last output sequence: 0\n",
      executionRunId: opts.cardExecutionRunId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.cardComment) {
      await db.insert(issueComments).values({
        companyId,
        issueId: cardId,
        authorAgentId: agentId,
        authorType: "agent",
        body: opts.cardComment,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { now, companyId, agentId, runId, cardId };
  }

  it("auto-closes the card and records the reason when the origin run is terminal", async () => {
    const { now, companyId, cardId, runId } = await seedStaleRunCard({ runStatus: "timed_out" });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const result = await recovery.autoCloseTerminalStaleRunEvaluations({ now, companyId });

    expect(result.closed).toBe(1);
    expect(result.closedIdentifiers).toHaveLength(1);

    const [card] = await db.select().from(issues).where(sql`${issues.id} = ${cardId}`);
    expect(card?.status).toBe("done");

    // The reason must be on the card, not silently dropped.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(sql`${issueComments.issueId} = ${cardId}`);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stale-run-evaluation:auto-close");
    expect(comments[0]?.body).toContain(runId);
    expect(comments[0]?.body).toContain("timed_out");
  });

  it("leaves the card alone while the origin run is still active", async () => {
    const { now, companyId, cardId } = await seedStaleRunCard({ runStatus: "running" });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const result = await recovery.autoCloseTerminalStaleRunEvaluations({ now, companyId });

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    const [card] = await db.select().from(issues).where(sql`${issues.id} = ${cardId}`);
    expect(card?.status).toBe("todo");
  });

  it("leaves the card alone when it asks for artifact recovery", async () => {
    const { now, companyId, cardId } = await seedStaleRunCard({
      runStatus: "failed",
      cardComment: "Please recover the run log for this card before closing it.",
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const result = await recovery.autoCloseTerminalStaleRunEvaluations({ now, companyId });

    expect(result.closed).toBe(0);
    const [card] = await db.select().from(issues).where(sql`${issues.id} = ${cardId}`);
    expect(card?.status).toBe("todo");
  });

  it("is idempotent: a second run closes nothing and adds no second comment", async () => {
    const { now, companyId, cardId } = await seedStaleRunCard({ runStatus: "failed" });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const first = await recovery.autoCloseTerminalStaleRunEvaluations({ now, companyId });
    const second = await recovery.autoCloseTerminalStaleRunEvaluations({ now, companyId });

    expect(first.closed).toBe(1);
    expect(second.closed).toBe(0);
    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(sql`${issueComments.issueId} = ${cardId}`);
    expect(comments).toHaveLength(1);
  });
});
