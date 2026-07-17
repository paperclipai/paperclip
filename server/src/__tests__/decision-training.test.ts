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
  decisionTrainingExamples,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  issueThreadInteractions,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { decisionTrainingRoutes } from "../routes/decision-training.js";
import { attentionService } from "../services/attention.js";
import { captureDecisionSnapshot, decisionTrainingService } from "../services/decision-training.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision training tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decision training", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-training-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(decisionTrainingExamples);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedResolvedInteraction() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const cutoffAt = new Date("2026-07-16T12:00:00.000Z");
    const beforeId = randomUUID();
    const atCutoffId = randomUUID();
    const afterId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Decision Co", issuePrefix: `D${companyId.slice(0, 4)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Decisions" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier: "DEC-1",
      title: "Choose a rollout strategy",
      status: "in_review",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      payload: { question: "Ship it?" } as never,
      result: { accepted: true } as never,
      resolvedByUserId: "board-user",
      resolvedAt: cutoffAt,
    });
    await db.insert(issueComments).values([
      { id: beforeId, companyId, issueId, body: "Before", createdAt: new Date("2026-07-16T11:59:59.000Z") },
      { id: atCutoffId, companyId, issueId, body: "At cutoff", createdAt: cutoffAt },
      { id: afterId, companyId, issueId, body: "Leaked later context", createdAt: new Date("2026-07-16T12:00:01.000Z") },
    ]);
    return { companyId, projectId, issueId, interactionId, cutoffAt, beforeId, atCutoffId, afterId };
  }

  it("includes the cutoff boundary and excludes later comments", async () => {
    const seeded = await seedResolvedInteraction();
    const captured = await captureDecisionSnapshot(db, {
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
    }, new Date("2026-07-16T13:00:00.000Z"));

    expect(captured.cutoffAt).toEqual(seeded.cutoffAt);
    expect(captured.snapshot.cutoff).toEqual({
      at: seeded.cutoffAt.toISOString(),
      lastCommentId: seeded.atCutoffId,
      commentCount: 2,
    });
    expect(captured.snapshot.comments.map((comment) => comment.id)).toEqual([seeded.beforeId, seeded.atCutoffId]);
    expect(JSON.stringify(captured.snapshot)).not.toContain("Leaked later context");
    expect(captured.snapshot.retention).toEqual({
      policy: "scrub_deleted_comments_v1",
      commentDeletion: "redact",
      issueDeletion: "cascade",
    });
  });

  it("scrubs captured comment content after source deletion", async () => {
    const seeded = await seedResolvedInteraction();
    const svc = decisionTrainingService(db);
    const example = await svc.create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Keep the decision, not deleted comment content.",
      createdByUserId: "board-user",
    });

    await svc.scrubDeletedComments({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      commentIds: [seeded.beforeId],
      deletedAt: new Date("2026-07-16T14:00:00.000Z"),
    });

    const updated = await svc.getById(example.id);
    expect(updated?.retentionPolicy).toBe("scrub_deleted_comments_v1");
    expect(updated?.snapshot.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: seeded.beforeId,
        body: "",
        presentation: null,
        metadata: null,
        retentionRedaction: {
          reason: "source_comment_deleted",
          policy: "scrub_deleted_comments_v1",
        },
      }),
    ]));
    expect(JSON.stringify(updated?.snapshot)).not.toContain("Before");
    expect(updated?.snapshot.comments.find((comment) => comment.id === seeded.atCutoffId)?.body).toBe("At cutoff");
  });

  it("deletes training examples when their issue is deleted", async () => {
    const seeded = await seedResolvedInteraction();
    const svc = decisionTrainingService(db);
    const example = await svc.create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Cascade with the issue.",
      createdByUserId: "board-user",
    });

    await db.delete(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, seeded.issueId));
    await db.delete(issues).where(eq(issues.id, seeded.issueId));

    expect(await svc.getById(example.id)).toBeUndefined();
  });

  it("excludes runs updated after the decision cutoff", async () => {
    const seeded = await seedResolvedInteraction();
    const agentId = randomUUID();
    const includedRunId = randomUUID();
    const excludedRunId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "Decision agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: includedRunId,
        companyId: seeded.companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date("2026-07-16T11:00:00.000Z"),
        finishedAt: new Date("2026-07-16T11:30:00.000Z"),
        contextSnapshot: { issueId: seeded.issueId, evidence: "known before cutoff" },
        createdAt: new Date("2026-07-16T11:00:00.000Z"),
        updatedAt: new Date("2026-07-16T11:30:00.000Z"),
      },
      {
        id: excludedRunId,
        companyId: seeded.companyId,
        agentId,
        status: "running",
        startedAt: new Date("2026-07-16T11:45:00.000Z"),
        contextSnapshot: { issueId: seeded.issueId, evidence: "written after cutoff" },
        createdAt: new Date("2026-07-16T11:45:00.000Z"),
        updatedAt: new Date("2026-07-16T12:30:00.000Z"),
      },
    ]);

    const captured = await captureDecisionSnapshot(db, {
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
    }, new Date("2026-07-16T13:00:00.000Z"));

    expect(captured.snapshot.runs.map((run) => run.id)).toEqual([includedRunId]);
    expect(JSON.stringify(captured.snapshot)).not.toContain("written after cutoff");
  });

  it("labels workspace-only commit evidence accurately", async () => {
    const seeded = await seedResolvedInteraction();
    await db.insert(projectWorkspaces).values({
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      name: "Primary workspace",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      metadata: { commitSha: "abcdef1234567890" },
      isPrimary: false,
      createdAt: new Date("2026-07-16T11:00:00.000Z"),
      updatedAt: new Date("2026-07-16T11:30:00.000Z"),
    });
    await db.insert(projectWorkspaces).values({
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      name: "Post-cutoff workspace",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      metadata: { commitSha: "ffffffffffffffff" },
      isPrimary: true,
      createdAt: new Date("2026-07-16T11:00:00.000Z"),
      updatedAt: new Date("2026-07-16T12:30:00.000Z"),
    });
    await db.insert(executionWorkspaces).values({
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      sourceIssueId: seeded.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Post-cutoff execution workspace",
      providerType: "git_worktree",
      metadata: { commitSha: "eeeeeeeeeeeeeeee" },
      openedAt: new Date("2026-07-16T11:00:00.000Z"),
      lastUsedAt: new Date("2026-07-16T12:30:00.000Z"),
      updatedAt: new Date("2026-07-16T12:30:00.000Z"),
    });

    const captured = await captureDecisionSnapshot(db, {
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
    }, new Date("2026-07-16T13:00:00.000Z"));

    expect(captured.snapshot.code).toMatchObject({
      commitSha: "abcdef1234567890",
      resolution: "workspace",
    });
  });

  it("enforces one example per decision and author", async () => {
    const seeded = await seedResolvedInteraction();
    const svc = decisionTrainingService(db);
    const input = {
      companyId: seeded.companyId,
      sourceKind: "interaction" as const,
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Ship behind a flag.",
      createdByUserId: "board-user",
    };

    const created = await svc.create(input);
    await expect(svc.create(input)).rejects.toMatchObject({ status: 409 });
    const updated = await svc.updateNotes(created.id, "board-user", "Use a 10% canary first.");
    expect(updated?.notesHistory).toEqual([
      expect.objectContaining({ author: "board-user", body: "Ship behind a flag." }),
    ]);
    const unchanged = await svc.updateNotes(created.id, "board-user", "Use a 10% canary first.");
    expect(unchanged?.notesHistory).toEqual(updated?.notesHistory);
    expect(updated?.snapshot).toEqual(created.snapshot);
  });

  it("enriches attention items with the current user's training example", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Captured guidance.",
      createdByUserId: "board-user",
    });
    await db
      .update(issueThreadInteractions)
      .set({ status: "pending", resolvedAt: null, updatedAt: new Date() })
      .where(eq(issueThreadInteractions.id, seeded.interactionId));

    const feed = await attentionService(db).list(seeded.companyId, { userId: "board-user" });
    const item = feed.items.find((candidate) => candidate.subject.id === seeded.interactionId);
    expect(item?.trainingExampleId).toBe(example.id);
  });

  it("does not log a notes update when the submitted notes are unchanged", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Keep the current notes.",
      createdByUserId: "board-user",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app)
      .patch(`/api/decision-training/${example.id}`)
      .send({ notes: "Keep the current notes." })
      .expect(200);

    const noOpLogs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "decision_training.notes_updated"));
    expect(noOpLogs).toHaveLength(0);

    await request(app)
      .patch(`/api/decision-training/${example.id}`)
      .send({ notes: "Record the real change." })
      .expect(200);

    const changedLogs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "decision_training.notes_updated"));
    expect(changedLogs).toHaveLength(1);
  });

  it("returns not found for malformed example ids", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app).get("/api/decision-training/not-a-uuid").expect(404);
    await request(app)
      .patch("/api/decision-training/not-a-uuid")
      .send({ notes: "Changed" })
      .expect(404);
    await request(app).delete("/api/decision-training/not-a-uuid").expect(404);
  });

  it("rejects updates and deletes from a different board user", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Owner notes",
      createdByUserId: "board-user",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "other-board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app)
      .patch(`/api/decision-training/${example.id}`)
      .send({ notes: "Changed by someone else" })
      .expect(403);
    await request(app).delete(`/api/decision-training/${example.id}`).expect(403);

    const unchanged = await decisionTrainingService(db).getById(example.id);
    expect(unchanged?.notes).toBe("Owner notes");
  });

  it("rejects agent writes and snapshot mutation", async () => {
    const seeded = await seedResolvedInteraction();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: randomUUID(),
        companyId: seeded.companyId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app)
      .post(`/api/companies/${seeded.companyId}/decision-training`)
      .send({ sourceKind: "interaction", sourceId: seeded.interactionId, issueId: seeded.issueId, notes: "No" })
      .expect(403);

    await request(app)
      .patch(`/api/decision-training/${randomUUID()}`)
      .send({ notes: "Changed", snapshot: { version: 2 } })
      .expect(400);
  });

  it("rejects agent reads and exports", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Sensitive guidance",
      createdByUserId: "board-user",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: randomUUID(),
        companyId: seeded.companyId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app).get(`/api/companies/${seeded.companyId}/decision-training`).expect(403);
    await request(app).get(`/api/decision-training/${example.id}`).expect(403);
    await request(app).get(`/api/companies/${seeded.companyId}/decision-training/export.jsonl`).expect(403);
  });

  it("exports immutable state and labels as JSONL", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Use a feature flag.",
      createdByUserId: "board-user",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    const response = await request(app)
      .get(`/api/companies/${seeded.companyId}/decision-training/export.jsonl`)
      .expect(200);
    const line = JSON.parse(response.text.trim());
    expect(line).toEqual({
      retentionPolicy: "scrub_deleted_comments_v1",
      state: example.snapshot,
      label: { outcome: "accepted", notes: "Use a feature flag." },
    });
    expect(response.text).not.toContain("Leaked later context");

    const exportLogs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "decision_training.exported"));
    expect(exportLogs).toHaveLength(1);
    expect(exportLogs[0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      entityType: "decision_training_export",
      entityId: seeded.companyId,
      details: { exampleCount: 1, exampleIds: [example.id] },
    });
  });

  it("logs individual example reads", async () => {
    const seeded = await seedResolvedInteraction();
    const example = await decisionTrainingService(db).create({
      companyId: seeded.companyId,
      sourceKind: "interaction",
      sourceId: seeded.interactionId,
      issueId: seeded.issueId,
      notes: "Read audit",
      createdByUserId: "board-user",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", decisionTrainingRoutes(db));
    app.use(errorHandler);

    await request(app).get(`/api/decision-training/${example.id}`).expect(200);

    const readLogs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "decision_training.read"));
    expect(readLogs).toHaveLength(1);
    expect(readLogs[0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      entityType: "decision_training_example",
      entityId: example.id,
      details: {
        sourceKind: "interaction",
        sourceId: seeded.interactionId,
        issueId: seeded.issueId,
      },
    });
  });
});
