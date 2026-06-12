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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue PR-url tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue prUrl round-trip", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-url-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PR Co",
      issuePrefix: "PRC",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("persists prUrl on update and surfaces it through the read projection", async () => {
    const companyId = await seedCompany();
    const issue = await svc.create(companyId, { title: "Add feature" });
    expect(issue.prUrl ?? null).toBeNull();

    const url = "https://github.com/Moyal17/paperclip/pull/42";
    await svc.update(issue.id, { prUrl: url });

    const read = await svc.getById(issue.id);
    expect(read?.prUrl).toBe(url);
  });

  it("clears prUrl when set to null", async () => {
    const companyId = await seedCompany();
    const issue = await svc.create(companyId, { title: "Add feature" });
    await svc.update(issue.id, { prUrl: "https://github.com/Moyal17/paperclip/pull/7" });
    await svc.update(issue.id, { prUrl: null });

    const read = await svc.getById(issue.id);
    expect(read?.prUrl ?? null).toBeNull();
  });
});
