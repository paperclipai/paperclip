import { describe, expect, it } from "vitest";
import { normalizeMsysDrivePath } from "../paths.js";

describe("normalizeMsysDrivePath", () => {
  it("returns input unchanged on non-Windows platforms", () => {
    // On macOS/Linux (where tests run), the function is a no-op
    expect(normalizeMsysDrivePath("/c/Users/foo")).toBe("/c/Users/foo");
    expect(normalizeMsysDrivePath("/d/projects/bar")).toBe("/d/projects/bar");
    expect(normalizeMsysDrivePath("C:\\Users\\foo")).toBe("C:\\Users\\foo");
  });

  it("returns empty string unchanged", () => {
    expect(normalizeMsysDrivePath("")).toBe("");
  });

  it("returns normal paths unchanged", () => {
    expect(normalizeMsysDrivePath("/usr/local/bin")).toBe("/usr/local/bin");
    expect(normalizeMsysDrivePath("/home/user/project")).toBe("/home/user/project");
  });

  it("returns relative paths unchanged", () => {
    expect(normalizeMsysDrivePath("foo/bar")).toBe("foo/bar");
    expect(normalizeMsysDrivePath("./relative")).toBe("./relative");
  });
});
