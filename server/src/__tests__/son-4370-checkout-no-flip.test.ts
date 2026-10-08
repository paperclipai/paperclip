import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// SON-4370 acceptance 3: checking out a parked `blocked` card records the
// run (checkoutRunId/executionRunId) WITHOUT a status transition — status
// and startedAt are preserved — while a non-blocked card still flips to
// in_progress with a fresh startedAt.

describe("SON-4370 checkout records the run without flipping a parked blocked card", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const blockedIssueId = randomUUID();
  const controlIssueId = randomUUID();
  const parkedStartedAt = new Date("2026-09-24T00:00:00.000Z");

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-son4370-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "SON-4370 checkout no-flip",
      issuePrefix: "S4370",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout agent",
      adapterType: "codex_local",
      status: "idle",
      runtimeConfig: {},
    });
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Parked blocked watchdog card",
        status: "blocked",
        workMode: "standard",
        assigneeAgentId: agentId,
        startedAt: parkedStartedAt,
      },
      {
        id: controlIssueId,
        companyId,
        title: "Control todo card",
        status: "todo",
        workMode: "standard",
        assigneeAgentId: agentId,
        startedAt: null,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (temporary) await temporary.cleanup();
  });

  it("records the run on a parked blocked card while status and startedAt stay parked", async () => {
    const svc = issueService(db);
    const runId = randomUUID();
    const before = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      responsibleUserId: "responsible-user",
      createdAt: before,
      startedAt: before,
    });
    const checkedOut = await svc.checkout(
      blockedIssueId,
      agentId,
      ["todo", "backlog", "blocked"],
      runId,
    );
    expect(checkedOut).toMatchObject({
      id: blockedIssueId,
      status: "blocked",
      checkoutRunId: runId,
      executionRunId: runId,
    });
    expect(new Date(checkedOut.startedAt!).toISOString()).toBe(
      parkedStartedAt.toISOString(),
    );
    expect(new Date(checkedOut.updatedAt!).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );

    // Durable state matches the returned row: the park survived the write.
    const [row] = await db
      .select({ status: issues.status, startedAt: issues.startedAt, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(row).toMatchObject({ status: "blocked", checkoutRunId: runId });
    expect(new Date(row.startedAt!).toISOString()).toBe(parkedStartedAt.toISOString());
  });

  it("still flips a todo card to in_progress with a fresh startedAt", async () => {
    const svc = issueService(db);
    const runId = randomUUID();
    const before = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      responsibleUserId: "responsible-user",
      createdAt: before,
      startedAt: before,
    });
    const checkedOut = await svc.checkout(
      controlIssueId,
      agentId,
      ["todo", "backlog", "blocked"],
      runId,
    );
    expect(checkedOut).toMatchObject({
      id: controlIssueId,
      status: "in_progress",
      checkoutRunId: runId,
      executionRunId: runId,
    });
    expect(new Date(checkedOut.startedAt!).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });
});
