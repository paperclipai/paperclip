import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeCommandSupportsEffortFlag,
  minimumClaudeCliVersionForModel,
  readClaudeCommandVersion,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";

const directories: string[] = [];

afterEach(() => {
  resetClaudeCliCapabilitiesCacheForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function slowClaude() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paperclip-slow-claude-"));
  directories.push(cwd);
  const command = path.join(cwd, "claude");
  writeFileSync(command, `#!${process.execPath}\nsetTimeout(() => {
  console.log(process.argv.includes("--version") ? "2.1.284 (test CLI)" : "Usage: claude --effort <level>");
}, 1500);\n`);
  chmodSync(command, 0o755);
  return { runId: "capability-probe", command, target: null, cwd, env: {}, graceSec: 1 };
}

// This fixture is a real executable. Windows does not use POSIX shebang files.
describe.skipIf(process.platform === "win32")("Claude CLI capability probe budgets", () => {
  it("allows a slow version and effort probe with an unlimited run timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 0 };
    await expect(readClaudeCommandVersion(input)).resolves.toBe("2.1.284");
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBe(true);
  }, 30_000);

  it("retains an explicit shorter positive timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 1 };
    await expect(readClaudeCommandVersion(input)).resolves.toBeNull();
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBeNull();
  }, 30_000);
});

describe("minimumClaudeCliVersionForModel", () => {
  it("returns 2.1.290 for claude-fable-5-2 including provider prefixes and [1m] suffix", () => {
    expect(minimumClaudeCliVersionForModel("claude-fable-5-2")).toBe("2.1.290");
    expect(minimumClaudeCliVersionForModel("anthropic.claude-fable-5-2[1m]")).toBe("2.1.290");
    expect(minimumClaudeCliVersionForModel("us.anthropic.claude-fable-5-2")).toBe("2.1.290");
  });

  it("preserves minimum versions for existing models and null for unknown models", () => {
    expect(minimumClaudeCliVersionForModel("claude-opus-5-5")).toBe("2.1.280");
    expect(minimumClaudeCliVersionForModel("claude-sonnet-5-5")).toBe("2.1.284");
    expect(minimumClaudeCliVersionForModel("claude-fable-5-1")).toBe("2.1.251");
    expect(minimumClaudeCliVersionForModel("claude-unknown-model")).toBeNull();
  });
});
