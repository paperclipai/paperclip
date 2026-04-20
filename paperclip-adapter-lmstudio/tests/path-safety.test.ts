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

  it("allows absolute path when it is inside an allowed write root", () => {
    const result = safePath(
      "/home/user/project",
      "/Volumes/Vault/notes/x.md",
      ["/Volumes/Vault"],
    );
    expect(result).toBe("/Volumes/Vault/notes/x.md");
  });

  it("still blocks absolute path outside both cwd and allowed roots", () => {
    expect(() =>
      safePath("/home/user/project", "/etc/passwd", ["/Volumes/Vault"]),
    ).toThrow(/Path traversal blocked/);
  });

  it("allowedWriteRoots does not leak partial-prefix matches", () => {
    // /Volumes/VaultSecret should NOT be treated as inside /Volumes/Vault
    expect(() =>
      safePath("/home/user/project", "/Volumes/VaultSecret/x", ["/Volumes/Vault"]),
    ).toThrow(/Path traversal blocked/);
  });
});
