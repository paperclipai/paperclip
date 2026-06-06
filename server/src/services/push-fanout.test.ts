import { describe, it, expect, vi, beforeEach } from "vitest";

// Set up mocks before imports
const mockSendToBoard = vi.fn().mockResolvedValue({ sent: 1, pruned: 0 });

vi.mock("./live-events.js", () => ({
  subscribeGlobalLiveEvents: vi.fn(),
}));

vi.mock("./web-push.js", () => ({
  webPushService: vi.fn(() => ({ sendToBoard: mockSendToBoard })),
}));

import { subscribeGlobalLiveEvents } from "./live-events.js";
import { initPushFanout } from "./push-fanout.js";

const mockSubscribe = vi.mocked(subscribeGlobalLiveEvents);

function captureListener(): (event: Parameters<Parameters<typeof subscribeGlobalLiveEvents>[0]>[0]) => void {
  const listener = mockSubscribe.mock.calls[mockSubscribe.mock.calls.length - 1][0];
  if (!listener) throw new Error("no listener captured");
  return listener;
}

function makeIssueEvent(type: string, issueId = "issue-1") {
  return {
    id: 1,
    companyId: "company-1",
    type,
    createdAt: new Date().toISOString(),
    payload: {
      issueId,
      issueIdentifier: "SAG-9999",
      issueTitle: "Test issue",
    },
  } as Parameters<Parameters<typeof subscribeGlobalLiveEvents>[0]>[0];
}

describe("initPushFanout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendToBoard.mockResolvedValue({ sent: 1, pruned: 0 });
    // Use 0-hour dedup TTL so dedup key resets instantly in dedup tests
    process.env.PAPERCLIP_PUSH_DEDUP_TTL_HOURS = "4";
    // Set quiet hours to something that won't fire during tests (midnight-1am)
    process.env.PAPERCLIP_PUSH_QUIET_START = "0";
    process.env.PAPERCLIP_PUSH_QUIET_END = "1";
  });

  it("calls sendToBoard on issue.user_assigned", async () => {
    initPushFanout({} as never);
    const listener = captureListener();

    await listener(makeIssueEvent("issue.user_assigned"));

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSendToBoard).toHaveBeenCalledOnce();
    expect(mockSendToBoard.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("Action needed"),
    });
  });

  it("calls sendToBoard on issue.interaction.pending", async () => {
    initPushFanout({} as never);
    const listener = captureListener();

    await listener(makeIssueEvent("issue.interaction.pending"));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSendToBoard).toHaveBeenCalledOnce();
    expect(mockSendToBoard.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("input needed"),
    });
  });

  it("deduplicates repeat immediate events for the same issue within TTL", async () => {
    process.env.PAPERCLIP_PUSH_DEDUP_TTL_HOURS = "4";
    initPushFanout({} as never);
    const listener = captureListener();

    // Fire same event twice — second should be suppressed
    await listener(makeIssueEvent("issue.user_assigned", "issue-dedup"));
    await listener(makeIssueEvent("issue.user_assigned", "issue-dedup"));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSendToBoard).toHaveBeenCalledOnce();
  });

  it("does NOT dedup events for different issues", async () => {
    initPushFanout({} as never);
    const listener = captureListener();

    await listener(makeIssueEvent("issue.user_assigned", "issue-a"));
    await listener(makeIssueEvent("issue.user_assigned", "issue-b"));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSendToBoard).toHaveBeenCalledTimes(2);
  });

  it("buffers issue.blocked without sending immediately", async () => {
    initPushFanout({} as never);
    const listener = captureListener();

    // Digest interval is 4h — won't flush immediately
    process.env.PAPERCLIP_PUSH_DIGEST_INTERVAL_HOURS = "4";
    await listener(makeIssueEvent("issue.blocked"));
    await new Promise((r) => setTimeout(r, 10));

    // sendToBoard should NOT have been called (digest not flushed yet)
    expect(mockSendToBoard).not.toHaveBeenCalled();
  });

  it("returns a cleanup function that stops the subscriber", () => {
    const mockUnsubscribe = vi.fn();
    mockSubscribe.mockReturnValueOnce(mockUnsubscribe);

    const cleanup = initPushFanout({} as never);
    cleanup();

    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });
});
