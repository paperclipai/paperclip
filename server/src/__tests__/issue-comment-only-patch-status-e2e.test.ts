// AGE-759 regression: a comment-only PATCH /api/issues/{id} must never
// silently change `status`. Reported as: PATCH { comment } on a `done`
// issue flipped its status to `todo` with no `status` field in the
// request body. Verified end-to-end here against a real Postgres-backed
// issue, with the assertion made against a *subsequent GET* (and a direct
// DB read), not just the PATCH response body.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment-only PATCH status tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("AGE-759: comment-only PATCH never mutates issue status", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-only-patch-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndMember() {
    const companyId = randomUUID();
    const issuePrefix = `PC${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "AGE-759 comment-only PATCH company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return { companyId, issuePrefix };
  }

  async function seedIssue(
    companyId: string,
    issuePrefix: string,
    status: "done" | "cancelled" | "in_review" | "todo",
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `${issuePrefix}-${issueId.slice(0, 8)}`,
      title: `Comment-only PATCH status regression (${status})`,
      status,
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    return issueId;
  }

  it.each(["done", "cancelled", "in_review", "todo"] as const)(
    "leaves a %s issue's status unchanged after a comment-only PATCH, verified by a subsequent GET and a direct DB read",
    async (status) => {
      const { companyId, issuePrefix } = await seedCompanyAndMember();
      const issueId = await seedIssue(companyId, issuePrefix, status);
      const app = createApp(companyId);

      const patchRes = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ comment: "operator note — no status field in this request" });

      expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
      expect(patchRes.body.status).toBe(status);

      const getRes = await request(app).get(`/api/issues/${issueId}`);
      expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
      expect(getRes.body.status).toBe(status);

      const stored = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(stored?.status).toBe(status);
    },
  );
});
