import { describe, expect, it } from "vitest";
import {
  buildDoneEvidenceRequiredErrorResponse,
  containsGitHubCommitOrPrLink,
  issueRequiresDoneEvidence,
  resolveDoneTransitionEvidenceComment,
} from "../routes/issues.js";

describe("containsGitHubCommitOrPrLink", () => {
  it("accepts GitHub commit links", () => {
    expect(
      containsGitHubCommitOrPrLink("Implemented in https://github.com/acme/paperclip/commit/abc1234"),
    ).toBe(true);
  });

  it("accepts GitHub pull request links", () => {
    expect(
      containsGitHubCommitOrPrLink("Shipped in https://github.com/acme/paperclip/pull/42"),
    ).toBe(true);
  });

  it("rejects other GitHub URLs", () => {
    expect(
      containsGitHubCommitOrPrLink("See https://github.com/acme/paperclip/issues/99"),
    ).toBe(false);
  });
});

describe("resolveDoneTransitionEvidenceComment", () => {
  it("prefers the new transition comment when provided", () => {
    expect(
      resolveDoneTransitionEvidenceComment(
        "Done via https://github.com/acme/paperclip/pull/77",
        "Old note without links",
      ),
    ).toContain("/pull/77");
  });

  it("falls back to the latest existing comment", () => {
    expect(
      resolveDoneTransitionEvidenceComment(
        undefined,
        "Latest: https://github.com/acme/paperclip/commit/def5678",
      ),
    ).toContain("/commit/def5678");
  });

  it("returns null when no usable comment exists", () => {
    expect(resolveDoneTransitionEvidenceComment("   ", "  ")).toBeNull();
  });
});

describe("buildDoneEvidenceRequiredErrorResponse", () => {
  it("documents the closeout fallback for code and non-code work", () => {
    const payload = buildDoneEvidenceRequiredErrorResponse();
    expect(payload.error).toContain("remove the code label before closing");
    expect(payload.error).toContain("keep the issue open until traceability is available");
    expect(payload.details).toMatchObject({
      requiredLabel: "code",
      acceptedEvidence: {
        githubCommitUrl: "https://github.com/<owner>/<repo>/commit/<sha>",
        githubPullRequestUrl: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      fallback: {
        nonCode: "Remove the code label before marking done when the task did not require repository changes.",
      },
    });
  });
});

describe("issueRequiresDoneEvidence", () => {
  it("requires evidence when current labels include code", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "Code" }],
      }),
    ).toBe(true);
  });

  it("does not require evidence when current labels do not include code", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "ops" }],
      }),
    ).toBe(false);
  });

  it("matches the code label case-insensitively even with extra whitespace", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "  CODE  " }],
      }),
    ).toBe(true);
  });

  it("uses next labelIds when labels are being updated", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "1", name: "ops" }],
        nextLabelIds: ["2"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "code" },
        ],
      }),
    ).toBe(true);
  });

  it("does not require evidence when code label is removed in the same patch", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [{ id: "2", name: "code" }],
        nextLabelIds: ["1"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "code" },
        ],
      }),
    ).toBe(false);
  });
});
