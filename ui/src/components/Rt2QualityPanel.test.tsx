// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collaboration: {
    getQualityMetrics: vi.fn(),
    getQualityTrends: vi.fn(),
    getQualityGates: vi.fn(),
  },
  jarvis: {
    getQualityReviews: vi.fn(),
    listRewriteProposals: vi.fn(),
    requestRewriteApproval: vi.fn(),
    applyApprovedWikiRewrite: vi.fn(),
    approveQualityReview: vi.fn(),
    rejectQualityReview: vi.fn(),
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../api/rt2-collaboration", () => ({
  rt2CollaborationApi: mocks.collaboration,
}));

vi.mock("../api/rt2-jarvis-runtime", () => ({
  rt2JarvisRuntimeApi: mocks.jarvis,
}));

import { Rt2QualityPanel } from "./Rt2QualityPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Rt2QualityPanel", () => {
  it("offers apply only for approved Jarvis wiki rewrite proposals", async () => {
    mocks.collaboration.getQualityMetrics.mockResolvedValue(null);
    mocks.collaboration.getQualityTrends.mockResolvedValue(null);
    mocks.collaboration.getQualityGates.mockResolvedValue({ gates: [], overallPassing: true });
    mocks.jarvis.getQualityReviews.mockResolvedValue({
      companyId: "company-1",
      items: [],
      stats: { shadow: 0, copilotPending: 0, autoApproved: 0, pendingManager: 0 },
    });
    mocks.jarvis.listRewriteProposals.mockResolvedValue({
      companyId: "company-1",
      stats: {
        total: 1,
        proposed: 0,
        approvalRequested: 0,
        approved: 1,
        applied: 0,
        rejected: 0,
        blocked: 0,
        highRisk: 0,
        providerUnavailable: 0,
        disagreement: 0,
        lowConfidence: 0,
      },
      proposals: [
        {
          id: "proposal-1",
          companyId: "company-1",
          projectId: "project-1",
          targetType: "wiki_page",
          targetId: "wiki-1",
          targetKey: "projects/project-1.md",
          title: "Project wiki update",
          status: "approved",
          riskLevel: "low",
          proposedDiff: { before: "old", after: "new", summary: "test" },
          rationale: null,
          citations: [],
          contradictionIds: [],
          approvalId: "approval-1",
          approvalRoute: "/approvals/approval-1",
          latestEval: {
            providerStatus: "not_run",
            fallbackStatus: "completed",
            disagreement: false,
            lowConfidence: false,
            finalRecommendation: "approve",
            finalConfidence: 0.9,
            reasonCodes: [],
          },
          createdBy: "board-user",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    mocks.jarvis.applyApprovedWikiRewrite.mockResolvedValue({ status: "applied" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Rt2QualityPanel companyId="company-1" projectId="project-1" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Project wiki update");
    const applyButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "적용");
    expect(applyButton).toBeDefined();

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.jarvis.applyApprovedWikiRewrite).toHaveBeenCalledWith(
      "company-1",
      "proposal-1",
      "관리자 cockpit에서 승인된 wiki draft 적용",
    );

    act(() => root.unmount());
  });
});
