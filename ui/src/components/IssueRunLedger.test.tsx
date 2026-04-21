// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue, RunLivenessState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunForIssue } from "../api/activity";
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

function renderLedger(props: Partial<ComponentProps<typeof IssueRunLedgerContent>> = {}) {
  render(
    <IssueRunLedgerContent
      runs={props.runs ?? []}
      liveRuns={props.liveRuns}
      activeRun={props.activeRun}
      issueStatus={props.issueStatus ?? "in_progress"}
      childIssues={props.childIssues ?? []}
      agentMap={props.agentMap ?? new Map([["agent-1", { name: "CodexCoder" }]])}
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
});
