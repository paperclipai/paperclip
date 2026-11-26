import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, toolCatalogEntries, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createProfileProjectionFixture } from "./helpers/tool-profile-projection-fixture.js";
import { createToolProfileService } from "../services/tool-access/profiles/service.js";
import { createToolAppAttention } from "../services/tool-access/catalog/attention.js";
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("pending profile tools through profile and attention services", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("profile-review-service-"); db = createDb(database.connectionString); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  it("preserves fresh pending counts in both owning services after review and catalog changes", async () => {
    const f = await createProfileProjectionFixture(db, { profiles: 2, tools: 8, rules: 4 });
    const now = () => new Date("2026-02-01T00:00:00Z"), service = createToolProfileService(db, now), attention = createToolAppAttention(db, now);
    const assertCounts = async (expected: number) => {
      const profiles = await service.listProfiles(f.company.id);
      expect(await service.listProfileSummaries(f.company.id)).toEqual(
        profiles.map(({ id, name, status, updatedAt, summary, newToolsPendingCount }) =>
          ({ id, name, status, updatedAt, summary, newToolsPendingCount })),
      );
      expect(profiles.find(p => p.id === f.profiles[0].id)?.newToolsPendingCount).toBe(expected);
      expect(profiles.find(p => p.id === f.profiles[1].id)?.newToolsPendingCount).toBe(0);
      expect((await service.listProfileNewTools(f.profiles[0].id, f.company.id)).pendingCount).toBe(expected);
      expect((await attention(f.company.id)).totals.newToolsPendingReview).toBe(expected);
    };
    await assertCounts(4);
    const [exclude] = await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profiles[0].id,
      selectorType: "tool_name", effect: "exclude", toolName: f.catalog[4].toolName }).returning();
    await assertCounts(3);
    await db.update(toolCatalogEntries).set({ status: "removed" }).where(eq(toolCatalogEntries.id, f.catalog[5].id));
    await assertCounts(2);
    await db.update(toolProfiles).set({ newToolsReviewedAt: now() }).where(eq(toolProfiles.id, f.profiles[0].id));
    await assertCounts(0);
    await db.update(toolProfiles).set({ status: "archived" }).where(eq(toolProfiles.id, f.profiles[0].id));
    await assertCounts(0);
    const foreign = await createProfileProjectionFixture(db, { profiles: 2, tools: 5, rules: 2 });
    expect((await service.listProfiles(foreign.company.id)).map(p => p.companyId)).toEqual([foreign.company.id, foreign.company.id]);
    expect((await service.listProfileSummaries(foreign.company.id)).map(p => p.id).sort()).toEqual(foreign.profiles.map(p => p.id).sort());
    expect((await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, exclude.id)))[0].effect).toBe("exclude");
  });
  it("keeps independent effects, null keys, and duplicate and unknown selectors across shared groups", async () => {
    const f = await createProfileProjectionFixture(db, { profiles: 6, tools: 8, rules: 0 });
    const service = createToolProfileService(db, () => new Date());
    const [application, connection, catalogEntry, toolName, riskLevel] = f.profiles;
    const [first, second] = f.catalog;
    await db.update(toolCatalogEntries).set({ applicationId: null }).where(eq(toolCatalogEntries.id, first.id));
    type Entry = typeof toolProfileEntries.$inferInsert;
    const add = (profileId: string, selector: Pick<Entry, "selectorType"> & Partial<Entry>): Entry =>
      ({ companyId: f.company.id, profileId, effect: "include", ...selector });
    const includeName = { selectorType: "tool_name", toolName: second.toolName } as const;
    await db.insert(toolProfileEntries).values([
      add(application.id, { selectorType: "application", applicationId: f.application.id }),
      add(application.id, { selectorType: "application", applicationId: null }),
      add(connection.id, { selectorType: "connection", connectionId: f.connection.id }),
      add(connection.id, { selectorType: "catalog_entry", effect: "exclude", catalogEntryId: first.id }),
      add(catalogEntry.id, { selectorType: "catalog_entry", catalogEntryId: first.id, applicationId: f.application.id }),
      add(catalogEntry.id, { selectorType: "catalog_entry", catalogEntryId: first.id }),
      add(catalogEntry.id, { selectorType: "legacy_unknown" as Entry["selectorType"], catalogEntryId: second.id }),
      add(toolName.id, includeName),
      add(toolName.id, includeName),
      add(riskLevel.id, includeName),
      add(riskLevel.id, { ...includeName, effect: "exclude" }),
      add(riskLevel.id, { selectorType: "risk_level", riskLevel: "read" }),
    ]);
    const detail = await service.listProfiles(f.company.id);
    const summaries = await service.listProfileSummaries(f.company.id);
    expect(summaries).toEqual(detail.map(({ id, name, status, updatedAt, summary, newToolsPendingCount }) =>
      ({ id, name, status, updatedAt, summary, newToolsPendingCount })));
    const counts = new Map(summaries.map(({ id, summary }) => [id, summary.allowedToolCount]));
    expect(f.profiles.map(({ id }) => counts.get(id))).toEqual([8, 7, 1, 1, 7, 0]);
  });
});
