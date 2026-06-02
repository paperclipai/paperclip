import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyInfraEntitlements, createDb } from "@valadrien-os/db";
import { DEFAULT_MANAGED_INFRA_ENTITLEMENTS } from "@valadrien-os/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("valadrien-os-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyInfraEntitlements);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARO",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("AROA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARO", "AROA"]);
  });

  it("seeds managed infra entitlements when creating a managed company", async () => {
    const created = await companyService(db).create({
      name: "ValAdrien Cloud Co",
      infraMode: "managed",
    });

    const entitlements = await companyService(db).listInfraEntitlements(created.id);
    expect(entitlements).toHaveLength(DEFAULT_MANAGED_INFRA_ENTITLEMENTS.length);
    expect(entitlements.map((row) => row.capability).sort()).toEqual(
      DEFAULT_MANAGED_INFRA_ENTITLEMENTS.map((row) => row.capability).sort(),
    );
    for (const row of entitlements) {
      expect(row.status).toBe("entitled");
      expect(row.provider).toBeNull();
    }
  });

  it("does not seed infra entitlements for BYO companies", async () => {
    const created = await companyService(db).create({
      name: "Bring Your Own Co",
      infraMode: "byo",
    });

    const entitlements = await companyService(db).listInfraEntitlements(created.id);
    expect(entitlements).toEqual([]);
  });
});
