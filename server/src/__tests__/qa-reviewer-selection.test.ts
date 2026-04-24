import { describe, expect, it } from "vitest";
import { selectPooledQaReviewer } from "@paperclipai/shared";

const qaA = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "qa",
  status: "idle",
  name: "QA A",
};

const qaB = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "qa",
  status: "idle",
  name: "QA B",
};

const qaC = {
  id: "33333333-3333-4333-8333-333333333333",
  role: "qa",
  status: "running",
  name: "QA C",
};

describe("selectPooledQaReviewer", () => {
  it("reuses the sticky reviewer when still eligible", () => {
    const selection = selectPooledQaReviewer({
      reviewers: [qaA, qaB],
      stickyReviewerAgentId: qaB.id,
      preferredReviewerAgentId: qaA.id,
      openIssueCountByAgentId: new Map([
        [qaA.id, 0],
        [qaB.id, 5],
      ]),
    });

    expect(selection).toEqual({
      reviewerAgentId: qaB.id,
      reason: "sticky_reuse",
      eligibleAgentIds: [qaA.id, qaB.id],
    });
  });

  it("prefers the configured reviewer only as a tie-breaker on equal load", () => {
    const selection = selectPooledQaReviewer({
      reviewers: [qaA, qaB],
      stickyReviewerAgentId: null,
      preferredReviewerAgentId: qaB.id,
      openIssueCountByAgentId: new Map([
        [qaA.id, 2],
        [qaB.id, 2],
      ]),
    });

    expect(selection).toEqual({
      reviewerAgentId: qaB.id,
      reason: "preferred_tiebreaker",
      eligibleAgentIds: [qaA.id, qaB.id],
    });
  });

  it("does not let the preferred reviewer override a less-loaded reviewer", () => {
    const selection = selectPooledQaReviewer({
      reviewers: [qaA, qaB],
      stickyReviewerAgentId: null,
      preferredReviewerAgentId: qaB.id,
      openIssueCountByAgentId: new Map([
        [qaA.id, 1],
        [qaB.id, 3],
      ]),
    });

    expect(selection).toEqual({
      reviewerAgentId: qaA.id,
      reason: "least_loaded",
      eligibleAgentIds: [qaA.id, qaB.id],
    });
  });

  it("prefers healthier status when load is tied and no preferred reviewer wins", () => {
    const selection = selectPooledQaReviewer({
      reviewers: [qaC, qaA],
      stickyReviewerAgentId: null,
      preferredReviewerAgentId: null,
      openIssueCountByAgentId: new Map([
        [qaA.id, 1],
        [qaC.id, 1],
      ]),
    });

    expect(selection).toEqual({
      reviewerAgentId: qaA.id,
      reason: "least_loaded",
      eligibleAgentIds: [qaC.id, qaA.id],
    });
  });

  it("ignores ineligible reviewers and returns none when the pool is empty", () => {
    const selection = selectPooledQaReviewer({
      reviewers: [{ ...qaA, status: "paused" }],
      stickyReviewerAgentId: qaA.id,
      preferredReviewerAgentId: qaA.id,
      openIssueCountByAgentId: new Map([[qaA.id, 0]]),
    });

    expect(selection).toEqual({
      reviewerAgentId: null,
      reason: "none",
      eligibleAgentIds: [],
    });
  });
});
