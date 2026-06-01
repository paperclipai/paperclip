import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
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
    `Skipping QBank item import route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("QBank item import routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qbank-item-import-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("imports a Partner API QBank item as a visible qbank-item issue document", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "HLT QBank Console",
      issuePrefix: "QBK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "QBK-1",
      title: "Review QBank item 50067",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });

    const app = createApp(companyId);
    const response = await request(app)
      .post(`/api/issues/${issueId}/qbank-item`)
      .send({
        appId: 3,
        item: {
          id: 50067,
          question_type: "Multiple Choice",
          question:
            "<p>A client diagnosed with ovarian cancer has been informed that the cancer has spread. The client has an elevated bilirubin and jaundice. Which organ likely has metastatic disease?</p>",
          rationale:
            '<p>The liver processes bilirubin.</p><p><img src="https://cdn-1.hltcorp.com/attachments/contents/000/026/921/large/Liver_and_Bile_Duct_Anatomy.jpg?1675957897" /></p>',
          key_takeaway: "<p>When you see jaundice, think liver or bile duct problems.</p>",
          draft_rationale: "<p><strong>Ovarian Cancer Metastasis</strong></p><p>Liver involvement can cause jaundice.</p>",
          difficulty: "Easy",
          state: "published",
          answers: [
            { text: "Bone", correct: false, rationale: "Less likely for ovarian cancer." },
            { text: "Liver&nbsp;", correct: true, rationale: "Liver disease can impair bilirubin clearance." },
          ],
          product_associations: [{ app_id: 3, category_id: 1068753933, visibility: true, deleted: false }],
          categories: [{ id: 1068753933, app_id: 3, name: "Anatomy and Physiology", published: true }],
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.created).toBe(true);
    expect(response.body.document).toMatchObject({
      issueId,
      key: "qbank-item",
      title: "QBank item 50067: ovarian cancer has spread",
      format: "markdown",
    });
    expect(response.body.document.body).toContain("Source ref: `qbank:app-3/question-50067`");
    expect(response.body.document.body).toContain("Correct answer: Liver");
    expect(response.body.document.body).toContain("Draft revision: present");
    expect(response.body.document.body).toContain("Create MMM2 visual rationale plan");
    expect(response.body.document.body).not.toContain("<p>");
    expect(response.body.document.body).not.toMatch(/x-mcp-token|PARTNER_API_KEY|cffefcae/i);

    const readBack = await request(app).get(`/api/issues/${issueId}/documents/qbank-item`);
    expect(readBack.status, JSON.stringify(readBack.body)).toBe(200);
    expect(readBack.body.body).toBe(response.body.document.body);
  });
});
