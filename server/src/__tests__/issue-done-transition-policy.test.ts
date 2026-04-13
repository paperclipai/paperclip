import { describe, expect, it } from "vitest";
import {
  buildDoneEvidenceRequiredErrorResponse,
  buildDoneEvidenceUnreachableErrorResponse,
  buildDoneEvidenceVerificationUnavailableErrorResponse,
  buildUiDoneEvidenceRequiredErrorResponse,
  containsGitHubCommitOrPrLink,
  containsPassingPlaywrightEvidence,
  issueHasImageAttachment,
  issueRequiresDoneEvidence,
  issueRequiresUiDoneEvidence,
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
    expect(payload.error).toContain("remove the code label");
    expect(payload.error).toContain("keep the issue open until traceability is available");
    expect(payload.details).toMatchObject({
      requiredLabel: "code",
      enforcedSignals: {
        codeLabel: "Issue has the 'code' label.",
        projectRepoWorkspace: "Issue belongs to a project with a repo-connected workspace (repoUrl set).",
      },
      acceptedEvidence: {
        githubCommitUrl: "https://github.com/<owner>/<repo>/commit/<sha>",
        githubPullRequestUrl: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      fallback: {
        nonCode: "Remove the code label before marking done when the task did not require repository changes.",
        projectBound:
          "If the issue is in a repo-connected project but did not change files, move it to a non-repo project or remove the project association.",
      },
    });
  });
});

describe("buildDoneEvidenceUnreachableErrorResponse", () => {
  it("includes remote verification failure details", () => {
    const payload = buildDoneEvidenceUnreachableErrorResponse(
      "Commit abc1234 not found on github.com/acme/paperclip (public repo)",
    );
    expect(payload.error).toContain("not reachable on the remote repository");
    expect(payload.error).toContain("Push the commit(s)");
    expect(payload.details.remoteVerification).toMatchObject({
      result: "unreachable",
      detail: "Commit abc1234 not found on github.com/acme/paperclip (public repo)",
      fix: "git push the branch containing the cited commit, then retry the done transition.",
    });
    // inherits base evidence details
    expect(payload.details.requiredLabel).toBe("code");
  });
});

describe("containsPassingPlaywrightEvidence", () => {
  it("accepts passed Playwright summaries", () => {
    expect(
      containsPassingPlaywrightEvidence("Validation: npx playwright test e2e/foo.spec.ts --project=chromium -> 18 passed"),
    ).toBe(true);
  });

  it("rejects mixed pass/fail Playwright summaries", () => {
    expect(
      containsPassingPlaywrightEvidence("Playwright rerun: 16 passed, 1 failed"),
    ).toBe(false);
  });

  it("rejects non-Playwright pass claims", () => {
    expect(
      containsPassingPlaywrightEvidence("Validation passed after fixing the issue"),
    ).toBe(false);
  });
});

describe("buildUiDoneEvidenceRequiredErrorResponse", () => {
  it("documents the ui closeout fallback and missing evidence state", () => {
    const payload = buildUiDoneEvidenceRequiredErrorResponse({
      hasImageAttachment: false,
      hasPassingPlaywrightEvidence: false,
    });
    expect(payload.error).toContain("ui-labeled issues");
    expect(payload.error).toContain("passing Playwright evidence");
    expect(payload.details).toMatchObject({
      requiredLabel: "ui",
      fallback: {
        nonUi: "Remove the ui label before marking done when the task did not change the UI.",
      },
      missing: {
        imageAttachment: true,
        passingPlaywrightEvidence: true,
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

  it("requires evidence when issue is in a repo-connected project workspace", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [],
        repoConnectedProjectWorkspace: true,
      }),
    ).toBe(true);
  });

  it("does not require evidence when repoConnectedProjectWorkspace is false", () => {
    expect(
      issueRequiresDoneEvidence({
        currentLabels: [],
        repoConnectedProjectWorkspace: false,
      }),
    ).toBe(false);
  });
});

describe("buildDoneEvidenceVerificationUnavailableErrorResponse", () => {
  it("includes verification-unavailable details", () => {
    const payload = buildDoneEvidenceVerificationUnavailableErrorResponse(
      "GitHub API returned 503",
    );
    expect(payload.error).toContain("could not be verified against GitHub");
    expect(payload.details.remoteVerification).toMatchObject({
      result: "verification_unavailable",
      detail: "GitHub API returned 503",
    });
    expect(payload.details.requiredLabel).toBe("code");
  });
});

describe("issueRequiresUiDoneEvidence", () => {
  it("requires evidence when current labels include ui", () => {
    expect(
      issueRequiresUiDoneEvidence({
        currentLabels: [{ id: "1", name: "UI" }],
      }),
    ).toBe(true);
  });

  it("does not require evidence when ui label is removed in the same patch", () => {
    expect(
      issueRequiresUiDoneEvidence({
        currentLabels: [{ id: "2", name: "ui" }],
        nextLabelIds: ["1"],
        companyLabels: [
          { id: "1", name: "ops" },
          { id: "2", name: "ui" },
        ],
      }),
    ).toBe(false);
  });
});

describe("issueHasImageAttachment", () => {
  it("detects image attachments", () => {
    expect(
      issueHasImageAttachment([
        { contentType: "application/pdf" },
        { contentType: "image/png" },
      ]),
    ).toBe(true);
  });

  it("ignores non-image attachments", () => {
    expect(
      issueHasImageAttachment([
        { contentType: "application/pdf" },
        { contentType: "text/plain" },
      ]),
    ).toBe(false);
  });
});
