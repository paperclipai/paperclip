import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueContinuationLinks,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embedded.supported ? describe : describe.skip;

describeEmbedded("issue continuations", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-continuations-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterEach(async () => {
    await db.delete(issueContinuationLinks);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => tempDb.cleanup());

  it("creates and idempotently coalesces explicit residual successors", async () => {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db.insert(companies).values({ name: "Continuation Co", issuePrefix: `CN${suffix}` }).returning();
    const [owner, successorOwner] = await db.insert(agents).values([
      { companyId: company!.id, name: "Owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId: company!.id, name: "Successor", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    const [predecessor] = await db.insert(issues).values({
      companyId: company!.id, title: "Audit accessibility", status: "in_progress", priority: "medium",
      assigneeAgentId: owner!.id, issueNumber: 1, identifier: `${company!.issuePrefix}-1`,
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board", companyIds: [company!.id], memberships: [], isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const body = {
      kind: "residual", deliverableKey: "ui.audit.accessibility", residualScope: "Keyboard defects remain.",
      successor: { title: "Fix keyboard navigation", assigneeAgentId: successorOwner!.id },
    };
    const created = await request(app).post(`/api/issues/${predecessor!.id}/continuations`).send(body).expect(201);
    expect(created.body).toMatchObject({ deduplicated: false, link: { predecessorIssueId: predecessor!.id, residualScope: body.residualScope } });
    const replay = await request(app).post(`/api/issues/${predecessor!.id}/continuations`).send(body).expect(200);
    expect(replay.body).toMatchObject({ deduplicated: true, successor: { id: created.body.successor.id } });
    const links = await db.select().from(issueContinuationLinks).where(and(
      eq(issueContinuationLinks.companyId, company!.id), eq(issueContinuationLinks.predecessorIssueId, predecessor!.id),
    ));
    expect(links).toHaveLength(1);
  });
});
