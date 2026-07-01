// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompanyScorecard as CompanyScorecardData } from "@paperclipai/shared";
import { CompanyScorecard } from "./CompanyScorecard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeScorecard(
  overrides: Partial<CompanyScorecardData> = {},
): CompanyScorecardData {
  return {
    companyId: "company-1",
    pulse: "green",
    counters: {
      issues: { todo: 4, inProgress: 2, inReview: 1, blocked: 0, done7d: 7 },
      agents: { active: 3, idle: 1, paused: 0 },
      runs24h: { succeeded: 12, failed: 1, other: 0 },
    },
    attention: [],
    activity: [],
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderScorecard(scorecard: CompanyScorecardData): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CompanyScorecard scorecard={scorecard} />);
  });
  return container;
}

describe("CompanyScorecard", () => {
  let containers: HTMLDivElement[] = [];

  beforeEach(() => {
    containers = [];
  });

  afterEach(() => {
    for (const c of containers) c.remove();
    document.body.innerHTML = "";
  });

  it("renders counter values for issues, agents, and runs", () => {
    const container = renderScorecard(makeScorecard());
    containers.push(container);
    const text = container.textContent ?? "";
    expect(text).toContain("Issues");
    expect(text).toContain("Agents");
    expect(text).toContain("Runs · 24h");
    expect(text).toContain("Done · 7d");
    // Counter values should all appear
    for (const value of ["4", "2", "1", "0", "7", "3", "12"]) {
      expect(text).toContain(value);
    }
  });

  it("exposes the pulse on the root element for styling and tests", () => {
    const container = renderScorecard(makeScorecard({ pulse: "amber" }));
    containers.push(container);
    const section = container.querySelector("[data-testid='company-scorecard']") as HTMLElement;
    expect(section.dataset.pulse).toBe("amber");
    expect(container.textContent).toContain("Needs attention");
  });

  it("renders attention items with reason labels", () => {
    const container = renderScorecard(
      makeScorecard({
        pulse: "red",
        attention: [
          {
            issueId: "i1",
            identifier: "SC-1",
            title: "Plumbing fails on Windows",
            status: "blocked",
            priority: "high",
            assigneeAgentId: null,
            updatedAt: new Date().toISOString(),
            reason: "blocked",
          },
          {
            issueId: "i2",
            identifier: "SC-2",
            title: "Review feedback never landed",
            status: "in_review",
            priority: "medium",
            assigneeAgentId: null,
            updatedAt: new Date().toISOString(),
            reason: "in_review_waiting",
          },
        ],
      }),
    );
    containers.push(container);
    const text = container.textContent ?? "";
    expect(text).toContain("SC-1");
    expect(text).toContain("Plumbing fails on Windows");
    expect(text).toContain("Blocked");
    expect(text).toContain("Review waiting");
  });

  it("falls back to empty-state copy when there is no attention or activity", () => {
    const container = renderScorecard(makeScorecard());
    containers.push(container);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing flagged.");
    expect(text).toContain("No recent activity.");
  });

  it("renders activity rows with agent name and kind label", () => {
    const container = renderScorecard(
      makeScorecard({
        activity: [
          {
            kind: "comment",
            label: "issue.comment_added",
            issueId: "i1",
            issueIdentifier: "SC-1",
            agentId: "a1",
            agentName: "Codex",
            occurredAt: new Date().toISOString(),
          },
          {
            kind: "run_started",
            label: "heartbeat.invoked",
            issueId: null,
            issueIdentifier: null,
            agentId: "a1",
            agentName: "Codex",
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    );
    containers.push(container);
    const text = container.textContent ?? "";
    expect(text).toContain("Codex");
    expect(text).toContain("commented");
    expect(text).toContain("SC-1");
    expect(text).toContain("started a run");
  });
});
