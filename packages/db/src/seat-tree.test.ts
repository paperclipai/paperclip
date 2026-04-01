import { describe, expect, it } from "vitest";
import { assertNoSeatCycle, MAX_SEAT_TREE_DEPTH } from "./seat-tree.js";

describe("assertNoSeatCycle", () => {
  it("allows a valid parent assignment when no cycle is introduced", () => {
    expect(() =>
      assertNoSeatCycle({
        seatId: "seat-c",
        proposedParentSeatId: "seat-b",
        parentSeatIdBySeatId: new Map([
          ["seat-a", null],
          ["seat-b", "seat-a"],
          ["seat-c", null],
        ]),
      }),
    ).not.toThrow();
  });

  it("throws when a seat is assigned as its own parent", () => {
    expect(() =>
      assertNoSeatCycle({
        seatId: "seat-a",
        proposedParentSeatId: "seat-a",
        parentSeatIdBySeatId: new Map([["seat-a", null]]),
      }),
    ).toThrow("Seat hierarchy would create cycle");
  });

  it("throws when a proposed parent would create a direct cycle", () => {
    expect(() =>
      assertNoSeatCycle({
        seatId: "seat-a",
        proposedParentSeatId: "seat-b",
        parentSeatIdBySeatId: new Map([
          ["seat-a", null],
          ["seat-b", "seat-a"],
        ]),
      }),
    ).toThrow("Seat hierarchy would create cycle");
  });

  it("throws when a proposed parent would create an indirect three-node cycle", () => {
    expect(() =>
      assertNoSeatCycle({
        seatId: "seat-a",
        proposedParentSeatId: "seat-c",
        parentSeatIdBySeatId: new Map([
          ["seat-a", null],
          ["seat-b", "seat-a"],
          ["seat-c", "seat-b"],
        ]),
      }),
    ).toThrow("Seat hierarchy would create cycle");
  });

  it("throws when the ancestor chain exceeds the supported depth", () => {
    const parentSeatIdBySeatId = new Map<string, string | null>();
    for (let index = 0; index <= MAX_SEAT_TREE_DEPTH; index += 1) {
      const seatId = `seat-${index}`;
      const parentSeatId = index === MAX_SEAT_TREE_DEPTH ? null : `seat-${index + 1}`;
      parentSeatIdBySeatId.set(seatId, parentSeatId);
    }

    expect(() =>
      assertNoSeatCycle({
        seatId: "seat-root",
        proposedParentSeatId: "seat-0",
        parentSeatIdBySeatId,
      }),
    ).toThrow(`Seat hierarchy exceeds maximum depth of ${MAX_SEAT_TREE_DEPTH}`);
  });
});
