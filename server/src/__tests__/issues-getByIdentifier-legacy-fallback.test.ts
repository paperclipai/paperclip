// Phase 4 follow-up to PR #55. Pins down the resolver fallback that lets
// pre-rename URLs (bookmarks, agent memory, copy-pasted refs) keep
// resolving after 0084's BLO→PCL backfill renamed identifiers.
//
// The schema-level legacy_identifier round-trip is covered separately in
// issues-identifier-provider.test.ts; this file pins the
// getByIdentifier dispatcher in services/issues.ts: that the primary
// `identifier` lookup is preferred, and that legacy_identifier kicks in
// only when the primary misses. Without this test, a future refactor
// could quietly regress the fallback and bookmarks would 404.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService.getByIdentifier (legacy_identifier fallback)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-getbyident-legacy-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  async function seedCompany(prefix: string) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `legacy-fallback ${randomUUID()}`,
        issuePrefix: prefix,
      })
      .returning();
    return company;
  }

  async function seedIssue(opts: {
    companyId: string;
    identifier: string;
    issueNumber: number;
    legacyIdentifier?: string | null;
  }) {
    const [row] = await db
      .insert(issues)
      .values({
        companyId: opts.companyId,
        identifier: opts.identifier,
        issueNumber: opts.issueNumber,
        legacyIdentifier: opts.legacyIdentifier ?? null,
        title: `seed for ${opts.identifier}`,
      })
      .returning();
    return row;
  }

  it("returns the row by primary identifier (hot path, no legacy_identifier)", async () => {
    const company = await seedCompany(`PCL${randomUUID().slice(0, 4).toUpperCase()}`);
    const seeded = await seedIssue({
      companyId: company.id,
      identifier: "PCL-100",
      issueNumber: 100,
    });

    const found = await svc.getByIdentifier("PCL-100");
    expect(found?.id).toBe(seeded.id);
    expect(found?.identifier).toBe("PCL-100");
  });

  it("falls back to legacy_identifier when the primary identifier is missing", async () => {
    // Mirror BLO's post-rename state: paperclip-only issue's identifier
    // was rewritten BLO-2562 → PCL-2562, with the old name preserved in
    // legacy_identifier. A bookmark to /issues/BLO-2562 must still land
    // on this row.
    const company = await seedCompany(`PCL${randomUUID().slice(0, 4).toUpperCase()}`);
    const seeded = await seedIssue({
      companyId: company.id,
      identifier: "PCL-2562",
      issueNumber: 2562,
      legacyIdentifier: "BLO-2562",
    });

    const found = await svc.getByIdentifier("BLO-2562");
    expect(found?.id).toBe(seeded.id);
    expect(found?.identifier).toBe("PCL-2562");
    expect(found?.legacyIdentifier).toBe("BLO-2562");
  });

  it("uppercases the input before matching (legacy_identifier path is case-insensitive too)", async () => {
    const company = await seedCompany(`PCL${randomUUID().slice(0, 4).toUpperCase()}`);
    await seedIssue({
      companyId: company.id,
      identifier: "PCL-77",
      issueNumber: 77,
      legacyIdentifier: "BLO-77",
    });

    const found = await svc.getByIdentifier("blo-77");
    expect(found?.identifier).toBe("PCL-77");
  });

  it("prefers primary identifier match when the same string exists as another row's legacy_identifier", async () => {
    // Cross-namespace collision: company A's CURRENT issue is BLO-9999;
    // company B's RENAMED issue stashed BLO-9999 in legacy_identifier
    // (its current identifier is PCL-9999). A request for "BLO-9999"
    // must resolve to A's primary, not B's legacy. Without primary-wins
    // ordering, the fallback would silently misroute live URLs.
    const companyA = await seedCompany(`AAA${randomUUID().slice(0, 4).toUpperCase()}`);
    const companyB = await seedCompany(`BBB${randomUUID().slice(0, 4).toUpperCase()}`);
    const primary = await seedIssue({
      companyId: companyA.id,
      identifier: "BLO-9999",
      issueNumber: 9999,
    });
    await seedIssue({
      companyId: companyB.id,
      identifier: "PCL-9999",
      issueNumber: 9999,
      legacyIdentifier: "BLO-9999",
    });

    const found = await svc.getByIdentifier("BLO-9999");
    expect(found?.id).toBe(primary.id);
    expect(found?.identifier).toBe("BLO-9999");
  });

  it("returns null when neither primary nor legacy_identifier matches", async () => {
    const company = await seedCompany(`PCL${randomUUID().slice(0, 4).toUpperCase()}`);
    await seedIssue({
      companyId: company.id,
      identifier: "PCL-1",
      issueNumber: 1,
      legacyIdentifier: "BLO-1",
    });

    expect(await svc.getByIdentifier("XYZ-9999")).toBeNull();
  });
});
