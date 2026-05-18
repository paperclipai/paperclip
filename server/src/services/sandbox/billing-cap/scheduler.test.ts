import { describe, expect, it, vi } from "vitest";
import { createBillingCapScheduler } from "./scheduler.js";
import { BillingCapMonitor, InMemoryBillingCapStore, NoopCapNotifier } from "./index.js";

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("billing-cap scheduler", () => {
  it("runOnce iterates every registered company id", async () => {
    const ticks: string[] = [];
    const monitor = {
      async tick(input: { companyId: string }) {
        ticks.push(input.companyId);
        return {} as any;
      },
    } as unknown as BillingCapMonitor;
    const scheduler = createBillingCapScheduler({
      monitor,
      resolveCompanyIds: async () => ["a", "b", "c"],
      logger: silentLogger(),
    });
    await scheduler.runOnce();
    expect(ticks).toEqual(["a", "b", "c"]);
  });

  it("logs but does not throw when monitor.tick rejects", async () => {
    const logger = silentLogger();
    const monitor = {
      async tick() {
        throw new Error("tick boom");
      },
    } as unknown as BillingCapMonitor;
    const scheduler = createBillingCapScheduler({
      monitor,
      resolveCompanyIds: async () => ["a"],
      logger,
    });
    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), "billing cap monitor tick failed");
  });

  it("smoke: integrates with the real BillingCapMonitor + in-memory store", async () => {
    const monitor = new BillingCapMonitor({
      store: new InMemoryBillingCapStore(),
      sourceA: null,
      sourceB: {
        async sample() {
          return {
            dayCents: 0,
            monthCents: 0,
            dayRuntimeSeconds: 0,
            monthRuntimeSeconds: 0,
            ratePerSecondCents: 0.01,
          };
        },
      },
      notifier: new NoopCapNotifier(),
      logger: silentLogger(),
    });
    const scheduler = createBillingCapScheduler({
      monitor,
      resolveCompanyIds: async () => ["company-1"],
      logger: silentLogger(),
    });
    await expect(scheduler.runOnce(new Date(Date.UTC(2026, 4, 17)))).resolves.toBeUndefined();
  });
});
