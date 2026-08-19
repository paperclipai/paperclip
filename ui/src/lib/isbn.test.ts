// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { validateAndNormalizeIsbn } from "./isbn";

describe("validateAndNormalizeIsbn", () => {
  it("validates and normalizes correct ISBN-13", () => {
    expect(validateAndNormalizeIsbn("978-3-16-148410-0")).toBe("9783161484100");
    expect(validateAndNormalizeIsbn("9783161484100")).toBe("9783161484100");
  });

  it("rejects invalid ISBN-13", () => {
    expect(validateAndNormalizeIsbn("9783161484101")).toBeNull();
  });

  it("validates and normalizes correct ISBN-10", () => {
    expect(validateAndNormalizeIsbn("0-306-40615-2")).toBe("0306406152");
    expect(validateAndNormalizeIsbn("0306406152")).toBe("0306406152");
  });

  it("rejects invalid ISBN-10", () => {
    expect(validateAndNormalizeIsbn("0306406153")).toBeNull();
  });

  it("handles mixed format ISBN-13", () => {
    expect(validateAndNormalizeIsbn("978 3 16 148410 0")).toBe("9783161484100");
  });

  it("handles mixed format ISBN-10", () => {
    expect(validateAndNormalizeIsbn("0 306 40615 2")).toBe("0306406152");
  });

  it("rejects empty string", () => {
    expect(validateAndNormalizeIsbn("" as any)).toBeNull();
  });

  it("rejects non-numeric ISBN-13", () => {
    expect(validateAndNormalizeIsbn("abcdefghij" as any)).toBeNull();
  });
});