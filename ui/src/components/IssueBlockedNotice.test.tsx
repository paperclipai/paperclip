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

  it("keeps the amber notice when a covered chain has no confirmed live blocker", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        liveIssueIds={new Set(["unrelated-live"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-1",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-1",
            identifier: "TASK-1",
            title: "Dependency work",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
        allBlockers={[
          {
            id: "blocker-1",
            identifier: "TASK-1",
            title: "Dependency work",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(node.querySelector('[data-testid="issue-blocked-notice-live"]')).toBeNull();
    // Rule C: a `blocked` issue with an unresolved blocker explains that a
    // human message will not reopen it yet.
    expect(node.textContent).toContain("A message won’t move this back to todo yet");
    expect(node.querySelector('[data-blocker-attention-state="covered"]')).not.toBeNull();
  });

  it("sorts same-status live-work steps with numeric identifier ordering", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        liveIssueIds={new Set(["blocker-11"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 3,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-11",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-11",
            identifier: "TASK-11",
            title: "Running work",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
        allBlockers={[
          {
            id: "blocker-10",
            identifier: "TASK-10",
            title: "Tenth done step",
            status: "done",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
          {
            id: "blocker-9",
            identifier: "TASK-9",
            title: "Ninth done step",
            status: "done",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
          {
            id: "blocker-11",
            identifier: "TASK-11",
            title: "Running work",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    const stepLinks = Array.from(
      node.querySelectorAll('[data-testid="issue-blocked-notice-steps"] a'),
    ).map((link) => link.textContent ?? "");

    expect(stepLinks[0]).toContain("TASK-9");
    expect(stepLinks[1]).toContain("TASK-10");
    expect(stepLinks[2]).toContain("TASK-11");

    const runningStep = node.querySelectorAll('[data-testid="issue-blocked-notice-steps"] a')[2];
    if (!runningStep) throw new Error("Expected a running live-work step.");
    expect(runningStep.querySelector('svg[aria-label="In Progress status"]')).not.toBeNull();
    expect(node.querySelector('[data-testid="issue-blocked-notice-now-running"]')).toBeNull();
  });

  it("explains a human message won't reopen a blocked issue and names the unresolved leaf (Rule C)", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-500",
            title: "Server work in flight",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(node.textContent).toContain("A message won’t move this back to todo yet");
    expect(node.textContent).toContain("Comments still wake CodexCoder");
    const suppressed = node.querySelector('[data-testid="issue-blocked-notice-reopen-suppressed"]');
    expect(suppressed).not.toBeNull();
    expect(suppressed!.textContent).toContain("Still blocked by");
    expect(suppressed!.textContent).toContain("PAP-500");
    expect(suppressed!.textContent).toContain("(in progress)");
    expect(suppressed!.textContent).not.toContain("other task");
  });

  it("names the deepest unresolved terminal leaf, not the direct blocker (Rule C)", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-600",
            title: "Waiting in review",
            status: "in_review",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
            terminalBlockers: [
              {
                id: "terminal-1",
                identifier: "PAP-777",
                title: "Actual work",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: "agent-2",
                assigneeUserId: null,
              },
            ],
          },
        ]}
      />,
    );

    const suppressed = node.querySelector('[data-testid="issue-blocked-notice-reopen-suppressed"]');
    expect(suppressed).not.toBeNull();
    expect(suppressed!.textContent).toContain("PAP-777");
    expect(suppressed!.textContent).toContain("(in progress)");
    expect(suppressed!.textContent).not.toContain("PAP-600");
  });

  it("summarizes the count when several blockers keep a comment from reopening (Rule C)", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-501",
            title: "First",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
          {
            id: "blocker-2",
            identifier: "PAP-502",
            title: "Second",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    const suppressed = node.querySelector('[data-testid="issue-blocked-notice-reopen-suppressed"]');
    expect(suppressed).not.toBeNull();
    expect(suppressed!.textContent).toContain("and 1 other task");
  });

  it("does not claim a message won't reopen when a blocked issue has no unresolved blockers (Rule B path)", () => {
    const node = render(<IssueBlockedNotice issueStatus="blocked" blockers={[]} />);

    expect(node.textContent).toContain("Work on this task is blocked until it is moved back to todo");
    expect(node.textContent).not.toContain("A message won’t move this back to todo yet");
    expect(node.querySelector('[data-testid="issue-blocked-notice-reopen-suppressed"]')).toBeNull();
  });

  it("shows external now-running blockers beneath the label on a separate line", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="blocked"
        liveIssueIds={new Set(["terminal-live"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-99",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-1",
            identifier: "TASK-1",
            title: "Queued dependency",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
            terminalBlockers: [
              {
                id: "terminal-live",
                identifier: "TASK-99",
                title: "External running task",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
              },
            ],
          },
        ]}
        allBlockers={[
          {
            id: "blocker-1",
            identifier: "TASK-1",
            title: "Queued dependency",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    const nowRunning = node.querySelector('[data-testid="issue-blocked-notice-now-running"]');
    expect(nowRunning).not.toBeNull();
    expect(nowRunning!.children[0]?.textContent?.trim()).toBe("Now running");
    expect(nowRunning!.children[1]?.querySelector("a")?.textContent).toContain("TASK-99");
    const stepText = node.querySelector('[data-testid="issue-blocked-notice-steps"]')?.textContent;
    expect(stepText).not.toContain("TASK-99");
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
