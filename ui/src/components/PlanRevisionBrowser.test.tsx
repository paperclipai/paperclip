// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlanDocumentRevision, PlanRevisionDiff } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanRevisionBrowser } from "./PlanRevisionBrowser";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  listPlanRevisions: vi.fn(),
  getPlanRevisionDiff: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

function createMockRevision(overrides: Partial<PlanDocumentRevision> = {}): PlanDocumentRevision {
  return {
    id: `rev-${Math.random().toString(36).slice(2, 9)}`,
    companyId: "company-1",
    documentId: "doc-1",
    issueId: "issue-1",
    key: "plan",
    format: "markdown",
    revisionNumber: overrides.revisionNumber ?? 1,
    body: "some plan body",
    title: overrides.title ?? null,
    changeSummary: overrides.changeSummary ?? null,
    planMetadata: overrides.planMetadata ?? null,
    createdAt: new Date(),
    createdByUserId: overrides.createdByUserId ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    ...overrides,
  };
}

function renderInQueryClient(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {element}
      </QueryClientProvider>,
    );
  });
  return { container, root, queryClient };
}

describe("PlanRevisionBrowser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders collapsed by default", () => {
    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" />,
    );

    expect(container.textContent).toContain("Revision history");
    expect(container.textContent).not.toContain("Loading revisions");
    expect(container.textContent).not.toContain("No revisions found");
  });

  it("shows loading state when expanded and revisions are loading", () => {
    // Never resolve the query
    mockIssuesApi.listPlanRevisions.mockReturnValue(new Promise(() => {}));

    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" initialOpen />,
    );

    // Wait for effects
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.textContent).toContain("Loading revisions");
  });

  it("shows 'No revisions found' when revisions list is empty", async () => {
    mockIssuesApi.listPlanRevisions.mockResolvedValue([]);

    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" initialOpen />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(container.textContent).toContain("No revisions found");
  });

  it("renders revisions list and loads diff for selected revision", async () => {
    const rev1 = createMockRevision({ revisionNumber: 1, changeSummary: "Initial plan" });
    const rev2 = createMockRevision({ revisionNumber: 2, changeSummary: "Updated scope" });

    mockIssuesApi.listPlanRevisions.mockResolvedValue([rev1, rev2]);
    mockIssuesApi.getPlanRevisionDiff.mockResolvedValue({
      previousRevision: rev1,
      revision: { id: rev2.id, revisionNumber: rev2.revisionNumber },
      bodyDiff: [
        { type: "added", value: "new line", oldLineNumber: undefined, newLineNumber: 1 },
        { type: "unchanged", value: "keep line", oldLineNumber: 1, newLineNumber: 2 },
        { type: "removed", value: "old line", oldLineNumber: 2, newLineNumber: undefined },
      ],
    } satisfies PlanRevisionDiff);

    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" initialOpen />,
    );

    // Wait for revisions to load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(container.textContent).toContain("rev 2");
    expect(container.textContent).toContain("rev 1");
    expect(container.textContent).toContain("Updated scope");
    expect(container.textContent).toContain("Initial plan");

    // Wait for diff to load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(container.textContent).toContain("Revision 2");
    expect(container.textContent).toContain("vs rev 1");
    expect(container.textContent).toContain("new line");
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("-");
    expect(container.textContent).toContain("1 addition");
    expect(container.textContent).toContain("1 deletion");
  });

  it("shows error state when diff fetch fails, with retry option", async () => {
    const rev1 = createMockRevision({ revisionNumber: 1 });

    mockIssuesApi.listPlanRevisions.mockResolvedValue([rev1]);

    // First call fails
    const diffError = new Error("Network error");
    mockIssuesApi.getPlanRevisionDiff.mockRejectedValueOnce(diffError);

    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" initialOpen />,
    );

    // Wait for revisions to load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Wait for diff to load and fail
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(container.textContent).toContain("Revision 1");
    expect(container.textContent).toContain("Failed to load diff");
    expect(container.textContent).toContain("Network error");
    expect(container.textContent).toContain("Retry");

    // Set up successful response for retry
    mockIssuesApi.getPlanRevisionDiff.mockResolvedValue({
      previousRevision: null,
      revision: { id: rev1.id, revisionNumber: rev1.revisionNumber },
      bodyDiff: [
        { type: "added", value: "retried content", oldLineNumber: undefined, newLineNumber: 1 },
      ],
    } satisfies PlanRevisionDiff);

    // Click retry
    const retryButton = container.querySelector("button");
    // Find the Retry button specifically (not the expansion toggle)
    const allButtons = container.querySelectorAll("button");
    const retryBtn = Array.from(allButtons).find((btn) => btn.textContent?.includes("Retry"));
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn!.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    // Now should see the diff content
    expect(container.textContent).toContain("retried content");
    expect(container.textContent).not.toContain("Failed to load diff");
  });

  it("allows selecting between revisions and loads diff for each", async () => {
    const rev1 = createMockRevision({ revisionNumber: 1, changeSummary: "v1" });
    const rev2 = createMockRevision({ revisionNumber: 2, changeSummary: "v2" });

    mockIssuesApi.listPlanRevisions.mockResolvedValue([rev1, rev2]);
    mockIssuesApi.getPlanRevisionDiff.mockResolvedValue({
      previousRevision: null,
      revision: { id: rev2.id, revisionNumber: rev2.revisionNumber },
      bodyDiff: [],
    } satisfies PlanRevisionDiff);

    const { container } = renderInQueryClient(
      <PlanRevisionBrowser issueId="issue-1" initialOpen />,
    );

    // Wait for initial load — should default to latest revision (rev2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Both revisions visible
    expect(container.textContent).toContain("rev 1");
    expect(container.textContent).toContain("rev 2");

    // Click on rev 1 to select it
    const rev1Button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("rev 1"),
    );
    expect(rev1Button).toBeTruthy();

    await act(async () => {
      rev1Button!.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    // Should show diff context for rev 1
    expect(container.textContent).toContain("Revision 1");
  });
});
