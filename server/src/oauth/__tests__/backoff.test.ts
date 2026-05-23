import { describe, it, expect } from "vitest";
import { backoffSeconds } from "../backoff.js";

describe("backoffSeconds", () => {
  it("starts at 30s on first attempt", () => expect(backoffSeconds(1)).toBe(60));
  it("returns 30s for zero attempts", () => expect(backoffSeconds(0)).toBe(30));
  it("doubles up to 1h cap", () => {
    expect(backoffSeconds(5)).toBe(960);
    expect(backoffSeconds(10)).toBe(3600);
    expect(backoffSeconds(50)).toBe(3600);
  });
  it("never negative", () => {
    for (let i = 0; i < 100; i++) expect(backoffSeconds(i)).toBeGreaterThanOrEqual(0);
  });
});
