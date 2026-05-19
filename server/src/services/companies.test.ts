import { describe, expect, it } from "vitest";
import { isIssuePrefixConflict } from "./companies.js";

// Shapes mirror what the runtime drivers actually produce:
// - drizzle-orm DrizzleQueryError sets `.cause` to the original driver error
// - postgres-js PostgresError exposes the constraint as `.constraint_name`
// - node-postgres exposes it as `.constraint`
const pgError = (over: Record<string, unknown> = {}) => ({
  code: "23505",
  constraint_name: "companies_issue_prefix_idx",
  ...over,
});
const drizzleWrap = (cause: unknown) => ({
  name: "DrizzleQueryError",
  message: "Failed query: insert into \"companies\" ...",
  cause,
});

describe("isIssuePrefixConflict", () => {
  it("detects the conflict through a drizzle cause chain (postgres-js)", () => {
    expect(isIssuePrefixConflict(drizzleWrap(pgError()))).toBe(true);
  });

  it("detects the conflict on a bare postgres error", () => {
    expect(isIssuePrefixConflict(pgError())).toBe(true);
  });

  it("accepts node-postgres style `.constraint`", () => {
    expect(
      isIssuePrefixConflict(
        drizzleWrap(pgError({ constraint_name: undefined, constraint: "companies_issue_prefix_idx" })),
      ),
    ).toBe(true);
  });

  it("walks more than one wrapper layer (bounded)", () => {
    expect(isIssuePrefixConflict(drizzleWrap(drizzleWrap(pgError())))).toBe(true);
  });

  it("does not retry a 23505 from a different constraint", () => {
    expect(
      isIssuePrefixConflict(drizzleWrap(pgError({ constraint_name: "companies_name_idx" }))),
    ).toBe(false);
  });

  it("does not match non-unique-violation errors", () => {
    expect(isIssuePrefixConflict(drizzleWrap(pgError({ code: "25P02" })))).toBe(false);
  });

  it("is safe on null, primitives, and cause-less errors", () => {
    expect(isIssuePrefixConflict(null)).toBe(false);
    expect(isIssuePrefixConflict(undefined)).toBe(false);
    expect(isIssuePrefixConflict("boom")).toBe(false);
    expect(isIssuePrefixConflict(new Error("no cause"))).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isIssuePrefixConflict(cyclic)).toBe(false);
  });
});
