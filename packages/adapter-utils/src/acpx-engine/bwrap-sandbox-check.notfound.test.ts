import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Disable package resolution entirely so the resolver cannot see any Codex
// platform package (including NODE_PATH global fallbacks used by the test
// runner). The module under test imports createRequire through this mock.
vi.mock("node:module", () => ({
  createRequire: () => {
    throw new Error("module resolution disabled in test");
  },
}));

import { verifyCodexBwrapSandbox } from "./bwrap-sandbox-check.js";

function withLinuxPlatform<T>(fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

describe("verifyCodexBwrapSandbox not-found path", () => {
  let emptyDir: string;
  let originalPath: string;

  beforeEach(() => {
    const base = existsSync("/tmp") ? "/tmp" : os.tmpdir();
    emptyDir = mkdtempSync(path.join(base, "bwrap-check-notfound-"));
    originalPath = process.env.PATH ?? "";
    process.env.PATH = emptyDir;
  });

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
  });

  it("reports a not-found reason when no package context or PATH bwrap exists", async () => {
    const result = await withLinuxPlatform(() => verifyCodexBwrapSandbox());
    expect(result.ok).toBe(false);
    expect(result.bwrapPath).toBeNull();
    expect(result.reason).toMatch(/not found/i);
  });

  it("reports a not-found reason with an anchor when no package context exists", async () => {
    const result = await withLinuxPlatform(() =>
      verifyCodexBwrapSandbox({ anchorPath: "/tmp/does-not-matter/index.js" }),
    );
    expect(result.ok).toBe(false);
    expect(result.bwrapPath).toBeNull();
    expect(result.reason).toMatch(/not found/i);
  });
});
