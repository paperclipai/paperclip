import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  createDb,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createToolProfileService } from "../services/tool-access/profiles/service.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("tool profile entry order", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-profile-entry-order-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 20_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("keeps list and detail entries stable across tied timestamps and physical row order", async () => {
    const [company, foreign] = await db.insert(companies).values([
      { name: "Entry order", issuePrefix: `EO${randomUUID().slice(0, 6)}` },
      { name: "Other entry order", issuePrefix: `EF${randomUUID().slice(0, 6)}` },
    ]).returning();
    const [profile, foreignProfile] = await db.insert(toolProfiles).values([
      { companyId: company.id, profileKey: "ordered", name: "Ordered" },
      { companyId: foreign.id, profileKey: "foreign", name: "Foreign" },
    ]).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id, name: "Order fixture", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "Order fixture",
      uid: `fixture/${randomUUID()}`, transport: "mcp_remote", status: "active",
      enabled: true, config: {},
    }).returning();
    await db.insert(toolCatalogEntries).values(["allowed", "blocked"].map(toolName => ({
      companyId: company.id, applicationId: application.id, connectionId: connection.id,
      name: toolName, toolName, riskLevel: "read" as const, status: "active" as const,
      versionHash: randomUUID(), schemaHash: randomUUID(),
    })));
    // Batch inserts use now() for every row. No entry ordinal exists, and an
    // exclusion wins regardless of where it appears among matching includes.
    const tiedAt = new Date("2026-01-02T00:00:00Z");
    const tied = Array.from({ length: 30 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      companyId: company.id, profileId: profile.id, selectorType: "tool_name" as const,
      effect: index === 29 ? "exclude" as const : "include" as const,
      toolName: index === 0 ? "allowed" : index === 1 || index === 29 ? "blocked" : `other_${index}`,
      createdAt: tiedAt,
    }));
    const earlier = {
      ...tied[0], id: "ffffffff-ffff-4fff-8fff-ffffffffffff", toolName: "earlier",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    await db.insert(toolProfileEntries).values([
      ...tied.toReversed(), earlier,
      { companyId: foreign.id, profileId: foreignProfile.id,
        selectorType: "tool_name", toolName: "foreign" },
    ]);

    // Change only heap layout in this disposable database. Force sequential
    // scans so both reads exercise the different layouts, not one index order.
    await db.execute(sql`SET enable_indexscan = off`);
    await db.execute(sql`SET enable_bitmapscan = off`);
    await db.execute(sql`CREATE INDEX entry_order_fixture_desc ON tool_profile_entries (id DESC)`);
    const service = createToolProfileService(db, () => new Date());
    const snapshots = [];
    for (const index of ["tool_profile_entries_pkey", "entry_order_fixture_desc"]) {
      await db.execute(sql`CLUSTER tool_profile_entries USING ${sql.identifier(index)}`);
      const physical = await db.execute<{ id: string }>(sql`
        SELECT id FROM tool_profile_entries WHERE profile_id = ${profile.id} ORDER BY ctid
      `);
      const [listed] = await service.listProfiles(company.id);
      const detail = await service.getProfile(profile.id, company.id);
      snapshots.push({ physical: physical.map(row => row.id), listed, detail });
    }
    expect(snapshots[0].physical).not.toEqual(snapshots[1].physical);
    const expectedIds = [earlier.id, ...tied.map(entry => entry.id)];
    for (const { listed, detail } of snapshots) {
      expect(listed.entries.map(entry => entry.id)).toEqual(expectedIds);
      expect(detail).toEqual(listed);
      expect(listed.summary).toMatchObject({ allowedToolCount: 1, excludedToolCount: 1, totalToolCount: 2 });
    }
    expect(snapshots[1].listed).toEqual(snapshots[0].listed);
    expect(await service.listProfiles(foreign.id)).toMatchObject([{ id: foreignProfile.id }]);
    await expect(service.getProfile(profile.id, foreign.id)).rejects.toThrow("Tool profile not found");

    // A real entry change must remain visible to configuration comparison.
    await db.update(toolProfileEntries).set({ effect: "include" }).where(eq(toolProfileEntries.id, tied[29].id));
    const changed = await service.getProfile(profile.id, company.id);
    expect(changed.entries).not.toEqual(snapshots[1].detail.entries);
    expect(changed.summary).toMatchObject({ allowedToolCount: 2, excludedToolCount: 0 });
  });
});
