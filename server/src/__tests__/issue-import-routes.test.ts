import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueComments,
  issueImportItems,
  issueImportRuns,
  issueOriginStates,
  issueRelations,
  issues,
  projects,
  providerEventReceipts,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueImportRoutes } from "../routes/issue-imports.js";
import { issueRoutes } from "../routes/issues.js";
import { computeLinearIssueFingerprint } from "../services/issue-imports.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("provider-aware staged issue imports", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-import-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(providerEventReceipts);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueOriginStates);
    await db.delete(issueImportItems);
    await db.delete(issueImportRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  function app(deploymentMode: "local_trusted" | "authenticated" = "local_trusted", includeGenericIssues = false) {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode }));
    instance.use("/api", issueImportRoutes(db));
    if (includeGenericIssues) instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Example Co",
      issuePrefix: `I${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Pilot" });
    return { companyId, projectId };
  }

  function item(overrides: Record<string, unknown> = {}) {
    const sourceId = randomUUID();
    return {
      sourceId,
      sourceIdentifier: "EXT-900",
      sourceVersion: "v1",
      sourceUpdatedAt: "2026-07-31T18:00:00.000Z",
      sourceUrl: "https://linear.app/example/issue/EXT-900/test",
      title: "Synthetic staged issue",
      description: "Untrusted provider text is stored, not executed.",
      sourceStatus: "Backlog",
      priority: "high",
      projectSourceId: "linear-project",
      parentSourceId: null,
      blockedBySourceIds: [],
      comments: [],
      ...overrides,
    };
  }

  function manifest(projectId: string, items: ReturnType<typeof item>[]) {
    return {
      provider: "linear",
      manifestVersion: 1,
      sourceSnapshot: { retrievedAt: "2026-07-31T19:00:00.000Z", version: "snapshot-v1" },
      options: { stageUnassigned: true, suppressWakes: true, conflictPolicy: "record" },
      projectMappings: { "linear-project": projectId },
      items,
    };
  }

  function representativeTenItemPilot(projectId: string) {
    const specs = [
      ["EXT-101", "Representative critical backlog item", "Backlog", "critical"],
      ["EXT-102", "Representative critical child item", "Backlog", "critical"],
      ["EXT-103", "Representative active source item", "In Progress", "critical"],
      ["EXT-104", "Representative active-source child", "Backlog", "critical"],
      ["EXT-105", "Representative review source item", "In Review", "critical"],
      ["EXT-106", "Representative ready item", "Todo", "high"],
      ["EXT-107", "Representative high backlog item", "Backlog", "high"],
      ["EXT-108", "Representative unmapped project item", "Backlog", "high"],
      ["EXT-109", "Representative medium backlog item", "Backlog", "medium"],
      ["EXT-110", "Representative low backlog item", "Backlog", "low"],
    ] as const;
    const sourceIds = specs.map(() => randomUUID());
    const items = specs.map(([identifier, title, sourceStatus, priority], index) => item({
      sourceId: sourceIds[index],
      sourceIdentifier: identifier,
      sourceUrl: `https://linear.app/example/issue/${identifier}/pilot`,
      title,
      sourceStatus,
      priority,
      projectSourceId: index === 7 ? "unmapped-project" : "linear-project",
      parentSourceId: index === 1 ? sourceIds[0] : index === 3 ? sourceIds[2] : null,
    }));
    return manifest(projectId, items);
  }

  async function tableCount(table: Parameters<typeof db.select>[0] extends never ? never : any) {
    return db.select({ count: sql<number>`count(*)::int` }).from(table).then((rows) => rows[0].count);
  }

  it("requires board authorization and rejects activation", async () => {
    const { companyId, projectId } = await seed();
    await request(app("authenticated"))
      .post(`/api/companies/${companyId}/issue-imports/preview`)
      .send(manifest(projectId, [item()]))
      .expect(403);

    await request(app())
      .post(`/api/companies/${companyId}/issue-imports/apply`)
      .send({ previewRunId: randomUUID(), previewDigest: "a".repeat(64), activate: true })
      .expect(400);
  });

  it("previews a representative ten-item selection without issue or wake mutation", async () => {
    const { companyId, projectId } = await seed();
    const beforeIssues = await tableCount(issues);
    const beforeWakes = await tableCount(agentWakeupRequests);

    const response = await request(app())
      .post(`/api/companies/${companyId}/issue-imports/preview`)
      .send(representativeTenItemPilot(projectId))
      .expect(201);

    expect(response.body.counts).toMatchObject({ received: 10, assignments: 0, wakes: 0, failures: 0 });
    expect(response.body.items.filter((entry: { proposed: { parentSourceId: string | null } }) => entry.proposed.parentSourceId))
      .toHaveLength(2);
    expect(response.body.items.flatMap((entry: { conflicts: string[] }) => entry.conflicts))
      .toEqual(expect.arrayContaining(["source_status_requires_accountable_execution_path", "project_mapping_missing"]));
    expect(await tableCount(issues)).toBe(beforeIssues);
    expect(await tableCount(agentWakeupRequests)).toBe(beforeWakes);
  });

  it("reports relation cycles as fatal preview failures", async () => {
    const { companyId, projectId } = await seed();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const payload = manifest(projectId, [
      item({ sourceId: firstId, sourceIdentifier: "EXT-906", parentSourceId: secondId }),
      item({ sourceId: secondId, sourceIdentifier: "EXT-907", parentSourceId: firstId }),
    ]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    expect(preview.body.counts.failures).toBe(2);
    expect(preview.body.items.every((entry: { failures: string[] }) => entry.failures.includes("parent_cycle_detected"))).toBe(true);
    expect(await tableCount(issues)).toBe(0);
  });

  it("applies a synthetic fixture transactionally, staged and unwoken, then replays without duplicates", async () => {
    const { companyId, projectId } = await seed();
    const parent = item({ sourceIdentifier: "EXT-901", title: "Parent" });
    const child = item({
      sourceIdentifier: "EXT-902",
      title: "Child",
      parentSourceId: parent.sourceId,
      blockedBySourceIds: [parent.sourceId],
      comments: [{
        sourceCommentId: "comment-1",
        sourceEventId: "event-1",
        body: "Imported once",
        sourceUpdatedAt: "2026-07-31T18:30:00.000Z",
      }],
    });
    const payload = manifest(projectId, [parent, child]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    const applied = await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: preview.body.previewRunId,
      previewDigest: preview.body.previewDigest,
      activate: false,
    }).expect(200);

    expect(applied.body.status).toBe("applied");
    expect(applied.body.counts).toMatchObject({ created: 2, assignments: 0, wakes: 0, commentsCreated: 1 });
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.originKind === "linear_issue" && !row.assigneeAgentId && !row.assigneeUserId)).toBe(true);
    expect(rows.every((row) => row.projectId === projectId && row.status === "backlog" && row.priority === "high")).toBe(true);
    const parentRow = rows.find((row) => row.originId === parent.sourceId)!;
    const childRow = rows.find((row) => row.originId === child.sourceId)!;
    expect(childRow.parentId).toBe(parentRow.id);
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, parentRow.id),
      eq(issueRelations.relatedIssueId, childRow.id),
    ))).toHaveLength(1);
    expect(await tableCount(agentWakeupRequests)).toBe(0);

    const replayPreview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    expect(replayPreview.body.counts).toMatchObject({ wouldCreate: 0, unchanged: 2 });
    const replayChild = replayPreview.body.items.find((entry: { sourceId: string }) => entry.sourceId === child.sourceId);
    expect(replayChild.current).toMatchObject({
      blockedByIssueIds: [parentRow.id],
      blockedBySourceIds: [parent.sourceId],
    });
    expect(replayChild.conflicts).not.toContain("blocker_relations_drift");
    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: replayPreview.body.previewRunId,
      previewDigest: replayPreview.body.previewDigest,
      activate: false,
    }).expect(200);
    expect(await tableCount(issues)).toBe(2);
    expect(await tableCount(issueComments)).toBe(1);
    expect(await tableCount(providerEventReceipts)).toBe(1);
    await expect(db.update(issues).set({ originId: randomUUID() }).where(eq(issues.id, parentRow.id)))
      .rejects.toThrow();
  });

  it("preserves a Paperclip-side blocker deletion on same-version replay", async () => {
    const { companyId, projectId } = await seed();
    const parent = item({ sourceIdentifier: "EXT-911", title: "Parent" });
    const child = item({
      sourceIdentifier: "EXT-912",
      title: "Child",
      blockedBySourceIds: [parent.sourceId],
    });
    const payload = manifest(projectId, [parent, child]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: preview.body.previewRunId,
      previewDigest: preview.body.previewDigest,
      activate: false,
    }).expect(200);

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const parentRow = rows.find((row) => row.originId === parent.sourceId)!;
    const childRow = rows.find((row) => row.originId === child.sourceId)!;
    await db.delete(issueRelations).where(and(
      eq(issueRelations.issueId, parentRow.id),
      eq(issueRelations.relatedIssueId, childRow.id),
    ));

    const replayPreview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    const childPreview = replayPreview.body.items.find((entry: { sourceId: string }) => entry.sourceId === child.sourceId);
    expect(childPreview).toMatchObject({
      action: "unchanged",
      current: { blockedByIssueIds: [], blockedBySourceIds: [] },
    });
    expect(childPreview.conflicts).toContain("blocker_relations_drift");

    const replayApplied = await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: replayPreview.body.previewRunId,
      previewDigest: replayPreview.body.previewDigest,
      activate: false,
    }).expect(200);
    expect(replayApplied.body.items.find((entry: { sourceId: string }) => entry.sourceId === child.sourceId))
      .toMatchObject({
        relationResults: {
          blockersApplied: 0,
          blockerReconciliation: {
            authority: "paperclip",
            proposedSourceIds: [parent.sourceId],
            currentIssueIds: [],
            currentSourceIds: [],
            conflict: true,
          },
        },
      });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, parentRow.id),
      eq(issueRelations.relatedIssueId, childRow.id),
    ))).toHaveLength(0);
  });

  it("reports newer-source blocker drift without overwriting Paperclip relations", async () => {
    const { companyId, projectId } = await seed();
    const parent = item({ sourceIdentifier: "EXT-913", title: "Parent" });
    const child = item({ sourceIdentifier: "EXT-914", title: "Child" });
    const initialPayload = manifest(projectId, [parent, child]);
    const initialPreview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(initialPayload).expect(201);
    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: initialPreview.body.previewRunId,
      previewDigest: initialPreview.body.previewDigest,
      activate: false,
    }).expect(200);

    const updatedChild = {
      ...child,
      sourceVersion: "v2",
      sourceUpdatedAt: "2026-07-31T20:00:00.000Z",
      blockedBySourceIds: [parent.sourceId],
    };
    const driftPreview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`)
      .send(manifest(projectId, [parent, updatedChild]))
      .expect(201);
    const childPreview = driftPreview.body.items.find((entry: { sourceId: string }) => entry.sourceId === child.sourceId);
    expect(childPreview).toMatchObject({
      action: "update",
      proposed: { blockedBySourceIds: [parent.sourceId] },
      current: { blockedByIssueIds: [], blockedBySourceIds: [] },
    });
    expect(childPreview.conflicts).toEqual(expect.arrayContaining([
      "source_version_drift",
      "blocker_relations_drift",
    ]));

    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: driftPreview.body.previewRunId,
      previewDigest: driftPreview.body.previewDigest,
      activate: false,
    }).expect(200);
    expect(await tableCount(issueRelations)).toBe(0);
  });

  it("does not attribute an unrelated concurrent company wake to the import", async () => {
    const { companyId, projectId } = await seed();
    const [agent] = await db.insert(agents).values({ companyId, name: "Unrelated agent" }).returning();
    const [unrelatedWake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agent.id,
      source: "manual",
      reason: "Unrelated concurrent wake",
    }).returning();
    const payload = manifest(projectId, [item({ sourceIdentifier: "EXT-915" })]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);

    await db.execute(sql.raw(`
      create function issue_import_test_delay() returns trigger as $$
      begin
        perform pg_advisory_xact_lock(580058);
        perform pg_sleep(0.5);
        return new;
      end;
      $$ language plpgsql;
      create trigger issue_import_test_delay_trigger
      after insert on issues
      for each row when (new.origin_kind = 'linear_issue')
      execute function issue_import_test_delay();
    `));

    let applied: request.Response | null = null;
    try {
      const concurrentDb = createDb(tempDb!.connectionString);
      const applyPromise = request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
        previewRunId: preview.body.previewRunId,
        previewDigest: preview.body.previewDigest,
        activate: false,
      }).then((response) => response);
      let triggerActive = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [probe] = await concurrentDb.select({
          acquired: sql<boolean>`pg_try_advisory_xact_lock(580058)`,
        }).from(companies).limit(1);
        if (!probe.acquired) {
          triggerActive = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(triggerActive).toBe(true);
      await concurrentDb.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, unrelatedWake.id));
      applied = await applyPromise;
    } finally {
      await db.execute(sql.raw("drop trigger if exists issue_import_test_delay_trigger on issues"));
      await db.execute(sql.raw("drop function if exists issue_import_test_delay()"));
    }

    expect(applied?.status).toBe(200);
    expect(applied?.body.counts).toMatchObject({ assignments: 0, wakes: 0 });
    expect(await tableCount(agentWakeupRequests)).toBe(0);
  });

  it("rejects digest drift without consuming the valid preview", async () => {
    const { companyId, projectId } = await seed();
    const payload = manifest(projectId, [item({ sourceIdentifier: "EXT-904" })]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: preview.body.previewRunId,
      previewDigest: "f".repeat(64),
      activate: false,
    }).expect(409);
    const [run] = await db.select().from(issueImportRuns).where(eq(issueImportRuns.id, preview.body.previewRunId));
    expect(run.status).toBe("preview_ready");
    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: preview.body.previewRunId,
      previewDigest: preview.body.previewDigest,
      activate: false,
    }).expect(200);
  });

  it("rolls back every issue mutation when a relation drifts after preview", async () => {
    const { companyId, projectId } = await seed();
    const externalSourceId = randomUUID();
    const [external] = await db.insert(issues).values({
      companyId,
      title: "External parent",
      originKind: "linear_issue",
      originId: externalSourceId,
      originFingerprint: computeLinearIssueFingerprint(externalSourceId),
    }).returning();
    const payload = manifest(projectId, [item({
      sourceIdentifier: "EXT-905",
      parentSourceId: externalSourceId,
    })]);
    const preview = await request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload).expect(201);
    expect(preview.body.counts.failures).toBe(0);
    await db.delete(issues).where(eq(issues.id, external.id));

    await request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
      previewRunId: preview.body.previewRunId,
      previewDigest: preview.body.previewDigest,
      activate: false,
    }).expect(422);

    expect(await tableCount(issues)).toBe(0);
    expect(await tableCount(issueOriginStates)).toBe(0);
    const [run] = await db.select().from(issueImportRuns).where(eq(issueImportRuns.id, preview.body.previewRunId));
    expect(run).toMatchObject({ status: "failed", errorSummary: "Issue import failed" });
  });

  it("serializes concurrent source applies to one immutable origin", async () => {
    const { companyId, projectId } = await seed();
    const payload = manifest(projectId, [item({ sourceIdentifier: "EXT-903" })]);
    const [one, two] = await Promise.all([
      request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload),
      request(app()).post(`/api/companies/${companyId}/issue-imports/preview`).send(payload),
    ]);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    const results = await Promise.all([
      request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
        previewRunId: one.body.previewRunId, previewDigest: one.body.previewDigest, activate: false,
      }),
      request(app()).post(`/api/companies/${companyId}/issue-imports/apply`).send({
        previewRunId: two.body.previewRunId, previewDigest: two.body.previewDigest, activate: false,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await tableCount(issues)).toBe(1);
    expect(await tableCount(issueOriginStates)).toBe(1);
  });

  it("rejects generic-create provenance fields", async () => {
    const { companyId } = await seed();
    await request(app("local_trusted", true))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Spoofed", originKind: "linear_issue", originId: randomUUID(), originFingerprint: "fake" })
      .expect(422);
    expect(await tableCount(issues)).toBe(0);
  });
});
