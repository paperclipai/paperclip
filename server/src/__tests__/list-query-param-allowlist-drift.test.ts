import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_LIST_SUPPORTED_QUERY_PARAMS,
  ISSUE_LIST_SUPPORTED_QUERY_PARAMS,
} from "../routes/query-params.js";

/**
 * The allow-lists in `query-params.ts` are what turn an unrecognized filter into
 * a 400 instead of a silently-unfiltered 200. That only holds while they match
 * the params the handlers actually read:
 *
 *  - a param read by the handler but missing from the list becomes unreachable,
 *    because the guard 400s before the handler ever sees it;
 *  - a param listed but never read is accepted and then silently does nothing —
 *    reintroducing the exact fail-open these lists exist to close.
 *
 * Neither drift direction is caught by typecheck, so assert it here by reading
 * the `req.query.<name>` accesses out of each handler body.
 */
function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function queryParamsReadBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start, `could not locate handler start: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `could not locate handler end: ${endMarker}`).toBeGreaterThan(start);

  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const match of body.matchAll(/req\.query\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  return names;
}

describe("list endpoint query-param allow-lists match their handlers", () => {
  it("issues list allow-list matches the params the handler reads", () => {
    const params = queryParamsReadBetween(
      readSource("../routes/issues.ts"),
      'router.get("/companies/:companyId/issues", async',
      'router.get("/companies/:companyId/issues/count"',
    );

    expect([...params].sort()).toEqual([...ISSUE_LIST_SUPPORTED_QUERY_PARAMS].sort());
  });

  it("approvals list allow-list matches the params the handler reads", () => {
    const params = queryParamsReadBetween(
      readSource("../routes/approvals.ts"),
      'router.get("/companies/:companyId/approvals", async',
      'router.get("/approvals/:id"',
    );

    expect([...params].sort()).toEqual([...APPROVAL_LIST_SUPPORTED_QUERY_PARAMS].sort());
  });
});
