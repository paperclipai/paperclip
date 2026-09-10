import { describe, expect, it } from "vitest";
import { readDeliveryRepairContext } from "./executable-repair-intent.js";

const HEAD = "a".repeat(40);

describe("readDeliveryRepairContext", () => {
  it("accepts the declared cross-slice carrier", () => {
    expect(
      readDeliveryRepairContext({
        deliveryRepair: {
          unitId: "unit-1",
          candidateGeneration: 3,
          headSha: HEAD.toUpperCase(),
          reasonCode: "review_blocking_findings",
          attempt: 2,
        },
      }),
    ).toEqual({
      unitId: "unit-1",
      candidateGeneration: 3,
      headSha: HEAD,
      reasonCode: "review_blocking_findings",
      attempt: 2,
    });
  });

  it("requires a generation, a full head, a reason and an attempt", () => {
    const base = {
      unitId: "unit-1",
      candidateGeneration: 1,
      headSha: HEAD,
      reasonCode: "review_blocking_findings",
      attempt: 1,
    };
    expect(readDeliveryRepairContext({})).toBeNull();
    expect(readDeliveryRepairContext({ deliveryRepair: null })).toBeNull();
    expect(readDeliveryRepairContext({ deliveryRepair: [] })).toBeNull();
    for (const missing of ["unitId", "candidateGeneration", "headSha", "reasonCode", "attempt"]) {
      const partial: Record<string, unknown> = { ...base };
      delete partial[missing];
      expect(readDeliveryRepairContext({ deliveryRepair: partial }), missing).toBeNull();
    }
    expect(
      readDeliveryRepairContext({ deliveryRepair: { ...base, candidateGeneration: 0 } }),
    ).toBeNull();
    expect(
      readDeliveryRepairContext({ deliveryRepair: { ...base, attempt: -1 } }),
    ).toBeNull();
    // A short or non-hex head is not a candidate revision.
    expect(
      readDeliveryRepairContext({ deliveryRepair: { ...base, headSha: "abc123" } }),
    ).toBeNull();
    expect(
      readDeliveryRepairContext({ deliveryRepair: { ...base, headSha: "z".repeat(40) } }),
    ).toBeNull();
  });

  it("never accepts a context that only claims a repair happened", () => {
    // Free-text or boolean claims are not the declared carrier.
    expect(readDeliveryRepairContext({ deliveryRepair: true })).toBeNull();
    expect(readDeliveryRepairContext({ deliveryRepairRequested: true })).toBeNull();
    expect(
      readDeliveryRepairContext({ deliveryRepair: { ...{ unitId: "u", reasonCode: "r" } } }),
    ).toBeNull();
  });
});
