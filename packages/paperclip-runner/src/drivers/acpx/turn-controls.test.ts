import { describe, expect, it } from "vitest";
import { AcpxTurnControlLedger, parseAcpxTurnControl } from "./turn-controls.js";

const control = { turnId: "turn-1", controlId: "control-1", mode: "follow_up", message: "Then validate it" };
describe("ACP active turn controls", () => {
  it("preserves explicit queued follow-up and rejects unbounded or ambiguous mutations", () => {
    expect(parseAcpxTurnControl(control)).toEqual(control);
    for (const invalid of [ { mode: "cancel" }, { mode: undefined }, { message: "  " }, { message: "x\0y" },
      { message: "🙂".repeat(16_385) }, { turnId: "stale id" }, { controlId: "" }, { executable: "ambient" } ]) {
      expect(() => parseAcpxTurnControl({ ...control, ...invalid })).toThrow();
    }
  });
  it("tombstones ambiguous attempts, fences stale turns and bounds per-turn retention", () => {
    const ledger = new AcpxTurnControlLedger();
    const parsed = parseAcpxTurnControl(control);
    ledger.begin("turn-1");
    expect(() => ledger.reserve(parsed, null)).toThrow(/stale/);
    ledger.reserve(parsed, "turn-1");
    expect(() => ledger.reserve(parsed, "turn-1")).toThrow(/already attempted/);
    for (let index = 1; index < 1024; index++) ledger.reserve({ ...parsed, controlId: `control-${index + 1}` }, "turn-1");
    expect(() => ledger.reserve({ ...parsed, controlId: "overflow" }, "turn-1")).toThrow(/limit/);
    ledger.begin("turn-2");
    expect(() => ledger.reserve(parsed, "turn-2")).toThrow(/stale/);
    expect(() => ledger.reserve({ ...parsed, turnId: "turn-2" }, "turn-2")).not.toThrow();
  });
});
