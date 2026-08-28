import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionThrottleService } from "../services/subscription-throttle.js";
import { subscriptionWindowUsage } from "../services/costs.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsertChain = {
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};
const mockInsertValues = vi.fn().mockReturnValue(mockInsertChain);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

function makeSelectChainReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeDb(stateRow: Record<string, unknown> | null = null) {
  const selectChain = makeSelectChainReturning(stateRow ? [stateRow] : []);
  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: mockInsert,
  } as any;
}

function makeInstanceSvc(throttleConfig: Record<string, unknown> | null) {
  return {
    getGeneral: vi.fn().mockResolvedValue({
      subscriptionThrottle: throttleConfig,
    }),
  } as any;
}

const defaultConfig = {
  enabled: true,
  provider: "anthropic",
  billingTypes: ["subscription_included", "subscription_overage"],
  windowHours: 5,
  estimatedCeilingTokens: 1_500_000,
  pausePercent: 80,
  resumePercent: 50,
  cachedWeight: 0,
};

// ---------------------------------------------------------------------------
// subscriptionWindowUsage — SQL window sum
// ---------------------------------------------------------------------------

describe("subscriptionWindowUsage", () => {
  it("returns zero when no cost events exist in the window", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        }]),
      }),
    } as any;

    const { usage } = await subscriptionWindowUsage(db, "company-1", {
      provider: "anthropic",
      billingTypes: ["subscription_included"],
      windowHours: 5,
      cachedWeight: 0,
    });

    expect(usage).toBe(0);
  });

  it("sums input and output tokens without cache weight", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{
          inputTokens: "600000",
          outputTokens: "400000",
          cachedInputTokens: "200000",
        }]),
      }),
    } as any;

    const { usage } = await subscriptionWindowUsage(db, "company-1", {
      provider: "anthropic",
      billingTypes: ["subscription_included"],
      windowHours: 5,
      cachedWeight: 0,
    });

    // cachedWeight=0 → cached tokens do not count
    expect(usage).toBe(1_000_000);
  });

  it("applies cachedWeight to cached input tokens", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{
          inputTokens: "500000",
          outputTokens: "300000",
          cachedInputTokens: "200000",
        }]),
      }),
    } as any;

    const { usage } = await subscriptionWindowUsage(db, "company-1", {
      provider: "anthropic",
      billingTypes: ["subscription_included"],
      windowHours: 5,
      cachedWeight: 0.1,
    });

    // 500_000 + 300_000 + 0.1 * 200_000 = 820_000
    expect(usage).toBe(820_000);
  });

  it("returns a windowStart in the past by windowHours", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any;

    const before = Date.now();
    const { windowStart } = await subscriptionWindowUsage(db, "company-1", {
      provider: "anthropic",
      billingTypes: ["subscription_included"],
      windowHours: 5,
      cachedWeight: 0,
    });
    const after = Date.now();

    const expectedMs = 5 * 60 * 60 * 1000;
    expect(before - windowStart.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - windowStart.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });
});

// ---------------------------------------------------------------------------
// subscriptionThrottleService — hysteresis state machine
// ---------------------------------------------------------------------------

describe("subscriptionThrottleService.getBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.mockReturnValue(mockInsertChain);
  });

  it("returns null when throttle is not configured", async () => {
    const svc = subscriptionThrottleService(makeDb(), makeInstanceSvc(null));
    const block = await svc.getBlock("company-1");
    expect(block).toBeNull();
  });

  it("returns null when throttle is disabled", async () => {
    const svc = subscriptionThrottleService(
      makeDb(),
      makeInstanceSvc({ ...defaultConfig, enabled: false }),
    );
    const block = await svc.getBlock("company-1");
    expect(block).toBeNull();
  });

  it("returns null when usage is below pausePercent and throttle is not active", async () => {
    // 79% usage
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          // first call → subscriptionWindowUsage
          .mockResolvedValueOnce([{ inputTokens: "1185000", outputTokens: "0", cachedInputTokens: "0" }])
          // second call → readState
          .mockResolvedValueOnce([]),
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    const block = await svc.getBlock("company-1");
    expect(block).toBeNull();
  });

  it("activates (returns block) when usage reaches pausePercent", async () => {
    // 85% usage = 1_275_000 tokens of 1_500_000
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([{ inputTokens: "1275000", outputTokens: "0", cachedInputTokens: "0" }])
          .mockResolvedValueOnce([]), // no existing state
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    const block = await svc.getBlock("company-1");

    expect(block).not.toBeNull();
    expect(block!.active).toBe(true);
    expect(block!.provider).toBe("anthropic");
    expect(block!.usagePercent).toBeCloseTo(85, 1);
    expect(block!.reason).toContain("85.0%");
    expect(block!.reason).toContain("1,500,000");
  });

  it("remains active (hysteresis) when usage is between resumePercent and pausePercent", async () => {
    // 65% usage — between 50 and 80
    const stateRow = { throttleActive: true, usagePercent: "85.0000", since: new Date(), updatedAt: new Date() };
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([{ inputTokens: "975000", outputTokens: "0", cachedInputTokens: "0" }])
          .mockResolvedValueOnce([stateRow]),
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    const block = await svc.getBlock("company-1");

    expect(block).not.toBeNull();
    expect(block!.usagePercent).toBeCloseTo(65, 1);
  });

  it("deactivates (returns null) when usage drops below resumePercent", async () => {
    // 45% usage — below 50
    const stateRow = { throttleActive: true, usagePercent: "65.0000", since: new Date(), updatedAt: new Date() };
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([{ inputTokens: "675000", outputTokens: "0", cachedInputTokens: "0" }])
          .mockResolvedValueOnce([stateRow]),
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    const block = await svc.getBlock("company-1");

    expect(block).toBeNull();
  });

  it("writes state update when throttle activates", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([{ inputTokens: "1275000", outputTokens: "0", cachedInputTokens: "0" }])
          .mockResolvedValueOnce([]),
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    await svc.getBlock("company-1");

    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ throttleActive: true }),
    );
  });

  it("writes state update when throttle deactivates", async () => {
    const stateRow = { throttleActive: true, usagePercent: "65.0000", since: new Date(), updatedAt: new Date() };
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([{ inputTokens: "675000", outputTokens: "0", cachedInputTokens: "0" }])
          .mockResolvedValueOnce([stateRow]),
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    await svc.getBlock("company-1");

    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ throttleActive: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// subscriptionThrottleService.getStatus
// ---------------------------------------------------------------------------

describe("subscriptionThrottleService.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.mockReturnValue(mockInsertChain);
  });

  it("returns configured=false when no config exists", async () => {
    const svc = subscriptionThrottleService(makeDb(), makeInstanceSvc(null));
    const status = await svc.getStatus("company-1");

    expect(status.configured).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.active).toBe(false);
  });

  it("returns current active state and usage when enabled", async () => {
    const stateRow = { throttleActive: true, usagePercent: "85.0000", since: new Date(), updatedAt: new Date() };
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn()
          .mockResolvedValueOnce([stateRow]) // readState
          .mockResolvedValueOnce([{ inputTokens: "1275000", outputTokens: "0", cachedInputTokens: "0" }]), // subscriptionWindowUsage
      }),
      insert: mockInsert,
    } as any;

    const svc = subscriptionThrottleService(db, makeInstanceSvc(defaultConfig));
    const status = await svc.getStatus("company-1");

    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.active).toBe(true);
    expect(status.usagePercent).toBeCloseTo(85, 1);
    expect(status.estimatedCeilingTokens).toBe(1_500_000);
    expect(status.pausePercent).toBe(80);
    expect(status.resumePercent).toBe(50);
  });
});
