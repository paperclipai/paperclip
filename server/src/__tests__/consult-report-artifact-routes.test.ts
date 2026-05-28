import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  consultReportArtifacts,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT,
  CONSULT_REPORT_ARTIFACT_LIST_MAX_LIMIT,
} from "../services/consult-report-artifacts.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const boardActor: Express.Request["actor"] = {
  type: "board",
  userId: "board-user",
  companyIds: [],
  memberships: [],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp(db: Db) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Consult report ${label}`,
      issuePrefix: `CR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedIssue(db: Db, companyId: string, input: { title: string; parentId?: string | null }) {
  return db
    .insert(issues)
    .values({
      companyId,
      title: input.title,
      identifier: `CR-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      status: "in_progress",
      priority: "medium",
      parentId: input.parentId ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Release ${randomUUID()}`,
      role: "release",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedDocument(db: Db, companyId: string, issueId: string, key = "plan") {
  const document = await db
    .insert(documents)
    .values({
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan",
      createdByUserId: "board-user",
      updatedByUserId: "board-user",
    })
    .returning()
    .then((rows) => rows[0]!);

  await db.insert(issueDocuments).values({
    companyId,
    issueId,
    documentId: document.id,
    key,
  });

  return document;
}

const artifactBody = {
  decision: "Ship the narrow consult/report artifact MVP.",
  evidence: "The parent plan requires five structured fields.",
  risk: "Schema changes need focused route coverage.",
  nextOwnerText: "Release Engineer",
};

function artifactRow(
  companyId: string,
  issueId: string,
  index: number,
  input: { reportNeeded?: boolean; createdAt?: Date } = {},
) {
  const reportNeeded = input.reportNeeded ?? false;
  const createdAt = input.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index));

  return {
    companyId,
    sourceIssueId: issueId,
    accountableIssueId: issueId,
    sourceType: "issue",
    decision: `Decision ${index}`,
    evidence: artifactBody.evidence,
    risk: artifactBody.risk,
    nextOwnerText: artifactBody.nextOwnerText,
    reportNeeded,
    reportReason: reportNeeded ? `Reason ${index}` : null,
    createdAt,
    updatedAt: createdAt,
  };
}

describeEmbeddedPostgres("consult report artifact routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-consult-report-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(consultReportArtifacts);
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a false issue artifact and keeps it out of the company rollup", async () => {
    const company = await seedCompany(db, "false");
    const issue = await seedIssue(db, company.id, { title: "Implementation child" });
    const app = await createApp(db);

    const createRes = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send(artifactBody);

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      sourceType: "issue",
      sourceIssueId: issue.id,
      accountableIssueId: issue.id,
      reportNeeded: false,
      reportReason: null,
      source: {
        type: "issue",
        issue: { id: issue.id, title: issue.title, status: issue.status },
      },
    });

    const issueArtifacts = await request(app).get(`/api/issues/${issue.id}/consult-report-artifacts`);
    expect(issueArtifacts.status, JSON.stringify(issueArtifacts.body)).toBe(200);
    expect(issueArtifacts.body).toHaveLength(1);
    expect(issueArtifacts.body[0].id).toBe(createRes.body.id);

    const rollup = await request(app).get(`/api/companies/${company.id}/consult-report-artifacts?reportNeeded=true`);
    expect(rollup.status, JSON.stringify(rollup.body)).toBe(200);
    expect(rollup.body).toEqual([]);

    const missingReportNeeded = await request(app).get(`/api/companies/${company.id}/consult-report-artifacts`);
    expect(missingReportNeeded.status, JSON.stringify(missingReportNeeded.body)).toBe(400);
  }, 15_000);

  it("defaults and paginates issue-scoped artifact lists", async () => {
    const company = await seedCompany(db, "issue-page");
    const issue = await seedIssue(db, company.id, { title: "Paged artifact issue" });
    const app = await createApp(db);
    await db.insert(consultReportArtifacts).values(
      Array.from({ length: CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT + 5 }, (_value, index) =>
        artifactRow(company.id, issue.id, index)),
    );

    const defaultPage = await request(app).get(`/api/issues/${issue.id}/consult-report-artifacts`);
    expect(defaultPage.status, JSON.stringify(defaultPage.body)).toBe(200);
    expect(defaultPage.body).toHaveLength(CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT);
    expect(defaultPage.body[0].decision).toBe(`Decision ${CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT + 4}`);
    expect(defaultPage.body[defaultPage.body.length - 1].decision).toBe("Decision 5");

    const secondWindow = await request(app).get(`/api/issues/${issue.id}/consult-report-artifacts?limit=2&offset=3`);
    expect(secondWindow.status, JSON.stringify(secondWindow.body)).toBe(200);
    expect(secondWindow.body.map((artifact: { decision: string }) => artifact.decision)).toEqual([
      `Decision ${CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT + 1}`,
      `Decision ${CONSULT_REPORT_ARTIFACT_LIST_DEFAULT_LIMIT}`,
    ]);

    const invalidLimit = await request(app).get(`/api/issues/${issue.id}/consult-report-artifacts?limit=0`);
    expect(invalidLimit.status, JSON.stringify(invalidLimit.body)).toBe(400);
  }, 15_000);

  it("rolls up true comment-source artifacts with source and accountable issue links", async () => {
    const company = await seedCompany(db, "true");
    const accountableIssue = await seedIssue(db, company.id, { title: "Parent decision" });
    const issue = await seedIssue(db, company.id, { title: "Advisor child", parentId: accountableIssue.id });
    const agent = await seedAgent(db, company.id);
    const comment = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: issue.id,
        body: "Decision: report upward.",
        authorAgentId: agent.id,
        authorType: "agent",
      })
      .returning()
      .then((rows) => rows[0]!);
    const app = await createApp(db);

    const createRes = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send({
        ...artifactBody,
        sourceType: "comment",
        sourceCommentId: comment.id,
        nextOwnerAgentId: agent.id,
        reportNeeded: true,
        reportReason: "Needs manager action on release authority.",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      sourceType: "comment",
      sourceCommentId: comment.id,
      accountableIssueId: accountableIssue.id,
      reportNeeded: true,
      reportReason: "Needs manager action on release authority.",
      source: {
        commentId: comment.id,
        issue: { id: issue.id, title: issue.title },
      },
      accountableIssue: { id: accountableIssue.id, title: accountableIssue.title },
      nextOwner: {
        agent: { id: agent.id, name: agent.name },
      },
    });

    const rollup = await request(app).get(`/api/companies/${company.id}/consult-report-artifacts?reportNeeded=true`);
    expect(rollup.status, JSON.stringify(rollup.body)).toBe(200);
    expect(rollup.body).toHaveLength(1);
    expect(rollup.body[0]).toMatchObject({
      id: createRes.body.id,
      reportNeeded: true,
      source: { commentId: comment.id, issue: { id: issue.id } },
      accountableIssue: { id: accountableIssue.id },
    });
  }, 15_000);

  it("caps and filters company report-needed artifact lists", async () => {
    const company = await seedCompany(db, "company-page");
    const issue = await seedIssue(db, company.id, { title: "Report-needed rollup issue" });
    const app = await createApp(db);
    await db.insert(consultReportArtifacts).values([
      ...Array.from({ length: CONSULT_REPORT_ARTIFACT_LIST_MAX_LIMIT + 5 }, (_value, index) =>
        artifactRow(company.id, issue.id, index, { reportNeeded: true })),
      artifactRow(company.id, issue.id, 200, { reportNeeded: false }),
    ]);

    const capped = await request(app)
      .get(`/api/companies/${company.id}/consult-report-artifacts?reportNeeded=true&limit=5000`);
    expect(capped.status, JSON.stringify(capped.body)).toBe(200);
    expect(capped.body).toHaveLength(CONSULT_REPORT_ARTIFACT_LIST_MAX_LIMIT);
    expect(capped.body.every((artifact: { reportNeeded: boolean }) => artifact.reportNeeded)).toBe(true);
    expect(capped.body[0].decision).toBe(`Decision ${CONSULT_REPORT_ARTIFACT_LIST_MAX_LIMIT + 4}`);

    const finalWindow = await request(app)
      .get(`/api/companies/${company.id}/consult-report-artifacts?reportNeeded=true&limit=10&offset=${CONSULT_REPORT_ARTIFACT_LIST_MAX_LIMIT}`);
    expect(finalWindow.status, JSON.stringify(finalWindow.body)).toBe(200);
    expect(finalWindow.body).toHaveLength(5);
  }, 15_000);

  it("creates document-source artifacts by issue document key", async () => {
    const company = await seedCompany(db, "document");
    const issue = await seedIssue(db, company.id, { title: "Document source issue" });
    const document = await seedDocument(db, company.id, issue.id, "consult");
    const app = await createApp(db);

    const createRes = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send({
        ...artifactBody,
        sourceType: "document",
        sourceDocumentKey: "consult",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      sourceType: "document",
      sourceDocumentId: document.id,
      sourceDocumentKey: "consult",
      source: {
        document: { id: document.id, key: "consult" },
      },
    });
  }, 15_000);

  it("rejects report-needed artifacts without a reason and unrelated source links", async () => {
    const company = await seedCompany(db, "reject");
    const otherCompany = await seedCompany(db, "other");
    const issue = await seedIssue(db, company.id, { title: "Source issue" });
    const otherIssue = await seedIssue(db, otherCompany.id, { title: "Other company issue" });
    const otherComment = await db
      .insert(issueComments)
      .values({
        companyId: otherCompany.id,
        issueId: otherIssue.id,
        body: "Wrong company.",
        authorType: "user",
        authorUserId: "board-user",
      })
      .returning()
      .then((rows) => rows[0]!);
    const app = await createApp(db);

    const missingReason = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send({
        ...artifactBody,
        reportNeeded: true,
      });
    expect(missingReason.status, JSON.stringify(missingReason.body)).toBe(400);

    const wrongComment = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send({
        ...artifactBody,
        sourceType: "comment",
        sourceCommentId: otherComment.id,
      });
    expect(wrongComment.status, JSON.stringify(wrongComment.body)).toBe(422);

    const wrongAccountable = await request(app)
      .post(`/api/issues/${issue.id}/consult-report-artifacts`)
      .send({
        ...artifactBody,
        accountableIssueId: otherIssue.id,
      });
    expect(wrongAccountable.status, JSON.stringify(wrongAccountable.body)).toBe(422);
  }, 15_000);

  it("leaves existing markdown-only comment and document flows out of rollup", async () => {
    const company = await seedCompany(db, "compat");
    const issue = await seedIssue(db, company.id, { title: "Compatibility issue" });
    const app = await createApp(db);

    const commentRes = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({
        body: [
          "## Consult Artifact",
          "",
          "- Decision: keep markdown-only compatibility",
          "- Report-needed: true",
        ].join("\n"),
        authorType: "user",
      });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const documentRes = await request(app)
      .put(`/api/issues/${issue.id}/documents/consult`)
      .send({
        title: "Consult",
        format: "markdown",
        body: "Decision: document-only note\n\nReport-needed: true",
      });
    expect(documentRes.status, JSON.stringify(documentRes.body)).toBe(201);

    const comments = await request(app).get(`/api/issues/${issue.id}/comments?order=asc`);
    expect(comments.status, JSON.stringify(comments.body)).toBe(200);
    expect(comments.body.map((comment: { body: string }) => comment.body)).toContain(commentRes.body.body);

    const docs = await request(app).get(`/api/issues/${issue.id}/documents`);
    expect(docs.status, JSON.stringify(docs.body)).toBe(200);
    expect(docs.body).toEqual(expect.arrayContaining([expect.objectContaining({ key: "consult" })]));

    const rollup = await request(app).get(`/api/companies/${company.id}/consult-report-artifacts?reportNeeded=true`);
    expect(rollup.status, JSON.stringify(rollup.body)).toBe(200);
    expect(rollup.body).toEqual([]);
  }, 15_000);
});
