// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueRetryNowOutcome, IssueScheduledRetry } from "@paperclipai/shared";
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
