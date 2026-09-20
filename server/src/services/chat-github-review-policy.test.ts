import { describe, expect, it } from "vitest";
import {
  defaultGitHubReviewPolicy,
  type GitHubChatConfiguration,
  type GitHubReviewAssessment,
  type GitHubReviewEventContext,
} from "@paperclipai/shared";
import {
  githubReviewConclusion,
  githubReviewLineIsInPatch,
  githubReviewSchedulingDecision,
  matchesGitHubReviewPattern,
  validateGitHubReviewAssessment,
} from "./chat-github-review-policy.js";

const context: GitHubReviewEventContext = {
  event: "opened",
  deliveryId: "delivery",
  repositoryId: "12",
  repository: "test/repo",
  pullNumber: 1,
  title: "Change",
  body: "",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseBranch: "master",
  author: { id: "42", login: "author", isBot: false },
  sender: { id: "42", login: "author" },
  draft: false,
  labels: [],
};

it("validates inline findings against the correct side of each diff hunk", () => {
  const patch =
    "@@ -4,3 +8,3 @@\n context\n-old\n+new\n context\n@@ -40,1 +90,1 @@\n-removed\n+added";
  expect(githubReviewLineIsInPatch(patch, 5, "LEFT")).toBe(true);
  expect(githubReviewLineIsInPatch(patch, 9, "RIGHT")).toBe(true);
  expect(githubReviewLineIsInPatch(patch, 40, "LEFT")).toBe(true);
  expect(githubReviewLineIsInPatch(patch, 90, "RIGHT")).toBe(true);
  expect(githubReviewLineIsInPatch(patch, 5, "RIGHT")).toBe(false);
  expect(githubReviewLineIsInPatch(patch, 11, "RIGHT")).toBe(false);
  expect(githubReviewLineIsInPatch(undefined, 1, "RIGHT")).toBe(false);
});
function configuration(): GitHubChatConfiguration {
  return {
    version: 1,
    toolsEnabled: true,
    responsibleUserId: "owner",
    memberAccess: "all_linked",
    people: [],
    defaults: defaultGitHubReviewPolicy(),
    repositories: {},
  };
}
function assessment(): GitHubReviewAssessment {
  return {
    reviewedCommit: context.headSha,
    score: 5,
    complete: true,
    summary: "Reviewed",
    rationale: "No defects found",
    coverage: {
      reviewedPaths: ["src/a.ts"],
      omittedPaths: [],
      limitations: [],
    },
    findings: [],
  };
}
function decide(config = configuration(), overrides = {}) {
  return githubReviewSchedulingDecision({
    configuration: config,
    context,
    repositoryEnabled: true,
    linkedMemberUserId: "owner",
    activeSponsorUserIds: new Set(["owner"]),
    manual: false,
    ...overrides,
  });
}

describe("GitHub review authorization and scheduling", () => {
  it("admits linked authors but not unlinked webhook senders", () => {
    expect(decide().allowed).toBe(true);
    expect(decide(configuration(), { linkedMemberUserId: null }).allowed).toBe(
      false,
    );
  });
  it("requires explicit per-person automatic guest permission and a live sponsor", () => {
    const config = configuration();
    config.defaults.invocation = "allowed_authors";
    config.people = [
      {
        kind: "guest",
        githubUserId: "42",
        login: "author",
        sponsorUserId: "owner",
        permissionProfile: "restricted",
        automaticReviews: false,
      },
    ];
    expect(decide(config, { linkedMemberUserId: null }).allowed).toBe(false);
    expect(
      decide(config, { linkedMemberUserId: null, manual: true }).guest,
    ).toBe(true);
    config.people[0]!.automaticReviews = true;
    expect(decide(config, { linkedMemberUserId: null }).allowed).toBe(true);
    expect(
      decide(config, {
        linkedMemberUserId: null,
        activeSponsorUserIds: new Set(),
      }).allowed,
    ).toBe(false);
  });
  it("manual requests bypass scheduling filters but never repository or actor authorization", () => {
    const config = configuration();
    config.defaults.invocation = "mentions_only";
    config.defaults.excludeAuthors = ["*"];
    config.defaults.targetBranches = ["release/*"];
    expect(
      decide(config, { manual: true, context: { ...context, draft: true } })
        .allowed,
    ).toBe(true);
    expect(
      decide(config, { manual: true, repositoryEnabled: false }).allowed,
    ).toBe(false);
    expect(
      decide(config, { manual: true, linkedMemberUserId: null }).allowed,
    ).toBe(false);
  });
  it("does not auto-enable an explicitly added member", () => {
    const config = configuration();
    config.people = [
      {
        kind: "member",
        githubUserId: "42",
        login: "author",
        userId: "owner",
        automaticReviews: false,
      },
    ];
    expect(decide(config).reason).toBe("automatic_reviews_disabled_for_person");
  });
  it("requires both an explicit sponsored account and the bot-author opt-in", () => {
    const config = configuration();
    config.defaults.invocation = "allowed_authors";
    config.people = [
      {
        kind: "guest",
        githubUserId: "42",
        login: "dependabot[bot]",
        sponsorUserId: "owner",
        permissionProfile: "restricted",
        automaticReviews: true,
      },
    ];
    const request = {
      linkedMemberUserId: null,
      context: {
        ...context,
        author: { ...context.author, login: "dependabot[bot]", isBot: true },
      },
    };
    expect(decide(config, request).reason).toBe("bot_author");
    config.defaults.reviewBotAuthors = true;
    expect(decide(config, request).allowed).toBe(true);
    config.people = [];
    expect(decide(config, request).allowed).toBe(false);
  });
  it("gates drafts, bot authors, disabled events and repository overrides", () => {
    expect(
      decide(configuration(), { context: { ...context, draft: true } }).reason,
    ).toBe("draft");
    expect(
      decide(configuration(), {
        context: { ...context, author: { ...context.author, isBot: true } },
      }).reason,
    ).toBe("bot_author");
    const config = configuration();
    config.repositories["12"] = { events: [] };
    expect(decide(config).reason).toBe("event_disabled");
  });
});
describe("GitHub score validation", () => {
  it("never accepts an agent-declared conclusion or mismatched commit", () => {
    expect(() =>
      validateGitHubReviewAssessment(
        { ...assessment(), conclusion: "success" },
        context.headSha,
        defaultGitHubReviewPolicy(),
      ),
    ).toThrow();
    expect(() =>
      validateGitHubReviewAssessment(
        assessment(),
        context.baseSha,
        defaultGitHubReviewPolicy(),
      ),
    ).toThrow();
  });
  it("returns actionable input errors rather than server failures for invalid assessment fields", () => {
    const invalid = assessment();
    invalid.coverage.limitations = ["x".repeat(257)];
    expect(() => validateGitHubReviewAssessment(invalid, context.headSha, defaultGitHubReviewPolicy()))
      .toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("coverage.limitations.0") }));
  });
  it("incomplete reviews never pass even at 5/5 or report-only", () => {
    expect(
      githubReviewConclusion({ ...assessment(), complete: false }, 5),
    ).toBe("action_required");
    expect(
      githubReviewConclusion({ ...assessment(), complete: false }, null),
    ).toBe("action_required");
    expect(githubReviewConclusion({ ...assessment(), score: 3 }, 5)).toBe(
      "failure",
    );
    expect(githubReviewConclusion(assessment(), 5)).toBe("success");
    expect(githubReviewConclusion(assessment(), null)).toBe("neutral");
  });
  it("enforces file exclusions and coverage independently of comment severity", () => {
    const policy = defaultGitHubReviewPolicy();
    policy.ignoredPaths = ["**/*.ts"];
    expect(() =>
      validateGitHubReviewAssessment(assessment(), context.headSha, policy),
    ).toThrow();
    expect(() =>
      validateGitHubReviewAssessment(
        {
          ...assessment(),
          coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] },
        },
        context.headSha,
        policy,
      ),
    ).toThrow();
  });
  it("matches simple branch/path globs literally and supports root and nested paths", () => {
    expect(matchesGitHubReviewPattern("a.ts", "**/*.ts")).toBe(true);
    expect(matchesGitHubReviewPattern("src/a.ts", "**/*.ts")).toBe(true);
    expect(matchesGitHubReviewPattern("src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGitHubReviewPattern("aXts", "a.ts")).toBe(false);
  });
});
