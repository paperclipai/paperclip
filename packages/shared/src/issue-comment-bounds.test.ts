import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ISSUE_COMMENT_PAGE_MAX_LIMIT,
  ISSUE_COMMENT_REORDER_IDS_LIMIT,
} from "./index.js";

const serverSource = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../server/src/${relative}`, import.meta.url)),
    "utf8",
  );

describe("issue comment bounds are single-sourced", () => {
  it("exports the page cap from the package root", () => {
    // The point of the constant living here is that a caller can discover it.
    // Importing from `./index.js` rather than `./constants.js` is deliberate:
    // the root is the surface other packages (and the OpenAPI document) read.
    expect(ISSUE_COMMENT_PAGE_MAX_LIMIT).toBe(500);
  });

  it("no longer leaves a module-private page cap in the route or the service", () => {
    // These were two private `500` literals applied in series — the route
    // clamped, then the service clamped the same request again — so nothing
    // published could derive the bound and the two could drift apart in
    // silence. A grep is the right shape here: the property is the ABSENCE of
    // a second declaration, which no runtime assertion can observe.
    for (const file of ["routes/issues.ts", "services/issues.ts"]) {
      const source = serverSource(file);
      expect(source).not.toMatch(/const MAX_ISSUE_COMMENT(_PAGE)?_LIMIT\s*=/);
      expect(source).toContain("ISSUE_COMMENT_PAGE_MAX_LIMIT");
    }
  });

  it("keeps the reorder payload bound INDEPENDENT of the page cap", () => {
    // They share a value today and are different promises: the page cap bounds
    // one read, the reorder bound limits one mutation's request body, and a
    // client can accumulate ids across several pages. Writing
    // `ISSUE_COMMENT_REORDER_IDS_LIMIT = ISSUE_COMMENT_PAGE_MAX_LIMIT` would
    // make a future page-size change silently move a request-validation bound.
    //
    // Equal values cannot distinguish a shared binding from two declarations,
    // so this asserts on the declaration itself.
    const constants = readFileSync(
      fileURLToPath(new URL("./constants.ts", import.meta.url)),
      "utf8",
    );
    expect(constants).toMatch(/export const ISSUE_COMMENT_REORDER_IDS_LIMIT = \d+;/);
    expect(constants).not.toMatch(
      /ISSUE_COMMENT_REORDER_IDS_LIMIT\s*=\s*ISSUE_COMMENT_PAGE_MAX_LIMIT/,
    );
    expect(ISSUE_COMMENT_REORDER_IDS_LIMIT).toBe(500);
  });

  it("CONTROL: the grep above can fail — it matches a planted private cap", () => {
    // Without this, a regex that silently stopped matching would read as a
    // passing single-source guarantee for the rest of the file's life.
    const planted = "const MAX_ISSUE_COMMENT_LIMIT = 500;\n";
    expect(planted).toMatch(/const MAX_ISSUE_COMMENT(_PAGE)?_LIMIT\s*=/);
  });
});
