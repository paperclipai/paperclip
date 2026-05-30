import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-context starter tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue heartbeat-context onboarding starter context", () => {
  let db!: ReturnType<typeof createDb>;
  let docs!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-context-starter-");
    db = createDb(tempDb.connectionString);
    docs = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      title: "Draft and review an HLT article",
      description: "Create a useful student-facing article for MasteryPublishing.",
      status: "todo",
      priority: "medium",
    });

    return { companyId, issueId };
  }

  it("includes the hidden onboarding starter context in heartbeat-context without exposing it as a normal document", async () => {
    const { companyId, issueId } = await seedIssue();
    const app = createApp(companyId);

    await docs.upsertIssueDocument({
      issueId,
      key: ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY,
      title: "Starter context",
      format: "markdown",
      body: [
        "# Starter context",
        "",
        "```json",
        JSON.stringify({
          useCaseId: "draft-review-hlt-article",
          label: "Draft and review an HLT article",
          teamRoles: ["Researcher", "Writer", "Media planner", "Editor"],
          optionalRefs: ["playbook:make-article", "schema:article_v2"],
          approvalBoundary: "Stops before publishing to MasteryPublishing until a human approves.",
          fallbackBehavior: "Keep drafting locally if extra context is unavailable.",
        }),
        "```",
      ].join("\n"),
    });

    const defaultDocuments = await request(app).get(`/api/issues/${issueId}/documents`);
    expect(defaultDocuments.status, JSON.stringify(defaultDocuments.body)).toBe(200);
    expect(defaultDocuments.body.map((doc: { key: string }) => doc.key)).not.toContain(
      ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY,
    );

    const context = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);

    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.onboardingStarterContext).toMatchObject({
      key: ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY,
      title: "Starter context",
      latestRevisionNumber: 1,
    });
    expect(context.body.onboardingStarterContext.body).toContain("draft-review-hlt-article");
    expect(context.body.onboardingStarterContext).not.toHaveProperty("id");
    expect(context.body.onboardingStarterContext).not.toHaveProperty("companyId");
    expect(context.body.onboardingStarterContext).not.toHaveProperty("issueId");
    expect(context.body.onboardingStarterContext).not.toHaveProperty("createdByUserId");
  });
});
