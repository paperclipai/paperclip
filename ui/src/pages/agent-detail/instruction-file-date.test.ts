import { describe, expect, it } from "vitest";
import { instructionFileDateLabel } from "./instruction-file-date";

describe("Identity file dates", () => {
  it("uses recorded creation until a modification date exists", () => {
    const createdAt = "2026-11-01T12:00:00.000Z";
    expect(instructionFileDateLabel({ createdAt })).toMatch(/^Date created /);
    expect(instructionFileDateLabel({ createdAt, updatedAt: "2026-11-02T12:00:00.000Z" })).toMatch(/^Last updated /);
  });
  it("does not fabricate dates for old or invalid metadata", () => {
    expect(instructionFileDateLabel(null)).toBe("Date unavailable");
    expect(instructionFileDateLabel({ updatedAt: "invalid" })).toBe("Date unavailable");
  });
});
