import { describe, expect, it } from "vitest";
import type { AccountWithHealth } from "@paperclipai/shared";
import { pickBestAccount } from "../services/account-pool-balancer.js";

function account(over: Partial<AccountWithHealth> & { id: string }): AccountWithHealth {
  return {
    id: over.id,
    name: over.name ?? `acct-${over.id}`,
    key: over.key ?? `key-${over.id}`,
    status: over.status ?? "active",
    windows: over.windows ?? [],
    usedPercent: over.usedPercent ?? null,
    resetsAt: over.resetsAt ?? null,
    capped: over.capped ?? false,
    error: over.error,
  };
}

describe("pickBestAccount", () => {
  it("picks the account with the lowest usedPercent", () => {
    const chosen = pickBestAccount([
      account({ id: "a", usedPercent: 80 }),
      account({ id: "b", usedPercent: 20 }),
      account({ id: "c", usedPercent: 55 }),
    ]);
    expect(chosen?.id).toBe("b");
  });

  it("never picks a capped account, even if it reports lower usedPercent", () => {
    const chosen = pickBestAccount([
      account({ id: "a", usedPercent: 100, capped: true }),
      account({ id: "b", usedPercent: 90 }),
    ]);
    expect(chosen?.id).toBe("b");
  });

  it("skips accounts with unknown health (null usedPercent or error)", () => {
    const chosen = pickBestAccount([
      account({ id: "a", usedPercent: null }),
      account({ id: "b", usedPercent: 30, error: "fetch failed" }),
      account({ id: "c", usedPercent: 70 }),
    ]);
    expect(chosen?.id).toBe("c");
  });

  it("returns null when no account is usable", () => {
    expect(
      pickBestAccount([
        account({ id: "a", usedPercent: 100, capped: true }),
        account({ id: "b", usedPercent: null }),
        account({ id: "c", usedPercent: 50, error: "boom" }),
      ]),
    ).toBeNull();
  });

  it("returns null for an empty pool", () => {
    expect(pickBestAccount([])).toBeNull();
  });

  it("breaks ties deterministically by id", () => {
    const chosen = pickBestAccount([
      account({ id: "z", usedPercent: 40 }),
      account({ id: "a", usedPercent: 40 }),
    ]);
    expect(chosen?.id).toBe("a");
  });

  it("models the spec scenario: 3 accounts, 1 capped → picks healthiest non-capped", () => {
    const chosen = pickBestAccount([
      account({ id: "max1", usedPercent: 100, capped: true }),
      account({ id: "max2", usedPercent: 65 }),
      account({ id: "max3", usedPercent: 30 }),
    ]);
    expect(chosen?.id).toBe("max3");
  });
});
