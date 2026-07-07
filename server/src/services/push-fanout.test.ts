import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendToBoard = vi.fn().mockResolvedValue({ sent: 1, pruned: 0 });

vi.mock("./web-push.js", () => ({
  webPushService: vi.fn(() => ({ sendToBoard: mockSendToBoard })),
}));

import { publishLiveEvent } from "./live-events.js";
import { __resetPushFanoutForTests, initPushFanout } from "./push-fanout.js";

let cleanup: (() => void) | null = null;

function startFanout() {
  cleanup?.();
  cleanup = initPushFanout({} as never);
}

function publishIssueEvent(
  type: "issue.user_assigned" | "issue.interaction.pending" | "issue.blocked" | "issue.stale",
  issueId = "issue-1",
) {
  publishLiveEvent({
    companyId: "company-1",
    type,
    payload: {
      issueId,
      issueIdentifier: "SAG-9999",
      issueTitle: "Test issue",
    },
  });
}

async function flushFanout() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("initPushFanout", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __resetPushFanoutForTests();
    mockSendToBoard.mockResolvedValue({ sent: 1, pruned: 0 });
    process.env.PAPERCLIP_PUSH_DEDUP_TTL_HOURS = "4";
    process.env.PAPERCLIP_PUSH_DIGEST_INTERVAL_HOURS = "1";
    process.env.PAPERCLIP_PUSH_QUIET_START = "0";
    process.env.PAPERCLIP_PUSH_QUIET_END = "1";
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetPushFanoutForTests();
    vi.useRealTimers();
  });

  it("calls sendToBoard once when publishLiveEvent emits issue.user_assigned", async () => {
    startFanout();

    publishIssueEvent("issue.user_assigned");
    await flushFanout();

    expect(mockSendToBoard).toHaveBeenCalledOnce();
    expect(mockSendToBoard.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("Action needed"),
    });
  });

  it("calls sendToBoard on issue.interaction.pending", async () => {
    startFanout();

    publishIssueEvent("issue.interaction.pending", "issue-interaction");
    await flushFanout();

    expect(mockSendToBoard).toHaveBeenCalledOnce();
    expect(mockSendToBoard.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("input needed"),
    });
  });

  it("deduplicates repeat immediate events for the same issue within TTL", async () => {
    startFanout();

    publishIssueEvent("issue.user_assigned", "issue-dedup");
    publishIssueEvent("issue.user_assigned", "issue-dedup");
    await flushFanout();

    expect(mockSendToBoard).toHaveBeenCalledOnce();
  });

  it("does not dedup events for different issues", async () => {
    startFanout();

    publishIssueEvent("issue.user_assigned", "issue-a");
    publishIssueEvent("issue.user_assigned", "issue-b");
    await flushFanout();

    expect(mockSendToBoard).toHaveBeenCalledTimes(2);
  });

  it("buffers issue.blocked without sending immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T15:00:00Z"));
    startFanout();

    publishIssueEvent("issue.blocked", "issue-blocked-buffered");
    await flushFanout();

    expect(mockSendToBoard).not.toHaveBeenCalled();
  });

  it("batches blocked and stale events into a digest from real published events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T15:00:00Z"));
    startFanout();

    publishIssueEvent("issue.blocked", "issue-blocked");
    vi.setSystemTime(new Date("2026-07-07T16:01:00Z"));
    publishIssueEvent("issue.stale", "issue-stale");
    await flushFanout();

    expect(mockSendToBoard).toHaveBeenCalledOnce();
    expect(mockSendToBoard.mock.calls[0][0]).toMatchObject({
      title: "1 blocked, 1 stale — tap to view",
      data: { kind: "digest", blockedCount: 1, staleCount: 1 },
    });
  });

  it("defers blocked and stale digest pushes during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T23:00:00Z"));
    process.env.PAPERCLIP_PUSH_QUIET_START = "0";
    process.env.PAPERCLIP_PUSH_QUIET_END = "24";
    startFanout();

    publishIssueEvent("issue.blocked", "issue-blocked-quiet");
    vi.setSystemTime(new Date("2026-07-08T00:01:00Z"));
    publishIssueEvent("issue.stale", "issue-stale-quiet");
    await flushFanout();

    expect(mockSendToBoard).not.toHaveBeenCalled();
  });

  it("returns a cleanup function that stops the subscriber", async () => {
    startFanout();
    cleanup?.();
    cleanup = null;

    publishIssueEvent("issue.user_assigned", "issue-after-cleanup");
    await flushFanout();

    expect(mockSendToBoard).not.toHaveBeenCalled();
  });
});
