import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, toolProfileBindings, toolProfileEntries } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createConnectionProfileConfigurationFixture, legacyConnectionConfiguration } from "./helpers/connection-profile-configuration-fixture.js";
import { createToolProfileService } from "../services/tool-access/profiles/service.js";
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("connection Permissions profile configuration", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("connection-profile-configuration-"); db = createDb(database.connectionString); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  it("matches the old selected view with full ordered entries and bindings, before and after changes", async () => {
    const f = await createConnectionProfileConfigurationFixture(db, { profiles: 8, tools: 12, rules: 4 });
    const service = createToolProfileService(db, () => new Date("2026-02-01T00:00:00Z"));
    const visible = async <T>(rows: T[]) => rows;
    const compare = async () => {
      const expected = legacyConnectionConfiguration(await service.listProfiles(f.company.id), f.connection.id);
      const actual = await service.listConnectionProfileConfiguration(f.company.id, f.connection.id, visible);
      expect(actual).toEqual(expected);
      expect(actual.map(p => p.id).sort()).toEqual([...f.selectedIds].sort());
      expect(actual.every(p => !("summary" in p) && !("newToolsPendingCount" in p))).toBe(true);
      return actual;
    };
    let result = await compare();
    expect(result.find(p => p.id === f.selectedIds[0])!.bindings.map(b => b.priority)).toEqual([1, 2]);
    expect(result.find(p => p.id === f.selectedIds[1])!.bindings).toHaveLength(2);
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.selectedIds[1], selectorType: "tool_name", toolName: "new selection" });
    await compare();
    // An unbound app profile must remain present for the install fallback.
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.selectedIds[0]));
    result = await compare();
    expect(result.find(p => p.id === f.selectedIds[0])!.bindings).toEqual([]);
    const seen: string[][] = [];
    const filtered = await service.listConnectionProfileConfiguration(f.company.id, f.connection.id, async rows => {
      seen.push(rows.map(p => p.id)); return rows.filter(p => p.id !== f.selectedIds[1]);
    });
    expect(seen[0].sort()).toEqual([...f.selectedIds].sort());
    expect(filtered.map(p => p.id)).toEqual([f.selectedIds[0]]);
    expect(await service.listConnectionProfileConfiguration(f.company.id, f.connection.id, async () => [])).toEqual([]);
    const foreign = await createConnectionProfileConfigurationFixture(db, { profiles: 2, tools: 3, rules: 2 });
    expect(await service.listConnectionProfileConfiguration(foreign.company.id, f.connection.id, visible)).toEqual([]);
  });
});
