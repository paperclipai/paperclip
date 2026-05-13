import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.ts";

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({
    ensureLocalEnvironment: vi.fn(async () => ({ id: "env-stub" })),
  }),
}));

type StoredCompany = {
  id: string;
  name: string;
  issuePrefix: string;
};

// JOE-58 regression. Drizzle wraps the underlying PostgresError in a
// DrizzleQueryError, so the previous `isIssuePrefixConflict` check (which only
// inspected the top-level `code`) never matched and the retry loop never ran.
// This test fakes an insert that throws a wrapped 23505 the first time and
// succeeds with a suffixed prefix the second time.
function makeIssuePrefixConflictError() {
  // Shape mirrors `postgres` driver errors. The fields are read by
  // `isIssuePrefixConflict` only as strings, so we don't need to import the
  // real PostgresError class.
  const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "companies_issue_prefix_idx",
    constraint_name: "companies_issue_prefix_idx",
  });
  return new DrizzleQueryError("insert into companies", [], cause);
}

function createDbStub(existing: StoredCompany[]) {
  const stored: StoredCompany[] = [...existing];
  const attemptedPrefixes: string[] = [];

  const insertValues = vi.fn(({ issuePrefix, name }: { issuePrefix: string; name: string }) => {
    attemptedPrefixes.push(issuePrefix);
    const collides = stored.some((row) => row.issuePrefix === issuePrefix);
    return {
      returning: vi.fn(async () => {
        if (collides) {
          throw makeIssuePrefixConflictError();
        }
        const row: StoredCompany = {
          id: `company-${stored.length + 1}`,
          name,
          issuePrefix,
        };
        stored.push(row);
        return [row];
      }),
    };
  });

  const insert = vi.fn(() => ({ values: insertValues }));

  // The public `create()` calls `getCompanyQuery(db).where(...).then((rows) => rows[0])`
  // after the successful insert. Return the most recently inserted row so the
  // call chain resolves to a non-null company.
  const selectChain = {
    from: vi.fn(() => selectChain),
    leftJoin: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    groupBy: vi.fn(() => selectChain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => {
      const last = stored[stored.length - 1];
      const row = last
        ? {
            ...last,
            description: null,
            status: "active",
            issueCounter: 1,
            budgetMonthlyCents: 0,
            spentMonthlyCents: 0,
            attachmentMaxBytes: null,
            requireBoardApprovalForNewAgents: false,
            feedbackDataSharingEnabled: false,
            feedbackDataSharingConsentAt: null,
            feedbackDataSharingConsentByUserId: null,
            feedbackDataSharingTermsVersion: null,
            brandColor: null,
            logoAssetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null;
      return Promise.resolve(resolve(row ? [row] : []));
    }),
  };

  const select = vi.fn(() => selectChain);

  return {
    db: { insert, select } as any,
    attemptedPrefixes,
    stored,
  };
}

describe("createCompanyWithUniquePrefix retry on issue-prefix conflict", () => {
  it("retries with a suffixed prefix when the first attempt hits a Drizzle-wrapped 23505", async () => {
    const { db, attemptedPrefixes, stored } = createDbStub([
      { id: "company-pre-existing", name: "Demo Co", issuePrefix: "DEM" },
    ]);

    const companies = companyService(db);
    const created = await companies.create({ name: "Demo Co" } as any);

    expect(attemptedPrefixes).toEqual(["DEM", "DEMA"]);
    expect(created.issuePrefix).toBe("DEMA");
    expect(stored.map((row) => row.issuePrefix)).toEqual(["DEM", "DEMA"]);
  });

  it("propagates non-prefix-conflict errors instead of retrying", async () => {
    const { db, attemptedPrefixes } = createDbStub([]);
    const unrelated = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const wrapped = new DrizzleQueryError("insert into companies", [], unrelated);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      values: vi.fn(() => ({
        returning: vi.fn(async () => {
          throw wrapped;
        }),
      })),
    });

    const companies = companyService(db);
    await expect(companies.create({ name: "Demo Co" } as any)).rejects.toBe(wrapped);
    expect(attemptedPrefixes).toEqual([]);
  });
});
