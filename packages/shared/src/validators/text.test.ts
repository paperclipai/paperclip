import { describe, expect, it } from "vitest";
import { multilineTextSchema } from "./text.js";

describe("multilineTextSchema (RENA-14562)", () => {
  it("stores literal backslash escape sequences verbatim", () => {
    for (const value of ["\\r", "\\n", "\\r\\n", "\\t", "\\register", "\\new", "\\repos", "C:\\node_modules"]) {
      expect(multilineTextSchema.parse(value)).toBe(value);
    }
  });

  it("does not alter real (already-decoded) line breaks", () => {
    expect(multilineTextSchema.parse("a\nb\r\nc")).toBe("a\nb\r\nc");
  });

  it("leaves arbitrary backslash sequences untouched", () => {
    expect(multilineTextSchema.parse("\\C \\t \\x \\\\")).toBe("\\C \\t \\x \\\\");
  });
});
