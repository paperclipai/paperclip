// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueWatchdog,
  IssueWatchdogProofOutcome,
  IssueWatchdogSummary,
} from "@paperclipai/shared";
import { WatchdogStateCallout } from "./WatchdogStateCallout";

const getWatchdogMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    getWatchdog: getWatchdogMock,
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const summary: IssueWatchdogSummary = {
  id: "wd-1",
  companyId: "co-1",
  issueId: "issue-1",
  watchdogAgentId: "agent-1",
  instructions: null,
  status: "active",
  watchdogIssueId: "watchdog-issue-1",
  lastObservedFingerprint: "task_watchdog_stop:abcd1234",
  lastReviewedFingerprint: "task_watchdog_stop:abcd1234",
  lastTriggeredAt: null,
  lastCompletedAt: null,
  triggerCount: 2,
  createdAt: new Date("2026-06-24T10:00:00Z"),
  updatedAt: new Date("2026-06-24T10:00:00Z"),
};

function watchdogWith(
  outcome: IssueWatchdogProofOutcome | null,
  overrides: Partial<IssueWatchdog> = {},
): IssueWatchdog {
  return {
    ...summary,
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    updatedByRunId: null,
    latestProofOutcome: outcome
      ? {
          id: "proof-1",
          outcome,
          targetIssueId: "issue-1",
          method: "https_probe",
          observedAt: new Date("2026-06-24T11:00:00Z"),
          resultClassification:
            outcome === "failed" ? "unhealthy_502" : outcome === "deferred" ? "blocked_chain_pending" : "healthy_200",
          redactedDetails: { target: "https://app.example/healthz", status: "200" },
          stopFingerprint: "task_watchdog_stop:abcd1234",
          proofObligationFingerprint: "proof:abcd",
          createdByRunId: null,
          createdAt: new Date("2026-06-24T11:00:00Z"),
          updatedAt: new Date("2026-06-24T11:00:00Z"),
        }
      : null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForText(text: string) {
  await vi.waitFor(async () => {
    await flush();
    expect(container.textContent ?? "").toContain(text);
  });
}

function renderCallout(props: Partial<ComponentProps<typeof WatchdogStateCallout>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <WatchdogStateCallout issueId="issue-1" watchdog={summary} {...props} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  getWatchdogMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WatchdogStateCallout", () => {
  it("renders nothing when the issue has no watchdog", () => {
    getWatchdogMock.mockResolvedValue(null);
    renderCallout({ watchdog: null });
    expect(container.querySelector('[data-testid="watchdog-state-callout"]')).toBeNull();
    expect(getWatchdogMock).not.toHaveBeenCalled();
  });

  it("shows the accepted outcome with redacted evidence", async () => {
    getWatchdogMock.mockResolvedValue(watchdogWith("accepted"));
    renderCallout();
    await waitForText("Accepted");
    expect(container.textContent).toContain("healthy_200");
    expect(container.textContent).toContain("https://app.example/healthz");
  });

  it("shows the deferred outcome with an outstanding blocker", async () => {
    getWatchdogMock.mockResolvedValue(watchdogWith("deferred"));
    const blockers: IssueRelationIssueSummary[] = [
      {
        id: "blk-1",
        identifier: "PAP-500",
        title: "Deploy access",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
    ];
    renderCallout({ blockers });
    await waitForText("Deferred");
    expect(container.textContent).toContain("Blocked by");
    expect(container.textContent).toContain("PAP-500");
  });

  it("does not show a phantom outstanding blocker section for deferred review paths", async () => {
    getWatchdogMock.mockResolvedValue(watchdogWith("deferred"));
    renderCallout();
    await waitForText("Deferred");
    expect(container.textContent).toContain("waiting path must complete");
    expect(container.textContent).not.toContain("Outstanding");
    expect(container.textContent).not.toContain("next check on blocker resolve");
  });

  it("shows the failed outcome with the recovery action owner and next step", async () => {
    getWatchdogMock.mockResolvedValue(watchdogWith("failed"));
    const recoveryAction = {
      id: "rec-1",
      recoveryIssueId: "issue-rec",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      nextAction: "Re-run the deploy verification",
    } as unknown as IssueRecoveryAction;
    renderCallout({ recoveryAction });
    await waitForText("Failed");
    expect(container.textContent).toContain("Recovery action");
    expect(container.textContent).toContain("Re-run the deploy verification");
  });

  it("shows the armed-but-unreviewed empty state", async () => {
    getWatchdogMock.mockResolvedValue(watchdogWith(null));
    renderCallout();
    await waitForText("Watchdog armed");
  });

  it("surfaces a load failure with a retry affordance instead of hiding it", async () => {
    getWatchdogMock.mockRejectedValue(new Error("boom"));
    renderCallout();
    await waitForText("Couldn't load watchdog state");
    expect(container.textContent).toContain("Retry");
  });

  it("flags fingerprint drift when observed is ahead of reviewed", async () => {
    getWatchdogMock.mockResolvedValue(
      watchdogWith("accepted", { lastObservedFingerprint: "task_watchdog_stop:zzzz9999" }),
    );
    renderCallout();
    await waitForText("review pending");
  });
});
