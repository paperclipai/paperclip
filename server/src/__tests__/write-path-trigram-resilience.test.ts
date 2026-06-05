import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueComments,
  issues,
  withSearchIndexFallback,
  getSearchDegradation,
  probeTrigramExtension,
  __resetSearchDegradationForTests,
  TRIGRAM_SEARCH_INDEXES,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres trigram resilience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for TON-2145 (follow-up to incident TON-2143): a pg_trgm / GIN
// trigram failure must degrade search, not 500 the primary write. These run against a
// real migrated embedded Postgres, so the actual GIN trigram indexes are maintained
// inline on the insert — the exact path that failed in TON-2143.
describeEmbeddedPostgres("write path trigram resilience", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trigram-resilience-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    __resetSearchDegradationForTests();
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
    __resetSearchDegradationForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Trigram Co",
      issuePrefix: "TRG",
      requireBoardApprovalForNewAgents: false,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resilience target",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("starts with the trigram GIN indexes present (migrations applied)", async () => {
    const rows = (await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = 'issue_comments_body_search_idx'`,
    )) as unknown as Array<{ indexname: string }>;
    expect(rows.length).toBe(1);

    const health = await probeTrigramExtension(db);
    expect(health).toMatchObject({ installedInCatalog: true, loadableAtRuntime: true });
  });

  // The exact failing case from TON-2143: a ~150-char novel comment body.
  it("accepts a ~150-char novel comment (returns the row — the TON-2143 201 case)", async () => {
    const { companyId, issueId } = await seedIssue();
    const body =
      "Quarterly coordination retro surfaced eleven novel mitigation threads spanning " +
      "embedded postgres trigram indexing latency budgets and durable wakeup semantics.";
    expect(body.length).toBeGreaterThanOrEqual(150);

    const [comment] = await withSearchIndexFallback(
      db,
      () => db.insert(issueComments).values({ companyId, issueId, body }).returning(),
      { operationName: "issue_comment.insert" },
    );

    expect(comment?.id).toBeTruthy();
    expect(comment?.body).toBe(body);
    // Healthy DB: no degradation, indexes intact.
    expect(getSearchDegradation().degraded).toBe(false);
  });

  // Fault injection against the real DB: when trigram maintenance is reported unavailable,
  // the fallback drops the real GIN indexes and the retried write completes (201-equivalent).
  it("degrades search and completes the write when trigram maintenance is unavailable", async () => {
    const { companyId, issueId } = await seedIssue();
    const body =
      "Degraded-mode coordination note describing how a trigram extension load failure must " +
      "never block primary comment writes during an incident window.";

    let attempts = 0;
    const [comment] = await withSearchIndexFallback(
      db,
      () => {
        attempts += 1;
        if (attempts === 1) {
          // Simulate pg_trgm being unloadable at runtime (TON-2143).
          throw new Error('could not access file "pg_trgm": No such file or directory');
        }
        return db.insert(issueComments).values({ companyId, issueId, body }).returning();
      },
      { operationName: "issue_comment.insert" },
    );

    expect(attempts).toBe(2);
    expect(comment?.id).toBeTruthy();

    const degradation = getSearchDegradation();
    expect(degradation.degraded).toBe(true);
    expect(degradation.droppedIndexes).toEqual(TRIGRAM_SEARCH_INDEXES.map((i) => i.index));

    // The real trigram indexes were actually dropped from the database.
    const remaining = (await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_search_idx'`,
    )) as unknown as Array<{ indexname: string }>;
    expect(remaining.length).toBe(0);
  });
});
