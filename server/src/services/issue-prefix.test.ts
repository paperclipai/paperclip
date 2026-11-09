import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ISSUE_PREFIX_FALLBACK,
  MAX_ISSUE_PREFIX_ATTEMPTS,
  deriveIssuePrefixBase,
  isIssuePrefixConflict,
  issuePrefixSuffixForAttempt,
  pickAvailableIssuePrefix,
  type IssuePrefixReadDb,
} from "./issue-prefix.js";

/**
 * Minimal select stub shaped like the one chain pickAvailableIssuePrefix uses:
 * select(...).from(companies).where(condition).then(...).
 */
function stubPrefixReadDb(takenPrefixes: string[]) {
  const conditions: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          conditions.push(condition);
          return {
            then: (resolve: (rows: unknown) => unknown) =>
              Promise.resolve(takenPrefixes.map((issuePrefix) => ({ issuePrefix }))).then(resolve),
          };
        },
      }),
    }),
  } as unknown as IssuePrefixReadDb;
  return { db, conditions };
}

describe("deriveIssuePrefixBase", () => {
  it("takes the first three letters of the name, uppercased", () => {
    expect(deriveIssuePrefixBase("Acme Robotics")).toBe("ACM");
    expect(deriveIssuePrefixBase("northwind")).toBe("NOR");
  });

  it("ignores digits, punctuation, and whitespace", () => {
    expect(deriveIssuePrefixBase("3 M-Labs")).toBe("MLA");
    expect(deriveIssuePrefixBase("  a b c d ")).toBe("ABC");
  });

  it("keeps a short name short rather than padding it", () => {
    expect(deriveIssuePrefixBase("Hi")).toBe("HI");
  });

  it("falls back when the name has no letters at all", () => {
    expect(deriveIssuePrefixBase("2026 // 42")).toBe(ISSUE_PREFIX_FALLBACK);
    expect(deriveIssuePrefixBase("")).toBe(ISSUE_PREFIX_FALLBACK);
  });

  it("never emits a LIKE metacharacter, so the base is safe to interpolate", () => {
    for (const name of ["100%", "a_b_c", "back\\slash", "何か"]) {
      expect(deriveIssuePrefixBase(name)).toMatch(/^[A-Z]{1,3}$/);
    }
  });
});

describe("issuePrefixSuffixForAttempt", () => {
  it("leaves the first attempt unsuffixed and grows by one A per retry", () => {
    expect(issuePrefixSuffixForAttempt(1)).toBe("");
    expect(issuePrefixSuffixForAttempt(2)).toBe("A");
    expect(issuePrefixSuffixForAttempt(3)).toBe("AA");
  });

  it("treats a non-positive attempt as the first attempt", () => {
    expect(issuePrefixSuffixForAttempt(0)).toBe("");
    expect(issuePrefixSuffixForAttempt(-5)).toBe("");
  });
});

describe("isIssuePrefixConflict", () => {
  it("matches the raw driver error", () => {
    expect(isIssuePrefixConflict({ code: "23505", constraint: "companies_issue_prefix_idx" })).toBe(true);
  });

  it("walks the cause chain Drizzle wraps the driver error in", () => {
    const wrapped = new Error("Failed query") as Error & { cause?: unknown };
    wrapped.cause = { code: "23505", constraint_name: "companies_issue_prefix_idx" };
    expect(isIssuePrefixConflict(wrapped)).toBe(true);
  });

  it("ignores a unique violation on a different constraint", () => {
    expect(isIssuePrefixConflict({ code: "23505", constraint: "issues_identifier_idx" })).toBe(false);
  });

  it("ignores a different error code on the same constraint", () => {
    expect(isIssuePrefixConflict({ code: "23503", constraint: "companies_issue_prefix_idx" })).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "42P01" };
    cyclic.cause = cyclic;
    expect(isIssuePrefixConflict(cyclic)).toBe(false);
  });

  it("ignores values that carry no error shape", () => {
    expect(isIssuePrefixConflict(null)).toBe(false);
    expect(isIssuePrefixConflict("23505")).toBe(false);
  });
});

describe("pickAvailableIssuePrefix", () => {
  it("returns the bare base when nothing holds it", async () => {
    const { db, conditions } = stubPrefixReadDb([]);
    await expect(pickAvailableIssuePrefix(db, "ACM")).resolves.toBe("ACM");
    // The read narrows to the base's own suffix family, not the whole table,
    // and it compares an exact head rather than a LIKE pattern, so a base is
    // never interpreted as one.
    expect(conditions).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(conditions[0] as SQL);
    expect(query.sql).toBe('left("companies"."issue_prefix", $1::int) = $2');
    expect(query.params).toEqual([3, "ACM"]);
  });

  it("compares against a base that carries LIKE metacharacters without treating it as a pattern", async () => {
    const { db, conditions } = stubPrefixReadDb([]);
    await expect(pickAvailableIssuePrefix(db, "A%_")).resolves.toBe("A%_");
    expect(new PgDialect().sqlToQuery(conditions[0] as SQL).params).toEqual([3, "A%_"]);
  });

  it("skips every prefix already taken in the same family", async () => {
    const { db } = stubPrefixReadDb(["ACM", "ACMA", "ACMB"]);
    // ACMB belongs to a different naming scheme, so it does not block ACMAA.
    await expect(pickAvailableIssuePrefix(db, "ACM")).resolves.toBe("ACMAA");
  });

  it("ignores rows from an unrelated family the pattern happened to return", async () => {
    const { db } = stubPrefixReadDb(["ACMEX"]);
    await expect(pickAvailableIssuePrefix(db, "ACM")).resolves.toBe("ACM");
  });

  it("returns null when the whole suffix space is taken", async () => {
    const exhausted = Array.from(
      { length: MAX_ISSUE_PREFIX_ATTEMPTS },
      (_, index) => `AC${"A".repeat(index)}`,
    );
    const { db } = stubPrefixReadDb(exhausted);
    await expect(pickAvailableIssuePrefix(db, "AC")).resolves.toBeNull();
  });
});
