import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("repository gitignore", () => {
  it("ignores materialized Paperclip runtime credentials", () => {
    const sensitiveRuntimePath = ".paperclip-runtime/codex/home/auth.json";
    const result = spawnSync("git", ["check-ignore", "-v", sensitiveRuntimePath], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".paperclip-runtime/");
    expect(result.stdout).toContain(sensitiveRuntimePath);
  });
});
