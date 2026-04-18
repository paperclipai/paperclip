import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeShellTool } from "../src/server/shell-tools.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

describe("executeShellTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "shell-tools-test-"));
    execSync("git init -q", { cwd });
    execSync("git config user.email test@test.de", { cwd });
    execSync("git config user.name test", { cwd });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shell_exec runs command in cwd", async () => {
    const result = await executeShellTool("shell_exec", { command: "echo hello" }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });

  it("shell_exec respects timeout", async () => {
    const result = await executeShellTool("shell_exec", {
      command: "sleep 5",
      timeout: 500,
    }, cwd);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toMatch(/timed out|timeout|killed/);
  }, 10000);

  it("shell_exec caps timeout at 120000ms", async () => {
    const result = await executeShellTool("shell_exec", {
      command: "echo quick",
      timeout: 999999,
    }, cwd);
    expect(result.isError).toBe(false);
  });

  it("git_status shows clean tree", async () => {
    const result = await executeShellTool("git_status", {}, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/nothing to commit|working tree clean/);
  });

  it("git_commit stages files and commits", async () => {
    execSync("echo content > file.txt", { cwd });

    const result = await executeShellTool("git_commit", {
      files: ["file.txt"],
      message: "test commit",
    }, cwd);
    expect(result.isError).toBe(false);

    const log = execSync("git log --oneline", { cwd, encoding: "utf-8" });
    expect(log).toContain("test commit");
  });

  it("git_log shows recent commits", async () => {
    execSync("echo x > a.txt && git add a.txt && git commit -q -m 'first'", { cwd, shell: "/bin/bash" });
    execSync("echo y > b.txt && git add b.txt && git commit -q -m 'second'", { cwd, shell: "/bin/bash" });

    const result = await executeShellTool("git_log", { count: 5 }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("first");
    expect(result.content).toContain("second");
  });
});
