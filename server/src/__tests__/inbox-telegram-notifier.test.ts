import { describe, expect, it } from "vitest";
import {
  createDefaultInboxTelegramNotifierState,
  decideInboxTelegramNotification,
  deriveInboxAlertCount,
  formatInboxTelegramMessage,
} from "../services/inbox-telegram-notifier.js";

describe("inbox telegram notifier", () => {
  it("does not notify when the first observed inbox count is zero", () => {
    const decision = decideInboxTelegramNotification({
      previousState: createDefaultInboxTelegramNotifierState(),
      snapshot: { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
      observedAt: "2026-05-02T03:00:00.000Z",
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("no_action_needed");
    expect(decision.nextState.lastObservedInboxCount).toBe(0);
    expect(decision.nextState.lastNotifiedInboxCount).toBeNull();
  });

  it("notifies on the first positive inbox count", () => {
    const decision = decideInboxTelegramNotification({
      previousState: createDefaultInboxTelegramNotifierState(),
      snapshot: { inbox: 3, approvals: 1, failedRuns: 1, joinRequests: 0 },
      observedAt: "2026-05-02T03:01:00.000Z",
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe("initial_positive");
    expect(decision.nextState.lastObservedInboxCount).toBe(3);
    expect(decision.nextState.lastNotifiedInboxCount).toBe(3);
  });

  it("does not re-notify when the positive inbox count is unchanged", () => {
    const decision = decideInboxTelegramNotification({
      previousState: {
        lastObservedInboxCount: 3,
        lastObservedAt: "2026-05-02T03:01:00.000Z",
        lastNotifiedInboxCount: 3,
        lastNotifiedAt: "2026-05-02T03:01:00.000Z",
      },
      snapshot: { inbox: 3, approvals: 1, failedRuns: 1, joinRequests: 0 },
      observedAt: "2026-05-02T03:02:00.000Z",
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("no_action_needed");
    expect(decision.nextState.lastObservedInboxCount).toBe(3);
    expect(decision.nextState.lastNotifiedInboxCount).toBe(3);
  });

  it("notifies when the inbox count changes while still positive", () => {
    const decision = decideInboxTelegramNotification({
      previousState: {
        lastObservedInboxCount: 3,
        lastObservedAt: "2026-05-02T03:01:00.000Z",
        lastNotifiedInboxCount: 3,
        lastNotifiedAt: "2026-05-02T03:01:00.000Z",
      },
      snapshot: { inbox: 5, approvals: 1, failedRuns: 2, joinRequests: 1 },
      observedAt: "2026-05-02T03:03:00.000Z",
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe("count_changed");
    expect(decision.nextState.lastObservedInboxCount).toBe(5);
    expect(decision.nextState.lastNotifiedInboxCount).toBe(5);
  });

  it("updates observed state without notifying when the inbox clears", () => {
    const decision = decideInboxTelegramNotification({
      previousState: {
        lastObservedInboxCount: 5,
        lastObservedAt: "2026-05-02T03:03:00.000Z",
        lastNotifiedInboxCount: 5,
        lastNotifiedAt: "2026-05-02T03:03:00.000Z",
      },
      snapshot: { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
      observedAt: "2026-05-02T03:04:00.000Z",
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.nextState.lastObservedInboxCount).toBe(0);
    expect(decision.nextState.lastNotifiedInboxCount).toBe(5);
  });

  it("derives alert count from the inbox total", () => {
    expect(
      deriveInboxAlertCount({
        inbox: 5,
        approvals: 1,
        failedRuns: 2,
        joinRequests: 1,
      }),
    ).toBe(1);
  });

  it("formats a human-readable Telegram message", () => {
    const message = formatInboxTelegramMessage(
      {
        inbox: 5,
        approvals: 1,
        failedRuns: 2,
        joinRequests: 1,
      },
      {
        companyLabel: "Emtesseract",
        inboxUrl: "https://paperclip.example/inbox/recent",
        observedAt: "2026-05-02T03:05:00.000Z",
      },
    );

    expect(message).toContain("Paperclip inbox update for Emtesseract");
    expect(message).toContain("Inbox count: 5");
    expect(message).toContain("2 failed runs, 1 alert, 1 join request, 1 approval");
    expect(message).toContain("Open inbox: https://paperclip.example/inbox/recent");
  });
});
