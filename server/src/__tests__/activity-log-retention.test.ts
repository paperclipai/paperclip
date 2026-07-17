import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  capActivityDetails,
  logActivity,
  MAX_ACTIVITY_DETAILS_BYTES,
} from "../services/activity-log.js";
import { pruneActivityLog } from "../services/activity-log-retention.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("capActivityDetails", () => {
  it("leaves payloads under the cap unchanged", () => {
    const details = { outcome: "ok" };
    expect(capActivityDetails(details)).toBe(details);
  });

  it("replaces oversized payloads with a bounded truncation marker", () => {
    const details = { message: `start-${"😀\"\\\n".repeat(30_000)}-end` };
    const capped = capActivityDetails(details);

    expect(capped).toMatchObject({
      _paperclipTruncated: true,
      _paperclipMaxBytes: MAX_ACTIVITY_DETAILS_BYTES,
    });
    expect(capped?._paperclipOriginalBytes).toBeGreaterThan(MAX_ACTIVITY_DETAILS_BYTES);
    expect(capped?._paperclipPreview).toEqual(expect.stringContaining("start-"));
    expect(/[\uD800-\uDBFF]$/.test(String(capped?._paperclipPreview))).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(
      MAX_ACTIVITY_DETAILS_BYTES,
    );
  });
});

describeEmbeddedPostgres("activity log retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-retention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("prunes per-company policies without crossing company boundaries", async () => {
    const retainedCompanyId = randomUUID();
    const foreverCompanyId = randomUUID();
    const shortRetentionCompanyId = randomUUID();
    const now = new Date("2026-07-17T12:00:00.000Z");

    await db.insert(companies).values([
      {
        id: retainedCompanyId,
        name: "Thirty days",
        issuePrefix: "THD",
        activityLogRetentionDays: 30,
      },
      {
        id: foreverCompanyId,
        name: "Forever",
        issuePrefix: "FOR",
        activityLogRetentionDays: null,
      },
      {
        id: shortRetentionCompanyId,
        name: "Seven days",
        issuePrefix: "SEV",
        activityLogRetentionDays: 7,
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId: retainedCompanyId,
        actorId: "system",
        action: "retained.expired",
        entityType: "company",
        entityId: retainedCompanyId,
        createdAt: new Date("2026-06-16T11:59:59.000Z"),
      },
      {
        companyId: retainedCompanyId,
        actorId: "system",
        action: "retained.cutoff",
        entityType: "company",
        entityId: retainedCompanyId,
        createdAt: new Date("2026-06-17T12:00:00.000Z"),
      },
      {
        companyId: foreverCompanyId,
        actorId: "system",
        action: "forever.old",
        entityType: "company",
        entityId: foreverCompanyId,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        companyId: shortRetentionCompanyId,
        actorId: "system",
        action: "short.expired",
        entityType: "company",
        entityId: shortRetentionCompanyId,
        createdAt: new Date("2026-07-10T11:59:59.000Z"),
      },
      {
        companyId: shortRetentionCompanyId,
        actorId: "system",
        action: "short.current",
        entityType: "company",
        entityId: shortRetentionCompanyId,
        createdAt: new Date("2026-07-10T12:00:00.000Z"),
      },
    ]);

    await expect(pruneActivityLog(db, now)).resolves.toBe(2);

    const remaining = await db
      .select({ companyId: activityLog.companyId, action: activityLog.action })
      .from(activityLog)
      .orderBy(asc(activityLog.action));

    expect(remaining).toEqual([
      { companyId: foreverCompanyId, action: "forever.old" },
      { companyId: retainedCompanyId, action: "retained.cutoff" },
      { companyId: shortRetentionCompanyId, action: "short.current" },
    ]);
  });

  it("caps details on the centralized activity write path", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Capped details",
      issuePrefix: "CAP",
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "test.oversized",
      entityType: "company",
      entityId: companyId,
      details: { output: "😀".repeat(MAX_ACTIVITY_DETAILS_BYTES) },
    });

    const row = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);

    expect(row?.details).toMatchObject({
      _paperclipTruncated: true,
      _paperclipMaxBytes: MAX_ACTIVITY_DETAILS_BYTES,
    });
    expect(Buffer.byteLength(JSON.stringify(row?.details), "utf8")).toBeLessThanOrEqual(
      MAX_ACTIVITY_DETAILS_BYTES,
    );
  });
});
