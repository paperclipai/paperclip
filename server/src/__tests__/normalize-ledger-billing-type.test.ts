import { describe, expect, it } from "vitest";
import { normalizeLedgerBillingType } from "../services/heartbeat.ts";

// ROCAA-182: Tier 1 (claude_local failover) returns AdapterExecutionResult
// objects with `billingType: "api_key"`. Before the fix, normalizeLedgerBillingType
// had no case for this value and silently coerced it to "unknown", erasing the
// metered-API tag the ROCAA-22 silent-billing-swap gate relies on.
describe("normalizeLedgerBillingType", () => {
  it("maps Tier 1 'api_key' to a known metered ledger value (not 'unknown')", () => {
    const result = normalizeLedgerBillingType("api_key");
    expect(result).not.toBe("unknown");
    expect(result).toBe("metered_api");
  });

  it("maps 'api' to 'metered_api' (existing alias)", () => {
    expect(normalizeLedgerBillingType("api")).toBe("metered_api");
  });

  it("passes through 'metered_api'", () => {
    expect(normalizeLedgerBillingType("metered_api")).toBe("metered_api");
  });

  it("maps subscription variants", () => {
    expect(normalizeLedgerBillingType("subscription")).toBe("subscription_included");
    expect(normalizeLedgerBillingType("subscription_included")).toBe("subscription_included");
    expect(normalizeLedgerBillingType("subscription_overage")).toBe("subscription_overage");
  });

  it("passes through 'credits' and 'fixed'", () => {
    expect(normalizeLedgerBillingType("credits")).toBe("credits");
    expect(normalizeLedgerBillingType("fixed")).toBe("fixed");
  });

  it("returns 'unknown' for empty / null / unrecognized values", () => {
    expect(normalizeLedgerBillingType(undefined)).toBe("unknown");
    expect(normalizeLedgerBillingType(null)).toBe("unknown");
    expect(normalizeLedgerBillingType("")).toBe("unknown");
    expect(normalizeLedgerBillingType("garbage")).toBe("unknown");
  });
});
