import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issueFavourites, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueFavouriteService } from "../services/issue-favourites.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue favourite tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue favourites", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueFavouriteService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-favourites-");
    db = createDb(tempDb.connectionString);
    svc = issueFavouriteService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueFavourites);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Favourite me" });
    return { companyId, issueId };
  }

  it("adds a favourite once per user and issue (idempotent)", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();
    const userId = "board-user";

    await svc.add(companyId, userId, issueId);
    await svc.add(companyId, userId, issueId);

    const favourites = await svc.list(companyId, userId);
    expect(favourites).toHaveLength(1);
    expect(favourites[0]?.issueId).toBe(issueId);
    expect(favourites[0]?.issue.id).toBe(issueId);
    expect(favourites[0]?.issue.title).toBe("Favourite me");
  });

  it("scopes favourites per user", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();

    await svc.add(companyId, "user-a", issueId);

    expect(await svc.list(companyId, "user-a")).toHaveLength(1);
    expect(await svc.list(companyId, "user-b")).toHaveLength(0);
  });

  it("removes a favourite and reports whether a row existed", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();
    const userId = "board-user";

    await svc.add(companyId, userId, issueId);
    const removed = await svc.remove(companyId, userId, issueId);
    expect(removed?.issueId).toBe(issueId);
    expect(await svc.list(companyId, userId)).toHaveLength(0);

    const removedAgain = await svc.remove(companyId, userId, issueId);
    expect(removedAgain).toBeNull();
  });

  it("cascades favourites when the issue is deleted", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();
    const userId = "board-user";

    await svc.add(companyId, userId, issueId);
    await db.delete(issues).where(eq(issues.id, issueId));

    expect(await svc.list(companyId, userId)).toHaveLength(0);
  });

  it("does not strand company deletion once its issues are removed", async () => {
    // `issues.company_id` has no ON DELETE cascade, so a company can only be
    // deleted after its issues are gone. Deleting the issue cascades the
    // favourite (via the issue FK); the favourites `company_id` cascade is the
    // defensive backstop so a favourite can never block company deletion.
    const { companyId, issueId } = await seedCompanyWithIssue();
    const userId = "board-user";

    await svc.add(companyId, userId, issueId);
    await db.delete(issues).where(eq(issues.id, issueId));
    await db.delete(companies).where(eq(companies.id, companyId));

    expect(await db.select().from(issueFavourites)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
  });
});
