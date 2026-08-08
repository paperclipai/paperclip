// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  InterruptedRunRecovery,
  IssueRecoveryAction,
  IssueRetryNowOutcome,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { IssueScheduledRetryCard } from "./IssueScheduledRetryCard";
import { ToastProvider } from "../context/ToastContext";

const retryNowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    retryScheduledRetryNow: retryNowMock,
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

const SYSTEM_NOW = new Date("2026-04-18T20:00:00.000Z").getTime();

const baseRetry: IssueScheduledRetry = {
  runId: "run-00000000",
  status: "scheduled_retry",
  agentId: "agent-1",
  agentName: "ClaudeCoder",
  retryOfRunId: "run-prev-1234567",
  scheduledRetryAt: "2026-04-18T20:15:00.000Z",
  scheduledRetryAttempt: 4,
  scheduledRetryReason: "transient_failure",
  retryExhaustedReason: null,
  error: "Upstream provider rate limited",
  errorCode: "rate_limited",
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

async function waitForUi(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    assertion();
  });
}

async function waitForRetryButtonText(expected: string) {
  for (let i = 0; i < 20; i += 1) {
    if ((getRetryNowButton()?.textContent ?? "").includes(expected)) return;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(getRetryNowButton()!.textContent ?? "").toContain(expected);
}

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(SYSTEM_NOW);
  retryNowMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  dateNowSpy?.mockRestore();
});

function getCard() {
  return container.querySelector('[data-testid="issue-scheduled-retry-card"]');
}

function getRetryNowButton() {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="issue-scheduled-retry-card-retry-now"]',
  );
}

describe("IssueScheduledRetryCard", () => {
  it("renders nothing when there is no scheduled retry", () => {
    renderWithProviders(<IssueScheduledRetryCard issueId="issue-1" scheduledRetry={null} />);
    expect(getCard()).toBeNull();
  });

  it("renders nothing when status is not scheduled_retry", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, status: "queued" }}
      />,
    );
    expect(getCard()).toBeNull();
  });

  it("shows attempt count, reason, absolute and relative timestamps", () => {
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    const card = getCard();
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("Retry scheduled");
    expect(text).toContain("Attempt 4");
    expect(text).toContain("Transient failure");
    expect(text).toContain("Automatic retry in 15m");
    expect(text).toContain("run-prev");
  });

  it("uses continuation copy for max-turn continuations", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, scheduledRetryReason: "max_turns_continuation" }}
      />,
    );
    const text = getCard()?.textContent ?? "";
    expect(text).toContain("Continuation scheduled");
    expect(text).toContain("Automatic continuation");
    expect(text).toContain("Pulls continuation forward immediately");
  });

  it("uses 'due now' label when scheduledRetryAt is at the current time", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, scheduledRetryAt: "2026-04-18T20:00:10.000Z" }}
      />,
    );
    const text = getCard()?.textContent ?? "";
    expect(text).toContain("Automatic retry due now");
  });

  it("invokes retry-now and shows promoted state on success", async () => {
    retryNowMock.mockResolvedValue(buildRetryResponse("promoted"));
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    const button = getRetryNowButton();
    expect(button).not.toBeNull();

    act(() => {
      button!.click();
    });
    await waitForRetryButtonText("Promoted");
    expect(retryNowMock).toHaveBeenCalledWith("issue-1");
    const finalButton = getRetryNowButton();
    expect(finalButton!.textContent ?? "").toContain("Promoted");
    expect(finalButton!.disabled).toBe(true);
  });

  it("shows already promoted state when backend reports duplicate click", async () => {
    retryNowMock.mockResolvedValue(buildRetryResponse("already_promoted"));
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    act(() => {
      getRetryNowButton()!.click();
    });
    await waitForRetryButtonText("Already promoted");
    expect(getRetryNowButton()!.textContent ?? "").toContain("Already promoted");
    expect(container.querySelector('[data-testid="issue-scheduled-retry-error-band"]')).toBeNull();
  });

  it("renders an inline error band on backend failure", async () => {
    retryNowMock.mockRejectedValue(new Error("Server error"));
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    act(() => {
      getRetryNowButton()!.click();
    });
    await waitForUi(() => {
      const band = container.querySelector('[data-testid="issue-scheduled-retry-error-band"]');
      expect(band).not.toBeNull();
      expect((band?.textContent ?? "")).toContain("Server error");
      expect(getRetryNowButton()!.disabled).toBe(false);
    });
  });

  it("surfaces gate-suppressed outcome via the inline error band", async () => {
    retryNowMock.mockResolvedValue(buildRetryResponse("gate_suppressed"));
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    act(() => {
      getRetryNowButton()!.click();
    });
    await waitForUi(() => {
      const band = container.querySelector('[data-testid="issue-scheduled-retry-error-band"]');
      expect(band).not.toBeNull();
      expect((band?.textContent ?? "")).toContain("Promotion suppressed");
      expect(getRetryNowButton()!.disabled).toBe(false);
    });
  });
});

const interruptedRecovery: InterruptedRunRecovery = {
  state: "retry_queued",
  interruptedRunId: "interrupted-run-1234",
  interruptedAt: "2026-04-18T19:55:13.000Z",
  errorCode: "server_shutdown_interrupted",
  successorRunId: null,
  successorStatus: null,
  receiptId: "receipt-9876-5432",
  receiptOutcome: "queued",
  suppressionReason: null,
  escalationReason: null,
  attempt: 1,
  maxAttempts: 3,
  recoveryActionId: null,
  owner: null,
  nextAction: null,
};

const openRecoveryAction = {
  id: "action-1",
  issueId: "issue-1",
  kind: "stranded_assigned_issue",
  status: "active",
  ownerType: "agent",
  ownerAgentId: "agent-2",
  ownerUserId: null,
  previousOwnerAgentId: "agent-1",
  returnOwnerAgentId: null,
  outcome: null,
  nextAction: "Reassign the task and restart the run.",
  evidence: {},
  attemptCount: 1,
  maxAttempts: 3,
  timeoutAt: null,
  resolvedAt: null,
  createdAt: "2026-04-18T19:56:00.000Z",
  updatedAt: "2026-04-18T19:56:00.000Z",
} as unknown as IssueRecoveryAction;

describe("IssueScheduledRetryCard — interrupted-run recovery variants", () => {
  it("variant A explains the restart and keeps Retry now", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        issueStatus="in_progress"
        scheduledRetry={{ ...baseRetry, scheduledRetryReason: "process_lost" }}
        interruptedRunRecovery={interruptedRecovery}
      />,
    );
    const card = getCard()!;
    expect(card.getAttribute("data-recovery-variant")).toBe("retry_queued");
    const text = card.textContent ?? "";
    expect(text).toContain("Retry queued");
    expect(text).toContain("Attempt 1 of 3");
    expect(text).toContain(
      "The last run was interrupted by a server restart. Work resumes automatically",
    );
    expect(text).toContain("Replaces run");
    expect(text).toContain("Receipt");
    expect(getRetryNowButton()).not.toBeNull();
  });

  it("variant A links the interrupted run and copies the receipt id", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, scheduledRetryReason: "process_lost" }}
        interruptedRunRecovery={interruptedRecovery}
      />,
    );
    const runLink = getCard()!.querySelector<HTMLAnchorElement>('a[title="interrupted-run-1234"]');
    expect(runLink).not.toBeNull();
    expect(runLink!.getAttribute("href")).toBe("/agents/agent-1/runs/interrupted-run-1234");
    expect(runLink!.textContent).toBe("interrup");
    const receipt = getCard()!.querySelector('[data-testid="issue-recovery-receipt-chip"]');
    expect(receipt).not.toBeNull();
    expect(receipt!.getAttribute("title")).toBe("receipt-9876-5432 · queued");
    expect(receipt!.textContent).toBe("receipt-");
  });

  it("variant B is quiet: no Retry now, no alarm tone, lineage only", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, status: "running", scheduledRetryReason: "process_lost" }}
        interruptedRunRecovery={{
          ...interruptedRecovery,
          state: "recovered",
          successorRunId: "successor-run-1",
          successorStatus: "running",
        }}
      />,
    );
    const card = getCard()!;
    expect(card.getAttribute("data-recovery-variant")).toBe("recovered");
    const text = card.textContent ?? "";
    expect(text).toContain("Recovered");
    expect(text).toContain("Recovered after restart — run successo is continuing the work.");
    expect(text).toContain("Continues run");
    expect(getRetryNowButton()).toBeNull();
    expect(card.className).not.toContain("amber");
    expect(card.className).toContain("border-border/60");
  });

  it("variant C renders the bounded exhaustion reason verbatim without a Retry now", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{
          ...baseRetry,
          status: "cancelled",
          scheduledRetryReason: "process_lost",
          retryExhaustedReason: "Automatic retries exhausted after 3 attempts.",
        }}
        interruptedRunRecovery={{
          ...interruptedRecovery,
          state: "retry_exhausted",
          escalationReason: "Automatic retries exhausted after 3 attempts.",
        }}
      />,
    );
    const card = getCard()!;
    expect(card.getAttribute("data-recovery-variant")).toBe("retry_exhausted");
    const text = card.textContent ?? "";
    expect(text).toContain("Retry exhausted");
    expect(text).toContain("Automatic retries are used up. A recovery owner is needed to continue.");
    expect(text).toContain("Automatic retries exhausted after 3 attempts.");
    expect(text).toContain("Interrupted run");
    expect(getRetryNowButton()).toBeNull();
  });

  it("variant C surfaces the pathless shape the original bug produced", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={null}
        interruptedRunRecovery={{ ...interruptedRecovery, state: "pathless", receiptId: null }}
      />,
    );
    const text = getCard()!.textContent ?? "";
    expect(text).toContain("No recovery scheduled");
    expect(text).toContain("The last run was interrupted and no retry or recovery is scheduled.");
    expect(text).toContain(
      "open a typed recovery action or escalate to a recovery owner",
    );
  });

  it("stands down entirely when a recovery owner is required (one card per task)", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={baseRetry}
        interruptedRunRecovery={interruptedRecovery}
        activeRecoveryAction={openRecoveryAction}
      />,
    );
    expect(getCard()).toBeNull();
  });

  it("renders nothing on a terminal task", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        issueStatus="done"
        scheduledRetry={{ ...baseRetry, scheduledRetryReason: "process_lost" }}
        interruptedRunRecovery={interruptedRecovery}
      />,
    );
    expect(getCard()).toBeNull();
  });

  it("leaves an ordinary failure retry on today's copy", () => {
    renderWithProviders(
      <IssueScheduledRetryCard issueId="issue-1" scheduledRetry={baseRetry} />,
    );
    const text = getCard()!.textContent ?? "";
    expect(text).toContain("Retry scheduled");
    expect(text).toContain("Transient failure");
    expect(text).not.toContain("interrupted by a server restart");
  });

  it("leaves a max-turn continuation on today's copy", () => {
    renderWithProviders(
      <IssueScheduledRetryCard
        issueId="issue-1"
        scheduledRetry={{ ...baseRetry, scheduledRetryReason: "max_turns_continuation" }}
      />,
    );
    const text = getCard()!.textContent ?? "";
    expect(text).toContain("Continuation scheduled");
    expect(text).toContain("Automatic continuation");
  });
});
