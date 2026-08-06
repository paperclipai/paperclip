import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval list filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `approvalService.list` is the server-side half of Approval Hygiene Rule 1
 * ("one open approval per artifact"). Rule 2 mandates `payload.dedupKey` so a
 * dedup guard can key on it — but the filter did not exist, so `?dedupKey=`
 * returned every approval in the company and a caller checking for duplicates
 * got a non-empty answer either way.
 */
describeEmbeddedPostgres("approvalService.list filters", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-list-filters-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedApproval(
    companyId: string,
    payload: Record<string, unknown>,
    overrides: { status?: string; createdAt?: Date } = {},
  ) {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "generic",
      status: overrides.status ?? "pending",
      payload,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    });
    return id;
  }

  it("returns only exact dedupKey matches", async () => {
    const companyId = await seedCompany();
    const svc = approvalService(db);
    const wanted = await seedApproval(companyId, { dedupKey: "issue:BLU-1234" });
    await seedApproval(companyId, { dedupKey: "issue:BLU-9999" });
    await seedApproval(companyId, { dedupKey: "issue:BLU-1234-extra" });
    await seedApproval(companyId, { title: "no dedup key at all" });

    const rows = await svc.list(companyId, { dedupKey: "issue:BLU-1234" });

    expect(rows.map((row) => row.id)).toEqual([wanted]);
  });

  // The DoD assertion: a nonsense filter value yields 0 rows, not the full set.
  it("returns 0 rows for a nonsense dedupKey rather than everything", async () => {
    const companyId = await seedCompany();
    const svc = approvalService(db);
    await seedApproval(companyId, { dedupKey: "issue:BLU-1234" });
    await seedApproval(companyId, { dedupKey: "issue:BLU-9999" });

    expect(await svc.list(companyId, { dedupKey: "zzzznonsense" })).toHaveLength(0);
    // ...and the unfiltered call still sees both, proving the rows were there.
    expect(await svc.list(companyId)).toHaveLength(2);
  });

  it("surfaces a duplicated dedupKey — the case Approval Hygiene Rule 1 exists to catch", async () => {
    const companyId = await seedCompany();
    const svc = approvalService(db);
    await seedApproval(companyId, { dedupKey: "postiz:BLU-26634:2026-08-14" });
    await seedApproval(companyId, { dedupKey: "postiz:BLU-26634:2026-08-14" });

    const rows = await svc.list(companyId, {
      status: "pending",
      dedupKey: "postiz:BLU-26634:2026-08-14",
    });

    expect(rows).toHaveLength(2);
  });

  it("combines dedupKey with status", async () => {
    const companyId = await seedCompany();
    const svc = approvalService(db);
    const pendingId = await seedApproval(companyId, { dedupKey: "shared" }, { status: "pending" });
    await seedApproval(companyId, { dedupKey: "shared" }, { status: "approved" });

    const rows = await svc.list(companyId, { status: "pending", dedupKey: "shared" });

    expect(rows.map((row) => row.id)).toEqual([pendingId]);
  });

  it("scopes dedupKey matches to the requesting company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const svc = approvalService(db);
    const mine = await seedApproval(companyA, { dedupKey: "shared" });
    await seedApproval(companyB, { dedupKey: "shared" });

    const rows = await svc.list(companyA, { dedupKey: "shared" });

    expect(rows.map((row) => row.id)).toEqual([mine]);
  });

  describe("pagination", () => {
    async function seedThree(companyId: string) {
      const oldest = await seedApproval(companyId, { n: 1 }, { createdAt: new Date("2026-08-01T00:00:00Z") });
      const middle = await seedApproval(companyId, { n: 2 }, { createdAt: new Date("2026-08-02T00:00:00Z") });
      const newest = await seedApproval(companyId, { n: 3 }, { createdAt: new Date("2026-08-03T00:00:00Z") });
      return { oldest, middle, newest };
    }

    it("returns the full set when limit is omitted", async () => {
      const companyId = await seedCompany();
      const svc = approvalService(db);
      await seedThree(companyId);

      // Three UI consumers (list page, inbox feed, sidebar badge) count over the
      // whole array, so an unrequested default page size would silently
      // under-report them.
      expect(await svc.list(companyId)).toHaveLength(3);
    });

    it("honours limit and offset over a stable newest-first order", async () => {
      const companyId = await seedCompany();
      const svc = approvalService(db);
      const { oldest, middle, newest } = await seedThree(companyId);

      expect((await svc.list(companyId, { limit: 2 })).map((r) => r.id)).toEqual([newest, middle]);
      expect((await svc.list(companyId, { limit: 2, offset: 2 })).map((r) => r.id)).toEqual([oldest]);
      // Distinct pages: the bug report's "page 1 re-fetched N times" inflation.
      expect((await svc.list(companyId, { limit: 1, offset: 1 })).map((r) => r.id)).toEqual([middle]);
    });
  });
});
