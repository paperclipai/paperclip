import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres unknown-run document route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage for PAP-10583: an agent presents its live X-Paperclip-Run-Id, which
// can reference a heartbeat run that does not exist in this server's DB (e.g. a worktree
// dev environment). The run-id is FK-constrained on issues.checkout_run_id,
// document_revisions.created_by_run_id and activity_log.run_id, so persisting it raised a
// FK violation that surfaced as a 500. Board users were unaffected because they carry no
// run-id. Writes must now succeed (the agent path is the design contract) with run
// provenance degraded to null, while a known run-id is still persisted unchanged.
describeEmbeddedPostgres("issue document writes with an unknown agent run-id", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-document-unknown-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function seed(options: { recordRun: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (options.recordRun) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Doc write",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });

    return { companyId, agentId, runId, issueId };
  }

  it("returns 201 and degrades run provenance to null when the run is unknown to this DB", async () => {
    const { companyId, agentId, runId, issueId } = await seed({ recordRun: false });
    const app = createApp(agentActor(companyId, agentId, runId));

    const created = await request(app)
      .put(`/api/issues/${issueId}/documents/qa-test-doc`)
      .send({ title: "x", format: "markdown", body: "# x" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const revision = await db
      .select({ createdByRunId: documentRevisions.createdByRunId, createdByAgentId: documentRevisions.createdByAgentId })
      .from(documentRevisions)
      .then((rows) => rows[0]);
    // FK-bearing run-id is dropped, but the agent is still recorded as the author.
    expect(revision).toEqual({ createdByRunId: null, createdByAgentId: agentId });

    // Checkout adoption cannot persist a missing run, so ownership is granted without a lock.
    const issueRow = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow).toEqual({ checkoutRunId: null, executionRunId: null });

    // Activity is still logged, with run_id nulled rather than FK-violating.
    const activity = await db
      .select({ action: activityLog.action, runId: activityLog.runId, agentId: activityLog.agentId })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.document_created"))
      .then((rows) => rows[0]);
    expect(activity).toMatchObject({ action: "issue.document_created", runId: null, agentId });

    // A follow-up update on the same doc must also succeed (the existing-document path).
    const updated = await request(app)
      .put(`/api/issues/${issueId}/documents/qa-test-doc`)
      .send({ title: "y", format: "markdown", body: "# y", baseRevisionId: created.body.latestRevisionId });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  });

  it("persists the run-id unchanged when the run exists in this DB", async () => {
    const { companyId, agentId, runId, issueId } = await seed({ recordRun: true });
    const app = createApp(agentActor(companyId, agentId, runId));

    const created = await request(app)
      .put(`/api/issues/${issueId}/documents/qa-test-doc`)
      .send({ title: "x", format: "markdown", body: "# x" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const revision = await db
      .select({ createdByRunId: documentRevisions.createdByRunId })
      .from(documentRevisions)
      .then((rows) => rows[0]);
    expect(revision).toEqual({ createdByRunId: runId });

    const issueRow = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow).toEqual({ checkoutRunId: runId, executionRunId: runId });

    const activity = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.document_created"))
      .then((rows) => rows[0]);
    expect(activity).toEqual({ runId });
  });
});
