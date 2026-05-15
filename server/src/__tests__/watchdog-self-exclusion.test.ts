import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.ts";
import { isWatchdogFamilyDescendant } from "../services/recovery/watchdog-family.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("watchdog family self-exclusion", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-self-exclusion-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("detects direct, ancestor, and origin-linked watchdog families", async () => {
    const companyId = randomUUID();
    const reviewId = randomUUID();
    const childId = randomUUID();
    const originLinkedId = randomUUID();
    const manualId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Family Co",
      issuePrefix: "WDF",
    });
    await db.insert(issues).values([
      {
        id: reviewId,
        companyId,
        title: "Review productivity",
        status: "todo",
        priority: "high",
        originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
        originId: manualId,
      },
      {
        id: childId,
        companyId,
        title: "Nested recovery child",
        status: "todo",
        priority: "medium",
        parentId: reviewId,
      },
      {
        id: originLinkedId,
        companyId,
        title: "Origin linked recovery child",
        status: "todo",
        priority: "medium",
        originId: reviewId,
      },
      {
        id: manualId,
        companyId,
        title: "Manual implementation",
        status: "todo",
        priority: "medium",
      },
    ]);

    const rows = await db.select().from(issues);
    const byId = new Map(rows.map((row) => [row.id, row]));
    await expect(isWatchdogFamilyDescendant(db, byId.get(reviewId)!)).resolves.toBe(true);
    await expect(isWatchdogFamilyDescendant(db, byId.get(childId)!)).resolves.toBe(true);
    await expect(isWatchdogFamilyDescendant(db, byId.get(originLinkedId)!)).resolves.toBe(true);
    await expect(isWatchdogFamilyDescendant(db, byId.get(manualId)!)).resolves.toBe(false);
  });
});
