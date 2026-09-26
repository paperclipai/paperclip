import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ISSUE_LIST_QUERY_PARAMS } from "../services/issues.js";

const here = dirname(fileURLToPath(import.meta.url));
const issuesRoutePath = resolve(here, "../routes/issues.ts");

/**
 * The spec declared two parameters for `GET /api/companies/{companyId}/issues`
 * while the handler read thirty-seven. A caller authoring against the spec could
 * not find `identifier` or `assigneeAgentId`, so they guessed, and a guessed name
 * returned the whole board with status 200.
 *
 * This test fails if the documented list and the implemented list ever diverge
 * again. It reads the route source rather than calling the handler, so it needs
 * no database.
 */
describe("issue list query parameter surface", () => {
  const routeSource = readFileSync(issuesRoutePath, "utf8");

  it("declares every parameter the handler reads, and no others", () => {
    // Scope the scan to the list handler: from the last route boundary before
    // `listFilters` back to the start of that handler.
    const listFiltersIndex = routeSource.indexOf("const listFilters: IssueFilters");
    expect(listFiltersIndex, "list handler no longer builds listFilters").toBeGreaterThan(-1);

    const handlerStart = routeSource.lastIndexOf("router.get(", listFiltersIndex);
    const handler = routeSource.slice(handlerStart, listFiltersIndex + 4000);

    const read = new Set(
      [...handler.matchAll(/req\.query\.(\w+)/g)].map((match) => match[1]),
    );
    const declared = new Set(Object.keys(ISSUE_LIST_QUERY_PARAMS));

    const documentedButNotRead = [...declared].filter((name) => !read.has(name));
    const readButNotDocumented = [...read].filter((name) => !declared.has(name));

    expect(
      documentedButNotRead,
      "documented but never read by the handler — the spec is promising a filter that does nothing",
    ).toEqual([]);
    expect(
      readButNotDocumented,
      "read by the handler but absent from ISSUE_LIST_QUERY_PARAMS — the spec cannot describe it",
    ).toEqual([]);
  });

  it("documents both the exact filter and its alias", () => {
    // `key` is the name the original report used. An alias that quietly meant
    // something else would reopen the exact trap this filter closes.
    expect(Object.keys(ISSUE_LIST_QUERY_PARAMS)).toContain("identifier");
    expect(Object.keys(ISSUE_LIST_QUERY_PARAMS)).toContain("key");
  });
});
