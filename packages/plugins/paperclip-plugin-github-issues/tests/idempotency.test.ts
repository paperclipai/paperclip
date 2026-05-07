import { describe, it, expect, vi } from "vitest";
import { acquireDelivery } from "../src/idempotency.js";

function fakeState() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (scope: any) => store.get(scope.stateKey) ?? null),
    set: vi.fn(async (scope: any, value: string) => { store.set(scope.stateKey, value); }),
  };
}

describe("acquireDelivery", () => {
  it("returns true on first delivery and stores marker", async () => {
    const state = fakeState();
    const acquired = await acquireDelivery(state as any, "company-1", "delivery-abc");
    expect(acquired).toBe(true);
    expect(state.set).toHaveBeenCalledOnce();
  });

  it("returns false on subsequent delivery with same id", async () => {
    const state = fakeState();
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(true);
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(false);
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(false);
  });

  it("isolates by companyId", async () => {
    const state = fakeState();
    expect(await acquireDelivery(state as any, "company-1", "delivery-abc")).toBe(true);
    expect(await acquireDelivery(state as any, "company-2", "delivery-abc")).toBe(true);
  });
});
