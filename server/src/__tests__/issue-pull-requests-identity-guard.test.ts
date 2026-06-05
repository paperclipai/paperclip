/**
 * Regression guard for the operator hard-guard (2026-06-05): the run→PR join,
 * the backfill reconciler enumeration, and the rollup filter MUST key on the
 * BLO- ref, never on the PR author. Author-scoped enumeration silently drops
 * whole GitHub-identity buckets (kkroo / app/allyblockcast / app/blockcast-ci-packages)
 * — the BLO-9103 floor bug.
 *
 * This test fails if any author-login filter or author-scoped GitHub search
 * qualifier creeps into the linkage/enumeration/rollup code, or if a PR-author
 * column is added to the storage schema.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativeToServerSrc: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativeToServerSrc}`, import.meta.url)), "utf8");
}

/** Strip line and block comments so the guard only inspects executable code —
 * the design intentionally *mentions* "author" in prose ("never on PR author"). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("PR↔issue linkage is author-agnostic (regression guard)", () => {
  const linkageCode = stripComments(readSource("services/issue-pull-requests.ts"));
  const rollupCode = stripComments(readSource("services/issue-efficiency.ts"));
  const schemaCode = stripComments(readSource("../../packages/db/src/schema/issue_pull_requests.ts"));

  it("the backfill enumeration carries NO author: GitHub search qualifier", () => {
    // It must enumerate by repo over the window, not by author.
    expect(linkageCode).toContain("is:pr is:merged");
    expect(linkageCode).not.toMatch(/author:/);
  });

  it("no linkage/enumeration path reads a PR author login", () => {
    for (const code of [linkageCode, rollupCode]) {
      expect(code).not.toMatch(/\.user\b/);
      expect(code).not.toMatch(/\buser\.login\b/);
      expect(code).not.toMatch(/\bauthorLogin\b/);
      // No `author`-keyed equality/filter in code (prose lives in comments,
      // already stripped above).
      expect(code).not.toMatch(/\bpr_?author\b/i);
    }
  });

  it("the storage schema has no PR-author column", () => {
    // An author column can't be reintroduced as a filter if it never exists.
    expect(schemaCode).not.toMatch(/pr_?author/i);
    expect(schemaCode).not.toMatch(/"author"/);
    expect(schemaCode).not.toMatch(/authorLogin/);
  });
});
