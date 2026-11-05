import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readGitCommit, resolveServiceVersion } from "../instrumentation.js";

describe("resolveServiceVersion", () => {
  it("prefers the build stamp over every other source", () => {
    expect(resolveServiceVersion("aaaaaaa", "bbbbbbb", "2026.5.0")).toBe("aaaaaaa");
  });

  it("uses the runtime git commit when no build stamp exists", () => {
    expect(resolveServiceVersion(null, "bbbbbbb", "2026.5.0")).toBe("bbbbbbb");
  });

  it("uses OTEL_SERVICE_VERSION when no stamp and no git commit exist", () => {
    expect(resolveServiceVersion(null, null, "2026.5.0")).toBe("2026.5.0");
  });

  it("falls back to 'unknown' when every source is absent", () => {
    expect(resolveServiceVersion(null, null, undefined)).toBe("unknown");
  });

  it("treats an empty env value as absent", () => {
    expect(resolveServiceVersion(null, null, "")).toBe("unknown");
  });
});

describe("readGitCommit", () => {
  it("resolves git from the module checkout, not the process launch directory", () => {
    // This test needs reachable git metadata in the checkout that holds the
    // module. Skip the assertion when the environment has no git.
    const baseline = readGitCommit();
    if (baseline === null) return;

    const original = process.cwd();
    const launchDir = mkdtempSync(join(tmpdir(), "paperclip-no-git-"));
    try {
      // Move the process into a directory with no repository. The lookup still
      // returns the checkout commit, because it reads the module directory, not
      // the launch directory.
      process.chdir(launchDir);
      expect(readGitCommit()).toBe(baseline);
    } finally {
      process.chdir(original);
      rmSync(launchDir, { recursive: true, force: true });
    }
  });
});
