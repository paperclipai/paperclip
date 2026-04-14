import { describe, expect, it } from "vitest";
import {
  redactHomePathUserSegments,
  redactHomePathUserSegmentsInValue,
  REDACTED_HOME_PATH_USER,
} from "./log-redaction.js";

describe("redactHomePathUserSegments", () => {
  it("redacts macOS home paths", () => {
    const result = redactHomePathUserSegments("/Users/angel/Documents/project");
    expect(result).toBe("/Users/a****/Documents/project");
  });

  it("redacts Linux home paths", () => {
    const result = redactHomePathUserSegments("/home/developer/code");
    expect(result).toBe("/home/d********/code");
  });

  it("redacts Windows home paths", () => {
    const result = redactHomePathUserSegments("C:\\Users\\Admin\\Desktop");
    expect(result).toBe("C:\\Users\\A****/Desktop");
  });

  it("redacts multiple occurrences", () => {
    const result = redactHomePathUserSegments(
      "from /Users/alice/src to /Users/bob/dst",
    );
    expect(result).not.toContain("alice");
    expect(result).not.toContain("bob");
  });

  it("returns original when disabled", () => {
    const result = redactHomePathUserSegments("/Users/angel/code", {
      enabled: false,
    });
    expect(result).toBe("/Users/angel/code");
  });

  it("handles text with no paths unchanged", () => {
    const text = "no paths here";
    expect(redactHomePathUserSegments(text)).toBe(text);
  });
});

describe("redactHomePathUserSegmentsInValue", () => {
  it("redacts strings", () => {
    const result = redactHomePathUserSegmentsInValue("/Users/test/file.ts");
    expect(result).not.toContain("test/");
  });

  it("redacts nested objects", () => {
    const result = redactHomePathUserSegmentsInValue({
      path: "/Users/angel/project",
      nested: { dir: "/home/dev/work" },
    });
    expect(result.path).not.toContain("angel");
    expect(result.nested.dir).not.toContain("dev/");
  });

  it("redacts arrays", () => {
    const result = redactHomePathUserSegmentsInValue([
      "/Users/alice/a",
      "/Users/bob/b",
    ]);
    expect(result[0]).not.toContain("alice");
    expect(result[1]).not.toContain("bob");
  });

  it("passes through non-string non-object values", () => {
    expect(redactHomePathUserSegmentsInValue(42)).toBe(42);
    expect(redactHomePathUserSegmentsInValue(null)).toBe(null);
    expect(redactHomePathUserSegmentsInValue(true)).toBe(true);
  });
});
