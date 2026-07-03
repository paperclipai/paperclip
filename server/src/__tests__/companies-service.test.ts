import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService, isIssuePrefixConflict } from "../services/companies.ts";

describe("company service", () => {
  it("recognizes Drizzle-wrapped issue prefix duplicate errors", () => {
    const postgresError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "companies_issue_prefix_idx",
    });
    const drizzleError = new Error("Failed query", { cause: postgresError });

    expect(isIssuePrefixConflict(drizzleError)).toBe(true);
  });

  it("does not treat unrelated duplicate keys as issue prefix conflicts", () => {
    const postgresError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "users_email_idx",
    });
    const drizzleError = new Error("Failed query", { cause: postgresError });

    expect(isIssuePrefixConflict(drizzleError)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company service embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company service with postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-companies-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allocates the next issue prefix when the derived prefix already exists", async () => {
    await db.insert(companies).values({
      name: "Existing Elitez",
      issuePrefix: "ELI",
    });

    const created = await companyService(db).create({
      name: "Elitez Asia (Rafly)",
      budgetMonthlyCents: 0,
    });

    expect(created.issuePrefix).toBe("ELIA");

    const [localEnvironment] = await db
      .select()
      .from(environments)
      .where(eq(environments.companyId, created.id));
    expect(localEnvironment?.driver).toBe("local");
  });
});
