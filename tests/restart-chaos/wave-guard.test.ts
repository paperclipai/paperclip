import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeFingerprint } from "./wave-guard.js";

describe("mid-wave worktree guard", () => {
  it("changes when runner build output is rewritten or added, and stays put otherwise", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chaos-wave-guard-"));
    try {
      await mkdir(path.join(root, "dist/cli"), { recursive: true });
      await writeFile(path.join(root, "dist/cli/runner.js"), "one");
      const first = worktreeFingerprint(root, ["dist"]);
      expect(worktreeFingerprint(root, ["dist"])).toBe(first);
      await utimes(path.join(root, "dist/cli/runner.js"), new Date(), new Date(Date.now() + 5_000));
      const rebuilt = worktreeFingerprint(root, ["dist"]);
      expect(rebuilt).not.toBe(first);
      await writeFile(path.join(root, "dist/new.js"), "x");
      expect(worktreeFingerprint(root, ["dist"])).not.toBe(rebuilt);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
