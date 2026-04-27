// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue, RunLivenessState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunForIssue } from "../api/activity";
import type { ActiveRunForIssue } from "../api/heartbeats";
import { IssueRunLedgerContent } from "./IssueRunLedger";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-18T20:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  act(() => {
    root.render(ui);
  });
}

function createRun(overrides: Partial<RunForIssue> = {}): RunForIssue {
  return {
    runId: "run-00000000",
    status: "succeeded",
    agentId: "agent-1",
    adapterType: "codex_local",
    startedAt: "2026-04-18T19:58:00.000Z",
    finishedAt: "2026-04-18T19:59:00.000Z",
    createdAt: "2026-04-18T19:58:00.000Z",
    invocationSource: "assignment",
    usageJson: null,
    resultJson: null,
    livenessState: "advanced",
    livenessReason: "Run produced concrete action evidence: 2 activity event(s)",
    continuationAttempt: 0,
    lastUsefulActionAt: "2026-04-18T19:59:00.000Z",
    nextAction: null,
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Child issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-18T19:00:00.000Z"),
    updatedAt: new Date("2026-04-18T19:00:00.000Z"),
    ...overrides,
  };
}

function createActiveRun(overrides: Partial<ActiveRunForIssue> = {}): ActiveRunForIssue {
  return {
    id: "run-live-1",
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-18T19:58:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-18T19:58:00.000Z",
    agentId: "agent-1",
    agentName: "CodexCoder",
    adapterType: "codex_local",
    outputSilence: {
      lastOutputAt: "2026-04-18T19:00:00.000Z",
      lastOutputSeq: 4,
      lastOutputStream: "stdout",
      silenceStartedAt: "2026-04-18T19:30:00.000Z",
      silenceAgeMs: 45 * 60 * 1000,
      level: "critical",
      suspicionThresholdMs: 10 * 60 * 1000,
      criticalThresholdMs: 30 * 60 * 1000,
      snoozedUntil: null,
      evaluationIssueId: "issue-eval-1",
      evaluationIssueIdentifier: "PAP-404",
      evaluationIssueAssigneeAgentId: "agent-owner",
    },
    ...overrides,
  };
}

function renderLedger(props: Partial<ComponentProps<typeof IssueRunLedgerContent>> = {}) {
  render(
    <IssueRunLedgerContent
      runs={props.runs ?? []}
      liveRuns={props.liveRuns}
      activeRun={props.activeRun}
      issueStatus={props.issueStatus ?? "in_progress"}
      childIssues={props.childIssues ?? []}
      agentMap={props.agentMap ?? new Map([["agent-1", { name: "CodexCoder" }]])}
      pendingWatchdogDecision={props.pendingWatchdogDecision}
      canRecordWatchdogDecisions={props.canRecordWatchdogDecisions}
      watchdogDecisionError={props.watchdogDecisionError}
      onWatchdogDecision={props.onWatchdogDecision}
    />,
  );
}

describe("IssueRunLedger", () => {
  it("renders every liveness state with exhausted continuation context", () => {
    const states: RunLivenessState[] = [
      "advanced",
      "plan_only",
      "empty_response",
      "blocked",
      "failed",
      "completed",
      "needs_followup",
    ];

    renderLedger({
      runs: states.map((state, index) =>
        createRun({
          runId: `run-${index}0000000`,
          createdAt: `2026-04-18T19:5${index}:00.000Z`,
          livenessState: state,
          livenessReason: state === "needs_followup"
            ? "Run produced useful output but no concrete action evidence; continuation attempts exhausted"
            : `state ${state}`,
          continuationAttempt: state === "needs_followup" ? 3 : 0,
        }),
      ),
    });

    expect(container.textContent).toContain("Advanced");
    expect(container.textContent).toContain("Plan only");
    expect(container.textContent).toContain("Empty response");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("Needs follow-up");
    expect(container.textContent).toContain("Exhausted");
    expect(container.textContent).toContain("Continuation attempt 3");
  });

  it("renders historical runs without liveness metadata as unavailable", () => {
    renderLedger({
      runs: [
        createRun({
          livenessState: null,
          livenessReason: null,
          continuationAttempt: undefined,
          lastUsefulActionAt: null,
          nextAction: null,
          resultJson: null,
        }),
      ],
    });

    expect(container.textContent).toContain("No liveness data");
    expect(container.textContent).toContain("Stop Unavailable");
    expect(container.textContent).toContain("Last useful action Unavailable");
  });

  it("shows live runs as pending final checks without missing-data language", () => {
    renderLedger({
      runs: [
        createRun({
          status: "running",
          finishedAt: null,
          livenessState: null,
          livenessReason: null,
          continuationAttempt: 0,
          lastUsefulActionAt: null,
          nextAction: null,
          resultJson: null,
        }),
      ],
    });

    expect(container.textContent).toContain("Running now by CodexCoder");
    expect(container.textContent).toContain("Checks after finish");
    expect(container.textContent).toContain("Last useful action No action recorded yet");
    expect(container.textContent).toContain("Stop Still running");
    expect(container.textContent).not.toContain("Liveness pending");
    expect(container.textContent).not.toContain("initial attempt");
  });

  it("surfaces scheduled retry timing and exhaustion state without opening logs", () => {
    renderLedger({
      runs: [
        createRun({
          runId: "run-scheduled",
          status: "scheduled_retry",
          finishedAt: null,
          livenessState: null,
          livenessReason: null,
          retryOfRunId: "run-root",
          scheduledRetryAt: "2026-04-18T20:15:00.000Z",
          scheduledRetryAttempt: 2,
          scheduledRetryReason: "transient_failure",
        }),
        createRun({
          runId: "run-exhausted",
          status: "failed",
          createdAt: "2026-04-18T19:57:00.000Z",
          retryOfRunId: "run-root",
          scheduledRetryAttempt: 4,
          scheduledRetryReason: "transient_failure",
          retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        }),
      ],
    });

    expect(container.textContent).toContain("Retry scheduled");
    expect(container.textContent).toContain("Attempt 2");
    expect(container.textContent).toContain("Transient failure");
    expect(container.textContent).toContain("Next retry");
    expect(container.textContent).toContain("Retry exhausted");
    expect(container.textContent).toContain("no further automatic retry will be queued");
    expect(container.textContent).toContain("Manual intervention required");
  });

  it("shows timeout, cancel, and budget stop reasons without raw logs", () => {
    renderLedger({
      runs: [
        createRun({
          runId: "run-timeout",
          resultJson: { stopReason: "timeout", timeoutFired: true, effectiveTimeoutSec: 30 },
        }),
        createRun({
          runId: "run-cancel",
          resultJson: { stopReason: "cancelled" },
          createdAt: "2026-04-18T19:57:00.000Z",
        }),
        createRun({
          runId: "run-budget",
          resultJson: { stopReason: "budget_paused" },
          createdAt: "2026-04-18T19:56:00.000Z",
        }),
      ],
    });

    expect(container.textContent).toContain("timeout (30s timeout)");
    expect(container.textContent).toContain("cancelled");
    expect(container.textContent).toContain("budget paused");
  });

  it("surfaces active and completed child issue summaries", () => {
    renderLedger({
      childIssues: [
        createIssue({ id: "child-1", identifier: "PAP-2", title: "Implement worker handoff", status: "in_progress" }),
        createIssue({ id: "child-2", identifier: "PAP-3", title: "Verify final report", status: "done" }),
        createIssue({ id: "child-3", identifier: "PAP-4", title: "Cancelled experiment", status: "cancelled" }),
      ],
    });

    expect(container.textContent).toContain("Child work");
    expect(container.textContent).toContain("1 active, 1 done, 1 cancelled");
    expect(container.textContent).toContain("PAP-2");
    expect(container.textContent).toContain("Implement worker handoff");

    renderLedger({
      childIssues: [
        createIssue({ id: "child-2", identifier: "PAP-3", title: "Verify final report", status: "done" }),
        createIssue({ id: "child-3", identifier: "PAP-4", title: "Cancelled experiment", status: "cancelled" }),
      ],
    });

    expect(container.textContent).toContain("all 2 terminal (1 done, 1 cancelled)");
  });

  it("uses wrapping-friendly markup for long next action text", () => {
    renderLedger({
      runs: [
        createRun({
          nextAction: "Continue investigating this intentionally-long-next-action-token-that-needs-to-wrap-cleanly-on-mobile-and-desktop-without-overlapping-controls.",
        }),
      ],
    });

    const nextAction = [...container.querySelectorAll("span")]
      .find((node) => node.textContent?.includes("intentionally-long-next-action-token"));
    expect(nextAction?.className).toContain("break-words");
    expect(container.textContent).toContain("Next action:");
  });

  it("shows when older runs are clipped from the ledger", () => {
    renderLedger({
      runs: Array.from({ length: 10 }, (_, index) =>
        createRun({
          runId: `run-${index.toString().padStart(8, "0")}`,
          createdAt: `2026-04-18T19:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
    });

    expect(container.textContent).toContain("2 older runs not shown");
  });

  it("renders stale-run banner, watchdog actions, and silence badge for live runs", () => {
    const onWatchdogDecision = vi.fn();
    renderLedger({
      runs: [createRun({ runId: "run-live-1", status: "running", finishedAt: null })],
      activeRun: createActiveRun(),
      onWatchdogDecision,
    });

    expect(container.textContent).toContain("Stale-run watchdog alert");
    expect(container.textContent).toContain("PAP-404");
    expect(container.textContent).toContain("Stale run");
    const watchdogBanner = Array.from(container.querySelectorAll("p"))
      .find((node) => node.textContent?.includes("Stale-run watchdog alert"))
      ?.closest("div");
    expect(watchdogBanner?.className).toContain("border-red-500/30");
    expect(watchdogBanner?.className).toContain("bg-red-500/10");

    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Continue monitoring"),
    );
    expect(continueButton).not.toBeUndefined();
    act(() => {
      continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onWatchdogDecision).toHaveBeenCalledWith({
      runId: "run-live-1",
      decision: "continue",
      evaluationIssueId: "issue-eval-1",
    });
  });

  it("hides watchdog decision actions for known non-owner viewers", () => {
    const onWatchdogDecision = vi.fn();
    renderLedger({
      runs: [createRun({ runId: "run-live-1", status: "running", finishedAt: null })],
      activeRun: createActiveRun(),
      canRecordWatchdogDecisions: false,
      onWatchdogDecision,
    });

    expect(container.textContent).toContain("Stale-run watchdog alert");
    expect(container.textContent).toContain("PAP-404");
    expect(container.textContent).not.toContain("Continue monitoring");
    expect(container.textContent).not.toContain("Snooze 1h");
    expect(container.textContent).not.toContain("Mark false positive");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(onWatchdogDecision).not.toHaveBeenCalled();
  });
});
