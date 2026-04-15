import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function resolveUnpatchedHermesExecutePath(): string {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  return path.join(
    repoRoot,
    "node_modules",
    ".pnpm",
    "hermes-paperclip-adapter@0.2.0",
    "node_modules",
    "hermes-paperclip-adapter",
    "dist",
    "server",
    "execute.js",
  );
}

function resolveActiveHermesExecutePath(): string {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  return realpathSync(path.join(repoRoot, "server", "node_modules", "hermes-paperclip-adapter", "dist", "server", "execute.js"));
}

function hasBundledHermesAdapter(): boolean {
  try {
    return existsSync(resolveUnpatchedHermesExecutePath()) && existsSync(resolveActiveHermesExecutePath());
  } catch {
    return false;
  }
}

function renderExecuteJsFromRepoPatch(): string {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const patchPath = path.join(repoRoot, "patches", "hermes-paperclip-adapter@0.2.0.patch");
  const tempRoot = mkdtempSync(path.join(tmpdir(), "paperclip-hermes-patch-"));
  const executePath = path.join(tempRoot, "dist", "server", "execute.js");

  mkdirSync(path.dirname(executePath), { recursive: true });
  copyFileSync(resolveUnpatchedHermesExecutePath(), executePath);

  try {
    execFileSync("git", ["apply", "--unsafe-paths", patchPath], { cwd: tempRoot, stdio: "pipe" });
    return executePath;
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

const describeHermesPatchedAdapter = hasBundledHermesAdapter() ? describe : describe.skip;

describeHermesPatchedAdapter("hermes patched adapter", () => {
  it("keeps the repo patch execute.js template syntactically valid", () => {
    const executePath = renderExecuteJsFromRepoPatch();

    try {
      expect(() => {
        execFileSync(process.execPath, ["--check", executePath], { stdio: "pipe" });
      }).not.toThrow();
    } finally {
      rmSync(path.dirname(path.dirname(executePath)), { recursive: true, force: true });
    }
  });

  it("keeps repo patch coverage for missing Hermes session recovery", () => {
    const executePath = renderExecuteJsFromRepoPatch();

    try {
      const source = readFileSync(executePath, "utf8");

      expect(source).toContain("function isHermesUnknownSessionError");
      expect(source).toContain("Skipping suspicious Hermes session id");
      expect(source).toContain('Hermes resume session "${prevSessionId}" is unavailable; retrying with a fresh session.');
      expect(source).toContain("executionResult.clearSession = true;");
    } finally {
      rmSync(path.dirname(path.dirname(executePath)), { recursive: true, force: true });
    }
  });

  it("keeps the installed Hermes execute.js aligned with the repo patch", () => {
    const executePath = renderExecuteJsFromRepoPatch();

    try {
      expect(readFileSync(resolveActiveHermesExecutePath(), "utf8")).toBe(readFileSync(executePath, "utf8"));
    } finally {
      rmSync(path.dirname(path.dirname(executePath)), { recursive: true, force: true });
    }
  });
});
