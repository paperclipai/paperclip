import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { codexHomeDir } from "./quota.js";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// codexHomeDir
// ---------------------------------------------------------------------------
// Note: secondsToWindowLabel and mapCodexRpcQuota are covered by
// quota-pure-functions.test.ts. This file covers only codexHomeDir, which
// reads process.env directly and is distinct from resolveSharedCodexHomeDir
// in codex-home.ts (which accepts an env argument and uses path.resolve).

describe("codexHomeDir", () => {
  let origCodexHome: string | undefined;

  beforeEach(() => {
    origCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (origCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = origCodexHome;
    }
  });

  it("returns CODEX_HOME env value when set to a non-empty string", () => {
    process.env.CODEX_HOME = "/custom/codex";
    expect(codexHomeDir()).toBe("/custom/codex");
  });

  it("trims the CODEX_HOME value", () => {
    process.env.CODEX_HOME = "  /custom/codex  ";
    expect(codexHomeDir()).toBe("/custom/codex");
  });

  it("falls back to ~/.codex when CODEX_HOME is not set", () => {
    delete process.env.CODEX_HOME;
    expect(codexHomeDir()).toBe(path.join(os.homedir(), ".codex"));
  });

  it("falls back to ~/.codex when CODEX_HOME is empty string", () => {
    process.env.CODEX_HOME = "";
    expect(codexHomeDir()).toBe(path.join(os.homedir(), ".codex"));
  });

  it("falls back to ~/.codex when CODEX_HOME is whitespace-only", () => {
    process.env.CODEX_HOME = "   ";
    expect(codexHomeDir()).toBe(path.join(os.homedir(), ".codex"));
  });
});
