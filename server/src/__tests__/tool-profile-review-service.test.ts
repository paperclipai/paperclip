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
    const foreign = await createProfileProjectionFixture(db, { profiles: 2, tools: 5, rules: 2 });
    expect((await service.listProfiles(foreign.company.id)).map(p => p.companyId)).toEqual([foreign.company.id, foreign.company.id]);
    expect((await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, exclude.id)))[0].effect).toBe("exclude");
  });
});
