import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-companies-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allocates the next derived issue prefix when the first candidate conflicts", async () => {
    await db.insert(companies).values({
      id: randomUUID(),
      name: "Tectara Systems",
      issuePrefix: "TEC",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await companyService(db).create({
      name: "Tecton Forge Lab",
      budgetMonthlyCents: 0,
    });

    expect(created).toMatchObject({
      name: "Tecton Forge Lab",
      issuePrefix: "TECA",
      budgetMonthlyCents: 0,
    });
  });
});
