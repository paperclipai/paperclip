/**
 * Option (A) (BLO-9117) lock: the agent branch name must carry the issue
 * identifier in a form the github-webhook extractor matches, so a merged PR
 * ref-links at merge time. This guards against a future sanitizeBranchName that
 * lowercases (the extractor is uppercase-only) or a custom branchTemplate that
 * omits {{issue.identifier}}.
 */
import { describe, expect, it } from "vitest";
import { applyIssueIdentifierToBranchName } from "../services/workspace-runtime.js";
import { extractPaperclipIdentifiers } from "../services/paperclip-identifiers.js";

describe("applyIssueIdentifierToBranchName (option A)", () => {
  it("injects the identifier when a custom template omits it, extractor-matchable", () => {
    const branch = applyIssueIdentifierToBranchName("feature/some-work", "BLO-9117");
    // The whole point: the webhook extractor (uppercase-only) finds the ref.
    expect(extractPaperclipIdentifiers(branch)).toContain("BLO-9117");
    // Case is preserved — a lowercased "blo-9117" would NOT match the extractor.
    expect(branch).toContain("BLO-9117");
  });

  it("does not duplicate an identifier the template already carries", () => {
    const branch = applyIssueIdentifierToBranchName("BLO-9117-add-efficiency", "BLO-9117");
    expect(branch).toBe("BLO-9117-add-efficiency");
    expect(branch.match(/BLO-9117/g)).toHaveLength(1);
    expect(extractPaperclipIdentifiers(branch)).toContain("BLO-9117");
  });

  it("leaves the branch unchanged when there is no issue identifier", () => {
    expect(applyIssueIdentifierToBranchName("feature/some-work", null)).toBe("feature/some-work");
    expect(applyIssueIdentifierToBranchName("feature/some-work", undefined)).toBe("feature/some-work");
  });

  it("still yields an extractor-matchable branch for the default template shape", () => {
    // Mirrors the default "{{issue.identifier}}-{{slug}}" render.
    const branch = applyIssueIdentifierToBranchName("BLO-9117-run-pr-loc", "BLO-9117");
    expect(extractPaperclipIdentifiers(branch)).toContain("BLO-9117");
  });
});
