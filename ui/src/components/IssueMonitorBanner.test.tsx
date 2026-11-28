// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { IssueMonitorBanner, IssueMonitorComposerStrip } from "./IssueMonitorBanner";

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

it("tells a user that a reply rechecks usage, not that it starts work outright", () => {
  const markup = renderToStaticMarkup(<IssueMonitorComposerStrip issue={waitingIssue("ai_connection_pool_wait")} />);
  expect(markup).toContain("Pool exhausted");
  expect(markup).toContain("Sending a reply checks usage again now.");
  expect(markup).not.toContain("wakes the agent now");
});

it("hides Check now for a pool wait because no monitor exists to check", () => {
  const issue = waitingIssue("ai_connection_pool_wait");
  const banner = renderToStaticMarkup(<IssueMonitorBanner issue={issue} onCheckNow={() => {}} />);
  const strip = renderToStaticMarkup(<IssueMonitorComposerStrip issue={issue} onCheckNow={() => {}} />);
  expect(banner).toContain("Usage recheck");
  expect(banner).not.toContain("Check now");
  expect(strip).not.toContain("Check now");
});

it("keeps the wake-now promise for an ordinary scheduled retry", () => {
  const markup = renderToStaticMarkup(<IssueMonitorComposerStrip issue={waitingIssue("transient_failure")} />);
  expect(markup).toContain("Sending a reply wakes the agent now");
});
