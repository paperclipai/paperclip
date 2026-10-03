import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";
import { ISSUE_LIST_MAX_LIMIT } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list truncation header tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * The list returns a bare JSON array and clamps `limit` server side, so without
 * a signal on the response a caller cannot tell "the corpus is exactly `limit`
 * rows" from "the server stopped at `limit`" — every response is
 * `min(corpus, cap, requested)`, and the usual `rows.length < requested`
 * completeness check therefore passes unconditionally above the cap.
 */
describeEmbeddedPostgres("issue list truncation headers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-truncation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [
          { companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" },
        ],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithIssues(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const issueIds = Array.from({ length: count }, () => randomUUID());
    if (issueIds.length > 0) {
      await db.insert(issues).values(
        issueIds.map((id, index) => ({
          id,
          companyId,
          title: `Issue ${index}`,
          status: "todo" as const,
          priority: "medium" as const,
        })),
      );
    }
    return { companyId, issueIds };
  }

  function listIssues(companyId: string, query: Record<string, string> = {}) {
    return request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query(query);
  }

  it("reports truncation when the corpus runs past the requested page", async () => {
    const { companyId } = await seedCompanyWithIssues(4);

    const res = await listIssues(companyId, { limit: "3" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The probe row is read but never served: the body is exactly the page.
    expect(res.body).toHaveLength(3);
    expect(res.headers["x-result-truncated"]).toBe("true");
    expect(res.headers["x-result-count"]).toBe("3");
    expect(res.headers["x-result-limit"]).toBe("3");
    expect(res.headers["x-result-offset"]).toBe("0");
  });

  // The control: without this case a hard-coded `truncated: true` would pass
  // the test above, and a corpus ending exactly at the limit is precisely what
  // the silent clamp could not be distinguished from.
  it("reports no truncation when the corpus ends exactly at the requested page", async () => {
    const { companyId } = await seedCompanyWithIssues(3);

    const res = await listIssues(companyId, { limit: "3" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.headers["x-result-truncated"]).toBe("false");
    expect(res.headers["x-result-count"]).toBe("3");
  });

  it("publishes the clamped limit for an over-max request", async () => {
    const { companyId } = await seedCompanyWithIssues(2);

    const res = await listIssues(companyId, { limit: "5000" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The clamp is the defect's trigger: the caller asked for 5000, the server
    // applied 1000, and nothing in the old response said so.
    expect(res.headers["x-result-limit"]).toBe(String(ISSUE_LIST_MAX_LIMIT));
    expect(res.headers["x-result-truncated"]).toBe("false");
    expect(res.headers["x-result-count"]).toBe("2");
  });

  it("still rejects a non-positive limit, with a message that claims no bound it does not enforce", async () => {
    const { companyId } = await seedCompanyWithIssues(1);

    const res = await listIssues(companyId, { limit: "0" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit must be a positive integer");
    expect(res.body.error).toContain("clamped");
  });

  it("pages with offset and reports the applied offset", async () => {
    const { companyId, issueIds } = await seedCompanyWithIssues(5);

    const first = await listIssues(companyId, { limit: "2", offset: "0" });
    const second = await listIssues(companyId, { limit: "2", offset: "2" });
    const third = await listIssues(companyId, { limit: "2", offset: "4" });

    expect(second.headers["x-result-offset"]).toBe("2");
    expect(first.headers["x-result-truncated"]).toBe("true");
    expect(second.headers["x-result-truncated"]).toBe("true");
    expect(third.headers["x-result-truncated"]).toBe("false");
    const swept = [...first.body, ...second.body, ...third.body].map(
      (issue: { id: string }) => issue.id,
    );
    expect(new Set(swept)).toEqual(new Set(issueIds));
  });

  it("reports an empty page past the end as complete rather than truncated", async () => {
    const { companyId } = await seedCompanyWithIssues(2);

    const res = await listIssues(companyId, { limit: "2", offset: "2" });

    expect(res.body).toHaveLength(0);
    expect(res.headers["x-result-count"]).toBe("0");
    expect(res.headers["x-result-truncated"]).toBe("false");
  });

  it("carries the headers on the compact view too", async () => {
    const { companyId } = await seedCompanyWithIssues(3);

    const res = await listIssues(companyId, { limit: "2", view: "compact" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-result-truncated"]).toBe("true");
    expect(res.headers["x-result-limit"]).toBe("2");
  });

  it("omits the total rather than reporting a guess", async () => {
    // This route cannot count the corpus cheaply, so it publishes no
    // X-Total-Count at all — an absent header means "not computed", and a
    // caller must read X-Result-Truncated for completeness instead of
    // inferring a total.
    const { companyId } = await seedCompanyWithIssues(4);

    const res = await listIssues(companyId, { limit: "3" });

    expect(res.headers["x-total-count"]).toBeUndefined();
    expect(res.headers["x-result-truncated"]).toBe("true");
  });
});
