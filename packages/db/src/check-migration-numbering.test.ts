import { describe, expect, it } from "vitest";
import { ensureJournalPrefixOrder } from "./check-migration-numbering.js";

describe("ensureJournalPrefixOrder", () => {
  it("rejects duplicate migration numeric prefixes", () => {
    expect(() =>
      ensureJournalPrefixOrder([
        "0084_approvals_source_plugin_columns",
        "0084_some_hotfix",
      ]),
    ).toThrow("Migration journal numeric order did not increase at 0084_some_hotfix");
  });
});
