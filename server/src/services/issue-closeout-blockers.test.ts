import { describe, expect, it } from "vitest";
import { extractRequiredBlockerIssueIdentifiers } from "./issue-closeout-blockers.js";

describe("extractRequiredBlockerIssueIdentifiers", () => {
  it("detects issue references on required blocker lines", () => {
    expect(
      extractRequiredBlockerIssueIdentifiers([
        "Done with platform changes.",
        "Remaining blocker: [DAT-5005](/DAT/issues/DAT-5005) must complete before launch.",
      ].join("\n")),
    ).toEqual(["DAT-5005"]);
  });

  it("ignores non-blocking issue references and negated blocker lines", () => {
    expect(
      extractRequiredBlockerIssueIdentifiers([
        "Related context: [DAT-5005](/DAT/issues/DAT-5005).",
        "No blockers: DAT-5006 is just background.",
        "Follow-up DAT-5007 is not a blocker.",
      ].join("\n")),
    ).toEqual([]);
  });
});
