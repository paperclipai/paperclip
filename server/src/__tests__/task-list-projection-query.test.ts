import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureTaskListQuery, seedTaskListProjectionFixture, type ListFilters } from "./helpers/task-list-projection-fixture.js";

describe("main task-list canonical activity index", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("task-projection-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  it("stops each latest-activity probe for full and index projections at one qualifying row", async () => {
    const f = await seedTaskListProjectionFixture(db, { count: 1200, chatCount: 6, history: 0, payloadBytes: 3072, descriptionBytes: 4096, activityPerIssue: 8, activityDecoys: 1000 });
    const cases: ListFilters[] = [{ limit: 100, sortField: "updated", sortDir: "desc" }, { limit: 100, listProjection: "index" }];
    for (const filters of cases) {
      const query = await captureTaskListQuery(db, issueService, f.companyId, filters);
      const [explain] = await db.$client.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params as never[]);
      const inspected: { rows: number; loops: number }[] = [];
      const visit = (node: Record<string, unknown>) => {
        if (node["Relation Name"] === "activity_log") inspected.push({ rows: Number(node["Actual Rows"]), loops: Number(node["Actual Loops"]) });
        for (const child of node.Plans as Record<string, unknown>[] ?? []) visit(child);
      };
      visit(explain["QUERY PLAN"][0].Plan);
      expect(inspected.length).toBeGreaterThan(0);
      expect(Math.max(...inspected.map(row => row.rows))).toBeLessThanOrEqual(1);
      expect(Math.max(...inspected.map(row => row.loops))).toBeGreaterThanOrEqual(1000);
      expect(await issueService(db).list(f.companyId, filters)).toHaveLength(100);
    }
  });

  it("rejects incomplete hosted conversation controls before writing fixture rows", async () => {
    const [before] = await db.$client.unsafe("select count(*)::int as count from companies");
    await expect(seedTaskListProjectionFixture(db, { count: 1200, chatCount: 600, history: 0, payloadBytes: 0, hostedShape: true })).rejects.toThrow("Hosted shape needs chatCount + 695 tasks");
    const [after] = await db.$client.unsafe("select count(*)::int as count from companies");
    expect(after!.count).toBe(before!.count);
  });

  it("preserves canonical activity exclusions, text bindings, ties and all list order modes", async () => {
    const f = await seedTaskListProjectionFixture(db, { count: 8, chatCount: 0, history: 0, payloadBytes: 0 });
    const id = (n: number) => f.records[n]!.id;
    const log = (n: number, day: number, extra: Record<string, unknown> = {}) => ({ companyId: f.companyId, actorType: "user", actorId: "reader", entityType: "issue", entityId: id(n), action: "issue.updated", createdAt: new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`), ...extra });
    await db.insert(activityLog).values([
      log(0, 3),
      ...["issue.read_marked", "issue.read_unmarked", "issue.inbox_archived", "issue.inbox_unarchived"].map(action => log(0, 20, { action })),
      log(0, 21, { action: "issue.recovery_action_resolved", details: { source: "source_revalidation", trigger: "read_projection" } }),
      log(1, 22, { entityType: "heartbeat_run" }),
      log(2, 5), log(2, 6, { action: "issue.recovery_action_resolved", details: { source: "source_revalidation", trigger: "explicit_decision" } }),
      log(4, 23, { entityId: id(4).toUpperCase() }),
      log(4, 24, { entityId: `{${id(4)}}` }),
      log(4, 25, { entityId: "not-a-task" }),
      log(5, 26, { companyId: f.otherCompanyId }),
      log(6, 7, { action: "issue.recovery_action_resolved", details: null }), log(7, 7),
    ] as never);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: id(1), authorUserId: "reader", body: "Canonical comment", createdAt: new Date("2026-01-04") });
    const svc = issueService(db), descending = [7, 6, 2, 1, 0, 5, 4, 3].map(id);
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "desc" })).map(row => row.id)).toEqual(descending);
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "asc" })).map(row => row.id)).toEqual([...descending].reverse());
    expect((await svc.list(f.companyId)).map(row => row.id)).toEqual([6, 0, 3, 7, 2, 1, 5, 4].map(id));
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "desc", limit: 2, offset: 2 })).map(row => row.id)).toEqual(descending.slice(2, 4));
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "desc", limit: 2, readCondition: sql<boolean>`${issues.id} <> ${id(7)}` })).map(row => row.id)).toEqual([id(6), id(2)]);
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "desc", issueIds: [id(0), id(2)] })).map(row => row.id)).toEqual([id(2), id(0)]);
    expect(await svc.list(f.companyId, { readCondition: sql<boolean>`false`, limit: 2 })).toEqual([]);
    await db.update(issues).set({ parentId: id(0) }).where(sql`${issues.id} in (${id(6)},${id(7)})`);
    expect((await svc.list(f.companyId, { sortField: "updated", sortDir: "desc", oneChildPerParent: true })).map(row => row.id)).toEqual([id(7), id(2)]);
  });

});
