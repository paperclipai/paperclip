// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { IssueRetryNowOutcome, IssueScheduledRetry } from "@paperclipai/shared";
import { IssueBlockedNotice } from "./IssueBlockedNotice";
import { ToastProvider } from "../context/ToastContext";

const retryNowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    retryScheduledRetryNow: retryNowMock,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as unknown as PromiseLike<unknown>;
  if (result && typeof maybePromise.then === "function") {
    throw new TypeError("This test act shim only supports synchronous callbacks.");
  }
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

const SYSTEM_NOW = new Date("2026-04-18T20:00:00.000Z").getTime();

const baseRetry: IssueScheduledRetry = {
  runId: "retry-run-1",
  status: "scheduled_retry",
  agentId: "agent-1",
  agentName: "CodexCoder",
  retryOfRunId: "source-run-1",
  scheduledRetryAt: "2026-04-19T20:00:00.000Z",
  scheduledRetryAttempt: 1,
  scheduledRetryReason: "max_turns_continuation",
  retryExhaustedReason: null,
  error: null,
  errorCode: null,
};

function buildRetryResponse(outcome: IssueRetryNowOutcome) {
  return {
    outcome,
    message:
      outcome === "promoted"
        ? "Promoted scheduled retry"
        : outcome === "already_promoted"
          ? "Scheduled retry already promoted"
          : outcome === "no_scheduled_retry"
            ? "No scheduled retry"
            : "Promotion suppressed by gate",
    scheduledRetry:
      outcome === "promoted" || outcome === "already_promoted"
        ? { ...baseRetry, status: "queued" as const }
        : null,
  };
}

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(SYSTEM_NOW);
  retryNowMock.mockReset();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
});

function withProviders(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(withProviders(element)));
  return container;
}

describe("IssueBlockedNotice", () => {
  it("renders a successful-run next-step notice without requiring blockers", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="in_progress"
        blockers={[]}
        agentName="CodexCoder"
        successfulRunHandoff={{
          state: "required",
          required: true,
          sourceRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
          correctiveRunId: null,
          assigneeAgentId: "agent-1",
          detectedProgressSummary: "Updated the plan and left follow-up work.",
          createdAt: "2026-05-01T00:00:00.000Z",
        }}
      />,
    );

    expect(node.textContent).toContain("This task still needs a next step.");
    expect(node.textContent).toContain("Corrective wake queued for CodexCoder");
    expect(node.textContent).toContain("Detected progress: Updated the plan");
    expect(node.textContent).not.toContain("Retry now");
    expect(node.textContent).not.toContain("Work on this task is blocked until");
    expect(node.querySelector('[data-successful-run-handoff="required"]')).not.toBeNull();
  });

  it("shows retry-now action for next-step notices with a scheduled retry", async () => {
    retryNowMock.mockResolvedValue(buildRetryResponse("promoted"));
    const node = render(
      <IssueBlockedNotice
        issueId="issue-1"
        issueStatus="in_progress"
        blockers={[]}
        agentName="CodexCoder"
        scheduledRetry={baseRetry}
        successfulRunHandoff={{
          state: "required",
          required: true,
          sourceRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
          correctiveRunId: null,
          assigneeAgentId: "agent-1",
          detectedProgressSummary: null,
          createdAt: "2026-05-01T00:00:00.000Z",
        }}
      />,
    );

    expect(node.textContent).toContain("Corrective wake scheduled in 1d");
    const button = node.querySelector<HTMLButtonElement>('[data-testid="issue-next-step-retry-now"]');
    expect(button).not.toBeNull();
    expect(button!.textContent ?? "").toContain("Retry now");

    act(() => {
      button!.click();
    });

    await vi.waitFor(() => {
      expect(retryNowMock).toHaveBeenCalledWith("issue-1");
      expect(button!.textContent ?? "").toContain("Promoted");
      expect(button!.disabled).toBe(true);
    });
  });

  it("does not render when the issue is done even if a stale handoff state is required", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="done"
        blockers={[]}
        agentName="CodexCoder"
        successfulRunHandoff={{
          state: "required",
          required: true,
          sourceRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
          correctiveRunId: null,
          assigneeAgentId: "agent-1",
          detectedProgressSummary: "Updated the plan and left follow-up work.",
          createdAt: "2026-05-01T00:00:00.000Z",
        }}
      />,
    );

    expect(node.textContent).toBe("");
  });

  it("does not render when the issue is cancelled even if blockers remain", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="cancelled"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-123",
            title: "Blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(node.textContent).toBe("");
  });

  it("renders a recovery indicator on a blocker chip when the blocker has an active recovery action", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-123",
            title: "Build still red",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            activeRecoveryAction: {
              id: "rec-1",
              companyId: "co-1",
              sourceIssueId: "blocker-1",
              recoveryIssueId: null,
              kind: "missing_disposition",
              status: "active",
              ownerType: "agent",
              ownerAgentId: "agent-cto",
              ownerUserId: null,
              previousOwnerAgentId: null,
              returnOwnerAgentId: null,
              cause: "successful_run_missing_state",
              fingerprint: "fp-1",
              evidence: {},
              nextAction: "choose disposition",
              wakePolicy: { type: "wake_owner" },
              monitorPolicy: null,
              attemptCount: 1,
              maxAttempts: 3,
              timeoutAt: null,
              lastAttemptAt: null,
              outcome: null,
              resolutionNote: null,
              resolvedAt: null,
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
        ]}
      />,
    );

    const indicator = node.querySelector(
      '[data-testid="issue-blocked-notice-recovery-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("data-recovery-state")).toBe("needed");
    expect(indicator?.getAttribute("data-recovery-kind")).toBe("missing_disposition");
    expect(indicator?.textContent).toContain("Recovery needed");
  });

  it("labels a workspace_validation blocker recovery distinctly", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[
          {
            id: "blocker-2",
            identifier: "PAP-409",
            title: "Workspace cwd lost git context",
            status: "blocked",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            activeRecoveryAction: {
              id: "rec-2",
              companyId: "co-1",
              sourceIssueId: "blocker-2",
              recoveryIssueId: null,
              kind: "workspace_validation",
              status: "active",
              ownerType: "agent",
              ownerAgentId: "agent-cto",
              ownerUserId: null,
              previousOwnerAgentId: null,
              returnOwnerAgentId: null,
              cause: "workspace_validation_failed",
              fingerprint: "fp-2",
              evidence: {
                latestRunErrorCode: "workspace_validation_failed",
              },
              nextAction:
                "Repair the source issue workspace link, project workspace cwd, or git checkout before resuming adapter execution.",
              wakePolicy: { type: "wake_owner" },
              monitorPolicy: null,
              attemptCount: 1,
              maxAttempts: 3,
              timeoutAt: null,
              lastAttemptAt: null,
              outcome: null,
              resolutionNote: null,
              resolvedAt: null,
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
        ]}
      />,
    );

    const indicator = node.querySelector(
      '[data-testid="issue-blocked-notice-recovery-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("data-recovery-state")).toBe("needed");
    expect(indicator?.getAttribute("data-recovery-kind")).toBe("workspace_validation");
    expect(indicator?.textContent).toContain("Workspace recovery needed");
  });
});
