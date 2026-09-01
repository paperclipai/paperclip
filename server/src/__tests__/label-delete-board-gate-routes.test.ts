import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, issueLabels, issues, labels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// `DELETE /labels/:labelId` deleted a company label with no Board-only
// gate, and the deletion cascades (`issue_labels.labelId` is
// `ON DELETE CASCADE`) — stripping the label from every issue that carries
// it, company-wide, in one ordinarily-privileged call, with the single
// `label.deleted` activity row naming the label but not which issues lost
// it. This is the same class of "erase corroborating history" action
// `DELETE /agents/:id` already gates behind `assertBoard`. Regression
// coverage for both halves of the fix: the gate, and the now-enumerated
// blast radius.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres label-delete board-gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("label delete board gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-label-delete-board-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createAppAsAgent(companyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        companyId,
        runId: "run-1",
        agentApiKeyId: null,
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function createAppAsBoard(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyLabelAndIssues(companyId: string) {
    await db.insert(companies).values({ id: companyId, name: "Acme" });

    const [label] = await db
      .insert(labels)
      .values({ companyId, name: "independent-check", color: "#123456" })
      .returning();

    const issueOneId = randomUUID();
    const issueTwoId = randomUUID();
    const issueUnrelatedId = randomUUID();
    await db.insert(issues).values([
      { id: issueOneId, companyId, title: "Check A", status: "todo", priority: "medium" },
      { id: issueTwoId, companyId, title: "Check B", status: "todo", priority: "medium" },
      { id: issueUnrelatedId, companyId, title: "Unrelated", status: "todo", priority: "medium" },
    ]);
    await db.insert(issueLabels).values([
      { issueId: issueOneId, labelId: label!.id, companyId },
      { issueId: issueTwoId, labelId: label!.id, companyId },
    ]);

    return { label: label!, issueOneId, issueTwoId, issueUnrelatedId };
  }

  it("refuses an agent seat with ordinary company access, leaving the label and its cascade untouched", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const { label, issueOneId, issueTwoId } = await seedCompanyLabelAndIssues(companyId);

    const app = createAppAsAgent(companyId, agentId);
    const res = await request(app).delete(`/api/labels/${label.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Board access required");

    const stillThere = await db.select().from(labels).where(eq(labels.id, label.id));
    expect(stillThere).toHaveLength(1);

    const stillLinked = await db.select().from(issueLabels).where(eq(issueLabels.labelId, label.id));
    expect(stillLinked.map((row) => row.issueId).sort()).toEqual([issueOneId, issueTwoId].sort());

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, label.id));
    expect(activity).toHaveLength(0);
  });

  it("allows a board actor to delete the label and enumerates the issues the cascade stripped it from", async () => {
    const companyId = randomUUID();
    const { label, issueOneId, issueTwoId, issueUnrelatedId } = await seedCompanyLabelAndIssues(companyId);

    const app = createAppAsBoard(companyId);
    const res = await request(app).delete(`/api/labels/${label.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(label.id);
    expect(res.body.affectedIssueIds?.sort()).toEqual([issueOneId, issueTwoId].sort());

    // The cascade actually ran: no issue_labels rows survive for this label.
    const remainingLinks = await db.select().from(issueLabels).where(eq(issueLabels.labelId, label.id));
    expect(remainingLinks).toHaveLength(0);

    // The unrelated issue was never linked and is unaffected either way.
    expect(issueUnrelatedId).toBeTruthy();

    // The activity row now enumerates the blast radius instead of just
    // naming the label — this is the half of the gap that made the loss
    // unreconstructible from the log before this fix.
    const [activityRow] = await db.select().from(activityLog).where(eq(activityLog.entityId, label.id));
    expect(activityRow).toBeTruthy();
    expect(activityRow!.action).toBe("label.deleted");
    const details = activityRow!.details as { name: string; color: string; issueIds: string[] };
    expect(details.name).toBe("independent-check");
    expect(details.issueIds.sort()).toEqual([issueOneId, issueTwoId].sort());
  });

  it("404s for a board actor when the label does not exist, without touching activity", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });

    const app = createAppAsBoard(companyId);
    const res = await request(app).delete(`/api/labels/${randomUUID()}`);

    expect(res.status).toBe(404);
    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(0);
  });
});
