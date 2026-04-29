import { describe, expect, it } from "vitest";
import {
  buildGitHubPrGatePacket,
  resolvePreviewProtectionStatus,
} from "../commands/client/issue-pr-gate.js";

describe("buildGitHubPrGatePacket", () => {
  const basePullRequest = {
    repoOwner: "Symphony-OS",
    repoName: "symphony-ai-edition",
    prNumber: 247,
    prUrl: "https://github.com/Symphony-OS/symphony-ai-edition/pull/247",
    headSha: "9db7ebf32712ed71b316669c7339d8dbca4c0031",
    isDraft: false,
    mergeable: true,
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    requiredChecks: ["Vercel", "Vercel Preview Comments"],
    passedChecks: ["Vercel", "Vercel Preview Comments"],
    failedChecks: [],
    pendingChecks: [],
    visibleReviews: [
      {
        authorLogin: "gemini-code-assist",
        state: "COMMENTED",
        submittedAt: "2026-04-29T10:16:34.033Z",
        commitOid: "76079151260cdd34b7588ebb9c4a8140642afc41",
      },
      {
        authorLogin: "MeghV",
        state: "COMMENTED",
        submittedAt: "2026-04-29T14:51:52.000Z",
        commitOid: "9db7ebf32712ed71b316669c7339d8dbca4c0031",
      },
    ],
    unresolvedReviewThreads: 0,
    viewerLogin: "MeghV",
    prAuthorLogin: "MeghV",
  };

  it("routes self-review-impossible PRs to the human-exception path", () => {
    const packet = buildGitHubPrGatePacket({
      pullRequest: basePullRequest,
      requiredReview: "non_author",
      previewProtectionStatus: "protected",
      previewSmokeStatus: "unknown",
      acceptedException: false,
    });

    expect(packet.blockedReasonCode).toBe("waiting_human_exception");
    expect(packet.externalGate.status).toBe("pending");
    expect(packet.externalGate.requiredSignal).toBe("accepted_exception");
    expect(packet.externalGate.githubPr?.currentViewerCanSatisfyReview).toBe(false);
  });

  it("records an accepted merge exception as the resolved gate outcome", () => {
    const packet = buildGitHubPrGatePacket({
      pullRequest: basePullRequest,
      requiredReview: "non_author",
      previewProtectionStatus: "protected",
      previewSmokeStatus: "unknown",
      acceptedException: true,
      exceptionNote: "Megh intentionally merged after reading the comment-only review trail.",
      capturedAt: "2026-04-29T15:57:22.423Z",
    });

    expect(packet.blockedReasonCode).toBeNull();
    expect(packet.externalGate.status).toBe("accepted_exception");
    expect(packet.externalGate.resolution).toMatchObject({
      signal: "accepted_exception",
      note: "Megh intentionally merged after reading the comment-only review trail.",
    });
  });

  it("keeps ordinary non-author review waits on the GitHub-review reason", () => {
    const packet = buildGitHubPrGatePacket({
      pullRequest: {
        ...basePullRequest,
        viewerLogin: "InternalOpsReviewer",
        prAuthorLogin: "MeghV",
      },
      requiredReview: "non_author",
      previewProtectionStatus: "open",
      previewSmokeStatus: "passed",
      acceptedException: false,
    });

    expect(packet.blockedReasonCode).toBe("waiting_github_review");
    expect(packet.externalGate.requiredSignal).toBe("github_non_author_approval");
    expect(packet.externalGate.githubPr?.currentViewerCanSatisfyReview).toBe(true);
  });
});

describe("resolvePreviewProtectionStatus", () => {
  it("classifies common preview responses without needing browser state", () => {
    expect(resolvePreviewProtectionStatus({ statusCode: 401 })).toBe("protected");
    expect(resolvePreviewProtectionStatus({ statusCode: 403 })).toBe("protected");
    expect(resolvePreviewProtectionStatus({ statusCode: 200 })).toBe("open");
    expect(resolvePreviewProtectionStatus({ statusCode: 302 })).toBe("open");
    expect(resolvePreviewProtectionStatus({ statusCode: null, error: "network timeout" })).toBe("error");
  });
});
