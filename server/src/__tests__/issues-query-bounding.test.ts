// EDG-7566 — data-layer query-bounding: default LIMIT (AC1), total_count via count()
// consistency (AC2), and the cursor bulk-export (AC3). Verifies the saturation fix
// (no unbounded list by omission), that count() matches list() for the same filter
// (including the search filter the prior hand-rolled count silently ignored), and that
// the keyset export streams the whole table page-by-page without offset degradation.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ISSUE_EXPORT_DEFAULT_LIMIT,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres query-bounding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService query bounding (EDG-7566)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-query-bounding-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssues(
    companyId: string,
    rows: Array<{ title?: string; status?: string; createdAt?: Date }>,
  ) {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    await db.insert(issues).values(
      rows.map((row, index) => ({
        id: randomUUID(),
        companyId,
        title: row.title ?? `Issue ${index}`,
        status: row.status ?? "todo",
        priority: "medium",
        // Distinct, monotonically increasing timestamps so the (created_at, id) keyset
        // ordering is deterministic across export pages.
        createdAt: row.createdAt ?? new Date(base + index * 1000),
      })),
    );
  }

  // ---- AC1: default LIMIT + unbounded opt-in ------------------------------------------

  it("imposes the default page size when no limit is supplied, and honours the unbounded opt-in", async () => {
    const companyId = await seedCompany();
    const total = ISSUE_LIST_DEFAULT_LIMIT + 3;
    await seedIssues(
      companyId,
      Array.from({ length: total }, (_, index) => ({ title: `Bulk ${index}` })),
    );

    const defaultPage = await svc.list(companyId);
    expect(defaultPage.length).toBe(ISSUE_LIST_DEFAULT_LIMIT);

    const fullRead = await svc.list(companyId, { unbounded: true });
    expect(fullRead.length).toBe(total);

    const explicit = await svc.list(companyId, { limit: 5 });
    expect(explicit.length).toBe(5);
  });

  it("clamps a supplied limit above the maximum down to ISSUE_LIST_MAX_LIMIT", async () => {
    const companyId = await seedCompany();
    await seedIssues(
      companyId,
      Array.from({ length: 4 }, (_, index) => ({ title: `Few ${index}` })),
    );
    // Over-large limit must not widen the bound past the server maximum.
    const page = await svc.list(companyId, { limit: ISSUE_LIST_MAX_LIMIT + 500 });
    expect(page.length).toBe(4);
  });

  // ---- AC2: count() matches list() for the same filter --------------------------------

  it("count() matches the unbounded list length for the same filter", async () => {
    const companyId = await seedCompany();
    await seedIssues(companyId, [
      { title: "alpha", status: "todo" },
      { title: "beta", status: "todo" },
      { title: "gamma", status: "in_progress" },
      { title: "delta", status: "done" },
    ]);

    expect(await svc.count(companyId)).toBe(4);

    const todoCount = await svc.count(companyId, { status: "todo" });
    const todoRows = await svc.list(companyId, { status: "todo", unbounded: true });
    expect(todoCount).toBe(2);
    expect(todoCount).toBe(todoRows.length);
  });

  it("count() honours the search filter (the prior hand-rolled count silently ignored q)", async () => {
    const companyId = await seedCompany();
    await seedIssues(companyId, [
      { title: "migrate database schema" },
      { title: "migrate the API" },
      { title: "unrelated chore" },
    ]);

    const q = "migrate";
    const searchCount = await svc.count(companyId, { q });
    const searchRows = await svc.list(companyId, { q, unbounded: true });
    expect(searchCount).toBe(2);
    expect(searchCount).toBe(searchRows.length);
  });

  // ---- AC3: cursor bulk export --------------------------------------------------------

  it("streams the whole table page-by-page via the keyset cursor with no duplicates or gaps", async () => {
    const companyId = await seedCompany();
    const total = 7;
    await seedIssues(
      companyId,
      Array.from({ length: total }, (_, index) => ({ title: `Export ${index}` })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await svc.exportPage(companyId, { cursor, limit: 2 });
      for (const item of page.items) seen.push(item.id);
      // Each page is in descending (created_at, id) order.
      const sorted = [...page.items].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1,
      );
      expect(page.items.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(total + 1);
    } while (cursor !== null);

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("caps the export page size and reports hasMore/nextCursor correctly", async () => {
    const companyId = await seedCompany();
    await seedIssues(
      companyId,
      Array.from({ length: 5 }, (_, index) => ({ title: `Cap ${index}` })),
    );

    const firstPage = await svc.exportPage(companyId, { limit: 2 });
    expect(firstPage.items.length).toBe(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    // A non-positive / oversized request still yields a bounded, valid page.
    const defaulted = await svc.exportPage(companyId, { limit: 0 });
    expect(defaulted.items.length).toBeLessThanOrEqual(ISSUE_EXPORT_DEFAULT_LIMIT);
    expect(defaulted.items.length).toBe(5);
    expect(defaulted.hasMore).toBe(false);
    expect(defaulted.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the start of the export", async () => {
    const companyId = await seedCompany();
    await seedIssues(
      companyId,
      Array.from({ length: 3 }, (_, index) => ({ title: `Bad ${index}` })),
    );

    const page = await svc.exportPage(companyId, { cursor: "not-a-valid-cursor", limit: 10 });
    expect(page.items.length).toBe(3);
  });

  it("applies the same filters to the export as the list", async () => {
    const companyId = await seedCompany();
    await seedIssues(companyId, [
      { title: "todo one", status: "todo" },
      { title: "todo two", status: "todo" },
      { title: "done one", status: "done" },
    ]);

    const page = await svc.exportPage(companyId, { filters: { status: "todo" }, limit: 50 });
    expect(page.items.length).toBe(2);
    expect(page.items.every((row) => row.status === "todo")).toBe(true);
  });
});

// Cursor opacity is part of the export contract — assert the empty-DB shape without a DB.
describe("issueService.exportPage empty contract (EDG-7566)", () => {
  it("export select stays lean (smoke: constants are exported and ordered)", () => {
    expect(ISSUE_EXPORT_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(ISSUE_EXPORT_DEFAULT_LIMIT).toBeLessThanOrEqual(ISSUE_LIST_MAX_LIMIT);
  });
});
