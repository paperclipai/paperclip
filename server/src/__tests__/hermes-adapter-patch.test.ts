import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function resolvePatchedHermesExecutePath(): string {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm");
  const hermesEntry = readdirSync(pnpmRoot, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.startsWith("hermes-paperclip-adapter@0.2.0"),
  );

  if (!hermesEntry) {
    throw new Error("patched hermes-paperclip-adapter package not found under node_modules/.pnpm");
  }

  return path.join(
    pnpmRoot,
    hermesEntry.name,
    "node_modules",
    "hermes-paperclip-adapter",
    "dist",
    "server",
    "execute.js",
  );
}

describe("hermes patched adapter", () => {
  it("keeps the patched execute.js template syntactically valid", () => {
    const executePath = resolvePatchedHermesExecutePath();

    expect(() => {
      execFileSync(process.execPath, ["--check", executePath], { stdio: "pipe" });
    }).not.toThrow();
  });
});
