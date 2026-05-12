// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutonomousLoopWatchdog,
  watchdogPreviewRefetchInterval,
  watchdogPreviewRetryDelay,
  watchdogPreviewShouldRetry,
} from "./AutonomousLoopWatchdog";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const watchdogApiMock = vi.hoisted(() => ({
  preview: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../api/autonomousLoopWatchdog", () => ({
  autonomousLoopWatchdogApi: watchdogApiMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderWatchdog(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/PAP/observability"]}>
          <Routes>
            <Route path="/:companyPrefix/observability" element={<AutonomousLoopWatchdog />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });

  return root;
}

describe("AutonomousLoopWatchdog page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    breadcrumbState.setBreadcrumbs.mockReset();
    watchdogApiMock.preview.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("backs off watchdog polling after endpoint errors", () => {
    expect(watchdogPreviewRefetchInterval({ state: { error: null } } as never)).toBe(30_000);
    expect(watchdogPreviewRefetchInterval({ state: { error: new Error("Board access required") } } as never)).toBe(false);
    expect(watchdogPreviewShouldRetry(0, new Error("transient network failure"))).toBe(true);
    expect(watchdogPreviewShouldRetry(3, new Error("transient network failure"))).toBe(false);
    expect(watchdogPreviewShouldRetry(0, new Error("Board access required"))).toBe(false);
    expect(watchdogPreviewRetryDelay(0)).toBe(1_000);
    expect(watchdogPreviewRetryDelay(6)).toBe(30_000);
  });

  it("renders read-only watchdog candidates from the preview endpoint", async () => {
    watchdogApiMock.preview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 25,
      hasMore: true,
      nextCursor: "issue-2",
      candidates: [
        {
          id: "issue-1:repair_loop_decision:ceo_loop_decision_stale",
          kind: "loop_decision_repair",
          severity: "high",
          owner: "operator",
          issueId: "issue-1",
          identifier: "PAP-581",
          title: "Autonomous loop goal",
          status: "in_progress",
          reason: "ceo_loop_decision_stale",
          recoveryAction: "repair_loop_decision",
          recommendedAction: "Review and rewrite the ceo-loop-decision document.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
        {
          id: "issue-2:manual_review:missing_ceo_loop_decision",
          kind: "manual_review",
          severity: "medium",
          owner: "operator",
          issueId: "issue-2",
          identifier: null,
          title: "Identifierless loop",
          status: "blocked",
          reason: "missing_ceo_loop_decision",
          recoveryAction: "manual_review",
          recommendedAction: "Inspect the issue and add a fresh decision document.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      expect(watchdogApiMock.preview).toHaveBeenCalledWith("company-1", { limit: 25 });
      expect(container.textContent).toContain("Autonomous loop watchdog");
      expect(container.textContent).toContain("Read-only preview");
      expect(container.textContent).toContain("25 issues scanned");
      expect(container.textContent).toContain("Autonomous loop goal");
      expect(container.textContent).toContain("PAP-581");
      expect(container.textContent).toContain("ceo_loop_decision_stale");
      expect(container.textContent).toContain("repair_loop_decision");
      expect(container.textContent).not.toContain("autonomous_loop_decision_freshness_failure");
      expect(container.textContent).not.toContain("Metric");
      expect(container.textContent).toContain("Internal repair");
      expect(container.textContent).toContain("Review and rewrite the ceo-loop-decision document.");
      expect(container.textContent).toContain("Load more watchdog candidates");
    });

    const issueLink = container.querySelector('a[href="/PAP/issues/PAP-581"]');
    expect(issueLink).not.toBeNull();
    const identifierlessIssueLink = container.querySelector('a[href="/PAP/issues/issue-2"]');
    expect(identifierlessIssueLink).not.toBeNull();
    expect(container.textContent).toContain("Identifierless loop");
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Observability" }]);

    await act(async () => root.unmount());
  });

  it("lets an operator locally snooze a watchdog candidate", async () => {
    watchdogApiMock.preview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 1,
      hasMore: false,
      nextCursor: null,
      candidates: [
        {
          id: "issue-1:repair_loop_decision:ceo_loop_decision_stale",
          kind: "loop_decision_repair",
          severity: "high",
          owner: "operator",
          issueId: "issue-1",
          identifier: "PAP-581",
          title: "Autonomous loop goal",
          status: "in_progress",
          reason: "ceo_loop_decision_stale",
          recoveryAction: "repair_loop_decision",
          recommendedAction: "Review and rewrite the ceo-loop-decision document.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("I'm on this");
      expect(container.textContent).not.toContain("Snoozed");
    });

    const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.includes("I'm on this"));
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Snoozed");
      expect(window.localStorage.getItem("paperclip:autonomous-loop-watchdog:snoozed:company-1")).toContain(
        "issue-1:repair_loop_decision:ceo_loop_decision_stale",
      );
    });

    await act(async () => root.unmount());
  });

  it("does not style unsupported critical severity as a backend-emitted critical alert", async () => {
    watchdogApiMock.preview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 1,
      hasMore: false,
      nextCursor: null,
      candidates: [
        {
          id: "issue-critical:manual_review:missing_ceo_loop_decision",
          kind: "loop_manual_review",
          severity: "critical",
          owner: "operator",
          issueId: "issue-critical",
          identifier: "PAP-999",
          title: "Unexpected critical label",
          status: "in_progress",
          reason: "missing_ceo_loop_decision",
          recoveryAction: "manual_review",
          recommendedAction: "Inspect the issue and add a fresh decision document.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      const severityBadge = Array.from(container.querySelectorAll("span")).find((element) => element.textContent === "critical");
      expect(severityBadge?.className).toContain("text-muted-foreground");
      expect(severityBadge?.className).not.toContain("text-destructive");
    });

    await act(async () => root.unmount());
  });

  it("renders a limited-window empty state without claiming all loops are clear", async () => {
    watchdogApiMock.preview.mockResolvedValue({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 25,
      hasMore: false,
      nextCursor: null,
      candidates: [],
    });

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No watchdog candidates in the latest 25 scanned open issues.");
      expect(container.textContent).not.toContain("all clear");
    });

    await act(async () => root.unmount());
  });

  it("loads additional watchdog pages with the server cursor", async () => {
    watchdogApiMock.preview
      .mockResolvedValueOnce({
        companyId: "company-1",
        mode: "preview",
        readOnly: true,
        generatedAt: "2026-05-11T10:00:00.000Z",
        totalIssuesScanned: 25,
        hasMore: true,
        nextCursor: "opaque-watchdog-cursor-1",
        candidates: [
          {
            id: "issue-1:manual_review:missing_ceo_loop_decision",
            kind: "loop_manual_review",
            severity: "medium",
            owner: "operator",
            issueId: "issue-1",
            identifier: "PAP-581",
            title: "First loop",
            status: "in_progress",
            reason: "missing_ceo_loop_decision",
            recoveryAction: "manual_review",
            recommendedAction: "Inspect the issue and add a fresh decision document.",
            userVisible: false,
            generatedAt: "2026-05-11T10:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        companyId: "company-1",
        mode: "preview",
        readOnly: true,
        generatedAt: "2026-05-11T10:01:00.000Z",
        totalIssuesScanned: 1,
        hasMore: false,
        nextCursor: null,
        candidates: [
          {
            id: "issue-2:manual_review:missing_ceo_loop_decision",
            kind: "loop_manual_review",
            severity: "medium",
            owner: "operator",
            issueId: "issue-2",
            identifier: "PAP-582",
            title: "Second loop",
            status: "in_progress",
            reason: "missing_ceo_loop_decision",
            recoveryAction: "manual_review",
            recommendedAction: "Inspect the issue and add a fresh decision document.",
            userVisible: false,
            generatedAt: "2026-05-11T10:01:00.000Z",
          },
        ],
      });

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First loop");
      expect(container.textContent).toContain("Load more watchdog candidates");
    });

    const button = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("Load more watchdog candidates"),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(watchdogApiMock.preview).toHaveBeenNthCalledWith(2, "company-1", { limit: 25, cursor: "opaque-watchdog-cursor-1" });
      expect(container.textContent).toContain("First loop");
      expect(container.textContent).toContain("Second loop");
      expect(container.textContent).not.toContain("Load more watchdog candidates");
    });

    await act(async () => root.unmount());
  });

  it("shows endpoint errors instead of silently hiding access problems", async () => {
    watchdogApiMock.preview.mockRejectedValue(new Error("Board access required"));

    const root = renderWatchdog(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Failed to load watchdog preview: Board access required");
    });

    await act(async () => root.unmount());
  });
});
