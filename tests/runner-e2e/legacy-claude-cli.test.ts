import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { LEGACY_CLAUDE_CLI_VERSION, qualifiedLegacyClaudeVersion, createLegacyClaudeLauncher } from "./legacy-claude-cli.js";

it("rejects the old CLI that cannot discover mounted skills and requires the exact qualified version", () => {
  expect(qualifiedLegacyClaudeVersion("2.1.19 (Claude Code)")).toBe(false);
  expect(qualifiedLegacyClaudeVersion(`${LEGACY_CLAUDE_CLI_VERSION} (Claude Code)\n`)).toBe(true);
  expect(qualifiedLegacyClaudeVersion(`warning: ${LEGACY_CLAUDE_CLI_VERSION} (Claude Code)`)).toBe(false);
});
it("keeps the workflow installation pin synchronized with local qualification", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
  expect(workflow).toContain(`@anthropic-ai/claude-code@${LEGACY_CLAUDE_CLI_VERSION}`);
  expect(workflow).not.toContain("@anthropic-ai/claude-code@2.1.19");
  expect(workflow).toContain("--omit=dev --ignore-scripts @anthropic-ai/claude-code");
});


it("launches the script-free package wrapper and preserves arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-launcher-"));
  try {
    const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "cli-wrapper.cjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const bin = await createLegacyClaudeLauncher(root);
    expect(JSON.parse(execFileSync(path.join(bin, "claude"), ["--version", "argument with spaces"], { encoding: "utf8" })))
      .toEqual(["--version", "argument with spaces"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
