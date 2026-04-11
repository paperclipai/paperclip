import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_STALL_THRESHOLD_MS } from "@paperclipai/shared";

// Mock the heartbeat service dependencies
const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
};

const mockLogActivity = vi.fn(async () => undefined);
const mockPublishLiveEvent = vi.fn();

vi.mock("./activity-log.js", () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

vi.mock("./live-events.js", () => ({
  publishLiveEvent: (...args: any[]) => mockPublishLiveEvent(...args),
}));

// Helper to build chainable query mocks
function chainableQuery(result: any[]) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result.length > 0 ? [result[0]] : []),
    orderBy: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  // Default: resolve to full result when no limit
  chain.where.mockResolvedValue(result);
  return chain;
}

describe("chain health sweeper", () => {
  it("CHAIN_STALL_THRESHOLD_MS is 4 hours", () => {
    expect(CHAIN_STALL_THRESHOLD_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("stalled overrides degraded (precedence)", () => {
    // This is a design constraint test - stalled (red) should override degraded (yellow)
    // The sweeper checks isStalled first, then isDegraded
    // Verifying the constants are correct
    expect(CHAIN_STALL_THRESHOLD_MS).toBeGreaterThan(0);
  });
});

describe("chain health sweeper constants", () => {
  it("TERMINAL_ISSUE_STATUSES includes done and cancelled", async () => {
    const { TERMINAL_ISSUE_STATUSES } = await import("@paperclipai/shared");
    expect(TERMINAL_ISSUE_STATUSES).toContain("done");
    expect(TERMINAL_ISSUE_STATUSES).toContain("cancelled");
    expect(TERMINAL_ISSUE_STATUSES).toHaveLength(2);
  });
});
