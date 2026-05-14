import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePath, ValidationError } from "../src/validate-path";

describe("validatePath", () => {
  let tmpRoot: string;
  let allowedRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "doc-opener-test-"));
    allowedRoot = join(tmpRoot, "allowed");
    outsideRoot = join(tmpRoot, "outside");
    mkdirSync(allowedRoot);
    mkdirSync(outsideRoot);
    writeFileSync(join(allowedRoot, "doc.md"), "hello");
    writeFileSync(join(outsideRoot, "secret.md"), "secret");
  });

  afterEach(() => {
    // tmp dirs auto-cleaned on process exit; OS-level cleanup is enough
  });

  it("accepts a file inside an allowed root", () => {
    const result = validatePath(join(allowedRoot, "doc.md"), [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("rejects a file outside all allowed roots", () => {
    expect(() => validatePath(join(outsideRoot, "secret.md"), [allowedRoot]))
      .toThrow(ValidationError);
  });

  it("rejects a non-existent file", () => {
    expect(() => validatePath(join(allowedRoot, "nope.md"), [allowedRoot]))
      .toThrow(/file not found/i);
  });

  it("rejects ..-escape attempts (after resolve+realpath)", () => {
    const escape = join(allowedRoot, "..", "outside", "secret.md");
    expect(() => validatePath(escape, [allowedRoot]))
      .toThrow(/outside allowed roots/i);
  });

  it("rejects a symlink that points outside allowed roots", () => {
    const symlinkPath = join(allowedRoot, "trap.md");
    symlinkSync(join(outsideRoot, "secret.md"), symlinkPath);
    expect(() => validatePath(symlinkPath, [allowedRoot]))
      .toThrow(/outside allowed roots/i);
  });

  it("expands ~ to home dir", () => {
    // Use HOME-resident temp dir for this case
    process.env.HOME = tmpRoot;
    const result = validatePath("~/allowed/doc.md", [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("decodes URL-encoded paths", () => {
    const spaceDir = join(allowedRoot, "with space");
    mkdirSync(spaceDir);
    writeFileSync(join(spaceDir, "doc.md"), "hi");
    const encoded = join(allowedRoot, "with%20space", "doc.md");
    const result = validatePath(encoded, [allowedRoot]);
    expect(result).toBe(join(spaceDir, "doc.md"));
  });

  it("strips file:// prefix", () => {
    const fileUrl = `file://${join(allowedRoot, "doc.md")}`;
    const result = validatePath(fileUrl, [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("returns ValidationError with .code property", () => {
    try {
      validatePath(join(outsideRoot, "secret.md"), [allowedRoot]);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("OUTSIDE_ROOTS");
    }
  });
});
