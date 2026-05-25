import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { weeklyReviewsApi } from "./weeklyReviews";

describe("weeklyReviewsApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
  });

  it("reads company weekly reviews from the company-scoped endpoint", async () => {
    await weeklyReviewsApi.list("company-1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/weekly-reviews");
  });

  it("reads review detail, version detail, and readiness metadata from stable endpoints", async () => {
    await weeklyReviewsApi.getReview("review-1");
    await weeklyReviewsApi.getVersion("version-1");
    await weeklyReviewsApi.getReadiness("review-1");

    expect(mockApi.get).toHaveBeenNthCalledWith(1, "/weekly-reviews/review-1");
    expect(mockApi.get).toHaveBeenNthCalledWith(2, "/weekly-review-versions/version-1");
    expect(mockApi.get).toHaveBeenNthCalledWith(3, "/weekly-reviews/review-1/readiness");
  });

  it("posts manual generation and refresh requests with ISO date payloads", async () => {
    await weeklyReviewsApi.generate("company-1", {
      periodStart: "2026-05-11T00:00:00.000Z",
      periodEnd: "2026-05-17T23:59:59.000Z",
    });
    await weeklyReviewsApi.refresh("review-1");

    expect(mockApi.post).toHaveBeenNthCalledWith(1, "/companies/company-1/weekly-reviews/generate", {
      periodStart: "2026-05-11T00:00:00.000Z",
      periodEnd: "2026-05-17T23:59:59.000Z",
    });
    expect(mockApi.post).toHaveBeenNthCalledWith(2, "/weekly-reviews/review-1/refresh", {});
  });

  it("posts recommendation governance actions to the recommendation-scoped endpoint", async () => {
    await weeklyReviewsApi.createRecommendationAction("recommendation-1", {
      actionKind: "create_followup_issue",
      title: "Assign support handoff owner",
      priority: "high",
    });

    expect(mockApi.post).toHaveBeenCalledWith("/weekly-review-recommendations/recommendation-1/actions", {
      actionKind: "create_followup_issue",
      title: "Assign support handoff owner",
      priority: "high",
    });
  });
});
