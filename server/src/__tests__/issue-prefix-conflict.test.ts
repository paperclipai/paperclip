import { describe, expect, it } from "vitest";
import { isIssuePrefixConflict } from "../services/companies.js";

describe("isIssuePrefixConflict", () => {
  it("recognises a bare postgres-js error (no wrapping)", () => {
    const err = {
      name: "PostgresError",
      code: "23505",
      constraint: "companies_issue_prefix_idx",
      severity: "ERROR",
      message: "duplicate key value violates unique constraint",
    };
    expect(isIssuePrefixConflict(err)).toBe(true);
  });

  it("recognises the same error after drizzle-orm wraps it in DrizzleQueryError", () => {
    // Shape produced by drizzle-orm/postgres-js when an INSERT fails on a
    // unique constraint: the underlying postgres error is nested at `cause`.
    const err = {
      name: "DrizzleQueryError",
      message: 'Failed query: insert into "companies" ...',
      cause: {
        name: "PostgresError",
        code: "23505",
        constraint: "companies_issue_prefix_idx",
        severity: "ERROR",
      },
    };
    expect(isIssuePrefixConflict(err)).toBe(true);
  });

  it("recognises deeper nesting via the cause chain", () => {
    const err = {
      name: "OuterWrapper",
      cause: {
        name: "InnerWrapper",
        cause: {
          code: "23505",
          constraint: "companies_issue_prefix_idx",
        },
      },
    };
    expect(isIssuePrefixConflict(err)).toBe(true);
  });

  it("accepts the alternative `constraint_name` field used by some drivers", () => {
    const err = { code: "23505", constraint_name: "companies_issue_prefix_idx" };
    expect(isIssuePrefixConflict(err)).toBe(true);
  });

  it("returns false for a different unique-constraint violation", () => {
    const err = {
      cause: { code: "23505", constraint: "companies_name_idx" },
    };
    expect(isIssuePrefixConflict(err)).toBe(false);
  });

  it("returns false for a non-conflict postgres error", () => {
    const err = { cause: { code: "23502", constraint: "companies_issue_prefix_idx" } };
    expect(isIssuePrefixConflict(err)).toBe(false);
  });

  it("returns false for null / undefined / primitives", () => {
    expect(isIssuePrefixConflict(null)).toBe(false);
    expect(isIssuePrefixConflict(undefined)).toBe(false);
    expect(isIssuePrefixConflict("23505")).toBe(false);
    expect(isIssuePrefixConflict(23505)).toBe(false);
  });

  it("terminates promptly on a circular cause graph (depth-cap regression)", () => {
    // Construct a cycle a → b → a. A naive while(cause) traversal would spin
    // forever. The MAX_DEPTH guard must short-circuit and return false.
    const a: Record<string, unknown> = { code: "OTHER", constraint: "irrelevant" };
    const b: Record<string, unknown> = { code: "OTHER", constraint: "irrelevant" };
    a.cause = b;
    b.cause = a;
    const start = Date.now();
    expect(isIssuePrefixConflict(a)).toBe(false);
    // Sanity: a hung loop would never return; assert this finished quickly.
    expect(Date.now() - start).toBeLessThan(100);
  });
});
