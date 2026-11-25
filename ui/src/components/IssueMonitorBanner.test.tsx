import type { Issue } from "@paperclipai/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueMonitorBanner, IssueMonitorComposerStrip } from "./IssueMonitorBanner";

describe("AI connection pool wait surfaces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T09:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function poolWaitIssue(poolWaitScope?: "account" | "pool"): Issue {
    const scheduledRetry = {
      runId: "scheduled-run",
      status: "scheduled_retry" as const,
      agentId: "agent",
      agentName: null,
      retryOfRunId: null,
      scheduledRetryAt: "2026-11-24T09:15:00.000Z",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ai_connection_pool_wait",
      ...(poolWaitScope ? { poolWaitScope } : {}),
    };
    return { id: "issue", status: "in_progress", scheduledRetry } as Issue;
  }

  it.each([
    ["pool", "Pool exhausted"],
    ["account", "Selected AI account cooling down"],
    [undefined, "Waiting for AI pool usage"],
  ] as const)("shows scoped status for a %s wait on both task surfaces", (scope, title) => {
    const issue = poolWaitIssue(scope);
    const banner = renderToStaticMarkup(<IssueMonitorBanner issue={issue} />);
    const strip = renderToStaticMarkup(<IssueMonitorComposerStrip issue={issue} />);

    expect(banner).toContain(title);
    expect(strip).toContain(title);
    expect(banner).toContain("Usage recheck in 15m");
    expect(strip).toContain("Usage recheck in 15m");
    expect(banner).toContain("(your time)");
    expect(strip).not.toContain("Sending a reply wakes the agent now");
    expect(strip).toContain("Sending a reply checks usage again now.");
  });
});

function waitingIssue(scheduledRetryReason: string) {
  return {
    id: "issue-1",
    status: "todo",
    scheduledRetry: {
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      scheduledRetryAttempt: 1,
      scheduledRetryReason,
    },
  } as unknown as Issue;
}

it("keeps the wake-now promise for an ordinary scheduled retry", () => {
  const markup = renderToStaticMarkup(<IssueMonitorComposerStrip issue={waitingIssue("transient_failure")} />);
  expect(markup).toContain("Sending a reply wakes the agent now");
});
