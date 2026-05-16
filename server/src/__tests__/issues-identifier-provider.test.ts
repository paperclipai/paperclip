// Phase 1 / Task 1.4 of the Linear ↔ Paperclip ID Unification plan.
// See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
//
// Locks in:
//   - companies.identifier_provider defaults to "paperclip" (Task 1.2)
//   - companies.identifier_provider CHECK rejects unknown values
//   - issues.legacy_identifier defaults to null and round-trips text (Task 1.3)
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("identifier_provider + legacy_identifier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-id-provider-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("companies.identifier_provider defaults to 'paperclip'", async () => {
    const [row] = await db
      .insert(companies)
      .values({
        name: `id-provider-default ${randomUUID()}`,
        issuePrefix: `IP${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    expect(row.identifierProvider).toBe("paperclip");
  });

  it("companies.identifier_provider accepts 'linear' as an explicit value", async () => {
    const [row] = await db
      .insert(companies)
      .values({
        name: `id-provider-linear ${randomUUID()}`,
        issuePrefix: `IP${randomUUID().slice(0, 6).toUpperCase()}`,
        identifierProvider: "linear",
      })
      .returning();
    expect(row.identifierProvider).toBe("linear");
  });

  it("companies.identifier_provider rejects unknown values via CHECK", async () => {
    await expect(
      db
        .insert(companies)
        .values({
          name: `id-provider-bad ${randomUUID()}`,
          issuePrefix: `IP${randomUUID().slice(0, 6).toUpperCase()}`,
          // Drizzle's text() doesn't track CHECK constraints, so this cast
          // is required to exercise the DB-level guard. The point of the
          // test is the DB rejection, not the TS type system.
          identifierProvider: "github" as never,
        })
        .returning(),
    // Drizzle wraps the underlying PG error in `Failed query: ...` text that
    // no longer surfaces the constraint name; the wrapped SQL still names the
    // column, so match on that as a stable signal that the DB rejected the
    // unknown identifier_provider value.
    ).rejects.toThrow(/identifier_provider/i);
  });

  it("issues.legacy_identifier defaults to null and round-trips text", async () => {
    const [company] = await db
      .insert(companies)
      .values({
        name: `legacy-id ${randomUUID()}`,
        issuePrefix: `LI${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();

    const [row] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "round-trip",
        identifier: "PCL-42",
      })
      .returning();
    expect(row.legacyIdentifier).toBeNull();

    await db
      .update(issues)
      .set({ legacyIdentifier: "BLO-42" })
      .where(eq(issues.id, row.id));

    const [reread] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, row.id));
    expect(reread.legacyIdentifier).toBe("BLO-42");
  });
});
