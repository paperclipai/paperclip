import { describe, it, expect } from "vitest";
import { safePath } from "../src/server/path-safety.js";

describe("safePath", () => {
  it("resolves relative path within cwd", () => {
    const result = safePath("/home/user/project", "src/file.ts");
    expect(result).toBe("/home/user/project/src/file.ts");
  });

  it("blocks path traversal with ..", () => {
    expect(() => safePath("/home/user/project", "../../../etc/passwd"))
      .toThrow(/Path traversal blocked/);
  });

  it("blocks absolute paths outside cwd", () => {
    expect(() => safePath("/home/user/project", "/etc/passwd"))
      .toThrow(/Path traversal blocked/);
  });

  it("allows nested subdirectories", () => {
    const result = safePath("/home/user/project", "a/b/c/file.ts");
    expect(result).toBe("/home/user/project/a/b/c/file.ts");
  });
});
