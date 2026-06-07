import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
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
    `Skipping embedded Postgres stale-lock takeover tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("issueService.checkout stale-lock takeover", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-stale-lock-takeover-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSameAgentReentryScene() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const priorRunId = randomUUID();
    const newRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Prior run already cancelled (e.g. by the graceful shutdown drain) but
    // the issue row still references it as the active checkoutRunId.
    // The new run is the live one the actor brings to the checkout call.
    await db.insert(heartbeatRuns).values([
      {
        id: priorRunId,
        companyId,
        agentId,
        status: "cancelled",
        invocationSource: "manual",
        finishedAt: new Date(),
        errorCode: "server_shutdown_stale_lock_cleanup",
      },
      {
        id: newRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Producer-1 dogfood reentry",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: priorRunId,
      executionRunId: priorRunId,
      executionAgentNameKey: "producer",
      executionLockedAt: new Date(),
    });

    return { companyId, agentId, priorRunId, newRunId, issueId };
  }

  it("lets the same agent take over a stale lock and writes an audit row", async () => {
    const { companyId, agentId, priorRunId, newRunId, issueId } =
      await seedSameAgentReentryScene();

    const result = await svc.checkout(issueId, agentId, ["in_progress"], newRunId);
    expect(result?.id).toBe(issueId);
    expect(result?.checkoutRunId).toBe(newRunId);
    expect(result?.executionRunId).toBe(newRunId);

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.stale_lock_takeover"),
        ),
      )
      .then((rows) => rows[0]);

    expect(audit).toBeTruthy();
    expect(audit).toMatchObject({
      action: "issue.stale_lock_takeover",
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: newRunId,
      entityType: "issue",
      entityId: issueId,
      details: {
        priorCheckoutRunId: priorRunId,
        actorRunId: newRunId,
        source: "adoptStaleCheckoutRun",
      },
    });
  });

  it("refuses to take over the lock for a different (non-assignee) agent — cross-agent regression", async () => {
    const { companyId, priorRunId, newRunId, issueId } = await seedSameAgentReentryScene();

    const intruderId = randomUUID();
    await db.insert(agents).values({
      id: intruderId,
      companyId,
      name: "Intruder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(
      svc.checkout(issueId, intruderId, ["in_progress"], newRunId),
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // The intruder must not own the checkout lock; the assignee/lock binding
    // is preserved. (`executionRunId` may legitimately be cleared because the
    // prior run is in a terminal state — the gate is the `checkoutRunId`
    // assignee binding, not the execution lock byproduct.)
    expect(row?.assigneeAgentId).not.toBe(intruderId);
    expect(row?.checkoutRunId).toBe(priorRunId);
    expect(row?.checkoutRunId).not.toBe(newRunId);

    const audit = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_takeover"))
      .then((rows) => rows.length);
    expect(audit).toBe(0);
  });
});
