import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  documentLinks,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { documentRoutes } from "../routes/documents.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("document routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(documentRevisions);
    await db.delete(documentLinks);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        userName: "Local Board",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", documentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(label: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Company ${label}`,
      issuePrefix: `D${label}${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedIssueDocument(companyId: string, identifier: string, body: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: `Issue ${identifier}`,
      description: null,
      status: "in_progress",
      priority: "medium",
    });
    const result = await documentService(db).upsertIssueDocument({
      issueId,
      key: "plan",
      title: `${identifier} plan`,
      format: "markdown",
      body,
    });
    return { issueId, document: result.document };
  }

  it("lists and searches only documents in the requested company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const docA = await seedIssueDocument(companyA, "DA-1", "Alpha roadmap");
    const docB = await seedIssueDocument(companyB, "DB-1", "Alpha secret");

    const app = createApp();

    const list = await request(app).get(`/api/companies/${companyA}/documents`).expect(200);
    expect(list.body.map((doc: { id: string }) => doc.id)).toEqual([docA.document.id]);

    const search = await request(app)
      .get(`/api/companies/${companyA}/documents`)
      .query({ q: "Alpha" })
      .expect(200);
    expect(search.body.map((doc: { id: string }) => doc.id)).toEqual([docA.document.id]);

    await request(app).get(`/api/companies/${companyA}/documents/${docB.document.id}`).expect(404);
  });

  it("rejects document links to targets from another company and logs same-company link mutations", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const docA = await seedIssueDocument(companyA, "DA-1", "Linkable plan");
    const issueB = await seedIssueDocument(companyB, "DB-1", "Other plan");
    const linkedIssue = await seedIssueDocument(companyA, "DA-2", "Related plan");

    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyA}/documents/${docA.document.id}/links`)
      .send({ targetType: "issue", targetId: issueB.issueId })
      .expect(404);

    const created = await request(app)
      .post(`/api/companies/${companyA}/documents/${docA.document.id}/links`)
      .send({ targetType: "issue", targetId: linkedIssue.issueId, relationship: "supporting" })
      .expect(201);

    expect(created.body).toEqual(expect.objectContaining({
      documentId: docA.document.id,
      targetType: "issue",
      targetId: linkedIssue.issueId,
      relationship: "supporting",
    }));

    const activity = await db.select().from(activityLog);
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: companyA,
        action: "document.link_created",
        entityId: docA.document.id,
      }),
    ]));
  });

  it("returns 400 for a malformed document id instead of a 500 (PAP-10582)", async () => {
    const companyA = await seedCompany("A");
    const app = createApp();

    const res = await request(app)
      .get(`/api/companies/${companyA}/documents/not-a-uuid`)
      .expect(400);
    expect(res.body).toEqual({ error: "Invalid document id format" });

    // Other :documentId routes are covered by the same param guard.
    await request(app)
      .get(`/api/companies/${companyA}/documents/not-a-uuid/backlinks`)
      .expect(400);
    await request(app)
      .patch(`/api/companies/${companyA}/documents/not-a-uuid`)
      .send({ status: "archived" })
      .expect(400);

    // A well-formed but non-existent id still resolves to a 404, not a 400.
    await request(app)
      .get(`/api/companies/${companyA}/documents/${randomUUID()}`)
      .expect(404);
  });
});
