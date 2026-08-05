import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  issueRouteApp,
  resetIssueRouteData,
  seedIssueRouteCompany,
} from "./helpers/issue-route-app.js";

/**
 * Regression coverage for https://github.com/paperclipai/paperclip/issues/4628.
 * Express's `qs` parser hands the list route either a string or an array for
 * `?status=`, and the route normalizes both shapes.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue list status query parsing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-query-parsing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await resetIssueRouteData(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function listStatuses(query: string) {
    const company = await seedIssueRouteCompany(db, "Status parsing");
    const companyId = company.companyId;
    await db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Todo", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, title: "In progress", status: "in_progress", priority: "medium" },
      { id: randomUUID(), companyId, title: "Done", status: "done", priority: "medium" },
    ]);
    const res = await request(issueRouteApp(db, company))
      .get(`/api/companies/${companyId}/issues${query}`)
      .expect(200);
    return (res.body as { status: string }[]).map((issue) => issue.status).sort();
  }

  it("accepts a single ?status=todo", async () => {
    expect(await listStatuses("?status=todo")).toEqual(["todo"]);
  });

  it("accepts comma-separated ?status=todo,in_progress", async () => {
    expect(await listStatuses("?status=todo,in_progress")).toEqual(["in_progress", "todo"]);
  });

  it("accepts repeated ?status=todo&status=in_progress", async () => {
    expect(await listStatuses("?status=todo&status=in_progress")).toEqual(["in_progress", "todo"]);
  });

  it("accepts mixed array and CSV ?status=todo,in_progress&status=done", async () => {
    expect(await listStatuses("?status=todo,in_progress&status=done"))
      .toEqual(["done", "in_progress", "todo"]);
  });

  it("returns every status when ?status is absent", async () => {
    expect(await listStatuses("")).toEqual(["done", "in_progress", "todo"]);
  });
});
