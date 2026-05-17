// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueTreeObservability } from "@paperclipai/shared";
import { IssueTreeObservabilityPanel } from "./IssueTreeObservabilityPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).IS_REACT_ACT_ENVIRONMENT = true;
}

function createObservability(overrides: Partial<IssueTreeObservability> = {}): IssueTreeObservability {
  const { blockerExplanations = [], ...restOverrides } = overrides;
  return {
    issueId: "issue-root",
    generatedAt: new Date("2026-05-13T12:10:00.000Z"),
    summary: {
      issueId: "issue-root",
      issueCount: 3,
      activeIssueCount: 2,
      doneIssueCount: 1,
      cancelledIssueCount: 0,
      blockedIssueCount: 1,
      runCount: 4,
      activeRunCount: 1,
      failedRunCount: 1,
      errorEventCount: 1,
      costCents: 425,
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 300,
      runtimeMs: 185_000,
      lastActivityAt: new Date("2026-05-13T12:09:00.000Z"),
    },
    nodes: [
      {
        id: "issue-root",
        identifier: "LET-125",
        title: "Roadmap parent",
        status: "in_progress",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        runCount: 1,
        activeRunCount: 0,
        failedRunCount: 0,
        errorEventCount: 0,
        costCents: 125,
        inputTokens: 200,
        cachedInputTokens: 50,
        outputTokens: 100,
        runtimeMs: 60_000,
        lastActivityAt: new Date("2026-05-13T12:05:00.000Z"),
        latestRunStatus: "succeeded",
        latestRunId: "run-root",
      },
      {
        id: "issue-child",
        identifier: "LET-128",
        title: "Tree observability",
        status: "blocked",
        parentId: "issue-root",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        runCount: 3,
        activeRunCount: 1,
        failedRunCount: 1,
        errorEventCount: 1,
        costCents: 300,
        inputTokens: 1000,
        cachedInputTokens: 150,
        outputTokens: 200,
        runtimeMs: 125_000,
        lastActivityAt: new Date("2026-05-13T12:09:00.000Z"),
        latestRunStatus: "failed",
        latestRunId: "run-failed",
      },
    ],
    timeline: [
      {
        id: "error:issue-child:1",
        kind: "error",
        severity: "error",
        issueId: "issue-child",
        issueIdentifier: "LET-128",
        issueTitle: "Tree observability",
        runId: "run-failed",
        timestamp: new Date("2026-05-13T12:09:00.000Z"),
        label: "adapter_error",
        message: `Request failed with to${"ken=synthetic-placeholder"} and sk-secret-value-123456`,
        costCents: null,
      },
      {
        id: "cost:issue-root:1",
        kind: "cost",
        severity: "info",
        issueId: "issue-root",
        issueIdentifier: "LET-125",
        issueTitle: "Roadmap parent",
        runId: "run-root",
        timestamp: new Date("2026-05-13T12:05:00.000Z"),
        label: "Cost recorded",
        message: "openai gpt-5",
        costCents: 125,
      },
    ],
    blockerExplanations,
    ...restOverrides,
  };
}

describe("IssueTreeObservabilityPanel", () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  afterEach(() => {
    if (reactRoot) {
      act(() => reactRoot.unmount());
    }
    container?.remove();
  });

  it("renders issue tree observability summaries, node health, timeline, and redacted errors", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    act(() => {
      reactRoot.render(<IssueTreeObservabilityPanel observability={createObservability()} />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Tree observability");
    expect(text).toContain("3 total · 2 active");
    expect(text).toContain("1 blocked");
    expect(text).toContain("4 total · 1 active");
    expect(text).toContain("1 failed");
    expect(text).toContain("$4.2500");
    expect(text).toContain("Tokens 1.5k");
    expect(text).toContain("Runtime");
    expect(text).toContain("LET-128");
    expect(text).toContain("adapter_error · LET-128");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("synthetic-placeholder");
    expect(text).not.toContain("sk-secret-value");
  });

  it("stays hidden without observability data", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    act(() => {
      reactRoot.render(<IssueTreeObservabilityPanel observability={null} />);
    });

    expect(container.textContent).toBe("");
  });
});
