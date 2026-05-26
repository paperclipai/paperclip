// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeeklyReview } from "./WeeklyReview";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockWeeklyReviewsApi = vi.hoisted(() => ({
  list: vi.fn(),
  getReview: vi.fn(),
  getReadiness: vi.fn(),
  generate: vi.fn(),
  refresh: vi.fn(),
  createRecommendationAction: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Northstar Labs", issuePrefix: "NSR", status: "active" },
    companies: [{ id: "company-1", name: "Northstar Labs", issuePrefix: "NSR", status: "active" }],
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/weeklyReviews", () => ({
  weeklyReviewsApi: mockWeeklyReviewsApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function latestReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    companyId: "company-1",
    periodStart: "2026-05-11T00:00:00.000Z",
    periodEnd: "2026-05-17T23:59:59.000Z",
    status: "ready",
    latestVersionId: "version-1",
    createdByUserId: null,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:10:00.000Z",
    ...overrides,
  };
}

function readyPayload(overrides: Record<string, unknown> = {}) {
  return {
    review: latestReview(),
    latestVersion: {
      id: "version-1",
      reviewId: "review-1",
      companyId: "company-1",
      versionNumber: 2,
      status: "ready",
      generatedAt: "2026-05-18T12:10:00.000Z",
      generatedByUserId: null,
      sourceWindowStart: "2026-05-11T00:00:00.000Z",
      sourceWindowEnd: "2026-05-17T23:59:59.000Z",
      summaryJson: { findingCounts: { decision_blocker: 1, action_required: 1, win_context: 1 } },
      validationJson: { valid: true, errors: [] },
      narrationStatus: "not_requested",
      narrationText: null,
      createdAt: "2026-05-18T12:10:00.000Z",
      updatedAt: "2026-05-18T12:10:00.000Z",
    },
    findings: [
      {
        id: "finding-1",
        reviewId: "review-1",
        versionId: "version-1",
        companyId: "company-1",
        stableId: "NSR-F01",
        category: "decision_blocker",
        severity: "critical",
        status: "open",
        title: "Pilot rollout blocked by unowned support handoff",
        summary: "CEO approval should wait until Support/Ops owns the handoff.",
        workstream: "Support Operations",
        evidenceIdsJson: ["issue-support"],
        recommendedActionJson: { type: "assign_owner", label: "Assign owner" },
        recommendationText: "Assign the Support/Ops Lead before rollout.",
        reasonCode: "unowned_support_handoff",
        sourceEntityType: "issue",
        sourceEntityId: "issue-support",
        confidence: "high",
        detectedAt: "2026-05-18T12:00:00.000Z",
        validationStatus: "valid",
        rulesTriggeredJson: ["blocked_unowned_work"],
        actorId: null,
        uiCtaJson: null,
        metadataJson: null,
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
      },
      {
        id: "finding-2",
        reviewId: "review-1",
        versionId: "version-1",
        companyId: "company-1",
        stableId: "NSR-F02",
        category: "action_required",
        severity: "high",
        status: "open",
        title: "Limited pilot rollout approval is pending",
        summary: "The prototype is complete and needs CEO approval.",
        workstream: "Product Delivery",
        evidenceIdsJson: ["approval-pilot"],
        recommendedActionJson: { type: "approve", label: "Review approval" },
        recommendationText: "Approve the limited pilot rollout.",
        reasonCode: "approval_pending",
        sourceEntityType: "approval",
        sourceEntityId: "approval-pilot",
        confidence: "high",
        detectedAt: "2026-05-18T12:00:00.000Z",
        validationStatus: "valid",
        rulesTriggeredJson: ["pending_approval"],
        actorId: null,
        uiCtaJson: null,
        metadataJson: null,
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
      },
      {
        id: "finding-3",
        reviewId: "review-1",
        versionId: "version-1",
        companyId: "company-1",
        stableId: "NSR-F08",
        category: "win_context",
        severity: "low",
        status: "open",
        title: "Inbox digest prototype shipped with cited evidence",
        summary: "The team completed a cited prototype during the period.",
        workstream: "Product Delivery",
        evidenceIdsJson: ["run-success"],
        recommendedActionJson: null,
        recommendationText: null,
        reasonCode: "completed_cited_work",
        sourceEntityType: "heartbeat_run",
        sourceEntityId: "run-success",
        confidence: "high",
        detectedAt: "2026-05-18T12:00:00.000Z",
        validationStatus: "valid",
        rulesTriggeredJson: ["completed_work"],
        actorId: null,
        uiCtaJson: null,
        metadataJson: null,
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
      },
    ],
    citations: [
      {
        id: "citation-1",
        reviewId: "review-1",
        versionId: "version-1",
        findingId: "finding-1",
        companyId: "company-1",
        citationType: "issue",
        entityType: "issue",
        entityId: "issue-support",
        field: "status",
        label: "Support handoff issue",
        excerpt: "Owner is missing for support handoff.",
        metadataJson: {},
        createdAt: "2026-05-18T12:00:00.000Z",
      },
    ],
    recommendations: [
      {
        id: "recommendation-1",
        reviewId: "review-1",
        versionId: "version-1",
        findingId: "finding-1",
        companyId: "company-1",
        kind: "assign_owner",
        severity: "critical",
        state: "open",
        title: "Assign support handoff owner",
        rationale: "The rollout needs an accountable support owner.",
        proposedActionJson: { kind: "assign_owner" },
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
      },
      {
        id: "recommendation-2",
        reviewId: "review-1",
        versionId: "version-1",
        findingId: "finding-2",
        companyId: "company-1",
        kind: "model_profile_fallback",
        severity: "high",
        state: "open",
        title: "Request cheap model fallback approval",
        rationale: "The agent can switch profiles only after operator approval.",
        proposedActionJson: { requestedModelProfile: "cheap" },
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
      },
    ],
    actions: [
      {
        id: "action-1",
        reviewId: "review-1",
        versionId: "version-1",
        findingId: "finding-1",
        recommendationId: "recommendation-1",
        companyId: "company-1",
        actionKind: "accept_recommendation",
        status: "completed",
        requestedByUserId: null,
        targetEntityType: "weekly_review_recommendation",
        targetEntityId: "recommendation-1",
        requestJson: { note: "Approved for limited rollout." },
        resultJson: { recommendationState: "accepted" },
        activityLogId: "activity-1",
        createdAt: "2026-05-18T12:15:00.000Z",
        updatedAt: "2026-05-18T12:15:00.000Z",
      },
    ],
    ...overrides,
  };
}

const readinessPayload = {
  reviewId: "review-1",
  versionId: "version-1",
  adapterReadiness: {
    byAdapterType: {
      claude_local: { status: "ready", basicReady: true, operationalReady: true, fixtureReady: true },
      codex_local: { status: "ready", basicReady: true, operationalReady: true, fixtureReady: true },
      agy_local: { status: "ready", basicReady: true, operationalReady: true, fixtureReady: true },
    },
  },
  modelAssurance: {
    byAgent: {
      "agent-research": {
        adapterType: "agy_local",
        selectedModel: "gemini-3.5-flash",
        resolvedModel: "gemini-3.5-flash",
        modelProfile: "primary",
        policyStatus: "approved_primary",
        roleFit: "strong",
      },
    },
  },
  citationValidation: { valid: true, errors: [] },
};

describe("WeeklyReview", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function renderPage() {
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WeeklyReview />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockWeeklyReviewsApi.list.mockResolvedValue([latestReview()]);
    mockWeeklyReviewsApi.getReview.mockResolvedValue(readyPayload());
    mockWeeklyReviewsApi.getReadiness.mockResolvedValue(readinessPayload);
    mockWeeklyReviewsApi.createRecommendationAction.mockResolvedValue({
      action: {
        id: "action-2",
        reviewId: "review-1",
        versionId: "version-1",
        findingId: "finding-1",
        recommendationId: "recommendation-1",
        companyId: "company-1",
        actionKind: "dismiss_recommendation",
        status: "completed",
        requestedByUserId: null,
        targetEntityType: "weekly_review_recommendation",
        targetEntityId: "recommendation-1",
        requestJson: null,
        resultJson: { recommendationState: "dismissed" },
        activityLogId: "activity-2",
        createdAt: "2026-05-18T12:16:00.000Z",
        updatedAt: "2026-05-18T12:16:00.000Z",
      },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the latest ready review as a decision dashboard with grouped findings and citation drilldowns", async () => {
    await renderPage();

    expect(container.textContent).toContain("Weekly Review");
    expect(container.textContent).toContain("Northstar Labs");
    expect(container.textContent).toContain("Version 2");
    expect(container.textContent).toContain("Decision blockers");
    expect(container.textContent).toContain("Pilot rollout blocked by unowned support handoff");
    expect(container.textContent).toContain("Actions needed");
    expect(container.textContent).toContain("Limited pilot rollout approval is pending");
    expect(container.textContent).toContain("Wins/context");
    expect(container.textContent).toContain("Inbox digest prototype shipped with cited evidence");
    expect(container.querySelector("details")?.textContent).toContain("Support handoff issue");
    expect(container.textContent).toContain("Recommended actions");
    expect(container.textContent).toContain("Assign support handoff owner");
    expect(container.textContent).toContain("Request cheap model fallback approval");
    expect(container.textContent).toContain("Action history");
    expect(container.textContent).toContain("accept recommendation");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Weekly Review" }]);
  });

  it("lets the operator dismiss a recommendation and refreshes the review action state", async () => {
    await renderPage();

    const dismissButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Dismiss"));
    expect(dismissButton).toBeTruthy();

    await act(async () => {
      dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockWeeklyReviewsApi.createRecommendationAction).toHaveBeenCalledWith(
      "recommendation-1",
      { actionKind: "dismiss_recommendation" },
    );
    expect(mockWeeklyReviewsApi.getReview).toHaveBeenCalledTimes(2);
  });

  it("shows adapter readiness and model assurance beside the business findings", async () => {
    await renderPage();

    expect(container.textContent).toContain("Readiness");
    expect(container.textContent).toContain("claude_local");
    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("agy_local");
    expect(container.textContent).toContain("Model assurance");
    expect(container.textContent).toContain("gemini-3.5-flash");
  });

  it("shows an empty state when no review has been generated", async () => {
    mockWeeklyReviewsApi.list.mockResolvedValue([]);
    await renderPage();

    expect(container.textContent).toContain("No weekly review yet");
    expect(container.textContent).toContain("Generate a review after the Northstar fixture has source evidence.");
    expect(mockWeeklyReviewsApi.getReview).not.toHaveBeenCalled();
  });

  it("surfaces a generating review status while keeping the read path visible", async () => {
    mockWeeklyReviewsApi.list.mockResolvedValue([latestReview({ status: "generating" })]);
    mockWeeklyReviewsApi.getReview.mockResolvedValue(
      readyPayload({
        review: latestReview({ status: "generating" }),
        latestVersion: {
          ...(readyPayload().latestVersion as Record<string, unknown>),
          status: "generating",
        },
      }),
    );

    await renderPage();

    expect(container.textContent).toContain("Generating");
    expect(container.textContent).toContain("Version 2");
    expect(container.textContent).toContain("Decision blockers");
  });

  it("surfaces validation failures and evidence gaps from the latest version", async () => {
    mockWeeklyReviewsApi.getReview.mockResolvedValue(
      readyPayload({
        review: latestReview({ status: "validation_failed" }),
        latestVersion: {
          ...(readyPayload().latestVersion as Record<string, unknown>),
          status: "validation_failed",
          validationJson: {
            valid: false,
            errors: [{ code: "material_citation_missing", findingStableId: "NSR-F04" }],
            materialFindingsWithoutCitations: ["NSR-F04"],
          },
        },
      }),
    );
    mockWeeklyReviewsApi.getReadiness.mockResolvedValue({
      ...readinessPayload,
      citationValidation: {
        valid: false,
        errors: [{ code: "material_citation_missing", findingStableId: "NSR-F04" }],
        materialFindingsWithoutCitations: ["NSR-F04"],
      },
    });

    await renderPage();

    expect(container.textContent).toContain("Validation failed");
    expect(container.textContent).toContain("material_citation_missing");
    expect(container.textContent).toContain("NSR-F04");
  });
});
