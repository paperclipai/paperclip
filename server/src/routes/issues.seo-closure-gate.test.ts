import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";

const { activityLogFailureControl } = vi.hoisted(() => ({
  activityLogFailureControl: {
    failAction: null as string | null,
  },
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    logActivity: vi.fn(async (db, input) => {
      if (activityLogFailureControl.failAction && input.action === activityLogFailureControl.failAction) {
        activityLogFailureControl.failAction = null;
        throw new Error(`forced activity failure for ${input.action}`);
      }
      return actual.logActivity(db, input);
    }),
  };
});

import { issueRoutes } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SEO closure gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Record<string, unknown>;

function createApp(db: ReturnType<typeof createDb>, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("issues route SEO closure gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seo-closure-gate-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    activityLogFailureControl.failAction = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        companies,
        instance_settings
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const cmoAgentId = randomUUID();
    const engineerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: cmoAgentId,
        companyId,
        name: "CMO",
        role: "cmo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const boardApp = createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const cmoApp = createApp(db, {
      type: "agent",
      agentId: cmoAgentId,
      companyId,
      source: "api_key",
    });
    const engineerApp = createApp(db, {
      type: "agent",
      agentId: engineerAgentId,
      companyId,
      source: "api_key",
    });

    return { companyId, boardApp, cmoApp, engineerApp };
  }

  async function createLabel(app: ReturnType<typeof createApp>, companyId: string, name: string) {
    const res = await request(app)
      .post(`/api/companies/${companyId}/labels`)
      .send({ name, color: "#12A150" });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createIssue(
    app: ReturnType<typeof createApp>,
    companyId: string,
    input?: { priority?: "low" | "medium" | "high" | "critical"; labelIds?: string[] },
  ) {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: `SEO closure test ${randomUUID().slice(0, 8)}`,
        priority: input?.priority ?? "medium",
        status: "backlog",
        labelIds: input?.labelIds ?? [],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function addIssueComment(app: ReturnType<typeof createApp>, issueId: string, body: string) {
    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function completeEvidenceComment() {
    return [
      "## URL scope list",
      "- /landing",
      "",
      "## KPI snapshot",
      "- Before: 3.1% CTR, After: 4.0% CTR",
      "",
      "## Technical validation",
      "- canonical and hreflang validator output attached",
      "",
      "## Deployment proof",
      "- PR #42, commit abc123, release 2026.04.21",
      "",
      "## Post-deploy verification",
      "- Search Console reindex + sitemap submission verified",
    ].join("\n");
  }

  function partialEvidenceComment(extra?: string) {
    return [
      "## Scope",
      "- /pricing",
      "",
      "## KPI snapshot",
      "- baseline collected",
      "",
      extra ?? "",
    ].join("\n");
  }

  it("1) allows non-SEO issues to close with no comment", async () => {
    const { companyId, boardApp } = await seedFixture();
    const issueId = await createIssue(boardApp, companyId);

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("2) allows SEO issues to close when all five evidence sections are present", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { labelIds: [seoLabelId] });

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: completeEvidenceComment() });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("3) rejects SEO close with no comment and returns closureTemplate", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { labelIds: [seoLabelId] });

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SEO closure evidence is incomplete");
    expect(res.body.details.missingEvidence).toEqual(expect.arrayContaining([
      "urlScopeList",
      "kpiSnapshot",
      "technicalValidation",
      "deploymentProof",
      "postDeployVerification",
    ]));
    expect(res.body.details.closureTemplate).toContain("### URL scope list");
    expect(res.body.details.closureTemplate).toContain("### KPI snapshot");
    expect(res.body.details.closureTemplate).toContain("### Technical validation");
    expect(res.body.details.closureTemplate).toContain("### Deployment proof");
    expect(res.body.details.closureTemplate).toContain("### Post-deploy verification");
  });

  it("3b) rejects close when the request adds the SEO label alongside status done", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId);

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", labelIds: [seoLabelId] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SEO closure evidence is incomplete");

    const issueRes = await request(boardApp).get(`/api/issues/${issueId}`);
    expect(issueRes.status).toBe(200);
    expect(issueRes.body.status).toBe("backlog");
    expect(issueRes.body.labelIds).toEqual([]);
  });

  it("4) rejects high-priority SEO partial evidence even with valid CMO exception", async () => {
    const { companyId, boardApp, cmoApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "high", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(cmoApp, issueId, "CMO approved temporary exception.");

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(422);
    expect(res.body.details.priority).toBe("high");
    expect(res.body.details.requiresCmoException).toBe(false);
  });

  it("5) allows medium-priority SEO partial evidence only with same-issue CMO exception comment", async () => {
    const { companyId, boardApp, cmoApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "medium", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(cmoApp, issueId, "Approved by CMO.");

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("5b) evaluates the requested priority when closing with a valid CMO exception", async () => {
    const { companyId, boardApp, cmoApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "high", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(cmoApp, issueId, "Approved by CMO after reprioritization.");

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        priority: "medium",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.priority).toBe("medium");
  });

  it("6) rejects medium-priority SEO partial evidence when exception comment is missing", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "medium", labelIds: [seoLabelId] });
    const missingCommentId = randomUUID();

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${missingCommentId}`),
      });

    expect(res.status).toBe(422);
    expect(res.body.details.exceptionCommentId).toBe(missingCommentId);
    expect(res.body.details.exceptionReason).toBe("comment_not_found");
  }, 10_000);

  it("7) rejects medium-priority SEO partial evidence when exception author is not CMO", async () => {
    const { companyId, boardApp, engineerApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "medium", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(engineerApp, issueId, "Engineer says this is okay.");

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(422);
    expect(res.body.details.exceptionCommentId).toBe(exceptionCommentId);
    expect(res.body.details.exceptionReason).toBe("author_not_cmo");
  });

  it("8) logs issue.seo_closure_exception_used for allowed medium/low exception path", async () => {
    const { companyId, boardApp, cmoApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "low", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(cmoApp, issueId, "CMO approved low-priority exception.");

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(200);

    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.seo_closure_exception_used")));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({
      priority: "low",
      missingEvidence: expect.arrayContaining(["technicalValidation", "deploymentProof", "postDeployVerification"]),
      exceptionCommentId,
      source: "seo_closure_gate",
    });
  });

  it("9) rejected closure attempt does not mutate status, add comment, or write bypass audit log", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "medium", labelIds: [seoLabelId] });

    const initialCommentsRes = await request(boardApp).get(`/api/issues/${issueId}/comments`);
    expect(initialCommentsRes.status).toBe(200);
    expect(initialCommentsRes.body).toHaveLength(0);

    const rejectRes = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(),
      });
    expect(rejectRes.status).toBe(422);

    const issueRes = await request(boardApp).get(`/api/issues/${issueId}`);
    expect(issueRes.status).toBe(200);
    expect(issueRes.body.status).toBe("backlog");

    const commentsRes = await request(boardApp).get(`/api/issues/${issueId}/comments`);
    expect(commentsRes.status).toBe(200);
    expect(commentsRes.body).toHaveLength(0);

    const bypassRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.seo_closure_exception_used")));
    expect(bypassRows).toHaveLength(0);
  });

  it("10) honors section aliases and enforces strict checks for 'Checks passed'", async () => {
    const { companyId, boardApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");

    const invalidIssueId = await createIssue(boardApp, companyId, { labelIds: [seoLabelId] });
    const invalidAliasComment = [
      "## Scope",
      "- /docs",
      "",
      "## Metrics delta",
      "- clicks +14%",
      "",
      "## Checks passed",
      "- looks good",
      "",
      "## Release",
      "- commit abc123",
      "",
      "## Verification",
      "- crawled key pages",
    ].join("\n");
    const invalidRes = await request(boardApp)
      .patch(`/api/issues/${invalidIssueId}`)
      .send({ status: "done", comment: invalidAliasComment });
    expect(invalidRes.status).toBe(422);
    expect(invalidRes.body.details.missingEvidence).toContain("technicalValidation");
    expect(invalidRes.body.details.missingEvidence).not.toContain("kpiSnapshot");

    const failingIssueId = await createIssue(boardApp, companyId, { labelIds: [seoLabelId] });
    const explicitFailureComment = [
      "## URL scope",
      "- /docs",
      "",
      "## Metrics delta",
      "- clicks +14%",
      "",
      "## Checks passed",
      "- schema validator failed and sitemap is missing",
      "",
      "## Release",
      "- commit abc123",
      "",
      "## Verification",
      "- crawled key pages",
    ].join("\n");
    const failingRes = await request(boardApp)
      .patch(`/api/issues/${failingIssueId}`)
      .send({ status: "done", comment: explicitFailureComment });
    expect(failingRes.status).toBe(422);
    expect(failingRes.body.details.missingEvidence).toContain("technicalValidation");

    const validIssueId = await createIssue(boardApp, companyId, { labelIds: [seoLabelId] });
    const validAliasComment = [
      "## URL scope",
      "- /blog",
      "",
      "## Metrics delta",
      "- impressions +8%",
      "",
      "## Checks passed",
      "- canonical + hreflang validator outputs clean, sitemap and schema checks passed",
      "",
      "## PR",
      "- PR #77",
      "",
      "## Post deploy",
      "- verified index coverage and rendering",
    ].join("\n");
    const validRes = await request(boardApp)
      .patch(`/api/issues/${validIssueId}`)
      .send({ status: "done", comment: validAliasComment });
    expect(validRes.status).toBe(200);
    expect(validRes.body.status).toBe("done");
  });

  it("11) rolls back the close when the SEO bypass audit log fails", async () => {
    const { companyId, boardApp, cmoApp } = await seedFixture();
    const seoLabelId = await createLabel(boardApp, companyId, "SEO");
    const issueId = await createIssue(boardApp, companyId, { priority: "low", labelIds: [seoLabelId] });
    const exceptionCommentId = await addIssueComment(cmoApp, issueId, "CMO approved low-priority exception.");

    activityLogFailureControl.failAction = "issue.seo_closure_exception_used";

    const res = await request(boardApp)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: partialEvidenceComment(`CMO exception comment: ${exceptionCommentId}`),
      });

    expect(res.status).toBe(500);

    const issueRes = await request(boardApp).get(`/api/issues/${issueId}`);
    expect(issueRes.status).toBe(200);
    expect(issueRes.body.status).toBe("backlog");

    const commentsRes = await request(boardApp).get(`/api/issues/${issueId}/comments`);
    expect(commentsRes.status).toBe(200);
    expect(commentsRes.body).toHaveLength(1);
    expect(commentsRes.body[0]?.id).toBe(exceptionCommentId);

    const bypassRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.seo_closure_exception_used")));
    expect(bypassRows).toHaveLength(0);
  });
});
