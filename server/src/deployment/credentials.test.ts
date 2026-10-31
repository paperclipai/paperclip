import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeploymentCredential } from "./credentials.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deployment-credential-"));
  roots.push(root);
  return { root, file: join(root, "secret") };
}

describe("deployment credential files", () => {
  it("reads protected multiline values literally, including through a runtime symlink", () => {
    const { root, file } = fixture();
    const value = "$(touch /never-execute)\nsecond='quoted'\n";
    writeFileSync(file, value, { mode: 0o600 });
    const link = join(root, "current");
    symlinkSync(file, link);
    expect(readDeploymentCredential(link)).toBe(value);
  });

  it.each(["public", "empty", "nul", "oversized", "directory", "missing", "relative"])("rejects %s credentials with redacted errors", (kind) => {
    const { root, file } = fixture();
    writeFileSync(file, kind === "empty" ? " \n" : kind === "nul" ? "private\0value" : kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : "do-not-print", { mode: 0o600 });
    if (kind === "public") chmodSync(file, 0o644);
    const target = kind === "directory" ? root : kind === "missing" ? join(root, "missing") : kind === "relative" ? "relative-secret" : file;
    expect(() => readDeploymentCredential(target)).toThrow("Deployment credential");
    try { readDeploymentCredential(target); } catch (error) {
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("do-not-print");
    }
  });
});
