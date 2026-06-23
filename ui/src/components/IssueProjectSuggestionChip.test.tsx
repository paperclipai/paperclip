// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueProjectSuggestionChip } from "./IssueProjectSuggestionChip";

const mockIssuesApi = vi.hoisted(() => ({
  getProjectSuggestions: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function suggestion(projectId: string, projectName: string, score: number) {
  return {
    projectId,
    projectName,
    score,
    matchedTerms: ["chart", "drawing"],
    reason: `Overlaps on: chart, drawing`,
  };
}

describe("IssueProjectSuggestionChip", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderChip(props: {
    onApply: (projectId: string) => void;
    isApplying?: boolean;
  }) {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProjectSuggestionChip
            issueId="issue-1"
            onApply={props.onApply}
            isApplying={props.isApplying ?? false}
          />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("offers the confident default and applies it on one click", async () => {
    mockIssuesApi.getProjectSuggestions.mockResolvedValue({
      issueId: "issue-1",
      currentProjectId: null,
      alreadyClassified: false,
      candidateProjectCount: 2,
      suggestions: [suggestion("p-charts", "Stock Charting App", 0.42), suggestion("p-bill", "Billing", 0.08)],
      topConfident: suggestion("p-charts", "Stock Charting App", 0.42),
    });
    const onApply = vi.fn();
    const root = await renderChip({ onApply });

    let applyButton!: HTMLButtonElement;
    await waitFor(() => {
      applyButton = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("분류: Stock Charting App"),
      ) as HTMLButtonElement;
      expect(applyButton).toBeTruthy();
    });

    await act(async () => {
      applyButton.click();
    });
    expect(onApply).toHaveBeenCalledWith("p-charts");

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to the plain placeholder when there is no usable signal", async () => {
    mockIssuesApi.getProjectSuggestions.mockResolvedValue({
      issueId: "issue-1",
      currentProjectId: null,
      alreadyClassified: false,
      candidateProjectCount: 0,
      suggestions: [],
      topConfident: null,
    });
    const onApply = vi.fn();
    const root = await renderChip({ onApply });

    await waitFor(() => {
      expect(container.textContent).toContain("프로젝트 없음");
    });
    expect(onApply).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an ambiguous 'suggestions' affordance when no default clears the gate", async () => {
    mockIssuesApi.getProjectSuggestions.mockResolvedValue({
      issueId: "issue-1",
      currentProjectId: null,
      alreadyClassified: false,
      candidateProjectCount: 2,
      suggestions: [suggestion("p-a", "Project A", 0.2), suggestion("p-b", "Project B", 0.19)],
      topConfident: null,
    });
    const onApply = vi.fn();
    const root = await renderChip({ onApply });

    await waitFor(() => {
      expect(container.textContent).toContain("분류 제안 2");
    });
    // No one-click default rendered when the gate isn't cleared.
    expect(container.textContent).not.toContain("분류:");

    await act(async () => {
      root.unmount();
    });
  });
});
