import { describe, expect, it } from "vitest";
import { isTransientAcpxTurnFailure } from "./recovery-classification.js";

describe("legacy ACPX recovery contract", () => {
  it.each(["connection", "service"])("retries %s diagnostics", category => {
    expect(isTransientAcpxTurnFailure({ resultJson: { terminalSessionFailure: { category } } })).toBe(true);
  });
  it.each(["limit", "request", "access"])("keeps %s failures visible for repair", category => {
    expect(isTransientAcpxTurnFailure({ resultJson: { terminalSessionFailure: { category } } })).toBe(false);
  });
  it("recognizes transport loss without a terminal diagnostic", () => {
    expect(isTransientAcpxTurnFailure({ resultJson: null })).toBe(true);
  });
});
