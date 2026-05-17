import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stale-checkout regression tests: ${embeddedPostgresSupport.reason ?? "embedded postgres unsupported"}`,
  );
}

// Regression coverage for CLAAA-48 / CLAAA-50: stale checkoutRunId must not
// orphan issues when the prior run is terminal-equivalent (status terminal,
// missing entirely, or running-but-stalled past LIVENESS_STALE_MS).
describeEmbeddedPostgres("issueService stale checkoutRunId adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-checkout-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  async function withDisabledForeignKeyChecks<T>(fn: () => Promise<T>): Promise<T> {
    await db.execute(sql`set session_replication_role = replica`);
    try {
      return await fn();
    } finally {
      await db.execute(sql`set session_replication_role = origin`);
    }
  }

  /** Heartbeat run row required for successful checkout adoption (FK on issues.checkout_run_id). */
  async function seedActorHeartbeatRun(runId: string) {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      updatedAt: new Date(),
    });
  }

  async function seedIssueLockedByRun(runId: string, runStatus: string, opts?: {
    runUpdatedAtOffsetMs?: number;
    skipRun?: boolean;
  }) {
    const issueId = randomUUID();
    if (opts?.skipRun) {
      // FK + onDelete would normally prevent a dangling checkout_run_id; replication
      // mode skips FK triggers so we can model historical / manual drift that
      // isTerminalOrMissingHeartbeatRun still handles.
      await withDisabledForeignKeyChecks(async () => {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: "Locked issue",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
          checkoutRunId: runId,
          executionRunId: runId,
        });
      });
      return issueId;
    }

    const updatedAt = new Date(Date.now() + (opts?.runUpdatedAtOffsetMs ?? 0));
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: runStatus,
      updatedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });
    return issueId;
  }

  it("adopts an issue when the prior run row reached a terminal status", async () => {
    await seedCompanyAndAgent();
    const priorRunId = randomUUID();
    const issueId = await seedIssueLockedByRun(priorRunId, "failed");

    const newRunId = randomUUID();
    await seedActorHeartbeatRun(newRunId);
    const adopted = await svc.checkout(issueId, agentId, ["in_progress"], newRunId);

    expect(adopted.checkoutRunId).toBe(newRunId);
    const row = await db
      .select({ runId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.runId).toBe(newRunId);
  });

  it("adopts when the prior run is running but stalled past LIVENESS_STALE_MS", async () => {
    await seedCompanyAndAgent();
    const priorRunId = randomUUID();
    const issueId = await seedIssueLockedByRun(priorRunId, "running", {
      runUpdatedAtOffsetMs: -5 * 60_000,
    });

    const newRunId = randomUUID();
    await seedActorHeartbeatRun(newRunId);
    const adopted = await svc.checkout(issueId, agentId, ["in_progress"], newRunId);
    expect(adopted.checkoutRunId).toBe(newRunId);
  });

  it("rejects checkout when the prior run is genuinely live", async () => {
    await seedCompanyAndAgent();
    const priorRunId = randomUUID();
    const issueId = await seedIssueLockedByRun(priorRunId, "running", {
      runUpdatedAtOffsetMs: 0,
    });

    const newRunId = randomUUID();
    await expect(
      svc.checkout(issueId, agentId, ["in_progress"], newRunId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("adopts when the prior run row is missing entirely", async () => {
    await seedCompanyAndAgent();
    const priorRunId = randomUUID();
    const issueId = await seedIssueLockedByRun(priorRunId, "running", { skipRun: true });

    const newRunId = randomUUID();
    await seedActorHeartbeatRun(newRunId);
    const adopted = await svc.checkout(issueId, agentId, ["in_progress"], newRunId);
    expect(adopted.checkoutRunId).toBe(newRunId);
  });
});
